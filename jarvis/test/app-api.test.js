// The phone bridge: the real server on a tailnet listener, a fake Keychain, a fake chat.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PAIRING_SERVICE, createAppApi, pair, renderQr, unpair } from "../server/app-api.js";
import { createKeychain } from "../server/keychain.js";
import { createServer } from "../server/server.js";
import { startTailnetListener } from "../server/tailnet.js";

const HOST = "mac.tail1234.ts.net";
const LOGIN = "owner@example.com";
const TOKEN = "T0ken_for_tests_AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const dir = mkdtempSync(join(tmpdir(), "jarvis-appapi-"));
const owner = { Host: HOST, "Tailscale-User-Login": LOGIN };
const auth = (t = TOKEN) => ({ ...owner, Authorization: `Bearer ${t}` });

const fakeKeychain = (data = {}) => ({ data, reads: 0, get: async function (s) { this.reads++; return this.data[s] ?? null; }, set: async function (s, v) { this.data[s] = v; }, remove: async function (s) { delete this.data[s]; } });

function call(port, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers } }, (res) => {
      let data = "";
      res.on("data", (d) => { data += d; });
      res.on("end", () => resolve({ status: res.statusCode, text: data, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}

let app, listener, port, chatCalls, release, keychain, logs, talk, gateState, gateCalls;
before(async () => {
  writeFileSync(join(dir, "tailnet.json"), JSON.stringify({ host: HOST, login: LOGIN }));
  keychain = fakeKeychain({ [PAIRING_SERVICE]: TOKEN });
  logs = [];
  chatCalls = [];
  release = null;
  gateCalls = [];
  gateState = { id: 0 };
  const gate = {
    current: () => (gateState.id ? { id: gateState.id } : undefined),
    describe: (s) => { gateCalls.push(["describe", s]); return null; },
    cancel: (s) => { gateCalls.push(["cancel", s]); },
    prompt: () => "prompt",
    confirm: async () => ({ reply: "merged" }),
  };
  talk = Object.assign(async (message, sessionId) => {
    chatCalls.push({ message, sessionId });
    if (message === "hold") await new Promise((r) => { release = r; });
    if (message === "merge") gateState.id = 7;
    return `model: ${message}`;
  }, { listeners: new Set(), on(fn) { this.listeners.add(fn); } });
  app = createServer({ booqyDir: dir, dataDir: dir, port: 0, gate, getState: async () => ({}), chat: talk, speak: async () => ({ audio: "AUDIO" }), keychain });
  listener = startTailnetListener({ dataDir: dir, handler: app.handleTailnet, port: 0, logger: (l) => logs.push(l) });
  await new Promise((r) => listener.on("listening", r));
  port = listener.address().port;
});
after(() => listener.close());

const events = () => [...talk.listeners];
const say = (sessionId, text) => Promise.all(events().map((fn) => fn({ sessionId, text })));

test("health needs the right token", async () => {
  assert.equal((await call(port, "GET", "/api/app/v1/health", owner)).status, 401);
  assert.equal((await call(port, "GET", "/api/app/v1/health", auth("wrong"))).status, 401);
  const ok = await call(port, "GET", "/api/app/v1/health", auth());
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.text), { ok: true, name: "Jarvis" });
  assert.deepEqual(JSON.parse((await call(port, "GET", "/api/app/v1/health", { ...owner, Authorization: "Basic abc" })).text), { error: "not paired" });
});

test("the owner check still applies first, even with the right token", async () => {
  assert.equal((await call(port, "GET", "/api/app/v1/health", { Host: HOST, Authorization: `Bearer ${TOKEN}` })).status, 403);
  assert.equal((await call(port, "GET", "/api/app/v1/health", { Host: HOST, "Tailscale-User-Login": "other@example.com", Authorization: `Bearer ${TOKEN}` })).status, 403);
  assert.equal((await call(port, "GET", "/api/app/v1/health", { Host: "evil.example", "Tailscale-User-Login": LOGIN, Authorization: `Bearer ${TOKEN}` })).status, 403);
});

test("app routes do not exist on localhost or the LAN handler", async () => {
  const local = createServer({ booqyDir: dir, dataDir: dir, port: 0, getState: async () => ({}), chat: async () => "x", keychain });
  await new Promise((r) => local.listen(0, "127.0.0.1", r));
  const lp = local.address().port;
  const h = { Host: `127.0.0.1:${lp}`, Authorization: `Bearer ${TOKEN}` };
  assert.equal((await call(lp, "GET", "/api/app/v1/health", h)).status, 404);
  assert.equal((await call(lp, "POST", "/api/app/v1/chat", { ...h, Origin: `http://127.0.0.1:${lp}` }, { message: "hi" })).status, 405);
  // The LAN handler: refuses anything outside the subnet, and has no app route inside it.
  const lan = { status: 0, body: "" };
  const res = { writeHead(s) { lan.status = s; }, end(b) { lan.body = b; }, setHeader() {} };
  await local.handlePhone({ method: "GET", url: "/api/app/v1/health", headers: { host: "192.168.1.5:7777", authorization: `Bearer ${TOKEN}` }, socket: { remoteAddress: "192.168.1.9", localPort: 7777 } }, res, { host: "192.168.1.5", subnet: "192.168.1.0/24" });
  assert.notEqual(lan.status, 200);
  local.close();
});

function unit(over = {}) {
  let t = 1_000_000;
  const kc = fakeKeychain({ [PAIRING_SERVICE]: TOKEN });
  const lines = [];
  const api = createAppApi({ keychain: kc, chatStream: async (req, res) => res.end("{}"), events: { subscribe: () => () => {} }, now: () => t, logger: (l) => lines.push(l), ...over });
  const ask = async (token, path = "/api/app/v1/health", method = "GET") => {
    const out = { headers: {} };
    const res = { writeHead(s, h) { out.status = s; Object.assign(out.headers, h); }, end(b) { out.body = b; }, write() {}, once() {}, on() {} };
    await api.handle({ method, url: path, headers: { authorization: `Bearer ${token}` }, on() {} }, res);
    return out;
  };
  return { api, kc, lines, ask, tick: (ms) => { t += ms; } };
}

test("tokens of any length are hashed first, so the comparison never throws", async () => {
  const u = unit();
  for (const t of ["a", TOKEN.slice(0, -1), TOKEN + "x", "z".repeat(5000)]) {
    assert.equal((await u.ask(t)).status, 401);
    assert.equal((await u.ask(TOKEN)).status, 200); // A success in between resets the lock counter.
  }
});

test("5 wrong tokens lock with Retry-After and exponential backoff, even for the right token", async () => {
  const u = unit();
  for (let i = 0; i < 5; i++) assert.equal((await u.ask("bad")).status, 401);
  const locked = await u.ask(TOKEN);
  assert.equal(locked.status, 429);
  assert.equal(locked.headers["Retry-After"], "30");
  u.tick(30_001);
  assert.equal((await u.ask(TOKEN)).status, 200);
  // A success resets the backoff; without one the wait doubles.
  const v = unit();
  for (let i = 0; i < 5; i++) await v.ask("bad");
  v.tick(30_001);
  for (let i = 0; i < 5; i++) await v.ask("bad");
  assert.equal((await v.ask(TOKEN)).headers["Retry-After"], "60");
});

test("30 requests a minute per token", async () => {
  const u = unit();
  for (let i = 0; i < 30; i++) assert.equal((await u.ask(TOKEN)).status, 200);
  const limited = await u.ask(TOKEN);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["Retry-After"]) >= 1);
  u.tick(60_001);
  assert.equal((await u.ask(TOKEN)).status, 200);
});

test("re-pairing works without a restart, re-read at most every 10 s", async () => {
  const u = unit();
  assert.equal((await u.ask(TOKEN)).status, 200);
  u.kc.data[PAIRING_SERVICE] = "new-token-NEW-1234567890";
  const reads = u.kc.reads;
  assert.equal((await u.ask("new-token-NEW-1234567890")).status, 401); // Within 10 s: cached.
  assert.equal(u.kc.reads, reads);
  u.tick(10_001);
  assert.equal((await u.ask("new-token-NEW-1234567890")).status, 200);
  assert.equal((await u.ask(TOKEN)).status, 401);
});

test("nothing paired means not paired", async () => {
  const u = unit({ keychain: fakeKeychain() });
  assert.equal((await u.ask(TOKEN)).status, 401);
});

test("chat goes to session owner, as the phone, with no confirmation", async () => {
  chatCalls.length = 0;
  gateCalls.length = 0;
  const res = await call(port, "POST", "/api/app/v1/chat", { ...auth(), Origin: `https://${HOST}` }, { message: "status", sessionId: "someone-else", voice: true });
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /ndjson/);
  const lines = res.text.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(chatCalls, [{ message: "status", sessionId: "owner" }]);
  const done = lines.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.confirm, null);
  assert.ok(!res.text.includes("AUDIO"), "the phone speaks for itself: no audio");
  assert.ok(!gateCalls.some(([n]) => n === "describe"));
});

test("a merge started from the phone is cancelled, not confirmable", async () => {
  gateCalls.length = 0;
  const res = await call(port, "POST", "/api/app/v1/chat", auth(), { message: "merge" });
  assert.match(res.text, /can only be confirmed on the Mac/);
  assert.deepEqual(gateCalls.filter(([n]) => n === "cancel"), [["cancel", "owner"]]);
  gateState.id = 0;
  // And the confirm route is not part of the app API.
  assert.equal((await call(port, "POST", "/api/app/v1/confirm", auth(), {})).status, 404);
});

test("only one chat at a time", async () => {
  const first = call(port, "POST", "/api/app/v1/chat", auth(), { message: "hold" });
  await new Promise((r) => setTimeout(r, 100));
  const second = await call(port, "POST", "/api/app/v1/chat", auth(), { message: "again" });
  assert.equal(second.status, 429);
  assert.ok(second.headers["retry-after"]);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await call(port, "POST", "/api/app/v1/chat", auth(), { message: "after" })).status, 200);
});

test("body limits and validation", async () => {
  const post = (body) => call(port, "POST", "/api/app/v1/chat", auth(), body);
  assert.equal((await post({ message: "" })).status, 400);
  assert.equal((await post({ message: "   " })).status, 400);
  assert.equal((await post({ message: 5 })).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post({ message: "x".repeat(20_001) })).status, 400);
  assert.equal((await post({ message: "x".repeat(200_000) }).catch(() => ({ status: 413 }))).status, 413);
  assert.equal((await call(port, "POST", "/api/app/v1/chat", { ...auth(), "Content-Type": "text/plain" }, "{}")).status, 403);
  assert.equal((await call(port, "GET", "/api/app/v1/chat", auth())).status, 405);
  assert.equal((await call(port, "GET", "/api/app/v1/nope", auth())).status, 404);
});

test("events carry only Jarvis's words for the owner session", async () => {
  const chunks = [];
  const req = request({ host: "127.0.0.1", port, path: "/api/app/v1/events", headers: auth() }, (res) => {
    assert.match(res.headers["content-type"], /event-stream/);
    res.on("data", (d) => chunks.push(d.toString()));
  });
  req.end();
  await new Promise((r) => setTimeout(r, 100));
  await say("owner", "Your build passed, sir.");
  await say("some-hud-tab", "private to another session");
  await new Promise((r) => setTimeout(r, 50));
  const data = chunks.join("");
  assert.deepEqual(data.match(/^data: .*$/gm), [`data: ${JSON.stringify({ type: "jarvis", text: "Your build passed, sir." })}`]);
  assert.ok(!data.includes("another session") && !data.includes("AUDIO") && !data.includes('"city"'));
  req.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events().length, 1); // Just the server's own talk.on hook.
});

test("events need the token and send a keepalive", async () => {
  assert.equal((await call(port, "GET", "/api/app/v1/events", owner)).status, 401);
  const writes = [];
  const api = createAppApi({ keychain: fakeKeychain({ [PAIRING_SERVICE]: TOKEN }), chatStream: async () => {}, events: { subscribe: () => () => {} }, keepaliveMs: 20 });
  const req = Object.assign(new EventEmitter(), { method: "GET", url: "/api/app/v1/events", headers: { authorization: `Bearer ${TOKEN}` } });
  await api.handle(req, { writeHead() {}, write: (s) => writes.push(s) });
  await new Promise((r) => setTimeout(r, 70));
  req.emit("close");
  assert.ok(writes.filter((w) => w === ": keepalive\n\n").length >= 2);
});

test("the token never shows up in logs or responses", async () => {
  const all = [];
  all.push((await call(port, "GET", "/api/app/v1/health", auth("wrong-secret-attempt"))).text);
  all.push((await call(port, "GET", "/api/app/v1/health", auth())).text);
  all.push((await call(port, "POST", "/api/app/v1/chat", auth(), "bad")).text);
  const blob = JSON.stringify([all, logs]);
  assert.ok(!blob.includes(TOKEN) && !blob.includes("wrong-secret-attempt"));
  const u = unit();
  for (let i = 0; i < 5; i++) await u.ask("leaky-token-0000");
  assert.ok(u.lines.length > 0 && !JSON.stringify(u.lines).includes("leaky-token-0000"));
});

// ---- Keychain and pairing ----

test("keychain.set puts the value on stdin, never in argv", async () => {
  const calls = [];
  const kc = createKeychain({ run: async (args, opts = {}) => { calls.push({ args, input: opts.input }); return { code: 0, stdout: "", stderr: "" }; } });
  await kc.set("svc", 'sec"ret\\value');
  assert.deepEqual(calls[0].args, ["-i"]);
  assert.equal(calls[0].input, 'add-generic-password -U -a jarvis -s svc -w "sec\\"ret\\\\value"\n');
  await assert.rejects(kc.set("svc", "a\nb"), /control/);
});

test("keychain get, missing and remove", async () => {
  const calls = [];
  const run = (code, stdout = "") => async (args) => { calls.push(args); return { code, stdout, stderr: "" }; };
  assert.equal(await createKeychain({ run: run(0, "v\n") }).get("svc"), "v");
  assert.deepEqual(calls[0], ["find-generic-password", "-a", "jarvis", "-s", "svc", "-w"]);
  assert.equal(await createKeychain({ run: run(44) }).get("svc"), null);
  await createKeychain({ run: run(0) }).remove("svc");
  assert.deepEqual(calls.at(-1), ["delete-generic-password", "-a", "jarvis", "-s", "svc"]);
});

test("pair needs tailnet.json, then stores a 43-char base64url token via stdin and rotates", async () => {
  const empty = mkdtempSync(join(tmpdir(), "jarvis-nopair-"));
  await assert.rejects(pair({ dataDir: empty, keychain: fakeKeychain(), render: async () => {} }), /Run scripts\/enable-tailscale\.sh first\./);

  const stdinCalls = [];
  const kc = createKeychain({ run: async (args, opts = {}) => { stdinCalls.push({ args, input: opts.input }); return { code: 0, stdout: "", stderr: "" }; } });
  const lines = [];
  const rendered = [];
  const payload = await pair({ dataDir: dir, keychain: kc, render: async (p) => { rendered.push(p); }, out: (l) => lines.push(l) });
  const m = /^jarvis-pair:\/\/v1\?host=([^&]+)&token=([A-Za-z0-9_-]{43})$/.exec(payload);
  assert.ok(m, payload);
  assert.equal(decodeURIComponent(m[1]), HOST);
  assert.deepEqual(rendered, [payload]);
  assert.deepEqual(stdinCalls[0].args, ["-i"]);
  assert.ok(stdinCalls[0].input.includes(`-s ${PAIRING_SERVICE}`) && stdinCalls[0].input.includes(m[2]));
  assert.ok(!JSON.stringify(stdinCalls.map((c) => c.args)).includes(m[2]));
  assert.ok(lines.some((l) => /shown only now/.test(l)) && lines.includes(payload));

  const second = await pair({ dataDir: dir, keychain: fakeKeychain(), render: async () => {}, out: () => {} });
  assert.notEqual(second, payload);
});

test("a failing QR renderer still prints the paste text; unpair removes the item", async () => {
  const kc = fakeKeychain();
  const lines = [];
  const payload = await pair({ dataDir: dir, keychain: kc, render: async () => { throw new Error("no swift"); }, out: (l) => lines.push(l) });
  assert.ok(lines.includes(payload));
  assert.ok(kc.data[PAIRING_SERVICE]);
  await unpair({ keychain: kc, out: () => {} });
  assert.equal(kc.data[PAIRING_SERVICE], undefined);
});

test("qr.swift gets the payload on stdin, not argv", async () => {
  let spawned;
  const stdin = [];
  const fake = (cmd, args, opts) => {
    spawned = { cmd, args, opts };
    const child = new EventEmitter();
    child.stdin = { end: (d) => { stdin.push(d); setImmediate(() => child.emit("close", 0)); } };
    return child;
  };
  await renderQr("jarvis-pair://v1?host=h&token=SECRETTOKEN", { spawnFn: fake });
  assert.equal(spawned.cmd, "swift");
  assert.equal(spawned.args.length, 1);
  assert.match(spawned.args[0], /scripts\/qr\.swift$/);
  assert.ok(!JSON.stringify(spawned).includes("SECRETTOKEN"));
  assert.deepEqual(stdin, ["jarvis-pair://v1?host=h&token=SECRETTOKEN"]);
});
