// Black-box tests: the real server against fake claude, gh, git, say and ffmpeg on PATH.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { ALLOWED_TOOLS, DISALLOWED_TOOLS, SYSTEM_PROMPT, TOOLS, TURN_REMINDER, scrubSecrets } from "../server/chat.js";
import { createServer } from "../server/server.js";
import { ciStatus, createStateSource, parseFeatures, parsePipeline, prState } from "../server/state.js";
import { pickVoice, speechText, synthesize } from "../server/voice.js";

process.env.JARVIS_VOICE_SCRIPT = "off";
process.env.JARVIS_WARM_CLAUDE = "off";
const TOKEN = "secret-token-do-not-leak";
const FIRE_URL = "https://fire.example.test/secret-path";
const dir = mkdtempSync(join(tmpdir(), "jarvis-test-"));
const bin = join(dir, "bin");
const calls = join(dir, "calls.log");
const original = { PATH: process.env.PATH, TOKEN: process.env.ORCHESTRATOR_TOKEN, URL: process.env.ORCHESTRATOR_FIRE_URL };

const STATUS = `# Build status

Last updated: 2026-11-02 (test).

## Feature ledger

| Feature | Status | Branch | Attempts | Open issues | Unverified | Human actions needed |
|---|---|---|---|---|---|---|
| A. Meta ads | merged | | 0 | | | Meta Business Verification, App Review |
| B. Site builder | building | | 0 | | | |
| C. Guest CRM | todo | | 0 | | | Accountant: gift card VAT |
| G. Social posting | todo | | 0 | | | Depends on A's Meta connection |
`;
const PIPELINE = `# Pipeline

## Lock
unlocked (released 2026-11-02)

## Position
Step: Run 0 addendum (K events). Review round 2 done, fixes pushed.
Next run: re-review.

## Needs owner
- Approve in infrastructure#37 before the addendum merges: IAM rows.
`;
const PRS = JSON.stringify([
  { number: 37, title: "Draft thing", url: "https://github.com/o/r/pull/37", baseRefName: "dev", isDraft: true, reviewDecision: "", statusCheckRollup: [] },
  { number: 38, title: "Ready thing", url: "https://github.com/o/r/pull/38", baseRefName: "main", isDraft: false, reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] },
]);
const RUNS = JSON.stringify([{ status: "completed", conclusion: "success", workflowName: "CI" }]);

function fake(name, script) {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${script}\n`);
  chmodSync(path, 0o755);
}

let server;
let port;

function call({ method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}
const chat = (payload, headers = {}) => call({ method: "POST", path: "/api/chat", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(payload) });
const callLog = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");

before(async () => {
  writeFileSync(join(dir, "placeholder"), "");
  rmSync(bin, { recursive: true, force: true });
  (await import("node:fs")).mkdirSync(bin);
  writeFileSync(join(dir, "status.md"), STATUS);
  writeFileSync(join(dir, "pipeline.md"), PIPELINE);
  fake("git", `case "$*" in
  *fetch*) [ -f "${dir}/fetch-fails" ] && exit 1; exit 0 ;;
  *STATUS.md*) cat "${dir}/status.md" ;;
  *PIPELINE.md*) cat "${dir}/pipeline.md" ;;
  *) echo "fatal: path does not exist" >&2; exit 128 ;;
esac`);
  fake("gh", `[ -f "${dir}/gh-fails" ] && { echo "gh: network" >&2; exit 1; }
case "$*" in
  *STATUS.md*) cat "${dir}/status.md" ;;
  *PIPELINE.md*) cat "${dir}/pipeline.md" ;;
  *DECISIONS.md*) echo "HTTP 404: Not Found" >&2; exit 1 ;;
  "pr list -R BookingSystemAdvancedOrg/infrastructure"*) echo '${PRS}' ;;
  "pr list"*) echo '[]' ;;
  "run list"*) echo '${RUNS}' ;;
esac`);
  // Records its stdin and answers as Claude Code does with --output-format json.
  fake("claude", `cat > "${dir}/claude-stdin"
printenv JARVIS_BOOQY_DIR > "${dir}/claude-env"
printenv CLAUDE_CODE_DISABLE_AUTO_MEMORY > "${dir}/claude-memory"
pwd > "${dir}/claude-cwd"
[ -f "${dir}/claude-fails" ] && { echo "boom ${TOKEN}" >&2; exit 1; }
case "$*" in
  *--resume\\ gone*) echo '{"type":"result","is_error":true,"result":"No conversation found with session ID: gone"}'; exit 1 ;;
esac
cat "${dir}/claude-reply"`);
  fake("say", `while [ $# -gt 0 ]; do [ "$1" = "-o" ] && echo aiff > "$2"; shift; done`);
  fake("ffmpeg", `for last; do :; done; echo mp3-bytes > "$last"`);
  process.env.PATH = `${bin}:${original.PATH}`;
  process.env.ORCHESTRATOR_TOKEN = TOKEN;
  process.env.ORCHESTRATOR_FIRE_URL = FIRE_URL;
  server = createServer({ booqyDir: dir, dataDir: join(dir, "data"), port: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  process.env.PATH = original.PATH;
  if (original.TOKEN === undefined) delete process.env.ORCHESTRATOR_TOKEN; else process.env.ORCHESTRATOR_TOKEN = original.TOKEN;
  if (original.URL === undefined) delete process.env.ORCHESTRATOR_FIRE_URL; else process.env.ORCHESTRATOR_FIRE_URL = original.URL;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(calls, { force: true });
  for (const flag of ["claude-fails", "gh-fails", "fetch-fails"]) rmSync(join(dir, flag), { force: true });
  writeFileSync(join(dir, "claude-reply"), JSON.stringify({ type: "result", is_error: false, result: "All quiet, sir.", session_id: "11111111-1111-4111-8111-111111111111", permission_denials: [] }));
});

test("the port is bound to 127.0.0.1 only", () => {
  assert.equal(server.address().address, "127.0.0.1");
  const lan = Object.values(networkInterfaces()).flat().find((n) => n.family === "IPv4" && !n.internal);
  if (!lan) return;
  return new Promise((resolve, reject) => {
    request({ host: lan.address, port, path: "/", timeout: 1000 }, () => reject(new Error("reachable on the LAN address")))
      .on("error", () => resolve())
      .on("timeout", () => resolve())
      .end();
  });
});

test("GET / serves the HUD", async () => {
  const r = await call();
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /text\/html/);
  assert.match(r.text, /JARVIS/);
});

test("state.json has the DEMO object's shape, built from the sources", async () => {
  const hud = readFileSync(new URL("../hud/index.html", import.meta.url), "utf8");
  const demo = new Function(`return ${hud.match(/const DEMO = (\{[\s\S]*?\n\});/)[1]}`)();
  const fresh = createStateSource({ booqyDir: dir });
  const state = await fresh();
  assert.deepEqual(Object.keys(state).sort(), Object.keys(demo).sort());
  assert.deepEqual(Object.keys(state.pipeline).sort(), Object.keys(demo.pipeline).sort());
  assert.deepEqual(Object.keys(state.features[0]).sort(), Object.keys(demo.features[0]).sort());
  assert.deepEqual(Object.keys(state.prs[0]).sort(), Object.keys(demo.prs[0]).sort());
  assert.deepEqual(Object.keys(state.ci[0]).sort(), Object.keys(demo.ci[0]).sort());
  assert.equal(state.demo, false);
  assert.equal(state.ci.length, 6);
  assert.deepEqual(state.features[1], { id: "B", name: "Site builder", status: "building" });
  assert.equal(state.pipeline.lock, "free");
  assert.equal(state.pipeline.round, 2);
  assert.equal(state.ciPass, 100);
  assert.deepEqual(state.prs.map((p) => p.state), ["draft", "awaiting_approval"]);
  assert.ok(state.actions.includes("Approve in infrastructure#37 before the addendum merges"));
  assert.ok(state.actions.includes("Meta Business Verification, App Review"));
  assert.ok(state.actions.includes("Accountant: gift card VAT"));
  assert.ok(!state.actions.some((a) => /depends on/i.test(a)));
  assert.equal(state.uptime, null, "nothing local measures uptime, so it must not be invented");
  assert.equal(state.alarms, null, "nothing local measures alarms, so it must not be invented");
});

test("state is cached for 60 s", async () => {
  let clock = 1_000_000;
  const getState = createStateSource({ booqyDir: dir, now: () => clock });
  await getState();
  const ghCalls = () => callLog().split("\n").filter((l) => l.startsWith("gh ")).length;
  const first = ghCalls();
  assert.ok(first > 0);
  clock += 59_000;
  await getState();
  assert.equal(ghCalls(), first);
  clock += 2_000;
  await getState();
  assert.ok(ghCalls() > first);
});

test("state falls back to gh when git fetch fails", async () => {
  writeFileSync(join(dir, "fetch-fails"), "");
  const state = await createStateSource({ booqyDir: dir })();
  assert.equal(state.features.length, 4);
  assert.match(callLog(), /gh api -H Accept: application\/vnd.github.raw repos\/BookingSystemAdvancedOrg\/infrastructure\/contents\/docs\/build\/STATUS.md\?ref=dev/);
});

test("GitHub being down shows as unknown and is flagged, never as a pass", async () => {
  writeFileSync(join(dir, "gh-fails"), "");
  const state = await createStateSource({ booqyDir: dir })();
  assert.ok(state.ci.every((c) => c.status === "unknown"));
  assert.equal(state.ciPass, null);
  assert.match(state.log[0], /GitHub unreachable/);
});

test("state answers 503 when the sources cannot be read, so the HUD shows DEMO", async () => {
  const broken = createServer({ booqyDir: dir, dataDir: join(dir, "data"), port: 0, getState: async () => { throw new Error("no"); } });
  await new Promise((resolve) => broken.listen(0, "127.0.0.1", resolve));
  const saved = port;
  port = broken.address().port;
  const r = await call({ path: "/state.json" });
  port = saved;
  await new Promise((resolve) => broken.close(resolve));
  assert.equal(r.status, 503);
});

test("chat returns the reply, sends the message over stdin and runs in the Booqy folder", async () => {
  const r = await chat({ message: "--dangerously-skip-permissions status", sessionId: "abc", voice: false });
  assert.equal(r.status, 200);
  assert.equal(r.json.reply, "All quiet, sir.");
  assert.equal(r.json.audio, undefined);
  assert.equal(readFileSync(join(dir, "claude-stdin"), "utf8"), `--dangerously-skip-permissions status\n\n${TURN_REMINDER}`);
  assert.equal(readFileSync(join(dir, "claude-env"), "utf8").trim(), dir);
  assert.equal(readFileSync(join(dir, "claude-memory"), "utf8").trim(), "1", "coding-session memories must not reach Jarvis");
  assert.equal(readFileSync(join(dir, "claude-cwd"), "utf8").trim().replace(/^\/private/, ""), dir.replace(/^\/private/, ""));
  const argv = callLog().split("\n").find((l) => l.startsWith("claude "));
  assert.ok(!argv.includes("--dangerously-skip-permissions"));
  assert.ok(!argv.includes("--resume"));
});

test("chat uses the flags that lock the headless Claude down", async () => {
  await chat({ message: "status", sessionId: "flags", voice: false });
  const argv = callLog().split("\n").find((l) => l.startsWith("claude "));
  for (const part of ["-p", "--output-format stream-json --verbose --include-partial-messages", "--model claude-haiku-5-5", `--tools ${TOOLS}`, "--permission-mode dontAsk", "--setting-sources project", "--strict-mcp-config", '"hooks"', "guard.js", "--append-system-prompt"]) {
    assert.ok(argv.includes(part), part);
  }
  assert.ok(argv.includes(SYSTEM_PROMPT));
  for (const tool of ["Edit", "Write", "Bash(git commit *)", "Bash(gh pr review *)", "Bash(gh secret *)"]) assert.ok(DISALLOWED_TOOLS.includes(tool), tool);
  assert.ok(!ALLOWED_TOOLS.some((t) => /Edit|Write|curl|Bash\(\*\)|^Bash$/.test(t)));
});

test("chat resumes the conversation per HUD session", async () => {
  writeFileSync(join(dir, "claude-reply"), JSON.stringify({ result: "One.", session_id: "22222222-2222-4222-8222-222222222222" }));
  await chat({ message: "first", sessionId: "keep", voice: false });
  await chat({ message: "second", sessionId: "keep", voice: false });
  await chat({ message: "third", sessionId: "other", voice: false });
  const lines = callLog().split("\n").filter((l) => l.startsWith("claude "));
  assert.ok(!lines[0].includes("--resume"));
  assert.ok(lines[1].includes("--resume 22222222-2222-4222-8222-222222222222"));
  assert.ok(!lines[2].includes("--resume"));
});

test("a conversation Claude no longer has starts again instead of failing", async () => {
  writeFileSync(join(dir, "data-sessions-seed"), "");
  const dataDir = join(dir, "data2");
  (await import("node:fs")).mkdirSync(dataDir);
  writeFileSync(join(dataDir, "sessions.json"), JSON.stringify({ old: "gone" }));
  const s = createServer({ booqyDir: dir, dataDir, port: 0 });
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const saved = port;
  port = s.address().port;
  const r = await chat({ message: "hello", sessionId: "old", voice: false });
  port = saved;
  await new Promise((resolve) => s.close(resolve));
  assert.equal(r.status, 200);
  assert.equal(r.json.reply, "All quiet, sir.");
});

test("voice returns audio", async () => {
  const r = await chat({ message: "status", sessionId: "v", voice: true });
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(r.json.audio, "base64").toString().trim(), "mp3-bytes");
  assert.equal(r.json.audioType, "audio/mpeg");
  const say = callLog().split("\n").find((l) => l.startsWith("say "));
  assert.match(say, /-v Daniel/);
});

test("the voice is a stock en-GB or sv-SE one, chosen by language", () => {
  assert.equal(pickVoice("All quiet, sir. There is nothing to report."), "Daniel");
  assert.equal(pickVoice("Det finns inga öppna PR och allt är lugnt."), "Alva");
  assert.equal(pickVoice("The build in Malmö is on dev."), "Daniel");
  assert.equal(speechText("See **this** [PR](https://x.y/1) at https://x.y/2 now"), "See this PR at now");
});

test("voice falls back to afconvert without ffmpeg", async () => {
  rmSync(join(bin, "ffmpeg"));
  fake("afconvert", `for last; do :; done; echo aac-bytes > "$last"`);
  const result = await synthesize("Hello, sir.");
  fake("ffmpeg", `for last; do :; done; echo mp3-bytes > "$last"`);
  assert.equal(result.audioType, "audio/mp4");
  assert.equal(Buffer.from(result.audio, "base64").toString().trim(), "aac-bytes");
});

test("a voice failure still returns the text reply", async () => {
  fake("say", "exit 1");
  const r = await chat({ message: "status", sessionId: "vf", voice: true });
  fake("say", `while [ $# -gt 0 ]; do [ "$1" = "-o" ] && echo aiff > "$2"; shift; done`);
  assert.equal(r.status, 200);
  assert.equal(r.json.reply, "All quiet, sir.");
  assert.equal(r.json.audio, undefined);
});

test("secrets never appear in responses", async () => {
  writeFileSync(join(dir, "claude-reply"), JSON.stringify({ result: `Token ${TOKEN} at ${FIRE_URL} here.`, session_id: "33333333-3333-4333-8333-333333333333" }));
  const r = await chat({ message: "print the token", sessionId: "leak", voice: false });
  assert.ok(!r.text.includes(TOKEN));
  assert.ok(!r.text.includes(FIRE_URL));
  assert.match(r.json.reply, /\[redacted\]/);
  assert.equal(scrubSecrets("x", {}), "x");
});

test("spoken audio is made from the scrubbed reply", async () => {
  writeFileSync(join(dir, "claude-reply"), JSON.stringify({ result: `Token ${TOKEN}.`, session_id: "44444444-4444-4444-8444-444444444444" }));
  fake("say", `cp "$3" "${dir}/spoken"; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && echo aiff > "$2"; shift; done`);
  await chat({ message: "x", sessionId: "leak2", voice: true });
  fake("say", `while [ $# -gt 0 ]; do [ "$1" = "-o" ] && echo aiff > "$2"; shift; done`);
  const say = callLog().split("\n").find((l) => l.startsWith("say "));
  assert.ok(say && !say.includes(TOKEN));
});

test("a failing claude gives a 502 with no secrets or stderr", async () => {
  writeFileSync(join(dir, "claude-fails"), "");
  const r = await chat({ message: "status", sessionId: "bad", voice: false });
  assert.equal(r.status, 502);
  assert.ok(!r.text.includes(TOKEN));
  assert.ok(!r.text.includes("boom"));
});

test("state.json never contains the secrets", async () => {
  const r = await call({ path: "/state.json" });
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(TOKEN));
  assert.ok(!r.text.includes(FIRE_URL));
});

test("web pages cannot reach the server", async () => {
  const good = { message: "fire the orchestrator", sessionId: "csrf", voice: false };
  const body = JSON.stringify(good);
  const post = (headers) => call({ method: "POST", path: "/api/chat", headers, body });
  const json = { "Content-Type": "application/json" };
  assert.equal((await post({ ...json, Origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ ...json, Origin: "null" })).status, 403);
  assert.equal((await post({ ...json, "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await post({ "Content-Type": "text/plain" })).status, 403, "the no-preflight content type");
  assert.equal((await post({ ...json, Host: "evil.example" })).status, 403, "DNS rebinding");
  assert.equal((await call({ path: "/state.json", headers: { Host: "evil.example:7777" } })).status, 403);
  assert.equal(callLog().includes("claude "), false, "claude must not have run");
  assert.equal((await post({ ...json, Origin: `http://localhost:${port}`, "Sec-Fetch-Site": "same-origin" })).status, 200);
});

test("no CORS headers are ever sent", async () => {
  const r = await call({ path: "/state.json", headers: { Origin: "https://evil.example" } });
  assert.equal(r.headers["access-control-allow-origin"], undefined);
});

test("bad input is refused and only known files are served", async () => {
  assert.equal((await chat({ message: "", sessionId: "a" })).status, 400);
  assert.equal((await chat({ message: "x".repeat(20001), sessionId: "a" })).status, 400);
  assert.equal((await chat({ message: "x", sessionId: "../../etc" })).status, 400);
  assert.equal((await chat({ message: "x" })).status, 400);
  assert.equal((await call({ method: "POST", path: "/api/chat", headers: { "Content-Type": "application/json" }, body: "{nope" })).status, 400);
  assert.equal((await call({ path: "/../SPEC.md" })).status, 404);
  assert.equal((await call({ path: "/server/server.js" })).status, 404);
  assert.equal((await call({ method: "DELETE", path: "/", headers: { "Content-Type": "application/json" } })).status, 405);
});

test("ledger, pipeline, PR and CI parsing", () => {
  assert.deepEqual(parseFeatures("no ledger"), { features: [], humanActions: [] });
  assert.equal(parsePipeline("## Lock\nheld by run 4\n").pipeline.lock, "held");
  assert.equal(parsePipeline(null).pipeline.step, "idle");
  assert.equal(prState({ isDraft: false, reviewDecision: "APPROVED", statusCheckRollup: [] }), "approved");
  assert.equal(prState({ isDraft: false, statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }), "ci_failing");
  assert.equal(prState({ isDraft: false, statusCheckRollup: [{ status: "IN_PROGRESS" }] }), "ci_running");
  assert.equal(prState({ isDraft: false, statusCheckRollup: [{ __typename: "StatusContext", state: "PENDING" }] }), "ci_running");
  assert.equal(ciStatus([]), "none");
  assert.equal(ciStatus([{ workflowName: "a", status: "completed", conclusion: "failure" }, { workflowName: "a", status: "completed", conclusion: "success" }]), "fail");
  assert.equal(ciStatus([{ workflowName: "a", status: "completed", conclusion: "skipped" }, { workflowName: "a", status: "completed", conclusion: "success" }]), "pass");
  assert.equal(ciStatus([{ workflowName: "a", status: "in_progress", conclusion: "" }, { workflowName: "b", status: "completed", conclusion: "success" }]), "running");
  assert.equal(ciStatus([{ workflowName: "a", status: "completed", conclusion: "failure" }, { workflowName: "b", status: "queued", conclusion: "" }]), "fail");
});
