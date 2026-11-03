// The tailnet route: the real server, with the headers `tailscale serve` would send.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createMergeGate } from "../server/merge.js";
import { createServer } from "../server/server.js";
import { readConfig, startTailnetListener } from "../server/tailnet.js";

const HOST = "mac.tail1234.ts.net";
const LOGIN = "owner@example.com";
const dir = mkdtempSync(join(tmpdir(), "jarvis-tailnet-"));
let app, listener, port, gate;
const owner = { Host: HOST, "Tailscale-User-Login": LOGIN };
const call = (method, path, headers, body) => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path, method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers } }, (res) => {
    let data = "";
    res.on("data", (d) => { data += d; });
    res.on("end", () => resolve({ status: res.statusCode, text: data }));
  });
  req.on("error", reject);
  req.end(body ? JSON.stringify(body) : undefined);
});

before(async () => {
  writeFileSync(join(dir, "tailnet.json"), JSON.stringify({ host: HOST, login: LOGIN }));
  gate = createMergeGate({ dataDir: dir });
  app = createServer({ booqyDir: dir, dataDir: dir, port: 0, gate, getState: async () => ({}), chat: async (m) => `model: ${m}`, speak: async () => null, transcribe: async () => "Yo Jarvis, status." });
  listener = startTailnetListener({ dataDir: dir, handler: app.handleTailnet, port: 0 });
  await new Promise((r) => listener.on("listening", r));
  port = listener.address().port;
});
after(() => listener.close());

test("off without a config, and only on loopback", () => {
  assert.equal(readConfig(mkdtempSync(join(tmpdir(), "jarvis-none-"))), null);
  assert.equal(startTailnetListener({ dataDir: mkdtempSync(join(tmpdir(), "jarvis-none-")), handler: () => {} }), null);
  assert.equal(listener.address().address, "127.0.0.1");
});

test("the owner gets the HUD and chat", async () => {
  assert.equal((await call("GET", "/", owner)).status, 200);
  const res = await call("POST", "/api/chat", { ...owner, Origin: `https://${HOST}` }, { message: "status", sessionId: "t" });
  assert.equal(JSON.parse(res.text).reply, "model: status");
});

test("the Home Screen app files load for the owner", async () => {
  const icon = await call("GET", "/apple-touch-icon.png", owner);
  assert.equal(icon.status, 200);
  assert.equal(JSON.parse((await call("GET", "/manifest.webmanifest", owner)).text).display, "standalone");
  assert.match((await call("GET", "/", owner)).text, /apple-mobile-web-app-capable/);
});

test("anyone else is refused", async () => {
  assert.equal((await call("GET", "/", { Host: HOST })).status, 403);
  assert.equal((await call("GET", "/", { Host: HOST, "Tailscale-User-Login": "other@example.com" })).status, 403);
  assert.equal((await call("GET", "/", { Host: "evil.example", "Tailscale-User-Login": LOGIN })).status, 403);
  assert.equal((await call("GET", "/", { Host: "localhost", "Tailscale-User-Login": LOGIN })).status, 403);
});

test("cross-site and plain http origins cannot post", async () => {
  for (const Origin of ["https://evil.example", `http://${HOST}`]) {
    assert.equal((await call("POST", "/api/chat", { ...owner, Origin }, { message: "x", sessionId: "t" })).status, 403, Origin);
  }
});

test("the owner can use the microphone and confirm a merge from here", async () => {
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(64)]);
  const heard = await call("POST", "/api/listen", { ...owner, Origin: `https://${HOST}` }, { audio: wav.toString("base64") });
  assert.equal(JSON.parse(heard.text).wake, true);
  const file = gate.requestFile();
  writeFileSync(file, JSON.stringify({ repo: "BookingSystemAdvancedOrg/application", number: 7, title: "x", url: "https://github.com/x", head: "abc", ci: "2 passed", mergeable: "MERGEABLE" }));
  gate.collect(file, "t");
  const asked = await call("POST", "/api/chat", { ...owner, Origin: `https://${HOST}` }, { message: "anything", sessionId: "t" });
  assert.equal(JSON.parse(asked.text).confirm.number, 7);
  assert.equal(gate.cancel("t"), true);
});
