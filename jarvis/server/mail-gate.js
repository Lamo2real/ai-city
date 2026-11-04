// Approval for emails to business contacts. The model and the CLI can only ASK: jarvis-mail registers a
// pending send here (token-guarded), and only the owner's own words, matched by this server, approve it.
// Same idea as merge.js: "I confirm the email" is matched on the owner's message, never on model text.
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { audit } from "../mail/audit.js";
import { redactTokens, scrubSecrets } from "./chat.js";
import { bearer, createTokenCheck } from "./token-check.js";

export const MAIL_GATE_SERVICE = "jarvis.mail-gate";
const TTL_MS = 30 * 60_000;
const MAX_BODY = 8 * 1024;
const ID_RE = /^[\w-]{8,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
// Channels that may approve. The plain-HTTP LAN browser never can, as with merges.
const CAN_APPROVE = new Set(["hud", "app", "telegram"]);

const normalise = (text) => String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
export const isEmailConfirm = (text) => normalise(text) === "i confirm the email";
export const isEmailCancel = (text) => normalise(text) === "cancel the email";

// One plain line with no quote or bracket characters, so a crafted subject or first line cannot close
// its delimiters and pass for the server's own words.
const oneLine = (v, max) => String(v ?? "").replace(/["“”„«»‹›]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const bare = (a) => (/<([^<>]+)>/.exec(String(a))?.[1] ?? String(a)).trim();

// What the owner HEARS must not contain the phrase: a speaker playing it could be picked up by the microphone.
export function spokenForm(text) {
  return String(text)
    .replace(/Say exactly: I confirm the email, or: Cancel the email\./g, "Say the email confirmation phrase to send it, or the email cancel phrase to drop it. The exact words are on screen.")
    .replace(/say exactly: I confirm\./gi, "say the confirmation phrase.");
}

// What the owner is told, built from the summary jarvis-mail REGISTERED, never from the model's words.
export function describeEmail(summary) {
  const who = [
    (summary.to ?? []).map(bare).join(", "),
    summary.cc?.length ? `cc ${summary.cc.map(bare).join(", ")}` : "",
    summary.bcc?.length ? `bcc ${summary.bcc.map(bare).join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return `email to ${oneLine(who, 300)}, subject "${oneLine(summary.subject, 200)}"`;
}
// The draft's recipients, subject and first lines come from the model and the mail it read: anything token-shaped in
// what the owner is told or shown is redacted here, at the source, and never reaches the HUD, the chat or a speaker.
const clean = (text) => redactTokens(scrubSecrets(text));
export function holdNotice(item) {
  const first = oneLine(item.summary.first_lines?.[0], 160);
  const why = (item.summary.why ?? []).map((w) => oneLine(w, 160)).join("; ") || "it needs your approval";
  return clean(`Email to ${describeEmail(item.summary).slice("email to ".length)}${first ? `, starts: «${first}»` : ""}, held because ${why}. Say exactly: I confirm the email, or: Cancel the email.`);
}

export function createMailGate({ dataDir, keychain, logger = () => {}, now = Date.now, ttlMs = TTL_MS, auditPath }) {
  const file = join(dataDir, "mail-pending.json");
  const items = new Map(); // confirm_id → { confirm_id, draft_hash, summary, status, expires, channel }
  const token = createTokenCheck({ keychain, service: MAIL_GATE_SERVICE, now, logger });

  function save() {
    const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify([...items.values()]), { mode: 0o600 });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  }
  function prune() {
    for (const [id, it] of items) if (it.expires <= now() || it.status === "used" || it.status === "cancelled") items.delete(id);
  }
  try {
    for (const it of JSON.parse(readFileSync(file, "utf8"))) items.set(it.confirm_id, it);
    prune();
  } catch { /* first run */ }

  const active = (status) => { prune(); return [...items.values()].filter((i) => i.status === status); };
  const record = (action, it, extra = {}) => {
    try { audit(action, { confirm_id: it.confirm_id, ...extra }, auditPath ? { path: auditPath, now: () => new Date(now()) } : undefined); } catch (err) { logger(`mail audit failed: ${err.message}`); }
  };

  // jarvis-mail asks. Only one email waits for an answer at a time: a newer request replaces the old one,
  // so "I confirm the email" always means the draft the owner was just shown.
  function register({ confirm_id, draft_hash, summary }) {
    if (!ID_RE.test(String(confirm_id)) || !HASH_RE.test(String(draft_hash)) || typeof summary !== "object" || summary === null) return false;
    prune();
    const existing = items.get(confirm_id);
    if (existing && existing.draft_hash === draft_hash && (existing.status === "pending" || existing.status === "approved")) return true;
    for (const it of items.values()) if (it.status === "pending") items.delete(it.confirm_id);
    items.set(confirm_id, { confirm_id, draft_hash, summary, status: "pending", announced: false, expires: now() + ttlMs });
    save();
    return true;
  }

  function approve(it, channel) {
    it.status = "approved";
    it.channel = channel;
    save();
    record("mail-approved", it, { approval_channel: channel });
    logger("email approved by the owner");
  }

  // The owner's whole message. Returns null (not about email), { reply } (answer directly) or
  // { forward } (approved: the model gets this fixed text instead and sends it by running the same command).
  function intercept(message, channel = "hud") {
    const confirm = isEmailConfirm(message);
    const cancel = !confirm && isEmailCancel(message);
    if (!confirm && !cancel) return null;
    const waiting = active("pending");
    if (cancel) {
      for (const it of waiting) { it.status = "cancelled"; record("mail-cancelled", it, { approval_channel: channel }); }
      if (waiting.length) save();
      return { reply: waiting.length ? "Cancelled, sir. The email was not sent." : "No email was waiting, sir." };
    }
    if (!CAN_APPROVE.has(channel)) return { reply: "An email to a business contact can only be confirmed on the Mac, in the Jarvis app or on Telegram, sir. Nothing was sent." };
    if (!waiting.length) return { reply: "No email is waiting for confirmation, sir." };
    const item = waiting[0];
    // Only the draft the owner was TOLD about can be approved. If a newer one slipped in since, tell him now
    // and approve nothing: his "I confirm the email" was about the draft he last heard.
    if (!item.announced) {
      item.announced = true;
      save();
      return { reply: `That is a different email from the one you were told about, so nothing was approved. ${holdNotice(item)}` };
    }
    approve(item, channel);
    return {
      forward: "[Jarvis server] The owner approved the pending email. Send it now by running exactly the same jarvis-mail command again.",
      note: clean(`Approved: ${describeEmail(item.summary)}.`),
    };
  }

  // The server-built notice for a waiting send the owner has not been told about yet. Marking it announced is
  // what makes it approvable. Called after every turn, including unprompted ones.
  function announce() {
    const fresh = active("pending").filter((i) => !i.announced);
    if (!fresh.length) return null;
    const item = fresh[fresh.length - 1];
    item.announced = true;
    save();
    return holdNotice(item);
  }

  // One atomic step for jarvis-mail: approved for exactly this hash? Then it is used up, whatever happens next.
  function redeem(confirm_id, draft_hash) {
    prune();
    const it = items.get(confirm_id);
    if (!it || it.status !== "approved" || it.draft_hash !== draft_hash) return { approved: false };
    it.status = "used";
    const { channel } = it;
    items.delete(confirm_id);
    save();
    return { approved: true, channel };
  }

  function approval(confirm_id, draft_hash) {
    prune();
    const it = items.get(confirm_id);
    return { approved: Boolean(it && it.status === "approved" && it.draft_hash === draft_hash), status: it && it.draft_hash === draft_hash ? it.status : "none" };
  }

  // ---- HTTP (the localhost route only) ----
  const json = (res, status, value) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(value));
  };
  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new Error("too large")); req.destroy(); } else chunks.push(c);
      });
      req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); } });
      req.on("error", reject);
    });
  }

  async function handle(req, res) {
    const { pathname, searchParams } = new URL(req.url, "http://localhost");
    const guarded = async () => Boolean(await token(bearer(req)));
    try {
      if (req.method === "POST" && pathname === "/api/mail/pending") {
        if (!(await guarded())) return json(res, 401, { error: "not authorised" });
        return register(await readJson(req)) ? json(res, 200, { ok: true }) : json(res, 400, { error: "bad request" });
      }
      if (req.method === "POST" && pathname === "/api/mail/redeem") {
        if (!(await guarded())) return json(res, 401, { error: "not authorised" });
        const { confirm_id, draft_hash } = await readJson(req);
        return json(res, 200, redeem(confirm_id, draft_hash));
      }
      if (req.method === "GET" && pathname.startsWith("/api/mail/approval/")) {
        if (!(await guarded())) return json(res, 401, { error: "not authorised" });
        return json(res, 200, approval(decodeURIComponent(pathname.slice("/api/mail/approval/".length)), searchParams.get("hash")));
      }
    } catch {
      return json(res, 400, { error: "bad request" });
    }
    return json(res, 404, { error: "not found" });
  }

  return { register, intercept, announce, redeem, approval, handle, pending: () => active("pending") };
}
