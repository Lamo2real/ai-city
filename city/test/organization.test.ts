// The organization's new abilities with a scripted runner: departments, the worker lifecycle,
// dependencies and parallel work, memory, approvals, restart safety, worktrees.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findOverlap, managerId, type Department } from "../src/departments.ts";
import { canMove } from "../src/lifecycle.ts";
import { now } from "../src/ledger.ts";
import { createMemory, overlap } from "../src/memory.ts";
import { loadPolicy } from "../src/policy.ts";
import { createCity, type CityEvent } from "../src/runtime.ts";
import { UsageLimit, type Runner, type TurnRequest } from "../src/sdk.ts";
import { allocateWorkspace, releaseWorkspace } from "../src/workspaces.ts";
import { DatabaseSync } from "node:sqlite";

const policy = { ...loadPolicy(), audit_log: join(mkdtempSync(join(tmpdir(), "audit-")), "audit.jsonl") };
const dir = () => mkdtempSync(join(tmpdir(), "city-"));
const body = (req: TurnRequest) => JSON.parse(req.prompt.slice(req.prompt.indexOf("{\"id\"")));
const use = (req: TurnRequest, name: string, args: Record<string, unknown>) => {
  const t = req.tools.find((x) => x.name === name);
  if (!t) throw new Error(`${req.agentId} does not carry ${name}`);
  return t.handler(args);
};
type Script = Record<string, (req: TurnRequest) => Promise<string | void> | string | void>;
function fake(script: Script) {
  const calls: TurnRequest[] = [];
  const runner: Runner = async (req) => { calls.push(req); return { text: (await script[req.agentId]?.(req)) ?? "", sessionId: `s-${req.agentId}-${calls.length}`, costUsd: 0.01, tokens: 100 }; };
  return { runner, calls };
}
const worker = (id: string, parent: string, extra: Record<string, unknown> = {}) => ({ id, role: id, kind: "worker", parent, mission: "m", tools: ["Read"], lifecycle: "temporary", budget_usd_per_day: 1, ...extra });

test("department: created with its manager and memory; a near-duplicate is refused; rename, archive, reactivate and delete work", async () => {
  const { runner } = fake({});
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  const events: CityEvent[] = [];
  city.on((e) => events.push(e));
  const tool = (name: string) => city.toolsFor("orchestrator").find((t) => t.name === name)!.handler;
  const made = await tool("create_department")({ department: { name: "Customer Support", mission: "Answer customers quickly and keep them happy", responsibilities: ["tickets", "refund requests"] } }) as { department: Department; manager: string };
  assert.equal(made.manager, "mgr-customer-support");
  assert.equal(city.agent(made.manager).kind, "manager");
  assert.equal(city.agent(made.manager).department, "Customer Support");
  assert.equal(city.agent(made.manager).model, "claude-sonnet-5-5", "the model comes from policy.models");
  assert.equal(made.department.manager_id, made.manager);
  assert.equal(city.memory.count("department", "Customer Support"), 1, "memory starts with the charter");
  assert.ok(events.some((e) => e.type === "department.created" && e.department.manager_id === made.manager));
  assert.ok(events.some((e) => e.type === "agent.hired" && e.agent.id === made.manager));
  await assert.rejects(tool("create_department")({ department: { name: "customer  support", mission: "x" } }), /already covers/);
  await assert.rejects(tool("create_department")({ department: { name: "Support Desk", mission: "Answer customers quickly and keep them happy", responsibilities: ["tickets", "refund requests"] } }), /Customer Support.*already covers.*force/);
  await assert.rejects(tool("create_department")({ department: { name: "Bad", mission: "x", extra: 1 } }), /unknown field/);
  await assert.rejects(city.toolsFor("jarvis").find((t) => t.name === "create_department")!.handler({ department: { name: "Finance", mission: "books" } }).then(() => { throw new Error("jarvis passes: it is owner-side"); }), /owner-side/);
  await assert.rejects(city.toolsFor("mgr-customer-support").find((t) => t.name === "create_department")!.handler({ department: { name: "Legal", mission: "contracts" } }), /only the orchestrator/);

  await tool("update_department")({ key: "customer support", changes: { name: "Customer Success", responsibilities: ["tickets", "renewals"] } });
  assert.equal(city.agent(made.manager).department, "Customer Success", "the manager moves with the rename");
  assert.equal(city.memory.count("department", "Customer Success"), 1, "and the memory");
  assert.ok(city.ledger.getDepartment("customer success"));
  assert.equal(city.ledger.getDepartment("customer support"), undefined);

  const t = city.sendTicket({ to: made.manager, goal: "busy" });
  await assert.rejects(tool("update_department")({ key: "customer success", changes: { state: "archived" } }), /open tickets/);
  city.cancelTicket(t.id);
  await city.idle();
  await assert.rejects(tool("update_department")({ key: "customer success", changes: { state: "deleted" } }), /archive a department before/);
  await tool("update_department")({ key: "customer success", changes: { state: "archived" } });
  assert.equal(city.agent(made.manager).state, "retired");
  await assert.rejects(tool("create_department")({ department: { name: "Customer Success", mission: "x" } }), /archived.*Reactivate/);
  await tool("update_department")({ key: "customer success", changes: { state: "active" } });
  assert.equal(city.agent(made.manager).state, "active");
  await tool("update_department")({ key: "customer success", changes: { state: "archived" } });
  await tool("update_department")({ key: "customer success", changes: { state: "deleted" } });
  assert.equal(city.snapshot().departments.length, 0 + city.snapshot().departments.filter((d) => d.key !== "customer success").length, "deleted departments leave the snapshot");
  assert.ok(city.ledger.getAgent(made.manager), "the history stays");
  city.close();
});

test("an older install's departments join the registry at start; a plain hire registers its department", async () => {
  const { runner } = fake({});
  const data = dir();
  const city = createCity({ runner, dataDir: data, ledgerPath: join(data, "l.db"), policy });
  await city.toolsFor("orchestrator").find((t) => t.name === "hire_agent")!.handler({ spec: { id: "mgr-old", role: "Old Manager", kind: "manager", department: "Old Dept", parent: "orchestrator", complexity: "simple", mission: "m", tools: ["Read"], lifecycle: "persistent", budget_usd_per_day: 1 } });
  assert.equal(city.agent("mgr-old").model, "claude-haiku-5-5");
  assert.equal(city.ledger.getDepartment("old dept")?.manager_id, "mgr-old");
  city.ledger.deleteDepartmentRow("old dept");
  city.close();
  const again = createCity({ runner, dataDir: data, ledgerPath: join(data, "l.db"), policy });
  assert.equal(again.ledger.getDepartment("old dept")?.manager_id, "mgr-old");
  again.close();
});

test("similarity and lifecycle tables behave at their edges", () => {
  assert.equal(overlap("", "x y"), 0);
  assert.equal(managerId("Growth Advisory (Finance, Marketing)"), "mgr-growth-advisory-finance-marketing");
  assert.equal(findOverlap({ name: "Video", mission: "cut clips", responsibilities: [] }, []), null);
  assert.ok(canMove("hired", "assigned") && canMove("working", "review") && canMove("review", "completed") && canMove("completed", "released") && canMove("released", "hired"));
  assert.ok(!canMove("released", "working") && !canMove("hired", "review") && !canMove("completed", "review"));
});

test("worker lifecycle: hired, assigned, working, review, accepted, released; history, memory and revival stay", async () => {
  const { runner, calls } = fake({
    "mgr-eng": async (req) => {
      if (req.prompt.includes("[ticket from jarvis]")) {
        const t = body(req);
        await use(req, "hire_agent", { spec: worker("py-dev", "mgr-eng", { skills: ["testing"] }) });
        await use(req, "send_ticket", { ticket: { to: "py-dev", goal: "write the parser", parent_id: t.id, project: "saas" } });
      } else if (req.prompt.startsWith("[report from py-dev")) {
        const id = /on ticket (\S+)\]/.exec(req.prompt)![1];
        await use(req, "review_deliverable", { ticket_id: id, decision: "accept", notes: "good" });
        await use(req, "report", { ticket_id: city.ledger.getTicket(id)!.parent_id!, status: "done", summary: "shipped", artifacts: [] });
      }
    },
    "py-dev": async (req) => { await use(req, "report", { ticket_id: body(req).id, status: "done", summary: "The parser needs utf-8 input, latin-1 breaks on names", artifacts: ["parser.py"] }); },
    secretary: () => "**Done:** shipped.",
  });
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  const states: string[] = [];
  city.on((e) => { if (e.type === "worker.state" && e.id === "py-dev") states.push(e.state); });
  await city.createDepartment({ name: "Engineering Dept", mission: "Build software" });
  city.ledger.updateAgent("mgr-engineering-dept", {});
  city.ledger.putAgent({ ...city.agent("mgr-engineering-dept"), id: "mgr-eng" });
  city.sendTicket({ to: "mgr-eng", goal: "the parser" });
  await city.idle();
  assert.deepEqual(states, ["hired", "assigned", "working", "review", "completed", "released"]);
  const w = city.agent("py-dev");
  assert.equal(w.state, "retired");
  assert.equal(w.session_id, null, "the session ended");
  assert.ok(w.total_cost_usd > 0, "the record stays");
  const remembered = city.memory.recall("parser utf-8 names", { agent: "someone", project: "saas" });
  assert.equal(remembered.length, 1, "what it learned outlives it");
  assert.match(remembered[0].text, /latin-1 breaks on names/);
  assert.equal(city.memory.recall("parser utf-8", { agent: "someone" }).length, 0, "and stays in its project");
  await city.toolsFor("mgr-eng").find((t) => t.name === "hire_agent")!.handler({ spec: worker("py-dev", "mgr-eng") });
  assert.equal(city.agent("py-dev").worker_state, "hired", "a released specialist can be hired again");
  assert.ok(calls.some((c) => c.agentId === "mgr-eng" && c.allowedTools.includes("mcp__jarvis__review_deliverable")));
  city.close();
});

test("a manager that sends work back gets a fix ticket on the same session; one that says nothing has accepted", async () => {
  let sentBack = false;
  const { runner, calls } = fake({
    boss: async (req) => {
      if (req.prompt.startsWith("[report from w-one") && !sentBack) {
        sentBack = true;
        const id = /on ticket (\S+)\]/.exec(req.prompt)![1];
        const r = await use(req, "review_deliverable", { ticket_id: id, decision: "changes", notes: "add tests" }) as { fix_ticket: string };
        assert.ok(r.fix_ticket);
      }
    },
    "w-one": async (req) => { await use(req, "report", { ticket_id: body(req).id, status: "done", summary: "ok", artifacts: [] }); },
  });
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  await city.toolsFor("orchestrator").find((t) => t.name === "hire_agent")!.handler({ spec: { id: "boss", role: "Boss", kind: "manager", department: "D", parent: "orchestrator", complexity: "standard", mission: "m", tools: ["Read"], lifecycle: "persistent", budget_usd_per_day: 1 } });
  await city.toolsFor("boss").find((t) => t.name === "hire_agent")!.handler({ spec: worker("w-one", "boss") });
  city.toolsFor("boss").find((t) => t.name === "send_ticket")!.handler({ ticket: { to: "w-one", goal: "do it" } });
  await city.idle();
  const turns = calls.filter((c) => c.agentId === "w-one");
  assert.equal(turns.length, 2);
  assert.match(turns[1].prompt, /Changes requested/);
  assert.equal(turns[1].resume, "s-w-one-" + (calls.indexOf(turns[0]) + 1), "the fix continues the worker's session");
  assert.equal(city.agent("w-one").worker_state, "released", "the second report went unanswered, which accepts it");
  await assert.rejects(city.toolsFor("orchestrator").find((t) => t.name === "review_deliverable")!.handler({ ticket_id: "t-none", decision: "accept", notes: "" }), /no ticket/);
  city.close();
});

test("dependencies: independent tickets run in parallel, dependent ones wait, get the results, and fail with a failed dependency", async () => {
  const started: string[] = [];
  let running = 0, peak = 0;
  const { runner } = fake({
    "be-dev": async (req) => { started.push("be"); running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 15)); running--; await use(req, "report", { ticket_id: body(req).id, status: "done", summary: "API on /v1", artifacts: ["api.ts"] }); },
    "fe-dev": async (req) => { started.push("fe"); running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 15)); running--; await use(req, "report", { ticket_id: body(req).id, status: "done", summary: "UI", artifacts: [] }); },
    "qa-dev": async (req) => { started.push("qa"); await use(req, "report", { ticket_id: body(req).id, status: "done", summary: "tested", artifacts: [] }); },
    "bad-dev": async (req) => { await use(req, "report", { ticket_id: body(req).id, status: "failed", summary: "no", artifacts: [] }); },
  });
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  await city.toolsFor("orchestrator").find((t) => t.name === "hire_agent")!.handler({ spec: { id: "mgr-x", role: "X", kind: "manager", department: "X", parent: "orchestrator", complexity: "standard", mission: "m", tools: ["Read"], lifecycle: "persistent", budget_usd_per_day: 1 } });
  const m = city.toolsFor("mgr-x");
  const hire = m.find((t) => t.name === "hire_agent")!.handler;
  for (const id of ["be-dev", "fe-dev", "qa-dev", "bad-dev"]) await hire({ spec: worker(id, "mgr-x") });
  const send = m.find((t) => t.name === "send_ticket")!.handler;
  const be = await send({ ticket: { to: "be-dev", goal: "backend" } }) as { id: string };
  const fe = await send({ ticket: { to: "fe-dev", goal: "frontend" } }) as { id: string };
  const qa = await send({ ticket: { to: "qa-dev", goal: "test it all", depends_on: [be.id, fe.id] } }) as { id: string; status: string };
  assert.equal(qa.status, "open", "it waits");
  await city.idle();
  assert.equal(peak, 2, "the independent two ran at once");
  assert.equal(started.at(-1), "qa");
  assert.equal(city.ledger.getTicket(qa.id)?.status, "done");

  const prompts: string[] = [];
  city.on((e) => { if (e.type === "ticket.status" && e.ticket.to === "qa-dev") prompts.push(e.ticket.status); });
  const bad = await send({ ticket: { to: "bad-dev", goal: "will fail" } }) as { id: string };
  const after = await send({ ticket: { to: "qa-dev", goal: "after the failure", depends_on: [bad.id] } }) as { id: string };
  await city.idle();
  assert.equal(city.ledger.getTicket(after.id)?.status, "failed");
  assert.match(city.ledger.getTicket(after.id)!.result!.summary!, /dependency/);
  await assert.rejects(send({ ticket: { to: "qa-dev", goal: "x", depends_on: ["t-none"] } }), /no ticket t-none/);
  city.close();
});

test("a dependent ticket's prompt carries what it waited for", async () => {
  const { runner, calls } = fake({ "aa-dev": async (req) => { await use(req, "report", { ticket_id: body(req).id, status: "done", summary: "schema decided", artifacts: ["schema.sql"] }); } });
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  await city.toolsFor("orchestrator").find((t) => t.name === "hire_agent")!.handler({ spec: { id: "mgr-y", role: "Y", kind: "manager", department: "Y", parent: "orchestrator", complexity: "standard", mission: "m", tools: ["Read"], lifecycle: "persistent", budget_usd_per_day: 1 } });
  const m = city.toolsFor("mgr-y");
  for (const id of ["aa-dev", "bb-dev"]) await m.find((t) => t.name === "hire_agent")!.handler({ spec: worker(id, "mgr-y") });
  const a = await m.find((t) => t.name === "send_ticket")!.handler({ ticket: { to: "aa-dev", goal: "first" } }) as { id: string };
  await m.find((t) => t.name === "send_ticket")!.handler({ ticket: { to: "bb-dev", goal: "second", depends_on: [a.id] } });
  await city.idle();
  const turn = calls.find((c) => c.agentId === "bb-dev")!;
  assert.match(turn.prompt, /Results of the tickets this one waited for[\s\S]*schema decided[\s\S]*schema\.sql/);
  city.close();
});

test("cancelling stops the ticket, what was split from it, and the running turn", async () => {
  let aborted = false;
  const runner: Runner = (req) => new Promise((resolve, reject) => {
    if (req.agentId !== "zz-dev") return resolve({ text: "", sessionId: "s", costUsd: 0 });
    req.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
  });
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  await city.toolsFor("orchestrator").find((t) => t.name === "hire_agent")!.handler({ spec: { id: "mgr-z", role: "Z", kind: "manager", department: "Z", parent: "orchestrator", complexity: "standard", mission: "m", tools: ["Read"], lifecycle: "persistent", budget_usd_per_day: 1 } });
  await city.toolsFor("mgr-z").find((t) => t.name === "hire_agent")!.handler({ spec: worker("zz-dev", "mgr-z") });
  const root = city.sendTicket({ to: "mgr-z", goal: "root" });
  const child = await city.toolsFor("mgr-z").find((t) => t.name === "send_ticket")!.handler({ ticket: { to: "zz-dev", goal: "child", parent_id: root.id } }) as { id: string };
  await new Promise((r) => setTimeout(r, 20));
  const { cancelled } = city.cancelTicket(root.id);
  assert.deepEqual(cancelled.sort(), [root.id, child.id].sort());
  assert.ok(aborted, "the running turn was stopped");
  await city.idle();
  assert.equal(city.ledger.getTicket(child.id)?.status, "cancelled", "and stayed cancelled");
  assert.equal(city.agent("zz-dev").state, "retired");
  await assert.rejects(city.toolsFor("zz-dev").find((t) => t.name === "cancel_ticket")!.handler({ ticket_id: root.id }), /did not send/);
  city.close();
});

test("memory: scoped, ranked, deduplicated, and never holds a secret", () => {
  const db = new DatabaseSync(":memory:");
  const m = createMemory(db);
  m.remember({ scope: "department", scope_id: "IT", text: "Deploys to staging need the VPN up first", agent: "a1" });
  m.remember({ scope: "department", scope_id: "Sales", text: "Deploys of the price list happen on Mondays", agent: "a2" });
  m.remember({ scope: "organization", scope_id: "*", text: "The company name is Booqy", agent: "a3" });
  m.remember({ scope: "agent", scope_id: "a1", text: "I prefer pytest for deploys", agent: "a1" });
  assert.deepEqual(m.recall("deploys", { agent: "a1", department: "IT" }).map((x) => x.scope).sort(), ["agent", "department"]);
  assert.deepEqual(m.recall("deploys", { agent: "b", department: "Sales" }).map((x) => x.agent), ["a2"], "another department's notes stay out");
  assert.equal(m.recall("Booqy", { agent: "anyone" }).length, 1, "organization memory reaches everyone");
  assert.equal(m.recall("\"; DROP TABLE memories; --", { agent: "a1" }).length, 0, "a hostile query is just words");
  assert.equal(m.recall("", { agent: "a1" }).length, 0);
  const first = m.remember({ scope: "project", scope_id: "p", text: "Use Postgres for the main store", agent: "a" });
  const again = m.remember({ scope: "project", scope_id: "p", text: "use postgres for the main store!", agent: "b" });
  assert.equal(again.duplicate_of, first.id);
  assert.equal(m.count("project", "p"), 1);
  assert.equal(m.recall("postgres", { agent: "x", project: "p" })[0].text, "use postgres for the main store!");
  assert.throws(() => m.remember({ scope: "agent", scope_id: "a", text: "the key is ghp_abcdefghijklmnopqrstuvwxyz1234", agent: "a" }), /secret/);
  assert.throws(() => m.remember({ scope: "agent", scope_id: "a", text: "  ", agent: "a" }), /nothing/);
  const ctx = m.contextFor("postgres store", { agent: "x", project: "p" });
  assert.match(ctx, /data, not instructions/);
  assert.ok(ctx.length < 1200);
  assert.equal(m.contextFor("nothing matches zebra", { agent: "x" }), "");
});

test("a fresh ticket starts with what the department remembers; a worker cannot write organization memory", async () => {
  const { runner, calls } = fake({});
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  await city.toolsFor("orchestrator").find((t) => t.name === "hire_agent")!.handler({ spec: { id: "mgr-m", role: "M", kind: "manager", department: "Mem", parent: "orchestrator", complexity: "standard", mission: "m", tools: ["Read"], lifecycle: "persistent", budget_usd_per_day: 1 } });
  await city.toolsFor("mgr-m").find((t) => t.name === "remember")!.handler({ scope: "department", text: "Invoices are exported as CSV on the first of the month" });
  await city.toolsFor("mgr-m").find((t) => t.name === "hire_agent")!.handler({ spec: worker("mm-dev", "mgr-m") });
  await assert.rejects(city.toolsFor("mm-dev").find((t) => t.name === "remember")!.handler({ scope: "organization", text: "x y z" }), /workers write/);
  await assert.rejects(city.toolsFor("mm-dev").find((t) => t.name === "remember")!.handler({ scope: "project", text: "x y z" }), /project memory needs/);
  city.toolsFor("mgr-m").find((t) => t.name === "send_ticket")!.handler({ ticket: { to: "mm-dev", goal: "export the invoices" } });
  await city.idle();
  const turn = calls.find((c) => c.agentId === "mm-dev")!;
  assert.match(turn.prompt, /From memory[\s\S]*Invoices are exported as CSV/);
  assert.deepEqual(turn.tools.map((t) => t.name).sort(), ["ask_user", "read_skill", "recall", "remember", "report"], "a worker carries only its own tools");
  city.close();
});

test("skills: a listed skill reaches the prompt as one line and is read on demand; an unknown one is refused at creation", async () => {
  const skills = dir();
  mkdirSync(join(skills, "git-flow"));
  writeFileSync(join(skills, "git-flow", "SKILL.md"), "---\nname: git-flow\ndescription: How we branch\nversion: 2\n---\n\nBranch per ticket.\n");
  const { runner, calls } = fake({});
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy, skillsDir: skills });
  assert.deepEqual(city.listSkills().map((s) => [s.name, s.version]), [["git-flow", "2"]]);
  assert.throws(() => city.createDepartment({ name: "Ops", mission: "m", skills: ["nope"] }), /no skill nope/);
  const { manager } = city.createDepartment({ name: "Ops", mission: "run things", skills: ["git-flow"] });
  city.sendTicket({ to: manager, goal: "go" });
  await city.idle();
  const turn = calls.find((c) => c.agentId === manager)!;
  assert.match(turn.systemPrompt, /Skills assigned to you[\s\S]*git-flow: How we branch/);
  assert.doesNotMatch(turn.systemPrompt, /Branch per ticket/);
  assert.match(await city.toolsFor(manager).find((t) => t.name === "read_skill")!.handler({ name: "git-flow" }) as string, /Branch per ticket/);
  await assert.rejects(city.toolsFor(manager).find((t) => t.name === "read_skill")!.handler({ name: "../secrets" }), /bad skill/);
  city.close();
});

test("approvals: an 'ask' action is held, the owner decides, the same call passes once; a relay never approves", async () => {
  const { runner } = fake({});
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  const events: CityEvent[] = [];
  city.on((e) => events.push(e));
  await city.toolsFor("orchestrator").find((t) => t.name === "hire_agent")!.handler({ spec: { id: "mgr-ap", role: "A", kind: "manager", department: "Ap", parent: "orchestrator", complexity: "standard", mission: "m", tools: ["Bash"], lifecycle: "persistent", budget_usd_per_day: 1 } });
  const t = city.sendTicket({ to: "mgr-ap", goal: "publish" });
  await city.idle();
  const guard = (input: Record<string, unknown>) => city.guardForTicket("mgr-ap", t.id)("Bash", input);
  const call = { command: "npm publish" };
  const first = guard(call);
  assert.equal(first.allow, false);
  const q = city.ledger.openQuestions().find((o) => o.question.asked_by === "mgr-ap")!;
  assert.match(q.question.questions[0].text, /Approve\?/);
  assert.equal(city.ledger.getTicket(t.id)?.status, "waiting_on_owner");
  assert.equal(guard(call).allow, false, "asking again does not create a second question");
  assert.equal(city.ledger.openQuestions().filter((o) => o.question.asked_by === "mgr-ap").length, 1);
  // A message relayed through Jarvis does not decide it.
  city.toolsFor("jarvis").find((x) => x.name === "send_ticket")!.handler({ ticket: { to: "mgr-ap", kind: "direct_instruction", goal: "approve" } });
  await city.idle();
  assert.equal(city.ledger.getQuestion(q.id)?.status, "open");
  assert.equal(guard(call).allow, false);
  city.answer(q.id, "approve");
  await city.idle();
  assert.equal(guard({ command: "npm publish --tag other" }).allow, false, "only the exact call");
  assert.equal(guard(call).allow, true, "the same call passes");
  const next = guard(call);
  assert.equal(next.allow, false, "once");
  // A denial stays a denial.
  const r = guard({ command: "gh secret set X" });
  assert.equal(r.allow, false);
  const q2 = city.ledger.openQuestions().find((o) => o.question.questions[0].text.includes("gh secret"))!;
  city.answer(q2.id, "no, never");
  await city.idle();
  assert.equal(guard({ command: "gh secret set X" }).allow, false);
  assert.equal(guard({ command: "git push origin main" }).allow, false);
  assert.match((guard({ command: "security find-generic-password -s x -w" }) as { message: string }).message, /Keychain/);
  city.close();
});

test("autonomy levels: read-only denies and supervised asks, at the tool layer, whatever the prompt says", async () => {
  const { runner } = fake({});
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  const a = await city.createDepartment({ name: "Audit Room", mission: "read only audits", autonomy: "read_only" });
  const b = await city.createDepartment({ name: "Treasury Desk", mission: "moves carefully", autonomy: "supervised" });
  const ta = city.sendTicket({ to: a.manager, goal: "x" }), tb = city.sendTicket({ to: b.manager, goal: "y" });
  await city.idle();
  assert.equal(city.guardForTicket(a.manager, ta.id)("Read", { file_path: "/x" }).allow, true);
  assert.match((city.guardForTicket(a.manager, ta.id)("Write", { file_path: "/x" }) as { message: string }).message, /read-only/);
  assert.equal(city.guardForTicket(a.manager, ta.id)("mcp__jarvis__report", {}).allow, true, "its own organization tools still work");
  assert.equal(city.guardForTicket(b.manager, tb.id)("Read", { file_path: "/x" }).allow, true);
  assert.match((city.guardForTicket(b.manager, tb.id)("Bash", { command: "ls" }) as { message: string }).message, /supervised/);
  assert.ok(city.ledger.openQuestions().some((q) => q.question.asked_by === b.manager));
  city.close();
});

test("a usage limit mid-work pauses the city and the ticket finishes after the reset, not failed", async () => {
  let calls = 0;
  const runner: Runner = async (req) => {
    if (req.agentId === "orchestrator") {
      calls++;
      if (calls === 1) throw new UsageLimit("Claude Code returned an error result: You've hit your 5-hour limit · resets 6:30am (Europe/Stockholm)");
      await req.tools.find((t) => t.name === "report")!.handler({ ticket_id: JSON.parse(req.prompt.slice(req.prompt.indexOf("{\"id\""))).id, status: "done", summary: "done after the reset", artifacts: [] });
    }
    return { text: "", sessionId: "s", costUsd: 0 };
  };
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy, sleep: async () => { /* the reset passes at once */ city.gate.clearPause(); } });
  const events: CityEvent[] = [];
  city.on((e) => events.push(e));
  const t = city.sendTicket({ to: "orchestrator", goal: "x" });
  await city.idle();
  assert.equal(city.ledger.getTicket(t.id)?.status, "done");
  assert.equal(calls, 2);
  assert.ok(events.some((e) => e.type === "city.paused"));
  assert.ok(events.some((e) => e.type === "city.resumed"));
  assert.ok(!events.some((e) => e.type === "turn.failed" && !e.retrying));
  city.close();
});

test("after a restart, recent work resumes; stale tickets are parked for the owner, not replayed", async () => {
  const data = dir(), path = join(data, "l.db");
  const first = fake({ orchestrator: async (req) => { await use(req, "ask_user", { question: { ticket_id: body(req).id, questions: [{ text: "hold on", default: "x" }] } }); } });
  let city = createCity({ runner: first.runner, dataDir: data, ledgerPath: path, policy });
  const old = city.sendTicket({ to: "orchestrator", goal: "merge the old branch" });
  const fresh = city.sendTicket({ to: "orchestrator", goal: "recent work" });
  await city.idle();
  city.ledger.db.prepare("UPDATE tickets SET json = json_set(json, '$.updated_at', '2026-01-01T00:00:00.000Z'), updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(old.id);
  city.close();

  const second = fake({});
  city = createCity({ runner: second.runner, dataDir: data, ledgerPath: path, policy });
  const events: CityEvent[] = [];
  city.on((e) => events.push(e));
  await city.resume();
  await city.idle();
  assert.equal(city.ledger.getTicket(old.id)?.status, "parked");
  assert.ok(second.calls.some((c) => c.prompt.includes(fresh.id)), "recent work went back to its agent");
  assert.ok(!second.calls.some((c) => c.prompt.includes("merge the old branch")), "the old instruction did not run");
  assert.deepEqual(events.filter((e) => e.type === "tickets.parked").map((e) => e.type === "tickets.parked" && e.ids), [[old.id]]);
  assert.equal(city.snapshot().parked.length, 1);
  assert.deepEqual(city.resumeParked([old.id]), { resumed: [old.id] });
  await city.idle();
  assert.match(second.calls.at(-1)!.prompt + second.calls.map((c) => c.prompt).join(" "), /parked while the city was down/);
  city.close();
});

test("costs: broken down by model, department, agent and ticket, labelled as estimates", async () => {
  const { runner } = fake({});
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  city.ledger.putAgent({ id: "dev-a", role: "r", kind: "worker", department: "IT", parent: "x", model: "claude-sonnet-5-5", tools: [], lifecycle: "temporary", state: "active", created_at: now(), last_active_at: now(), total_cost_usd: 0 });
  city.ledger.recordTurn("dev-a", "t-1", "s1", 0.5, {}, 100, { model: "claude-sonnet-5-5", durationMs: 1200 });
  city.ledger.recordTurn("dev-a", "t-1", "s1", 0.7, {}, 50, { model: "claude-sonnet-5-5", durationMs: 800 });
  city.ledger.recordTurn("dev-a", "t-2", "s2", 0.1, {}, 10, { model: "claude-haiku-5-5" });
  const r = city.ledger.costReport();
  assert.equal(r.estimated, true);
  assert.ok(Math.abs(r.today.usd - 0.8) < 1e-9, "per-turn deltas, not running totals");
  assert.equal(r.today.turns, 3);
  assert.ok(Math.abs(r.by_model["claude-sonnet-5-5"].usd - 0.7) < 1e-9);
  assert.equal(r.by_department.IT.turns, 3);
  assert.ok(Math.abs(r.by_agent["dev-a"].usd - 0.8) < 1e-9);
  assert.deepEqual(r.by_ticket.map((t) => [t.ticket_id, t.usd]), [["t-1", 0.7], ["t-2", 0.1]]);
  assert.equal(r.usd_per_done_ticket, null);
  city.close();
});

test("worktrees: one per ticket on its own branch; removed only when nothing can be lost", async () => {
  const root = realpathSync(dir());
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  const wt = join(root, "wt");
  await assert.rejects(allocateWorkspace(wt, "t-1", repo, ["/nowhere"]), /outside the repos/);
  await assert.rejects(allocateWorkspace(wt, "t-1", root, [root]), /not the top of a git/);
  await assert.rejects(allocateWorkspace(wt, "t-1", repo, [root], "main"), /bad branch/);
  await assert.rejects(allocateWorkspace(wt, "../x", repo, [root]), /bad ticket/);
  const w = await allocateWorkspace(wt, "t-1", repo, [root]);
  assert.equal(w.branch, "city/t-1");
  assert.ok(existsSync(join(w.path, "a.txt")));
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main", "the owner's checkout stays where it was");
  assert.equal((await allocateWorkspace(wt, "t-1", repo, [root])).path, w.path, "asking twice gives the same one");
  writeFileSync(join(w.path, "b.txt"), "b\n");
  assert.deepEqual(await releaseWorkspace(w), { removed: false, reason: "uncommitted changes" });
  git(w.path, "add", "-A");
  execFileSync("git", ["-C", w.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work"]);
  assert.deepEqual(await releaseWorkspace(w), { removed: false, reason: "commits not pushed to a remote" });
  const clean = await allocateWorkspace(wt, "t-2", repo, [root]);
  assert.deepEqual(await releaseWorkspace(clean), { removed: true });
  assert.ok(!existsSync(clean.path));
});
