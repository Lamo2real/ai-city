// Events in, scene state out: the City View's reducer and panel mappings, with no DOM and no three.js.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentRows, ageText, inboxItems, limits, relTime, ticketGroups, agentPanel, agentStatus, applySnapshot, departmentPanel, initialState, layout, propFor, reduce, topBar } from "../hud/city-state.js";
import { cityEvent, citySnapshot } from "./fixtures/city.js";

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
  assert.deepEqual(d, { name: "App", manager: "app-manager", workers: ["ios-dev"], openTickets: [{ id: "t1", goal: "Build the screen", status: "in_progress", to: "ios-dev" }], todayUsd: 0.9 });
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
