# AI City roadmap

Written 2026-11-04 from the code on branch `feat/openclaw-nervous-system` (first written at commit `b82cab3`, updated the same day after the live tests and two code reviews). This file is the persistent roadmap: update it when something changes, and date the change. See `docs/ARCHITECTURE.md` for how the parts fit and `docs/CAPABILITY_GAPS.md` for the evidence per section of the directive.

**How to read the status column.** "In code" means the code exists and a unit test with a fake runner covers it. It says nothing about live behaviour. Live results go only in the Acceptance tests table, filled in by the coordinating session. Where this file and a live result disagree, the live result wins.

## State of the branches

`main` does not contain any of this work. `git rev-list --count main..HEAD` gives 23, and `main` has no `recordTurn` in `city/src/ledger.ts`, so `main` still has the cost accounting that summed a running session total on every turn. Until this chain is merged, the corrected figures exist only here.

## The ten highest-impact improvements

| # | Improvement | Status | Evidence in code | Still open |
|---|---|---|---|---|
| 1 | Reliability gate: concurrency, retries, timeouts, usage-limit pause | In code | `city/src/scheduler.ts`, wired in `callRunner` (`runtime.ts`). 4 concurrent turns, 60 minute timeout, 2 retries (5 s, 30 s) on transient errors, city-wide pause until the reset time parsed from the limit message, up to 12 pauses per turn. `isUsageLimit` in `sdk.ts` now uses `includes`; the earlier `startsWith` never matched the real error. Tests: `scheduler.test.ts` (7), `sdk.test.ts`, `organization.test.ts` (pause then finish). | The pause has not been seen against a real limit as far as the repo shows. `isPausableLimit` is a regex over the message text and will miss a reworded message. |
| 2 | Cost accounting fix and estimate labelling | In code | `recordTurn` and `session_baselines` in `ledger.ts` turn the SDK's cumulative `total_cost_usd` into per-turn deltas. Migration v1 marks old rows `estimated = 1`, keeps `raw_usd`, backs the file up first. `costReport()` says `estimated: true`. Tests: `ledger.test.ts` (17). | Not on `main`. Prices in `config/policy.json` not checked against the published list. Nothing proves whether extra usage was billed. OpenClaw turns assume the reported cost is cumulative per session id; unchecked for that executor. |
| 3 | Dynamic departments with duplicate prevention | In code | `createDepartment`, `updateDepartment`, `findOverlap` (threshold 0.6), `departmentKey` (case and space folding), `ensureDepartment` for older installs, per-department caps. Test: `organization.test.ts`. | Overlap is word overlap, not meaning. Event routes and workflows name departments that nothing creates by itself. |
| 4 | Worker lifecycle with review and release | In code | `lifecycle.ts` table, `setWorker`, `reviewDeliverable`, `acceptWorker`, `releaseWorker`. Accepted deliverables go to memory; a temporary worker's session ends and its row stays. A manager that says nothing counts as accepting. | `idle_retire_minutes` is never read. States `requested` and `paused` are never entered. |
| 5 | Dependencies, handoffs and per-ticket git worktrees | In code | `depends_on` with handoff text, failure propagation, `allocate_workspace` via `workspaces.ts` (limited to `repos_roots`, never main). Tests: `organization.test.ts` (dependencies, worktrees). | `releaseWorkspace` is never called by the runtime; worktrees pile up under `~/.jarvis/worktrees`. Nothing allocates a worktree unless the agent asks. |
| 6 | Memory with retrieval | In code | `memory.ts`: FTS5, five scopes, recency, dedupe, secret refusal; automatic recall at dispatch. Test: `organization.test.ts`. | Keyword only. No expiry. Narrow secret filter. No measure of benefit. |
| 7 | OpenClaw execution layer with capability enforcement at the hook | In code | `openclaw.ts` (pinned config, bridge, runner), `city/openclaw-plugin/` (tools and `before_tool_call` at priority 1000, fail closed). Tests: `openclaw.test.ts` (8). | No sandbox. The policy rules for shell commands now match `Bash`, `exec` and `bash` (fixed 2026-11-04, see priority 1); they are still regexes over command text. Browser path: see tests. |
| 8 | Skills library, 18 skills covering the directive's 47 areas | In code | `skills/` has 18 folders; their `covers:` lines hold 47 distinct entries. Index in the prompt, body by `read_skill`. | The 47 was counted from `covers:`, not matched against the directive's own list. No third-party skills. Nothing measures whether a skill helps. |
| 9 | Workflows with durable approvals, inbound event routing, schedules | In code, schedules off | Four workflows in `config/workflows/`; approval steps as `gate` tickets that survive a restart; `ingestEvent` and `POST /api/city/events`; `city-event`; `city-automations`. Tests: `automation.test.ts` (6). | Schedules are off and need the Gateway, which is not running. No inbound webhooks. The events endpoint has no authentication of its own. Approval is read from the first word of free text. |
| 10 | Tool-layer approvals and autonomy, plus trace, workforce, health and honest integration probes | In code | `guardFor` (approvals bound to the exact call, single use, relay cannot approve, `read_only` and `supervised` departments); `createTrace`, `workforce()`, `health()`, `probeIntegrations` (a status of `operational` only when a probe answered). Tests: `organization.test.ts`, `automation.test.ts`, `events.test.ts`. | The daily spend cap is enforced only at hire time. See priorities 2 and 3. |

## What comes next, in priority order

1. **Done 2026-11-04: shell rules cover `Bash`, `exec`, `bash` and `process`,** with any git flags before `push`, plus `gh pr merge` and `gh api` writes. A regular expression over a command is never complete, so these rules are a guard against mistakes and simple injection, and the sandbox is the stronger layer.
2. **Decide what actually limits spend.** Today the department's daily budget is checked only when hiring, and `budget_usd` on a ticket and `budget_usd_per_day` on a spec are stored and unused. Read the two unmerged cost branches (list below) against the corrected figures before choosing, because both may have been motivated by the inflated number.
3. **Merge the chain into `main`.** `main` lacks the cost fix. Merging needs the owner and the Reviewer Gate, so it is not something an agent does alone.
4. **Settle MCP for city agents.** Either give the SDK runner the servers its prompts name (`mcp__personal-assistant__*` in Jarvis, `mcp__github__*` in the Reviewer), or remove those names from the prompts. First confirm with a live call that they are unavailable now; the finding is from reading `sdk.ts`.
5. **Give default-executor workers an OS sandbox.** They have the policy rules and a text check only, so a steered worker with `Bash` can still reach the owner's API through a script file. This is the largest remaining security gap.
6. **Verify a real provider limit on the OpenClaw path.** A fake CLI's limit message came back only as "process exited with code 1", so a real limit may fail that worker's ticket rather than pause the city. Its manager's next turn should pause. Record what a real limit does when one next occurs. Do not provoke one.
7. **Owner decision: Gateway and schedules.** Start the Gateway, then enable schedules one at a time with `jarvis/bin/city-automations enable <id>`. Start with `failed-tickets` and `github-failures`, which make no model call unless something happened. The daily briefing costs one Sonnet turn a day.
8. **Authenticate `POST /api/city/events` and `/api/city/answer` for local processes.** Cross-site requests are refused and the sandbox stops OpenClaw shell runs, but any other local process can still call them.
9. **Done 2026-11-04: only a whole yes approves,** so "okay, deny it" is a denial, and approvals cannot be decided from the phone listener.
10. **Make idle retirement real.** Read `idle_retire_minutes`, or remove the field. Enter or remove the `requested` and `paused` states.
11. **Verify voice.** Run the audio checks in `jarvis/voice/README.md`, wire the offline fallback, pick the Cartesia voice id, and record the latency.
12. **Memory quality.** The secret filter was widened on 2026-11-04. Still to add: a way to see what was recalled for a ticket, and embeddings only if a recall test shows keyword search is not enough.
13. **Workflow shape.** Retry of a single step, and a failure that does not fail unrelated branches. Only if a real workflow needs it.

## Acceptance tests

Run live on 2026-11-04 on scratch data (`JARVIS_HOME` in a temp folder, `JARVIS_MODEL_CAP=claude-sonnet-5-5`), with real agents on the owner's Claude subscription. Total estimated value at API list prices: under $3, not a charge. The owner's live ledger was not touched.

| # | Test | Result | Date | Notes |
|---|---|---|---|---|
| 1 | Dynamic department creation | Passed | 2026-11-04 | Jarvis to Orchestrator; Research and its manager created and shown in the city. |
| 2 | Dynamic workforce | Passed | 2026-11-04 | The manager hired three OpenClaw Haiku workers and delegated to them. |
| 3 | Parallel execution | Passed | 2026-11-04 | Three workers overlapped in time, with real `web_fetch` calls in the audit log; the manager consolidated. |
| 4 | Worker lifecycle | Passed | 2026-11-04 | Hired, assigned, working, review, completed, released, from the event log. Results stay in the ledger. |
| 5 | Cross-department coordination | Passed | 2026-11-04 | Engineering, then Marketing through `depends_on`, with one combined report. |
| 6 | Computer execution | Passed | 2026-11-04 | Real `sw_vers` and `df`; a real browser read a page heading; a Keychain read was denied by the gate; a zero-capability worker was blocked from Write and Agent. `desktop` was not exercised. |
| 7 | Claude Code | Passed | 2026-11-04 | A real commit with a test on its own branch of a scratch repo, tests rerun independently, not merged. |
| 8 | Persistent memory | Passed | 2026-11-04 | After workers were released and the server restarted, Research answered from `recall` with no web calls. |
| 9 | Proactive automation | Passed, on a scratch Gateway | 2026-11-04 | A real OpenClaw cron job fired `city-event`, and the result came through the Secretary. A routed event reached Engineering, whose planted instruction was ignored. The owner's own Gateway and schedules stay off. |
| 10 | Cost visibility | Passed | 2026-11-04 | Per-agent figures sum to the total, with breakdowns by department, model and ticket. All are labelled estimates. |
| 11 | Failure recovery | Mostly passed | 2026-11-04 | Worker killed with SIGKILL: ticket failed cleanly and the manager was told. Server killed with SIGKILL: ledger integrity ok, tickets resumed and finished, and that run's worker ran again (execution is at least once). Provider limit: see What comes next, item 6; pause is unit-tested only. |
| 12 | Real-time city | Passed | 2026-11-04 | Live in the HUD: workers appeared, the Workforce panel and Activity feed followed each state through release. All 34 tickets and 10 workers in the event log matched the ledger at the time of that check. Real phone listener not exercised. |

## Limits that do not change by building more

- Docker is absent. OpenClaw runs other than browser runs go inside a macOS `sandbox-exec` profile: they cannot reach the owner's API port or write to the city's code, config, ledger, audit log, agent prompts, `node_modules`, shell start-up files or launch agents, and `open` and `osascript` are blocked unless the run has the `desktop` capability. Browser runs stay outside it, because Chrome's own sandbox cannot start inside it, and a browser worker cannot also have shell, desktop or files. Default-executor (SDK) workers have no OS sandbox: only the policy rules and a text check on their commands, which an encoded command or a script file can get past.
- Inbound webhooks need public exposure, which the owner has forbidden. Events come from schedules and a local POST.
- Non-Anthropic providers are not used.
- Lobster is not used: it is single-agent tool pipelines, and workflows here span departments.
- No third-party skills are installed.
- Schedules are off until the owner enables them, and they need the Gateway, which is not running.
- Cost figures are estimates at API list prices, not charges.
- `ANTHROPIC_API_KEY` is refused. Everything runs on the Claude subscription.

## Unmerged branches for the owner to reconsider

Counts are commits ahead of `main`, checked 2026-11-04. None of these is an ancestor of this branch.

| Branch | Ahead of main | What it is | Note |
|---|---|---|---|
| `chore/remove-cost-caps` | 9 | "Remove per-department cost caps (null = unlimited) by owner decision; keep the agent cap" | The ledger summed a running total and showed about $8,545 against a real estimate of about $203 to $214, roughly 40 times too high. If the removal was motivated by a cap firing on that figure, the reason is gone. I do not know what motivated it. |
| `fix/turn-spend-limit` | 10 | Adds a spend-cap test file (`city/test/spendcap.test.ts`) and changes `runtime.ts`, `ledger.ts`, `sdk.ts`, `policy.ts` and `hud/city.js` | Same concern, same uncertainty about motive. I did not review its logic. Its history includes a merge of `fix/cost-accounting`. |
| `fix/cost-accounting` | 13 | The per-turn cost delta fix | This branch has `recordTurn`, but `fix/cost-accounting` is not an ancestor of it and I did not diff the two. Confirm nothing is missing here before deleting it. |
| `feat/city-windows` | 11 | Not reviewed. Last commit: "test: city snapshot keys include department_agents" | City-related by name. |
| `feat/hud-nav-mobile` | 10 | Not reviewed. Last commit: "test: expect department_agents in the city snapshot" | |
| `feat/jarvis-safari` | 25 | Not reviewed. Last commit: "city-chat test: snapshot now carries department_agents" | Largest of the set. |
| `feat/lean-context-skill` | 3 | Not reviewed. Last commit: "Merge origin/main" | |
| `fix/department-key-followup` | 9 | Not reviewed. Last commit: "Update City snapshot key test for department_agents" | |
| `fix/hud-scrub-more` | 5 | Scrubs the mail hold and approve notices at the source | |
| `fix/mail-followups` | 3 | Scrubs the mail note on the unprompted path | |

`fix/fresh-sessions` and `fix/worker-report-ask` are ancestors of this branch.

## For the owner to check

- **The live Jarvis is not running.** `se.lamo.jarvis` is disabled in launchd, and nothing listens on port 7777. Nothing recorded in the work on this branch disabled it, so it was left alone. To start it again: `launchctl enable gui/$(id -u)/se.lamo.jarvis`, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/se.lamo.jarvis.plist`.
- **The first restart on this code parks stale tickets.** The live ledger had 25 stale `in_progress` tickets. They will appear in the City view's Parked list to resume or cancel, instead of all running at once.
