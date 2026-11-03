// GPT-Live: the key stays on the server, and the session is what the docs ask for.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { childEnv } from "../server/chat.js";
import { LIVE_INSTRUCTIONS, createLiveSession, liveAvailable, liveSessionRequest } from "../server/live.js";
import { createServer } from "../server/server.js";

const KEY = "sk-test-secret-do-not-leak";
const dir = mkdtempSync(join(tmpdir(), "jarvis-live-"));
const original = process.env.OPENAI_API_KEY;
let server, port, offers = [], failing = false;
const call = (method, path, body) => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path, method, headers: body ? { "Content-Type": "application/json" } : {} }, (res) => {
    let data = "";
    res.on("data", (d) => { data += d; });
    res.on("end", () => resolve({ status: res.statusCode, text: data, json: JSON.parse(data || "{}") }));
  });
  req.on("error", reject);
  req.end(body ? JSON.stringify(body) : undefined);
});

before(async () => {
  server = createServer({ booqyDir: dir, dataDir: dir, port: 0, getState: async () => ({}), chat: async () => "ok", speak: async () => null, transcribe: async () => "",
    startLive: async (sdp) => { offers.push(sdp); if (failing) throw new Error(`OpenAI answered 500 ${KEY}`); return "answer-sdp"; } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(() => { server.close(); if (original === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = original; });

test("the session request matches the GPT-Live docs", () => {
  const body = liveSessionRequest("offer", "vesper");
  assert.equal(body.session.model, "gpt-live-1");
  assert.equal(body.session.audio.output.voice, "vesper");
  assert.deepEqual(body.session.delegation, { type: "client" });
  assert.deepEqual(body.transport, { type: "webrtc", sdp: "offer" });
  assert.match(LIVE_INSTRUCTIONS, /<\|SpawnThinking\|>/);
  assert.match(LIVE_INSTRUCTIONS, /Never imitate a real actor/);
});

test("the OpenAI call uses the key and returns only the answer", async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ session: { id: "live_1" }, transport: { type: "webrtc", sdp: "the-answer" } }) }; };
  assert.equal(await createLiveSession("offer", { env: { OPENAI_API_KEY: KEY }, fetchImpl }), "the-answer");
  assert.equal(seen.url, "https://api.openai.com/v1/live/sessions");
  assert.equal(seen.init.headers.Authorization, `Bearer ${KEY}`);
  assert.ok(!seen.init.body.includes(KEY));
});

test("an OpenAI error carries no body or key", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: KEY }) });
  await assert.rejects(createLiveSession("offer", { env: { OPENAI_API_KEY: KEY }, fetchImpl }), (err) => err.status === 401 && !err.message.includes(KEY));
});

test("without a key the page is told, and the local voice stays in charge", async () => {
  delete process.env.OPENAI_API_KEY;
  assert.equal(liveAvailable(), false);
  assert.equal((await call("GET", "/api/live/status")).json.available, false);
  assert.equal((await call("POST", "/api/live/session", { sdp: "offer" })).status, 503);
});

test("with a key the offer is exchanged, and no response holds the key", async () => {
  process.env.OPENAI_API_KEY = KEY;
  const status = await call("GET", "/api/live/status");
  assert.equal(status.json.available, true);
  assert.ok(!status.text.includes(KEY));
  const ok = await call("POST", "/api/live/session", { sdp: "offer" });
  assert.deepEqual(ok.json, { sdp: "answer-sdp" });
  assert.ok(offers.includes("offer"));
  assert.equal((await call("POST", "/api/live/session", {})).status, 400);
  failing = true;
  const bad = await call("POST", "/api/live/session", { sdp: "offer" });
  failing = false;
  assert.equal(bad.status, 502);
  assert.ok(!bad.text.includes(KEY));
});

test("the Claude process does not get the key", () => {
  process.env.OPENAI_API_KEY = KEY;
  assert.equal(childEnv(dir).OPENAI_API_KEY, undefined);
});
