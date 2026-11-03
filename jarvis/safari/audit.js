// Append-only audit trail of what Jarvis did in the browser. Never records filled values or page text.
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const AUDIT_PATH = join(homedir(), "Library", "Application Support", "Jarvis", "access-audit.jsonl");

// Query strings and fragments often carry tokens, so only origin + path are kept.
export function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "file:" || u.protocol === "about:" ? u.protocol + u.pathname : u.origin + u.pathname;
  } catch {
    return null;
  }
}

export function createAudit({ path = AUDIT_PATH, now = () => new Date() } = {}) {
  return {
    path,
    append({ action, url, selector, result, spend_ticket }) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
      const entry = { ts: now().toISOString(), tool: "safari", action, url: safeUrl(url), selector: selector ?? null, result, ...(spend_ticket && { spend_ticket }) };
      appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
      chmodSync(path, 0o600);
      return entry;
    },
  };
}
