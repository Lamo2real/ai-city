// jarvis eval: known tasks per department, each with a pass condition a machine can check. Every task
// runs a real department in a throwaway city, so a run never touches the owner's ledger or memory.
// shortcut: workers run on the SDK executor only, an openclaw hire is refused; add the runner if an eval needs a browser.
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoApiKey, sdkEnv } from "./auth.ts";
import { loadPolicy, type Policy } from "./policy.ts";
import { createCity } from "./runtime.ts";
import { createRunner, type Runner } from "./sdk.ts";

export const EVALS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "evals");
export type PassCheck =
  | { type: "file_matches"; path: string; pattern: string }
  | { type: "file_absent"; path: string }
  | { type: "result_matches"; pattern: string }
  | { type: "command"; argv: string[] };
export interface EvalTask { id: string; goal: string; setup?: Record<string, string>; acceptance_criteria?: string[]; complexity?: "simple" | "standard" | "complex"; timeout_minutes?: number; pass: PassCheck[] }
export interface EvalSuite { department: string; mission: string; tasks: EvalTask[] }
export interface TaskResult { id: string; department: string; passed: boolean; status: string; failures: string[]; cost_usd: number; ms: number }
export interface EvalRun { at: string; label: string; passed: number; total: number; score: number; cost_usd: number; ms: number; limit: boolean; tasks: TaskResult[] }

const NO_OWNER = "No owner is available during this eval. Decide for yourself and carry on; anything that needs approval is denied.";
const inside = (p: string) => !isAbsolute(p) && !normalize(p).startsWith("..");

export function loadSuites(dir = EVALS_DIR): EvalSuite[] {
  const suites = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalSuite);
  const ids = new Set<string>();
  for (const s of suites) {
    if (!s.department || !s.mission || !s.tasks?.length) throw new Error("an eval suite needs a department, a mission and tasks");
    for (const t of s.tasks) {
      if (!t.id || !t.goal || !t.pass?.length) throw new Error(`eval ${t.id ?? "(no id)"} needs an id, a goal and a pass condition`);
      if (ids.has(t.id)) throw new Error(`eval ${t.id} appears twice`);
      ids.add(t.id);
      for (const p of Object.keys(t.setup ?? {})) if (!inside(p)) throw new Error(`eval ${t.id}: setup path ${p} leaves its folder`);
      for (const c of t.pass) {
        if ("path" in c && !inside(c.path)) throw new Error(`eval ${t.id}: path ${c.path} leaves its folder`);
        if ("pattern" in c) new RegExp(c.pattern);
        if (!["file_matches", "file_absent", "result_matches", "command"].includes(c.type)) throw new Error(`eval ${t.id}: unknown check ${(c as { type: string }).type}`);
      }
    }
  }
  return suites;
}

// A check that cannot run has failed. A ticket that did not end as done has failed whatever its files say.
export function scoreTask(task: EvalTask, status: string, summary: string, work: string): string[] {
  const failures: string[] = status === "done" ? [] : [`the ticket ended as ${status}`];
  for (const c of task.pass) {
    if (c.type === "file_absent") { if (existsSync(join(work, c.path))) failures.push(`${c.path} should not exist`); continue; }
    if (c.type === "result_matches") { if (!new RegExp(c.pattern, "m").test(summary)) failures.push(`the result does not match /${c.pattern}/`); continue; }
    if (c.type === "file_matches") {
      let text: string | null = null;
      try { text = readFileSync(join(work, c.path), "utf8"); } catch { failures.push(`${c.path} is missing`); }
      if (text !== null && !new RegExp(c.pattern, "m").test(text)) failures.push(`${c.path} does not match /${c.pattern}/`);
      continue;
    }
    try { execFileSync(c.argv[0], c.argv.slice(1), { cwd: work, timeout: 30_000, stdio: "ignore" }); } catch { failures.push(`${c.argv.join(" ")} failed`); }
  }
  return failures;
}

export interface RunOptions { runner: Runner; suites?: EvalSuite[]; policy?: Policy; label?: string; agentsDir?: string; skillsDir?: string; log?: (line: string) => void; sleep?: (ms: number) => Promise<void> }

export async function runEvals(o: RunOptions): Promise<EvalRun> {
  const started = Date.now();
  const tasks: TaskResult[] = [];
  let limit = false;
  for (const suite of o.suites ?? loadSuites()) {
    for (const task of suite.tasks) {
      if (limit) { tasks.push({ id: task.id, department: suite.department, passed: false, status: "not run", failures: ["the usage limit stopped this run"], cost_usd: 0, ms: 0 }); continue; }
      const r = await runTask(suite, task, o);
      limit = r.limit;
      tasks.push(r.result);
    }
  }
  const passed = tasks.filter((t) => t.passed).length;
  return { at: new Date(started).toISOString(), label: o.label ?? "", passed, total: tasks.length, score: tasks.length ? passed / tasks.length : 0, cost_usd: tasks.reduce((s, t) => s + t.cost_usd, 0), ms: Date.now() - started, limit, tasks };
}

async function runTask(suite: EvalSuite, task: EvalTask, o: RunOptions): Promise<{ result: TaskResult; limit: boolean }> {
  const home = mkdtempSync(join(tmpdir(), "city-eval-"));
  const work = join(home, "work"); // also where a ticket with no scope runs, so a worker lands here whatever its manager passes on
  for (const [path, text] of Object.entries({ ".gitkeep": "", ...task.setup })) { mkdirSync(dirname(join(work, path)), { recursive: true }); writeFileSync(join(work, path), text); }
  const policy = { ...(o.policy ?? loadPolicy()), audit_log: join(home, "audit.jsonl") };
  const city = createCity({ runner: o.runner, policy, dataDir: home, ledgerPath: join(home, "ledger.db"), agentsDir: o.agentsDir, skillsDir: o.skillsDir, sleep: o.sleep, log: o.log });
  const started = Date.now();
  let stop = () => {};
  const stopped = new Promise<void>((resolve) => { stop = resolve; });
  let limit = false, timedOut = false, quiet = false;
  city.on((e) => {
    if (e.type === "question") queueMicrotask(() => { try { city.answer(e.id, NO_OWNER); } catch { /* it ended meanwhile */ } });
    if (e.type === "city.paused") { limit = true; stop(); }
  });
  const timer = setTimeout(() => { timedOut = true; stop(); }, (task.timeout_minutes ?? 10) * 60_000);
  let id = "";
  try {
    const { manager } = city.createDepartment({ name: suite.department, mission: suite.mission });
    id = city.sendTicket({ to: manager, goal: task.goal.replaceAll("{{workdir}}", work), scope: [work], acceptance_criteria: task.acceptance_criteria, complexity: task.complexity ?? "simple" }).id;
    const settled = (async () => { do { await city.idle(); if (city.openTickets().length) await new Promise((r) => setTimeout(r, 100)); } while (city.openTickets().length && !limit && !timedOut); quiet = true; })();
    await Promise.race([settled, stopped]);
    if (!quiet) { // a turn paused on the limit never settles, so give up on waiting for it
      city.cancelTicket(id);
      await Promise.race([settled, new Promise((r) => setTimeout(r, 5_000))]);
    }
  } finally {
    clearTimeout(timer);
  }
  const ticket = id ? city.ledger.getTicket(id) : undefined;
  const { usd } = city.ledger.db.prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM costs").get() as { usd: number };
  const failures = scoreTask(task, ticket?.status ?? "not sent", ticket?.result?.summary ?? "", work);
  if (timedOut) failures.push(`timed out after ${task.timeout_minutes ?? 10} minutes`);
  if (limit) failures.push("the usage limit stopped this task");
  const result: TaskResult = { id: task.id, department: suite.department, passed: !failures.length, status: ticket?.status ?? "not sent", failures, cost_usd: usd, ms: Date.now() - started };
  // A turn still paused on the limit would write to a closed ledger: this city is thrown away with its process.
  if (quiet) { city.close(); rmSync(home, { recursive: true, force: true }); }
  return { result, limit };
}

export const runsPath = () => join(process.env.JARVIS_HOME ?? join(homedir(), ".jarvis"), "evals.jsonl");
export function recordRun(run: EvalRun, path = runsPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(run)}\n`);
  chmodSync(path, 0o600);
}
export function loadRuns(path = runsPath()): EvalRun[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((l) => { try { return l ? [JSON.parse(l) as EvalRun] : []; } catch { return []; } }); // a torn last line
}

const money = (n: number) => `$${n.toFixed(2)}`;
const time = (ms: number) => `${(ms / 60_000).toFixed(1)}m`;
const pct = (r: EvalRun) => `${r.passed}/${r.total} (${Math.round(r.score * 100)}%)`;
export function formatRun(run: EvalRun, previous?: EvalRun): string {
  const lines = run.tasks.map((t) => `${t.passed ? "PASS" : "FAIL"}  ${t.department} / ${t.id}  ${money(t.cost_usd)}  ${time(t.ms)}${t.failures.length ? `\n      ${t.failures.join("; ")}` : ""}`);
  const verdict = !previous ? "" : run.score > previous.score ? ", better than" : run.score < previous.score ? ", worse than" : ", same as";
  lines.push(`Score ${pct(run)}, estimated ${money(run.cost_usd)} at API list prices (not a charge), ${time(run.ms)}${previous ? `${verdict} the last run: ${pct(previous)}, ${money(previous.cost_usd)}, ${time(previous.ms)} (${previous.label || previous.at})` : ""}.`);
  if (run.limit) lines.push("Stopped on a usage limit, so this score says nothing about the city.");
  return lines.join("\n");
}

const git = (...args: string[]) => new Promise<string>((resolve) => execFile("git", args, (err, out) => resolve(err ? "" : out.trim())));

// jarvis eval [--department D] [--task id] [--json] [--evals dir] [--out file]
// --out writes the run for whoever asked instead of adding it to the owner's history; the merge gate uses it.
export async function evalCli(argv: string[], runner?: Runner): Promise<number> {
  const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.some((a) => a.startsWith("--") && !["--department", "--task", "--json", "--evals", "--out"].includes(a))) { console.error("usage: jarvis eval [--department D] [--task id] [--json] [--evals dir] [--out file]"); return 2; }
  const [department, only, out] = [opt("--department"), opt("--task"), opt("--out")];
  const suites = loadSuites(opt("--evals") ?? EVALS_DIR)
    .filter((s) => !department || s.department.toLowerCase() === department.toLowerCase())
    .map((s) => ({ ...s, tasks: s.tasks.filter((t) => !only || t.id === only) })).filter((s) => s.tasks.length);
  if (!suites.length) { console.error("no eval matches that"); return 2; }
  let run = runner;
  if (!run) {
    assertNoApiKey();
    run = createRunner({ policy: loadPolicy(), env: await sdkEnv(process.env) });
  }
  const label = await git("-C", dirname(fileURLToPath(import.meta.url)), "rev-parse", "--short", "HEAD");
  const result = await runEvals({ runner: run, suites, label, log: process.env.JARVIS_VERBOSE === "1" ? (l) => console.error(`  · ${l}`) : undefined });
  if (out) writeFileSync(out, JSON.stringify(result));
  const previous = department || only ? undefined : loadRuns().filter((r) => !r.limit && r.total === result.total).at(-1); // only a like-for-like run compares
  // A partial or limit-stopped run says nothing about the whole set, so it stays out of the history.
  if (!out && !department && !only && !result.limit) recordRun(result);
  console.log(argv.includes("--json") ? JSON.stringify(result, null, 2) : formatRun(result, previous));
  return result.limit ? 3 : result.passed === result.total ? 0 : 1;
}

if (import.meta.main) process.exit(await evalCli(process.argv.slice(2)));
