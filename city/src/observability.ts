// What is true right now, from the ledger and real probes. Nothing here is a guess: an integration
// that was not checked says "unknown", and a probe never reads a secret's value.
import { execFile } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AgentRow, Ledger, Ticket } from "./ledger.ts";

const run = promisify(execFile);
export const INTEGRATIONS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "integrations.json");

// ---- trace: one line per city event, so a ticket's whole story can be read back
const ticketOf = (e: Record<string, unknown>): string | null => (e.ticket as Ticket | undefined)?.id ?? (e.ticket_id as string | null | undefined) ?? null;
export function createTrace(path: string) {
  let ready = false;
  return {
    write(event: Record<string, unknown>): void {
      if (event.type === "log" || event.type === "agent.activity") return; // activity can hold command text, and the audit log has the history
      if (!ready) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); ready = true; }
      const fresh = !existsSync(path);
      appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
      if (fresh) chmodSync(path, 0o600);
    },
    // A ticket and everything split from it, oldest first. shortcut: reads the whole file; rotate it if it passes a few hundred MB.
    forTicket(id: string, ledger: Pick<Ledger, "getTicket">, limit = 400): Array<Record<string, unknown>> {
      if (!existsSync(path)) return [];
      const family = new Set([id]);
      const out: Array<Record<string, unknown>> = [];
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        let e: Record<string, unknown>;
        try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; } // a torn last line
        const t = ticketOf(e);
        if (!t) continue;
        const parent = (e.ticket as Ticket | undefined)?.parent_id ?? ledger.getTicket(t)?.parent_id;
        if (parent && family.has(parent)) family.add(t);
        if (family.has(t)) out.push(e);
      }
      return out.slice(-limit);
    },
  };
}

// ---- workforce
export function workforce(ledger: Ledger) {
  const workers = ledger.agents().filter((a) => a.kind === "worker");
  const tickets = ledger.db.prepare("SELECT json FROM tickets").all().map((r) => JSON.parse(String((r as { json: string }).json)) as Ticket);
  const stat = (a: AgentRow) => {
    const mine = tickets.filter((t) => t.to === a.id && t.kind !== "direct_instruction");
    const done = mine.filter((t) => t.status === "done"), failed = mine.filter((t) => t.status === "failed");
    const times = done.map((t) => Date.parse(t.updated_at ?? t.created_at) - Date.parse(t.created_at)).filter((n) => n > 0).sort((x, y) => x - y);
    const busy = ledger.db.prepare("SELECT COALESCE(SUM(duration_ms), 0) AS ms FROM costs WHERE agent_id = ?").get(a.id) as { ms: number };
    return {
      id: a.id, role: a.role, department: a.department ?? null, state: a.worker_state ?? (a.state === "retired" ? "released" : "unknown"), executor: a.executor ?? "sdk", model: a.model,
      assignment: mine.find((t) => !["done", "failed", "cancelled"].includes(t.status))?.goal.slice(0, 120) ?? null,
      completed: done.length, failed: failed.length,
      success_rate: done.length + failed.length ? done.length / (done.length + failed.length) : null,
      median_completion_ms: times.length ? times[Math.floor(times.length / 2)] : null,
      busy_ms: busy.ms, cost_usd: a.total_cost_usd ?? 0,
    };
  };
  const rows = workers.map(stat);
  const count = (s: string[]) => rows.filter((r) => s.includes(r.state)).length;
  return {
    totals: { hired_ever: rows.length, active: workers.filter((a) => a.state === "active").length, working: count(["working"]), in_review: count(["review"]), blocked: count(["blocked"]), released: count(["released"]), failed: count(["failed"]) },
    workers: rows,
  };
}

// ---- health
export function health(ledger: Ledger, gate: { paused: number; active: number; waiting: number }, staleHours = 1) {
  const open = ledger.ticketsByStatus("open", "in_progress", "in_review");
  const day = new Date().toISOString().slice(0, 10);
  const staleBefore = Date.now() - staleHours * 3_600_000;
  const failedToday = (ledger.db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status = 'failed' AND updated_at >= ?").get(day) as { n: number }).n;
  const last = ledger.db.prepare("SELECT ts FROM costs ORDER BY id DESC LIMIT 1").get() as { ts: string } | undefined;
  return {
    paused_until: gate.paused ? new Date(gate.paused).toISOString() : null,
    turns_running: gate.active, turns_waiting: gate.waiting,
    tickets_open: open.length,
    tickets_stale: open.filter((t) => Date.parse(t.updated_at ?? t.created_at) < staleBefore && gate.active === 0).map((t) => t.id),
    tickets_parked: ledger.ticketsByStatus("parked").length,
    tickets_waiting_on_owner: ledger.ticketsByStatus("waiting_on_owner").length,
    failed_today: failedToday,
    last_model_turn: last?.ts ?? null,
    active_agents: ledger.agents("active").filter((a) => a.kind !== "core").length,
  };
}

// ---- integrations: "operational" means a real probe answered, never that a config entry exists
export type IntegrationStatus = "operational" | "authenticated" | "available" | "unavailable" | "needs_owner" | "unknown";
export interface IntegrationDef { name: string; category: string; check: { command?: string[]; bin?: string; keychain?: string; mcp?: string; port?: number }; note?: string }
export interface IntegrationState extends IntegrationDef { status: IntegrationStatus; detail: string }

type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
const realExec: Exec = (cmd, args) => run(cmd, args, { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });

export async function probeIntegrations(defs: IntegrationDef[], exec: Exec = realExec, connect: (port: number) => Promise<boolean> = () => Promise.resolve(false)): Promise<IntegrationState[]> {
  // One `claude mcp list` covers every MCP entry.
  let mcp = "";
  if (defs.some((d) => d.check.mcp)) { try { mcp = (await exec("claude", ["mcp", "list"])).stdout; } catch { mcp = ""; } }
  return Promise.all(defs.map(async (d): Promise<IntegrationState> => {
    const say = (status: IntegrationStatus, detail: string) => ({ ...d, status, detail });
    try {
      if (d.check.mcp) {
        const line = mcp.split("\n").find((l) => l.toLowerCase().includes(d.check.mcp!.toLowerCase()));
        if (!line) return say("unavailable", "not configured as an MCP server");
        if (/✔|connected/i.test(line) && !/needs auth/i.test(line)) return say("operational", "MCP server connected");
        if (/needs auth/i.test(line)) return say("needs_owner", "MCP server needs the owner to sign in");
        return say("unavailable", "MCP server failed to connect");
      }
      if (d.check.keychain) {
        // Without -w this prints metadata only; the value is never read.
        try { await exec("security", ["find-generic-password", "-s", d.check.keychain]); } catch { return say("needs_owner", `Keychain item ${d.check.keychain} is missing`); }
        if (!d.check.command && !d.check.port) return say("authenticated", "credential present, not exercised");
      }
      if (d.check.port) return (await connect(d.check.port)) ? say("operational", `listening on ${d.check.port}`) : say("available", `nothing listening on ${d.check.port}`);
      if (d.check.command) {
        try { await exec(d.check.command[0], d.check.command.slice(1)); return say("operational", `${d.check.command.join(" ")} succeeded`); }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return say("unavailable", `${d.check.command[0]} is not installed`);
          return say("needs_owner", `${d.check.command.join(" ")} failed`);
        }
      }
      if (d.check.bin) {
        try { await exec("which", [d.check.bin]); return say("available", `${d.check.bin} is installed`); } catch { return say("unavailable", `${d.check.bin} is not installed`); }
      }
      return say("unknown", "no check defined");
    } catch (err) {
      return say("unknown", (err as Error).message.slice(0, 120));
    }
  }));
}

export function loadIntegrations(path = INTEGRATIONS_PATH): IntegrationDef[] {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as IntegrationDef[] : [];
}
