// Daily spend caps are checked before every turn, not only at hire time.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPolicy } from "../src/policy.ts";
import { createCity } from "../src/runtime.ts";
import type { Runner, TurnRequest } from "../src/sdk.ts";

const base = loadPolicy();
const mk = (caps: Record<string, number> = {}) => {
  const calls: TurnRequest[] = [];
  const runner: Runner = async (req) => { calls.push(req); return { text: "", sessionId: `s-${req.agentId}`, costUsd: 0 }; };
  const policy = { ...base, caps: { ...base.caps, daily_spend_usd_per_department: 1, ...caps } };
  const city = createCity({ runner, dataDir: mkdtempSync(join(tmpdir(), "cap-")), ledgerPath: ":memory:", policy });
  return { city, calls };
};
const spec = (id: string, department: string) => ({ id, role: id, kind: "manager", parent: "orchestrator", model: "claude-sonnet-5-5", mission: "m", tools: ["Read"], lifecycle: "persistent", budget_usd_per_day: 1, department });
const hire = (city: ReturnType<typeof mk>["city"], id: string, department: string) => city.toolsFor("orchestrator").find((t) => t.name === "hire_agent")!.handler({ spec: spec(id, department) });
const asked = (city: ReturnType<typeof mk>["city"]) => city.ledger.openQuestions().filter((q) => q.id.startsWith("q-cap-"));
const day = () => new Date().toISOString().slice(0, 10);

test("under the cap nothing is blocked", async () => {
  const { city, calls } = mk();
  await hire(city, "it-mgr", "IT");
  city.ledger.addCost("it-mgr", null, 0.5);
  const t = city.sendTicket({ to: "it-mgr", goal: "x" });
  await city.idle();
  assert.ok(calls.some((c) => c.agentId === "it-mgr"));
  assert.notEqual(city.ledger.getTicket(t.id)?.status, "waiting_on_owner");
  assert.equal(asked(city).length, 0);
  city.close();
});

test("over the cap the turn does not start, the ticket waits, and the owner is asked exactly once", async () => {
  const { city, calls } = mk();
  await hire(city, "it-mgr", "IT");
  city.ledger.addCost("it-mgr", null, 2);
  const a = city.sendTicket({ to: "it-mgr", goal: "one" });
  const b = city.sendTicket({ to: "it-mgr", goal: "two" });
  await city.idle();
  assert.equal(calls.filter((c) => c.agentId === "it-mgr").length, 0);
  assert.equal(city.ledger.getTicket(a.id)?.status, "waiting_on_owner");
  assert.equal(city.ledger.getTicket(b.id)?.status, "waiting_on_owner");
  const qs = asked(city);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].id, `q-cap-IT-${day()}`);
  assert.deepEqual(qs[0].question.questions[0].options, ["raise the limit for today", "pause until tomorrow"]);
  assert.equal(qs[0].question.questions[0].default, "pause until tomorrow");
  city.close();
});

test("a revived agent is blocked too", async () => {
  const { city, calls } = mk();
  await hire(city, "it-mgr", "IT");
  await city.toolsFor("orchestrator").find((t) => t.name === "retire_agent")!.handler({ id: "it-mgr" });
  city.ledger.addCost("it-mgr", null, 2);
  await assert.rejects(hire(city, "it-mgr", "IT"), /cap reached/);
  // A revival that got through (raised, then cap re-applied) still cannot take a turn.
  city.ledger.updateAgent("it-mgr", { state: "active" });
  city.sendTicket({ to: "it-mgr", goal: "x" });
  await city.idle();
  assert.equal(calls.filter((c) => c.agentId === "it-mgr").length, 0);
  city.close();
});

test("'raise' lifts that department for today and resumes its tickets; other departments stay capped", async () => {
  const { city, calls } = mk();
  await hire(city, "it-mgr", "IT");
  await hire(city, "hr-mgr", "HR");
  city.ledger.addCost("it-mgr", null, 2);
  city.ledger.addCost("hr-mgr", null, 2);
  const it = city.sendTicket({ to: "it-mgr", goal: "x" });
  const hr = city.sendTicket({ to: "hr-mgr", goal: "y" });
  await city.idle();
  city.answer(`q-cap-IT-${day()}`, "raise the limit for today");
  await city.idle();
  assert.ok(calls.some((c) => c.agentId === "it-mgr" && c.prompt.includes(it.id)), "the waiting IT ticket restarted");
  assert.notEqual(city.ledger.getTicket(it.id)?.cap_block, "IT");
  assert.equal(city.ledger.getTicket(hr.id)?.status, "waiting_on_owner");
  assert.equal(calls.filter((c) => c.agentId === "hr-mgr").length, 0);
  assert.equal(asked(city).length, 1, "no second IT question once raised");
  city.close();
});

test("an override from another day does not lift today's cap", async () => {
  const { city, calls } = mk();
  await hire(city, "it-mgr", "IT");
  city.ledger.addCost("it-mgr", null, 2);
  const q = { ticket_id: "-", asked_by: "it-mgr", path: "p", questions: [{ text: "t", default: "d" }] };
  city.ledger.putQuestion({ id: "q-cap-IT-2020-01-01", status: "answered", question: q, created_at: "2020-01-01T00:00:00Z", answer: "raise the limit for today" });
  city.sendTicket({ to: "it-mgr", goal: "x" });
  await city.idle();
  assert.equal(calls.filter((c) => c.agentId === "it-mgr").length, 0);
  city.close();
});

test("'pause' leaves tickets waiting, and they stay waiting; no new question that day", async () => {
  const { city, calls } = mk();
  await hire(city, "it-mgr", "IT");
  city.ledger.addCost("it-mgr", null, 2);
  const t = city.sendTicket({ to: "it-mgr", goal: "x" });
  await city.idle();
  city.answer(`q-cap-IT-${day()}`, "pause until tomorrow");
  await city.idle();
  city.resumeCapBlocked();
  await city.idle();
  assert.equal(city.ledger.getTicket(t.id)?.status, "waiting_on_owner");
  assert.equal(calls.filter((c) => c.agentId === "it-mgr").length, 0);
  assert.equal(asked(city).length, 0, "the day's question is answered, not re-raised");
  city.close();
});

test("held tickets restart when the cap no longer applies (a new day)", async () => {
  const { city, calls } = mk();
  await hire(city, "it-mgr", "IT");
  city.ledger.addCost("it-mgr", null, 2);
  const t = city.sendTicket({ to: "it-mgr", goal: "x" });
  await city.idle();
  // Tomorrow's spend is 0: simulate by moving today's spend to yesterday.
  city.ledger.addCost("it-mgr", null, -2); // offsets today's spend, standing in for the day rolling over
  city.resumeCapBlocked();
  await city.idle();
  assert.ok(calls.some((c) => c.agentId === "it-mgr" && c.prompt.includes(t.id)));
  city.close();
});

test("the optional global cap blocks every department, and is off when absent", async () => {
  const off = mk({ daily_spend_usd_per_department: 100 });
  await hire(off.city, "it-mgr", "IT");
  off.city.ledger.addCost("it-mgr", null, 50);
  off.city.sendTicket({ to: "it-mgr", goal: "x" });
  await off.city.idle();
  assert.ok(off.calls.some((c) => c.agentId === "it-mgr"));
  off.city.close();

  const { city, calls } = mk({ daily_spend_usd_per_department: 100, daily_spend_usd_global: 1 });
  await hire(city, "it-mgr", "IT");
  await hire(city, "hr-mgr", "HR");
  city.ledger.addCost("it-mgr", null, 2);
  const t = city.sendTicket({ to: "hr-mgr", goal: "y" });
  await city.idle();
  assert.equal(calls.filter((c) => c.agentId === "hr-mgr").length, 0);
  assert.equal(city.ledger.getTicket(t.id)?.status, "waiting_on_owner");
  assert.equal(asked(city)[0].id, `q-cap-global-${day()}`);
  city.close();
});
