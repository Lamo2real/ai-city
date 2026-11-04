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
// Every dollar figure in the HUD is this: a value at list prices, not money that moved.
export const COST_NOTE = "Estimated value at API list prices. On the Claude subscription this is not a charge.";
export const estUsd = (v, digits = 2) => (v === null || v === undefined || Number.isNaN(v) ? "—" : `est. $${Number(v).toFixed(digits)}`);
const RECENT_MS = { done: 6000, review_fail: 20000, hired: 4000, retired: 4000 };

export function initialState(now = Date.now()) {
  return { agents: {}, activities: {}, tickets: {}, questions: {}, departments: {}, reviews: {}, costs: {}, usage: null, spend: {}, caps: null, parked: {}, city: null, feed: [], recent: {}, now };
}

export const deptOf = (agent) => (agent.id === "jarvis" || CORE.has(agent.id) ? "HQ" : agent.department || "other");
export const deptColor = (name) => DEPT_COLOR[name] ?? DEPT_COLOR.other;
export function propFor(agent) {
  if (agent.kind !== "worker") return null;
  const text = `${agent.role} ${agent.id} ${(agent.skills ?? []).join(" ")}`.toLowerCase();
  return TOOL_PROP.find(([re]) => new RegExp(re).test(text))[1];
}

// The same key the runtime files a department under (departmentKey in city/src/policy.ts).
const keyOf = (name) => String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
// An agent carries the spelling of the department's registry entry, so one department is one building.
function filed(departments, a) {
  const d = a.department && Object.values(departments).find((x) => keyOf(x.name) === keyOf(a.department));
  return d && d.name !== a.department ? { ...a, department: d.name } : a;
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
  // The registry says which departments exist. Only a snapshot from before the registry (no `departments`) falls back to the agents.
  const listed = Array.isArray(snap.departments);
  for (const d of listed ? snap.departments : []) {
    const born = Date.parse(d.created_at ?? "");
    if (d.state !== "deleted") next.departments[d.name] = { ...d, builtAt: Math.min(now - 60000, Number.isNaN(born) ? Infinity : born) }; // already built: no construction animation
  }
  for (const a of snap.agents ?? []) {
    next.agents[a.id] = filed(next.departments, a);
    if (!listed) next.departments = touch(next, deptOf(a), now - 60000);
  }
  next.activities = snap.activities ?? {};
  for (const t of snap.tickets ?? []) next.tickets[t.id] = t;
  for (const t of snap.parked ?? []) next.parked[t.id] = t;
  next.city = snap.city ?? null;
  for (const q of snap.questions ?? []) next.questions[q.id] = q;
  next.usage = snap.usage ?? null;
  next.spend = snap.spend ?? {};
  next.caps = snap.caps ?? null; // the limits the server enforces; null when the server did not send them
  return next;
}

// What only a snapshot carries (the gate's counters, parked tickets, spend), taken without rebuilding the scene's state.
export function applyLive(state, snap, now = Date.now()) {
  const parked = {};
  for (const t of snap.parked ?? []) parked[t.id] = t;
  const reason = snap.city?.paused_until ? state.city?.reason ?? null : null; // the reason only comes with the event
  return { ...state, now, parked, city: snap.city ? { ...snap.city, reason } : state.city, usage: snap.usage ?? state.usage, spend: snap.spend ?? state.spend };
}

// A worker's move that is worth a line. hired/assigned/working/idle already show as hire and ticket lines.
const WORKER_LINE = { review: "worker", completed: "done", released: "worker", blocked: "fail", failed: "fail", paused: "worker", cancelled: "worker" };
const asked = (state, event, now) => ({ ...state, now, questions: { ...state.questions, [event.id]: { id: event.id, status: "open", question: event.question, created_at: new Date(now).toISOString() } }, feed: feed(state, `${event.question.path} asks: ${event.question.questions[0]?.text ?? ""}`, "question", now) });

// One event in, a new state out. Unknown events change nothing.
export function reduce(state, event, now = Date.now()) {
  switch (event.type) {
    case "agent.hired": {
      const a = filed(state.departments, event.agent);
      return { ...state, now, agents: { ...state.agents, [a.id]: a }, departments: touch(state, deptOf(a), now), recent: { ...state.recent, [a.id]: { kind: "hired", at: now } }, feed: feed(state, `${a.role} ${event.revived ? "is back" : "hired"} in ${deptOf(a)}`, "hire", now) };
    }
    case "agent.retired": {
      const a = state.agents[event.id];
      if (!a) return state;
      return { ...state, now, agents: { ...state.agents, [a.id]: { ...a, state: "retired" } }, recent: { ...state.recent, [a.id]: { ...state.recent[a.id], kind: "retired", at: now } }, feed: feed(state, `${a.role} ${a.worker_state === "released" ? "released" : "retired"}`, "retire", now) };
    }
    case "ticket.status": {
      const t = event.ticket;
      const tickets = { ...state.tickets }, parked = { ...state.parked };
      const terminal = ["done", "failed", "cancelled"].includes(t.status);
      delete tickets[t.id]; delete parked[t.id];
      if (t.status === "parked") parked[t.id] = t; else if (!terminal) tickets[t.id] = t;
      const recent = terminal ? { ...state.recent, [t.to]: { kind: t.status, at: now, ticket: t.id } } : state.recent;
      const text = event.previous === null ? `${t.to} got a ticket from ${t.from}: ${t.goal.slice(0, 60)}` : `${t.to}: ${event.previous} → ${t.status}`;
      return { ...state, now, tickets, parked, recent, feed: feed(state, text, t.status, now) };
    }
    case "question.asked":
      return asked(state, event, now);
    case "question": // the same question again on its way to the owner, or re-sent after a restart
      return state.questions[event.id] ? state : asked(state, event, now);
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
    case "worker.state": {
      const a = state.agents[event.id];
      if (!a) return state;
      const kind = WORKER_LINE[event.state];
      return { ...state, now, agents: { ...state.agents, [a.id]: { ...a, worker_state: event.state } }, feed: kind ? feed(state, `${a.id}: ${event.previous ?? "new"} → ${event.state}`, kind, now) : state.feed };
    }
    case "agent.activity": {
      const { id, activity, detail, ticket_id, at } = event;
      return { ...state, now, activities: { ...state.activities, [id]: { activity, detail, ticket_id, at } } };
    }
    case "worker.merge_waiting": {
      const a = state.agents[event.id];
      if (!a) return state;
      return { ...state, now, agents: { ...state.agents, [a.id]: { ...a, awaiting_merge: { branch: event.branch, since: new Date(now).toISOString() } } }, feed: feed(state, `${a.id} stays at its desk until ${event.branch} is merged`, "worker", now) };
    }
    case "worker.merged": {
      const a = state.agents[event.id];
      if (!a) return state;
      return { ...state, now, agents: { ...state.agents, [a.id]: { ...a, awaiting_merge: null } }, feed: feed(state, `${event.branch} is settled; ${a.id} can leave its desk`, "done", now) };
    }
    case "jarvis.visit":
      return { ...state, now, feed: feed(state, `Jarvis ${event.kind === "ask" ? "asks" : "checks in with"} ${event.to}`, "worker", now) };
    case "department.created":
    case "department.updated": {
      const d = event.department;
      const oldKey = event.previous_key ?? keyOf(d.name);
      const old = Object.values(state.departments).find((x) => keyOf(x.name) === oldKey);
      const departments = { ...state.departments };
      if (old) delete departments[old.name];
      if (d.state !== "deleted") departments[d.name] = { ...d, builtAt: old?.builtAt ?? now };
      // A rename moves its members in the ledger without an event of its own.
      const agents = old && old.name !== d.name ? Object.fromEntries(Object.entries(state.agents).map(([id, a]) => [id, a.department && keyOf(a.department) === oldKey ? { ...a, department: d.name } : a])) : state.agents;
      const text = !old?.key ? `Department ${d.name} created` : old.name !== d.name ? `Department ${old.name} is now ${d.name}` : old.state !== d.state ? `Department ${d.name}: ${old.state} → ${d.state}` : `Department ${d.name} updated`;
      return { ...state, now, departments, agents, feed: feed(state, text, "department", now) };
    }
    case "city.paused":
      return { ...state, now, city: { turns_running: null, turns_waiting: null, ...state.city, paused_until: event.until, reason: event.reason ?? null }, feed: feed(state, `City paused until ${stockholmTime(Date.parse(event.until))}: ${String(event.reason ?? "").slice(0, 80)}`, "fail", now) };
    case "city.resumed":
      return { ...state, now, city: { turns_running: null, turns_waiting: null, ...state.city, paused_until: null, reason: null }, feed: feed(state, "City resumed", "pass", now) };
    case "tickets.parked": {
      const tickets = { ...state.tickets }, parked = { ...state.parked };
      for (const id of event.ids ?? []) if (tickets[id]) { parked[id] = { ...tickets[id], status: "parked" }; delete tickets[id]; }
      return { ...state, now, tickets, parked, feed: feed(state, `${event.ids?.length ?? 0} stale tickets parked; they wait for you`, "fail", now) };
    }
    case "turn.failed":
      return { ...state, now, feed: feed(state, `${event.agent || "A turn"} failed${event.retrying ? ", retrying" : ""}: ${String(event.error ?? "").slice(0, 80)}`, "fail", now) };
    default:
      return state;
  }
}

// What an agent is doing right now, for its animation.
export function agentStatus(state, id, now = state.now) {
  const a = state.agents[id];
  if (!a) return "unknown";
  if (a.state === "retired") return a.worker_state === "released" ? "released" : "retired";
  const mine = Object.values(state.tickets).filter((t) => t.to === id);
  const review = Object.values(state.reviews).find((r) => r.agent === id && r.verdict === "FAIL" && now - r.at < RECENT_MS.review_fail);
  if (review) return "review_fail";
  // A worker's lifecycle is what the runtime says it is; tickets only decide for agents without one.
  if (a.kind === "worker" && a.worker_state) return a.worker_state === "blocked" && mine.some((t) => t.status === "waiting_on_owner") ? "waiting_on_owner" : a.worker_state;
  if (mine.some((t) => t.status === "in_review")) return "in_review";
  if (mine.some((t) => t.status === "waiting_on_owner")) return "waiting_on_owner";
  const recent = state.recent[id];
  if (recent?.kind === "done" && now - recent.at < RECENT_MS.done) return "done";
  if (mine.some((t) => t.status === "in_progress" || t.status === "open")) return "working";
  return "idle";
}

export const departmentNames = (state) => Object.values(state.departments).sort((a, b) => a.builtAt - b.builtAt).map((d) => d.name);

// ---------- Where each agent is. The whole game follows from these few rules. ----------
const hasOpenWork = (state, id) => Object.values(state.tickets).some((t) => t.to === id || t.from === id);

// Core: HQ. Anyone else is at its station while it has open work, is hired and not released, or waits for a merge. Otherwise home.
// `state.tickets` holds only open tickets: a parked one does nothing until the owner decides, so it keeps nobody at a desk.
export function placement(state, id) {
  const a = state.agents[id];
  if (!a) return null;
  if (a.kind === "core" || CORE.has(id)) return { place: "hq", dept: "HQ", why: "core" };
  const dept = deptOf(a);
  if (hasOpenWork(state, id)) return { place: "station", dept, why: "ticket" };
  if (a.awaiting_merge) return { place: "station", dept, why: "merge" };
  if (a.kind === "worker" && a.state !== "retired" && a.worker_state !== "released") return { place: "station", dept, why: "hired" };
  return { place: "home", dept, why: a.state === "retired" ? "released" : "off work" };
}

// What the figure shows: a key of VISUALS, one for every activity the runtime reports and every lifecycle mark.
export function visualState(state, id, now = Date.now()) {
  const a = state.agents[id], where = placement(state, id);
  if (!a || where.place === "home") return "idle";
  const mine = Object.values(state.tickets).filter((t) => t.to === id);
  const worker = a.kind === "worker" ? a.worker_state : null;
  const activity = state.activities[id]?.activity;
  if (worker === "failed") return "failed";
  if (mine.some((t) => t.status === "waiting_on_owner") || activity === "waiting_owner" || Object.values(state.questions).some((q) => q.question?.asked_by === id)) return "waiting_owner";
  if (worker === "blocked") return "blocked";
  if (worker === "paused") return "paused";
  if (where.why === "merge") return "waiting_merge";
  if (activity && activity !== "idle") return gateStatus(state, now).paused ? "paused" : VISUALS[activity] ? activity : "working"; // a paused city's turns wait, nobody is typing
  if (worker === "review" || mine.some((t) => t.status === "in_review")) return "in_review";
  if (mine.length) return "working";
  return Object.values(state.tickets).some((t) => t.from === id) ? "waiting_team" : "idle";
}

// words: what the panel says in plain language. pose: which body animation.
export const VISUALS = {
  understanding: { label: "Understanding", words: "Working out what is being asked", pose: "think" },
  reading: { label: "Reading", words: "Reading a file", pose: "read" },
  researching: { label: "Researching", words: "Looking things up", pose: "read" },
  browsing: { label: "Browsing", words: "Using a browser", pose: "tablet" },
  coding: { label: "Coding", words: "Writing code", pose: "type" },
  running: { label: "Running", words: "Running a command", pose: "type" },
  working: { label: "Working", words: "Working on its task", pose: "type" },
  hiring: { label: "Hiring", words: "Hiring someone", pose: "wave" },
  delegating: { label: "Delegating", words: "Handing work to someone", pose: "point" },
  asking: { label: "Asking", words: "Asking a question", pose: "raise" },
  answering: { label: "Answering", words: "Answering a question", pose: "point" },
  reporting: { label: "Reporting", words: "Reporting back", pose: "clipboard" },
  reviewing: { label: "Reviewing", words: "Reviewing someone's work", pose: "magnify" },
  in_review: { label: "In review", words: "Waiting for its work to be reviewed", pose: "wait" },
  summarizing: { label: "Summarizing", words: "Writing a summary", pose: "clipboard" },
  remembering: { label: "Remembering", words: "Saving something to memory", pose: "think" },
  waiting_team: { label: "Waiting for the team", words: "Waiting for its team to finish", pose: "wait" },
  waiting_owner: { label: "Needs you", words: "Waiting for your answer", pose: "alarm" },
  waiting_merge: { label: "Waiting for a merge", words: "Done, and staying until the branch is merged", pose: "wait" },
  failed: { label: "Failed", words: "Its last task failed", pose: "slump" },
  blocked: { label: "Blocked", words: "Blocked and cannot go on", pose: "slump" },
  paused: { label: "Paused", words: "Paused", pose: "still" },
  idle: { label: "Idle", words: "Nothing right now", pose: "rest" },
};

// Plain words for the panel. The detail is agent text: the caller puts it in a text node.
export function doingWords(key, detail = "") {
  const words = (VISUALS[key] ?? VISUALS.working).words;
  return detail ? `${words}: ${detail}` : `${words}.`;
}

// Everyone keeps a seat once given one; a newcomer takes the lowest free one. On a page load `previous` is empty.
export function assignSlots(ids, previous = new Map()) {
  const slots = new Map();
  const taken = new Set();
  for (const id of ids) if (previous.has(id)) { slots.set(id, previous.get(id)); taken.add(previous.get(id)); }
  let next = 0;
  for (const id of [...ids].sort()) {
    if (slots.has(id)) continue;
    while (taken.has(next)) next++;
    slots.set(id, next);
    taken.add(next);
  }
  return slots;
}

// A released worker stays home as history, but only the latest few stand in the neighbourhood; the rest are in Workforce.
export const RETIRED_SHOWN = 24;
export function residents(state) {
  const all = Object.values(state.agents).filter((a) => !CORE.has(a.id) && a.kind !== "core");
  const away = all.filter((a) => a.state === "retired" && placement(state, a.id).place === "home").sort((a, b) => (b.last_active_at ?? "").localeCompare(a.last_active_at ?? "") || a.id.localeCompare(b.id));
  const hide = new Set(away.slice(RETIRED_SHOWN).map((a) => a.id));
  return { ids: all.filter((a) => !hide.has(a.id)).map((a) => a.id), hidden: hide.size };
}

// A stable look from the id alone: the same figure on every load and every machine.
export function hashOf(s) { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
export function identity(id) {
  const h = hashOf(id);
  return { skin: h % 6, hair: (h >>> 3) % 7, hairStyle: (h >>> 6) % 5, shirt: (h >>> 9) % 10, trousers: (h >>> 13) % 4 };
}

// ---------- The map, in tiles of 16 art pixels ----------
export const TILE = 16;
export const BUILDING_H = 5;
const PLOT_W = 9, SEAT_PITCH = 40, SEATS_PER_ROW = 4, STREET = 3, HQ_W = 12, HQ_H = 11, HOUSES_PER_ROW = 4, HOUSE_W = 3, HOUSE_ROW_H = 4;

// An archived department keeps its slot, so a building never lands on another; it isn't drawn unless work is still open there.
// `seats` is { dept: the highest seat in use + 1 }, so a crowded row of offices gets a deeper terrace.
export function layout(state, { portrait = false, seats = {}, houses = 0 } = {}) {
  const names = departmentNames(state);
  for (const d of Object.keys(seats)) if (d !== "HQ" && !names.includes(d)) names.push(d); // someone works in a department the registry no longer lists
  const n = names.length;
  const cols = portrait ? 2 : Math.max(2, n <= 4 ? 2 : Math.ceil(n / 3));
  const rows = Math.max(2, Math.ceil(n / cols));
  const originX = portrait ? 1 : 1 + HQ_W + STREET, width = originX + cols * PLOT_W + (cols - 1) * STREET + 1;
  const hq = { dept: "HQ", x: portrait ? Math.round((width - HQ_W) / 2) : 1, y: 1, w: HQ_W, h: HQ_H, color: DEPT_COLOR.HQ };
  const buildings = [], lots = [];
  const avenueX = portrait ? originX + PLOT_W : 1 + HQ_W;
  const streets = [portrait ? { y: 1 + HQ_H, x0: 0, x1: width } : { y: 1 + HQ_H, x0: 0, x1: avenueX }];
  let y = portrait ? 1 + HQ_H + STREET : 1;
  for (let r = 0; r < rows; r++) {
    let most = 2 * SEATS_PER_ROW;
    for (let c = 0; c < cols; c++) most = Math.max(most, seats[names[r * cols + c]] ?? 0);
    const h = BUILDING_H + Math.ceil((Math.ceil(most / SEATS_PER_ROW) * SEAT_PITCH) / TILE);
    for (let c = 0; c < cols; c++) {
      const name = names[r * cols + c], x = originX + c * (PLOT_W + STREET);
      if (!name) { lots.push({ x, y, w: PLOT_W, h }); continue; }
      const reg = state.departments[name];
      buildings.push({ dept: name, slot: r * cols + c, x, y, w: PLOT_W, h, color: deptColor(name), builtAt: reg?.builtAt ?? 0, archived: reg?.state === "archived" && !seats[name] });
    }
    y += h;
    streets.push({ y, x0: portrait ? 0 : avenueX, x1: width });
    y += STREET;
  }
  const officesEnd = y - STREET;
  // Houses: under HQ on the wide map, under the offices on a phone. More than fit makes the neighbourhood run on below.
  const homesY = portrait ? y : 1 + HQ_H + STREET;
  const homesW = portrait ? width - 2 : HQ_W;
  const perRow = portrait ? Math.floor(homesW / HOUSE_W) : HOUSES_PER_ROW;
  const home = [];
  for (let i = 0; i < houses; i++) home.push({ x: 1 + (i % perRow) * HOUSE_W, y: homesY + Math.floor(i / perRow) * HOUSE_ROW_H });
  const homesH = Math.max(Math.ceil(houses / perRow) * HOUSE_ROW_H, portrait ? HOUSE_ROW_H : officesEnd - homesY);
  return { hq, buildings, lots, streets, hqStreet: 1 + HQ_H, officesEnd, avenue: avenueX, width, height: Math.max(y, homesY + homesH + 1), homes: { x: 1, y: homesY, w: homesW, h: homesH, houses: home }, portrait };
}

// The art-pixel spot for a seat on a department's terrace: where the figure's feet are.
export const seatRows = (building) => Math.floor(((building.h - BUILDING_H) * TILE) / SEAT_PITCH);
export function seatSpot(building, seat) {
  const r = Math.floor(seat / SEATS_PER_ROW), c = seat % SEATS_PER_ROW;
  const pitch = (building.w * TILE - 8) / SEATS_PER_ROW;
  return { x: building.x * TILE + 4 + Math.round(pitch * (c + 0.5)), y: (building.y + BUILDING_H) * TILE + r * SEAT_PITCH + 24 };
}

// Two spots in each house's front yard.
export function homeSpot(world, slot) {
  const h = world.homes.houses[Math.floor(slot / 2)];
  return h ? { x: h.x * TILE + (slot % 2 ? 36 : 12), y: h.y * TILE + 58 } : null;
}

// An evening walk keeps to the streets: to the nearest street, along it to the avenue, along the avenue, and in.
export function walkRoute(world, from, to) {
  const lanes = [...world.streets.map((s) => (s.y + STREET / 2) * TILE), ...new Set(world.homes.houses.map((h) => h.y * TILE - 5))];
  const nearest = (y) => lanes.reduce((best, l) => (Math.abs(l - y) < Math.abs(best - y) ? l : best), lanes[0] ?? y);
  const ax = (world.avenue + STREET / 2) * TILE, a = nearest(from.y), b = nearest(to.y);
  return a === b ? [{ x: from.x, y: a }, { x: to.x, y: a }, to] : [{ x: from.x, y: a }, { x: ax, y: a }, { x: ax, y: b }, { x: to.x, y: b }, to];
}

// What the map should say when it has nothing to show. Null when people and offices speak for themselves.
export function cityMessage(state) {
  const others = Object.keys(state.agents).filter((id) => !CORE.has(id));
  if (!departmentNames(state).length) return "No departments yet. An office goes up the moment a prompt needs one.";
  if (!others.some((id) => placement(state, id).place === "station")) return "Nobody is at a desk right now. Everyone is home or at HQ.";
  return null;
}

// Jarvis's status call can fire many times in a row; only the first of a burst is a visit.
export const visitAllowed = (lastAt, now, to) => to !== "jarvis" && now - lastAt >= 1000;

export const currentTicket = (state, id) => Object.values(state.tickets).filter((t) => t.to === id).sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))[0] ?? null;

export function agentPanel(state, id, audit = []) {
  const a = state.agents[id];
  if (!a) return null;
  const t = currentTicket(state, id);
  const today = state.costs[id];
  return {
    id, role: a.role, kind: a.kind, executor: a.executor ?? null, lastTicket: state.recent[id]?.ticket ?? null, model: a.model, modelName: MODEL_NAME[a.model] ?? a.model, modelColor: MODEL_COLOR[a.model] ?? "#ccc", department: deptOf(a), parent: a.parent,
    status: agentStatus(state, id),
    ticket: t ? { id: t.id, goal: t.goal, status: t.status } : null,
    actions: audit.slice(-10).map((x) => ({ at: x.ts, text: `${x.decision === "allow" ? "" : `${x.decision}: `}${x.tool}${x.reason ? ` (${x.reason})` : ""}` })),
    costUsd: a.total_cost_usd ?? null, tokensToday: today?.tokens ?? null,
    prop: propFor(a),
  };
}

export function departmentPanel(state, dept) {
  const everyone = Object.values(state.agents).filter((a) => deptOf(a) === dept);
  const members = everyone.filter((a) => a.state !== "retired");
  const ids = new Set(members.map((a) => a.id));
  const reg = state.departments[dept];
  // Spend is keyed by the agents' spellings, so an old install's "app" and "App" add up here.
  const spent = Object.entries(state.spend).filter(([k]) => keyOf(k) === keyOf(dept)).map(([, v]) => v);
  return {
    name: dept,
    mission: reg?.mission || null,
    state: reg?.state ?? null,
    manager: reg?.manager_id ?? members.find((a) => a.kind === "manager")?.id ?? (dept === "HQ" ? "orchestrator" : null),
    workers: members.filter((a) => a.kind === "worker").map((a) => a.id),
    workerStates: Object.fromEntries(members.filter((a) => a.kind === "worker").map((a) => [a.id, agentStatus(state, a.id)])),
    released: everyone.filter((a) => a.state === "retired").map((a) => ({ id: a.id, role: a.role })), // history: their row, tickets and costs stay
    openTickets: Object.values(state.tickets).filter((t) => ids.has(t.to)).map((t) => ({ id: t.id, goal: t.goal, status: t.status, to: t.to })),
    todayUsd: spent.length ? spent.reduce((a, b) => a + b, 0) : null,
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

// Everything that waits for the owner, as one list: a pending merge confirmation first (it expires),
// then open agent questions, oldest first. `confirm` is { id, ..., expiresAt } (epoch ms) or null.
// An expired confirmation is not listed. Pure: nothing here sends or answers anything.
export function inboxItems(state, confirm, now = Date.now()) {
  const items = [];
  if (confirm && Number(confirm.expiresAt) > now) items.push({ kind: "merge", id: confirm.id, confirm });
  const qs = Object.values(state?.questions ?? {}).filter((q) => q.status === "open" && q.question)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || String(a.id).localeCompare(String(b.id)));
  for (const q of qs) items.push({ kind: "question", id: q.id, path: q.question.path ?? "", questions: q.question.questions ?? [], created_at: q.created_at });
  return items;
}

// ---------- Status board: limits, agents and tickets, as plain data ----------
export const STALE_MS = 2 * 3600 * 1000;
export const TICKET_ORDER = ["open", "in_progress", "in_review", "waiting_on_owner"];

// How the city is doing against its caps. A cap is null when the server did not send one: the board says so, it never guesses.
export function limits(state) {
  const caps = state.caps ?? {};
  const cap = (k) => (typeof caps[k] === "number" ? caps[k] : null);
  const agents = Object.values(state.agents);
  const active = agents.filter((a) => a.kind !== "core" && a.state === "active").length; // the rule runtime.ts applies when hiring
  const workersMax = agents.filter((a) => a.kind === "manager").reduce((m, mgr) => Math.max(m, agents.filter((a) => a.parent === mgr.id && a.state === "active").length), 0);
  const spendCap = cap("daily_spend_usd_per_department");
  const departments = Object.entries(state.spend ?? {}).map(([dept, usd]) => ({ dept, usd, cap: spendCap, over: spendCap !== null && usd > spendCap, pct: spendCap ? Math.min(100, (usd / spendCap) * 100) : null }));
  // Active agents against the cap, per department. The cap is department_caps[dept] ?? the default; a snapshot from
  // before the restart (only max_concurrent_agents) has neither, so the cap is null, never guessed.
  const defaultCap = cap("max_active_agents_per_department");
  const deptCaps = caps.department_caps ?? {};
  const names = [...new Set(agents.filter((a) => a.kind !== "core" && a.department).map((a) => a.department))].sort();
  const agentsByDepartment = names.map((dept) => {
    const n = agents.filter((a) => a.kind !== "core" && a.state === "active" && a.department === dept).length;
    const c = typeof deptCaps[dept] === "number" ? deptCaps[dept] : defaultCap;
    return { dept, active: n, cap: c, full: c !== null && n >= c };
  });
  return {
    known: state.caps !== null && state.caps !== undefined,
    // Total across departments. `max` is only set by an older server that still enforces a total cap.
    agents: { active, max: cap("max_concurrent_agents") },
    // Only a server that sends the per-department cap says "no total cap"; an older snapshot keeps the plain label.
    agentsLabel: defaultCap !== null ? "AGENTS ACTIVE (no total cap; per department below)" : "AGENTS ACTIVE",
    agentsByDepartment,
    agentCapPerDepartment: defaultCap,
    workersPerManager: { largest: workersMax, max: cap("max_workers_per_manager") },
    departments,
    usage: state.usage ? { turns: state.usage.turns, tokens: state.usage.tokens, usd: state.usage.usd } : null,
  };
}

const ms = (iso) => { const t = Date.parse(iso ?? ""); return Number.isNaN(t) ? null : t; };
export function relTime(msAgo) {
  if (msAgo === null || msAgo === undefined) return "—";
  const s = Math.max(0, Math.round(msAgo / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export function ageText(msAgo) { return msAgo === null ? "—" : relTime(msAgo).replace(" ago", "").replace("just now", "<1 min"); }

// Open work grouped by status, oldest first. `stale`: nothing has touched the ticket for more than two hours.
export function ticketGroups(state, now = Date.now()) {
  return TICKET_ORDER.map((status) => ({
    status,
    tickets: Object.values(state.tickets).filter((t) => t.status === status).map((t) => {
      const created = ms(t.created_at), updated = ms(t.updated_at);
      return { id: t.id, to: t.to, goal: t.goal, ageMs: created === null ? null : now - created, stale: updated !== null && now - updated > STALE_MS };
    }).sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1)),
  }));
}

// One row per live agent. Core agents come separately; retired agents are not listed.
export function agentRows(state, now = Date.now()) {
  const rows = Object.values(state.agents).filter((a) => a.state !== "retired").map((a) => {
    const t = currentTicket(state, a.id), last = ms(a.last_active_at);
    return { id: a.id, role: a.role, state: a.state, model: a.model, modelName: MODEL_NAME[a.model] ?? a.model, department: deptOf(a), goal: t?.goal ?? null, lastActiveMs: last === null ? null : now - last, core: a.kind === "core" };
  });
  return { core: rows.filter((r) => r.core), others: rows.filter((r) => !r.core) };
}

// ---------- The gate, parked tickets, and what the panels read ----------
export const stockholmTime = (t) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" }).format(t);

// The server's gate lifts by itself when the reset passes, so a paused_until in the past is not a pause.
export function gateStatus(state, now = Date.now()) {
  const c = state.city, until = ms(c?.paused_until);
  return {
    known: !!c,
    running: c?.turns_running ?? null,
    waiting: c?.turns_waiting ?? null,
    paused: until !== null && until > now ? { until, text: stockholmTime(until), inText: ageText(until - now), reason: c.reason ?? null } : null,
  };
}

export function parkedRows(state, now = Date.now()) {
  return Object.values(state.parked).map((t) => {
    const created = ms(t.created_at), updated = ms(t.updated_at);
    return { id: t.id, to: t.to, from: t.from, goal: t.goal, ageMs: created === null ? null : now - created, quietMs: updated === null ? null : now - updated };
  }).sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1));
}

// A ticket moving between two agents, from the event itself: the sender hands it over, the worker hands the result back.
export function courierFor(event) {
  if (event.type !== "ticket.status") return null;
  const t = event.ticket;
  if (!t.from || !t.to || t.from === t.to) return null;
  if (event.previous === null) return { from: t.from, to: t.to, kind: "ticket" };
  return t.status === "done" || t.status === "failed" ? { from: t.to, to: t.from, kind: "result" } : null;
}

export const workforceGroups = (wf) => ({ current: (wf?.workers ?? []).filter((w) => w.state !== "released"), released: (wf?.workers ?? []).filter((w) => w.state === "released") });
export const usdRows = (byKey) => Object.entries(byKey ?? {}).map(([name, v]) => ({ name, ...v }));

export const INTEGRATION_MEANS = [
  ["operational", "a real probe answered"],
  ["authenticated", "a credential is present, not exercised"],
  ["available", "on this Mac, not proven working"],
  ["needs_owner", "needs you to sign in or fix it"],
  ["unavailable", "not installed or not reachable"],
  ["unknown", "not checked"],
];
// What the probe actually looked at. Names only: a keychain probe reads metadata, never the value.
export function checkText(check) {
  if (!check) return null;
  if (check.command) return check.command.join(" ");
  if (check.mcp) return `claude mcp list: ${check.mcp}`;
  if (check.port) return `port ${check.port}`;
  if (check.keychain) return `Keychain item ${check.keychain} exists`;
  if (check.bin) return `which ${check.bin}`;
  return null;
}
export function integrationGroups(list) {
  const groups = new Map();
  for (const i of list ?? []) { const c = i.category || "other"; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(i); }
  return [...groups].map(([category, items]) => ({ category, items }));
}

// A ticket's story, one plain line per recorded event. The runtime sends each question twice; the story tells it once.
export function traceLines(events) {
  const seen = new Set((events ?? []).filter((e) => e.type === "question.asked").map((e) => e.id));
  return (events ?? []).filter((e) => e.type !== "question" || !seen.has(e.id)).map((e) => ({ at: e.at, type: e.type, text: traceText(e) }));
}
function traceText(e) {
  switch (e.type) {
    case "ticket.status": { const t = e.ticket; return e.previous === null ? `${t.from} sent ${t.to}: ${t.goal}` : `${t.to}: ${e.previous} → ${t.status}`; }
    case "question.asked": case "question": return `${e.question?.path ?? e.question?.asked_by ?? "An agent"} asked: ${e.question?.questions?.[0]?.text ?? ""}`;
    case "question.answered": return `${e.answered_by} answered: ${e.answer}`;
    case "review.started": return `Review round ${e.round} started by ${e.by}`;
    case "review.result": return `Review round ${e.round}: ${e.verdict}. ${e.summary ?? ""}`;
    case "cost.update": return `${e.agent}: a turn of ${e.tokens} tokens, ${estUsd(e.usd, 3)}`;
    case "result": return `Result (${e.status}): ${e.summary}`;
    case "turn.failed": return `${e.agent || "A turn"} failed${e.retrying ? ", retrying" : ""}: ${e.error}`;
    default: return e.type;
  }
}
