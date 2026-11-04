// Fresh sessions: managers resume per root ticket and rotate when big; workers start fresh per ticket.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPolicy } from "../src/policy.ts";
import { createCity } from "../src/runtime.ts";
import type { Runner, TurnRequest } from "../src/sdk.ts";

const policy = loadPolicy();
let n = 0;
function setup(ctx = 1000, pol = policy) {
  const calls: TurnRequest[] = [];
  const runner: Runner = async (req) => { calls.push(req); return { text: "", sessionId: `s${++n}`, costUsd: 0, contextTokens: ctx }; };
  const city = createCity({ runner, dataDir: mkdtempSync(join(tmpdir(), "city-")), ledgerPath: ":memory:", policy: pol });
  const hire = (id: string, kind: "manager" | "worker", parent: string) => city.toolsFor(parent).find((t) => t.name === "hire_agent")!.handler({
    spec: { id, role: id, kind, parent, model: "claude-sonnet-5-5", mission: "m", tools: ["Read"], lifecycle: "persistent", budget_usd_per_day: 1, department: "IT" } });
  return { city, calls, hire };
}
// The scripted agents never report, so the runtime nags them; those reminder turns are not what is under test.
const turnsOf = (calls: TurnRequest[], id: string) => calls.filter((c) => c.agentId === id && !c.prompt.includes("[reminder]"));

test("a manager resumes within one root ticket and starts fresh on a new one, with a handover", async () => {
  const { city, calls, hire } = setup();
  await hire("mgr-a", "manager", "orchestrator");
  const root = city.sendTicket({ to: "mgr-a", goal: "first job" });
  await city.idle();
  city.sendTicket({ to: "mgr-a", goal: "same tree", parent_id: root.id });
  await city.idle();
  const [t1, t2] = turnsOf(calls, "mgr-a");
  assert.equal(t1.resume, null);
  assert.ok(t2.resume);
  assert.ok(!t2.prompt.includes("[handover"));
  city.ledger.updateTicket(root.id, { status: "in_progress" });
  city.sendTicket({ to: "mgr-a", goal: "a different parent ticket" });
  await city.idle();
  const t3 = turnsOf(calls, "mgr-a")[2];
  assert.equal(t3.resume, null);
  assert.match(t3.prompt, /^\[handover/);
  assert.match(t3.prompt, new RegExp(root.id));
  assert.match(t3.prompt, /first job/);
  assert.ok(t3.prompt.length < 6200);
});

test("a manager session over the context threshold rotates", async () => {
  const { city, calls, hire } = setup(200_000);
  await hire("mgr-a", "manager", "orchestrator");
  const root = city.sendTicket({ to: "mgr-a", goal: "big" });
  await city.idle();
  city.sendTicket({ to: "mgr-a", goal: "more", parent_id: root.id });
  await city.idle();
  assert.equal(turnsOf(calls, "mgr-a")[1].resume, null);
  assert.match(turnsOf(calls, "mgr-a")[1].prompt, /^\[handover/);
  const small = setup(200_000, { ...policy, caps: { ...policy.caps, session_rotate_context_tokens: 300_000 } });
  await small.hire("mgr-a", "manager", "orchestrator");
  const r = small.city.sendTicket({ to: "mgr-a", goal: "big" });
  await small.city.idle();
  small.city.sendTicket({ to: "mgr-a", goal: "more", parent_id: r.id });
  await small.city.idle();
  assert.ok(turnsOf(small.calls, "mgr-a")[1].resume, "under a raised threshold it resumes");
});

test("handover lists open tickets of the agent and its children, decisions and artifacts", async () => {
  const { city, calls, hire } = setup();
  await hire("mgr-a", "manager", "orchestrator");
  await hire("dev-a", "worker", "mgr-a");
  const done = city.sendTicket({ to: "dev-a", goal: "built it", parent_id: undefined });
  await city.idle();
  city.ledger.updateTicket(done.id, { status: "done", result: { artifacts: ["/tmp/out/app.zip"] } });
  const open = city.sendTicket({ to: "dev-a", goal: "still going" });
  await city.idle();
  const ask = city.toolsFor("dev-a").find((t) => t.name === "ask_user")!.handler;
  await ask({ question: { ticket_id: open.id, questions: [{ text: "Which db?", default: "sqlite" }] } });
  city.answer(city.ledger.openQuestions()[0].id, "use sqlite");
  await city.idle();
  city.sendTicket({ to: "mgr-a", goal: "mgr one" });
  await city.idle();
  city.ledger.updateTicket(open.id, { status: "in_progress" });
  city.sendTicket({ to: "mgr-a", goal: "mgr two" });
  await city.idle();
  const p = turnsOf(calls, "mgr-a").at(-1)!.prompt;
  assert.match(p, /still going/);
  assert.match(p, /\/tmp\/out\/app\.zip/);
  assert.match(p, /Which db\? → /);
});

test("a worker starts fresh for each ticket and resumes only on the same ticket", async () => {
  const { city, calls, hire } = setup();
  await hire("mgr-a", "manager", "orchestrator");
  await hire("dev-a", "worker", "mgr-a");
  const t1 = city.sendTicket({ to: "dev-a", goal: "one" });
  await city.idle();
  city.sendTicket({ to: "dev-a", goal: "two" });
  await city.idle();
  const [a, b] = turnsOf(calls, "dev-a");
  assert.equal(a.resume, null);
  assert.equal(b.resume, null);
  // an answer to its question on ticket one is a follow-up on that ticket
  city.sendTicket({ to: "dev-a", goal: "ans", kind: "direct_instruction", parent_id: t1.id });
  await city.idle();
  city.sendTicket({ to: "dev-a", goal: "two again" });
  await city.idle();
  assert.equal(turnsOf(calls, "dev-a")[2].resume, null, "different ticket from the last one: fresh");
  const t4 = city.sendTicket({ to: "dev-a", goal: "four" });
  await city.idle();
  city.sendTicket({ to: "dev-a", goal: "reply", kind: "direct_instruction", parent_id: t4.id });
  await city.idle();
  assert.ok(turnsOf(calls, "dev-a").at(-1)!.resume, "same ticket resumes");
});

test("reset_session clears the stored session; only the orchestrator has it", async () => {
  const { city, calls, hire } = setup();
  await hire("mgr-a", "manager", "orchestrator");
  const root = city.sendTicket({ to: "mgr-a", goal: "job" });
  await city.idle();
  assert.ok(city.ledger.getAgent("mgr-a")!.session_id);
  const reset = city.toolsFor("orchestrator").find((t) => t.name === "reset_session")!;
  await reset.handler({ agent_id: "mgr-a" });
  assert.equal(city.ledger.getAgent("mgr-a")!.session_id, null);
  city.sendTicket({ to: "mgr-a", goal: "next", parent_id: root.id });
  await city.idle();
  const last = turnsOf(calls, "mgr-a").at(-1)!;
  assert.equal(last.resume, null);
  assert.match(last.prompt, /^\[handover/);
  assert.equal(city.toolsFor("mgr-a").find((t) => t.name === "reset_session"), undefined);
  assert.throws(() => city.resetSession("mgr-a", "mgr-a"), /orchestrator only/);
});
