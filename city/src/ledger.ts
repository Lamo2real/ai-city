// The ledger: every ticket, agent, question and cost in one SQLite file, so work
// survives a crash and the daemon can resume it. Rows keep the full JSON plus
// the few columns we query on.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type TicketStatus = "open" | "in_progress" | "waiting_on_owner" | "in_review" | "done" | "failed" | "cancelled";

export interface Ticket {
  id: string;
  parent_id?: string | null;
  from: string;
  to: string;
  cc?: string[];
  kind: "task" | "fix" | "direct_instruction" | "review";
  goal: string;
  owner_words?: string;
  acceptance_criteria?: string[];
  scope?: string[];
  budget_usd?: number;
  deadline?: string | null;
  status: TicketStatus;
  review_rounds?: number;
  result?: { summary?: string; artifacts?: string[]; checks?: { name: string; passed: boolean }[]; cost_usd?: number };
  created_at: string;
  updated_at?: string;
}

export interface AgentRow {
  id: string;
  role: string;
  kind: "core" | "manager" | "worker";
  department?: string;
  parent: string;
  model: string;
  effort?: string;
  tools: string[];
  skills?: string[];
  lifecycle: "persistent" | "temporary";
  idle_retire_minutes?: number;
  state: "active" | "retired";
  session_id?: string | null;
  session_key?: string | null; // what the session belongs to: root ticket (managers) or ticket (workers)
  context_tokens?: number; // size of the session after its last turn
  prompt_path?: string;
  created_at: string;
  last_active_at: string;
  total_cost_usd: number;
}

export interface Compaction {
  agent_id: string;
  session_before: string | null;
  session_after: string | null;
  tokens_before: number;
  tokens_after: number;
  method: string;
}

export interface Question {
  ticket_id: string;
  asked_by: string;
  path: string;
  blocking?: boolean;
  questions: { text: string; options?: string[]; default: string; why?: string }[];
}

export interface QuestionRow {
  id: string;
  status: "open" | "answered";
  question: Question;
  created_at: string;
  answer?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, to_agent TEXT NOT NULL, from_agent TEXT NOT NULL, status TEXT NOT NULL, parent_id TEXT, json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent TEXT NOT NULL, state TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, asked_by TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS compactions (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, session_before TEXT, session_after TEXT, tokens_before INTEGER NOT NULL, tokens_after INTEGER NOT NULL, method TEXT NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS costs (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, ticket_id TEXT, usd REAL NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, ts TEXT NOT NULL);
-- The SDK's total_cost_usd is cumulative per session; this remembers the last one so each costs row is a delta.
-- Keyed by "<agentId>:<sessionId>" so two agents can never share a baseline.
CREATE TABLE IF NOT EXISTS session_baselines (key TEXT PRIMARY KEY, cumulative_usd REAL NOT NULL);
`;

export const sessionKey = (agentId: string, sessionId: string) => `${agentId}:${sessionId}`;
const LARGE_DELTA_USD = 20;

// ROLLBACK of the cost migration (v1): the backfill keeps the pre-migration cumulative values in costs.raw_usd.
//   UPDATE costs SET usd = raw_usd, estimated = 0 WHERE raw_usd IS NOT NULL; PRAGMA user_version = 0;
// Rows written by recordTurn leave raw_usd NULL (so that statement never touches them). A file ledger is also
// copied to <db>.pre-cost-v1.bak (VACUUM INTO, mode 0600) before its first migration.
// Roll back only before new turns are recorded, or delete rows with raw_usd IS NULL first.
// If the backup can't be written, the ledger refuses to open (Jarvis won't start): free disk space or
// remove the stale .bak (VACUUM INTO will not overwrite one).

// costs.usd is the cost of ONE turn (a delta). costs.tokens = input + output + cache_read + cache_write
// for new rows; for backfilled rows (estimated = 1) it is the legacy input+output value and the split is 0.
// "Today" is the UTC calendar day (ts is an ISO UTC string).
export interface TurnUsage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
const COST_COLUMNS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "estimated"];

// Idempotent: columns via ALTER (ignored when present); the backfill runs once, guarded by user_version.
function migrate(db: DatabaseSync, path: string, log: (line: string) => void): void {
  const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (v < 1 && path !== ":memory:") {
    const rows = (db.prepare("SELECT COUNT(*) AS n FROM costs").get() as { n: number }).n;
    const bak = `${path}.pre-cost-v1.bak`;
    if (rows > 0) {
      try { db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`); chmodSync(bak, 0o600); }
      catch (e) { throw new Error(`ledger: cannot write the pre-migration backup ${bak} (${(e as Error).message}); free disk space or remove the stale .bak, then restart`); }
      log(`ledger: backed up to ${bak} before the cost migration`);
    }
  }
  try { db.exec("ALTER TABLE costs ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0"); } catch { /* already there */ }
  for (const c of COST_COLUMNS) { try { db.exec(`ALTER TABLE costs ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`); } catch { /* already there */ } }
  try { db.exec("ALTER TABLE costs ADD COLUMN raw_usd REAL"); } catch { /* already there */ }
  // A baseline table keyed by session id alone (an earlier draft) carries over under the agent-scoped key.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_costs'").get()) {
    db.exec("INSERT OR IGNORE INTO session_baselines (key, cumulative_usd) SELECT json_extract(a.json, '$.id') || ':' || s.session_id, s.cumulative_usd FROM session_costs s JOIN agents a ON json_extract(a.json, '$.session_id') = s.session_id");
    db.exec("DROP TABLE session_costs");
  }
  if (v >= 1) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("UPDATE costs SET raw_usd = usd WHERE raw_usd IS NULL");
    // Old rows hold the cumulative total. delta = usd - previous usd for the agent; a drop = a new session.
    const prev = new Map<string, number>();
    const total = new Map<string, number>();
    const upd = db.prepare("UPDATE costs SET usd = ?, estimated = 1 WHERE id = ?");
    for (const r of db.prepare("SELECT id, agent_id, usd FROM costs ORDER BY ts, id").all() as { id: number; agent_id: string; usd: number }[]) {
      const p = prev.get(r.agent_id) ?? 0;
      const delta = r.usd >= p ? r.usd - p : r.usd;
      prev.set(r.agent_id, r.usd);
      total.set(r.agent_id, (total.get(r.agent_id) ?? 0) + delta);
      upd.run(delta, r.id);
    }
    for (const [id, sum] of total) {
      const row = db.prepare("SELECT json FROM agents WHERE id = ?").get(id) as { json: string } | undefined;
      if (!row) continue;
      const a = JSON.parse(row.json) as AgentRow;
      db.prepare("UPDATE agents SET json = ? WHERE id = ?").run(JSON.stringify({ ...a, total_cost_usd: sum }), id);
      // So the next turn of the live session continues from its cumulative total instead of re-counting it.
      if (a.session_id) db.prepare("INSERT OR REPLACE INTO session_baselines (key, cumulative_usd) VALUES (?, ?)").run(sessionKey(id, a.session_id), prev.get(id) ?? 0);
    }
    db.exec("PRAGMA user_version = 1");
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

export const now = () => new Date().toISOString();

export function openLedger(path: string, log: (line: string) => void = () => {}) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") for (const f of [path, `${path}-wal`, `${path}-shm`]) { try { chmodSync(f, 0o600); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
  db.exec(SCHEMA);
  migrate(db, path, log);
  const rows = <T>(sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args).map((r) => JSON.parse(String((r as { json: string }).json)) as T);
  const one = <T>(sql: string, ...args: (string | number)[]) => { const r = db.prepare(sql).get(...args) as { json: string } | undefined; return r ? (JSON.parse(r.json) as T) : undefined; };
  let depth = 0; // nested calls join the outer transaction
  const inTx = <T>(fn: () => T): T => { if (depth) return fn(); db.exec("BEGIN IMMEDIATE"); depth++; try { const v = fn(); db.exec("COMMIT"); return v; } catch (e) { db.exec("ROLLBACK"); throw e; } finally { depth--; } };

  return {
    // Ticket ids are idempotency keys: a repeated send is a no-op. Returns true if new.
    putTicket(t: Ticket): boolean {
      const r = db.prepare("INSERT OR IGNORE INTO tickets (id, to_agent, from_agent, status, parent_id, json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(t.id, t.to, t.from, t.status, t.parent_id ?? null, JSON.stringify(t), t.updated_at ?? t.created_at);
      return r.changes > 0;
    },
    getTicket: (id: string) => one<Ticket>("SELECT json FROM tickets WHERE id = ?", id),
    updateTicket(id: string, patch: Partial<Ticket>): Ticket {
      return inTx(() => {
        const t = one<Ticket>("SELECT json FROM tickets WHERE id = ?", id);
        if (!t) throw new Error(`no ticket ${id}`);
        const next = { ...t, ...patch, updated_at: now() };
        db.prepare("UPDATE tickets SET to_agent = ?, status = ?, json = ?, updated_at = ? WHERE id = ?").run(next.to, next.status, JSON.stringify(next), next.updated_at, id);
        return next;
      });
    },
    ticketsByStatus: (...statuses: TicketStatus[]) => rows<Ticket>(`SELECT json FROM tickets WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY updated_at`, ...statuses),
    ticketsTo: (to: string) => rows<Ticket>("SELECT json FROM tickets WHERE to_agent = ? ORDER BY updated_at", to),
    ticketsFrom: (from: string) => rows<Ticket>("SELECT json FROM tickets WHERE from_agent = ? ORDER BY updated_at", from),
    inbox: (agentId: string) => rows<Ticket>("SELECT json FROM tickets WHERE status IN ('open','in_progress') AND (to_agent = ? OR json LIKE ?) ORDER BY updated_at", agentId, `%"cc":[%"${agentId}"%`),

    putAgent(a: AgentRow) {
      db.prepare("INSERT OR REPLACE INTO agents (id, kind, parent, state, json) VALUES (?, ?, ?, ?, ?)").run(a.id, a.kind, a.parent, a.state, JSON.stringify(a));
    },
    getAgent: (id: string) => one<AgentRow>("SELECT json FROM agents WHERE id = ?", id),
    updateAgent(id: string, patch: Partial<AgentRow>): AgentRow {
      return inTx(() => {
        const a = one<AgentRow>("SELECT json FROM agents WHERE id = ?", id);
        if (!a) throw new Error(`no agent ${id}`);
        const next = { ...a, ...patch };
        db.prepare("UPDATE agents SET kind = ?, parent = ?, state = ?, json = ? WHERE id = ?").run(next.kind, next.parent, next.state, JSON.stringify(next), id);
        return next;
      });
    },
    agents: (state?: "active" | "retired") => (state ? rows<AgentRow>("SELECT json FROM agents WHERE state = ?", state) : rows<AgentRow>("SELECT json FROM agents")),
    children: (parent: string) => rows<AgentRow>("SELECT json FROM agents WHERE parent = ? AND state = 'active'", parent),

    putQuestion(q: QuestionRow) {
      db.prepare("INSERT INTO questions (id, ticket_id, asked_by, status, json) VALUES (?, ?, ?, ?, ?)").run(q.id, q.question.ticket_id, q.question.asked_by, q.status, JSON.stringify(q));
    },
    getQuestion: (id: string) => one<QuestionRow>("SELECT json FROM questions WHERE id = ?", id),
    openQuestions: () => rows<QuestionRow>("SELECT json FROM questions WHERE status = 'open'"),
    answeredQuestions: () => rows<QuestionRow>("SELECT json FROM questions WHERE status = 'answered'"),
    answerQuestion(id: string, answer: string): QuestionRow {
      return inTx(() => {
        const q = one<QuestionRow>("SELECT json FROM questions WHERE id = ?", id);
        if (!q) throw new Error(`no question ${id}`);
        const next: QuestionRow = { ...q, status: "answered", answer };
        db.prepare("UPDATE questions SET status = 'answered', json = ? WHERE id = ?").run(JSON.stringify(next), id);
        return next;
      });
    },

    // usd is a per-turn delta. For the SDK's cumulative total use recordTurn.
    addCost(agentId: string, ticketId: string | null, usd: number, tokens = 0, usage: TurnUsage = {}) {
      const [i, o, cr, cw] = [usage.input ?? 0, usage.output ?? 0, usage.cacheRead ?? 0, usage.cacheWrite ?? 0];
      const split = i + o + cr + cw;
      if (split) tokens = split;
      if (!usd && !tokens) return;
      inTx(() => {
        db.prepare("INSERT INTO costs (agent_id, ticket_id, usd, tokens, ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(agentId, ticketId, usd, tokens, now(), i, o, cr, cw);
        const a = one<AgentRow>("SELECT json FROM agents WHERE id = ?", agentId);
        if (a) db.prepare("UPDATE agents SET json = ? WHERE id = ?").run(JSON.stringify({ ...a, total_cost_usd: (a.total_cost_usd ?? 0) + usd, last_active_at: now() }), agentId);
      });
    },
    // Records a turn from the SDK's cumulative per-session total; returns the delta stored.
    // ASSUMPTION (proven from the ledger): result.total_cost_usd is CUMULATIVE for a resumed session, so
    // the per-turn cost is the difference from the last total seen for that agent's session. A new or
    // unknown session starts from 0; a total below the last one means a reset, so it counts in full.
    // An empty session id falls back to the agent-scoped key "<agentId>:" (never a shared baseline).
    // New rows leave raw_usd NULL; raw_usd only holds the pre-migration values of backfilled rows.
    recordTurn(agentId: string, ticketId: string | null, sessionId: string, cumulativeUsd: number, usage: TurnUsage = {}, tokens = 0): number {
      if (!sessionId) log(`ledger: ${agentId} reported no session id; using the agent-scoped baseline`);
      return inTx(() => {
        const key = sessionKey(agentId, sessionId);
        const r = db.prepare("SELECT cumulative_usd FROM session_baselines WHERE key = ?").get(key) as { cumulative_usd: number } | undefined;
        const prev = r?.cumulative_usd ?? 0;
        const delta = cumulativeUsd >= prev ? cumulativeUsd - prev : cumulativeUsd;
        if (delta > LARGE_DELTA_USD) log(`ledger: warning: one turn of ${agentId} cost $${delta.toFixed(2)} (over $${LARGE_DELTA_USD}); check the cumulative assumption`);
        db.prepare("INSERT OR REPLACE INTO session_baselines (key, cumulative_usd) VALUES (?, ?)").run(key, cumulativeUsd);
        this.addCost(agentId, ticketId, delta, tokens, usage);
        return delta;
      });
    },
    agentSpendToday(agentId: string): number {
      return (db.prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM costs WHERE agent_id = ? AND ts >= ?").get(agentId, now().slice(0, 10)) as { usd: number }).usd;
    },
    // Today's subscription usage: what the SDK reported per turn, summed.
    usageToday(): { usd: number; tokens: number; turns: number } {
      const day = now().slice(0, 10);
      return db.prepare("SELECT COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(tokens), 0) AS tokens, COUNT(*) AS turns FROM costs WHERE ts >= ?").get(day) as { usd: number; tokens: number; turns: number };
    },
    spendToday(department: string): number {
      const day = now().slice(0, 10);
      const r = db.prepare("SELECT COALESCE(SUM(c.usd), 0) AS usd FROM costs c JOIN agents a ON a.id = c.agent_id WHERE c.ts >= ? AND lower(trim(json_extract(a.json, '$.department'))) = lower(trim(?))").get(day, department) as { usd: number };
      return r.usd;
    },
    // Every compaction: what it cost the session and how it was done (sdk_compact | handover_haiku | handover_ledger).
    addCompaction(c: Compaction) {
      db.prepare("INSERT INTO compactions (agent_id, session_before, session_after, tokens_before, tokens_after, method, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(c.agent_id, c.session_before, c.session_after, c.tokens_before, c.tokens_after, c.method, now());
    },
    compactions: (agentId?: string) => db.prepare(`SELECT agent_id, session_before, session_after, tokens_before, tokens_after, method, ts FROM compactions ${agentId ? "WHERE agent_id = ?" : ""} ORDER BY id`).all(...(agentId ? [agentId] : [])) as unknown as Array<Compaction & { ts: string }>,
    compactionStats(since = "") {
      const rows = db.prepare("SELECT method, COUNT(*) AS n, SUM(tokens_before) AS before, SUM(tokens_after) AS after FROM compactions WHERE ts >= ? GROUP BY method").all(since) as unknown as Array<{ method: string; n: number; before: number; after: number }>;
      return { count: rows.reduce((s, r) => s + r.n, 0), tokens_before: rows.reduce((s, r) => s + r.before, 0), tokens_after: rows.reduce((s, r) => s + r.after, 0), by_method: Object.fromEntries(rows.map((r) => [r.method, r.n])) };
    },
    close: () => db.close(),
  };
}

export type Ledger = ReturnType<typeof openLedger>;
