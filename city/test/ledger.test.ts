import assert from "node:assert/strict";
import { test } from "node:test";
import { openLedger, now, type Ticket } from "../src/ledger.ts";

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
