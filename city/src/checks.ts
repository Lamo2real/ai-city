// Automated checks before the Reviewer Gate: whatever the repo under review
// already defines (npm test/lint/typecheck, pytest). They run in the ticket's
// scope directory; their results go to the reviewer and into the ticket.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface Check {
  name: string;
  passed: boolean;
  output: string;
}

export type Exec = (cmd: string, args: string[], cwd: string) => Promise<{ ok: boolean; output: string }>;

const TAIL = 2000;
export const realExec: Exec = (cmd, args, cwd) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: "1" } }, (err, stdout, stderr) => {
    resolve({ ok: !err, output: `${stdout}\n${stderr}`.trim().slice(-TAIL) });
  });
});

// Which checks this repo defines. Nothing defined → no checks, and the reviewer is told so.
export function detectChecks(cwd: string): Array<[string, string, string[]]> {
  const out: Array<[string, string, string[]]> = [];
  const pkg = join(cwd, "package.json");
  if (existsSync(pkg)) {
    let scripts: Record<string, string> = {};
    try { scripts = JSON.parse(readFileSync(pkg, "utf8")).scripts ?? {}; } catch { /* not ours to fix */ }
    for (const name of ["test", "lint", "typecheck"]) if (scripts[name]) out.push([name, "npm", ["run", name, "--silent"]]);
  }
  if (["pyproject.toml", "pytest.ini", "setup.cfg", "tests"].some((f) => existsSync(join(cwd, f)))) {
    out.push(["pytest", existsSync(join(cwd, "uv.lock")) ? "uv" : "python3", existsSync(join(cwd, "uv.lock")) ? ["run", "pytest", "-q"] : ["-m", "pytest", "-q"]]);
  }
  return out;
}

// The checkout under review. Order: an absolute directory named in the artifact text (the PR head's
// worktree), then the ticket's own scope. Never another ticket's scope: that is how a stale worktree got tested.
// Only real checkouts (with a .git) count. Never the caller's cwd.
export function reviewDir(scope: string[] | undefined, artifact: string, exists: (p: string) => boolean = existsSync): string | undefined {
  const named = namedDirs(artifact, exists);
  return named[0] ?? (scope ?? []).find((p) => isAbsolute(p) && exists(join(p, ".git")));
}

const namedDirs = (artifact: string, exists: (p: string) => boolean = existsSync) =>
  (artifact.match(/\/[\w.@~+-]+(?:\/[\w.@~+-]+)+/g) ?? []).map((p) => p.replace(/[.,;:)]+$/, "")).filter((p) => isAbsolute(p) && exists(join(p, ".git")));

// A PR named in the artifact: a github URL, or "PR #47" / "pull request 47" (repo then comes from the checkout).
export function prRef(artifact: string): { repo?: string; num: string } | undefined {
  const u = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(artifact);
  if (u) return { repo: u[1], num: u[2] };
  const n = /\b(?:PR|pull request)\s*#?(\d+)/i.exec(artifact);
  return n ? { num: n[1] } : undefined;
}

export type Checkout = { ok: true; dir: string; head?: string; temp?: string } | { ok: false; error: string };

// Resolve the checkout the gate must test, or say why it cannot. Never falls back to the caller's cwd.
//  - PR + worktree path: use the worktree, but HEAD must equal the PR head.
//  - PR only: fetch the PR head into a dedicated detached worktree under `reviewRoot`.
//  - worktree path only: use it.
//  - neither: the ticket's own scope checkout, else an error.
export async function resolveCheckout(o: { scope?: string[]; artifact: string; reviewRoot: string; ticketId: string; exec?: Exec; exists?: (p: string) => boolean }): Promise<Checkout> {
  const exec = o.exec ?? realExec, exists = o.exists ?? existsSync;
  const named = namedDirs(o.artifact, exists);
  const own = (o.scope ?? []).find((p) => isAbsolute(p) && exists(join(p, ".git")));
  const base = named[0] ?? own;
  const pr = prRef(o.artifact);
  if (!pr) return base ? { ok: true, dir: base } : { ok: false, error: "no checkout to test: the artifact names no PR or worktree path, and the ticket scope has no git checkout" };
  const slug = pr.repo ? ["-R", pr.repo] : [];
  const probe = base ?? tmpdir();
  if (!pr.repo && !base) return { ok: false, error: `no checkout to test: PR #${pr.num} named without a repo URL and no worktree to infer it from` };
  const v = await exec("gh", ["pr", "view", pr.num, ...slug, "--json", "headRefOid", "-q", ".headRefOid"], probe);
  const head = v.output.trim();
  if (!v.ok || !/^[0-9a-f]{40}$/.test(head)) return { ok: false, error: `no checkout to test: cannot read the head commit of PR #${pr.num}: ${v.output.slice(-300)}` };
  if (named[0]) {
    const h = await exec("git", ["rev-parse", "HEAD"], named[0]);
    if (!h.ok || h.output.trim() !== head) return { ok: false, error: `checkout ${named[0]} is at ${h.output.trim().slice(0, 12) || "unknown"}, not PR #${pr.num} head ${head.slice(0, 12)}; refusing to test the wrong commit` };
    return { ok: true, dir: named[0], head };
  }
  if (!base) return { ok: false, error: `no checkout to test: PR #${pr.num} has no local repository to fetch into` };
  const dir = join(o.reviewRoot, `${o.ticketId}-${head.slice(0, 12)}`);
  const fresh = !exists(join(dir, ".git"));
  if (fresh) {
    const f = await exec("git", ["fetch", "--quiet", "origin", `pull/${pr.num}/head`], base);
    if (!f.ok) return { ok: false, error: `no checkout to test: fetching PR #${pr.num} failed: ${f.output.slice(-300)}` };
    mkdirSync(o.reviewRoot, { recursive: true });
    const w = await exec("git", ["worktree", "add", "--detach", dir, head], base);
    if (!w.ok) return { ok: false, error: `no checkout to test: worktree for PR #${pr.num} failed: ${w.output.slice(-300)}` };
  }
  const h = await exec("git", ["rev-parse", "HEAD"], dir);
  if (!h.ok || h.output.trim() !== head) return { ok: false, error: `review worktree ${dir} is not at PR #${pr.num} head ${head.slice(0, 12)}` };
  return { ok: true, dir, head, temp: base };
}

// Remove a dedicated review worktree made by resolveCheckout.
export async function dropCheckout(co: Checkout, exec: Exec = realExec): Promise<void> {
  if (!co.ok || !co.temp) return;
  await exec("git", ["worktree", "remove", "--force", co.dir], co.temp);
}

// Dependencies first, so a missing node_modules is never mistaken for a failing test.
export async function installDeps(cwd: string, exec: Exec): Promise<Check | null> {
  if (!existsSync(join(cwd, "package.json"))) return null;
  const r = await exec("npm", [existsSync(join(cwd, "package-lock.json")) ? "ci" : "install", "--no-audit", "--no-fund"], cwd);
  return { name: "install", passed: r.ok, output: r.output };
}

export async function runChecks(cwd: string, exec: Exec = realExec): Promise<Check[]> {
  const checks: Check[] = [];
  if (detectChecks(cwd).some(([, c]) => c === "npm")) { const i = await installDeps(cwd, exec); if (i) { if (!i.passed) return [i]; } }
  for (const [name, cmd, args] of detectChecks(cwd)) {
    const r = await exec(cmd, args, cwd);
    checks.push({ name, passed: r.ok, output: r.output });
  }
  return checks;
}

export const checksText = (checks: Check[]) => checks.length
  ? checks.map((c) => `- ${c.name}: ${c.passed ? "PASS" : "FAIL"}${c.passed ? "" : `\n${c.output}`}`).join("\n")
  : "- none: the repo defines no test, lint, typecheck or pytest";
