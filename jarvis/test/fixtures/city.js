// Test-only fixtures for the City View tests. Not under jarvis/hud, so the server never serves them.

// Test fixture only: a busy city, as plain data. Never served to the HUD.
export function citySnapshot(now = Date.now()) {
  const agent = (id, role, kind, department, parent, model, extra = {}) => ({ id, role, kind, department, parent, model, tools: [], lifecycle: "persistent", state: "active", created_at: new Date(now).toISOString(), last_active_at: new Date(now).toISOString(), total_cost_usd: 0.42, ...extra });
  const core = ["jarvis", "orchestrator", "secretary", "reviewer"].map((id, i) => agent(id, id, "core", undefined, "owner", ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"][i]));
  const agents = [...core,
    agent("app-manager", "App Manager", "manager", "App", "orchestrator", "claude-opus-5-5"),
    agent("ios-dev", "iOS Developer", "worker", "App", "app-manager", "claude-sonnet-5-5", { skills: ["swift"] }),
    agent("qa-tester", "QA Tester", "worker", "App", "app-manager", "claude-sonnet-5-5", { skills: ["simulator tests"] }),
    agent("it-manager", "IT Manager", "manager", "IT", "orchestrator", "claude-opus-5-5"),
    agent("py-dev", "Python Developer", "worker", "IT", "it-manager", "claude-sonnet-5-5"),
    agent("marketing-manager", "Marketing Manager", "manager", "Marketing", "orchestrator", "claude-sonnet-5-5"),
    agent("ads-writer", "Ads Writer", "worker", "Marketing", "marketing-manager", "claude-sonnet-5-5", { skills: ["meta ads"] }),
    agent("travel-manager", "Travel Manager", "manager", "Travel", "orchestrator", "claude-sonnet-5-5", { lifecycle: "temporary" }),
    agent("flights", "Flights worker", "worker", "Travel", "travel-manager", "claude-sonnet-5-5", { lifecycle: "temporary" }),
  ];
  const ticket = (id, to, goal, status) => ({ id, from: "orchestrator", to, kind: "task", goal, status, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() });
  return {
    agents,
    tickets: [ticket("t-fx1", "ios-dev", "Build the habit tracker screen", "in_progress"), ticket("t-fx2", "qa-tester", "Run the simulator tests", "in_review"), ticket("t-fx3", "py-dev", "Hello-world CLI", "in_progress"), ticket("t-fx4", "ads-writer", "Draft the spring campaign", "waiting_on_owner"), ticket("t-fx5", "flights", "Find flights to Innsbruck", "in_progress")],
    questions: [{ id: "q-fx1", status: "open", created_at: new Date(now).toISOString(), question: { ticket_id: "t-fx4", asked_by: "ads-writer", path: "Marketing Manager › Ads Writer", questions: [{ text: "Daily budget: 20 or 40 euro?", options: ["20", "40"], default: "20" }] } }],
    usage: { usd: 1.73, tokens: 184200, turns: 31 },
    spend: { App: 0.91, IT: 0.22, Marketing: 0.4, Travel: 0.2 },
    caps: { max_active_agents_per_department: 5, department_caps: {}, max_workers_per_manager: 4, daily_spend_usd_per_department: 5, max_review_rounds: 3 },
  };
}

// A loop of events for the reducer tests.
export function cityEvent(i, now = Date.now()) {
  const steps = [
    { type: "ticket.status", ticket: { id: "t-fx3", from: "it-manager", to: "py-dev", kind: "task", goal: "Hello-world CLI", status: "done", created_at: "", updated_at: new Date(now).toISOString() }, previous: "in_progress" },
    { type: "review.started", ticket_id: "t-fx1", round: 1, by: "orchestrator" },
    { type: "review.result", ticket_id: "t-fx1", round: 1, verdict: "FAIL", summary: "tests failed on the habit screen", checks: [] },
    { type: "question.answered", id: "q-fx1", answer: "20", answered_by: "owner", ticket_id: "t-fx4" },
    { type: "ticket.status", ticket: { id: "t-fx4", from: "marketing-manager", to: "ads-writer", kind: "task", goal: "Draft the spring campaign", status: "in_progress", created_at: "", updated_at: new Date(now).toISOString() }, previous: "waiting_on_owner" },
    { type: "agent.hired", revived: false, agent: { id: "video-editor", role: "Video Editor", kind: "worker", department: "Video", parent: "orchestrator", model: "claude-sonnet-5-5", tools: [], skills: ["ffmpeg"], lifecycle: "temporary", state: "active", created_at: "", last_active_at: "", total_cost_usd: 0 } },
    { type: "cost.update", agent: "ios-dev", ticket_id: "t-fx1", usd: 0.03, tokens: 2100, today: { usd: 1.76, tokens: 186300, turns: 32 } },
    { type: "ticket.status", ticket: { id: "t-fx3", from: "it-manager", to: "py-dev", kind: "task", goal: "Hello-world CLI", status: "in_progress", created_at: "", updated_at: new Date(now).toISOString() }, previous: null },
    { type: "question.asked", id: "q-fx2", ticket_id: "t-fx5", question: { ticket_id: "t-fx5", asked_by: "flights", path: "Travel Manager › Flights worker", questions: [{ text: "Morning or evening flight?", options: ["morning", "evening"], default: "morning" }] } },
    { type: "agent.retired", id: "video-editor" },
    { type: "review.result", ticket_id: "t-fx1", round: 2, verdict: "PASS", summary: "clean", checks: [] },
  ];
  return steps[i % steps.length];
}
