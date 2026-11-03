// The City View's state: what the scene draws, as plain data. Pure functions, no DOM, no three.js,
// so the event → state step is unit-tested in Node. The scene reads this; it never reads the server.

export const MODEL_COLOR = {
  "claude-haiku-5-5": "#ffd21e",
  "claude-opus-5-5": "#3b82ff",
  "claude-sonnet-5-5": "#2fd36b",
  "claude-fable-5-1": "#a86bff",
};
export const MODEL_NAME = { "claude-haiku-5-5": "Haiku", "claude-opus-5-5": "Opus", "claude-sonnet-5-5": "Sonnet", "claude-fable-5-1": "Fable" };
export const DEPT_COLOR = { HQ: "#3b82ff", IT: "#4cc9f0", App: "#ff7a45", Cloud: "#8ecae6", Marketing: "#f72585", Video: "#b5179e", Travel: "#06d6a0", other: "#9aa0a6" };
export const CORE = new Set(["jarvis", "orchestrator", "secretary", "reviewer"]);
export const TOOL_PROP = [["ios|swift|app", "laptop"], ["video|film|camera", "camera"], ["market|ads|growth", "chart"], ["cloud|infra|terraform|devops", "wrench"], ["travel|flight|hotel", "ticket"], ["qa|test", "clipboard"], [".", "laptop"]];
export const FEED_MAX = 40;
const RECENT_MS = { done: 6000, review_fail: 20000, hired: 4000, retired: 4000 };

export function initialState(now = Date.now()) {
  return { agents: {}, tickets: {}, questions: {}, departments: {}, reviews: {}, costs: {}, usage: null, spend: {}, feed: [], recent: {}, now };
}

export const deptOf = (agent) => (agent.id === "jarvis" || CORE.has(agent.id) ? "HQ" : agent.department || "other");
export const deptColor = (name) => DEPT_COLOR[name] ?? DEPT_COLOR.other;
export function propFor(agent) {
  if (agent.kind !== "worker") return null;
  const text = `${agent.role} ${agent.id} ${(agent.skills ?? []).join(" ")}`.toLowerCase();
  return TOOL_PROP.find(([re]) => new RegExp(re).test(text))[1];
}

function touch(state, department, now) {
  if (department === "HQ" || state.departments[department]) return state.departments;
  return { ...state.departments, [department]: { name: department, builtAt: now } };
}

function feed(state, text, kind, now) {
  return [{ at: now, text, kind }, ...state.feed].slice(0, FEED_MAX);
}

export function applySnapshot(state, snap, now = Date.now()) {
  const next = { ...initialState(now), feed: state.feed };
  for (const a of snap.agents ?? []) {
    next.agents[a.id] = a;
    next.departments = touch(next, deptOf(a), now - 60000); // already built: no construction animation
  }
  for (const t of snap.tickets ?? []) next.tickets[t.id] = t;
  for (const q of snap.questions ?? []) next.questions[q.id] = q;
  next.usage = snap.usage ?? null;
  next.spend = snap.spend ?? {};
  return next;
}

// One event in, a new state out. Unknown events change nothing.
export function reduce(state, event, now = Date.now()) {
  switch (event.type) {
    case "agent.hired": {
      const a = event.agent;
      return { ...state, now, agents: { ...state.agents, [a.id]: a }, departments: touch(state, deptOf(a), now), recent: { ...state.recent, [a.id]: { kind: "hired", at: now } }, feed: feed(state, `${a.role} ${event.revived ? "is back" : "hired"} in ${deptOf(a)}`, "hire", now) };
    }
    case "agent.retired": {
      const a = state.agents[event.id];
      if (!a) return state;
      return { ...state, now, agents: { ...state.agents, [a.id]: { ...a, state: "retired" } }, recent: { ...state.recent, [a.id]: { kind: "retired", at: now } }, feed: feed(state, `${a.role} retired`, "retire", now) };
    }
    case "ticket.status": {
      const t = event.ticket;
      const tickets = { ...state.tickets };
      const terminal = ["done", "failed", "cancelled"].includes(t.status);
      if (terminal) delete tickets[t.id]; else tickets[t.id] = t;
      const recent = terminal ? { ...state.recent, [t.to]: { kind: t.status, at: now } } : state.recent;
      const text = event.previous === null ? `${t.to} got a ticket: ${t.goal.slice(0, 60)}` : `${t.to}: ${event.previous} → ${t.status}`;
      return { ...state, now, tickets, recent, feed: feed(state, text, t.status, now) };
    }
    case "question.asked": {
      return { ...state, now, questions: { ...state.questions, [event.id]: { id: event.id, status: "open", question: event.question, created_at: new Date(now).toISOString() } }, feed: feed(state, `${event.question.path} asks: ${event.question.questions[0]?.text ?? ""}`, "question", now) };
    }
    case "question.answered": {
      const questions = { ...state.questions };
      delete questions[event.id];
      return { ...state, now, questions, feed: feed(state, `${event.answered_by} answered: ${event.answer.slice(0, 60)}`, "answer", now) };
    }
    case "review.started": {
      const t = state.tickets[event.ticket_id];
      return { ...state, now, reviews: { ...state.reviews, [event.ticket_id]: { round: event.round, verdict: null, at: now, agent: t?.to ?? null } }, feed: feed(state, `Inspector at ${t?.to ?? event.ticket_id}'s door (round ${event.round})`, "review", now) };
    }
    case "review.result": {
      const prev = state.reviews[event.ticket_id];
      return { ...state, now, reviews: { ...state.reviews, [event.ticket_id]: { ...prev, round: event.round, verdict: event.verdict, at: now } }, feed: feed(state, `Review ${event.verdict}: ${event.summary.slice(0, 60)}`, event.verdict === "PASS" ? "pass" : "fail", now) };
    }
    case "cost.update": {
      const c = state.costs[event.agent] ?? { usd: 0, tokens: 0 };
      return { ...state, now, usage: event.today, costs: { ...state.costs, [event.agent]: { usd: c.usd + event.usd, tokens: c.tokens + event.tokens } } };
    }
    case "result":
      return { ...state, now, feed: feed(state, `Summary for ${event.ticket_id}: ${event.summary.slice(0, 60)}`, "result", now) };
    default:
      return state;
  }
}

// What an agent is doing right now, for its animation.
export function agentStatus(state, id, now = state.now) {
  const a = state.agents[id];
  if (!a) return "unknown";
  if (a.state === "retired") return "retired";
  const mine = Object.values(state.tickets).filter((t) => t.to === id);
  const review = Object.values(state.reviews).find((r) => r.agent === id && r.verdict === "FAIL" && now - r.at < RECENT_MS.review_fail);
  if (review) return "review_fail";
  if (mine.some((t) => t.status === "in_review")) return "in_review";
  if (mine.some((t) => t.status === "waiting_on_owner")) return "waiting_on_owner";
  const recent = state.recent[id];
  if (recent?.kind === "done" && now - recent.at < RECENT_MS.done) return "done";
  if (mine.some((t) => t.status === "in_progress" || t.status === "open")) return "working";
  return "idle";
}

// HQ in the centre, one building per department on a ring around it, in the order they appeared.
export function layout(state) {
  const names = Object.values(state.departments).sort((a, b) => a.builtAt - b.builtAt).map((d) => d.name);
  const ring = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]];
  const buildings = names.map((name, i) => {
    const [gx, gz] = ring[i % ring.length];
    const r = 1 + Math.floor(i / ring.length);
    return { dept: name, x: gx * 14 * r, z: gz * 14 * r, color: deptColor(name), builtAt: state.departments[name].builtAt };
  });
  return { hq: { dept: "HQ", x: 0, z: 0, color: DEPT_COLOR.HQ }, buildings };
}

export const currentTicket = (state, id) => Object.values(state.tickets).filter((t) => t.to === id).sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))[0] ?? null;

export function agentPanel(state, id, audit = []) {
  const a = state.agents[id];
  if (!a) return null;
  const t = currentTicket(state, id);
  const today = state.costs[id];
  return {
    id, role: a.role, kind: a.kind, model: a.model, modelName: MODEL_NAME[a.model] ?? a.model, modelColor: MODEL_COLOR[a.model] ?? "#ccc", department: deptOf(a), parent: a.parent,
    status: agentStatus(state, id),
    ticket: t ? { id: t.id, goal: t.goal, status: t.status } : null,
    actions: audit.slice(-10).map((x) => ({ at: x.ts, text: `${x.decision === "allow" ? "" : `${x.decision}: `}${x.tool}${x.reason ? ` (${x.reason})` : ""}` })),
    costUsd: a.total_cost_usd ?? null, tokensToday: today?.tokens ?? null,
    prop: propFor(a),
  };
}

export function departmentPanel(state, dept) {
  const members = Object.values(state.agents).filter((a) => deptOf(a) === dept && a.state !== "retired");
  const ids = new Set(members.map((a) => a.id));
  return {
    name: dept,
    manager: members.find((a) => a.kind === "manager")?.id ?? (dept === "HQ" ? "orchestrator" : null),
    workers: members.filter((a) => a.kind === "worker").map((a) => a.id),
    openTickets: Object.values(state.tickets).filter((t) => ids.has(t.to)).map((t) => ({ id: t.id, goal: t.goal, status: t.status, to: t.to })),
    todayUsd: dept in state.spend ? state.spend[dept] : null,
  };
}

export function topBar(state) {
  const agents = Object.values(state.agents).filter((a) => !CORE.has(a.id));
  return {
    agentsTotal: agents.length,
    agentsActive: agents.filter((a) => a.state === "active").length,
    ticketsRunning: Object.values(state.tickets).filter((t) => t.status === "in_progress" || t.status === "in_review").length,
    questionsWaiting: Object.keys(state.questions).length,
    usage: state.usage,
  };
}

export const fmt = (v, digits = 2) => (v === null || v === undefined || Number.isNaN(v) ? "—" : typeof v === "number" ? v.toFixed(digits) : String(v));
