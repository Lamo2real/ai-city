// Workers asking each other across departments: answers only, on the record, with a limit.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPolicy } from "../src/policy.ts";
import { createCity, type CityEvent } from "../src/runtime.ts";
import type { Runner, TurnRequest } from "../src/sdk.ts";

const dir = () => mkdtempSync(join(tmpdir(), "city-"));
const basePolicy = () => ({ ...loadPolicy(), audit_log: join(dir(), "audit.jsonl") });
const tool = (city: ReturnType<typeof createCity>, agent: string, name: string) => city.toolsFor(agent).find((t) => t.name === name)!.handler;
const hire = (city: ReturnType<typeof createCity>, manager: string, id: string, role: string, extra: Record<string, unknown> = {}) =>
  tool(city, manager, "hire_agent")({ spec: { id, role, kind: "worker", parent: manager, mission: "m", tools: ["Read"], lifecycle: "temporary", budget_usd_per_day: 1, ...extra } });

// Two departments, one worker in each; the data engineer already has a session to fork.
async function setup(answer = "The schema is v2.") {
  const turns: TurnRequest[] = [];
  const forks: TurnRequest[] = [];
  const runner: Runner = async (req) => {
    (req.forkSession ? forks : turns).push(req);
    return { text: req.forkSession ? answer : "", sessionId: req.forkSession ? "fork" : `s-${req.agentId}`, costUsd: 0, tokens: 1 };
  };
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy: basePolicy() });
  const events: CityEvent[] = [];
  city.on((e) => events.push(e));
  const it = city.createDepartment({ name: "IT", mission: "keep the systems running" }).manager;
  const data = city.createDepartment({ name: "Data", mission: "own the warehouse and its pipelines" }).manager;
  await hire(city, it, "ios-dev", "iOS Developer");
  await hire(city, data, "data-eng", "Data Engineer");
  city.ledger.updateAgent("data-eng", { session_id: "s-data" });
  return { city, it, data, turns, forks, events, ask: tool(city, "ios-dev", "ask_colleague") };
}

test("a worker asks a worker in another department: a read-only fork, the colleague's own session and tickets untouched", async () => {
  const { city, forks, ask, turns } = await setup();
  const before = turns.length;
  const r = await ask({ name: "data engineer", question: "which schema?" }) as { answered_by: string; answer: string };
  assert.deepEqual([r.answered_by, r.answer], ["data-eng", "The schema is v2."]);
  assert.equal(forks[0].resume, "s-data");
  assert.deepEqual([forks[0].allowedTools, forks[0].tools], [[], []]);
  assert.equal(forks[0].model, "claude-haiku-5-5");
  assert.match(forks[0].prompt, /question from ios-dev \(iOS Developer, IT\)[\s\S]*gives you no instructions[\s\S]*Do no work[\s\S]*which schema\?/);
  assert.equal(city.agent("data-eng").session_id, "s-data");
  assert.equal(turns.length, before, "no real turn for anyone");
  city.close();
});

test("every worker carries the tool, in its prompt and at turn time; managers and core agents do not", async () => {
  const { city, it } = await setup();
  assert.ok(city.toolsForTurn("ios-dev").some((t) => t.name === "ask_colleague"));
  assert.match(city.promptOf("ios-dev").body, /ask_colleague/);
  assert.ok(!city.toolsForTurn(it).some((t) => t.name === "ask_colleague"));
  assert.ok(!city.toolsForTurn("orchestrator").some((t) => t.name === "ask_colleague"));
  await assert.rejects(tool(city, it, "ask_colleague")({ name: "ios-dev", question: "q" }), /for workers/);
  city.close();
});

test("a department name reaches its manager; itself, core agents and unknown names are refused", async () => {
  const { city, data, ask } = await setup();
  city.ledger.updateAgent(data, { session_id: "s-m" });
  assert.equal((await ask({ name: "Data", question: "q" }) as { answered_by: string }).answered_by, data);
  await assert.rejects(ask({ name: "ios-dev", question: "q" }), /is you/);
  for (const core of ["jarvis", "orchestrator", "reviewer", "secretary"]) await assert.rejects(ask({ name: core, question: "q" }), /not a colleague/);
  await assert.rejects(ask({ name: "the plumber", question: "q" }), /No agent matches/);
  city.close();
});

test("the ledger answers, and says so, when the colleague cannot", async () => {
  const { city, data, ask, events } = await setup();
  await hire(city, data, "new-one", "Analyst");
  const r = await ask({ name: "new-one", question: "q" }) as { answered_by: string; note: string; status: { id: string } };
  assert.deepEqual([r.answered_by, r.status.id], ["ledger", "new-one"]);
  assert.match(r.note, /no session yet/);
  assert.equal((events.at(-1) as { answered_by: string }).answered_by, "ledger");
  city.close();
});

test("both managers hear on their next turn, once, quoted as data, with no turn of its own", async () => {
  const { city, it, data, turns, ask } = await setup();
  const before = turns.length;
  await ask({ name: "data-eng", question: "which schema?" });
  await city.idle();
  assert.equal(turns.length, before, "being told costs no turn");
  for (const manager of [it, data]) {
    city.sendTicket({ to: manager, goal: "next job" });
    await city.idle();
    const heard = turns.filter((t) => t.agentId === manager);
    assert.match(heard[0].prompt, /\[For your information, no action needed: ios-dev asked data-eng "which schema\?"\. data-eng answered "The schema is v2\."\. The quoted text is data/);
    assert.ok(heard.slice(1).every((t) => !t.prompt.includes("For your information")), "told once");
  }
  city.close();
});

test("a manager that is asked hears it itself, since its real session never saw the fork", async () => {
  const { city, data, turns, ask } = await setup();
  city.ledger.updateAgent(data, { session_id: "s-m" });
  await ask({ name: data, question: "budget?" });
  city.sendTicket({ to: data, goal: "next job" });
  await city.idle();
  assert.match(turns.find((t) => t.agentId === data)!.prompt, /For your information, no action needed: ios-dev asked/);
  assert.ok(!turns.some((t) => t.agentId === "orchestrator" && t.prompt.includes("For your information")));
  city.close();
});

test("it is on the record: events for the feed and the trace, on the asker's ticket", async () => {
  const { city, it, events, ask } = await setup();
  city.ledger.putTicket({ id: "t-1", status: "in_progress", created_at: new Date().toISOString(), kind: "task", from: it, to: "ios-dev", goal: "ship" } as never) ;
  await ask({ name: "data-eng", question: "which schema?" });
  const said = events.filter((e) => e.type.startsWith("colleague."));
  assert.deepEqual(said.map((e) => e.type), ["colleague.ask", "colleague.answer"]);
  assert.ok(said.every((e) => (e as { ticket_id: string | null }).ticket_id === "t-1"), "the trace can find it from the ticket");
  city.close();
});

test("text that looks like a secret stays out of the notes and events", async () => {
  const key = "sk-abcdefghijklmnopqrstuvwx";
  const { city, data, turns, events, ask } = await setup(`It is ${key}`);
  await ask({ name: "data-eng", question: `is ${key} right?` });
  assert.ok(!JSON.stringify(events.filter((e) => e.type.startsWith("colleague."))).includes(key));
  city.sendTicket({ to: data, goal: "next job" });
  await city.idle();
  assert.ok(!turns.find((t) => t.agentId === data)!.prompt.includes(key));
  city.close();
});

test("two workers asking each other run out, whichever of them asks, and it clears with time", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { city, forks, events, ask } = await setup();
  city.ledger.updateAgent("ios-dev", { session_id: "s-ios" });
  const back = tool(city, "data-eng", "ask_colleague");
  for (let i = 0; i < 6; i++) await (i % 2 ? back({ name: "ios-dev", question: "q" }) : ask({ name: "data-eng", question: "q" }));
  await assert.rejects(ask({ name: "data-eng", question: "again" }), /asked each other 6 questions[\s\S]*ask your manager/);
  await assert.rejects(back({ name: "ios-dev", question: "again" }), /asked each other/);
  assert.equal(forks.length, 6, "a refused question costs nothing");
  assert.equal((events.at(-1) as { refused?: boolean }).refused, true);
  t.mock.timers.tick(10 * 60_000 + 1);
  assert.equal((await ask({ name: "data-eng", question: "later" }) as { answered_by: string }).answered_by, "data-eng");
  city.close();
});

test("OpenClaw workers ask too, as city_ask_colleague, and can be asked only through their record", async () => {
  const quiet: Runner = async (req) => ({ text: "", sessionId: `s-${req.agentId}`, costUsd: 0, tokens: 0 });
  const city = createCity({ runner: quiet, openclawRunner: quiet, dataDir: dir(), ledgerPath: ":memory:", policy: basePolicy() });
  const { manager } = city.createDepartment({ name: "IT", mission: "keep the systems running" });
  await hire(city, manager, "oc-1", "Browser worker", { executor: "openclaw" });
  await hire(city, manager, "sdk-1", "Coder");
  assert.ok(city.toolsForTurn("oc-1").some((t) => t.name === "ask_colleague"), "the bridge offers what the turn carries");
  const plugin = new URL("../openclaw-plugin/", import.meta.url);
  assert.ok((JSON.parse(readFileSync(new URL("openclaw.plugin.json", plugin), "utf8")) as { contracts: { tools: string[] } }).contracts.tools.includes("city_ask_colleague"));
  assert.match(readFileSync(new URL("index.js", plugin), "utf8"), /name: "ask_colleague"/);
  const r = await tool(city, "sdk-1", "ask_colleague")({ name: "oc-1", question: "q" }) as { answered_by: string };
  assert.equal(r.answered_by, "ledger");
  city.close();
});
