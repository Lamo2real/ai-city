import assert from "node:assert/strict";
import { test } from "node:test";
import { openLedger, now, type Ticket } from "../src/ledger.ts";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ticket = (id: string, extra: Partial<Ticket> = {}): Ticket => ({ id, from: "jarvis", to: "orchestrator", kind: "task", goal: "g", status: "open", created_at: now(), ...extra });

test("a repeated send_ticket with the same id is a no-op", () => {
  const l = openLedger(":memory:");
  assert.equal(l.putTicket(ticket("t1")), true);
  assert.equal(l.putTicket(ticket("t1", { goal: "changed" })), false);
  assert.equal(l.getTicket("t1")?.goal, "g");
  l.close();
});

test("updates keep the full ticket and bump updated_at; status queries see them", () => {
  const l = openLedger(":memory:");
  l.putTicket(ticket("t1", { scope: ["/tmp/x"] }));
  const next = l.updateTicket("t1", { status: "in_progress" });
  assert.equal(next.status, "in_progress");
  assert.deepEqual(next.scope, ["/tmp/x"]);
  assert.ok(next.updated_at);
  assert.deepEqual(l.ticketsByStatus("in_progress").map((t) => t.id), ["t1"]);
  assert.deepEqual(l.ticketsByStatus("open"), []);
  assert.throws(() => l.updateTicket("nope", { status: "done" }), /no ticket/);
  l.close();
});

test("an inbox holds open tickets addressed or cc'd to the agent", () => {
  const l = openLedger(":memory:");
  l.putTicket(ticket("a", { to: "ios-dev", cc: ["app-manager"] }));
  l.putTicket(ticket("b", { to: "app-manager", status: "done" }));
  l.putTicket(ticket("c", { to: "other" }));
  assert.deepEqual(l.inbox("app-manager").map((t) => t.id), ["a"]);
  assert.deepEqual(l.inbox("ios-dev").map((t) => t.id), ["a"]);
  l.close();
});

test("costs add up per agent and per department per day", () => {
  const l = openLedger(":memory:");
  const base = { role: "r", parent: "orchestrator", model: "claude-sonnet-5-5", tools: ["Read"], lifecycle: "persistent" as const, state: "active" as const, created_at: now(), last_active_at: now(), total_cost_usd: 0 };
  l.putAgent({ ...base, id: "a1", kind: "manager", department: "IT" });
  l.putAgent({ ...base, id: "a2", kind: "worker", department: "IT" });
  l.addCost("a1", "t1", 0.5);
  l.addCost("a2", null, 0.25);
  l.addCost("a2", null, 0);
  assert.equal(l.getAgent("a1")?.total_cost_usd, 0.5);
  assert.equal(l.spendToday("IT"), 0.75);
  assert.equal(l.spendToday("Cloud"), 0);
  l.close();
});

test("questions open, answer once, and keep the answer", () => {
  const l = openLedger(":memory:");
  const q = { ticket_id: "t1", asked_by: "ios-dev", path: "App Manager › iOS Developer", questions: [{ text: "SwiftData?", default: "yes" }] };
  l.putQuestion({ id: "q1", status: "open", question: q, created_at: now() });
  assert.equal(l.openQuestions().length, 1);
  assert.equal(l.answerQuestion("q1", "yes").answer, "yes");
  assert.equal(l.openQuestions().length, 0);
  assert.equal(l.getQuestion("q1")?.status, "answered");
  l.close();
});

const agentRow = (id: string, extra: Record<string, unknown> = {}) => ({ id, role: "r", kind: "manager" as const, department: "platform", parent: "orchestrator", model: "m", tools: [], lifecycle: "persistent" as const, state: "active" as const, created_at: now(), last_active_at: now(), total_cost_usd: 0, ...extra });

test("recordTurn turns a cumulative session total into per-turn deltas, a new session starts from 0", () => {
  const l = openLedger(":memory:");
  l.putAgent(agentRow("m1"));
  assert.equal(l.recordTurn("m1", null, "s1", 1, { input: 1 }), 1);
  assert.ok(Math.abs(l.recordTurn("m1", null, "s1", 3, { input: 1 }) - 2) < 1e-9);
  assert.equal(l.recordTurn("m1", null, "s2", 0.5, { input: 1 }), 0.5); // new session
  assert.equal(l.recordTurn("m1", null, "s2", 0.2, { input: 1 }), 0.2); // a drop = reset
  assert.ok(Math.abs(l.spendToday("platform") - 3.7) < 1e-9);
  assert.ok(Math.abs(l.agentSpendToday("m1") - 3.7) < 1e-9);
  assert.ok(Math.abs(l.getAgent("m1")!.total_cost_usd - 3.7) < 1e-9);
  l.close();
});

test("the cache split is stored and tokens is the sum of all four", () => {
  const l = openLedger(":memory:");
  l.recordTurn("m1", null, "s1", 1, { input: 10, output: 5, cacheRead: 1000, cacheWrite: 200 });
  assert.equal(l.usageToday().tokens, 1215);
  l.close();
});

test("the session baseline survives a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const path = join(dir, "l.db");
  const a = openLedger(path); a.recordTurn("m1", null, "s1", 2); a.close();
  const b = openLedger(path);
  assert.equal(b.recordTurn("m1", null, "s1", 2.5), 0.5);
  b.close();
});

test("the migration backfills old cumulative rows as estimated deltas, once", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const path = join(dir, "old.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE costs (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, ticket_id TEXT, usd REAL NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, ts TEXT NOT NULL);");
  old.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent TEXT NOT NULL, state TEXT NOT NULL, json TEXT NOT NULL);");
  const ins = old.prepare("INSERT INTO costs (agent_id, usd, tokens, ts) VALUES (?, ?, 7, ?)");
  for (const [u, t] of [[10, 1], [12, 2], [15, 3], [2, 4], [3, 5]]) ins.run("m1", u, `2026-01-01T00:0${t}:00Z`);
  ins.run("m2", 4, "2026-01-01T00:00:30Z");
  old.prepare("INSERT INTO agents VALUES (?, 'manager', 'orchestrator', 'active', ?)").run("m1", JSON.stringify(agentRow("m1", { session_id: "live", total_cost_usd: 3 })));
  old.close();
  const l = openLedger(path);
  const raw = new DatabaseSync(path);
  const deltas = () => (raw.prepare("SELECT usd, estimated FROM costs ORDER BY ts, id").all() as { usd: number; estimated: number }[]);
  assert.deepEqual(deltas().map((r) => r.usd), [4, 10, 2, 3, 2, 1]);
  assert.ok(deltas().every((r) => r.estimated === 1));
  assert.equal(l.getAgent("m1")!.total_cost_usd, 18);
  assert.equal(l.recordTurn("m1", null, "live", 5), 2); // continues from the last cumulative (3)
  l.close();
  openLedger(path).close(); // re-opening does not backfill again
  assert.equal(deltas().reduce((s, r) => s + r.usd, 0), 24);
  raw.close();
});

function oldLedger(extraSql = "") {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const path = join(dir, "old.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE costs (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, ticket_id TEXT, usd REAL NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, ts TEXT NOT NULL);");
  old.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent TEXT NOT NULL, state TEXT NOT NULL, json TEXT NOT NULL);");
  const ins = old.prepare("INSERT INTO costs (agent_id, usd, tokens, ts) VALUES (?, ?, 7, ?)");
  [10, 12, 15, 2, 3].forEach((u, i) => ins.run("m1", u, `2026-01-01T00:0${i}:00Z`));
  old.exec(extraSql);
  return { path, old };
}
const usds = (path: string) => { const r = new DatabaseSync(path); const v = (r.prepare("SELECT usd FROM costs ORDER BY id").all() as { usd: number }[]).map((x) => x.usd); r.close(); return v; };

test("raw_usd keeps the pre-migration values, the documented rollback restores them exactly, and a backup file is made", () => {
  const { path, old } = oldLedger();
  old.close();
  const lines: string[] = [];
  openLedger(path, (l) => lines.push(l)).close();
  assert.ok(existsSync(`${path}.pre-cost-v1.bak`));
  assert.equal(statSync(`${path}.pre-cost-v1.bak`).mode & 0o777, 0o600);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(lines.some((l) => l.includes(".pre-cost-v1.bak")));
  const bak = new DatabaseSync(`${path}.pre-cost-v1.bak`);
  assert.deepEqual((bak.prepare("SELECT usd FROM costs ORDER BY id").all() as { usd: number }[]).map((x) => x.usd), [10, 12, 15, 2, 3]);
  bak.close();
  const raw = new DatabaseSync(path);
  assert.deepEqual((raw.prepare("SELECT raw_usd FROM costs ORDER BY id").all() as { raw_usd: number }[]).map((x) => x.raw_usd), [10, 12, 15, 2, 3]);
  assert.notDeepEqual(usds(path), [10, 12, 15, 2, 3]);
  raw.exec("UPDATE costs SET usd = raw_usd, estimated = 0 WHERE raw_usd IS NOT NULL; PRAGMA user_version = 0;");
  raw.close();
  assert.deepEqual(usds(path), [10, 12, 15, 2, 3]);
});

test("new rows leave raw_usd NULL, so the rollback never touches them", () => {
  const l = openLedger(":memory:");
  l.recordTurn("m1", null, "s1", 1);
  l.close();
  const { path, old } = oldLedger(); old.close();
  const a = openLedger(path); a.recordTurn("m1", null, "s9", 4); a.close();
  const raw = new DatabaseSync(path);
  raw.exec("UPDATE costs SET usd = raw_usd, estimated = 0 WHERE raw_usd IS NOT NULL; PRAGMA user_version = 0;");
  const last = raw.prepare("SELECT usd, raw_usd FROM costs ORDER BY id DESC LIMIT 1").get() as { usd: number; raw_usd: number | null };
  assert.deepEqual({ ...last }, { usd: 4, raw_usd: null });
  raw.close();
});

test("a failure during the backfill rolls everything back", () => {
  const { path, old } = oldLedger("CREATE TRIGGER boom BEFORE UPDATE OF usd ON costs BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  old.close();
  assert.throws(() => openLedger(path), /boom/);
  const raw = new DatabaseSync(path);
  assert.equal((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0);
  assert.deepEqual((raw.prepare("SELECT raw_usd FROM costs").all() as { raw_usd: number | null }[]).map((r) => r.raw_usd), [null, null, null, null, null]);
  raw.close();
  assert.deepEqual(usds(path), [10, 12, 15, 2, 3]);
});

test("a DB that already has the new columns at user_version 0 migrates correctly", () => {
  const { path, old } = oldLedger();
  for (const c of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "estimated"]) old.exec(`ALTER TABLE costs ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
  old.exec("ALTER TABLE costs ADD COLUMN raw_usd REAL");
  old.close();
  openLedger(path).close();
  assert.deepEqual(usds(path), [10, 2, 3, 2, 1]);
  const raw = new DatabaseSync(path);
  assert.equal((raw.prepare("SELECT MIN(estimated) AS m FROM costs").get() as { m: number }).m, 1);
  raw.close();
});

test("an earlier session_costs table carries over under the agent-scoped key", () => {
  const { path, old } = oldLedger("CREATE TABLE session_costs (session_id TEXT PRIMARY KEY, cumulative_usd REAL NOT NULL); INSERT INTO session_costs VALUES ('live', 3);");
  old.prepare("INSERT INTO agents VALUES ('m1', 'manager', 'orchestrator', 'active', ?)").run(JSON.stringify(agentRow("m1", { session_id: "live" })));
  old.close();
  const l = openLedger(path);
  assert.equal(l.recordTurn("m1", null, "live", 5), 2);
  l.close();
});

test("two agents with the same session id keep separate baselines; an empty id is agent-scoped and logged", () => {
  const lines: string[] = [];
  const l = openLedger(":memory:", (x) => lines.push(x));
  assert.equal(l.recordTurn("a", null, "same", 1), 1);
  assert.equal(l.recordTurn("b", null, "same", 5), 5);
  assert.equal(l.recordTurn("a", null, "same", 3), 2);
  assert.equal(l.recordTurn("a", null, "", 1), 1);
  assert.equal(l.recordTurn("b", null, "", 2), 2); // not interleaved with a's empty-id baseline
  assert.equal(l.recordTurn("a", null, "", 1.5), 0.5);
  assert.equal(lines.filter((x) => x.includes("no session id")).length, 3);
  l.close();
});

test("a turn costing over $20 logs a warning", () => {
  const lines: string[] = [];
  const l = openLedger(":memory:", (x) => lines.push(x));
  l.recordTurn("a", null, "s", 5);
  assert.equal(lines.length, 0);
  l.recordTurn("a", null, "s", 30);
  assert.ok(lines.some((x) => x.includes("warning") && x.includes("$25.00")));
  l.close();
});

test("a backup that cannot be written stops the open with a message naming the path", () => {
  const { path, old } = oldLedger(); old.close();
  writeFileSync(`${path}.pre-cost-v1.bak`, "stale");
  assert.throws(() => openLedger(path), (e: Error) => e.message.includes(`${path}.pre-cost-v1.bak`) && /remove the stale/.test(e.message));
  assert.deepEqual(usds(path), [10, 12, 15, 2, 3], "nothing was migrated");
});
