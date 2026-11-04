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
function setup(ctx = 1000, o: { sdkCompact?: boolean; haikuFails?: boolean } = {}) {
  const calls: TurnRequest[] = [];
  const runner: Runner = async (req) => {
    calls.push(req);
    if (req.prompt.startsWith("/compact")) {
      if (o.sdkCompact === false) return { text: "", sessionId: "s-old", costUsd: 0, contextTokens: ctx };
      return { text: "", sessionId: `c${++n}`, costUsd: 0, contextTokens: 20_000, compact: { pre: ctx, post: 20_000 } };
    }
    if (req.model.includes("haiku")) { if (o.haikuFails) throw new Error("haiku down"); return { text: "SUMMARY of work", sessionId: "h", costUsd: 0 }; }
    return { text: "", sessionId: `s${++n}`, costUsd: 0, contextTokens: ctx };
  };
  const city = createCity({ runner, dataDir: mkdtempSync(join(tmpdir(), "city-")), ledgerPath: ":memory:", policy });
  const hire = (id: string, kind: "manager" | "worker", parent: string) => city.toolsFor(parent).find((t) => t.name === "hire_agent")!.handler({
    spec: { id, role: id, kind, parent, model: "claude-sonnet-5-5", mission: "m", tools: ["Read"], lifecycle: "persistent", budget_usd_per_day: 1, department: "IT" } });
  return { city, calls, hire };
}
const turnsOf = (calls: TurnRequest[], id: string) => calls.filter((c) => c.agentId === id && !c.prompt.includes("[reminder]") && !c.prompt.startsWith("/compact") && !c.model.includes("haiku"));

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

async function twoTurns(ctx: number, o = {}) {
  const t = setup(ctx, o);
  await t.hire("mgr-a", "manager", "orchestrator");
  const root = t.city.sendTicket({ to: "mgr-a", goal: "big" });
  await t.city.idle();
  t.city.ledger.updateTicket(root.id, { status: "in_progress" });
  t.city.sendTicket({ to: "mgr-a", goal: "more", parent_id: root.id });
  await t.city.idle();
  return { ...t, root, second: turnsOf(t.calls, "mgr-a")[1] };
}

test("a session at 60% of the window is compacted with the SDK's /compact before the next turn, and logged", async () => {
  const { city, calls, second } = await twoTurns(120_000);
  assert.ok(calls.some((c) => c.agentId === "mgr-a" && c.prompt.startsWith("/compact") && c.resume));
  assert.ok(second.resume?.startsWith("c"), "the turn resumes the compacted session");
  const [c] = city.compactions("mgr-a");
  assert.deepEqual([c.method, c.tokens_before, c.tokens_after], ["sdk_compact", 120_000, 20_000]);
  assert.ok(c.session_before && c.session_after);
  const k = city.compactions().length; // reminder turns in this scripted setup compact too, as the fake keeps reporting 120k
  assert.deepEqual(city.compactionStats(), { count: k, tokens_before: 120_000 * k, tokens_after: 20_000 * k, by_method: { sdk_compact: k } });
});

test("under 60% nothing is compacted", async () => {
  const { city, calls, second } = await twoTurns(119_999);
  assert.ok(!calls.some((c) => c.prompt.startsWith("/compact")));
  assert.ok(second.resume);
  assert.equal(city.compactions().length, 0);
});

test("if /compact does nothing, a fresh session gets a Haiku summary plus the ledger handover", async () => {
  const { city, calls, second } = await twoTurns(150_000, { sdkCompact: false });
  assert.equal(second.resume, null);
  assert.match(second.prompt, /SUMMARY of work/);
  assert.match(second.prompt, /Open tickets:/);
  assert.ok(calls.some((c) => c.model === "claude-haiku-5-5" && c.resume));
  assert.equal(city.compactions()[0].method, "handover_haiku");
  assert.equal(city.compactions()[0].tokens_before, 150_000);
});

test("if Haiku also fails, the ledger handover alone seeds the fresh session", async () => {
  const { city, second } = await twoTurns(150_000, { sdkCompact: false, haikuFails: true });
  assert.equal(second.resume, null);
  assert.match(second.prompt, /^\[handover/);
  assert.equal(city.compactions()[0].method, "handover_ledger");
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

test("a compaction turn records a per-turn cost delta, not the session's cumulative total", async () => {
  let cum = 0;
  const runner: Runner = async (req) => {
    if (req.prompt.startsWith("/compact")) { cum = 0.13; return { text: "", sessionId: "S", costUsd: cum, usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 }, tokens: 6, contextTokens: 20_000, compact: { pre: 120_000, post: 20_000 } }; }
    if (cum === 0) cum = 0.10;
    return { text: "", sessionId: "S", costUsd: cum, contextTokens: 120_000, tokens: 10 };
  };
  const city = createCity({ runner, dataDir: mkdtempSync(join(tmpdir(), "city-")), ledgerPath: ":memory:", policy });
  await city.toolsFor("orchestrator").find((t) => t.name === "hire_agent")!.handler({ spec: { id: "mgr-a", role: "m", kind: "manager", parent: "orchestrator", model: "claude-sonnet-5-5", mission: "m", tools: ["Read"], lifecycle: "persistent", budget_usd_per_day: 1, department: "IT" } });
  const root = city.sendTicket({ to: "mgr-a", goal: "x" });
  await city.idle();
  city.sendTicket({ to: "mgr-a", goal: "y", parent_id: root.id });
  await city.idle();
  assert.equal(city.compactions()[0].method, "sdk_compact");
  // Baselines are per agent and session, so read this agent's total (the Secretary's turn has its own baseline).
  const usd = city.agent("mgr-a").total_cost_usd;
  assert.ok(Math.abs(usd - 0.13) < 1e-9, `got ${usd}`);
});
