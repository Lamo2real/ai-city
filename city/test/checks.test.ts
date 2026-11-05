import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checksText, detectChecks, runChecks } from "../src/checks.ts";

const repo = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "checks-"));
  for (const [name, text] of Object.entries(files)) { mkdirSync(join(dir, name, ".."), { recursive: true }); writeFileSync(join(dir, name), text); }
  return dir;
};

test("checks are whatever the repo defines: npm scripts and pytest", () => {
  assert.deepEqual(detectChecks(repo({})), []);
  const node = repo({ "package.json": JSON.stringify({ scripts: { test: "x", lint: "y", build: "z" } }) });
  assert.deepEqual(detectChecks(node).map(([n]) => n), ["test", "lint"]);
  const py = repo({ "pyproject.toml": "", "uv.lock": "" });
  assert.deepEqual(detectChecks(py), [["pytest", "uv", ["run", "pytest", "-q"]]]);
  assert.deepEqual(detectChecks(repo({ "tests/test_a.py": "" })), [["pytest", "python3", ["-m", "pytest", "-q"]]]);
  assert.deepEqual(detectChecks(repo({ "package.json": "not json" })), []);
});

test("a failing check carries its output; the summary names each result", async () => {
  const dir = repo({ "package.json": JSON.stringify({ scripts: { test: "t", typecheck: "c" } }) });
  const ran: string[] = [];
  const checks = await runChecks(dir, async (cmd, args, cwd) => { ran.push(`${cmd} ${args.join(" ")} @${cwd === dir}`); return args[1] === "test" ? { ok: false, output: "1 failing" } : { ok: true, output: "" }; });
  assert.deepEqual(ran, ["npm install --no-audit --no-fund @true", "npm run test --silent @true", "npm run typecheck --silent @true"]);
  assert.deepEqual(checks, [{ name: "test", passed: false, output: "1 failing" }, { name: "typecheck", passed: true, output: "" }]);
  assert.equal(checksText(checks), "- test: FAIL\n1 failing\n- typecheck: PASS");
  assert.match(checksText([]), /none: the repo defines no/);
});

test("the real exec runs a command in the repo and reports failure without throwing", async () => {
  const { realExec } = await import("../src/checks.ts");
  const dir = repo({});
  assert.equal((await realExec("true", [], dir)).ok, true);
  const r = await realExec("sh", ["-c", "echo nope; exit 3"], dir);
  assert.equal(r.ok, false);
  assert.equal(r.output, "nope");
});

test("the gate tests the checkout under review, never a stale worktree", async () => {
  const { reviewDir } = await import("../src/checks.ts");
  const live = new Set(["/w/sonnet-clamp-wt/.git", "/w/spendcap-r1/.git", "/w/own/.git"]);
  const ex = (p: string) => live.has(p);
  assert.equal(reviewDir(["/w/spendcap-r1"], "PR #47 head 676127f, worktree /w/sonnet-clamp-wt.", ex), "/w/sonnet-clamp-wt");
  assert.equal(reviewDir(["/w/own"], "no path here", ex), "/w/own");
  assert.equal(reviewDir([], "no path here", ex), undefined);
});

test("npm ci runs before the checks; a failed install fails the gate without running tests", async () => {
  const dir = repo({ "package.json": JSON.stringify({ scripts: { test: "t" } }), "package-lock.json": "{}" });
  const ran: string[] = [];
  await runChecks(dir, async (c, a) => { ran.push(`${c} ${a[0]}`); return { ok: true, output: "" }; });
  assert.deepEqual(ran, ["npm ci", "npm run"]);
  const bad = await runChecks(dir, async () => ({ ok: false, output: "boom" }));
  assert.deepEqual(bad.map((c) => c.name), ["install"]);
});
