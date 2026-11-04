// Who may Jarvis email without asking? Everyone except business contacts. This module only CLASSIFIES;
// approval for a business send happens on the Jarvis server, on the owner's own words (see server/mail-gate.js).
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CODES, MailError } from "./errors.js";

export const CONTACTS_PATH = join(homedir(), "Library/Application Support/Jarvis/mail-contacts.json");

// Consumer mail providers. Anything else is a company or custom domain, which counts as business.
const CONSUMER = /^(gmail\.com|googlemail\.com|icloud\.com|me\.com|mac\.com|msn\.com|aol\.com|proton\.me|protonmail\.com|pm\.me|telia\.com|comhem\.se|bredband\.net|(outlook|hotmail|live|yahoo|gmx)\.[a-z]{2,3}(\.[a-z]{2})?)$/;
// A consumer address is still business when the thread or the draft reads like business.
const SIGNAL_WORDS = /\b(invoice|contract|quote|quotation|offer|purchase order|proposal|faktura|avtal|offert)\b/i;
const SIGNAL_TITLES = /\b(CEO|CTO|CFO|COO|VD|AB|Ltd|Inc|LLC|GmbH|Oy)\b/;

export const addressOf = (recipient) => (/<([^<>]+)>/.exec(recipient)?.[1] ?? recipient).trim().toLowerCase();

// ---- contacts ----

const ENTRY = /^(@[a-z0-9.-]+\.[a-z]{2,}|[^\s@<>,;]+@[a-z0-9.-]+\.[a-z]{2,})$/;
const cleanEntry = (e) => {
  const v = String(e ?? "").trim().toLowerCase();
  if (!ENTRY.test(v)) throw new MailError(CODES.BAD_REQUEST, `"${e}" is not an email address or an @domain.`);
  return v;
};

export function createContacts({ path = CONTACTS_PATH } = {}) {
  const read = () => {
    try {
      const j = JSON.parse(readFileSync(path, "utf8"));
      return { personal: [...(j.personal ?? [])], business: [...(j.business ?? [])] };
    } catch {
      return { personal: [], business: [] };
    }
  };
  function write(c) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  }
  return {
    list: read,
    add(entry, kind) {
      const e = cleanEntry(entry);
      const c = read();
      for (const k of ["personal", "business"]) c[k] = c[k].filter((x) => x !== e);
      c[kind].push(e);
      write(c);
      return c;
    },
    remove(entry) {
      const e = cleanEntry(entry);
      const c = read();
      for (const k of ["personal", "business"]) c[k] = c[k].filter((x) => x !== e);
      write(c);
      return c;
    },
  };
}

const listed = (list, address) => list.some((e) => e === address || (e.startsWith("@") && address.endsWith(e)));

// ---- classification ----

// → { business: boolean, why: ["addr → reason", ...] }. Order: own, personal list, business list, domain, unsure.
export function classify(recipients, { own = [], contacts = { personal: [], business: [] }, context = "" } = {}) {
  const ownSet = new Set(own.map((a) => a.toLowerCase()));
  const signal = SIGNAL_WORDS.test(context) || SIGNAL_TITLES.test(context);
  const why = [];
  for (const r of recipients) {
    const a = addressOf(r);
    const domain = /^[^\s@]+@([a-z0-9-]+(\.[a-z0-9-]+)+)$/.exec(a)?.[1];
    if (ownSet.has(a)) continue;
    if (listed(contacts.personal, a)) continue;
    if (listed(contacts.business, a)) { why.push(`${a} → on your business list`); continue; }
    if (!domain) { why.push(`${a} → not sure who this is`); continue; }
    if (!CONSUMER.test(domain)) { why.push(`${a} → company domain (${domain})`); continue; }
    if (signal) why.push(`${a} → personal mail provider, but the message reads like business`);
  }
  return { business: why.length > 0, why };
}

// ---- the exact draft ----

// SHA-256 over recipients + subject + body + attachments (+ thread headers). Any edit changes it.
export function draftHash({ to = [], cc = [], bcc = [], subject = "", body = "", attachments = [], threadId = "", inReplyTo = "", references = "" }) {
  const norm = (l) => l.map((a) => addressOf(a)).sort();
  return createHash("sha256").update(JSON.stringify({ to: norm(to), cc: norm(cc), bcc: norm(bcc), subject, body, attachments, threadId, inReplyTo, references })).digest("hex");
}

export const confirmIdFor = (hash) => `mail-${hash.slice(0, 24)}`;

export function summaryOf({ to = [], cc = [], bcc = [], subject = "", body = "" }, why) {
  const first_lines = String(body).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 3).map((l) => (l.length > 160 ? `${l.slice(0, 157)}...` : l));
  return { to, cc, bcc, subject, first_lines, why };
}
