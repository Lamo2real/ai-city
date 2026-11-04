// The ledger: every ticket, agent, question and cost in one SQLite file, so work
// survives a crash and the daemon can resume it. Rows keep the full JSON plus
// the few columns we query on.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
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
  prompt_path?: string;
  created_at: string;
  last_active_at: string;
  total_cost_usd: number;
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
CREATE TABLE IF NOT EXISTS costs (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, ticket_id TEXT, usd REAL NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, ts TEXT NOT NULL);
`;

export const now = () => new Date().toISOString();

export function openLedger(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  try { db.exec("ALTER TABLE costs ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0"); } catch { /* already there */ }
  const rows = <T>(sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args).map((r) => JSON.parse(String((r as { json: string }).json)) as T);
  const one = <T>(sql: string, ...args: (string | number)[]) => { const r = db.prepare(sql).get(...args) as { json: string } | undefined; return r ? (JSON.parse(r.json) as T) : undefined; };
  const inTx = <T>(fn: () => T): T => { db.exec("BEGIN IMMEDIATE"); try { const v = fn(); db.exec("COMMIT"); return v; } catch (e) { db.exec("ROLLBACK"); throw e; } };

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
    answerQuestion(id: string, answer: string): QuestionRow {
      return inTx(() => {
        const q = one<QuestionRow>("SELECT json FROM questions WHERE id = ?", id);
        if (!q) throw new Error(`no question ${id}`);
        const next: QuestionRow = { ...q, status: "answered", answer };
        db.prepare("UPDATE questions SET status = 'answered', json = ? WHERE id = ?").run(JSON.stringify(next), id);
        return next;
      });
    },

    addCost(agentId: string, ticketId: string | null, usd: number, tokens = 0) {
      if (!usd && !tokens) return;
      inTx(() => {
        db.prepare("INSERT INTO costs (agent_id, ticket_id, usd, tokens, ts) VALUES (?, ?, ?, ?, ?)").run(agentId, ticketId, usd, tokens, now());
        const a = one<AgentRow>("SELECT json FROM agents WHERE id = ?", agentId);
        if (a) db.prepare("UPDATE agents SET json = ? WHERE id = ?").run(JSON.stringify({ ...a, total_cost_usd: (a.total_cost_usd ?? 0) + usd, last_active_at: now() }), agentId);
      });
    },
    // Today's subscription usage: what the SDK reported per turn, summed.
    usageToday(): { usd: number; tokens: number; turns: number } {
      const day = now().slice(0, 10);
      return db.prepare("SELECT COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(tokens), 0) AS tokens, COUNT(*) AS turns FROM costs WHERE ts >= ?").get(day) as { usd: number; tokens: number; turns: number };
    },
    // Grouped in JS by the same key as policy.departmentKey (trim, collapse whitespace, case-fold), not by an SQL string match.
    spendToday(department: string): number {
      const day = now().slice(0, 10);
      const key = (n: string) => n.trim().replace(/\s+/g, " ").toLowerCase();
      const rows = db.prepare("SELECT c.usd AS usd, json_extract(a.json, '$.department') AS dept FROM costs c JOIN agents a ON a.id = c.agent_id WHERE c.ts >= ?").all(day) as Array<{ usd: number; dept: string | null }>;
      return rows.filter((r) => r.dept != null && key(r.dept) === key(department)).reduce((n, r) => n + r.usd, 0);
    },
    close: () => db.close(),
  };
}

export type Ledger = ReturnType<typeof openLedger>;
