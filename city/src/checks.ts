// Automated checks before the Reviewer Gate: whatever the repo under review
// already defines (npm test/lint/typecheck, pytest). They run in the ticket's
// scope directory; their results go to the reviewer and into the ticket.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
export function reviewDir(scope: string[] | undefined, artifact: string, exists: (p: string) => boolean = existsSync): string | undefined {
  const named = (artifact.match(/\/[\w.@~+-]+(?:\/[\w.@~+-]+)+/g) ?? []).map((p) => p.replace(/[.,;:)]+$/, ""));
  const candidates = [...named, ...(scope ?? [])].filter((p) => isAbsolute(p) && exists(join(p, ".git")));
  return candidates.find((p) => named.includes(p)) ?? candidates[0] ?? scope?.find((s) => isAbsolute(s) && exists(s));
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
