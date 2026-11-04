// What the city has learned about itself: a report per department from the ledger, and the short
// lesson kept after each ticket. No model call in either. Dollar figures are estimates, not charges.
import { homedir } from "node:os";
import { join } from "node:path";
import { openLedger, type AgentRow, type Ledger, type Ticket } from "./ledger.ts";
import type { MemoryScope } from "./memory.ts";

export interface DepartmentRow { department: string; tickets: number; done: number; failed: number; cancelled: number; open: number; failure_rate: number | null; retries: number; fixes: number; review_rounds: number; cost_usd: number; busy_ms: number; median_ticket_ms: number | null }
export interface Repeated { department: string; problem: string; count: number; tickets: string[] }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const duration = (t: Ticket) => Date.parse(t.updated_at ?? t.created_at) - Date.parse(t.created_at);
// The same problem twice reads the same once its ids and numbers are gone.
const problemKey = (s: string) => s.toLowerCase().replace(/\b[\w]*-[0-9a-f]{8,}\b/g, "#").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 100);

export function departmentReport(ledger: Ledger, { days = 7, now = Date.now() }: { days?: number; now?: number } = {}) {
  const since = new Date(now - days * 86_400_000).toISOString();
  const agents = new Map(ledger.agents().map((a) => [a.id, a]));
  const deptOf = (id: string) => agents.get(id)?.department ?? "HQ"; // core agents, as in the cost report
  const rows = new Map<string, DepartmentRow>();
  const row = (department: string) => {
    let r = rows.get(department);
    if (!r) rows.set(department, r = { department, tickets: 0, done: 0, failed: 0, cancelled: 0, open: 0, failure_rate: null, retries: 0, fixes: 0, review_rounds: 0, cost_usd: 0, busy_ms: 0, median_ticket_ms: null });
    return r;
  };
  const times = new Map<string, number[]>();
  const problems = new Map<string, Repeated>();
  const seen = (department: string, text: string, id: string) => {
    const key = `${department}\n${problemKey(text)}`;
    const p = problems.get(key) ?? { department, problem: clip(text, 200), count: 0, tickets: [] };
    p.count++;
    if (p.tickets.length < 3) p.tickets.push(id);
    problems.set(key, p);
  };
  const tickets = ledger.db.prepare("SELECT json FROM tickets WHERE updated_at >= ?").all(since).map((r) => JSON.parse(String((r as { json: string }).json)) as Ticket);
  for (const t of tickets) {
    const department = deptOf(t.to), r = row(department);
    r.tickets++;
    if (t.status === "done") { r.done++; (times.get(department) ?? times.set(department, []).get(department)!).push(duration(t)); }
    else if (t.status === "failed") { r.failed++; seen(department, t.result?.summary ?? "failed without a summary", t.id); }
    else if (t.status === "cancelled") r.cancelled++;
    else r.open++;
    r.retries += t.retries ?? 0;
    r.review_rounds += t.review_rounds ?? 0;
    if (t.kind === "fix") { r.fixes++; seen(department, t.goal, t.id); }
  }
  for (const c of ledger.db.prepare("SELECT agent_id, COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(duration_ms), 0) AS ms FROM costs WHERE ts >= ? GROUP BY agent_id").all(since) as unknown as Array<{ agent_id: string; usd: number; ms: number }>) {
    const r = row(deptOf(c.agent_id));
    r.cost_usd += c.usd;
    r.busy_ms += c.ms;
  }
  for (const r of rows.values()) {
    const ended = r.done + r.failed;
    r.failure_rate = ended ? r.failed / ended : null;
    const ms = (times.get(r.department) ?? []).sort((a, b) => a - b);
    r.median_ticket_ms = ms.length ? ms[Math.floor(ms.length / 2)] : null;
  }
  return {
    since, days, estimated: true,
    departments: [...rows.values()].sort((a, b) => b.failed - a.failed || b.cost_usd - a.cost_usd),
    repeated: [...problems.values()].filter((p) => p.count >= 2).sort((a, b) => b.count - a.count).slice(0, 10),
  };
}

// A core agent's lesson stays with it: department memory is the scope its readers can see, and core agents have none.
export function lessonFor(t: Ticket, a: AgentRow, usd: number): { scope: MemoryScope; scope_id: string; kind: string; text: string } {
  const rounds = t.review_rounds ? `, ${t.review_rounds} review rounds` : "";
  const retries = t.retries ? `, ${t.retries} retries` : "";
  const took = `${Math.max(1, Math.round(duration(t) / 60_000))} min, about $${usd.toFixed(2)}${rounds}${retries}`;
  const text = `${t.status === "failed" ? "Failed" : "Worked"}: ${a.role} on "${clip(t.goal, 120)}" (${took}): ${clip(t.result?.summary ?? "no summary", 300)}`;
  return a.kind === "core" ? { scope: "agent", scope_id: a.id, kind: "lesson", text } : { scope: "department", scope_id: a.department ?? "other", kind: "lesson", text };
}

const minutes = (ms: number | null) => (ms === null ? "-" : `${(ms / 60_000).toFixed(1)}m`);
export function formatReport(report: ReturnType<typeof departmentReport>): string {
  const head = ["department", "tickets", "done", "failed", "retries", "fixes", "reviews", "est. $", "busy", "median"];
  const body = report.departments.map((r) => [r.department, r.tickets, r.done, r.failed, r.retries, r.fixes, r.review_rounds, r.cost_usd.toFixed(2), minutes(r.busy_ms), minutes(r.median_ticket_ms)].map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const repeated = report.repeated.map((p) => `  ${p.count}x ${p.department}: ${p.problem}`);
  return [`The last ${report.days} days. Dollar figures are estimates at API list prices, not charges.`, line(head), ...body.map(line), ...(repeated.length ? ["Repeated problems:", ...repeated] : ["No repeated problems."])].join("\n");
}

// jarvis report [--days N] [--json]
export function reportCli(argv: string[]): number {
  const at = argv.indexOf("--days");
  const days = at >= 0 ? Number(argv[at + 1]) : 7;
  if (!(days > 0)) { console.error("usage: jarvis report [--days N] [--json]"); return 2; }
  const ledger = openLedger(join(process.env.JARVIS_HOME ?? join(homedir(), ".jarvis"), "ledger.db"));
  const report = departmentReport(ledger, { days });
  ledger.close();
  console.log(argv.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
  return 0;
}
