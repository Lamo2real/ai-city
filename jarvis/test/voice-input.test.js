// Wake phrase parsing, the merge gate and the two new endpoints.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { cleanTranscript, parseWake } from "../server/listen.js";
import { ciSummary, createMergeGate, isConfirmPhrase } from "../server/merge.js";
import { createServer } from "../server/server.js";
import { speechText } from "../server/voice.js";

test("wake phrase, including how Whisper mishears it", () => {
  for (const heard of ["Yo Jarvis, status.", "Yojavas, status.", "yo javis status", "Hej Jarvis, status.", "ok so yo jarvis, status"]) assert.deepEqual(parseWake(heard), { wake: true, command: heard.includes("status.") ? "status." : "status" }, heard);
  assert.deepEqual(parseWake("Yo Jarvis."), { wake: true, command: "" });
  for (const heard of ["Jarvis, status.", "Javis, status.", "Okay Jarvis, status."]) assert.deepEqual(parseWake(heard), { wake: true, command: "status." }, heard);
  assert.deepEqual(parseWake("Jarvis."), { wake: true, command: "" });
  for (const hello of ["Hi Jarvis.", "Hello, Jarvis!", "Good morning Jarvis.", "Hej Jarvis"]) assert.deepEqual(parseWake(hello), { wake: true, command: hello }, hello);
  assert.deepEqual(parseWake("Hi Jarvis, status."), { wake: true, command: "status." });
  for (const heard of ["I saw Jarvis in a film", "yo what's up", ""]) assert.equal(parseWake(heard).wake, false, heard);
  assert.equal(cleanTranscript(" [BLANK_AUDIO] (music) hello "), "hello");
});

test("only the exact phrase confirms", () => {
  for (const yes of ["I confirm", "i confirm.", " I CONFIRM! "]) assert.ok(isConfirmPhrase(yes), yes);
  for (const no of ["yes", "I confirm that it looks bad", "confirm", "I don't confirm", "Yo Jarvis, I confirm"]) assert.ok(!isConfirmPhrase(no), no);
});

test("CI summary", () => {
  assert.equal(ciSummary([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }]), "1 failed");
  assert.equal(ciSummary([{ status: "IN_PROGRESS" }]), "1 still running");
  assert.equal(ciSummary([]), "no checks");
});

const dir = mkdtempSync(join(tmpdir(), "jarvis-gate-"));
const calls = join(dir, "gh.log");
const originalPath = process.env.PATH;
let server, port, gate, clock = 1000;
const SID = "sess1";
function addRequest() {
  const file = gate.requestFile();
  writeFileSync(file, JSON.stringify({ repo: "BookingSystemAdvancedOrg/application", number: 7, title: "Release", url: "https://github.com/x", head: "abc123", ci: "2 passed", mergeable: "MERGEABLE" }));
  gate.collect(file, SID);
}
const post = (path, body, headers = {}) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json", ...headers } }, (res) => {
    let data = "";
    res.on("data", (d) => { data += d; });
    res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data || "{}") }));
  });
  req.on("error", reject);
  req.end(payload);
});
const ghCalls = () => { try { return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };

before(async () => {
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$@" >> "${calls}"\n[ -f "${dir}/fail" ] && exit 1\nexit 0\n`);
  chmodSync(join(dir, "gh"), 0o755);
  process.env.PATH = `${dir}:${originalPath}`;
  gate = createMergeGate({ dataDir: dir, now: () => clock });
  server = createServer({ booqyDir: dir, dataDir: dir, port: 0, gate, getState: async () => ({}), chat: async (m) => `model: ${m}`, speak: async () => ({ audio: "QQ==", audioType: "audio/mpeg" }), transcribe: async () => "Yo Jarvis, status." });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(() => { server.close(); process.env.PATH = originalPath; });

test("saying exactly I confirm merges the shown commit once, without the model", async () => {
  addRequest();
  const res = await post("/api/chat", { message: "I confirm.", sessionId: SID, voice: true });
  assert.match(res.body.reply, /merged to main/);
  assert.equal(res.body.audio, "QQ==");
  assert.equal(res.body.confirm, null);
  const merges = ghCalls().filter((c) => c.startsWith("pr merge"));
  assert.equal(merges.length, 1);
  assert.match(merges[0], /pr merge 7 -R BookingSystemAdvancedOrg\/application --squash --match-head-commit abc123/);
  const again = await post("/api/chat", { message: "I confirm", sessionId: SID });
  assert.equal(again.body.reply, "model: I confirm");
  assert.equal(ghCalls().filter((c) => c.startsWith("pr merge")).length, 1);
});

test("other words do not confirm and the request stays visible", async () => {
  addRequest();
  const res = await post("/api/chat", { message: "yes do it", sessionId: SID });
  assert.equal(res.body.reply, "model: yes do it");
  assert.equal(res.body.confirm.number, 7);
  const count = ghCalls().filter((c) => c.startsWith("pr merge")).length;
  const cancel = await post("/api/chat", { message: "Cancel.", sessionId: SID });
  assert.match(cancel.body.reply, /Nothing was merged/);
  assert.equal(ghCalls().filter((c) => c.startsWith("pr merge")).length, count);
});

test("the Merge button needs the right id, for that session", async () => {
  addRequest();
  const { id } = gate.describe(SID);
  assert.equal((await post("/api/confirm", { sessionId: SID, id: "wrong", action: "merge" })).status, 409);
  assert.equal((await post("/api/confirm", { sessionId: "other", id, action: "merge" })).status, 409);
  const count = ghCalls().filter((c) => c.startsWith("pr merge")).length;
  const ok = await post("/api/confirm", { sessionId: SID, id, action: "merge" });
  assert.match(ok.body.reply, /merged to main/);
  assert.equal(ghCalls().filter((c) => c.startsWith("pr merge")).length, count + 1);
});

const get = (path) => new Promise((resolve, reject) => {
  request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => { let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(d || "{}") })); }).on("error", reject).end();
});

test("GET /api/confirm/pending returns the waiting item without changing it; a bad sessionId is 400", async () => {
  assert.deepEqual((await get(`/api/confirm/pending?sessionId=${SID}`)).body, { confirm: null });
  addRequest();
  const before = ghCalls().length;
  const r = await get(`/api/confirm/pending?sessionId=${SID}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.confirm.number, 7);
  assert.equal(r.body.confirm.id, gate.describe(SID).id, "same id on every read");
  assert.deepEqual((await get("/api/confirm/pending?sessionId=other")).body, { confirm: null });
  assert.equal((await get("/api/confirm/pending?sessionId=bad%20id")).status, 400);
  assert.equal((await get("/api/confirm/pending")).status, 400);
  assert.equal(ghCalls().length, before, "reading merges nothing");
  assert.ok(gate.current(SID), "and does not spend the confirmation");
  gate.cancel(SID);
});

test("a confirmation expires after two minutes", async () => {
  addRequest();
  const { id } = gate.describe(SID);
  clock += 121_000;
  assert.equal((await post("/api/confirm", { sessionId: SID, id, action: "merge" })).status, 409);
  assert.equal(gate.current(SID), null);
});

test("a failed merge is reported as not merged and spends the confirmation", async () => {
  addRequest();
  writeFileSync(join(dir, "fail"), "");
  const res = await post("/api/chat", { message: "I confirm", sessionId: SID });
  assert.match(res.body.reply, /Nothing was merged/);
  assert.equal(res.body.confirm, null);
});

test("a cross-site page cannot confirm or send audio", async () => {
  addRequest();
  const { id } = gate.describe(SID);
  const evil = { Origin: "https://evil.example" };
  assert.equal((await post("/api/confirm", { sessionId: SID, id, action: "merge" }, evil)).status, 403);
  assert.equal((await post("/api/listen", { audio: "x" }, evil)).status, 403);
  gate.cancel(SID);
});

test("listen rejects non-WAV and returns the wake result", async () => {
  assert.equal((await post("/api/listen", { audio: "aGVsbG8=" })).status, 400);
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(64)]);
  const res = await post("/api/listen", { audio: wav.toString("base64") });
  assert.deepEqual(res.body, { text: "Yo Jarvis, status.", wake: true, command: "status." });
});

test("speech leaves out IDs, hashes, paths and code", () => {
  assert.equal(speechText("See application#67 and PR 12 at abc1234 in docs/build/STATUS.md, run `gh pr list` now"), "See application pull request and PR at in , run now");
  assert.equal(speechText("Two features on dev."), "Two features on dev.");
});

test("the first clause goes early, after that only whole sentences", async () => {
  const { sentenceSplitter } = await import("../server/progress.js");
  const out = [];
  const split = sentenceSplitter((s) => out.push(s));
  split.push("Oh, right, the lighthouse");
  assert.deepEqual(out, [], "a clause too short to say alone waits");
  split.push(" stood — on a rock, by the sea. It was old, and tall.");
  assert.deepEqual(out, ["Oh, right, the lighthouse stood —", "on a rock, by the sea."]);
  split.flush();
  assert.deepEqual(out.at(-1), "It was old, and tall.");
  const figures = [];
  const numbers = sentenceSplitter((s) => figures.push(s));
  numbers.push("Roughly 1,000,000 people live there");
  numbers.flush();
  assert.deepEqual(figures, ["Roughly 1,000,000 people live there"], "a comma inside a number is no clause");
});

test("a secret survives no way of cutting the stream: scrubSecrets always sees it whole", async () => {
  const { sentenceSplitter } = await import("../server/progress.js");
  const { scrubSecrets } = await import("../server/chat.js");
  const token = `ghp_${"a1".repeat(20)}`;
  const envSecret = "s3cr3t,value:with.punctuation";
  const env = { ...process.env, ORCHESTRATOR_TOKEN: envSecret };
  for (const reply of [`Here, sir, it is ${token}, as asked. ${envSecret} too.`, `${token} is it, sir.`, `Your key, sir: ${token}`, `Your long winded token is: ${token}. Done.`, `${envSecret}, sir, and more.`]) {
    for (let size = 1; size <= 9; size++) {
      const out = [];
      const split = sentenceSplitter((s) => out.push(scrubSecrets(s, env)));
      for (let i = 0; i < reply.length; i += size) split.push(reply.slice(i, i + size));
      split.flush();
      assert.equal(out.join(" ").includes("ghp_"), false, `token leaked at size ${size}: ${out}`);
      assert.equal(out.join(" ").includes("s3cr3t"), false, `env secret leaked at size ${size}: ${out}`);
    }
  }
});

test("sentences split on real ends only, and progress lines match the tool", async () => {
  const { FILLERS, fillerLanguage, sentenceSplitter, toolFiller } = await import("../server/progress.js");
  const out = [];
  const split = sentenceSplitter((s) => out.push(s));
  split.push("Version 1.2 is live, sir. Hm. The next");
  split.push(" one is on dev");
  split.flush();
  assert.deepEqual(out, ["Version 1.2 is live,", "sir. Hm. The next one is on dev"]);
  const set = FILLERS.en;
  assert.equal(toolFiller("Bash", { command: "gh pr list -R x" }, set), set.github);
  assert.equal(toolFiller("Bash", { command: "gh pr merge 3 -R x" }, set), set.update);
  assert.equal(toolFiller("Bash", { command: "git -C infrastructure push origin dev" }, set), set.update);
  assert.equal(toolFiller("Bash", { command: "jq x | curl $ORCHESTRATOR_FIRE_URL" }, set), set.relay);
  assert.equal(toolFiller("Read", {}, set), set.files);
  assert.equal(toolFiller("Skill", {}, set), null);
  assert.equal(fillerLanguage("Hej, hur är läget?"), "sv");
  assert.equal(fillerLanguage("What is the status?"), "en");
});

test("the stream sends progress, then sentences as they come, then done", async () => {
  const chatServer = createServer({ booqyDir: dir, dataDir: dir, port: 0, gate: createMergeGate({ dataDir: dir }), getState: async () => ({}), speak: async (t) => ({ audio: Buffer.from(t).toString("base64"), audioType: "audio/mpeg" }), transcribe: async () => "",
    chat: async (m, sid, { onEvent }) => { onEvent({ type: "text", text: "All quiet, sir. " }); onEvent({ type: "text", text: "Nothing waits." }); onEvent({ type: "flush" }); return "All quiet, sir. Nothing waits."; } });
  await new Promise((r) => chatServer.listen(0, "127.0.0.1", r));
  const res = await fetch(`http://127.0.0.1:${chatServer.address().port}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "status", sessionId: "s", voice: true }) });
  const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  chatServer.closeAllConnections(); chatServer.close();
  assert.equal(events.filter((e) => e.type === "filler").length, 0, "a quick reply gets no canned line");
  assert.ok(events[0].audio);
  assert.deepEqual(events.filter((e) => e.type === "sentence").map((e) => e.text), ["All quiet, sir.", "Nothing waits."]);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).reply, "All quiet, sir. Nothing waits.");
});

test("closing the stream cancels the turn", async () => {
  let cancelled;
  const chatServer = createServer({ booqyDir: dir, dataDir: dir, port: 0, gate: createMergeGate({ dataDir: dir }), getState: async () => ({}), speak: async () => null, transcribe: async () => "",
    chat: (m, sid, { signal }) => new Promise((_, reject) => { signal.addEventListener("abort", () => { cancelled = true; reject(Object.assign(new Error("cancelled"), { cancelled: true })); }); }) });
  await new Promise((r) => chatServer.listen(0, "127.0.0.1", r));
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${chatServer.address().port}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "status", sessionId: "s", voice: false }), signal: ctrl.signal });
  assert.equal(res.status, 200);
  ctrl.abort();
  await new Promise((r) => setTimeout(r, 100));
  chatServer.closeAllConnections(); chatServer.close();
  assert.equal(cancelled, true);
});

test("a stream merge request is read out from GitHub's facts", async () => {
  const g = createMergeGate({ dataDir: dir });
  const chatServer = createServer({ booqyDir: dir, dataDir: dir, port: 0, gate: g, getState: async () => ({}), speak: async () => null, transcribe: async () => "",
    chat: async (m, sid) => { const f = g.requestFile(); writeFileSync(f, JSON.stringify({ repo: "BookingSystemAdvancedOrg/application", number: 7, title: "Release", url: "https://github.com/x", head: "abc", ci: "2 passed", mergeable: "MERGEABLE" })); g.collect(f, sid); return "merged, trust me"; } });
  await new Promise((r) => chatServer.listen(0, "127.0.0.1", r));
  const res = await fetch(`http://127.0.0.1:${chatServer.address().port}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "merge it", sessionId: "m", voice: false }) });
  const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  chatServer.closeAllConnections(); chatServer.close();
  assert.match(events.at(-1).reply, /say exactly: I confirm/);
  assert.equal(events.at(-1).confirm.number, 7);
});

test("only a real wait gets a spoken line", async () => {
  const chatServer = createServer({ booqyDir: dir, dataDir: dir, port: 0, gate: createMergeGate({ dataDir: dir }), getState: async () => ({}), speak: async () => null, transcribe: async () => "", firstWaitMs: 20,
    chat: async (m, sid, { onEvent }) => { await new Promise((r) => setTimeout(r, 80)); onEvent({ type: "text", text: "Done, sir." }); onEvent({ type: "flush" }); return "Done, sir."; } });
  await new Promise((r) => chatServer.listen(0, "127.0.0.1", r));
  const res = await fetch(`http://127.0.0.1:${chatServer.address().port}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "do it", sessionId: "w", voice: true }) });
  const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  chatServer.closeAllConnections(); chatServer.close();
  assert.deepEqual(events.map((e) => e.type), ["filler", "sentence", "done"]);
  assert.match(events[0].text, /moment/);
});
