// The report per department, the lesson after each ticket, and retries reaching the ledger.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { departmentReport, formatReport } from "../src/measure.ts";
import { loadPolicy } from "../src/policy.ts";
import { createCity } from "../src/runtime.ts";
import type { Runner, TurnRequest } from "../src/sdk.ts";

const policy = { ...loadPolicy(), audit_log: join(mkdtempSync(join(tmpdir(), "audit-")), "audit.jsonl") };
const body = (req: TurnRequest) => JSON.parse(req.prompt.slice(req.prompt.indexOf('{"id"')));
const reporting = (status: (t: { goal: string }) => string, summary = "the disk was full"): Runner => async (req) => {
  if (req.prompt.includes('{"id"') && !req.prompt.startsWith("[report") && !req.prompt.startsWith("[result")) {
    const t = body(req);
    await req.tools.find((x) => x.name === "report")?.handler({ ticket_id: t.id, status: status(t), summary, artifacts: [] });
  }
  return { text: "", sessionId: `s-${req.agentId}`, costUsd: 0.5, tokens: 10, durationMs: 60_000 };
};
const cityWith = (runner: Runner) => { const data = mkdtempSync(join(tmpdir(), "city-")); return createCity({ runner, dataDir: data, ledgerPath: join(data, "l.db"), policy, sleep: async () => {} }); };

test("the report counts failures, fixes, review rounds, retries, cost and time per department, and finds what repeats", async () => {
  const city = cityWith(reporting((t) => (t.goal.startsWith("break") ? "failed" : "done")));
  const { manager } = city.createDepartment({ name: "Ops", mission: "operate" });
  for (const goal of ["break one", "break two", "fine"]) city.sendTicket({ to: manager, goal });
  await city.idle();
  const fix = city.sendTicket({ to: manager, goal: "again", kind: "fix" });
  await city.idle();
  city.ledger.updateTicket(fix.id, { review_rounds: 2, retries: 1 });
  const report = departmentReport(city.ledger);
  const ops = report.departments.find((d) => d.department === "Ops")!;
  assert.deepEqual([ops.tickets, ops.done, ops.failed, ops.fixes, ops.review_rounds, ops.retries], [4, 2, 2, 1, 2, 1]);
  assert.equal(ops.failure_rate, 0.5);
  assert.ok(ops.cost_usd > 0 && ops.busy_ms > 0);
  assert.ok(report.departments.some((d) => d.department === "HQ"), "core agents count as HQ, as in the cost report");
  assert.deepEqual(report.repeated.map((p) => [p.department, p.count, p.problem]), [["Ops", 2, "the disk was full"]]);
  assert.match(formatReport(report), /2x Ops: the disk was full/);
  assert.equal(departmentReport(city.ledger, { now: Date.now() + 30 * 86_400_000 }).departments.length, 0, "older than the window is out");
  city.close();
});

test("each finished or failed ticket leaves a short lesson in its department; a core agent's stays its own", async () => {
  const city = cityWith(reporting((t) => (t.goal.startsWith("break") ? "failed" : "done")));
  const { manager } = city.createDepartment({ name: "Ops", mission: "operate" });
  city.sendTicket({ to: manager, goal: "break the thing" });
  city.sendTicket({ to: manager, goal: "mend the thing" });
  city.sendTicket({ to: "orchestrator", goal: "plan the thing" });
  await city.idle();
  const lessons = city.ledger.db.prepare("SELECT scope, scope_id, text FROM memories WHERE kind = 'lesson'").all() as Array<{ scope: string; scope_id: string; text: string }>;
  assert.ok(lessons.some((l) => l.scope_id === "Ops" && /^Failed: .*break the thing.*the disk was full/.test(l.text)));
  assert.ok(lessons.some((l) => l.scope_id === "Ops" && /^Worked: .*mend the thing/.test(l.text)));
  assert.ok(lessons.some((l) => l.scope === "agent" && l.scope_id === "orchestrator"));
  city.close();
});

test("a lesson holding a secret is refused by the memory filter and the ticket still finishes", async () => {
  const lines: string[] = [];
  const data = mkdtempSync(join(tmpdir(), "city-"));
  const city = createCity({ runner: reporting(() => "failed", "it printed ghp_abcdefghijklmnopqrstuvwxyz123456"), dataDir: data, ledgerPath: join(data, "l.db"), policy, log: (l) => lines.push(l) });
  const { manager } = city.createDepartment({ name: "Ops", mission: "operate" });
  const t = city.sendTicket({ to: manager, goal: "leak" });
  await city.idle();
  assert.equal(city.ledger.getTicket(t.id)?.status, "failed");
  assert.equal((city.ledger.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE text LIKE '%ghp_%'").get() as { n: number }).n, 0);
  assert.ok(lines.some((l) => /no lesson kept/.test(l)) && !lines.some((l) => l.includes("ghp_")), "the log says so without repeating it");
  city.close();
});

test("a turn the gate ran again counts as a retry on its ticket", async () => {
  let calls = 0;
  const done = reporting(() => "done");
  const city = cityWith(async (req) => {
    if (req.prompt.includes('{"id"') && !req.prompt.startsWith("[result") && calls++ === 0) throw new Error("529 overloaded");
    return done(req);
  });
  const { manager } = city.createDepartment({ name: "Ops", mission: "operate" });
  const t = city.sendTicket({ to: manager, goal: "flaky" });
  await city.idle();
  assert.equal(city.ledger.getTicket(t.id)?.status, "done");
  assert.equal(city.ledger.getTicket(t.id)?.retries, 1);
  city.close();
});
