// Builds outgoing mail: UTF-8 body as base64, RFC 2047 subjects, reply/forward headers, base64url "raw".
import { CODES, MailError } from "./errors.js";

const ADDRESS_RE = /^(?:[^<>\r\n,;"]*<[^\s<>,;@]+@[^\s<>,;@]+>|[^\s<>,;"@]+@[^\s<>,;"@]+)$/;
const bad = (m) => new MailError(CODES.BAD_REQUEST, m);

export function checkHeader(name, value) {
  if (/[\r\n]/.test(value)) throw bad(`${name} must not contain line breaks.`);
  return value;
}

// "a@x.com, B <b@x.com>" → validated list. Display names must be plain ASCII.
export function addressList(name, value) {
  const list = (Array.isArray(value) ? value : String(value ?? "").split(",")).map((s) => s.trim()).filter(Boolean);
  for (const a of list) {
    checkHeader(name, a);
    if (!ADDRESS_RE.test(a) || /[^\x20-\x7e]/.test(a)) throw bad(`"${a}" is not a valid email address for ${name}.`);
  }
  return list;
}

// RFC 2047 encoded-words of at most 45 UTF-8 bytes each, never splitting a character.
export function encodeSubject(subject) {
  checkHeader("Subject", subject);
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const words = [];
  let chunk = "";
  for (const ch of subject) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}

const wrap76 = (b64) => b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();

export function buildMime({ to, cc, bcc, subject, body, inReplyTo, references }) {
  const toList = addressList("To", to);
  if (!toList.length) throw bad("A recipient is needed.");
  const headers = [`To: ${toList.join(", ")}`];
  const ccList = addressList("Cc", cc);
  const bccList = addressList("Bcc", bcc);
  if (ccList.length) headers.push(`Cc: ${ccList.join(", ")}`);
  if (bccList.length) headers.push(`Bcc: ${bccList.join(", ")}`);
  headers.push(`Subject: ${encodeSubject(subject ?? "")}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${checkHeader("In-Reply-To", inReplyTo)}`);
  if (references) headers.push(`References: ${checkHeader("References", references)}`);
  headers.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64");
  const text = String(body ?? "").replace(/\r?\n/g, "\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${wrap76(Buffer.from(text).toString("base64"))}\r\n`;
}

export const toRaw = (mime) => Buffer.from(mime).toString("base64url");

const withPrefix = (prefix, subject) => (new RegExp(`^${prefix}:`, "i").test(subject) ? subject : `${prefix}: ${subject}`);
const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

// Reply headers from the original message (metadata is enough). `self` is the owner's address, dropped from Reply All.
export function replyFields(original, { all = false, self = "" } = {}) {
  const messageId = header(original, "Message-ID");
  const to = header(original, "Reply-To") || header(original, "From");
  let cc = [];
  let toList = [to];
  if (all) {
    const others = [...header(original, "To").split(","), ...header(original, "Cc").split(",")].map((s) => s.trim()).filter(Boolean);
    cc = others.filter((a) => !self || !a.toLowerCase().includes(self.toLowerCase()));
    toList = [to];
  }
  const refs = [header(original, "References"), messageId].filter(Boolean).join(" ");
  return {
    to: toList,
    cc,
    subject: withPrefix("Re", header(original, "Subject")),
    inReplyTo: messageId,
    references: refs,
    threadId: original.threadId,
  };
}

export function forwardSubject(original) {
  return withPrefix("Fwd", header(original, "Subject"));
}
