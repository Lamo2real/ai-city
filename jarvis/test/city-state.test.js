// Events in, scene state out: the City View's reducer and panel mappings, with no DOM and no three.js.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentRows, ageText, applyLive, checkText, courierFor, departmentNames, estUsd, gateStatus, inboxItems, integrationGroups, limits, parkedRows, relTime, ticketGroups, traceLines, workforceGroups, agentPanel, agentStatus, applySnapshot, departmentPanel, initialState, layout, propFor, reduce, topBar } from "../hud/city-state.js";
import { cityEvent, cityIntegrations, cityParked, citySnapshot, cityTrace, cityWorkforce } from "./fixtures/city.js";

const T0 = 1_000_000;
const agent = (id, kind, department, parent = "orchestrator", model = "claude-sonnet-5-5", extra = {}) => ({ id, role: id, kind, department, parent, model, tools: [], lifecycle: "persistent", state: "active", created_at: "", last_active_at: "", total_cost_usd: 0.5, ...extra });
const ticket = (id, to, status, goal = "work") => ({ id, from: "orchestrator", to, kind: "task", goal, status, created_at: "", updated_at: "" });

test("a hire builds the department once, a retirement keeps the agent in the registry", () => {
  let s = initialState(T0);
  s = reduce(s, { type: "agent.hired", agent: agent("it-manager", "manager", "IT"), revived: false }, T0);
  s = reduce(s, { type: "agent.hired", agent: agent("py-dev", "worker", "IT", "it-manager"), revived: false }, T0 + 1);
  assert.deepEqual(Object.keys(s.departments), ["IT"]);
  assert.equal(s.departments.IT.builtAt, T0);
  assert.equal(s.feed[0].text, "py-dev hired in IT");
  s = reduce(s, { type: "agent.retired", id: "py-dev" }, T0 + 2);
  assert.equal(s.agents["py-dev"].state, "retired");
  assert.equal(agentStatus(s, "py-dev"), "retired");
  assert.equal(reduce(s, { type: "agent.retired", id: "nobody" }), s, "unknown agents change nothing");
  assert.equal(reduce(s, { type: "something.else" }), s);
});

test("ticket, question and review events decide each agent's animation", () => {
  let s = initialState(T0);
  s = reduce(s, { type: "agent.hired", agent: agent("ios-dev", "worker", "App", "app-manager"), revived: false }, T0);
  assert.equal(agentStatus(s, "ios-dev"), "idle");
  s = reduce(s, { type: "ticket.status", ticket: ticket("t1", "ios-dev", "in_progress"), previous: null }, T0);
  assert.equal(agentStatus(s, "ios-dev"), "working");
  s = reduce(s, { type: "ticket.status", ticket: ticket("t1", "ios-dev", "waiting_on_owner"), previous: "in_progress" }, T0);
  assert.equal(agentStatus(s, "ios-dev"), "waiting_on_owner");
  s = reduce(s, { type: "review.started", ticket_id: "t1", round: 1, by: "orchestrator" }, T0);
  s = reduce(s, { type: "ticket.status", ticket: ticket("t1", "ios-dev", "in_review"), previous: "waiting_on_owner" }, T0);
  assert.equal(agentStatus(s, "ios-dev"), "in_review");
  assert.match(s.feed.find((f) => f.kind === "review").text, /Inspector at ios-dev's door/);
  s = reduce(s, { type: "review.result", ticket_id: "t1", round: 1, verdict: "FAIL", summary: "one bug", checks: [] }, T0);
  s = reduce(s, { type: "ticket.status", ticket: ticket("t1", "ios-dev", "in_progress"), previous: "in_review" }, T0);
  assert.equal(agentStatus(s, "ios-dev", T0 + 1000), "review_fail");
  assert.equal(agentStatus(s, "ios-dev", T0 + 30000), "working", "the smoke clears after a while");
  s = reduce(s, { type: "ticket.status", ticket: ticket("t1", "ios-dev", "done"), previous: "in_progress" }, T0 + 40000);
  assert.equal(agentStatus(s, "ios-dev", T0 + 41000), "done");
  assert.equal(agentStatus(s, "ios-dev", T0 + 50000), "idle");
  assert.deepEqual(Object.keys(s.tickets), [], "finished tickets leave the board");
});

test("questions wait in the inbox until answered; usage follows cost updates", () => {
  let s = initialState(T0);
  const q = { ticket_id: "t1", asked_by: "ios-dev", path: "App Manager › iOS Developer", questions: [{ text: "SwiftData?", default: "yes" }] };
  s = reduce(s, { type: "question.asked", id: "q1", ticket_id: "t1", question: q }, T0);
  assert.equal(topBar(s).questionsWaiting, 1);
  assert.equal(s.feed[0].text, "App Manager › iOS Developer asks: SwiftData?");
  s = reduce(s, { type: "question.answered", id: "q1", answer: "yes", answered_by: "owner", ticket_id: "t1" }, T0);
  assert.equal(topBar(s).questionsWaiting, 0);
  assert.equal(topBar(s).usage, null);
  s = reduce(s, { type: "cost.update", agent: "ios-dev", ticket_id: "t1", usd: 0.02, tokens: 1500, today: { usd: 0.3, tokens: 20000, turns: 7 } }, T0);
  s = reduce(s, { type: "cost.update", agent: "ios-dev", ticket_id: "t1", usd: 0.01, tokens: 500, today: { usd: 0.31, tokens: 20500, turns: 8 } }, T0);
  assert.deepEqual(topBar(s).usage, { usd: 0.31, tokens: 20500, turns: 8 });
  assert.deepEqual(s.costs["ios-dev"], { usd: 0.03, tokens: 2000 });
});

test("a snapshot seeds the city without construction animations; HQ sits in the centre with departments around it", () => {
  const s = applySnapshot(initialState(T0), { agents: [agent("jarvis", "core", undefined, "owner", "claude-haiku-5-5"), agent("orchestrator", "core", undefined, "jarvis", "claude-opus-5-5"), agent("it-manager", "manager", "IT"), agent("app-manager", "manager", "App")], tickets: [ticket("t1", "it-manager", "in_progress")], questions: [], usage: { usd: 1, tokens: 10, turns: 2 }, spend: { IT: 0.5 } }, T0);
  const l = layout(s);
  assert.deepEqual(l.hq, { dept: "HQ", x: 0, z: 0, color: "#3b82ff" });
  assert.deepEqual(l.buildings.map((b) => [b.dept, b.x, b.z]), [["IT", 14, 0], ["App", -14, 0]]);
  assert.ok(l.buildings.every((b) => b.builtAt < T0), "no construction animation for what already exists");
  assert.deepEqual(topBar(s), { agentsTotal: 2, agentsActive: 2, ticketsRunning: 1, questionsWaiting: 0, usage: { usd: 1, tokens: 10, turns: 2 } });
});

test("panels show real data and dashes for what is unknown", () => {
  let s = applySnapshot(initialState(T0), { agents: [agent("app-manager", "manager", "App"), agent("ios-dev", "worker", "App", "app-manager", "claude-sonnet-5-5", { skills: ["swift"], total_cost_usd: 0.123 })], tickets: [ticket("t1", "ios-dev", "in_progress", "Build the screen")], questions: [], usage: null, spend: { App: 0.9 } }, T0);
  const p = agentPanel(s, "ios-dev", [{ ts: 1, tool: "Read", decision: "allow", reason: "" }, { ts: 2, tool: "Bash", decision: "deny", reason: "Never push to main." }]);
  assert.equal(p.role, "ios-dev");
  assert.equal(p.modelName, "Sonnet");
  assert.equal(p.modelColor, "#2fd36b");
  assert.equal(p.department, "App");
  assert.equal(p.parent, "app-manager");
  assert.deepEqual(p.ticket, { id: "t1", goal: "Build the screen", status: "in_progress" });
  assert.deepEqual(p.actions.map((a) => a.text), ["Read", "deny: Bash (Never push to main.)"]);
  assert.equal(p.costUsd, 0.123);
  assert.equal(p.tokensToday, null, "no cost event yet: unknown, not zero");
  assert.equal(p.prop, "laptop");
  assert.equal(agentPanel(s, "nobody"), null);
  const d = departmentPanel(s, "App");
  assert.deepEqual(d, { name: "App", mission: null, state: null, manager: "app-manager", workers: ["ios-dev"], workerStates: { "ios-dev": "working" }, released: [], openTickets: [{ id: "t1", goal: "Build the screen", status: "in_progress", to: "ios-dev" }], todayUsd: 0.9 });
  assert.equal(departmentPanel(s, "Video").todayUsd, null);
  assert.equal(propFor(agent("cam", "worker", "Video", "video-manager", "claude-sonnet-5-5", { role: "Camera operator" })), "camera");
  assert.equal(propFor(agent("m", "manager", "Video")), null);
});

test("a busy city and a loop of its events go through the reducer without breaking it", () => {
  let s = applySnapshot(initialState(T0), citySnapshot(T0), T0);
  assert.ok(topBar(s).agentsTotal >= 8);
  assert.equal(layout(s).buildings.length, 4);
  for (let i = 0; i < 40; i++) s = reduce(s, cityEvent(i, T0 + i), T0 + i);
  assert.ok(s.feed.length > 10 && s.feed.length <= 40);
  assert.ok(Object.keys(s.departments).includes("Video"), "a hire builds a new department");
});

test("the city state carries no demo flag and the module exports no demo data", async () => {
  const mod = await import("../hud/city-state.js");
  assert.ok(!("demo" in initialState(T0)));
  assert.ok(!("demo" in applySnapshot(initialState(T0), { agents: [] }, T0)));
  assert.deepEqual(Object.keys(mod).filter((k) => /demo|sample|fake/i.test(k)), []);
});

test("inboxItems lists a live merge first, then open questions oldest first; expired merges and answered questions are gone", () => {
  let s = applySnapshot(initialState(T0), citySnapshot(T0), T0);
  s = reduce(s, cityEvent(8), T0 + 5000); // q-fx2 asked later than q-fx1
  const merge = { id: "c1", repo: "o/r", number: 7, expiresAt: T0 + 10_000 };
  const items = inboxItems(s, merge, T0 + 6000);
  assert.deepEqual(items.map((i) => `${i.kind}:${i.id}`), ["merge:c1", "question:q-fx1", "question:q-fx2"]);
  assert.equal(items[1].path, "Marketing Manager › Ads Writer");
  assert.equal(items[1].questions[0].default, "20");
  assert.deepEqual(inboxItems(s, merge, T0 + 10_000).map((i) => i.kind), ["question", "question"], "expired at expiresAt");
  assert.deepEqual(inboxItems(s, null, T0).map((i) => i.id), ["q-fx1", "q-fx2"]);
  s = reduce(s, cityEvent(3), T0 + 7000); // q-fx1 answered
  assert.deepEqual(inboxItems(s, null, T0).map((i) => i.id), ["q-fx2"]);
  assert.deepEqual(inboxItems(initialState(T0), null, T0), []);
  assert.deepEqual(inboxItems(undefined, undefined, T0), []);
});

// ---- Status board ----
const H = 3600 * 1000;
test("applySnapshot keeps the caps the server sent, and null when it sent none", () => {
  assert.deepEqual(applySnapshot(initialState(T0), citySnapshot(T0), T0).caps, citySnapshot(T0).caps);
  assert.equal(applySnapshot(initialState(T0), { agents: [] }, T0).caps, null);
});

test("limits counts active non-core agents, the largest team, and flags a department over its cap", () => {
  const snap = { ...citySnapshot(T0), spend: { App: 0.91, Marketing: 7.5 } };
  snap.agents.push({ ...snap.agents.find((a) => a.id === "ios-dev"), id: "old", state: "retired" });
  const L = limits(applySnapshot(initialState(T0), snap, T0));
  assert.deepEqual(L.agents, { active: 9, max: null }, "core and retired agents are not counted; there is no total cap any more");
  assert.equal(L.agentsLabel, "AGENTS ACTIVE (no total cap; per department below)");
  assert.deepEqual(L.agentsByDepartment, [
    { dept: "App", active: 3, cap: 5, full: false }, { dept: "IT", active: 2, cap: 5, full: false },
    { dept: "Marketing", active: 2, cap: 5, full: false }, { dept: "Travel", active: 2, cap: 5, full: false },
  ], "active / cap per department; the retired agent is not counted");
  assert.deepEqual(L.workersPerManager, { largest: 2, max: 4 });
  assert.deepEqual(L.departments.map((d) => [d.dept, d.over]), [["App", false], ["Marketing", true]]);
  assert.equal(L.departments[1].pct, 100);
  assert.equal(Math.round(L.departments[0].pct), 18);
  assert.deepEqual(L.usage, { turns: 31, tokens: 184200, usd: 1.73 });
  assert.equal(L.known, true);
});

test("a department_caps override wins, and a full department is flagged", () => {
  const snap = { ...citySnapshot(T0) };
  snap.caps = { ...snap.caps, department_caps: { App: 3 } };
  const L = limits(applySnapshot(initialState(T0), snap, T0));
  assert.deepEqual(L.agentsByDepartment.find((d) => d.dept === "App"), { dept: "App", active: 3, cap: 3, full: true });
  assert.equal(L.agentsByDepartment.find((d) => d.dept === "IT").cap, 5);
});

test("a snapshot from before the restart (only max_concurrent_agents) still renders: no per-department cap is guessed", () => {
  const snap = { ...citySnapshot(T0), caps: { max_concurrent_agents: 10, max_workers_per_manager: 4, daily_spend_usd_per_department: 5, max_review_rounds: 3 } };
  const L = limits(applySnapshot(initialState(T0), snap, T0));
  assert.deepEqual(L.agents, { active: 9, max: 10 });
  assert.ok(L.agentsByDepartment.every((d) => d.cap === null && d.full === false));
  assert.equal(L.agentCapPerDepartment, null);
  assert.equal(L.agentsLabel, "AGENTS ACTIVE", "an old snapshot keeps the plain label");
});

test("limits never invent a cap the server did not send", () => {
  const L = limits(applySnapshot(initialState(T0), { agents: [], spend: { App: 99 }, usage: null }, T0));
  assert.equal(L.known, false);
  assert.equal(L.agents.max, null);
  assert.equal(L.departments[0].over, false);
  assert.equal(L.departments[0].pct, null);
  assert.equal(L.usage, null);
});

test("ticketGroups groups by status in a fixed order, oldest first, and tags stale after two hours", () => {
  const t = (id, status, createdAgo, updatedAgo) => ({ id, from: "x", to: "ios-dev", kind: "task", goal: id, status, created_at: new Date(T0 - createdAgo).toISOString(), updated_at: new Date(T0 - updatedAgo).toISOString() });
  const s = applySnapshot(initialState(T0), { agents: [], tickets: [t("a", "in_progress", H, 60_000), t("b", "in_progress", 5 * H, 3 * H), t("c", "open", 10_000, 10_000), t("d", "waiting_on_owner", H, 2 * H), t("e", "in_review", H, 2 * H + 1)] }, T0);
  const g = ticketGroups(s, T0);
  assert.deepEqual(g.map((x) => x.status), ["open", "in_progress", "in_review", "waiting_on_owner"]);
  assert.deepEqual(g[1].tickets.map((x) => x.id), ["b", "a"], "oldest first");
  assert.deepEqual(g.flatMap((x) => x.tickets).filter((x) => x.stale).map((x) => x.id), ["b", "e"], "exactly 2 h is not stale yet");
  assert.equal(g[1].tickets[0].ageMs, 5 * H);
  assert.equal(ticketGroups(initialState(T0), T0).every((x) => x.tickets.length === 0), true);
});

test("agentRows hides retired agents, splits out the core, and carries the current ticket and last-active age", () => {
  const snap = citySnapshot(T0);
  snap.agents.find((a) => a.id === "py-dev").state = "retired";
  snap.agents.find((a) => a.id === "ios-dev").last_active_at = new Date(T0 - 5 * 60_000).toISOString();
  const r = agentRows(applySnapshot(initialState(T0), snap, T0), T0);
  assert.deepEqual(r.core.map((x) => x.id), ["jarvis", "orchestrator", "secretary", "reviewer"]);
  assert.ok(!r.others.some((x) => x.id === "py-dev"));
  const ios = r.others.find((x) => x.id === "ios-dev");
  assert.equal(ios.goal, "Build the habit tracker screen");
  assert.equal(ios.department, "App");
  assert.equal(ios.modelName, "Sonnet");
  assert.equal(relTime(ios.lastActiveMs), "5 min ago");
  assert.equal(r.others.find((x) => x.id === "app-manager").goal, null);
});

test("relative times", () => {
  assert.equal(relTime(null), "—");
  assert.equal(relTime(20_000), "just now");
  assert.equal(relTime(2 * H), "2 h ago");
  assert.equal(relTime(50 * H), "2 d ago");
  assert.equal(ageText(90 * 60_000), "1 h");
  assert.equal(ageText(null), "—");
});

// ---- What the backend now reports ----
const dept = (name, extra = {}) => ({ key: name.toLowerCase(), name, mission: `${name} mission`, responsibilities: [], manager_id: null, skills: [], tools: [], autonomy: "standard", state: "active", created_at: new Date(T0 - 5000).toISOString(), updated_at: "", ...extra });

test("departments come from the registry, not from the agents, in the order they were created", () => {
  const snap = { agents: [agent("ghost", "worker", "Nowhere"), agent("a", "worker", "app")], departments: [dept("Later", { created_at: new Date(T0 - 1000).toISOString() }), dept("App", { created_at: new Date(T0 - 900_000).toISOString() }), dept("Gone", { state: "deleted" })] };
  const s = applySnapshot(initialState(T0), snap, T0);
  assert.deepEqual(departmentNames(s), ["App", "Later"], "the registry's list, oldest first; a deleted one and an agent's stray department are not departments");
  assert.equal(s.agents.a.department, "App", "an agent carries the registry's spelling");
  assert.ok(Object.values(s.departments).every((d) => d.builtAt <= T0 - 60000), "no construction animation for what already exists");
  assert.deepEqual(Object.keys(applySnapshot(initialState(T0), { agents: [agent("b", "worker", "Old")] }, T0).departments), ["Old"], "a server from before the registry still draws");
});

test("department.created and department.updated build, rename, archive and delete", () => {
  let s = applySnapshot(initialState(T0), { agents: [agent("mgr", "manager", "App")], departments: [dept("App")] }, T0);
  const builtAt = s.departments.App.builtAt;
  s = reduce(s, { type: "department.created", department: dept("Video") }, T0 + 1);
  assert.equal(s.departments.Video.builtAt, T0 + 1, "a new one gets its construction animation");
  assert.equal(s.feed[0].text, "Department Video created");
  // A hire can arrive before its department: the building appears once, and the registry entry fills it in.
  s = reduce(s, { type: "agent.hired", agent: agent("mgr2", "manager", "Ops"), revived: false }, T0 + 2);
  s = reduce(s, { type: "department.created", department: dept("Ops") }, T0 + 3);
  assert.equal(s.departments.Ops.builtAt, T0 + 2);
  assert.equal(s.departments.Ops.mission, "Ops mission");
  // A rename moves members without an event of their own and keeps the building's slot.
  s = reduce(s, { type: "department.updated", department: dept("Apps"), previous_key: "app" }, T0 + 4);
  assert.equal(s.departments.App, undefined);
  assert.equal(s.departments.Apps.builtAt, builtAt);
  assert.equal(s.agents.mgr.department, "Apps");
  assert.equal(s.feed[0].text, "Department App is now Apps");
  s = reduce(s, { type: "department.updated", department: dept("Video", { state: "archived" }) }, T0 + 5);
  assert.equal(s.feed[0].text, "Department Video: active → archived");
  assert.equal(layout(s).buildings.find((b) => b.dept === "Video").archived, true);
  assert.equal(departmentPanel(s, "Video").state, "archived");
  s = reduce(s, { type: "department.updated", department: dept("Video", { state: "deleted" }) }, T0 + 6);
  assert.equal(s.departments.Video, undefined);
});

test("worker.state is the truth for a worker; every lifecycle word shows as itself", () => {
  let s = initialState(T0);
  s = reduce(s, { type: "agent.hired", agent: agent("w", "worker", "IT", "m"), revived: false }, T0);
  s = reduce(s, { type: "ticket.status", ticket: ticket("t1", "w", "in_progress"), previous: null }, T0);
  assert.equal(agentStatus(s, "w"), "working", "before the first lifecycle event the ticket decides");
  const lines = s.feed.length;
  for (const st of ["requested", "hired", "assigned", "working", "idle"]) {
    s = reduce(s, { type: "worker.state", id: "w", state: st, previous: null }, T0);
    assert.equal(agentStatus(s, "w"), st);
  }
  assert.equal(s.feed.length, lines, "these show as hire and ticket lines already");
  for (const st of ["review", "completed", "failed", "paused", "cancelled"]) {
    s = reduce(s, { type: "worker.state", id: "w", state: st, previous: "working" }, T0);
    assert.equal(agentStatus(s, "w"), st);
    assert.equal(s.feed[0].text, `w: working → ${st}`);
  }
  s = reduce(s, { type: "worker.state", id: "w", state: "blocked", previous: "working" }, T0);
  assert.equal(agentStatus(s, "w"), "blocked");
  s = reduce(s, { type: "ticket.status", ticket: ticket("t1", "w", "waiting_on_owner"), previous: "in_progress" }, T0);
  assert.equal(agentStatus(s, "w"), "waiting_on_owner", "blocked on the owner keeps its question mark");
  assert.equal(reduce(s, { type: "worker.state", id: "nobody", state: "working", previous: null }), s, "no agent is made up");
});

test("a released worker stays findable as history, with its last ticket", () => {
  let s = applySnapshot(initialState(T0), { agents: [agent("m", "manager", "IT"), agent("w", "worker", "IT", "m", "claude-sonnet-5-5", { lifecycle: "temporary", worker_state: "completed" })], departments: [dept("IT")] }, T0);
  s = reduce(s, { type: "ticket.status", ticket: ticket("t9", "w", "done"), previous: "in_review" }, T0);
  s = reduce(s, { type: "worker.state", id: "w", state: "released", previous: "completed" }, T0);
  s = reduce(s, { type: "agent.retired", id: "w" }, T0);
  assert.equal(agentStatus(s, "w"), "released");
  assert.equal(s.feed[0].text, "w released");
  const d = departmentPanel(s, "IT");
  assert.deepEqual(d.workers, []);
  assert.deepEqual(d.released, [{ id: "w", role: "w" }]);
  assert.equal(agentPanel(s, "w").lastTicket, "t9");
  assert.equal(agentPanel(s, "w").status, "released");
});

test("the pause comes from the snapshot and the events, and a reset in the past is no pause", () => {
  const until = new Date(T0 + 3600_000).toISOString();
  let s = applySnapshot(initialState(T0), { agents: [], city: { paused_until: until, turns_running: 0, turns_waiting: 3 } }, T0);
  const g = gateStatus(s, T0);
  assert.deepEqual([g.known, g.running, g.waiting, g.paused.until, g.paused.inText, g.paused.reason], [true, 0, 3, Date.parse(until), "1 h", null]);
  assert.equal(g.paused.text.length, 5, "HH:MM");
  assert.equal(gateStatus(s, T0 + 3600_000).paused, null, "the gate lifts by itself at the reset");
  s = reduce(s, { type: "city.resumed" }, T0);
  assert.equal(gateStatus(s, T0).paused, null);
  assert.equal(gateStatus(s, T0).waiting, 3, "the counters are the last ones the server said");
  s = reduce(s, { type: "city.paused", until, reason: "You've hit your 5-hour limit" }, T0);
  assert.equal(gateStatus(s, T0).paused.reason, "You've hit your 5-hour limit");
  assert.match(s.feed[0].text, /City paused until \d\d:\d\d: You've hit/);
  s = applyLive(s, { city: { paused_until: until, turns_running: 1, turns_waiting: 2 } }, T0);
  assert.deepEqual([gateStatus(s, T0).running, gateStatus(s, T0).paused.reason], [1, "You've hit your 5-hour limit"], "a refresh keeps the reason only the event carried");
  const fresh = reduce(initialState(T0), { type: "city.paused", until, reason: "x" }, T0);
  assert.equal(gateStatus(fresh, T0).running, null, "never a made-up zero");
  assert.deepEqual([gateStatus(initialState(T0), T0).known, gateStatus(initialState(T0), T0).paused], [false, null], "an old server says nothing");
});

test("parked tickets leave the running board, and come back or vanish by the ticket events", () => {
  const [p1, p2] = cityParked(T0);
  let s = applySnapshot(initialState(T0), { agents: [], tickets: [ticket("t1", "w", "in_progress")], parked: [p2, p1] }, T0);
  assert.deepEqual(parkedRows(s, T0).map((t) => t.id), ["t-pk2", "t-pk1"], "oldest first");
  assert.equal(parkedRows(s, T0)[0].ageMs, 50 * 3600_000);
  s = reduce(s, { type: "ticket.status", ticket: { ...ticket("t1", "w", "parked") }, previous: "in_progress" }, T0);
  s = reduce(s, { type: "tickets.parked", ids: ["t1", "unknown"] }, T0);
  assert.equal(s.tickets.t1, undefined, "not counted as running");
  assert.equal(s.parked.t1.status, "parked");
  assert.equal(s.parked.unknown, undefined, "an id alone is no ticket: the next snapshot brings it");
  assert.equal(s.feed[0].text, "2 stale tickets parked; they wait for you");
  s = reduce(s, { type: "ticket.status", ticket: { ...p1, status: "in_progress" }, previous: "parked" }, T0);
  assert.equal(s.parked["t-pk1"], undefined);
  assert.equal(s.tickets["t-pk1"].status, "in_progress", "resumed");
  s = reduce(s, { type: "ticket.status", ticket: { ...p2, status: "cancelled" }, previous: "parked" }, T0);
  assert.equal(s.parked["t-pk2"], undefined);
  assert.equal(s.tickets["t-pk2"], undefined, "cancelled");
  assert.deepEqual(Object.keys(applyLive(s, { parked: [p1] }, T0).parked), ["t-pk1"], "the snapshot is the list");
  // Only a ticket.status arrived before the parked event: the same answer.
  const only = reduce(applySnapshot(initialState(T0), { agents: [], tickets: [ticket("t2", "w", "open")] }, T0), { type: "tickets.parked", ids: ["t2"] }, T0);
  assert.equal(only.parked.t2.status, "parked");
});

test("turn.failed and the question event go to the feed, once", () => {
  let s = reduce(initialState(T0), { type: "turn.failed", agent: "", ticket_id: null, error: "overloaded", retrying: true }, T0);
  assert.equal(s.feed[0].text, "A turn failed, retrying: overloaded");
  s = reduce(s, { type: "turn.failed", agent: "w", ticket_id: "t1", error: "boom", retrying: false }, T0);
  assert.equal(s.feed[0].text, "w failed: boom");
  const question = { ticket_id: "t1", asked_by: "w", path: "M › W", questions: [{ text: "Which?" }] };
  s = reduce(s, { type: "question.asked", id: "q1", question, ticket_id: "t1" }, T0);
  const lines = s.feed.length;
  assert.equal(reduce(s, { type: "question", id: "q1", question, ticket_id: "t1" }, T0), s, "the same question on its way to the owner");
  s = reduce(s, { type: "question", id: "q2", question, ticket_id: "t1" }, T0);
  assert.equal(topBar(s).questionsWaiting, 2, "re-sent after a restart: still known");
  assert.equal(s.feed.length, lines + 1);
});

test("a courier only moves for a real hand-over between two agents", () => {
  const t = (status, from = "m", to = "w") => ({ ...ticket("t1", to, status), from });
  assert.deepEqual(courierFor({ type: "ticket.status", ticket: t("open"), previous: null }), { from: "m", to: "w", kind: "ticket" });
  assert.deepEqual(courierFor({ type: "ticket.status", ticket: t("done"), previous: "in_review" }), { from: "w", to: "m", kind: "result" });
  assert.deepEqual(courierFor({ type: "ticket.status", ticket: t("failed"), previous: "in_progress" }), { from: "w", to: "m", kind: "result" });
  assert.equal(courierFor({ type: "ticket.status", ticket: t("in_progress"), previous: "open" }), null);
  assert.equal(courierFor({ type: "ticket.status", ticket: t("cancelled"), previous: "open" }), null);
  assert.equal(courierFor({ type: "ticket.status", ticket: t("open", "w"), previous: null }), null, "to itself");
  assert.equal(courierFor({ type: "agent.hired" }), null);
});

test("every dollar figure is marked as an estimate and an unknown stays a dash", () => {
  assert.equal(estUsd(1.726), "est. $1.73");
  assert.equal(estUsd(0.0314, 3), "est. $0.031");
  assert.equal(estUsd(null), "—");
  assert.equal(estUsd(undefined), "—");
});

test("the panels' readers: workforce groups, what an integration checked, a ticket's story", () => {
  const g = workforceGroups(cityWorkforce());
  assert.deepEqual(g.current.map((w) => w.id), ["ios-dev", "ads-writer"]);
  assert.deepEqual(g.released.map((w) => w.id), ["old-writer"]);
  assert.deepEqual(workforceGroups(null), { current: [], released: [] });
  const checks = cityIntegrations(T0).integrations.map((i) => checkText(i.check));
  assert.deepEqual(checks, ["gh auth status", "port 18789", "Keychain item jarvis.meta exists", "which blender", null]);
  assert.equal(checkText({ mcp: "figma" }), "claude mcp list: figma");
  assert.deepEqual(integrationGroups(cityIntegrations(T0).integrations).map((x) => [x.category, x.items.length]), [["development", 2], ["marketing", 1], ["video", 2]]);
  assert.deepEqual(integrationGroups(undefined), []);
  const lines = traceLines(cityTrace(T0));
  assert.deepEqual(lines.map((l) => l.text), [
    "app-manager sent ios-dev: Build the habit tracker screen", "ios-dev: open → in_progress", "ios-dev: a turn of 2100 tokens, est. $0.031",
    "ios-dev failed, retrying: overloaded", "App Manager › iOS Developer asked: SwiftData?",
  ], "the question is told once");
  assert.deepEqual(traceLines(undefined), []);
});
