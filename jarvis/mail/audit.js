// Every irreversible mail action leaves one JSON line: when, what, to whom, result. Never a body or a token.
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redact } from "./redact.js";

export const AUDIT_PATH = join(homedir(), "Library/Application Support/Jarvis/access-audit.jsonl");

export function audit(action, details, { path = AUDIT_PATH, now = () => new Date() } = {}) {
  const line = JSON.stringify(redact({ ts: now().toISOString(), tool: "mail", action, ...details }));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, line + "\n", { mode: 0o600 });
  chmodSync(dirname(path), 0o700);
  chmodSync(path, 0o600);
}
