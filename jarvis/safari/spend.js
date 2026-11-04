// Spend approvals. `--spend-ticket <id>` lets a payment action through only if the ledger holds a spend_approval
// ticket that the Orchestrator sent to Jarvis (status done), for the page's own origin, not expired, and unused.
// Using it records the id, so one approval buys one thing. The runtime stops anyone else creating such a ticket
// (city/src/runtime.ts: sendTicket).
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readTicket, LEDGER_PATH } from "./ledger.js";

export const USED_PATH = join(homedir(), "Library", "Application Support", "Jarvis", "spend-used.json");
const MAX_WINDOW_MS = 30 * 60 * 1000;

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// One writer at a time: the lock file is created exclusively, and a lock older than 10 s is stale.
function withLock(path, fn) {
  const lock = `${path}.lock`;
  for (let i = 0; ; i++) {
    try { closeSync(openSync(lock, "wx", 0o600)); break; } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try { if (Date.now() - statSync(lock).mtimeMs > 10_000) unlinkSync(lock); } catch { /* gone already */ }
      if (i >= 40) throw new Error("spend log is locked");
      nap(25);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* ignore */ } }
}

function readUsed(path) {
  try { return JSON.parse(readFileSync(path, "utf8")).used ?? {}; } catch { return {}; }
}

// Records the id as used. Returns false if it already was.
function consume(path, id, at) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withLock(path, () => {
    const used = readUsed(path);
    if (used[id]) return false;
    used[id] = at;
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ used }) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
    return true;
  });
}

export function createSpendCheck({ ledgerPath = LEDGER_PATH, usedPath = USED_PATH, now = Date.now } = {}) {
  // → { ok: true } (and the ticket is now spent) or { ok: false, reason }.
  return function authorize(ticketId, pageUrl, amount) {
    const found = readTicket(ticketId, ledgerPath);
    if (!found) return { ok: false, reason: "that ticket doesn't exist" };
    const { ticket } = found;
    if (ticket.kind !== "spend_approval" || found.to !== "jarvis" || found.from !== "orchestrator" || found.status !== "done") {
      return { ok: false, reason: "that isn't a spend approval from the orchestrator" };
    }
    const a = ticket.approval;
    const expires = Date.parse(a?.expires_at);
    const created = Date.parse(ticket.created_at);
    if (!a || !Number.isFinite(expires)) return { ok: false, reason: "that approval is incomplete" };
    if (expires <= now()) return { ok: false, reason: "that approval has expired" };
    if (!Number.isFinite(created) || expires - created > MAX_WINDOW_MS) return { ok: false, reason: "that approval is valid for too long" };
    const origin = originOf(pageUrl);
    if (!origin || origin !== a.origin) return { ok: false, reason: "that approval is for a different site" };
    const n = typeof amount === "string" && amount.trim() !== "" ? Number(amount) : amount;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return { ok: false, reason: "I need the amount with --amount" };
    if (!Number.isFinite(a.max_amount) || n > a.max_amount) return { ok: false, reason: "that amount is more than the approval allows" };
    if (!consume(usedPath, String(ticketId), new Date(now()).toISOString())) return { ok: false, reason: "that approval was already used" };
    return { ok: true, approval: a };
  };
}
