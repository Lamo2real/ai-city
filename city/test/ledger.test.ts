import assert from "node:assert/strict";
import { test } from "node:test";
import { openLedger, now, type Ticket } from "../src/ledger.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
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
