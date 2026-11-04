// The City View's event stream: everything that moves is one typed event, and a snapshot describes the rest.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { audit, auditPath, loadPolicy } from "../src/policy.ts";
import { createCity, type CityEvent } from "../src/runtime.ts";
import type { Runner, TurnRequest } from "../src/sdk.ts";
// A real session's total_cost_usd is cumulative; the fakes mimic that.
const totals = new Map<string, number>();
const cum = (id: string) => { const v = (totals.get(id) ?? 0) + 0.01; totals.set(id, v); return v; };

const policy = loadPolicy();
const use = (req: TurnRequest, name: string, args: Record<string, unknown>) => req.tools.find((t) => t.name === name)!.handler(args);
const spec = (id: string, kind: "manager" | "worker", parent: string, extra: Record<string, unknown> = {}) => ({ id, role: id, kind, parent, model: "claude-sonnet-5-5", mission: "m", tools: ["Read"], lifecycle: "temporary", budget_usd_per_day: 1, department: "IT", ...extra });

test("a hire, a ticket, a question, a review and a report each show up as typed events, with today's usage", async () => {
  const runner: Runner = async (req) => {
    if (req.agentId === "orchestrator" && req.prompt.startsWith("[ticket from jarvis]")) {
      const t = JSON.parse(req.prompt.slice(req.prompt.indexOf("{")));
      await use(req, "hire_agent", { spec: spec("it-manager", "manager", "orchestrator") });
      await use(req, "send_ticket", { ticket: { to: "it-manager", goal: "build", parent_id: t.id } });
    } else if (req.agentId === "it-manager" && req.prompt.startsWith("[ticket from orchestrator]")) {
      const t = JSON.parse(req.prompt.slice(req.prompt.indexOf("{")));
      await use(req, "ask_user", { question: { ticket_id: t.id, blocking: true, questions: [{ text: "Which repo?", default: "new" }] } });
    } else if (req.agentId === "it-manager" && req.prompt.startsWith("[direct instruction from owner")) {
      const t = JSON.parse(req.prompt.slice(req.prompt.indexOf("{")));
      const v = await use(req, "request_review", { ticket_id: t.parent_id, artifact: "diff" }) as { verdict: string };
      await use(req, "report", { ticket_id: t.parent_id, status: v.verdict === "PASS" ? "done" : "failed", summary: "built", artifacts: ["PR #1"] });
    } else if (req.agentId === "orchestrator" && req.prompt.startsWith("[report from it-manager")) {
      const id = /on ticket (\S+)\]/.exec(req.prompt)![1];
      await use(req, "report", { ticket_id: city.ledger.getTicket(id)!.parent_id!, status: "done", summary: "all done", artifacts: ["PR #1"] });
    }
    return { text: req.agentId === "reviewer" ? '{"verdict":"PASS","findings":[],"summary":"clean"}' : req.agentId === "secretary" ? "**Done:** built." : "", sessionId: `s-${req.agentId}`, costUsd: cum(req.agentId), tokens: 100 };
  };
  const city = createCity({ runner, dataDir: mkdtempSync(join(tmpdir(), "city-")), ledgerPath: ":memory:", policy });
  const events: CityEvent[] = [];
  city.on((e) => events.push(e));
  const ticket = city.sendTicket({ to: "orchestrator", goal: "feature" });
  await city.idle();
  const asked = events.find((e) => e.type === "question.asked");
  assert.ok(asked && asked.type === "question.asked");
  assert.equal(city.snapshot().questions.length, 1);
  assert.equal(city.snapshot().tickets.find((t) => t.to === "it-manager")?.status, "waiting_on_owner");
  city.answer(asked.id, "a new one");
  await city.idle();

  const types: string[] = events.map((e) => e.type);
  const order = (a: string, b: string) => assert.ok(types.indexOf(a) >= 0 && types.indexOf(a) < types.indexOf(b), `${a} before ${b}: ${types.join(" ")}`);
  order("ticket.status", "agent.hired");
  order("agent.hired", "question.asked");
  order("question.asked", "question.answered");
  order("question.answered", "review.started");
  order("review.started", "review.result");
  order("review.result", "agent.retired");
  order("agent.retired", "result");

  const hired = events.find((e) => e.type === "agent.hired");
  assert.ok(hired && hired.type === "agent.hired" && hired.agent.id === "it-manager" && hired.revived === false);
  const statuses = events.filter((e) => e.type === "ticket.status").map((e) => e.type === "ticket.status" && `${e.ticket.to}:${e.previous}→${e.ticket.status}`);
  assert.deepEqual(statuses.slice(0, 2), ["orchestrator:null→open", "orchestrator:open→in_progress"]);
  assert.ok(statuses.includes("it-manager:in_progress→waiting_on_owner"));
  assert.ok(statuses.includes("it-manager:waiting_on_owner→in_progress"));
  assert.ok(statuses.includes("it-manager:in_progress→in_review"));
  assert.ok(statuses.includes("it-manager:in_review→in_progress"));
  assert.ok(statuses.includes("orchestrator:in_progress→done"));
  const answered = events.find((e) => e.type === "question.answered");
  assert.deepEqual(answered, { type: "question.answered", id: asked.id, answer: "a new one", answered_by: "owner", ticket_id: asked.ticket_id });
  const review = events.find((e) => e.type === "review.result");
  assert.ok(review && review.type === "review.result" && review.verdict === "PASS" && review.round === 1);
  const costs = events.filter((e) => e.type === "cost.update");
  assert.ok(costs.length >= 5);
  const last = costs.at(-1)!;
  assert.ok(last.type === "cost.update" && last.tokens === 100 && last.today.tokens === costs.length * 100 && last.today.turns === costs.length);
  assert.deepEqual(city.snapshot().usage, last.type === "cost.update" ? last.today : null);
  assert.equal(city.snapshot().tickets.length, 0);
  assert.ok(city.snapshot().agents.some((a) => a.id === "it-manager" && a.state === "retired"));
  city.close();
});

test("audit lines carry the agent that acted", () => {
  const p = { ...policy, audit_log: join(mkdtempSync(join(tmpdir(), "audit-")), "audit.jsonl") };
  audit(p, "Bash", "allow", "", "py-dev");
  audit(p, "Bash", "deny", "no", undefined);
  const lines = readFileSync(auditPath(p), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].agent, "py-dev");
  assert.equal(lines[1].agent, undefined);
});
