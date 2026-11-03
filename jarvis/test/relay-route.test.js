// The OpenClaw relay route: the real server, a fake Keychain, a fake chat and a fake merge gate.
// The relay has the phone's rights, so a merge to main can never be confirmed through it.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { RELAY_PATH, RELAY_SERVICE, createServer } from "../server/server.js";
import { startTailnetListener } from "../server/tailnet.js";

const RELAY_TOKEN = "relay_token_for_tests_BBBBBBBBBBBBBBBBBBBBBBBB";
const dir = mkdtempSync(join(tmpdir(), "jarvis-relay-"));

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
before(async () => {
  const keychain = { get: async (s) => (s === RELAY_SERVICE ? RELAY_TOKEN : null), set: async () => {}, remove: async () => {} };
  const gate = {
    current: () => (pending ? { id: pending } : undefined),
    describe: () => null,
    prompt: () => "Merge PR 1 to main? Say: I confirm.",
    cancel: (s) => { gateCalls.push(["cancel", s]); pending = 0; },
    confirm: async (s) => { gateCalls.push(["confirm", s]); pending = 0; return { reply: "Merged to main." }; },
  };
  const talk = Object.assign(async (message, sessionId) => {
    chatCalls.push({ message, sessionId });
    if (message === "merge PR 1") pending = 1; // Jarvis asks for a merge during this turn
    return `Jarvis: ${message}`;
  }, { on() {} });
  app = createServer({ booqyDir: dir, dataDir: dir, port: 0, gate, getState: async () => ({}), chat: talk, speak: async () => ({}), keychain });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  port = app.address().port;
});
after(() => app.close());
beforeEach(() => { chatCalls = []; gateCalls = []; pending = 0; });

test("a pending merge to main can NOT be confirmed through the relay; the same words on the HUD route do", async () => {
  pending = 7;
  const viaRelay = await relay(port, "I confirm");
  assert.equal(viaRelay.status, 200);
  assert.ok(!gateCalls.some(([n]) => n === "confirm"), "the relay never reaches gate.confirm");
  assert.notEqual(viaRelay.json.reply, "Merged to main.");
  assert.equal(viaRelay.json.confirm, null, "no merge prompt is offered to the relay");
  assert.deepEqual(chatCalls, [{ message: "I confirm", sessionId: "owner" }], "it is just words to Jarvis");
  assert.equal(pending, 7, "the pending merge is untouched");

  // Control: the HUD's own route does confirm, so the test can tell the two apart.
  const viaHud = await call(port, "/api/chat", { body: { message: "I confirm", sessionId: "owner" } });
  assert.equal(viaHud.json.reply, "Merged to main.");
  assert.deepEqual(gateCalls, [["confirm", "owner"]]);
});

test("a merge requested during a relayed turn is cancelled, with the phone's message", async () => {
  const res = await relay(port, "merge PR 1");
  assert.equal(res.status, 200);
  assert.deepEqual(gateCalls, [["cancel", "owner"]]);
  assert.match(res.json.reply, /only be confirmed on the Mac/);
  assert.equal(pending, 0);
});

test("no token or a wrong token: 401, and Jarvis never sees the message", async () => {
  for (const token of [null, "", "wrong", RELAY_TOKEN.slice(0, -1), `${RELAY_TOKEN}x`]) {
    const res = await relay(port, "I confirm", token);
    assert.equal(res.status, 401, `token ${JSON.stringify(token)}`);
    assert.deepEqual(res.json, { error: "relay not authorised" });
  }
  assert.deepEqual(chatCalls, []);
  assert.deepEqual(gateCalls, []);
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
    const res = await call(tailnet.address().port, RELAY_PATH, {
      host: "mac.tail1234.ts.net",
      headers: { "Tailscale-User-Login": "owner@example.com", "X-Forwarded-Proto": "https", Authorization: `Bearer ${RELAY_TOKEN}` },
      body: { message: "I confirm" },
    });
    assert.notEqual(res.status, 200);
    assert.deepEqual(chatCalls, []);
  } finally {
    tailnet.close();
  }
});
