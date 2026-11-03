// Events in, scene state out: the City View's reducer and panel mappings, with no DOM and no three.js.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentPanel, agentStatus, applySnapshot, demoEvent, demoSnapshot, departmentPanel, initialState, layout, propFor, reduce, topBar } from "../hud/city-state.js";

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

test("the demo city is busy and its events loop without breaking the reducer", () => {
  let s = applySnapshot(initialState(T0), demoSnapshot(T0), T0);
  assert.ok(topBar(s).agentsTotal >= 8);
  assert.equal(layout(s).buildings.length, 4);
  for (let i = 0; i < 40; i++) s = reduce(s, demoEvent(i, T0 + i), T0 + i);
  assert.ok(s.feed.length > 10 && s.feed.length <= 40);
  assert.ok(Object.keys(s.departments).includes("Video"), "a demo hire builds a new department");
});
