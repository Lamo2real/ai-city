// Read-only look at the city ledger: is this spend ticket a finished approval from the orchestrator?
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LEDGER_PATH = join(homedir(), ".jarvis", "ledger.db");

export function createLedgerCheck({ path = LEDGER_PATH } = {}) {
  return function isApproved(ticketId) {
    if (!ticketId || !existsSync(path)) return false;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare("SELECT from_agent, status FROM tickets WHERE id = ?").get(String(ticketId));
      return row?.from_agent === "orchestrator" && row?.status === "done";
    } catch {
      return false;
    } finally {
      db.close();
    }
  };
}
