// Scrubs Gmail secrets from anything that might reach a log, an error or a report.
const MASK = "[REDACTED]";
const FIELDS = ["access_token", "refresh_token", "code_verifier", "client_id", "client_secret", "id_token", "authorization", "code"];
const FIELD_RE = FIELDS.join("|");
const secrets = new Set();

export function addSecret(s) {
  if (typeof s === "string" && s.length >= 8) secrets.add(s);
}

const PATTERNS = [
  [/Bearer\s+[^\s"',;]+/gi, `Bearer ${MASK}`],
  // JSON: "access_token":"x" (also with escaped quotes inside a JSON string)
  [new RegExp(`(\\\\?["'](?:${FIELD_RE})\\\\?["']\\s*:\\s*)(\\\\?")(?:\\\\.|[^"\\\\])*\\\\?"`, "gi"), `$1$2${MASK}$2`],
  // query strings and form bodies: access_token=x&...
  [new RegExp(`(?<![\\w-])((?:${FIELD_RE})=)[^&\\s"']*`, "gi"), `$1${MASK}`],
];

function redactString(str) {
  let out = str;
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  for (const s of secrets) out = out.split(s).join(MASK);
  return out;
}

function redactError(err, seen) {
  const copy = { name: err.name, message: redactString(String(err.message)) };
  // An error's own `code` is its stable identifier, not an OAuth code.
  for (const k of Object.keys(err)) copy[k] = walk(err[k], seen, k === "code" ? undefined : k);
  if (err.stack) copy.stack = redactString(String(err.stack));
  if (err.cause !== undefined) copy.cause = walk(err.cause, seen);
  return copy;
}

function walk(value, seen, key) {
  // The truncated display form of a client ID ("123456…") is not the secret.
  if (key === "client_id" && /^.{1,8}…$/.test(value)) return value;
  if (key && FIELDS.includes(key.toLowerCase()) && value != null) return MASK;
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Error) return redactError(value, seen);
  if (Array.isArray(value)) return value.map((v) => walk(v, seen));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = walk(v, seen, k);
  return out;
}

export function redact(value) {
  return walk(value, new WeakSet());
}
