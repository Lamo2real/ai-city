import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  assert.deepEqual(ran, ["npm install --no-audit --no-fund --ignore-scripts @true", "npm run test --silent @true", "npm run typecheck --silent @true"]);
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
  const full: string[][] = [];
  await runChecks(dir, async (_c, a) => { full.push(a); return { ok: true, output: "" }; });
  assert.deepEqual(full[0], ["ci", "--no-audit", "--no-fund", "--ignore-scripts"]);
  const { realExec } = await import("../src/checks.ts");
  assert.ok(realExec.length === 3); // 10-minute timeout is set inside realExec
  assert.match(readFileSync(new URL("../src/checks.ts", import.meta.url), "utf8"), /timeout: 10 \* 60_000/);
  const bad = await runChecks(dir, async () => ({ ok: false, output: "boom" }));
  assert.deepEqual(bad.map((c) => c.name), ["install"]);
});

test("no checks defined fails the automated stage", async () => {
  const r = await runChecks(repo({ "package.json": "{}" }), async () => ({ ok: true, output: "" }));
  assert.deepEqual(r.map((c) => [c.name, c.passed]), [["checks", false]]);
  assert.match(r[0].output, /no checks defined/);
});

test("no PR: a named directory outside the workspace/review roots is refused; inside is accepted; non-work-tree refused", async () => {
  const { resolveCheckout } = await import("../src/checks.ts");
  const exists = (p: string) => p === "/etc/evil/.git" || p === "/w/ws/t-9/.git";
  const base = { scope: [], reviewRoot: "/w/rev", allowedRoots: ["/w/ws"], ticketId: "t-1", exists };
  const ok = (out: string): import("../src/checks.ts").Exec => async () => ({ ok: true, output: out });
  const bad = await resolveCheckout({ ...base, artifact: "done, see /etc/evil", exec: ok("true") });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /refusing/);
  const ins = await resolveCheckout({ ...base, artifact: "done, see /w/ws/t-9", exec: ok("true") });
  assert.deepEqual(ins, { ok: true, dir: "/w/ws/t-9" });
  const nt = await resolveCheckout({ ...base, artifact: "done, see /w/ws/t-9", exec: ok("false") });
  assert.equal(nt.ok, false);
});

test("resolveCheckout: PR + worktree verifies HEAD; PR alone gets a dedicated worktree; nothing resolvable fails; cwd never used", async () => {
  const { resolveCheckout, prRef } = await import("../src/checks.ts");
  const head = "a".repeat(40), other = "b".repeat(40);
  const live = new Set(["/w/pr-wt/.git", "/w/own/.git", "/w/rev/t-1-aaaaaaaaaaaa/.git"]);
  const exists = (p: string) => live.has(p);
  const mk = (sha: string): import("../src/checks.ts").Exec => async (cmd, args) => {
    if (cmd === "gh") return { ok: true, output: head };
    if (args.includes("--is-inside-work-tree")) return { ok: true, output: "true" };
    if (args[0] === "rev-parse") return { ok: true, output: sha };
    return { ok: true, output: "" };
  };
  assert.deepEqual(prRef("https://github.com/o/r/pull/47"), { repo: "o/r", num: "47" });
  const here = process.cwd();
  process.chdir(tmpdir()); // a stale caller cwd must change nothing
  try {
    const a = "PR #47 worktree /w/pr-wt";
    assert.deepEqual(await resolveCheckout({ scope: ["/w/stale"], artifact: a, reviewRoot: "/w/rev", ticketId: "t-1", exec: mk(head), exists }), { ok: true, dir: "/w/pr-wt", head });
    const bad = await resolveCheckout({ scope: [], artifact: a, reviewRoot: "/w/rev", ticketId: "t-1", exec: mk(other), exists });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.error, /not PR #47 head/);
    const r = await resolveCheckout({ scope: ["/w/own"], artifact: "https://github.com/o/r/pull/47", reviewRoot: "/w/rev", ticketId: "t-1", exec: mk(head), exists });
    assert.deepEqual(r, { ok: true, dir: "/w/rev/t-1-aaaaaaaaaaaa", head, temp: "/w/own" });
    const calls: string[][] = [];
    await (await import("../src/checks.ts")).dropCheckout(r, async (c, a, d) => { calls.push([c, ...a, d]); return { ok: true, output: "" }; });
    assert.deepEqual(calls, [["git", "worktree", "remove", "--force", "/w/rev/t-1-aaaaaaaaaaaa", "/w/own"]]);
    const none = await resolveCheckout({ scope: ["/w/stale"], artifact: "done", reviewRoot: "/w/rev", ticketId: "t-1", exec: mk(head), exists });
    assert.equal(none.ok, false);
    if (!none.ok) assert.match(none.error, /no checkout to test/);
    assert.equal((await resolveCheckout({ scope: [], artifact: "PR #47", reviewRoot: "/w/rev", ticketId: "t-1", exec: mk(head), exists })).ok, false);
  } finally { process.chdir(here); }
});

// Real git checkouts, all under tmp. The caller's cwd is (a) many commits behind main, (b) dirty with uncommitted edits.
// Neither may decide which checkout is tested, and the gate must never write to or run in them.
test("stale caller cwd (behind main, or dirty) never picks, runs in, or alters the tested checkout", async () => {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync, realpathSync } = await import("node:fs");
  const { resolveCheckout } = await import("../src/checks.ts");
  const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "stalecwd-")));
  const main = join(root, "main"); mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "package.json"), '{"scripts":{"test":"true"}}');
  git(main, "add", "-A"); git(main, "commit", "-qm", "base");
  const behind = join(root, "behind"), dirty = join(root, "dirty"), target = join(root, "target");
  git(root, "clone", "-q", main, behind); git(root, "clone", "-q", main, dirty);
  for (let i = 0; i < 5; i++) { writeFileSync(join(main, `f${i}`), String(i)); git(main, "add", "-A"); git(main, "commit", "-qm", `c${i}`); }
  git(root, "clone", "-q", main, target); // the checkout under review, current
  git(dirty, "pull", "-q"); writeFileSync(join(dirty, "package.json"), '{"scripts":{"test":"false"}}'); writeFileSync(join(dirty, "untracked.txt"), "wip");
  const snap = (d: string) => `${git(d, "rev-parse", "HEAD")}|${git(d, "status", "--porcelain")}|${readFileSync(join(d, "package.json"), "utf8")}`;
  const before = { behind: snap(behind), dirty: snap(dirty) };
  assert.notEqual(git(behind, "rev-parse", "HEAD"), git(main, "rev-parse", "HEAD")); // really behind
  assert.notEqual(git(dirty, "status", "--porcelain"), ""); // really dirty
  const head = git(target, "rev-parse", "HEAD");
  const here = process.cwd();
  try {
    for (const caller of [behind, dirty]) {
      process.chdir(caller);
      const ran: string[] = [];
      const exec: import("../src/checks.ts").Exec = async (cmd, args, cwd) => { ran.push(cwd); return cmd === "gh" ? { ok: true, output: head } : { ok: true, output: git(cwd, ...(args[0] === "rev-parse" ? args : ["status", "-s"])) }; };
      // named worktree: tested as-is; scope pointing at the caller is ignored in favour of the artifact
      const a = await resolveCheckout({ scope: [caller], artifact: `PR #47 worktree ${target}`, reviewRoot: join(root, "rev"), ticketId: "t-1", exec });
      assert.deepEqual(a, { ok: true, dir: target, head });
      // no PR, no path: falls to scope only; never to process.cwd()
      const n = await resolveCheckout({ scope: [], artifact: "done", reviewRoot: join(root, "rev"), ticketId: "t-1", exec });
      assert.equal(n.ok, false);
      // checks run in the resolved dir only
      const cwds: string[] = [];
      await runChecks(target, async (_c, _a, cwd) => { cwds.push(cwd); return { ok: true, output: "" }; });
      assert.ok(cwds.length > 0 && cwds.every((c) => c === target));
      assert.ok(![...ran, ...cwds].some((c) => c === caller || c === realpathSync(process.cwd())), "ran in the caller's folder");
    }
  } finally { process.chdir(here); }
  assert.deepEqual({ behind: snap(behind), dirty: snap(dirty) }, before); // callers untouched
});
