// Against a running gateway (JARVIS_OPENCLAW_URL=ws://127.0.0.1:18799, JARVIS_OPENCLAW_TOKEN=…):
// a connect without the token is refused, one with it is accepted. Skipped when no gateway is given,
// so `npm test` never starts the 270 MB gateway itself.
import assert from "node:assert/strict";
import { test } from "node:test";

const url = process.env.JARVIS_OPENCLAW_URL;
const token = process.env.JARVIS_OPENCLAW_TOKEN;

export function connectFrame(auth) {
  return { type: "req", id: "1", method: "connect", params: { minProtocol: 4, maxProtocol: 4, client: { id: "cli", version: "0.0.0", platform: "macos", mode: "cli" }, role: "operator", scopes: ["operator.read"], caps: [], commands: [], permissions: {}, auth, locale: "en-US", userAgent: "ai-city-test/0.0.0" } };
}

function connect(auth) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { ws.close(); resolve({ ok: null, note: "no answer in 5s" }); }, 5000);
    ws.onerror = () => {};
    ws.onopen = () => ws.send(JSON.stringify(connectFrame(auth)));
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === "res" && m.id === "1") { clearTimeout(t); ws.close(); resolve({ ok: m.ok, error: m.error?.message, payload: m.payload }); } };
    ws.onclose = (e) => { clearTimeout(t); resolve({ ok: false, error: `closed ${e.code} ${e.reason}` }); };
  });
}

test("the gateway refuses a connect without the token, with a wrong token, and accepts the right one", { skip: !url || !token ? "set JARVIS_OPENCLAW_URL and JARVIS_OPENCLAW_TOKEN against a running gateway" : false }, async () => {
  const none = await connect(undefined);
  assert.equal(none.ok, false, JSON.stringify(none));
  const wrong = await connect({ token: "not-the-token" });
  assert.equal(wrong.ok, false, JSON.stringify(wrong));
  const right = await connect({ token });
  assert.equal(right.ok, true, JSON.stringify(right));
  assert.equal(right.payload?.auth?.role ?? right.payload?.role ?? "operator", "operator");
});
