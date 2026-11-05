# Capability gaps

Written 2026-11-04 against the code on branch `feat/openclaw-nervous-system` (commit `b82cab3`). One row per section of the owner's directive. The directive's own text is not in the repo, so the sections are taken from the task brief, and "done" means "the code does what the section's name asks", judged by reading the code. It does not mean "proven in a live run". Live results belong in the Acceptance tests table of `docs/ROADMAP.md`.

Scale: **done** = implemented and covered by a test in `city/test/`; **partial** = implemented in part, or implemented without evidence it works live; **not done** = absent.

Unit tests in `city/test/` use a fake runner. They show that the logic behaves as written, not that a model behaves well inside it.

## Summary

| # | Section | Status |
|---|---|---|
| 1 | Dynamic departments | done |
| 2 | Workforce | partial |
| 3 | Orchestration | partial |
| 4 | Memory | partial |
| 5 | Skills | partial |
| 6 | MCP and tools | not done for city agents, partial overall |
| 7 | Claude Code | done |
| 8 | Computer and browser control | partial |
| 9 | Proactive automation | partial |
| 10 | Model routing and cost | partial |
| 11 | Workflow engine | partial |
| 12 | Voice | partial |
| 13 | Security | partial |
| 14 | City visualization | partial |
| 15 | Observability | done |
| 16 | Evals and self-improvement | partial |

## 1. Dynamic departments: done

Evidence:
- `createDepartment` and `updateDepartment` in `city/src/runtime.ts`; the `departments` table in `city/src/ledger.ts`; `schemas/department.schema.json`.
- Duplicate prevention: `findOverlap` in `city/src/departments.ts` refuses a department whose key equals an existing one or whose name, mission and responsibilities overlap an existing one by 0.6 or more (shared words over the shorter word set). `force: true` overrides a similar-but-different match, never an identical key. An archived match is refused with a pointer to reactivate it.
- Rename, expand, archive (releases workers, retires the manager), reactivate (revives the manager), delete (only after archive). A department with open tickets cannot be archived or deleted.
- Per-department cap (`departmentCap`), per-department autonomy (`read_only`, `standard`, `supervised`), per-department skills and tools.
- Departments from an older install are registered at start (`ensureDepartment`).
- Test: `organization.test.ts` ("department: created with its manager and memory; a near-duplicate is refused; rename, archive, reactivate and ...").

Gaps:
- Overlap is word overlap, not meaning. Two differently worded departments that do the same job pass.
- `config/automations.json` and the workflows name departments (Engineering, Finance, Sales, Infrastructure, Support, Marketing) that nothing creates automatically. `startWorkflow` refuses to start if one has no active manager. `ingestEvent` falls back to the Orchestrator.
- Department `tools` are stored, but `hire` carries a comment that tools are not checked against a per-department allowlist.

## 2. Workforce: partial

Evidence:
- Worker lifecycle table in `city/src/lifecycle.ts`, applied by `setWorker` in `runtime.ts`: hired, assigned, working, review, completed, released, plus idle, blocked, failed, cancelled. An impossible move is logged and ignored.
- Temporary workers are released after the manager accepts (`acceptWorker`, `releaseWorker`): session cleared, row, tickets, costs and memory kept. A later hire of the same id revives it.
- `workforce()` in `city/src/observability.ts` reports per worker: state, assignment, completed, failed, success rate, median completion time, busy time, cost.
- Duplicate hires refused: same role with nothing to do under the same manager; `max_workers_per_manager` (4); department cap (5).
- Tests: `organization.test.ts` (lifecycle, manager sends work back, cancel), `automation.test.ts` (workforce view).

Gaps:
- `idle_retire_minutes` is in the spec and stored, and nothing reads it. Persistent idle workers are never retired by time.
- The states `requested` and `paused` exist in the table and are never entered by the runtime.
- A worker's success rate counts tickets done or failed. A ticket a worker was reminded about and then dropped counts as failed with the agent's last words, not with a cause.

## 3. Orchestration: partial

Evidence:
- `depends_on` ordering with handoffs: a dependent ticket waits, gets the results and artifacts of what it waited for, and fails with a reason if a dependency fails (`advanceDependents`, `handoffs`). Independent tickets run in parallel up to `max_concurrent_turns`.
- Reviewer Gate with automated checks first (`requestReview`, `city/src/checks.ts`), fix tickets, escalation after 3 rounds.
- Per-ticket git worktrees: `allocateWorkspace` in `city/src/workspaces.ts`, reachable as the `allocate_workspace` tool. Limited to `repos_roots` (`~/projects`, `/tmp`), never `main` or `master`, refuses a path that is not a repository top.
- `cancel_ticket` cancels a ticket, everything split from it, and aborts running turns.
- Recovery after a crash: `resume()`, with stale tickets parked.
- Questions go to the parent first, then the owner; `@agent-id` direct instructions with the manager cc'd.
- Tests: `organization.test.ts`, `runtime.test.ts`, `sessions.test.ts`.

Gaps:
- A worktree exists only if an agent calls `allocate_workspace`. Nothing allocates one automatically.
- `releaseWorkspace` is exported, imported in `runtime.ts` and never called. Worktrees are not removed by the runtime. The unit test calls it directly.
- How a goal is split into tickets is the Orchestrator's prompt, not code. Nothing checks that the split is good.
- The Orchestrator's own session is one of the few that accumulates context across many tickets; it is rotated by compaction, not by ticket.

## 4. Memory: partial

Evidence:
- `city/src/memory.ts`: SQLite FTS5 with the porter tokenizer, in the ledger's file. Five scopes (agent, department, project, organization, jarvis), visibility decided in `scopesFor`. Ranked by BM25 plus a recency term that fades over 30 days. Repeated facts are merged (word overlap 0.9). Text matching an API-key pattern is refused. Queries are reduced to words so a model cannot reach FTS5 syntax.
- Retrieval is automatic at dispatch (`memory.contextFor`, up to four short lines marked as data) and on request (`recall`).
- Writes: `remember` tool (workers cannot write organization scope), the department charter at creation, and the accepted deliverable of a worker.
- The HUD route `/api/city/memory` recalls as the owner, with secrets scrubbed in the response.
- Tests: `organization.test.ts` ("memory: scoped, ranked, deduplicated, and never holds a secret"; "a fresh ticket starts with what the department remembers ...").

Gaps:
- Keyword retrieval only. The file says so: pure synonyms are missed, and embeddings were left out because they need a paid provider or a local model.
- No expiry, pruning or consolidation. `hits` is counted and not used for ranking.
- The secret filter covers four key shapes (`sk-`, `gh*_`, `xox*-`, `AKIA`). Other credentials would be stored.
- Nothing measures whether recalled memory improves results.

## 5. Skills: partial

Evidence:
- `skills/` holds 19 folders with a `SKILL.md`: advertising, aws, backend-api, customer-support, database-engineering, financial-reporting, git-code-review, incident-response, market-research, operations, python, sales-outreach, security-review, seo-content, software-architecture, terraform-cicd, testing-debugging, typescript-react.
- Their `covers:` lines hold 47 distinct entries (counted by splitting on commas and de-duplicating). I could not check that against the directive's list of 47 areas, because that text is not in the repo.
- Mechanism (`city/src/agents.ts`): a spec's or a department's `skills` list puts one line per skill in the prompt; the body is read with `read_skill`. `create_department` refuses an unknown skill name. `list_skills` and `/api/city/skills` list them.
- Test: `organization.test.ts` ("skills: a listed skill reaches the prompt as one line and is read on demand; an unknown one is refused at creation").

Gaps:
- No third-party skills are installed. This is deliberate; `skills/README.md` gives the review rule.
- Agents cannot write or propose skills in code; the README says to propose in a report.
- A skill is text. Nothing measures whether a skill changes an agent's work.
- Jarvis, the Secretary and the Reviewer have no `read_skill`; every manager, every worker and the Orchestrator do.

## 6. MCP and tools: not done for city agents, partial overall

Evidence:
- The SDK runner (`city/src/sdk.ts`) passes the in-process `jarvis` server, plus any server in `mcp_servers` in `config/policy.json` for the agents listed there, with `strictMcpConfig: true` and `settingSources: []`. Today that is `personal-assistant`, for Jarvis alone.
- The city's own tools (24 of them, defined in `toolsFor` in `runtime.ts`): `hire_agent`, `retire_agent`, `list_registry`, `send_ticket`, `ask_user`, `request_review`, `review_deliverable`, `cancel_ticket`, `create_department`, `update_department`, `list_departments`, `remember`, `recall`, `list_skills`, `read_skill`, `allocate_workspace`, `list_workflows`, `start_workflow`, `report`, `reset_session` (Orchestrator only), `ask_colleague` (workers only), and `city_status`, `agent_status`, `ask_agent` (Jarvis only). Each agent gets the subset its prompt lists.
- `config/integrations.json` and `probeIntegrations` report what is installed or signed in. Status words are `operational` (a real probe answered), `authenticated` (credential present, not exercised), `available`, `unavailable`, `needs_owner`, `unknown`. A probe never reads a secret's value.
- OpenClaw workers get `city_*` tools through the plugin and native tools by capability.

Gaps:
- Jarvis's `personal-assistant` tools work, confirmed with a live call on 2026-11-04. Other departments have no outside servers yet.
- The `.mcp.json` servers (github, terraform, meta-ads, playwright) serve the interactive Claude Code in this repo, not the city. Terraform's server also needs Docker, which is not installed.
- OpenClaw runs load no MCP servers (`plugins.allow` lists only `city-bridge`, `anthropic` and, with the browser capability, `browser`).
- The morning report lists MCP servers needing sign-in (Slack, Stripe, Microsoft 365 and others). None are usable by the city.

## 7. Claude Code: done

Evidence:
- Both executors are Claude Code underneath. The SDK runner uses `@anthropic-ai/claude-agent-sdk` 0.3.317 (one resumable session per agent and ticket). The OpenClaw runner sets `agentRuntime: claude-cli` for `anthropic/*`, so OpenClaw drives the `claude` CLI.
- Workers get the built-in tools their spec and template list (`Read`, `Edit`, `Bash(...)` patterns), bounded by the policy gate.
- Compaction uses the CLI's own `/compact` first (`compact` in `runtime.ts`).
- Subscription login only: `city/src/auth.ts`.

Gaps: none specific to this section beyond those in sections 6 and 13.

## 8. Computer and browser control: partial

Evidence:
- `CAPABILITY_TOOLS` and `CAPABILITY_CALLS` in `city/src/openclaw.ts` map capabilities `shell`, `files`, `browser`, `web` and `desktop` to tools. `desktop` means `osascript` and `open` through `exec`, so the policy gate sees every command. The `browser` capability turns OpenClaw's browser plugin on for that run only.
- OpenClaw's `computer` tool is on the permanent deny list.
- Test: `openclaw.test.ts` covers the capability table, the config, the bridge and the argument list, with a fake process.
- Per the coordinating session (not verified by me): live test 6 passed for shell; the browser path was still being fixed.

Gaps:
- No OS sandbox, by the owner's decision on 2026-11-04.
- Until 2026-11-04 the policy rules for force-push, push to main, `rm -rf`, `terraform destroy` and the others matched `Bash` only, so they did not cover `exec`, the OpenClaw shell. They now match `Bash`, `exec` and `bash`, with test cases for each. They are still regexes over the command text.
- `desktop` is `exec` plus `osascript`; there is no screen-reading or click tool. Screenshots and UI automation beyond what a script can do are not available.
- The browser works in a live run with an isolated, headless profile, and its SSRF policy refused a loopback address. The first tab after Chrome starts can vanish, so the run's instructions tell the worker to open the page again. `desktop` was not exercised live.

## 9. Proactive automation: partial

Evidence:
- `ingestEvent` in `runtime.ts` plus `POST /api/city/events` (`jarvis/server/server.js`) and routes in `config/automations.json` for `briefing.daily`, `github.run_failed`, `city.tickets_failed`, `stripe.*`, `lead.*`, `aws.alarm`, `support.*`. The same event within the same hour (or with the same `idempotency_key`) is one ticket (`ev-<hash>`). Event data is wrapped as untrusted and cut to 2,000 characters.
- `jarvis/bin/city-event`: `emit`, `briefing`, `watch-github` (uses `gh run list`), `watch-failures`. Checking costs no model call; a model turn happens only when an event is actually sent.
- `jarvis/bin/city-automations`: `list`, `enable`, `disable` for three schedules (daily briefing 07:00, GitHub failures every 30 minutes, failed tickets hourly), installed into OpenClaw's cron.
- Test: `automation.test.ts` ("an event reaches the owning department once, as quoted data ...").

Gaps:
- Schedules run as LaunchAgents through `jarvis/bin/city-automations`, by the owner's choice on 2026-11-05. The OpenClaw Gateway is no longer needed for them.
- Inbound webhooks are not supported: they need public exposure, which the owner has forbidden. Stripe, lead, AWS and support routes exist but nothing sends those events except a manual local POST.
- `POST /api/city/events` has no token of its own; it relies on the server's loopback binding and host check.
- The `watch-github` repo list holds one repository.
- Routes to departments that do not exist go to the Orchestrator, which then decides.

## 10. Model routing and cost: partial

Evidence:
- Routing (`config/policy.json`, `modelFor` in `runtime.ts`): a ticket's `complexity` picks haiku, sonnet or opus for workers; a fallback chain (fable to opus to sonnet to haiku) is passed to both executors; core agents' models come from their prompt files; `JARVIS_MODEL_CAP` caps everything for smoke tests.
- Cost accounting (`recordTurn` in `ledger.ts`): the SDK's `total_cost_usd` is cumulative per resumed session, so a baseline per `<agent>:<session>` turns it into a per-turn delta. Rows from the migration are marked `estimated = 1` and keep the old value in `raw_usd`. The ledger warns on a single turn over $20.
- `costReport()` groups by model, department, agent and ticket, by month, and says `estimated: true`. `/api/city/costs` serves it.
- OpenClaw turns: the envelope's `costUsd`, else tokens times the prices in `policy.json` (`estimateUsd`).
- Tests: `ledger.test.ts` (17), `organization.test.ts` ("costs: broken down by model ...").

Gaps:
- The daily spend cap (`daily_spend_usd_per_department`, 20) is checked only in `hire`. A hired agent can keep working past it. `Ticket.budget_usd` and the spec's `budget_usd_per_day` are not enforced.
- The unmerged branches `fix/turn-spend-limit` and `chore/remove-cost-caps` touch exactly this. See the branch list in `docs/ROADMAP.md`.
- The prices in `config/policy.json` were not checked against Anthropic's price list.
- All figures are estimates at API list prices, not charges. The earlier inflated figure came from summing a cumulative total on every turn; the delta fix is in this branch's ledger.
- For OpenClaw runs the baseline logic assumes the reported cost is cumulative for the session id. If a run ever reports the same session id twice with per-run costs, deltas would be wrong. I did not check whether the CLI does that.
- "Today" is the UTC day.

## 11. Workflow engine: partial

Evidence:
- `config/workflows/`: `software-delivery`, `marketing-campaign`, `sales-pipeline`, `infrastructure-incident`, each ending in an owner approval step before the final action. `checkWorkflow` validates the whole shape before any ticket exists (unique ids, dependencies point backwards so there are no cycles, a department and a goal or an approval).
- `startWorkflow` resolves every department and input first; a missing one starts nothing. Steps become tickets with `depends_on`, a shared `project` and the step's `complexity`. State, recovery and history are the ledger's.
- An approval step is a ticket with `gate: true`; answering approve completes it, anything else fails it and its dependents. It survives a restart.
- Tools `list_workflows`, `start_workflow`; routes `/api/city/workflows`, `/api/city/workflows/start`.
- Test: `automation.test.ts` ("a workflow runs in order, waits at its approval step, continues on approve and stops on deny; state survives a restart").

Gaps:
- A directed acyclic graph of tickets only. No loops, no conditions, no retry of one step, no fan-out over a list.
- A failed step fails everything after it.
- Departments must exist first.
- Approval parsing: the owner's free-text answer counts as approval if it starts with approve, approved, yes, ok, okay or go ahead (`AUTO_APPROVE_WORD`). "yes, but not the second one" would be read as approval.
- No workflow-level status view; the tickets share a `project` id, which is the only grouping.
- Lobster is not used; see the limits in `docs/ARCHITECTURE.md`.

## 12. Voice: partial

Evidence:
- `jarvis/voice/` (Python 3.12, uv): clause aggregator, barge-in handling, a Haiku long-turn summary, offline fallback wired through a Pipecat service switcher, per-turn latency log, and a session client for the shared `owner` conversation. Unit tests run without audio (`uv run pytest`). Config in `config/voice.json`.
- `jarvis/voice/tests/smoke_graph.py` runs the whole graph on synthetic speech from `say`, with no devices. Measured: about 900 ms to first audio with a scripted Jarvis and Kokoro, 6.4 s on one turn with a real Jarvis.
- The HUD's existing speech path (`jarvis/bin/jarvis-say` and the server's voice route) is separate from the Pipecat pipeline.
- Typed and spoken turns share one Jarvis session.

Gaps:
- The pipeline has not run against a microphone, a speaker or Cartesia. The README marks every audio check unverified and needing the owner.
- `jarvis.cartesia` is not in the Keychain and `config/voice.json` still has a placeholder Cartesia voice id. The owner adds both.
- First audio misses the 800 ms target: a Jarvis server turn took 5.4 to 10.7 s to its first sentence.
- Echo cancellation through macOS voice processing is built but has never run on real devices (`jarvis/voice/README.md` has the by-ear check). Backchannels over 300 ms stop playback because MLX Whisper is not streaming.
- Not checked in this review: whether the old HUD voice path works today.

## 13. Security: partial

Evidence:
- Billing guard: `ANTHROPIC_API_KEY` is refused (`city/src/auth.ts`); the OpenClaw runner strips both key and token.
- Policy gate on every tool call for every executor; audit log of every decision with the acting agent (`audit`, `/api/city/audit`).
- Approvals for gated actions, bound to the exact call, single use, not approvable by a relayed message.
- Autonomy levels per department.
- Per-run bridge: loopback only, token per run, destroyed with the run; the plugin refuses a non-loopback URL and blocks on any failure.
- OpenClaw pinned config per run: minimal profile, deny list, no elevated tools, mDNS off. OpenClaw Telegram relay config tested to fail if its settings loosen (`jarvis/openclaw/test`).
- Files are private: ledger and events log 0600, directories 0700.
- Event data and memory are marked as untrusted data in prompts. Secrets are scrubbed from HUD responses (`scrubDeep`).
- Policy rules: Keychain access denied, force-push denied, push to main denied, publishing, payments, cloud deletes, destructive SQL, public video and activating ads need the owner.

Gaps:
- Policy rules are regular expressions over the JSON of the tool input, applied to `Bash`, `exec`, `bash` and `process`. A command can be written in a way a regex does not see, such as a script file. The OS sandbox covers OpenClaw shell runs; default-executor workers have only these rules and a text check.
- No OS sandbox, by the owner's decision: see the computer control section above.
- Prompt injection defence is prompt text ("treat as data") plus the tool-layer limits above. There is no classifier or content filter.
- The policy rules are regular expressions over the JSON of the tool input. A command can be written in a way a regex does not see. No test tries to evade them.
- The secret filter in memory recognizes known token shapes, not every secret (section 4).
- `POST /api/city/events` has no authentication beyond the loopback binding.
- The OpenClaw Gateway's own audit reported one warning (`missing scope: operator.read` for its own probe client). The morning report says it is not an exposure; I did not re-run the audit.

## 14. City visualization: partial

Evidence:
- The City tab of the HUD (`jarvis/hud/city.js`, `city-state.js`) draws agents, departments, tickets and questions from `GET /api/city` and the server-sent event stream; the runtime emits typed events for hires, retirements, ticket status, questions, reviews, cost, worker state, departments, pauses and parked tickets. `snapshot()` carries per-department active/cap counts.
- Tests: `jarvis/test/city-state.test.js`, `city-ops.test.js`, `city.playwright.test.js` (a browser smoke test).
- Another session is working on the HUD while this is written, so this section may be out of date.

Gaps:
- The morning report says 60 fps with 40 agents was never measured. Its statement that a 15-agent demo ran smoothly was not measured either, and the demo has since been removed (the report's own note says so).
- Not checked in this review: what the panels currently show.

## 15. Observability: done

Evidence:
- Trace: `createTrace` writes every non-log city event to `~/.jarvis/events.jsonl`; `/api/city/trace?ticket=<id>` returns a ticket and everything split from it.
- Workforce: `workforce()` and `/api/city/workforce`.
- Health: `health()` and `/api/city/health` (pause, turns running and waiting, open, stale, parked and owner-blocked tickets, failures today, last model turn, active agents).
- Costs: `/api/city/costs`.
- Integrations: real probes, cached five minutes, `/api/city/integrations`. An integration that was not checked says `unknown`.
- Audit tail per agent: `/api/city/audit?agent=<id>`.
- Tests: `automation.test.ts` (workforce, health, integrations, trace), `events.test.ts`.

Gaps:
- `forTicket` reads the whole trace file and has no rotation; a comment in the code says to rotate it past a few hundred MB.
- `tickets_stale` is empty while any turn is running, by design.
- The trace does not record the content of tool calls; the audit log records tool name, decision and reason only.

## 16. Evals and self-improvement: partial

Evidence:
- `jarvis eval`, `config/evals/` (five tasks across Engineering, Research, Marketing and Support), recorded in `evals.jsonl`. Tests: `evals.test.ts`.
- `jarvis report` and `/api/city/report`; lessons through `memory.remember`. Tests: `measure.test.ts`.
- The weekly schedule and the merge gate, which names rule and scoring changes. Tests: `improve.test.ts`.

Gaps:
- The merge gate has only run against fake `git`, `gh` and evals, apart from `evalAtCommit`. It has not merged a real PR, and the weekly schedule is off.
- The eval set is small and known, so it catches a broken department and little else. One live task proves little about quality.
- A failed gate does not try again: a PR that fails review goes to the owner, with no fix round.
- A merge does not reach the running service until the checkout is pulled and it restarts.
- By the owner's decision this loop can change the city's rules and scoring, with only `.github/`, `package.json` files, existing tests and the Reviewer's prompt barred, and a worker can merge a PR itself. See "What may change" in `docs/ARCHITECTURE.md`.
