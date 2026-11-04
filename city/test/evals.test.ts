// jarvis eval with a fake runner: scoring, recording and comparing.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evalCli, formatRun, loadRuns, loadSuites, recordRun, runEvals, scoreTask, type EvalSuite, type EvalTask } from "../src/evals.ts";
import { loadPolicy } from "../src/policy.ts";
import { UsageLimit, type Runner, type TurnRequest } from "../src/sdk.ts";

const policy = loadPolicy();
const body = (req: TurnRequest) => JSON.parse(req.prompt.slice(req.prompt.indexOf('{"id"')));
const isTicket = (req: TurnRequest) => req.prompt.includes('{"id"') && !req.prompt.startsWith("[report") && !req.prompt.startsWith("[result");
// Does the work as told: writes what the goal names into the ticket's folder, then reports.
const worker = (status = "done", write: (dir: string) => void = (dir) => writeFileSync(join(dir, "out.txt"), "hello")): Runner => async (req) => {
  if (isTicket(req)) {
    const t = body(req);
    write(t.scope[0]);
    await req.tools.find((x) => x.name === "report")?.handler({ ticket_id: t.id, status, summary: "the answer is 42", artifacts: [] });
  }
  return { text: "", sessionId: `s-${req.agentId}`, costUsd: 0.25, tokens: 10 };
};
const suite = (task: Partial<EvalTask> = {}): EvalSuite => ({ department: "Ops", mission: "operate", tasks: [{ id: "t1", goal: "write {{workdir}}/out.txt", pass: [{ type: "file_matches", path: "out.txt", pattern: "hello" }], ...task }] });

test("the shipped evals are valid, every department has a task, and a file naming a path outside its folder is refused", () => {
  const suites = loadSuites();
  assert.deepEqual(suites.map((s) => s.department).sort(), ["Engineering", "Marketing", "Research", "Support"]);
  const dir = mkdtempSync(join(tmpdir(), "evals-"));
  writeFileSync(join(dir, "a.json"), JSON.stringify({ department: "D", mission: "m", tasks: [{ id: "x", goal: "g", pass: [{ type: "file_absent", path: "../secret" }] }] }));
  assert.throws(() => loadSuites(dir), /leaves its folder/);
  writeFileSync(join(dir, "a.json"), JSON.stringify({ department: "D", mission: "m", tasks: [{ id: "x", goal: "g", pass: [] }] }));
  assert.throws(() => loadSuites(dir), /pass condition/);
});

test("each kind of check passes and fails on what is really there, and a ticket not done never passes", () => {
  const work = mkdtempSync(join(tmpdir(), "work-"));
  writeFileSync(join(work, "f.txt"), "alpha\nbeta");
  const task = (pass: EvalTask["pass"]): EvalTask => ({ id: "x", goal: "g", pass });
  const fails = (pass: EvalTask["pass"], status = "done", summary = "") => scoreTask(task(pass), status, summary, work).length;
  assert.equal(fails([{ type: "file_matches", path: "f.txt", pattern: "^beta$" }]), 0);
  assert.equal(fails([{ type: "file_matches", path: "f.txt", pattern: "gamma" }]), 1);
  assert.equal(fails([{ type: "file_matches", path: "nope.txt", pattern: "x" }]), 1);
  assert.equal(fails([{ type: "file_absent", path: "f.txt" }]), 1);
  assert.equal(fails([{ type: "file_absent", path: "nope.txt" }]), 0);
  assert.equal(fails([{ type: "result_matches", pattern: "42" }], "done", "it is 42"), 0);
  assert.equal(fails([{ type: "result_matches", pattern: "42" }], "done", "no idea"), 1);
  assert.equal(fails([{ type: "command", argv: ["node", "-e", "process.exit(0)"] }]), 0);
  assert.equal(fails([{ type: "command", argv: ["node", "-e", "process.exit(1)"] }]), 1);
  assert.equal(fails([{ type: "command", argv: ["no-such-program-here"] }]), 1);
  assert.equal(fails([{ type: "file_matches", path: "f.txt", pattern: "alpha" }], "failed"), 1);
});

test("a run scores real work in a throwaway city, with its cost and time", async () => {
  const run = await runEvals({ runner: worker(), suites: [suite(), { ...suite({ id: "t2", pass: [{ type: "file_absent", path: "out.txt" }] }), department: "Other" }], policy, label: "abc" });
  assert.deepEqual([run.passed, run.total, run.score, run.label, run.limit], [1, 2, 0.5, "abc", false]);
  assert.deepEqual(run.tasks.map((t) => [t.id, t.passed]), [["t1", true], ["t2", false]]);
  assert.match(run.tasks[1].failures[0], /should not exist/);
  assert.ok(existsSync(join(run.tasks[1].kept!, "events.jsonl")), "a failed task keeps its evidence");
  assert.equal(run.tasks[0].kept, undefined);
  assert.ok(run.cost_usd > 0 && run.ms >= 0);
  assert.match(formatRun(run), /Score 1\/2 \(50%\)/);
});

test("a task's setup files reach the folder, and {{workdir}} in its goal is that folder", async () => {
  let seen = "";
  const run = await runEvals({ policy, suites: [suite({ setup: { "sub/in.txt": "given" }, pass: [{ type: "file_matches", path: "sub/in.txt", pattern: "given" }] })], runner: worker("done", (dir) => { seen = dir; }) });
  assert.equal(run.passed, 1);
  assert.ok(seen.endsWith("/work"));
});

test("a worker that asks the owner gets told there is none, and a run does not hang on it", async () => {
  let asked = false;
  const done = worker();
  const runner: Runner = async (req) => {
    if (isTicket(req) && !asked) {
      asked = true;
      await req.tools.find((x) => x.name === "ask_user")?.handler({ question: { ticket_id: body(req).id, blocking: true, questions: [{ text: "which?", default: "a" }] } });
      return { text: "", sessionId: `s-${req.agentId}`, costUsd: 0, tokens: 0 };
    }
    return done(req);
  };
  const run = await runEvals({ runner, suites: [suite({ timeout_minutes: 0.05 })], policy });
  assert.ok(asked);
  assert.equal(run.total, 1);
});

test("a usage limit stops the run, marks it, and leaves what is left unrun", async () => {
  const runner: Runner = async () => { throw new UsageLimit("You've hit your limit · resets 11pm (Europe/Stockholm)"); };
  const run = await runEvals({ runner, suites: [suite(), suite({ id: "t2" })], policy, sleep: () => new Promise(() => {}) });
  assert.equal(run.limit, true);
  assert.deepEqual(run.tasks.map((t) => t.status), [run.tasks[0].status, "not run"]);
  assert.equal(run.passed, 0);
});

test("a task that takes too long fails and the run goes on", async () => {
  const runner: Runner = (req) => (isTicket(req) ? new Promise((_, no) => req.signal?.addEventListener("abort", () => no(new Error("cancelled")))) : worker()(req));
  const run = await runEvals({ runner, suites: [suite({ timeout_minutes: 0.002 })], policy });
  assert.equal(run.passed, 0);
  assert.match(run.tasks[0].failures.join(), /timed out/);
});

test("runs are recorded privately, and a torn last line does not lose the rest", () => {
  const path = join(mkdtempSync(join(tmpdir(), "runs-")), "evals.jsonl");
  const run = { at: "2026-11-04T00:00:00Z", label: "a", passed: 1, total: 2, score: 0.5, cost_usd: 1, ms: 60_000, limit: false, tasks: [] };
  recordRun(run, path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  writeFileSync(path, `${readFileSync(path, "utf8")}{"at":`);
  assert.deepEqual(loadRuns(path), [run]);
  assert.match(formatRun({ ...run, passed: 2, score: 1 }, run), /better than the last run: 1\/2 \(50%\), \$1\.00, 1\.0m \(a\)/);
  assert.match(formatRun({ ...run, passed: 0, score: 0 }, run), /worse than/);
  assert.match(formatRun(run, run), /same as/);
});

test("the command: a full run is recorded and compared, a filtered one is not, an unknown flag is refused", async () => {
  const home = mkdtempSync(join(tmpdir(), "home-")), evals = mkdtempSync(join(tmpdir(), "evals-"));
  writeFileSync(join(evals, "ops.json"), JSON.stringify(suite()));
  const before = process.env.JARVIS_HOME, write = console.log;
  process.env.JARVIS_HOME = home;
  const out: string[] = [];
  console.log = (s: string) => { out.push(s); };
  try {
    assert.equal(await evalCli(["--evals", evals], worker()), 0);
    assert.equal(await evalCli(["--evals", evals], worker()), 0);
    assert.match(out[1], /same as the last run/);
    assert.equal(loadRuns().length, 2);
    assert.equal(await evalCli(["--evals", evals, "--department", "ops"], worker()), 0);
    assert.equal(loadRuns().length, 2, "a partial run says nothing about the whole set");
    const file = join(home, "out.json");
    assert.equal(await evalCli(["--evals", evals, "--out", file], worker("failed")), 1);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).passed, 0);
    assert.equal(loadRuns().length, 2, "a run for the merge gate stays out of the owner's history");
    assert.equal(await evalCli(["--nope"], worker()), 2);
    assert.equal(await evalCli(["--evals", evals, "--department", "nope"], worker()), 2);
  } finally {
    console.log = write;
    if (before === undefined) delete process.env.JARVIS_HOME; else process.env.JARVIS_HOME = before;
  }
});
