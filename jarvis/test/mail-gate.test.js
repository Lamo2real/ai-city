// Business-send approval: the CLI asks, only the owner's own words (matched by the server) approve.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { run } from "../bin/jarvis-mail";
import { audit as writeAudit } from "../mail/audit.js";
import { createGateClient } from "../mail/gate.js";
import { createGmailClient } from "../mail/gmail.js";
import { classify, createContacts, draftHash } from "../mail/policy.js";
import { redact } from "../mail/redact.js";
import { createMailGate, isEmailCancel, isEmailConfirm } from "../server/mail-gate.js";
import { createServer } from "../server/server.js";

const TOKEN = "gate-token-for-tests-0123456789abcdef";
const dir = mkdtempSync(join(tmpdir(), "jarvis-mailgate-"));
const auditPath = join(dir, "audit.jsonl");
const res = (status, body) => ({ ok: status < 400, status, headers: { get: () => undefined }, text: async () => (body === undefined ? "" : JSON.stringify(body)), json: async () => body ?? {} });
const fakeKeychain = (data) => ({ get: async (s) => data[s] ?? null, set: async (s, v) => { data[s] = v; }, remove: async (s) => { delete data[s]; } });

// ---- the server, for real, on a free localhost port ----
let app, port, chatLog, keychain;
before(async () => {
  chatLog = [];
  keychain = fakeKeychain({ "jarvis.mail-gate": TOKEN });
  app = createServer({ booqyDir: dir, dataDir: dir, port: 0, getState: async () => ({}), chat: async (m, sessionId) => { chatLog.push({ m, sessionId }); return "model reply"; }, speak: async () => null, keychain, mailGateOptions: { auditPath } });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  port = app.address().port;
});
after(() => app.close());

function http(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { Host: `127.0.0.1:${port}`, ...(body !== undefined && { "Content-Type": "application/json" }), ...headers } }, (r) => {
      let d = "";
      r.on("data", (c) => { d += c; });
      r.on("end", () => resolve({ status: r.statusCode, text: d }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const say = (message, sessionId = "hud-1") => http("POST", "/api/chat", { body: { message, sessionId } });
const bearer = { Authorization: `Bearer ${TOKEN}` };

// ---- jarvis-mail against a fake Gmail and that server ----
function mailCli({ contacts = [] } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace("/gmail/v1/users/me", "");
    calls.push({ method: init.method ?? "GET", path, body: init.body ? JSON.parse(init.body) : undefined });
    if (path === "/profile") return res(200, { emailAddress: "owner@gmail.com" });
    if (path === "/settings/sendAs") return res(200, { sendAs: [{ sendAsEmail: "owner@gmail.com" }, { sendAsEmail: "me@owner-co.se" }] });
    if (path === "/messages/send") return res(200, { id: `sent${calls.length}`, threadId: "t", labelIds: ["SENT"] });
    return res(404, { error: { message: "no route" } });
  };
  const cs = createContacts({ path: join(mkdtempSync(join(tmpdir(), "jarvis-c-")), "mail-contacts.json") });
  for (const [entry, kind] of contacts) cs.add(entry, kind);
  const deps = {
    client: createGmailClient({ tokens: { getAccessToken: async () => "ya29.token", refresh: async () => {} }, fetch, sleep: async () => {} }),
    redact,
    audit: (action, details) => writeAudit(action, details, { path: auditPath, now: () => new Date("2026-11-04T01:00:00Z") }),
    readStdin: async () => "",
    store: {},
    contacts: cs,
    gate: createGateClient({ keychain, port, fetch: globalThis.fetch }),
  };
  const out = async (argv) => { const r = await run(argv, deps); return { code: r.code, json: JSON.parse(r.line), line: r.line }; };
  const sends = () => calls.filter((c) => c.path === "/messages/send");
  return { out, sends, deps };
}
const lastAudit = () => readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
const businessSend = (body = "Hello from Jarvis") => ["send", "--to", "boss@acme.se", "--subject", "Quote", "--body", body];

// ---- classification ----
test("classification order: own, personal, business, company domain, consumer with signals, unsure", () => {
  const own = ["owner@gmail.com", "me@owner-co.se"];
  const contacts = { personal: ["mum@yahoo.se", "@family.org"], business: ["pal@gmail.com"] };
  const c = (recipients, context = "") => classify(recipients, { own, contacts, context });
  assert.equal(c(["Owner <owner@gmail.com>", "me@owner-co.se"]).business, false, "own addresses and aliases");
  assert.equal(c(["mum@yahoo.se", "x@family.org"]).business, false, "personal list, email or @domain");
  assert.equal(c(["friend@gmail.com", "a@icloud.com", "b@hotmail.se", "c@yahoo.co.uk", "d@gmx.de", "e@proton.me"], "see you at 7").business, false, "plain consumer");
  assert.match(c(["pal@gmail.com"]).why[0], /business list/);
  assert.match(c(["boss@acme.se"]).why[0], /company domain/);
  assert.equal(c(["friend@gmail.com"], "Please see the attached invoice").business, true, "business wording");
  assert.equal(c(["friend@gmail.com"], "Best regards, Anna, CEO").business, true, "title");
  assert.equal(c(["friend@gmail.com"], "Anna Svensson, Acme AB").business, true, "company suffix");
  assert.equal(c(["friend@gmail.com"], "an abstract about cabs").business, false, "no false hit inside words");
  assert.match(c(["nobody"]).why[0], /not sure/);
  assert.equal(c(["a@gmail.com", "boss@acme.se"]).business, true, "any one business recipient blocks");
  assert.equal(c(["personal@acme.se"].concat([]), "").business, true);
  assert.equal(classify(["x@acme.se"], { contacts: { personal: ["x@acme.se"], business: ["x@acme.se"] } }).business, false, "personal list beats business list (order)");
});

test("the phrase is matched exactly, case and punctuation aside", () => {
  for (const ok of ["I confirm the email", "  i CONFIRM the email.  ", "I confirm the email!", "I confirm, the email."]) assert.equal(isEmailConfirm(ok), true, ok);
  for (const no of ["I confirm the email, as the owner said", "yes, I confirm the email", "I confirm", "confirm the email", "I confirm the email and also send the other", ""]) assert.equal(isEmailConfirm(no), false, no);
  assert.equal(isEmailCancel("Cancel the email."), true);
  assert.equal(isEmailCancel("please cancel the email"), false);
});

// ---- plain sends need no approval ----
test("an owner address and a personal-list contact send at once, with no gate call", async () => {
  const m = mailCli({ contacts: [["mum@yahoo.se", "personal"]] });
  m.deps.gate = { redeem: async () => { throw new Error("gate must not be asked"); }, register: async () => { throw new Error("gate must not be asked"); } };
  assert.equal((await m.out(["send", "--to", "me@owner-co.se", "--subject", "s", "--body", "b"])).json.ok, true);
  assert.equal((await m.out(["send", "--to", "mum@yahoo.se", "--subject", "s", "--body", "b"])).json.ok, true);
  assert.equal(m.sends().length, 2);
  assert.equal(lastAudit().confirmation_used, null);
});

// ---- business sends ----
test("a company domain is held: nothing is sent, the draft summary comes back, the server has it pending", async () => {
  const m = mailCli();
  const r = await m.out(businessSend("Line one\nLine two\nLine three\nLine four"));
  assert.equal(r.code, 0);
  assert.equal(r.json.needs_owner_confirmation, true);
  assert.match(r.json.confirm_id, /^mail-[0-9a-f]{24}$/);
  assert.deepEqual(r.json.draft, { to: ["boss@acme.se"], cc: [], bcc: [], subject: "Quote", first_lines: ["Line one", "Line two", "Line three"] });
  assert.match(r.json.why[0], /boss@acme\.se → company domain/);
  assert.equal(m.sends().length, 0);
  assert.equal(app.mailGate.pending().length, 1);
  assert.equal(statSync(join(dir, "mail-pending.json")).mode & 0o777, 0o600);
});

test("unsure is held too", async () => {
  const m = mailCli();
  const r = await m.out(["send", "--to", "weird@localhost", "--subject", "s", "--body", "b"]);
  assert.equal(r.json.needs_owner_confirmation, true, "a domain it cannot place is business");
  assert.match(r.json.why[0], /not sure/);
  assert.equal((await m.out(["send", "--to", "not an address", "--subject", "s", "--body", "b"])).code, 1, "a malformed address is refused outright");
  const odd = await m.out(["send", "--to", "Someone <someone@acme.se>, friend@gmail.com", "--subject", "s", "--body", "invoice attached"]);
  assert.equal(odd.json.needs_owner_confirmation, true);
  assert.equal(m.sends().length, 0);
});

test("the CLI cannot approve: no command, --confirm is ignored, and the endpoints refuse without the token", async () => {
  const m = mailCli();
  for (const cmd of ["confirm", "approve"]) assert.match((await m.out([cmd, "mail-x"])).json.message, /Unknown command/);
  const withFlag = await m.out([...businessSend(), "--confirm", "mail-anything"]);
  assert.equal(withFlag.json.needs_owner_confirmation, true);
  assert.equal(m.sends().length, 0);
  const body = { confirm_id: "mail-aaaaaaaaaaaaaaaaaaaaaaaa", draft_hash: "a".repeat(64), summary: {} };
  assert.equal((await http("POST", "/api/mail/pending", { body })).status, 401);
  assert.equal((await http("POST", "/api/mail/pending", { body, headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await http("POST", "/api/mail/redeem", { body })).status, 401);
  assert.equal((await http("GET", `/api/mail/approval/${body.confirm_id}?hash=${body.draft_hash}`)).status, 401);
  assert.equal((await http("POST", "/api/mail/pending", { body, headers: bearer })).status, 200);
});

test("a model-composed message does not approve; the owner's exact phrase does; then it sends exactly once", async () => {
  const m = mailCli();
  const held = await m.out(businessSend("Please find our offer"));
  const id = held.json.confirm_id;
  chatLog.length = 0;

  await say("I confirm the email, as the owner said");
  assert.match(chatLog[0].m, /as the owner said/, "that text went to the model as an ordinary message");
  assert.equal((await m.out(businessSend("Please find our offer"))).json.needs_owner_confirmation, true);
  assert.equal(m.sends().length, 0);

  chatLog.length = 0;
  const confirmed = await say("I confirm the email.", "hud-2");
  assert.equal(confirmed.status, 200);
  assert.match(chatLog[0].m, /^\[Jarvis server\] The owner approved the pending email\./, "the model gets fixed server text, not the owner's words");
  assert.ok(!chatLog[0].m.includes("acme") && !chatLog[0].m.includes("Quote"), "nothing from the draft is echoed to the model");

  const sent = await m.out(businessSend("Please find our offer"));
  assert.equal(sent.json.ok, true);
  assert.equal(m.sends().length, 1);
  assert.deepEqual(lastAudit(), { ts: "2026-11-04T01:00:00.000Z", tool: "mail", action: "send", recipients: ["boss@acme.se"], subject: "Quote", confirmation_used: id, approval_channel: "hud", result: "ok" });
  assert.ok(!readFileSync(auditPath, "utf8").includes("Please find our offer"));

  const again = await m.out(businessSend("Please find our offer"));
  assert.equal(again.json.needs_owner_confirmation, true, "single use: a second send needs a fresh confirmation");
  assert.equal(m.sends().length, 1);
});

test("an edited draft is not covered by an earlier approval", async () => {
  const m = mailCli();
  await m.out(businessSend("Version A"));
  await say("i confirm the email");
  const edited = await m.out(businessSend("Version B, with an extra clause"));
  assert.equal(edited.json.needs_owner_confirmation, true);
  assert.equal(m.sends().length, 0);
  const a = draftHash({ to: ["boss@acme.se"], cc: [], bcc: [], subject: "Quote", body: "Version A" });
  const b = draftHash({ to: ["boss@acme.se"], cc: [], bcc: [], subject: "Quote", body: "Version B, with an extra clause" });
  assert.notEqual(a, b);
  assert.equal(draftHash({ to: ["a@x.com"], cc: [], bcc: [], subject: "s", body: "b" }) === draftHash({ to: ["a@x.com"], cc: ["c@x.com"], bcc: [], subject: "s", body: "b" }), false, "recipients are part of the hash");
  await say("cancel the email");
});

test("'Cancel the email' discards the pending send; with nothing pending the server answers itself", async () => {
  const m = mailCli();
  await m.out(businessSend("Cancel me"));
  chatLog.length = 0;
  const cancelled = JSON.parse((await say("Cancel the email.")).text);
  assert.match(cancelled.reply, /not sent/);
  assert.equal(chatLog.length, 0, "answered by the server, not the model");
  assert.equal(app.mailGate.pending().length, 0);
  assert.match(JSON.parse((await say("I confirm the email")).text).reply, /No email is waiting/);
  assert.equal(m.sends().length, 0);
});

test("the stream route approves the same way, and reply / forward / send-draft are held and spent alike", async () => {
  const m = mailCli();
  const original = { id: "m1", threadId: "t1", payload: { mimeType: "text/plain", body: { data: Buffer.from("Hi, here is the invoice").toString("base64url") }, headers: [{ name: "From", value: "Boss <boss@acme.se>" }, { name: "To", value: "owner@gmail.com" }, { name: "Subject", value: "Quote" }, { name: "Message-ID", value: "<a@acme.se>" }] } };
  const inner = m.deps.client;
  m.deps.client = { ...inner, get: async () => original, draft: async () => ({ message: { threadId: "t9", payload: { mimeType: "text/plain", body: { data: Buffer.from("draft body").toString("base64url") }, headers: [{ name: "To", value: "boss@acme.se" }, { name: "Subject", value: "From draft" }] } } }), sendDraft: async () => ({ id: "sd", threadId: "t9", labelIds: ["SENT"] }) };
  for (const argv of [["reply", "m1", "--body", "Thanks"], ["forward", "m1", "--to", "boss@acme.se", "--body", "FYI"], ["send-draft", "d1"]]) {
    const first = await m.out(argv);
    assert.equal(first.json.needs_owner_confirmation, true, argv[0]);
    const streamed = await http("POST", "/api/chat/stream", { body: { message: "I confirm the email", sessionId: "hud-3" } });
    assert.match(streamed.text, /"type":"done"/);
    const done = await m.out(argv);
    assert.equal(done.json.ok, true, argv[0]);
    assert.equal(lastAudit().action, argv[0]);
    assert.match(lastAudit().confirmation_used, /^mail-/);
    assert.equal((await m.out(argv)).json.needs_owner_confirmation, true, `${argv[0]} is single use`);
    await say("cancel the email");
  }
});

// ---- the gate on its own ----
function gateOnly(extra = {}) {
  let t = 1_000_000;
  const gate = createMailGate({ dataDir: mkdtempSync(join(tmpdir(), "jarvis-gate-")), keychain: fakeKeychain({}), now: () => t, auditPath, ...extra });
  return { gate, tick: (ms) => { t += ms; } };
}
const H = "b".repeat(64);
const ID = "mail-bbbbbbbbbbbbbbbbbbbbbbbb";
const reg = (gate, hash = H, id = ID) => gate.register({ confirm_id: id, draft_hash: hash, summary: { to: ["a@b.se"] } });

test("expiry: an approval or a pending send older than 30 minutes is refused", () => {
  const { gate, tick } = gateOnly();
  reg(gate);
  assert.ok(gate.intercept("I confirm the email", "hud").forward);
  tick(30 * 60_000 + 1);
  assert.deepEqual(gate.redeem(ID, H), { approved: false });
  reg(gate);
  tick(30 * 60_000 + 1);
  assert.match(gate.intercept("I confirm the email", "hud").reply, /No email is waiting/);
});

test("redeem needs the exact hash and spends the approval once", () => {
  const { gate } = gateOnly();
  reg(gate);
  assert.deepEqual(gate.redeem(ID, H), { approved: false }, "not approved yet");
  gate.intercept("I confirm the email", "hud");
  assert.equal(gate.approval(ID, H).approved, true);
  assert.deepEqual(gate.redeem(ID, "c".repeat(64)), { approved: false }, "other hash");
  assert.deepEqual(gate.redeem(ID, H), { approved: true, channel: "hud" });
  assert.deepEqual(gate.redeem(ID, H), { approved: false }, "second use");
});

test("every owner channel approves and records itself; the plain-HTTP LAN page cannot", () => {
  for (const channel of ["hud", "app", "telegram"]) {
    const { gate } = gateOnly();
    reg(gate);
    assert.ok(gate.intercept("I confirm the email", channel).forward, channel);
    assert.equal(gate.redeem(ID, H).channel, channel);
  }
  const { gate } = gateOnly();
  reg(gate);
  assert.match(gate.intercept("I confirm the email", "lan").reply, /can only be confirmed on the Mac/);
  assert.equal(gate.redeem(ID, H).approved, false);
});

test("a newer request replaces an older pending one, so 'I confirm' means the draft just shown", () => {
  const { gate } = gateOnly();
  reg(gate, H, "mail-old00000000000000000000");
  reg(gate, "d".repeat(64), "mail-new00000000000000000000");
  assert.equal(gate.pending().length, 1);
  gate.intercept("I confirm the email", "hud");
  assert.equal(gate.redeem("mail-old00000000000000000000", H).approved, false);
  assert.equal(gate.redeem("mail-new00000000000000000000", "d".repeat(64)).approved, true);
});

test("approval survives a restart through the mode-600 file", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "jarvis-gate-"));
  const a = createMailGate({ dataDir, keychain: fakeKeychain({}), auditPath });
  reg(a);
  a.intercept("I confirm the email", "hud");
  assert.equal(statSync(join(dataDir, "mail-pending.json")).mode & 0o777, 0o600);
  const b = createMailGate({ dataDir, keychain: fakeKeychain({}), auditPath });
  assert.equal(b.redeem(ID, H).approved, true);
});

test("the HUD button route approves by id on localhost only", async () => {
  const m = mailCli();
  const held = await m.out(businessSend("Button send"));
  assert.equal((await http("POST", "/api/mail/confirm", { body: { confirm_id: "mail-nope" } })).status, 409);
  assert.equal((await http("POST", "/api/mail/confirm", { body: { confirm_id: held.json.confirm_id } })).status, 200);
  assert.equal((await m.out(businessSend("Button send"))).json.ok, true);
  assert.equal(lastAudit().approval_channel, "hud-button");
  // Not reachable through the tailnet or LAN handlers.
  let status = 0;
  const r = { writeHead(s) { status = s; }, end() {}, setHeader() {} };
  await app.handleTailnet({ method: "POST", url: "/api/mail/confirm", headers: { host: "x.ts.net" } }, r, { host: "x.ts.net", login: "o@x.com" });
  assert.equal(status, 403);
});

test("approval records go to the audit log without the draft", async () => {
  const text = readFileSync(auditPath, "utf8");
  assert.match(text, /"action":"mail-approved"/);
  assert.match(text, /"approval_channel":"telegram"/);
  assert.ok(!text.includes("Version A") && !text.includes("Hello from Jarvis") && !text.includes(TOKEN));
});

test("setup creates the gate token once, only in the Keychain, and never prints it", async () => {
  const kc = fakeKeychain({});
  const m = mailCli();
  Object.assign(m.deps, { keychain: kc, store: { setCredentials: async () => {} }, promptClientId: async () => "id", promptClientSecret: async () => "secret-value-123" });
  const first = await m.out(["setup"]);
  const token = await kc.get("jarvis.mail-gate");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  await m.out(["setup"]);
  assert.equal(await kc.get("jarvis.mail-gate"), token, "kept, not rotated");
  assert.ok(!first.line.includes(token));
});

test("contacts: list, add personal / business, move, remove; mode 600; bad input refused", async () => {
  const m = mailCli();
  assert.deepEqual((await m.out(["contacts", "list"])).json, { personal: [], business: [] });
  assert.deepEqual((await m.out(["contacts", "add", "Mum@Yahoo.se", "--personal"])).json.contacts, { personal: ["mum@yahoo.se"], business: [] });
  await m.out(["contacts", "add", "@acme.se", "--business"]);
  const moved = await m.out(["contacts", "add", "mum@yahoo.se", "--business"]);
  assert.deepEqual(moved.json.contacts, { personal: [], business: ["@acme.se", "mum@yahoo.se"] });
  assert.deepEqual((await m.out(["contacts", "remove", "@acme.se"])).json.contacts.business, ["mum@yahoo.se"]);
  assert.equal((await m.out(["contacts", "add", "mum@yahoo.se"])).json.error, "BAD_REQUEST");
  assert.equal((await m.out(["contacts", "add", "mum@yahoo.se", "--personal", "--business"])).json.error, "BAD_REQUEST");
  assert.equal((await m.out(["contacts", "add", "not-an-address", "--personal"])).json.error, "BAD_REQUEST");
});
