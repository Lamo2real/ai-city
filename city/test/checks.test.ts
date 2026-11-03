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
  assert.deepEqual(ran, ["npm run test --silent @true", "npm run typecheck --silent @true"]);
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
