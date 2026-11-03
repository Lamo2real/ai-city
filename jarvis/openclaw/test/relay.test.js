// A message in → one POST to Jarvis's relay route (phone rights) with the relay token → the reply out.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { askJarvis } from "../plugins/jarvis-relay/relay.js";

const seen = [];
let server, base;
before(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      const body = JSON.parse(data);
      seen.push({ path: req.url, type: req.headers["content-type"], auth: req.headers.authorization, ...body });
      res.setHeader("Content-Type", "application/json");
      if (body.message === "fail") { res.statusCode = 502; return res.end(JSON.stringify({ error: "Jarvis could not get an answer" })); }
      res.end(JSON.stringify({ reply: `  On it, sir: ${body.message}  ` }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const ENV = { JARVIS_RELAY_TOKEN: "relay-token-for-tests" };
const ask = (msg, config = { server: base }, env = ENV) => askJarvis(config, msg, fetch, env);

test("a message from the phone reaches Jarvis's relay route with the relay token, and the reply comes back", async () => {
  assert.equal(await ask("status please"), "On it, sir: status please");
  assert.deepEqual(seen, [{ path: "/api/relay/chat", type: "application/json", auth: "Bearer relay-token-for-tests", message: "status please" }]);
});

test("no relay token, no request; the token only ever goes to Jarvis on loopback", async () => {
  const before = seen.length;
  await assert.rejects(ask("hi", { server: base }, {}), /relay token missing/);
  for (const server of ["https://evil.example", "http://192.168.1.5:7777", "http://m-d1hgp.example.ts.net", "file:///etc/passwd", "not a url"]) {
    await assert.rejects(ask("hi", { server }), /loopback|not a URL/);
  }
  assert.equal(seen.length, before, "nothing was sent");
});

test("errors and empty messages never turn into an answer", async () => {
  await assert.rejects(ask("fail"), /could not get an answer/);
  await assert.rejects(ask("   "), /empty/);
  await assert.rejects(ask("x".repeat(20_001)), /too long/);
});

test("the plugin exposes exactly one tool, ask_jarvis, with no shell, files or browser", async () => {
  const plugin = (await import("../plugins/jarvis-relay/index.js")).default;
  const manifest = (await import("../plugins/jarvis-relay/openclaw.plugin.json", { with: { type: "json" } })).default;
  assert.equal(plugin.id, "jarvis-relay");
  assert.deepEqual(manifest.contracts.tools, ["ask_jarvis"]);
  const registered = { tools: [], other: [] };
  const api = new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => registered.tools.push(tool) : (...args) => registered.other.push([key, args])) });
  plugin.register(api);
  assert.deepEqual(registered.tools.map((t) => t.name), ["ask_jarvis"]);
  assert.deepEqual(registered.other, [], "the plugin registers nothing else: no commands, hooks, channels or providers");
});
