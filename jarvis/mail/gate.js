// jarvis-mail's side of the approval gate. It can only ASK the Jarvis server (register) and spend an approval
// that the owner gave there (redeem). There is no call here that approves anything.
import { CODES, MailError } from "./errors.js";

export const GATE_SERVICE = "jarvis.mail-gate";
const down = () => new MailError(CODES.API, "I can't reach the Jarvis server to ask for approval, so nothing was sent. Is Jarvis running?");

export function createGateClient({ keychain, fetch = globalThis.fetch, port = process.env.JARVIS_PORT ?? 7777 }) {
  const base = `http://127.0.0.1:${port}`;

  async function call(method, path, body) {
    const token = await keychain.get(GATE_SERVICE);
    if (!token) throw new MailError(CODES.NOT_CONFIGURED, "The mail approval token is missing. Run jarvis-mail setup.");
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body && { "Content-Type": "application/json" }) },
        ...(body && { body: JSON.stringify(body) }),
      });
    } catch {
      throw down();
    }
    if (res.status === 401) throw new MailError(CODES.NOT_CONFIGURED, "The Jarvis server did not accept the mail approval token. Restart Jarvis, or run jarvis-mail setup again.", { status: 401 });
    if (!res.ok) throw new MailError(CODES.API, `The Jarvis server refused the approval request (${res.status}). Nothing was sent.`, { status: res.status });
    return res.json();
  }

  return {
    register: (confirm_id, draft_hash, summary) => call("POST", "/api/mail/pending", { confirm_id, draft_hash, summary }),
    // Atomic: approved for exactly this hash → used up now. { approved, channel }
    redeem: (confirm_id, draft_hash) => call("POST", "/api/mail/redeem", { confirm_id, draft_hash }),
    approval: (confirm_id, draft_hash) => call("GET", `/api/mail/approval/${encodeURIComponent(confirm_id)}?hash=${draft_hash}`),
  };
}
