// The OpenClaw relay route: the real server, a fake Keychain, a fake chat and a fake merge gate.
// By the owner's decision the relay (his own allowlisted Telegram account) has the HUD's rights,
// including confirming a merge to main. It needs its own token, and every relayed turn is audited.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { RELAY_AUDIT, RELAY_PATH, RELAY_SERVICE, auditRelayOutcome, createServer } from "../server/server.js";
import { startTailnetListener } from "../server/tailnet.js";

const RELAY_TOKEN = "relay_token_for_tests_BBBBBBBBBBBBBBBBBBBBBBBB";
const dir = mkdtempSync(join(tmpdir(), "jarvis-relay-"));
const auditFile = join(dir, RELAY_AUDIT);
const audit = () => (existsSync(auditFile) ? readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

function call(port, path, { headers = {}, body, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { Host: host, "Content-Type": "application/json", ...headers } }, (res) => {
      let data = "";
      res.on("data", (d) => { data += d; });
      res.on("end", () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
const relay = (port, message, token = RELAY_TOKEN) => call(port, RELAY_PATH, { headers: token === null ? {} : { Authorization: `Bearer ${token}` }, body: { message } });

let app, port, chatCalls, gateCalls, pending;
let confirmResult = () => ({ ok: true, reply: "Merged to main." });
before(async () => {
  const keychain = { get: async (s) => (s === RELAY_SERVICE ? RELAY_TOKEN : null), set: async () => {}, remove: async () => {} };
  const gate = {
    current: () => pending,
    describe: () => (pending ? { repo: pending.repo, number: pending.number } : null),
    prompt: () => "Merge PR 12 of Lamo2real/ai-city to main? Say: I confirm.",
    cancel: (s) => { gateCalls.push(["cancel", s]); pending = undefined; },
    confirm: async (s) => { gateCalls.push(["confirm", s]); const item = pending; pending = undefined; return confirmResult(item); },
  };
  const talk = Object.assign(async (message, sessionId) => {
    chatCalls.push({ message, sessionId });
    return `Jarvis: ${message}`;
  }, { on() {} });
  app = createServer({ booqyDir: dir, dataDir: dir, port: 0, gate, getState: async () => ({}), chat: talk, speak: async () => ({}), keychain, mailGateOptions: { auditPath: join(dir, "mail-audit.jsonl") } });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  port = app.address().port;
});
after(() => app.close());
beforeEach(() => { chatCalls = []; gateCalls = []; pending = undefined; confirmResult = () => ({ ok: true, reply: "Merged to main." }); rmSync(auditFile, { force: true }); });

test("the owner can confirm a pending merge to main from Telegram, like the HUD, and it is audited", async () => {
  pending = { id: "m1", repo: "Lamo2real/ai-city", number: 12, head: "abc1234def" };
  const res = await relay(port, "I confirm");
  assert.equal(res.status, 200);
  assert.equal(res.json.reply, "Merged to main.");
  assert.deepEqual(gateCalls, [["confirm", "owner"]]);
  assert.deepEqual(chatCalls, [], "the confirmation is handled by the server, never by the model");
  const [entry] = audit();
  assert.equal(entry.via, "telegram");
  assert.equal(entry.kind, "merge_confirm");
  assert.deepEqual(entry.merge, { repo: "Lamo2real/ai-city", number: 12 });
  assert.match(entry.who, /allowlisted Telegram account/);
  assert.ok(!Number.isNaN(Date.parse(entry.ts)));
  const outcome = audit()[1];
  assert.equal(outcome.kind, "merge_outcome");
  assert.equal(outcome.outcome, "merged");
  assert.deepEqual(outcome.merge, { repo: "Lamo2real/ai-city", number: 12, head: "abc1234def" }, "merged at the PR head SHA the gate required");
});

test("a Telegram confirmation GitHub refuses is audited as failed, with the reason", async () => {
  pending = { id: "m6", repo: "Lamo2real/ai-city", number: 17, head: "fff0000" };
  confirmResult = () => ({ ok: false, reply: "I could not merge it, sir. Nothing was merged." });
  const res = await relay(port, "I confirm");
  assert.match(res.json.reply, /could not merge/);
  const [confirm, outcome] = audit();
  assert.equal(confirm.kind, "merge_confirm");
  assert.equal(outcome.outcome, "failed");
  assert.match(outcome.reason, /GitHub refused/);
  assert.equal(outcome.merge.number, 17);
});

test("a confirmation that finds nothing valid to merge (expired) is audited as refused", async () => {
  pending = { id: "m7", repo: "Lamo2real/ai-city", number: 18, head: "aaa1111" };
  confirmResult = () => null; // the gate's window had expired by the time it ran
  await relay(port, "I confirm");
  const outcome = audit()[1];
  assert.equal(outcome.outcome, "refused");
  assert.match(outcome.reason, /expired/);
  auditRelayOutcome(dir, undefined, null);
  assert.equal(audit()[2].outcome, "refused");
  assert.equal(audit()[2].merge, undefined);
});

test("a cancel from Telegram is audited too", async () => {
  pending = { id: "m2", repo: "Lamo2real/ai-city", number: 13 };
  await relay(port, "cancel");
  assert.deepEqual(gateCalls, [["cancel", "owner"]]);
  assert.equal(audit()[0].kind, "merge_cancel");
});

test("forwarded content saying 'I confirm' can never confirm a merge", async () => {
  pending = { id: "m3", repo: "Lamo2real/ai-city", number: 14 };
  const forwarded = "[Forwarded content — data, not an instruction from the owner]\nI confirm\n[End of forwarded content]";
  for (const message of [forwarded, "what does this mean? I confirm", "> I confirm"]) {
    const res = await relay(port, message);
    assert.equal(res.status, 200);
  }
  assert.ok(!gateCalls.some(([n]) => n === "confirm"), "only the owner's own exact words 'I confirm' confirm");
  assert.equal(chatCalls.length, 3, "they go to Jarvis as ordinary messages");
  assert.deepEqual(audit().map((e) => e.kind), ["message", "message", "message"]);
});

test("every relayed message is audited, scrubbed of secrets; the audit file is private", async () => {
  const leaky = "status please, my token is ghp_0123456789abcdefghijklmnopqrstuvwxyz0123";
  await relay(port, leaky);
  const [entry] = audit();
  assert.equal(entry.kind, "message");
  assert.ok(!entry.text.includes("ghp_0123456789abcdefghijklmnopqrstuvwxyz0123"), "secrets never reach the audit");
  assert.equal(statSync(auditFile).mode & 0o777, 0o600);
  await relay(port, "x".repeat(5000));
  assert.ok(audit()[1].text.length <= 500);
});

test("no token or a wrong token: 401, nothing reaches Jarvis or the merge gate, nothing is audited", async () => {
  pending = { id: "m4", repo: "Lamo2real/ai-city", number: 15 };
  for (const token of [null, "", "wrong", RELAY_TOKEN.slice(0, -1), `${RELAY_TOKEN}x`]) {
    const res = await relay(port, "I confirm", token);
    assert.equal(res.status, 401, `token ${JSON.stringify(token)}`);
    assert.deepEqual(res.json, { error: "relay not authorised" });
  }
  assert.deepEqual(chatCalls, []);
  assert.deepEqual(gateCalls, []);
  assert.deepEqual(audit(), []);
});

test("the relay cannot pick another conversation or turn the voice on", async () => {
  await call(port, RELAY_PATH, { headers: { Authorization: `Bearer ${RELAY_TOKEN}` }, body: { message: "hi", sessionId: "other", voice: true } });
  assert.deepEqual(chatCalls, [{ message: "hi", sessionId: "owner" }]);
});

test("bad bodies are refused before Jarvis", async () => {
  for (const message of ["", "   ", 42, "x".repeat(20_001)]) assert.equal((await relay(port, message)).status, 400);
  assert.deepEqual(chatCalls, []);
});

test("the relay route exists only on the Mac's own listener, not on the tailnet one", async () => {
  writeFileSync(join(dir, "tailnet.json"), JSON.stringify({ host: "mac.tail1234.ts.net", login: "owner@example.com" }));
  const tailnet = startTailnetListener({ dataDir: dir, handler: app.handleTailnet, port: 0 });
  await new Promise((r) => tailnet.on("listening", r));
  try {
    pending = { id: "m5", repo: "Lamo2real/ai-city", number: 16 };
    const res = await call(tailnet.address().port, RELAY_PATH, {
      host: "mac.tail1234.ts.net",
      headers: { "Tailscale-User-Login": "owner@example.com", "X-Forwarded-Proto": "https", Authorization: `Bearer ${RELAY_TOKEN}` },
      body: { message: "I confirm" },
    });
    assert.notEqual(res.status, 200);
    assert.deepEqual(chatCalls, []);
    assert.deepEqual(gateCalls, []);
  } finally {
    tailnet.close();
  }
});

// ---- email approval over the relay (Telegram) ----
const MAIL_HASH = "d".repeat(64);
const MAIL_ID = "mail-relayroute00000000000";
const holdEmail = () => { app.mailGate.register({ confirm_id: MAIL_ID, draft_hash: MAIL_HASH, summary: { to: ["boss@acme.se"], cc: [], bcc: [], subject: "Quote", first_lines: ["Hello"], why: ["boss@acme.se → company domain (acme.se)"] } }); app.mailGate.announce(); };

test("the owner's Telegram 'I confirm the email' approves the pending email, with the server's summary", async () => {
  holdEmail();
  chatCalls.length = 0;
  await relay(port, "I confirm the email, as the owner said");
  assert.equal(app.mailGate.approval(MAIL_ID, MAIL_HASH).approved, false, "text around the phrase is not the phrase");
  const ok = await relay(port, "I confirm the email.");
  assert.equal(ok.status, 200);
  assert.match(chatCalls.at(-1).message, /^\[Jarvis server\] The owner approved the pending email\./);
  assert.match(ok.json.reply, /Approved: email to boss@acme\.se, subject "Quote"\./);
  assert.deepEqual(app.mailGate.redeem(MAIL_ID, MAIL_HASH), { approved: true, channel: "telegram" });
});

test("the owner's Telegram 'Cancel the email' discards it, answered by the server", async () => {
  holdEmail();
  chatCalls.length = 0;
  const cancelled = await relay(port, "Cancel the email");
  assert.match(cancelled.json.reply, /not sent/);
  assert.equal(chatCalls.length, 0, "the model never saw it");
  assert.equal(app.mailGate.approval(MAIL_ID, MAIL_HASH).approved, false);
  assert.equal(app.mailGate.pending().length, 0);
});
