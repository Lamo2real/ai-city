// Jarvis's direct line to anyone, what each agent is doing right now, and workers waiting for a merge.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPolicy } from "../src/policy.ts";
import { createCity, type CityEvent } from "../src/runtime.ts";
import { createRunner, outsideServers, type Runner, type TurnRequest } from "../src/sdk.ts";
import { allocateWorkspace, branchState } from "../src/workspaces.ts";

const dir = () => mkdtempSync(join(tmpdir(), "city-"));
const basePolicy = () => ({ ...loadPolicy(), audit_log: join(dir(), "audit.jsonl") });
const quiet: Runner = async (req) => ({ text: "", sessionId: `s-${req.agentId}`, costUsd: 0, tokens: 0 });
const tool = (city: ReturnType<typeof createCity>, agent: string, name: string) => city.toolsFor(agent).find((t) => t.name === name)!.handler;
const hireWorker = (city: ReturnType<typeof createCity>, manager: string, id: string, extra: Record<string, unknown> = {}) =>
  tool(city, manager, "hire_agent")({ spec: { id, role: "iOS Developer", kind: "worker", parent: manager, mission: "m", tools: ["Read"], lifecycle: "temporary", budget_usd_per_day: 1, ...extra } });

test("status comes straight from the ledger: no model call, not through the Orchestrator", async () => {
  const calls: TurnRequest[] = [];
  const runner: Runner = async (req) => { calls.push(req); return { text: "", sessionId: `s-${req.agentId}`, costUsd: 0, tokens: 0 }; };
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy: basePolicy() });
  const { manager } = city.createDepartment({ name: "IT", mission: "keep the systems running" });
  await hireWorker(city, manager, "ios-dev");
  city.ledger.putTicket({ id: "t-1", status: "in_progress", created_at: new Date().toISOString(), kind: "task", from: manager, to: "ios-dev", goal: "build the login" } as never);
  const before = calls.length;
  const all = await tool(city, "jarvis", "city_status")({}) as { departments: Array<{ name: string }>; at_work: Array<{ id: string; goal: string }> };
  assert.ok(all.departments.some((d) => d.name === "IT"));
  assert.deepEqual(all.at_work.map((a) => [a.id, a.goal]), [["ios-dev", "build the login"]]);
  const one = await tool(city, "jarvis", "agent_status")({ agent: "ios-dev" }) as { current: Array<{ goal: string }>; role: string };
  assert.equal(one.current[0].goal, "build the login");
  assert.equal(calls.length, before, "no model turn at all");
  city.close();
});

test("an agent can be named as the owner would say it; a wrong or vague name lists who exists", async () => {
  const city = createCity({ runner: quiet, dataDir: dir(), ledgerPath: ":memory:", policy: basePolicy() });
  const { manager } = city.createDepartment({ name: "IT", mission: "keep the systems running" });
  await hireWorker(city, manager, "ios-dev");
  assert.equal(city.findAgent("ios-dev").id, "ios-dev");
  assert.equal(city.findAgent("the IT manager").id, manager);
  assert.equal(city.findAgent("IT department").id, manager);
  assert.equal(city.findAgent("iOS developer").id, "ios-dev");
  assert.throws(() => city.findAgent("the plumber"), /No agent matches[\s\S]*ios-dev/);
  city.close();
});

test("only Jarvis has the direct line", async () => {
  const city = createCity({ runner: quiet, dataDir: dir(), ledgerPath: ":memory:", policy: basePolicy() });
  await assert.rejects(tool(city, "orchestrator", "city_status")({}), /only Jarvis/);
  await assert.rejects(tool(city, "secretary", "ask_agent")({ agent: "orchestrator", question: "q" }), /only Jarvis/);
  city.close();
});

test("ask_agent reaches a busy manager at once, in a forked session with no tools, on no ticket of its own", async () => {
  let finish!: () => void;
  const stuck = new Promise<void>((r) => { finish = r; });
  const asked: TurnRequest[] = [];
  const runner: Runner = async (req) => {
    if (req.forkSession) { asked.push(req); return { text: " Nearly done. ", sessionId: "fork", costUsd: 99, tokens: 10, usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }; }
    if (req.prompt.includes('"goal":"long job"')) { await stuck; }
    return { text: "", sessionId: `s-${req.agentId}`, costUsd: 0, tokens: 0 };
  };
  const policy = basePolicy();
  policy.caps = { ...policy.caps, max_concurrent_turns: 1 };
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy });
  const { manager } = city.createDepartment({ name: "IT", mission: "keep the systems running" });
  city.ledger.updateAgent(manager, { session_id: "s-real" });
  const t = city.sendTicket({ to: manager, goal: "long job" });
  await new Promise((r) => setTimeout(r, 20));
  const before = city.ledger.getTicket(t.id)!.status;
  const r = await Promise.race([city.askAgent("IT manager", "how is it going?"), new Promise<never>((_, no) => setTimeout(() => no(new Error("stuck behind its turn")), 1000))]) as { answered_by: string; answer: string };
  assert.equal(r.answered_by, manager);
  assert.equal(r.answer, "Nearly done.");
  assert.equal(asked[0].resume, "s-real");
  assert.deepEqual([asked[0].allowedTools, asked[0].tools], [[], []]);
  assert.match(asked[0].prompt, /Do no work here[\s\S]*how is it going\?/);
  assert.equal(city.ledger.getTicket(t.id)!.status, before);
  assert.equal(city.ledger.getAgent(manager)!.session_id, "s-real", "the agent's own session is untouched");
  assert.ok((city.ledger.costReport().by_agent[manager]?.usd ?? 0) < 1, "the fork's running total is not counted as this turn's cost");
  finish();
  await city.idle();
  city.close();
});

test("ask_agent reaches a worker in its very first turn, in the folder that turn runs in", async () => {
  let finish!: () => void;
  const stuck = new Promise<void>((r) => { finish = r; });
  const asked: TurnRequest[] = [];
  const runner: Runner = async (req) => {
    if (req.forkSession) { asked.push(req); return { text: "Coding.", sessionId: "fork", costUsd: 0, tokens: 1 }; }
    if (req.agentId === "eng-1") { req.onSession?.("s-first"); await stuck; return { text: "", sessionId: "s-first", costUsd: 0, tokens: 0 }; }
    return { text: "", sessionId: `s-${req.agentId}`, costUsd: 0, tokens: 0 };
  };
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy: basePolicy() });
  const { manager } = city.createDepartment({ name: "IT", mission: "keep the systems running" });
  await hireWorker(city, manager, "eng-1");
  await tool(city, manager, "send_ticket")({ ticket: { to: "eng-1", goal: "code" } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(city.agent("eng-1").session_id ?? null, null, "no saved session until the turn ends");
  const r = await city.askAgent("eng-1", "what now?") as { answered_by: string };
  assert.equal(r.answered_by, "eng-1");
  assert.equal(asked[0].resume, "s-first");
  finish();
  await city.idle();
  city.close();
});

test("ask_agent falls back to the record, and says so, when the agent cannot be asked", async () => {
  const failing: Runner = async (req) => { if (req.forkSession) throw new Error("No conversation found"); return { text: "", sessionId: "s", costUsd: 0, tokens: 0 }; };
  const city = createCity({ runner: failing, openclawRunner: quiet, dataDir: dir(), ledgerPath: ":memory:", policy: basePolicy() });
  const { manager } = city.createDepartment({ name: "IT", mission: "keep the systems running" });
  await hireWorker(city, manager, "oc-1", { executor: "openclaw" });
  assert.equal((await city.askAgent("oc-1", "q") as { answered_by: string }).answered_by, "ledger");
  await hireWorker(city, manager, "new-one", { role: "Fresh" });
  assert.match((await city.askAgent("new-one", "q") as { note: string }).note, /no session yet/);
  city.ledger.updateAgent(manager, { session_id: "gone" });
  const r = await city.askAgent(manager, "q") as { answered_by: string; note: string; status: { id: string } };
  assert.equal(r.answered_by, "ledger");
  assert.match(r.note, /could not answer directly/);
  assert.equal(r.status.id, manager);
  city.close();
});

test("an outside MCP server reaches only the named agent, only when its tools are allowed, and only if installed", () => {
  const policy = { ...basePolicy(), mcp_servers: {
    pa: { command: process.execPath, args: ["~/pa.py"], agents: ["jarvis"] },
    gone: { command: "/no/such/python", args: [], agents: ["jarvis"] },
  } };
  const servers = outsideServers("jarvis", ["mcp__pa__reminders_list", "mcp__gone__x"], policy);
  assert.deepEqual(Object.keys(servers), ["pa"]);
  assert.ok(!JSON.stringify(servers).includes("~"), "the home folder is spelled out");
  assert.deepEqual(outsideServers("eng-1", ["mcp__pa__mail_read"], policy), {}, "a worker hired with the tool's name still gets no server");
  assert.deepEqual(outsideServers("jarvis", [], policy), {}, "a side question with no tools starts no server");
});

test("the real policy gives the personal-assistant server to Jarvis alone", () => {
  const servers = loadPolicy().mcp_servers ?? {};
  assert.deepEqual(servers["personal-assistant"]?.agents, ["jarvis"]);
});

test("the SDK runner passes the fork through", async () => {
  let options: Record<string, unknown> = {};
  const queryFn = (({ options: o }: { options: Record<string, unknown> }) => { options = o; return (async function* () { yield { type: "result", subtype: "success", result: "x", session_id: "s", total_cost_usd: 0, usage: {} }; })(); }) as never;
  const runner = createRunner({ policy: basePolicy(), env: {}, queryFn });
  await runner({ agentId: "a", systemPrompt: "p", model: "claude-haiku-5-5", effort: "low", allowedTools: [], tools: [], prompt: "q", resume: "s0", forkSession: true });
  assert.equal(options.forkSession, true);
  assert.equal(options.resume, "s0");
});

test("activity follows the turn: understanding, then each tool, then what it waits for; reviewing a report is shown as reviewing", async () => {
  const events: CityEvent[] = [];
  const runner: Runner = async (req) => {
    if (req.prompt.includes('"goal":"go"') && req.agentId === "wrk-a") {
      req.guard!("Read", { file_path: "/x/a.ts" });
      req.guard!("Bash", { command: "npm test" });
      const t = JSON.parse(req.prompt.slice(req.prompt.indexOf('{"')));
      await req.tools.find((x) => x.name === "report")!.handler({ ticket_id: t.id, status: "done", summary: "ok", artifacts: [] });
    }
    return { text: "", sessionId: `s-${req.agentId}`, costUsd: 0, tokens: 0 };
  };
  const city = createCity({ runner, dataDir: dir(), ledgerPath: ":memory:", policy: basePolicy() });
  city.on((e) => events.push(e));
  const { manager } = city.createDepartment({ name: "IT", mission: "keep the systems running" });
  await hireWorker(city, manager, "wrk-a");
  await tool(city, manager, "send_ticket")({ ticket: { to: "wrk-a", goal: "go" } });
  await city.idle();
  const of = (id: string) => events.filter((e) => e.type === "agent.activity" && e.id === id).map((e) => (e as { activity: string }).activity);
  const worker = of("wrk-a");
  assert.deepEqual(worker.slice(0, 4), ["understanding", "reading", "running", "in_review"]);
  assert.ok(of(manager).includes("reviewing"));
  const row = events.find((e) => e.type === "agent.activity" && e.activity === "running") as { detail: string };
  assert.equal(row.detail, "npm", "only the program: a command can carry a secret");
  assert.equal((city.snapshot() as { activities: Record<string, { activity: string }> }).activities["wrk-a"].activity, worker.at(-1));
  city.close();
});

function repo(): { path: string; commit: (file: string) => void; git: (...a: string[]) => string } {
  const path = dir();
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
  const git = (...a: string[]) => execFileSync("git", a, { cwd: path, env, encoding: "utf8" });
  git("init", "-q", "-b", "trunk");
  writeFileSync(join(path, "a.txt"), "a");
  git("add", "-A");
  git("commit", "-qm", "init");
  return { path, git, commit: (file) => { writeFileSync(join(path, file), "x"); git("add", "-A"); git("commit", "-qm", file); } };
}

test("a branch's state: no commits, unmerged, merged, deleted", async () => {
  const r = repo();
  const w = await allocateWorkspace(join(dir(), "w"), "t-1", r.path, [tmpdir(), "/private/tmp", "/var/folders", "/private/var/folders"], "feat/x");
  assert.equal(await branchState(w), "nothing");
  writeFileSync(join(w.path, "b.txt"), "b");
  execFileSync("git", ["-C", w.path, "add", "-A"]);
  execFileSync("git", ["-C", w.path, "commit", "-qm", "b"], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });
  assert.equal(await branchState(w), "unmerged");
  r.git("merge", "-q", "--no-ff", "-m", "merge", "feat/x");
  assert.equal(await branchState(w), "merged");
});

test("a worker does not wait on a branch from another of its manager's tickets", async () => {
  const r = repo();
  const city = createCity({ runner: quiet, dataDir: dir(), ledgerPath: ":memory:", policy: basePolicy() });
  const { manager } = city.createDepartment({ name: "IT", mission: "keep the systems running" });
  await hireWorker(city, manager, "eng-1");
  const w = await allocateWorkspace(join(dir(), "w"), "t-7", r.path, [tmpdir(), "/private/tmp", "/var/folders", "/private/var/folders"], "feat/other");
  const coding = await tool(city, "orchestrator", "send_ticket")({ ticket: { to: manager, goal: "code" } }) as { id: string };
  city.ledger.updateTicket(coding.id, { workspace: w });
  await tool(city, "orchestrator", "send_ticket")({ ticket: { to: manager, goal: "research, no code" } });
  const t = await tool(city, manager, "send_ticket")({ ticket: { to: "eng-1", goal: "look something up" } }) as { id: string };
  await tool(city, "eng-1", "report")({ ticket_id: t.id, status: "done", summary: "ok", artifacts: [] });
  await city.idle();
  assert.equal(city.agent("eng-1").awaiting_merge ?? null, null);
  city.close();
});

test("a checked-out branch is not a merged branch when the repo has a remote", async () => {
  const r = repo();
  const w = await allocateWorkspace(join(dir(), "w"), "t-6", r.path, [tmpdir(), "/private/tmp", "/var/folders", "/private/var/folders"], "feat/try");
  writeFileSync(join(w.path, "c.txt"), "c");
  execFileSync("git", ["-C", w.path, "add", "-A"]);
  execFileSync("git", ["-C", w.path, "commit", "-qm", "c"], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });
  r.git("update-ref", "refs/remotes/origin/HEAD", w.base);
  r.git("merge", "-q", "--ff-only", "feat/try");
  assert.equal(await branchState(w), "unmerged");
});

test("an agent's open tickets are never lost behind newer finished ones", async () => {
  const city = createCity({ runner: quiet, dataDir: dir(), ledgerPath: ":memory:", policy: basePolicy() });
  const { manager } = city.createDepartment({ name: "IT", mission: "keep the systems running" });
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
  const row = (id: string, status: string, i: number) => ({ id, from: "orchestrator", to: manager, kind: "task", goal: id, status, created_at: at(i), updated_at: at(i) }) as never;
  const open = { id: "t-open" };
  city.ledger.putTicket(row(open.id, "in_progress", 0));
  for (let i = 1; i < 7; i++) city.ledger.putTicket(row(`t-${i}`, "done", i));
  assert.ok(city.agentStatus(manager).current.some((t: { id: string }) => t.id === open.id));
  city.close();
});

test("live activity shows a command's program and a URL without its query", async () => {
  let seen: (tool: string, input: Record<string, unknown>) => unknown = () => {};
  const events: CityEvent[] = [];
  const runner = async (req: { guard?: typeof seen }) => { seen = req.guard!; await seen("Bash", { command: 'curl -H "Authorization: Bearer abc" https://x.test' }); await seen("Bash", { command: "TOKEN=abc npm test" }); await seen("WebFetch", { url: "https://x.test/a?token=abc" }); return { text: "ok", sessionId: "s", costUsd: 0 }; };
  const city = createCity({ runner: runner as never, dataDir: dir(), ledgerPath: ":memory:", policy: basePolicy() });
  city.on((e) => events.push(e));
  const { manager } = city.createDepartment({ name: "IT", mission: "keep the systems running" });
  await tool(city, "orchestrator", "send_ticket")({ ticket: { to: manager, goal: "go" } });
  await city.idle();
  const details = events.filter((e) => e.type === "agent.activity").map((e) => (e as { detail: string }).detail);
  assert.ok(details.includes("curl") && details.includes("a command") && details.includes("x.test/a"));
  assert.ok(!details.join(" ").includes("abc"));
  city.close();
});

test("a worker also waits when the workspace is on its manager's ticket and the model left parent_id out", async () => {
  const r = repo();
  const city = createCity({ runner: quiet, dataDir: dir(), ledgerPath: ":memory:", policy: basePolicy() });
  const { manager } = city.createDepartment({ name: "IT", mission: "keep the systems running" });
  await hireWorker(city, manager, "eng-1");
  const w = await allocateWorkspace(join(dir(), "w"), "t-8", r.path, [tmpdir(), "/private/tmp", "/var/folders", "/private/var/folders"], "feat/z");
  writeFileSync(join(w.path, "c.txt"), "c");
  execFileSync("git", ["-C", w.path, "add", "-A"]);
  execFileSync("git", ["-C", w.path, "commit", "-qm", "c"], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });
  const parent = await tool(city, "orchestrator", "send_ticket")({ ticket: { to: manager, goal: "lead" } }) as { id: string };
  city.ledger.updateTicket(parent.id, { workspace: w });
  const t = await tool(city, manager, "send_ticket")({ ticket: { to: "eng-1", goal: "code" } }) as { id: string };
  await tool(city, "eng-1", "report")({ ticket_id: t.id, status: "done", summary: "ok", artifacts: [] });
  await city.idle();
  await city.checkMerges();
  assert.equal(city.agent("eng-1").awaiting_merge?.branch, "feat/z");
  r.git("merge", "-q", "--no-ff", "-m", "merge", "feat/z");
  await city.checkMerges();
  assert.equal(city.agent("eng-1").awaiting_merge, null);
  city.close();
});

test("a worker with an unmerged branch stays at its station after release, then leaves when it lands", async () => {
  const r = repo();
  const events: CityEvent[] = [];
  const city = createCity({ runner: quiet, dataDir: dir(), ledgerPath: ":memory:", policy: basePolicy() });
  city.on((e) => events.push(e));
  const { manager } = city.createDepartment({ name: "IT", mission: "keep the systems running" });
  await hireWorker(city, manager, "eng-1");
  const w = await allocateWorkspace(join(dir(), "w"), "t-9", r.path, [tmpdir(), "/private/tmp", "/var/folders", "/private/var/folders"], "feat/y");
  writeFileSync(join(w.path, "c.txt"), "c");
  execFileSync("git", ["-C", w.path, "add", "-A"]);
  execFileSync("git", ["-C", w.path, "commit", "-qm", "c"], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });
  const t = await tool(city, manager, "send_ticket")({ ticket: { to: "eng-1", goal: "code" } }) as { id: string };
  city.ledger.updateTicket(t.id, { workspace: w });
  await tool(city, "eng-1", "report")({ ticket_id: t.id, status: "done", summary: "ok", artifacts: [] });
  await city.idle();
  await city.checkMerges();
  const a = city.agent("eng-1");
  assert.equal(a.worker_state, "released", "its session has ended");
  assert.equal(a.awaiting_merge?.branch, "feat/y", "and it stays until the work is merged");
  assert.ok(events.some((e) => e.type === "worker.merge_waiting"));
  assert.ok((await tool(city, "jarvis", "city_status")({}) as { waiting_for_merge: unknown[] }).waiting_for_merge.length === 1);
  r.git("merge", "-q", "--no-ff", "-m", "merge", "feat/y");
  await city.checkMerges();
  assert.equal(city.agent("eng-1").awaiting_merge, null);
  assert.ok(events.some((e) => e.type === "worker.merged"));
  city.close();
});
