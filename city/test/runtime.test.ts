// The city with a scripted runner in place of the Agent SDK: no network, no credentials.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPolicy } from "../src/policy.ts";
import { createCity, type CityEvent } from "../src/runtime.ts";
import type { Runner, TurnRequest } from "../src/sdk.ts";

type Script = Record<string, (req: TurnRequest) => Promise<string | void> | string | void>;
const use = (req: TurnRequest, name: string, args: Record<string, unknown>) => req.tools.find((t) => t.name === name)!.handler(args);

function fakeRunner(script: Script) {
  const calls: TurnRequest[] = [];
  const runner: Runner = async (req) => {
    calls.push(req);
    const text = (await script[req.agentId]?.(req)) ?? "";
    return { text, sessionId: `s-${req.agentId}`, costUsd: 0.01 };
  };
  return { runner, calls };
}

const policy = loadPolicy();
const dir = () => mkdtempSync(join(tmpdir(), "city-"));
const spec = (id: string, kind: "manager" | "worker", parent: string, extra: Record<string, unknown> = {}) => ({
  id, role: id, kind, parent, model: "claude-sonnet-5-5", mission: "m", tools: ["Read"], lifecycle: "persistent", budget_usd_per_day: 1, department: "IT", ...extra,
});

test("a ticket from Jarvis flows orchestrator → manager → worker and back through the Secretary", async () => {
  const log: string[] = [];
  const { runner, calls } = fakeRunner({
    orchestrator: async (req) => {
      if (req.prompt.startsWith("[ticket from jarvis]")) {
        const t = JSON.parse(req.prompt.slice(req.prompt.indexOf("{")));
        await use(req, "hire_agent", { spec: spec("it-manager", "manager", "orchestrator") });
        await use(req, "send_ticket", { ticket: { to: "it-manager", goal: "build it", parent_id: t.id } });
      } else if (req.prompt.startsWith("[report from it-manager")) {
        const id = /on ticket (\S+)\]/.exec(req.prompt)![1];
        const parent = city.ledger.getTicket(id)!.parent_id!;
        await use(req, "report", { ticket_id: parent, status: "done", summary: "built", artifacts: ["/tmp/x"] });
      }
    },
    "it-manager": async (req) => {
      if (req.prompt.startsWith("[ticket from orchestrator]")) {
        const t = JSON.parse(req.prompt.slice(req.prompt.indexOf("{")));
        await use(req, "hire_agent", { spec: spec("py-dev", "worker", "it-manager") });
        await use(req, "send_ticket", { ticket: { to: "py-dev", goal: "write it", parent_id: t.id, scope: ["/tmp"] } });
      } else if (req.prompt.startsWith("[report from py-dev")) {
        const id = /on ticket (\S+)\]/.exec(req.prompt)![1];
        await use(req, "report", { ticket_id: city.ledger.getTicket(id)!.parent_id!, status: "done", summary: "worker done", artifacts: [] });
      }
    },
    "py-dev": async (req) => {
      const t = JSON.parse(req.prompt.slice(req.prompt.indexOf("{")));
      await use(req, "report", { ticket_id: t.id, status: "done", summary: "wrote hello", artifacts: ["/tmp/x/hello.py"] });
    },
    secretary: () => "**Done:** a hello world CLI.",
  });
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy, log: (l) => log.push(l) });
  const events: CityEvent[] = [];
  city.on((e) => events.push(e));
  const ticket = city.sendTicket({ to: "orchestrator", goal: "hello world CLI", owner_words: "write a hello-world Python CLI" });
  assert.equal(ticket.from, "jarvis");
  await city.idle();
  assert.equal(city.ledger.getTicket(ticket.id)?.status, "done");
  assert.deepEqual(events.filter((e) => e.type === "result"), [{ type: "result", ticket_id: ticket.id, status: "done", summary: "**Done:** a hello world CLI.", artifacts: ["/tmp/x"] }]);
  assert.deepEqual(calls.map((c) => c.agentId), ["orchestrator", "it-manager", "py-dev", "it-manager", "orchestrator", "secretary"]);
  assert.equal(city.agent("py-dev").parent, "it-manager");
  assert.equal(city.agent("it-manager").session_id, "s-it-manager");
  assert.match(calls[2].systemPrompt, /py-dev specialist in Jarvis OS, reporting to it-manager/);
  assert.ok(calls[1].allowedTools.includes("mcp__jarvis__report") && calls[1].allowedTools.includes("Read"), "a hired agent may use the tools of its template and of its spec");
  assert.equal(calls[2].cwd, "/tmp");
  assert.equal(city.sendTicket({ id: ticket.id, to: "orchestrator", goal: "again" }).goal, "hello world CLI", "same id is a no-op");
  city.close();
});

test("caps block the agent over max_concurrent_agents and the 5th worker of one manager", async () => {
  const { runner } = fakeRunner({});
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  const hire = (by: string, s: Record<string, unknown>) => city.toolsFor(by).find((t) => t.name === "hire_agent")!.handler({ spec: s });
  const retire = (by: string, id: string) => city.toolsFor(by).find((t) => t.name === "retire_agent")!.handler({ id });
  await hire("orchestrator", spec("mgr-a", "manager", "orchestrator"));
  await hire("mgr-a", spec("wk-1", "worker", "mgr-a"));
  await hire("mgr-a", spec("wk-2", "worker", "mgr-a"));
  await hire("mgr-a", spec("wk-3", "worker", "mgr-a"));
  await assert.rejects(hire("orchestrator", spec("mgr-b", "manager", "orchestrator")), /cap reached: 4 agents/);
  await assert.rejects(hire("mgr-a", spec("wk-4", "worker", "mgr-a")), /cap reached: 4 agents/);
  await retire("mgr-a", "wk-3");
  await hire("mgr-a", spec("wk-4", "worker", "mgr-a"));
  await assert.rejects(hire("orchestrator", { ...spec("bad", "manager", "orchestrator"), extra: 1 }), /unknown field extra/);
  await assert.rejects(hire("orchestrator", spec("mgr-c", "manager", "someone-else")), /parent must be the hiring agent/);
  assert.equal((await city.toolsFor("mgr-a").find((t) => t.name === "list_registry")!.handler({ query: "wk" }) as unknown[]).length, 4, "retired agents stay in the registry");
  city.close();

  const roomy = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy: { ...policy, caps: { ...policy.caps, max_concurrent_agents: 10 } } });
  const h = (by: string, s: Record<string, unknown>) => roomy.toolsFor(by).find((t) => t.name === "hire_agent")!.handler({ spec: s });
  await h("orchestrator", spec("mgr-a", "manager", "orchestrator"));
  for (const id of ["wk-1", "wk-2", "wk-3", "wk-4"]) await h("mgr-a", spec(id, "worker", "mgr-a"));
  await assert.rejects(h("mgr-a", spec("wk-5", "worker", "mgr-a")), /4 workers per manager/);
  await roomy.toolsFor("mgr-a").find((t) => t.name === "retire_agent")!.handler({ id: "wk-1" });
  assert.equal((await h("mgr-a", spec("wk-1", "worker", "mgr-a")) as { state: string }).state, "active", "a retired specialist is revived, not re-hired");
  roomy.close();
});

test("@id from the owner is a direct instruction to that agent with its manager cc'd", async () => {
  const { runner, calls } = fakeRunner({});
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  const hire = city.toolsFor("orchestrator").find((t) => t.name === "hire_agent")!.handler;
  await hire({ spec: spec("app-manager", "manager", "orchestrator") });
  await city.toolsFor("app-manager").find((t) => t.name === "hire_agent")!.handler({ spec: spec("ios-dev", "worker", "app-manager") });
  const t = city.instruct("@ios-dev use SwiftData")!;
  await city.idle();
  assert.equal(t.to, "ios-dev");
  assert.deepEqual(t.cc, ["app-manager"]);
  assert.equal(t.kind, "direct_instruction");
  assert.equal(t.goal, "use SwiftData");
  assert.deepEqual(calls.map((c) => c.agentId), ["ios-dev"]);
  assert.match(calls[0].prompt, /^\[direct instruction from owner, cc app-manager\]/);
  assert.deepEqual(city.ledger.inbox("app-manager").map((x) => x.id), [t.id]);
  assert.equal(city.instruct("plain text"), null);
  assert.throws(() => city.instruct("@nobody hi"), /no agent nobody/);
  city.close();
});

test("a question the manager can answer never reaches the owner; one it cannot does, and the answer comes back as a direct instruction", async () => {
  let managerReply = '{"answers": ["Use SwiftData."]}';
  const { runner, calls } = fakeRunner({ "app-manager": () => managerReply });
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  const events: CityEvent[] = [];
  city.on((e) => events.push(e));
  await city.toolsFor("orchestrator").find((t) => t.name === "hire_agent")!.handler({ spec: spec("app-manager", "manager", "orchestrator", { role: "App Manager" }) });
  await city.toolsFor("app-manager").find((t) => t.name === "hire_agent")!.handler({ spec: spec("ios-dev", "worker", "app-manager", { role: "iOS Developer" }) });
  const ticket = city.ledger.getTicket(city.sendTicket({ to: "orchestrator", goal: "app" }).id)!;
  await city.idle();
  const ask = city.toolsFor("ios-dev").find((t) => t.name === "ask_user")!.handler;
  const q1 = await ask({ question: { ticket_id: ticket.id, questions: [{ text: "Core Data or SwiftData?", default: "SwiftData" }] } }) as { answered_by?: string; answer?: string };
  await city.idle();
  assert.equal(q1.answered_by, "app-manager");
  assert.equal(events.filter((e) => e.type === "question").length, 0, "the owner was never asked");
  const toDev = calls.filter((c) => c.agentId === "ios-dev");
  assert.equal(toDev.length, 1);
  assert.match(toDev[0].prompt, /direct instruction from app-manager.*Answer to your question \(q-[0-9a-f]+\): Use SwiftData\./);

  managerReply = '{"escalate": true}';
  const q2 = await ask({ question: { ticket_id: ticket.id, blocking: true, questions: [{ text: "Ship to TestFlight?", default: "no", options: ["yes", "no"] }] } }) as { id: string };
  await city.idle();
  const asked = events.filter((e) => e.type === "question");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].type === "question" && asked[0].question.path, "App Manager › iOS Developer");
  assert.equal(city.ledger.getTicket(ticket.id)?.status, "waiting_on_owner");
  const dup = await ask({ question: { ticket_id: ticket.id, questions: [{ text: "Ship to TestFlight?", default: "no" }] } }) as { id: string };
  assert.equal(dup.id, q2.id, "identical open questions are deduped");
  const reply = city.answer(q2.id, "yes");
  await city.idle();
  assert.equal(reply.to, "ios-dev");
  assert.deepEqual(reply.cc, ["app-manager"]);
  assert.equal(city.ledger.getTicket(ticket.id)?.status, "in_progress");
  assert.throws(() => city.answer(q2.id, "again"), /already answered/);

  // The owner's reply relayed by Jarvis as a direct instruction answers the open question too.
  const q3 = await ask({ question: { ticket_id: ticket.id, blocking: true, questions: [{ text: "Dark mode?", default: "yes" }] } }) as { id: string };
  await city.idle();
  assert.equal(city.ledger.getTicket(ticket.id)?.status, "waiting_on_owner");
  city.toolsFor("jarvis").find((t) => t.name === "send_ticket")!.handler({ ticket: { to: "ios-dev", kind: "direct_instruction", goal: "yes, dark mode" } });
  await city.idle();
  assert.equal(city.ledger.getQuestion(q3.id)?.answer, "yes, dark mode");
  assert.equal(city.ledger.getTicket(ticket.id)?.status, "in_progress");
  city.close();
});

test("after a restart the daemon resumes in_progress tickets and re-asks open questions", async () => {
  const data = dir();
  const ledgerPath = join(data, "ledger.db");
  const first = fakeRunner({ orchestrator: async (req) => { const t = JSON.parse(req.prompt.slice(req.prompt.indexOf("{"))); await use(req, "ask_user", { question: { ticket_id: t.id, questions: [{ text: "Which repo?", default: "new" }] } }); } });
  let city = createCity({ runner: first.runner, dataDir: data, ledgerPath, policy });
  const ticket = city.sendTicket({ to: "orchestrator", goal: "work" });
  await city.idle();
  assert.equal(city.ledger.getTicket(ticket.id)?.status, "in_progress", "the agent never reported, so the ticket is still open");
  city.close(); // the kill

  const second = fakeRunner({});
  city = createCity({ runner: second.runner, dataDir: data, ledgerPath, policy });
  const events: CityEvent[] = [];
  city.on((e) => events.push(e));
  await city.resume();
  await city.idle();
  assert.equal(second.calls.length, 1);
  assert.equal(second.calls[0].agentId, "orchestrator");
  assert.equal(second.calls[0].resume, "s-orchestrator", "the saved session is resumed");
  assert.match(second.calls[0].prompt, /^\[resumed after a restart/);
  assert.equal(events.filter((e) => e.type === "question").length, 1);
  city.close();
});

test("request_review runs the reviewer and counts rounds; a failed turn fails the ticket and reaches the owner", async () => {
  const { runner } = fakeRunner({
    reviewer: () => 'Here you go: {"verdict": "FAIL", "findings": [{"severity": "major", "where": "a.py", "problem": "p", "fix": "f", "owner_hint": "IT"}], "summary": "one bug"}',
    orchestrator: () => { throw new Error("boom"); },
    secretary: () => "**Done:** nothing. **Needs you:** the orchestrator failed.",
  });
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  const events: CityEvent[] = [];
  city.on((e) => events.push(e));
  const ticket = city.sendTicket({ to: "orchestrator", goal: "x" });
  await city.idle();
  assert.equal(city.ledger.getTicket(ticket.id)?.status, "failed");
  assert.equal(events[0].type, "result");
  assert.match(events[0].type === "result" ? events[0].summary : "", /Needs you/);
  const t2 = city.ledger.getTicket(city.sendTicket({ to: "secretary", goal: "y" }).id)!;
  const verdict = await city.toolsFor("secretary").find((t) => t.name === "request_review")!.handler({ ticket_id: t2.id, artifact: "diff" }) as { verdict: string };
  assert.equal(verdict.verdict, "FAIL");
  assert.equal(city.ledger.getTicket(t2.id)?.review_rounds, 1);
  city.close();
});

test("temporary teams retire when their work is done; persistent ones stay", async () => {
  const { runner } = fakeRunner({
    "travel-manager": async (req) => {
      if (req.prompt.startsWith("[ticket from jarvis]")) {
        const t = JSON.parse(req.prompt.slice(req.prompt.indexOf("{")));
        await use(req, "hire_agent", { spec: spec("flights", "worker", "travel-manager", { lifecycle: "temporary" }) });
        await use(req, "send_ticket", { ticket: { to: "flights", goal: "find", parent_id: t.id } });
      } else if (req.prompt.startsWith("[report from flights")) {
        const id = /on ticket (\S+)\]/.exec(req.prompt)![1];
        await use(req, "report", { ticket_id: city.ledger.getTicket(id)!.parent_id!, status: "done", summary: "trip found", artifacts: [] });
      }
    },
    flights: async (req) => { const t = JSON.parse(req.prompt.slice(req.prompt.indexOf("{"))); await use(req, "report", { ticket_id: t.id, status: "done", summary: "ok", artifacts: [] }); },
    secretary: () => "**Done:** trip.",
  });
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  const hire = city.toolsFor("orchestrator").find((t) => t.name === "hire_agent")!.handler;
  await hire({ spec: spec("travel-manager", "manager", "orchestrator", { lifecycle: "temporary", department: "Travel" }) });
  await hire({ spec: spec("it-manager", "manager", "orchestrator") });
  city.sendTicket({ to: "travel-manager", goal: "trip" });
  await city.idle();
  assert.equal(city.agent("flights").state, "retired");
  assert.equal(city.agent("travel-manager").state, "retired");
  assert.equal(city.agent("it-manager").state, "active");
  city.close();
});

test("an agent that ends its turn without reporting gets one reminder, then the ticket fails with its last words", async () => {
  const { runner, calls } = fakeRunner({ orchestrator: () => "I could not do it.", secretary: () => "**Done:** nothing. **Needs you:** it was dropped." });
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  const events: CityEvent[] = [];
  city.on((e) => events.push(e));
  const ticket = city.sendTicket({ to: "orchestrator", goal: "x" });
  await city.idle();
  assert.deepEqual(calls.map((c) => c.agentId), ["orchestrator", "orchestrator", "secretary"]);
  assert.match(calls[1].prompt, /^\[reminder\] Ticket t-/);
  const final = city.ledger.getTicket(ticket.id)!;
  assert.equal(final.status, "failed");
  assert.match(final.result!.summary!, /ended its turn without reporting: I could not do it\./);
  assert.equal(events.filter((e) => e.type === "result").length, 1);

  // Delegating counts as progress: the sub-ticket's turn comes next, not a reminder.
  const quiet = fakeRunner({ orchestrator: async (req) => { if (req.prompt.startsWith("[ticket from jarvis]")) await use(req, "send_ticket", { ticket: { to: "secretary", goal: "sub" } }); } });
  const city2 = createCity({ runner: quiet.runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  city2.sendTicket({ to: "orchestrator", goal: "y" });
  await city2.idle();
  assert.deepEqual(quiet.calls.slice(0, 2).map((c) => c.agentId), ["orchestrator", "secretary"]);
  assert.match(quiet.calls[1].prompt, /^\[ticket from orchestrator\]/);
  city.close(); city2.close();
});

test("a later report that corrects a ticket's status goes through; a repeat is ignored", async () => {
  const { runner } = fakeRunner({ secretary: () => "summary" });
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  const events: CityEvent[] = [];
  city.on((e) => events.push(e));
  const t = city.ledger.getTicket(city.sendTicket({ to: "secretary", goal: "x" }).id)!;
  await city.idle();
  const report = city.toolsFor("secretary").find((x) => x.name === "report")!.handler;
  await report({ ticket_id: t.id, status: "failed", summary: "not yet", artifacts: [] });
  await report({ ticket_id: t.id, status: "failed", summary: "still not", artifacts: [] });
  await report({ ticket_id: t.id, status: "done", summary: "actually done", artifacts: [] });
  await city.idle();
  assert.deepEqual(events.filter((e) => e.type === "result").map((e) => e.type === "result" && e.status), ["failed", "done"]);
  assert.equal(city.ledger.getTicket(t.id)?.result?.summary, "actually done");
  city.close();
});
