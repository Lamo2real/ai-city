// Every token family is redacted in what the HUD receives: chat replies, the stream's sentence and done lines,
// the pending-merge GET, and (recursively) the city data. Identifiers and links stay intact.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { redactKnownTokens, redactTokens, scrubSecrets } from "../server/chat.js";
import { createMailGate, holdNotice } from "../server/mail-gate.js";
import { createMergeGate } from "../server/merge.js";
import { createServer, scrubDeep } from "../server/server.js";

// One token per pattern family the server knows.
const FAMILIES = {
  github: `ghp_${"aB3".repeat(12)}`,
  githubPat: `github_pat_${"A1_".repeat(10)}`,
  anthropic: `sk-ant-${"Zz9".repeat(8)}`,
  openai: `sk-${"Qq7".repeat(10)}`,
  slack: `xoxb-${"1234567890".repeat(2)}`,
  aws: "AKIAIOSFODNN7EXAMPLE",
  telegram: `123456789:${"AAH".repeat(12)}`,
  bearer: "Bearer abc.def-ghi_jkl",
};
const LONG = "k3J9xQ2mZp7LwR5tY8uN1vB4cD6fG0hS"; // 32 random-looking characters, no known prefix
const ALL = Object.values(FAMILIES).join(" and ");
const has = (text) => [...Object.values(FAMILIES), LONG].some((t) => text.includes(t) || text.includes(t.replace(/^Bearer /, "")));

const dir = mkdtempSync(join(tmpdir(), "jarvis-scrub2-"));
const gate = createMergeGate({ dataDir: dir });
const stub = async (message, sessionId, opts) => {
  const text = `Sir, the keys are ${ALL}. Done.`;
  opts?.onEvent?.({ type: "text", text });
  opts?.onEvent?.({ type: "flush" });
  return text;
};
const chat = Object.assign(stub, { on: () => {} });
let server, port;
before(async () => {
  server = createServer({ booqyDir: dir, dataDir: dir, port: 0, gate, getState: async () => ({}), chat, speak: async () => null, transcribe: async () => "" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(() => server.close());

const call = (path, body) => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path, method: body ? "POST" : "GET", headers: { Host: `localhost:${port}`, "Content-Type": "application/json" } }, (res) => { let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve({ status: res.statusCode, text: d })); });
  req.on("error", reject);
  req.end(body ? JSON.stringify(body) : undefined);
});

test("every family is redacted by redactTokens; scrubSecrets takes the specific families but not bare long strings", () => {
  for (const [name, token] of Object.entries(FAMILIES)) {
    assert.equal(redactTokens(`x ${token} y`).includes(token.replace(/^Bearer /, "")), false, name);
    assert.equal(scrubSecrets(`x ${token} y`, {}).includes(token.replace(/^Bearer /, "")), false, `scrubSecrets ${name}`);
    assert.equal(redactKnownTokens(`x ${token} y`).includes(token.replace(/^Bearer /, "")), false, `known ${name}`);
  }
  assert.equal(redactTokens(`id ${LONG}`), "id [redacted]");
  assert.equal(scrubSecrets(`a path /Users/me/projects/ai-city/jarvis/server/server.js and sha ${"a1b2c3d4".repeat(5)}`, {}), `a path /Users/me/projects/ai-city/jarvis/server/server.js and sha ${"a1b2c3d4".repeat(5)}`, "ordinary long paths and hashes survive in replies");
});

test("scrubDeep redacts free text with every pattern but keeps identifier and link fields whole", () => {
  const uuid = "3f2b8c1e-9d4a-4e7b-a1c2-5d6e7f8091a2";
  const out = scrubDeep({ id: uuid, repo: "BookingSystemAdvancedOrg/application", url: "https://github.com/BookingSystemAdvancedOrg/application/pull/7", created_at: "2026-11-04T09:47:55.848Z", goal: `use ${LONG} please`, list: [`x ${FAMILIES.telegram}`, { text: FAMILIES.bearer }], n: 4 });
  assert.equal(out.id, uuid);
  assert.equal(out.repo, "BookingSystemAdvancedOrg/application");
  assert.equal(out.url, "https://github.com/BookingSystemAdvancedOrg/application/pull/7");
  assert.equal(out.goal, "use [redacted] please");
  assert.equal(out.list[0], "x [redacted]");
  assert.equal(out.list[1].text, "[redacted]");
  assert.equal(out.n, 4);
  assert.equal(scrubDeep({ url: `https://x.test/?t=${FAMILIES.github}` }).url, "https://x.test/?t=[redacted]", "even a link loses a known token");
});

test("POST /api/chat: the reply has every token family redacted", async () => {
  const r = await call("/api/chat", { message: "keys?", sessionId: "s1" });
  assert.equal(r.status, 200);
  assert.equal(has(r.text), false, r.text);
  assert.match(JSON.parse(r.text).reply, /^Sir, the keys are \[redacted\] and/);
});

test("POST /api/chat/stream: sentence lines and the done reply have every token family redacted", async () => {
  const r = await call("/api/chat/stream", { message: "keys?", sessionId: "s2" });
  assert.equal(r.status, 200);
  assert.equal(has(r.text), false, r.text);
  const lines = r.text.trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.type === "sentence" && l.text.includes("[redacted]")), "a sentence arrived, scrubbed");
  const done = lines.find((l) => l.type === "done");
  assert.match(done.reply, /\[redacted\]/);
});

test("GET /api/confirm/pending is scrubbed, but the confirmation's id, repo and url arrive intact", async () => {
  const file = gate.requestFile();
  writeFileSync(file, JSON.stringify({ repo: "BookingSystemAdvancedOrg/application", number: 7, title: `Release ${ALL}`, url: "https://github.com/BookingSystemAdvancedOrg/application/pull/7", head: "abc123", ci: `2 passed ${FAMILIES.github}`, mergeable: "MERGEABLE" }));
  gate.collect(file, "pend");
  const real = gate.describe("pend");
  const r = await call("/api/confirm/pending?sessionId=pend");
  assert.equal(r.status, 200);
  assert.equal(has(r.text), false, r.text);
  const c = JSON.parse(r.text).confirm;
  assert.equal(c.id, real.id, "the UUID must survive, or MERGE could never match it");
  assert.equal(c.repo, "BookingSystemAdvancedOrg/application");
  assert.equal(c.url, "https://github.com/BookingSystemAdvancedOrg/application/pull/7");
  assert.match(c.title, /^Release \[redacted\] and/);
  assert.equal(c.ci, "2 passed [redacted]");
  assert.equal(c.number, 7);
  gate.cancel("pend");
});

// ---- the mail gate's hold and approve notices ----
const mailItem = (n) => ({ confirm_id: `confirm-${n}-abcdefgh`, draft_hash: String(n).repeat(64).slice(0, 64), summary: { to: [`Pat <pat@example.com>`], subject: `Invoice ${FAMILIES.github}`, first_lines: [`use ${FAMILIES.telegram} and ${FAMILIES.bearer} and ${FAMILIES.aws}`], why: [`it mentions ${FAMILIES.anthropic}`] } });
const newGate = () => createMailGate({ dataDir: mkdtempSync(join(tmpdir(), "jarvis-mailscrub-")), keychain: { get: async () => null }, auditPath: join(dir, "mail-audit.jsonl") });

test("the mail hold notice is scrubbed at the source, and still carries the exact confirmation words", () => {
  const gate = newGate();
  assert.ok(gate.register(mailItem(1)));
  const text = gate.announce();
  assert.equal(has(text), false, text);
  assert.match(text, /\[redacted\]/);
  assert.match(text, /Email to pat@example\.com, subject "Invoice \[redacted\]"/);
  assert.ok(text.endsWith("Say exactly: I confirm the email, or: Cancel the email."), "the phrase the owner must say is untouched");
  assert.equal(has(holdNotice({ summary: mailItem(2).summary })), false, "holdNotice itself");
});

test("the mail 'Approved' note and the different-email notice are scrubbed, and approval still works as before", () => {
  const gate = newGate();
  gate.register(mailItem(3));
  gate.announce();
  const approved = gate.intercept("I confirm the email", "hud");
  assert.match(approved.forward, /^\[Jarvis server\] The owner approved the pending email\./);
  assert.equal(has(approved.note), false, approved.note);
  assert.match(approved.note, /^Approved: email to pat@example\.com, subject "Invoice \[redacted\]"\.$/);
  // A newer draft the owner was not told about: the notice inside the refusal is scrubbed too, and nothing is approved.
  gate.register(mailItem(4));
  const refused = gate.intercept("I confirm the email", "hud");
  assert.equal(refused.forward, undefined);
  assert.match(refused.reply, /^That is a different email/);
  assert.equal(has(refused.reply), false, refused.reply);
});

// ---- the pending-merge confirmation that rides along with chat replies ----
test("POST /api/chat and /api/chat/stream: the attached merge confirm is scrubbed, its id/repo/url intact", async () => {
  for (const [path, sid] of [["/api/chat", "cf1"], ["/api/chat/stream", "cf2"]]) {
    const file = gate.requestFile();
    writeFileSync(file, JSON.stringify({ repo: "BookingSystemAdvancedOrg/application", number: 9, title: `Ship ${ALL}`, url: "https://github.com/BookingSystemAdvancedOrg/application/pull/9", head: "def456", ci: `ok ${LONG}`, mergeable: "MERGEABLE" }));
    gate.collect(file, sid);
    const real = gate.describe(sid);
    const r = await call(path, { message: "status?", sessionId: sid });
    assert.equal(r.status, 200);
    assert.equal(has(r.text), false, `${path}: ${r.text}`);
    const body = path === "/api/chat" ? JSON.parse(r.text) : r.text.trim().split("\n").map((l) => JSON.parse(l)).find((l) => l.type === "done");
    assert.equal(body.confirm.id, real.id, `${path}: the UUID must survive`);
    assert.equal(body.confirm.url, "https://github.com/BookingSystemAdvancedOrg/application/pull/9");
    assert.match(body.confirm.title, /^Ship \[redacted\] and/);
    assert.equal(body.confirm.ci, "ok [redacted]");
    gate.cancel(sid);
  }
});
