# AI City roadmap

Written 2026-11-04 from the code on branch `feat/openclaw-nervous-system` (commit `b82cab3`). This file is the persistent roadmap: update it when something changes, and date the change. See `docs/ARCHITECTURE.md` for how the parts fit and `docs/CAPABILITY_GAPS.md` for the evidence per section of the directive.

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
| 7 | OpenClaw execution layer with capability enforcement at the hook | In code | `openclaw.ts` (pinned config, bridge, runner), `city/openclaw-plugin/` (tools and `before_tool_call` at priority 1000, fail closed). Tests: `openclaw.test.ts` (8). | No sandbox. Policy rules written for `Bash` do not cover the OpenClaw shell tool `exec` (see priority 1 below). Browser path: see tests. |
| 8 | Skills library, 18 skills covering the directive's 47 areas | In code | `skills/` has 18 folders; their `covers:` lines hold 47 distinct entries. Index in the prompt, body by `read_skill`. | The 47 was counted from `covers:`, not matched against the directive's own list. No third-party skills. Nothing measures whether a skill helps. |
| 9 | Workflows with durable approvals, inbound event routing, schedules | In code, schedules off | Four workflows in `config/workflows/`; approval steps as `gate` tickets that survive a restart; `ingestEvent` and `POST /api/city/events`; `city-event`; `city-automations`. Tests: `automation.test.ts` (6). | Schedules are off and need the Gateway, which is not running. No inbound webhooks. The events endpoint has no authentication of its own. Approval is read from the first word of free text. |
| 10 | Tool-layer approvals and autonomy, plus trace, workforce, health and honest integration probes | In code | `guardFor` (approvals bound to the exact call, single use, relay cannot approve, `read_only` and `supervised` departments); `createTrace`, `workforce()`, `health()`, `probeIntegrations` (a status of `operational` only when a probe answered). Tests: `organization.test.ts`, `automation.test.ts`, `events.test.ts`. | The daily spend cap is enforced only at hire time. See priorities 2 and 3. |

## What comes next, in priority order

1. **Make the `exec` tool obey the same policy rules as `Bash`.** In `config/policy.json` the rules for force-push, push to main, `rm -rf` of root or home, `terraform destroy`, `terraform apply` to prod, `curl | sh` and the git redirect and `-c` rules match the tool name `^Bash$` only. `decide("exec", {command: "terraform destroy"})` returns `allow`; for `Bash` it returns `ask`. Widen the pattern to `^(Bash|exec|bash)$` (as the Keychain, publishing and AWS rules already are), mirror it in `.claude/hooks/policy_gate.py` and both self-tests, and add test cases for `exec`. This is the largest known hole between what the documents say and what the code does.
2. **Decide what actually limits spend.** Today the department's daily budget is checked only when hiring, and `budget_usd` on a ticket and `budget_usd_per_day` on a spec are stored and unused. Read the two unmerged cost branches (list below) against the corrected figures before choosing, because both may have been motivated by the inflated number.
3. **Merge the chain into `main`.** `main` lacks the cost fix. Merging needs the owner and the Reviewer Gate, so it is not something an agent does alone.
4. **Settle MCP for city agents.** Either give the SDK runner the servers its prompts name (`mcp__personal-assistant__*` in Jarvis, `mcp__github__*` in the Reviewer), or remove those names from the prompts. First confirm with a live call that they are unavailable now; the finding is from reading `sdk.ts`.
5. **Release worktrees.** Call `releaseWorkspace` when a ticket reaches a terminal state, and keep the worktree when it reports something unpushed (that function already refuses in that case).
6. **Finish and record the browser path** (acceptance test 6) and the desktop path, with the live result in the table below.
7. **Owner decision: Gateway and schedules.** Start the Gateway, then enable schedules one at a time with `jarvis/bin/city-automations enable <id>`. Start with `failed-tickets` and `github-failures`, which make no model call unless something happened. The daily briefing costs one Sonnet turn a day.
8. **Authenticate `POST /api/city/events`**, so that any local process cannot start tickets.
9. **Stricter approval parsing.** Offer the owner buttons (approve or deny) in the inbox and accept only those for gated actions, instead of reading the first word of free text.
10. **Make idle retirement real.** Read `idle_retire_minutes`, or remove the field. Enter or remove the `requested` and `paused` states.
11. **Verify voice.** Run the audio checks in `jarvis/voice/README.md`, wire the offline fallback, pick the Cartesia voice id, and record the latency.
12. **Memory quality.** Widen the secret filter, add a way to see what was recalled for a ticket, and add embeddings only if a recall test shows keyword search is not enough.
13. **Workflow shape.** Retry of a single step, and a failure that does not fail unrelated branches. Only if a real workflow needs it.

## Acceptance tests

The twelve live acceptance tests run by the coordinating session. The test descriptions are not in the repo, so that column is left for the coordinating session to fill in. Results are left as "pending" on purpose; nothing here is a live result.

| # | Test | Result | Date | Notes |
|---|---|---|---|---|
| 1 | | pending | | |
| 2 | | pending | | |
| 3 | | pending | | |
| 4 | | pending | | |
| 5 | | pending | | |
| 6 | | pending | | |
| 7 | | pending | | |
| 8 | | pending | | |
| 9 | | pending | | |
| 10 | | pending | | |
| 11 | | pending | | |
| 12 | | pending | | |

## Limits that do not change by building more

- Docker is absent, so there is no OpenClaw sandbox.
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
