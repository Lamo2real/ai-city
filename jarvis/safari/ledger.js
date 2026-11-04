// Read-only look at one ticket in the city ledger.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LEDGER_PATH = join(homedir(), ".jarvis", "ledger.db");

// → { from, to, status, ticket } or null (no file, no such ticket, unreadable).
export function readTicket(ticketId, path = LEDGER_PATH) {
  if (!ticketId || !existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT from_agent, to_agent, status, json FROM tickets WHERE id = ?").get(String(ticketId));
    return row ? { from: row.from_agent, to: row.to_agent, status: row.status, ticket: JSON.parse(row.json) } : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}
