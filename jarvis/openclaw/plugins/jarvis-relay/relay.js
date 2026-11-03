// The one thing OpenClaw may do: hand the owner's words to Jarvis and bring back the reply.
// Same route and session as the HUD's text box, so the phone is the same conversation.
export const DEFAULTS = { server: "http://127.0.0.1:7777", sessionId: "owner" };
const MAX_MESSAGE = 20_000;

export async function askJarvis(config, message, fetchImpl = fetch) {
  const text = String(message ?? "").trim();
  if (!text) throw new Error("empty message");
  if (text.length > MAX_MESSAGE) throw new Error("message too long");
  const { server, sessionId } = { ...DEFAULTS, ...config };
  const res = await fetchImpl(`${server.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text, sessionId, voice: false }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Jarvis answered ${res.status}`);
  return String(body.reply ?? "").trim();
}
