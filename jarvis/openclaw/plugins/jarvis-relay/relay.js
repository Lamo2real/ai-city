// The one thing OpenClaw may do: hand the owner's words to Jarvis and bring back the reply.
// It uses Jarvis's relay route, in the shared `owner` conversation (fixed on the server). By the
// owner's decision that route has the HUD's rights; only his allowlisted Telegram account reaches it,
// and every relayed turn is audited. The relay token comes from the gateway's environment:
// bin/gateway reads it from Keychain item jarvis.openclaw-relay. It is never in config or logs.
export const DEFAULTS = { server: "http://127.0.0.1:7777" };
export const RELAY_PATH = "/api/relay/chat";
const MAX_MESSAGE = 20_000;

// The token only ever goes to Jarvis on this Mac.
function loopback(server) {
  let u;
  try { u = new URL(server); } catch { throw new Error("relay server is not a URL"); }
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) throw new Error("relay server must be Jarvis on this Mac (loopback)");
  return u.origin;
}

export async function askJarvis(config, message, fetchImpl = fetch, env = process.env) {
  const text = String(message ?? "").trim();
  if (!text) throw new Error("empty message");
  if (text.length > MAX_MESSAGE) throw new Error("message too long");
  const origin = loopback({ ...DEFAULTS, ...config }.server);
  const token = env.JARVIS_RELAY_TOKEN;
  if (!token) throw new Error("relay token missing: start the gateway with jarvis/openclaw/bin/gateway");
  const res = await fetchImpl(`${origin}${RELAY_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Jarvis answered ${res.status}`);
  return String(body.reply ?? "").trim();
}
