// The iPhone route, through a real listener on loopback with a fake network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { createMergeGate } from "../server/merge.js";
import { createPhoneAccess, disable, enable, inSubnet, readConfig, startPhoneListener } from "../server/phone.js";
import { createServer } from "../server/server.js";

const PASSCODE = "correct horse";
const HOME = { address: "127.0.0.1", netmask: "255.0.0.0", networkId: "aa:bb:cc:dd:ee:ff", host: "my-mac.local" };
const dataDir = mkdtempSync(join(tmpdir(), "jarvis-phone-"));
const mergeRequest = { repo: "BookingSystemAdvancedOrg/application", number: 7, title: "Release", head: "abc", ci: "2 passed" };

let net = HOME;
let server, phone, gate;
let chatCalls = 0;
let confirmCalls = 0;
let askForMerge = false;

function call(path, { method = "GET", host, body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const port = phone.port();
    const req = request({ host: "127.0.0.1", port, path, method, headers: { Host: host ?? `my-mac.local:${port}`, ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, text, headers: res.headers, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function signIn() {
  const r = await call("/login", { method: "POST", body: { passcode: PASSCODE } });
  assert.equal(r.status, 200);
  return r.headers["set-cookie"][0].split(";")[0];
}

before(async () => {
  enable(dataDir, PASSCODE, HOME);
  const real = createMergeGate({ dataDir });
  gate = { ...real, confirm: async () => { confirmCalls += 1; return { ok: true, reply: "merged" }; } };
  const chat = async (_message, sessionId) => {
    chatCalls += 1;
    if (askForMerge) {
      const file = gate.requestFile();
      writeFileSync(file, JSON.stringify(mergeRequest));
      gate.collect(file, sessionId);
    }
    return "Good evening, sir.";
  };
  server = createServer({ booqyDir: dataDir, dataDir, port: 0, chat, gate, getState: async () => ({ live: true }), speak: async () => ({}), transcribe: async () => "heard" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  phone = startPhoneListener({ dataDir, port: 0, handler: server.handlePhone, network: async () => net, bindAddress: "127.0.0.1" });
  await phone.ready;
  await new Promise((resolve) => setTimeout(resolve, 20));
});

after(() => {
  phone.stop();
  server.close();
});

beforeEach(() => {
  chatCalls = 0;
  confirmCalls = 0;
  askForMerge = false;
});

test("the passcode is stored only as a hash, readable by the owner alone", () => {
  const raw = readFileSync(join(dataDir, "iphone.json"), "utf8");
  assert.ok(!raw.includes(PASSCODE));
  assert.equal(statSync(join(dataDir, "iphone.json")).mode & 0o777, 0o600);
});

test("a short passcode is refused", () => {
  const other = mkdtempSync(join(tmpdir(), "jarvis-phone-"));
  assert.throws(() => enable(other, "12345", HOME));
  assert.equal(readConfig(other), null);
});

test("without the passcode only the prompt is served", async () => {
  const page = await call("/");
  assert.equal(page.status, 200);
  assert.match(page.text, /Passcode/);
  assert.ok(!page.text.includes("BUILDING"));
  for (const path of ["/index.html", "/state.json", "/manifest.webmanifest", "/icon-192.png"]) assert.equal((await call(path)).status, 401, path);
  assert.equal((await call("/api/chat", { method: "POST", body: { message: "status", sessionId: "s1" } })).status, 401);
  assert.equal(chatCalls, 0);
});

test("the passcode opens the HUD and state", async () => {
  const cookie = await signIn();
  assert.match((await call("/", { cookie })).text, /BUILDING/);
  assert.deepEqual((await call("/state.json", { cookie })).json(), { live: true });
  assert.equal((await call("/api/chat", { method: "POST", cookie, body: { message: "status", sessionId: "s1" } })).json().reply, "Good evening, sir.");
});

test("the session cookie cannot be read by scripts or sent cross-site", async () => {
  const r = await call("/login", { method: "POST", body: { passcode: PASSCODE } });
  assert.match(r.headers["set-cookie"][0], /HttpOnly; SameSite=Strict/);
});

test("a made-up cookie is refused", async () => {
  assert.equal((await call("/state.json", { cookie: "jarvis_phone=abc" })).status, 401);
});

test("other hosts and cross-site requests are refused, even signed in", async () => {
  const cookie = await signIn();
  assert.equal((await call("/", { host: "evil.example:7777", cookie })).status, 403);
  assert.equal((await call("/", { host: `localhost:${phone.port()}`, cookie })).status, 403);
  const post = { method: "POST", cookie, body: { message: "x", sessionId: "s1" } };
  assert.equal((await call("/api/chat", { ...post, headers: { Origin: "http://evil.example" } })).status, 403);
  assert.equal((await call("/api/chat", { ...post, headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal(chatCalls, 0);
});

test("peers outside the home subnet are refused", () => {
  assert.ok(inSubnet("192.168.1.20", { address: "192.168.1.5", netmask: "255.255.255.0" }));
  assert.ok(!inSubnet("192.168.2.20", { address: "192.168.1.5", netmask: "255.255.255.0" }));
  assert.ok(!inSubnet("fe80::1", { address: "192.168.1.5", netmask: "255.255.255.0" }));
});

test("the phone can never confirm a merge to main", async () => {
  const cookie = await signIn();
  askForMerge = true;
  const asked = (await call("/api/chat", { method: "POST", cookie, body: { message: "merge it", sessionId: "phone" } })).json();
  assert.match(asked.reply, /only be confirmed on the Mac/);
  assert.equal(asked.confirm, null);
  assert.equal(gate.current("phone"), null);

  // Even naming a session the Mac has waiting.
  const file = gate.requestFile();
  writeFileSync(file, JSON.stringify(mergeRequest));
  gate.collect(file, "mac");
  const { id } = gate.describe("mac");
  askForMerge = false;
  assert.equal((await call("/api/confirm", { method: "POST", cookie, body: { sessionId: "mac", id, action: "merge" } })).status, 403);
  const said = (await call("/api/chat", { method: "POST", cookie, body: { message: "I confirm", sessionId: "mac" } })).json();
  assert.equal(said.confirm, null);
  assert.equal(confirmCalls, 0);
  gate.cancel("mac");
});

test("GET /api/confirm/pending: the phone route sees null, a bad sessionId is a 400, and it only reads", async () => {
  const cookie = await signIn();
  const file = gate.requestFile();
  writeFileSync(file, JSON.stringify(mergeRequest));
  gate.collect(file, "mac2");
  const r = await call("/api/confirm/pending?sessionId=mac2", { cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json(), { confirm: null });
  assert.equal((await call("/api/confirm/pending?sessionId=bad%20id", { cookie })).status, 400);
  assert.equal(confirmCalls, 0);
  assert.ok(gate.current("mac2"), "reading changed nothing");
  gate.cancel("mac2");
});

test("the phone route does not take audio", async () => {
  const cookie = await signIn();
  assert.equal((await call("/api/listen", { method: "POST", cookie, body: { audio: "" } })).status, 403);
});

test("the listener closes off the home network, and reopens on it", async () => {
  net = { ...HOME, networkId: "11:22:33:44:55:66" };
  await phone.check();
  assert.equal(phone.port(), null);
  net = null;
  await phone.check();
  assert.equal(phone.port(), null);
  net = HOME;
  await phone.check();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(phone.port());
});

test("wrong passcodes lock the route, and the right one is refused while locked", () => {
  let time = 0;
  const access = createPhoneAccess({ dataDir, now: () => time });
  for (let i = 0; i < 4; i++) assert.equal(access.login("wrong").retryInMs, undefined);
  assert.equal(access.login("wrong").retryInMs, 60_000);
  assert.deepEqual(access.login(PASSCODE), { ok: false, retryInMs: 60_000 });
  time = 60_001;
  assert.equal(access.login("wrong").retryInMs, 120_000);
  time = 60_001 + 120_001;
  assert.ok(access.login(PASSCODE).ok);
});

test("sessions expire", () => {
  let time = 0;
  const access = createPhoneAccess({ dataDir, now: () => time });
  const cookie = access.login(PASSCODE).cookie.split(";")[0];
  assert.ok(access.authed(cookie));
  time = 31 * 24 * 60 * 60 * 1000;
  assert.ok(!access.authed(cookie));
});

test("changing or disabling the passcode ends sessions and closes the listener", async () => {
  const other = mkdtempSync(join(tmpdir(), "jarvis-phone-"));
  enable(other, PASSCODE, HOME);
  const access = createPhoneAccess({ dataDir: other });
  const cookie = access.login(PASSCODE).cookie.split(";")[0];
  assert.ok(access.authed(cookie));
  enable(other, "a new passcode", HOME);
  assert.ok(!access.authed(cookie));

  const listener = startPhoneListener({ dataDir: other, port: 0, handler: (_req, res) => res.end(), network: async () => HOME, bindAddress: "127.0.0.1" });
  await listener.ready;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(listener.port());
  disable(other);
  await listener.check();
  assert.equal(listener.port(), null);
  assert.ok(!access.authed(cookie));
  listener.stop();
});

test("with the option off nothing listens", async () => {
  const other = mkdtempSync(join(tmpdir(), "jarvis-phone-"));
  const listener = startPhoneListener({ dataDir: other, port: 0, handler: (_req, res) => res.end(), network: async () => HOME, bindAddress: "127.0.0.1" });
  await listener.ready;
  assert.equal(listener.port(), null);
  listener.stop();
});
