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
  for (const a of agents) if (a.kind === "worker") a.worker_state = "working";
  agents.find((a) => a.id === "qa-tester").worker_state = "review";
  agents.find((a) => a.id === "ads-writer").worker_state = "blocked";
  const dept = (name, manager_id) => ({ key: name.toLowerCase(), name, mission: `${name} work`, responsibilities: [], manager_id, skills: [], tools: [], autonomy: "standard", state: "active", created_at: new Date(now - 3600_000).toISOString(), updated_at: new Date(now - 3600_000).toISOString() });
  const ticket = (id, to, goal, status) => ({ id, from: "orchestrator", to, kind: "task", goal, status, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() });
  return {
    agents,
    departments: [dept("App", "app-manager"), dept("IT", "it-manager"), dept("Marketing", "marketing-manager"), dept("Travel", "travel-manager")],
    parked: [],
    city: { paused_until: null, turns_running: 2, turns_waiting: 1 },
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

// Tickets the runtime parked: they wait for the owner.
export function cityParked(now = Date.now()) {
  const t = (id, to, goal, hours) => ({ id, from: "orchestrator", to, kind: "task", goal, status: "parked", created_at: new Date(now - hours * 3600_000).toISOString(), updated_at: new Date(now - hours * 3600_000).toISOString() });
  return [t("t-pk1", "ios-dev", "Finish the settings screen", 30), t("t-pk2", "py-dev", "<img src=x onerror=window.__xss=1> Rotate the logs", 50)];
}

// What GET /api/city/workforce answers.
export function cityWorkforce() {
  const w = (id, role, department, state, extra = {}) => ({ id, role, department, state, executor: "sdk", model: "claude-sonnet-5-5", assignment: null, completed: 0, failed: 0, success_rate: null, median_completion_ms: null, busy_ms: 0, cost_usd: 0, ...extra });
  return {
    totals: { hired_ever: 3, active: 2, working: 1, in_review: 0, blocked: 1, released: 1, failed: 0 },
    workers: [
      w("ios-dev", "iOS Developer", "App", "working", { assignment: "Build the habit tracker screen", completed: 3, failed: 1, success_rate: 0.75, median_completion_ms: 240_000, busy_ms: 720_000, cost_usd: 0.42 }),
      w("ads-writer", "Ads Writer", "Marketing", "blocked", { executor: "openclaw", assignment: "Draft the spring campaign" }),
      w("old-writer", "Copywriter", "Marketing", "released", { completed: 2, success_rate: 1, median_completion_ms: 60_000, busy_ms: 90_000, cost_usd: 0.1 }),
    ],
  };
}

// What GET /api/city/costs answers.
export function cityCosts() {
  const u = (usd, tokens, turns) => ({ usd, tokens, turns });
  return {
    estimated: true,
    note: "Estimated value at API list prices. On the Claude subscription this is not a charge.",
    today: u(1.73, 184200, 31), month: u(12.5, 900000, 210),
    by_model: { "claude-sonnet-5-5": u(9, 700000, 180), "claude-opus-5-5": u(3.5, 200000, 30) },
    by_department: { App: u(8, 600000, 150), HQ: u(4.5, 300000, 60) },
    by_agent: { "ios-dev": u(6, 500000, 120) },
    by_ticket: [{ ticket_id: "t-fx1", usd: 2.5, tokens: 90000, turns: 12 }],
    done_tickets: 5, failed_tickets: 1, usd_per_done_ticket: 2.5,
  };
}

// What GET /api/city/health answers.
export function cityHealth(now = Date.now()) {
  return { paused_until: null, turns_running: 2, turns_waiting: 1, tickets_open: 4, tickets_stale: [], tickets_parked: 2, tickets_waiting_on_owner: 1, failed_today: 0, last_model_turn: new Date(now - 120_000).toISOString(), active_agents: 9 };
}

// What GET /api/city/integrations answers. The check is what the probe looked at.
export function cityIntegrations(now = Date.now()) {
  return {
    checked_at: new Date(now - 60_000).toISOString(),
    integrations: [
      { name: "GitHub CLI", category: "development", status: "operational", detail: "gh auth status succeeded", check: { command: ["gh", "auth", "status"] } },
      { name: "OpenClaw gateway", category: "development", status: "available", detail: "nothing listening on 18789", check: { port: 18789 }, note: "Only needed for Telegram and scheduled automations; workers run without it." },
      { name: "Meta Ads", category: "marketing", status: "needs_owner", detail: "Keychain item jarvis.meta is missing", check: { keychain: "jarvis.meta" } },
      { name: "Blender", category: "video", status: "unavailable", detail: "blender is not installed", check: { bin: "blender" } },
      { name: "Mystery", category: "video", status: "unknown", detail: "no check defined", check: {} },
    ],
  };
}

// What GET /api/city/trace answers: the recorded events of one ticket, oldest first.
export function cityTrace(now = Date.now()) {
  const at = (s) => new Date(now - s * 1000).toISOString();
  const t = (status) => ({ id: "t-fx1", from: "app-manager", to: "ios-dev", goal: "Build the habit tracker screen", status });
  return [
    { at: at(300), type: "ticket.status", ticket: t("open"), previous: null },
    { at: at(290), type: "ticket.status", ticket: t("in_progress"), previous: "open" },
    { at: at(120), type: "cost.update", agent: "ios-dev", ticket_id: "t-fx1", usd: 0.031, tokens: 2100, today: {} },
    { at: at(60), type: "turn.failed", agent: "ios-dev", ticket_id: "t-fx1", error: "overloaded", retrying: true },
    { at: at(30), type: "question.asked", id: "q1", ticket_id: "t-fx1", question: { path: "App Manager › iOS Developer", questions: [{ text: "SwiftData?" }] } },
    { at: at(30), type: "question", id: "q1", ticket_id: "t-fx1", question: { path: "App Manager › iOS Developer", questions: [{ text: "SwiftData?" }] } },
  ];
}

// A city at full tilt: one figure for every mark the map can show, plus people at home. `extraDepartments` adds offices.
export function cityBusy(now = Date.now(), extraDepartments = 0) {
  const iso = new Date(now).toISOString();
  const agent = (id, role, kind, department, parent, extra = {}) => ({ id, role, kind, department, parent, model: kind === "manager" ? "claude-opus-5-5" : "claude-sonnet-5-5", tools: [], lifecycle: "temporary", state: "active", created_at: iso, last_active_at: iso, total_cost_usd: 0.12, ...extra });
  const core = [["jarvis", "Jarvis", "claude-haiku-5-5"], ["orchestrator", "Orchestrator", "claude-opus-5-5"], ["secretary", "Executive Secretary", "claude-sonnet-5-5"], ["reviewer", "Reviewer Gate", "claude-fable-5-1"]].map(([id, role, model]) => agent(id, role, "core", undefined, "owner", { model, lifecycle: "persistent" }));
  const names = ["App", "IT", "Marketing", "Travel", "Finance", "Video", "Legal", "Research", "Support", "Design", "Data", "Ops"].slice(0, 4 + extraDepartments);
  const dept = (name, i) => ({ key: name.toLowerCase(), name, mission: `${name} work`, responsibilities: [], manager_id: `${name.toLowerCase()}-manager`, skills: [], tools: [], autonomy: "standard", state: "active", created_at: new Date(now - 7200_000 + i).toISOString(), updated_at: iso });
  const worker = (id, role, department, worker_state = "working", extra = {}) => agent(id, role, "worker", department, `${department.toLowerCase()}-manager`, { worker_state, ...extra });
  const agents = [...core, ...names.map((n) => agent(`${n.toLowerCase()}-manager`, `${n} Manager`, "manager", n, "orchestrator", { lifecycle: "persistent" })),
    worker("ios-dev", "iOS Developer", "App", "working", { skills: ["swift"] }), worker("qa-tester", "QA Tester", "App", "review"), worker("docs-reader", "Docs Reader", "App"), worker("web-dev", "Web Developer", "App", "completed", { awaiting_merge: { branch: "feat/web-login", repo: "booqy/web", ticket_id: "t-old", since: new Date(now - 1800_000).toISOString() } }),
    worker("py-dev", "Python Developer", "IT"), worker("sre", "Site Reliability", "IT", "failed"), worker("db-admin", "Database Admin", "IT", "blocked"), worker("net-admin", "Network Admin", "IT", "paused"),
    worker("ads-writer", "Ads Writer", "Marketing", "blocked"), worker("seo", "SEO Researcher", "Marketing", "working", { skills: ["growth"] }), worker("analyst", "Campaign Analyst", "Marketing"), worker("recruit", "Recruiter", "Marketing"),
    worker("flights", "Flights worker", "Travel"), worker("hotels", "Hotels worker", "Travel"), worker("guide", "Travel Guide", "Travel"), worker("visa", "Visa Clerk", "Travel"),
    agent("old-writer", "Copywriter", "worker", "Marketing", "marketing-manager", { state: "retired", worker_state: "released" }), agent("old-cutter", "Video Cutter", "worker", "App", "app-manager", { state: "retired", worker_state: "released" }), agent("old-scout", "Hotel Scout", "worker", "Travel", "travel-manager", { state: "retired", worker_state: "released" }),
  ];
  const ticket = (id, to, goal, status = "in_progress", from = "orchestrator") => ({ id, from, to, kind: "task", goal, status, created_at: iso, updated_at: iso });
  const on = ["ios-dev", "docs-reader", "py-dev", "seo", "analyst", "recruit", "flights", "hotels", "guide", "visa", "net-admin", "sre", "db-admin"];
  const tickets = [...on.map((id) => ticket(`t-${id}`, id, `Work for ${id}`)), ticket("t-qa", "qa-tester", "Run the simulator tests", "in_review"), ticket("t-ads", "ads-writer", "Draft the spring campaign", "waiting_on_owner"), ...["app", "it", "marketing"].map((d) => ticket(`t-${d}`, `${d}-manager`, `Lead the ${d} work`))];
  const act = (activity, detail = "") => ({ activity, detail, ticket_id: null, at: iso });
  const activities = { jarvis: act("understanding"), orchestrator: act("delegating", "to app-manager"), secretary: act("summarizing"), reviewer: act("reviewing", "t-qa"), "app-manager": act("hiring"), "it-manager": act("waiting_team"), "marketing-manager": act("answering"), "ios-dev": act("coding", "Sources/Habit.swift"), "docs-reader": act("reading", "docs/ARCHITECTURE.md"), "py-dev": act("running", "npm test"), seo: act("researching", "spring trends"), analyst: act("browsing", "https://example.com"), recruit: act("remembering"), flights: act("working"), hotels: act("reporting"), guide: act("asking"), visa: act("idle") };
  return { agents, activities, departments: names.map(dept), parked: [], city: { paused_until: null, turns_running: 6, turns_waiting: 2 }, tickets, questions: [{ id: "q-busy", status: "open", created_at: iso, question: { ticket_id: "t-ads", asked_by: "ads-writer", path: "Marketing Manager › Ads Writer", questions: [{ text: "Daily budget: 20 or 40 euro?", options: ["20", "40"], default: "20" }] } }], usage: { usd: 3.4, tokens: 412000, turns: 74 }, spend: { App: 1.2, IT: 0.6, Marketing: 0.9, Travel: 0.7 }, caps: { max_active_agents_per_department: 5, department_caps: {}, max_workers_per_manager: 4, daily_spend_usd_per_department: 5, max_review_rounds: 3 } };
}

// A city with only its core: no departments, nobody hired, nothing open.
export function cityEmpty(now = Date.now()) {
  const busy = cityBusy(now);
  return { ...busy, agents: busy.agents.filter((a) => a.kind === "core"), activities: {}, departments: [], tickets: [], questions: [], spend: {}, usage: { usd: 0, tokens: 0, turns: 0 }, city: { paused_until: null, turns_running: 0, turns_waiting: 0 } };
}
