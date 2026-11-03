// The city: core agents, the Agent Factory and Registry, the Question &
// Instruction Bus, the review gate and the ledger, behind one interface for
// Jarvis: send_ticket in, questions and results out.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { AGENTS_DIR, loadCorePrompt, parsePrompt, renderTemplate, type AgentPrompt } from "./agents.ts";
import { now, openLedger, type AgentRow, type Question, type QuestionRow, type Ticket } from "./ledger.ts";
import { loadPolicy, type Policy } from "./policy.ts";
import { validate } from "./schemas.ts";
import type { JarvisTool, Runner, TurnResult } from "./sdk.ts";

export type CityEvent =
  | { type: "question"; id: string; question: Question; ticket_id: string }
  | { type: "result"; ticket_id: string; status: Ticket["status"]; summary: string; artifacts: string[] }
  | { type: "log"; text: string };

export interface CityOptions {
  runner: Runner;
  dataDir?: string;
  ledgerPath?: string;
  policy?: Policy;
  agentsDir?: string;
  log?: (line: string) => void;
}

export interface AgentSpec {
  id: string;
  role: string;
  kind: "manager" | "worker";
  department?: string;
  parent: string;
  model: string;
  effort?: "low" | "medium" | "high";
  mission: string;
  skills?: string[];
  tools: string[];
  lifecycle: "persistent" | "temporary";
  idle_retire_minutes?: number;
  budget_usd_per_day: number;
}

const CORE: Array<{ name: "jarvis" | "orchestrator" | "secretary" | "reviewer"; parent: string }> = [
  { name: "jarvis", parent: "owner" },
  { name: "orchestrator", parent: "jarvis" },
  { name: "secretary", parent: "orchestrator" },
  { name: "reviewer", parent: "orchestrator" },
];
const OWNER_SIDE = new Set(["owner", "jarvis"]);
const TERMINAL = new Set<Ticket["status"]>(["done", "failed", "cancelled"]);
const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

export function createCity(opts: CityOptions) {
  const dataDir = opts.dataDir ?? process.env.JARVIS_HOME ?? join(homedir(), ".jarvis");
  const agentsDir = opts.agentsDir ?? AGENTS_DIR;
  const policy = opts.policy ?? loadPolicy();
  const log = opts.log ?? (() => {});
  const ledger = openLedger(opts.ledgerPath ?? join(dataDir, "ledger.db"));
  const listeners = new Set<(e: CityEvent) => void>();
  const emit = (e: CityEvent) => { for (const fn of listeners) fn(e); };
  const prompts = new Map<string, AgentPrompt>();
  const queues = new Map<string, Promise<void>>();
  const pending = new Map<string, number>();
  const reminded = new Set<string>();
  const running = new Set<Promise<void>>();

  for (const { name, parent } of CORE) {
    const p = loadCorePrompt(name, agentsDir);
    prompts.set(name, p);
    if (!ledger.getAgent(name)) {
      ledger.putAgent({ id: name, role: p.name, kind: "core", parent, model: p.model, effort: p.effort, tools: p.tools, lifecycle: "persistent", state: "active", session_id: null, created_at: now(), last_active_at: now(), total_cost_usd: 0 });
    }
  }

  function agent(id: string): AgentRow {
    const a = ledger.getAgent(id);
    if (!a) throw new Error(`no agent ${id}`);
    return a;
  }

  function promptOf(a: AgentRow): AgentPrompt {
    let p = prompts.get(a.id);
    if (!p) {
      p = parsePrompt(readFileSync(a.prompt_path!, "utf8"));
      prompts.set(a.id, p);
    }
    return p;
  }

  // "App Manager › iOS Developer": the chain of roles below the Orchestrator.
  function pathOf(id: string): string {
    const roles: string[] = [];
    for (let a = ledger.getAgent(id); a && a.kind !== "core"; a = ledger.getAgent(a.parent)) roles.unshift(a.role);
    return roles.join(" › ") || agent(id).role;
  }

  function cwdFor(ticket?: Ticket): string {
    const dir = ticket?.scope?.find((s) => isAbsolute(s) && existsSync(s));
    if (dir) return dir;
    const work = join(dataDir, "work");
    mkdirSync(work, { recursive: true });
    return work;
  }

  // One turn at a time per agent: a message lands at a turn boundary, never mid-tool-call.
  function deliver(agentId: string, text: string, ticket?: Ticket, onText?: (t: string) => void): Promise<TurnResult> {
    const prev = queues.get(agentId) ?? Promise.resolve();
    pending.set(agentId, (pending.get(agentId) ?? 0) + 1);
    const run = prev.catch(() => {}).then(() => turn(agentId, text, ticket, onText));
    const done = run.then((r) => { pending.set(agentId, pending.get(agentId)! - 1); settle(agentId, r.text); }, () => { pending.set(agentId, pending.get(agentId)! - 1); });
    queues.set(agentId, done);
    running.add(done);
    done.finally(() => running.delete(done));
    return run;
  }

  async function turn(agentId: string, text: string, ticket?: Ticket, onText?: (t: string) => void): Promise<TurnResult> {
    const a = agent(agentId);
    const p = promptOf(a);
    log(`${agentId}: turn (${text.slice(0, 80).replace(/\s+/g, " ")})`);
    const result = await opts.runner({
      agentId, systemPrompt: p.body, model: a.model, effort: (a.effort as AgentPrompt["effort"]) ?? p.effort,
      // The prompt's own tools (report, ask_user, …) plus what the spec granted (Bash, Write, …).
      allowedTools: [...new Set([...p.tools, ...a.tools])], tools: toolsFor(agentId), prompt: text, resume: a.session_id, cwd: cwdFor(ticket), onText,
    });
    ledger.updateAgent(agentId, { session_id: result.sessionId, last_active_at: now() });
    ledger.addCost(agentId, ticket?.id ?? null, result.costUsd);
    return result;
  }

  function dispatch(ticket: Ticket, note = ""): void {
    const t = ledger.updateTicket(ticket.id, { status: "in_progress" });
    const label = t.kind === "direct_instruction" ? `[direct instruction from ${t.from}${t.cc?.length ? `, cc ${t.cc.join(", ")}` : ""}]` : `[ticket from ${t.from}]`;
    deliver(t.to, `${note}${label} ${JSON.stringify(t)}`, t).catch((err: Error) => {
      log(`${t.to}: turn failed: ${err.message}`);
      finish(t.id, "failed", `${t.to} could not finish: ${err.message}`, []);
    });
  }

  // When an agent's queue runs dry, a ticket of its that is neither reported, delegated nor
  // waiting on a question has been dropped: one reminder, then it fails with the agent's last words.
  // Coarse on purpose: models often leave parent_id out, and a false "dropped" costs more than a late reminder.
  const inFlight = (t: Ticket) => ledger.ticketsFrom(t.to).some((s) => !TERMINAL.has(s.status)) || ledger.openQuestions().some((q) => q.question.asked_by === t.to);
  function settle(agentId: string, lastWords: string): void {
    if (pending.get(agentId)) return;
    for (const t of ledger.inbox(agentId).filter((x) => x.to === agentId && x.status === "in_progress" && x.kind !== "direct_instruction" && !inFlight(x))) {
      if (reminded.has(t.id)) {
        log(`${agentId}: dropped ticket ${t.id}`);
        finish(t.id, "failed", `${agentId} ended its turn without reporting: ${lastWords.slice(0, 500)}`, []);
        continue;
      }
      reminded.add(t.id);
      deliver(agentId, `[reminder] Ticket ${t.id} is still open and nothing is in flight for it. Report on it now with the report tool (done or failed, with what happened), or delegate it with send_ticket.`, t)
        .catch((err: Error) => finish(t.id, "failed", `${agentId} could not finish: ${err.message}`, []));
    }
  }

  // Report → the ticket's sender hears about it. Jarvis's tickets go through the Secretary first.
  function finish(ticketId: string, status: Ticket["status"], summary: string, artifacts: string[]): void {
    const current = ledger.getTicket(ticketId);
    if (!current) throw new Error(`no ticket ${ticketId}`);
    if (TERMINAL.has(current.status) && current.status === status) return; // a repeat; a correction (failed → done) goes through
    const t = ledger.updateTicket(ticketId, { status, result: { ...current.result, summary: summary.slice(0, 800), artifacts } });
    if (TERMINAL.has(status)) retireIfDone(t.to);
    const report = `[report from ${t.to} on ticket ${t.id}] status: ${status}. ${summary}${artifacts.length ? ` Artifacts: ${artifacts.join(", ")}` : ""}`;
    if (!OWNER_SIDE.has(t.from)) {
      deliver(t.from, report, t).catch((err: Error) => log(`${t.from}: turn failed: ${err.message}`));
      return;
    }
    deliver("secretary", `[result for the owner's ticket ${t.id}] goal: ${t.goal}\n${report}`, t)
      .then((r) => emit({ type: "result", ticket_id: t.id, status, summary: r.text.trim() || summary, artifacts }))
      .catch((err: Error) => { log(`secretary failed: ${err.message}`); emit({ type: "result", ticket_id: t.id, status, summary, artifacts }); });
  }

  function retireIfDone(agentId: string): void {
    const a = ledger.getAgent(agentId);
    if (!a || a.kind === "core" || a.lifecycle !== "temporary" || a.state !== "active") return;
    if (ledger.inbox(agentId).length) return;
    ledger.updateAgent(agentId, { state: "retired" });
    log(`${agentId}: retired (temporary, work done)`);
    for (const child of ledger.children(agentId)) retireIfDone(child.id);
    retireIfDone(a.parent);
  }

  function sendTicket(from: string, input: Record<string, unknown>): Ticket {
    const draft = { id: newId("t"), status: "open", created_at: now(), kind: "task", ...input, from: typeof input.from === "string" && input.from ? input.from : from } as Record<string, unknown>;
    for (const k of Object.keys(draft)) if (draft[k] === undefined) delete draft[k];
    const ticket = validate<Ticket>("ticket", draft);
    agent(ticket.to);
    if (!ledger.putTicket(ticket)) return ledger.getTicket(ticket.id)!;
    if (ticket.kind === "direct_instruction" && OWNER_SIDE.has(ticket.from)) {
      // The owner's reply, relayed by Jarvis, is the answer to what that agent asked.
      for (const q of ledger.openQuestions().filter((o) => o.question.asked_by === ticket.to)) {
        ledger.answerQuestion(q.id, ticket.goal);
        const t = ledger.getTicket(q.question.ticket_id);
        if (t?.status === "waiting_on_owner") ledger.updateTicket(t.id, { status: "in_progress" });
      }
    }
    dispatch(ticket);
    return ticket;
  }

  function hire(by: string, input: Record<string, unknown>): AgentRow {
    const spec = validate<AgentSpec>("agent_spec", input);
    if (spec.parent !== by) throw new Error(`parent must be the hiring agent (${by})`);
    const existing = ledger.getAgent(spec.id);
    if (existing?.state === "active") throw new Error(`${spec.id} is already hired; find it with list_registry`);
    if (existing) {
      log(`${spec.id}: revived from the registry`);
      return ledger.updateAgent(spec.id, { state: "active", last_active_at: now() });
    }
    const active = ledger.agents("active").filter((a) => a.kind !== "core").length;
    if (active >= policy.caps.max_concurrent_agents) throw new Error(`cap reached: ${policy.caps.max_concurrent_agents} agents are already active. Retire one or reuse.`);
    if (spec.kind === "worker" && ledger.children(by).length >= policy.caps.max_workers_per_manager) throw new Error(`cap reached: ${policy.caps.max_workers_per_manager} workers per manager`);
    const department = spec.department ?? agent(by).department ?? "other";
    if (ledger.spendToday(department) >= policy.caps.daily_spend_usd_per_department) throw new Error(`cap reached: ${department} has spent today's budget`);
    // shortcut: tools are not checked against a per-department allowlist, policy.json has none yet; add one when departments get scopes.
    const text = spec.kind === "manager"
      ? renderTemplate("manager", { id: spec.id, department, mission: spec.mission, model: spec.model, tools_summary: spec.tools.join(", ") }, agentsDir)
      : renderTemplate("worker", { id: spec.id, specialty: spec.role, parent: by, tools: spec.tools.join(", ") }, agentsDir);
    const dir = join(dataDir, "agents");
    mkdirSync(dir, { recursive: true });
    const prompt_path = join(dir, `${spec.id}.md`);
    writeFileSync(prompt_path, text);
    prompts.delete(spec.id);
    const row: AgentRow = {
      id: spec.id, role: spec.role, kind: spec.kind, department, parent: by, model: spec.model, effort: spec.effort ?? "medium", tools: spec.tools, skills: spec.skills,
      lifecycle: spec.lifecycle, idle_retire_minutes: spec.idle_retire_minutes, state: "active", session_id: null, prompt_path, created_at: now(), last_active_at: now(), total_cost_usd: 0,
    };
    ledger.putAgent(row);
    log(`${spec.id}: hired by ${by} (${spec.kind}, ${department})`);
    return row;
  }

  function listRegistry(query: string): Array<Pick<AgentRow, "id" | "role" | "kind" | "department" | "parent" | "model" | "skills" | "lifecycle" | "state">> {
    const q = query.trim().toLowerCase();
    return ledger.agents()
      .filter((a) => a.kind !== "core")
      .filter((a) => !q || [a.id, a.role, a.department ?? "", ...(a.skills ?? [])].some((s) => s.toLowerCase().includes(q)))
      .map(({ id, role, kind, department, parent, model, skills, lifecycle, state }) => ({ id, role, kind, department, parent, model, skills, lifecycle, state }));
  }

  // Questions: the parent sees it first; only what it cannot answer reaches the owner.
  async function ask(by: string, input: Record<string, unknown>): Promise<{ id: string; answered_by?: string; answer?: string }> {
    const q = validate<Question>("question", { asked_by: by, path: pathOf(by), ...input });
    const ticket = ledger.getTicket(q.ticket_id);
    if (!ticket) throw new Error(`no ticket ${q.ticket_id}`);
    const texts = JSON.stringify(q.questions.map((x) => x.text));
    const dup = ledger.openQuestions().find((o) => o.question.ticket_id === q.ticket_id && o.question.asked_by === by && JSON.stringify(o.question.questions.map((x) => x.text)) === texts);
    if (dup) return { id: dup.id };
    const row: QuestionRow = { id: newId("q"), status: "open", question: q, created_at: now() };
    ledger.putQuestion(row);
    const parent = agent(by).parent;
    if (!OWNER_SIDE.has(parent)) {
      const r = await deliver(parent, `[question from ${by} on ticket ${q.ticket_id}] ${JSON.stringify(q.questions)}\nIf the ticket, the codebase or earlier decisions settle it, reply with only {"answers": ["...", ...]} (one per question). Otherwise reply with only {"escalate": true} and it goes to the owner.`, ticket);
      const answers = parseAnswers(r.text);
      if (answers) {
        const answer = answers.join(" | ");
        ledger.answerQuestion(row.id, answer);
        sendTicket(parent, { to: by, kind: "direct_instruction", goal: `Answer to your question (${row.id}): ${answer}`, parent_id: q.ticket_id });
        return { id: row.id, answered_by: parent, answer };
      }
    }
    if (q.blocking) ledger.updateTicket(q.ticket_id, { status: "waiting_on_owner" });
    emit({ type: "question", id: row.id, question: q, ticket_id: q.ticket_id });
    return { id: row.id };
  }

  function answer(questionId: string, text: string): Ticket {
    const q = ledger.getQuestion(questionId);
    if (!q) throw new Error(`no question ${questionId}`);
    if (q.status === "answered") throw new Error(`question ${questionId} is already answered`);
    ledger.answerQuestion(questionId, text);
    const t = ledger.getTicket(q.question.ticket_id);
    if (t?.status === "waiting_on_owner") ledger.updateTicket(t.id, { status: "in_progress" });
    const asker = agent(q.question.asked_by);
    return sendTicket("owner", { to: asker.id, cc: OWNER_SIDE.has(asker.parent) ? [] : [asker.parent], kind: "direct_instruction", goal: `Answer to your question (${questionId}): ${text}`, owner_words: text, parent_id: q.question.ticket_id });
  }

  // "@ios-dev use SwiftData" → a direct instruction to ios-dev, its manager cc'd.
  function instruct(text: string): Ticket | null {
    const m = /^\s*@([a-z][a-z0-9-]{2,40})\b[\s:,-]*([\s\S]+)$/.exec(text);
    if (!m) return null;
    const a = agent(m[1]);
    return sendTicket("owner", { to: a.id, cc: OWNER_SIDE.has(a.parent) ? [] : [a.parent], kind: "direct_instruction", goal: m[2].trim(), owner_words: text.trim() });
  }

  async function requestReview(by: string, ticketId: string, artifact: string): Promise<unknown> {
    const t = ledger.getTicket(ticketId);
    if (!t) throw new Error(`no ticket ${ticketId}`);
    ledger.updateTicket(ticketId, { status: "in_review", review_rounds: (t.review_rounds ?? 0) + 1 });
    const r = await deliver("reviewer", `[review request from ${by} for ticket ${ticketId}]\n${artifact}`, t);
    ledger.updateTicket(ticketId, { status: "in_progress" });
    return parseJson(r.text) ?? { verdict: "FAIL", findings: [], summary: `reviewer gave no JSON: ${r.text.slice(0, 300)}` };
  }

  function toolsFor(agentId: string): JarvisTool[] {
    const obj = z.record(z.string(), z.unknown());
    return [
      { name: "hire_agent", description: "Hire a manager or worker from an agent spec (schemas/agent_spec.schema.json). Reuse from list_registry first.", schema: { spec: obj }, handler: async ({ spec }) => hire(agentId, spec as Record<string, unknown>) },
      { name: "retire_agent", description: "Retire an agent you hired. It stays in the registry for reuse.", schema: { id: z.string() }, handler: async ({ id }) => { ledger.updateAgent(id as string, { state: "retired" }); return { retired: id }; } },
      { name: "list_registry", description: "Find existing agents by role, department, skill or id. Empty query lists all, retired ones included.", schema: { query: z.string() }, handler: async ({ query }) => listRegistry(query as string) },
      { name: "send_ticket", description: "Send a ticket (schemas/ticket.schema.json) to an agent. id, from, status and created_at are filled in if missing.", schema: { ticket: obj }, handler: async ({ ticket }) => sendTicket(agentId, ticket as Record<string, unknown>) },
      { name: "ask_user", description: "Ask the owner (schemas/question.schema.json). Your manager answers first if it can. Keep working on the default unless blocking.", schema: { question: obj }, handler: async ({ question }) => ask(agentId, question as Record<string, unknown>) },
      { name: "request_review", description: "Send an artifact (diff, plan, campaign, video notes) to the Reviewer Gate. Returns {verdict, findings, summary}.", schema: { ticket_id: z.string(), artifact: z.string() }, handler: async ({ ticket_id, artifact }) => requestReview(agentId, ticket_id as string, artifact as string) },
      { name: "report", description: "Report a ticket's outcome to whoever sent it.", schema: { ticket_id: z.string(), status: z.enum(["done", "failed"]), summary: z.string(), artifacts: z.array(z.string()) }, handler: async ({ ticket_id, status, summary, artifacts }) => { finish(ticket_id as string, status as Ticket["status"], summary as string, artifacts as string[]); return { ok: true }; } },
    ];
  }

  // After a restart: open questions are asked again, unfinished tickets go back to their agents.
  async function resume(): Promise<void> {
    for (const q of ledger.openQuestions()) emit({ type: "question", id: q.id, question: q.question, ticket_id: q.question.ticket_id });
    for (const t of ledger.ticketsByStatus("open", "in_progress", "in_review")) dispatch(t, "[resumed after a restart; continue where you left off] ");
  }

  async function idle(): Promise<void> {
    while (running.size) await Promise.allSettled([...running]);
  }

  return {
    ledger,
    sendTicket: (ticket: Record<string, unknown>) => sendTicket("jarvis", ticket),
    answer,
    instruct,
    toolsFor,
    promptOf: (id: string) => promptOf(agent(id)),
    agent,
    pathOf,
    on(fn: (e: CityEvent) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    resume,
    idle,
    openTickets: () => ledger.ticketsByStatus("open", "in_progress", "in_review", "waiting_on_owner"),
    close: () => ledger.close(),
  };
}

export type City = ReturnType<typeof createCity>;

function parseJson(text: string): Record<string, unknown> | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
}

function parseAnswers(text: string): string[] | null {
  const j = parseJson(text);
  return j && Array.isArray(j.answers) && j.answers.length ? j.answers.map(String) : null;
}
