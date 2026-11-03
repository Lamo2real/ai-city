# Jarvis OS — build plan

One phase per Claude Code session (or per PR). Paste the **Prompt** into Claude Code at the repo root. Don't start the next phase until every **Done when** check passes.

---

## Phase 0 — Setup (you, ~30 min)
Follow `README.md` → Setup. Done when `claude mcp list` shows all servers connected and `python3 .claude/hooks/policy_gate.py --selftest` passes.

## Phase 1 — Runtime core (text only)
**Prompt**
> Read CLAUDE.md, BUILD_PLAN.md and the agent-factory skill. Build Phase 1: a Python daemon in `runtime/` using claude-agent-sdk that loads the four core agents from `agents/core/`, implements the in-process `jarvis` MCP server (hire_agent, retire_agent, list_registry, send_ticket, ask_user, request_review, report), the SQLite ledger and registry, and wires `policy_gate.decide()` into can_use_tool. Add a CLI `jarvis "<prompt>"` that prints Jarvis's replies and questions and accepts answers. Write the tests listed in the agent-factory skill. Use ponytail; run ponytail-review before opening the PR.

**Done when:** `jarvis "what's 9+9"` answers via the fast path with no hire. `jarvis "write a hello-world Python CLI in a new repo"` hires an IT manager and a worker, opens a PR and reports through the Secretary. Killing the daemon mid-task and restarting resumes it. All tests pass.

## Phase 2 — Voice
**Prompt**
> Read the jarvis-voice-streaming skill. Build `voice/` with Pipecat exactly as described, connected to the Phase 1 daemon and the HUD over WebSocket. Log per-turn timings. Use impeccable for the HUD changes.

**Done when:** every check in the voice skill passes and the logged p50 latency is within target.

## Phase 3 — Software department + Fable gate
**Prompt**
> Make the review loop real: request_review runs automated checks first (tests, lint, typecheck), then the reviewer agent; FAIL creates a fix ticket for the owning manager; stop after max_review_rounds and ask the owner. Merges to main only after PASS.

**Done when:** a deliberately buggy PR gets FAIL, is fixed automatically and passes on round 2; a PR that fails 3 times reaches the owner as a question.

## Phase 4 — iOS app team
**Prompt**
> Add a worker skill for iOS (Swift, SwiftUI, Xcode). The worker builds with `xcodebuild` and tests on the simulator on this Mac. The Orchestrator must ask "native Swift or cross-platform?" before hiring for any app request.

**Done when:** "build me a simple iOS habit-tracker app" → platform question → App Manager + iOS Developer hired → questions arrive tagged with their path → `@ios-dev …` reaches the developer with the manager cc'd → app builds and its tests pass → Fable PASS → summary delivered.

## Phase 5 — Cloud / Terraform
**Prompt**
> Add a Cloud manager template using the terraform MCP and AWS CLI via SSO profiles. plan runs freely; apply to non-prod goes through Fable; prod apply and destroy go to the owner (policy already enforces this).

**Done when:** a small non-prod change goes plan → Fable → apply. A prod apply stops and asks the owner.

## Phase 6 — Marketing / Meta Ads
**Prompt**
> Add a Marketing manager using the meta-ads MCP. Campaigns are always created PAUSED. Activation and any budget over the cap go through Fable, then the owner. Use the booqy-meta-ads skill when the work touches the Booqy platform feature.

**Done when:** "draft a campaign for X with €20/day" creates a paused campaign and asks before activating.

## Phase 7 — Video production
**Prompt**
> Add a Video manager and workers for script, edit (ffmpeg), captions, thumbnail and upload. Renders run as background jobs; workers wait for them to finish. Uploads are private or unlisted; going public is gated.

**Done when:** "cut a 30-second vertical clip from this file with captions and upload unlisted to YouTube" works end to end and asks before going public.

## Phase 8 — Personal & temporary teams
**Prompt**
> Wire the fast path to the personal-assistant MCP (calendar, mail, notes, reminders, texts). Add a temporary Travel team template (flights worker, hotels worker with a view filter) that retires itself when done.

**Done when:** "add lunch with Sara Friday at 12" is done in one turn with no hire, and "find a 3-night lake-view hotel trip in March under 8,000 kr" returns options and then the team retires.

## Phase 9 — Self-hiring at scale + observability
**Prompt**
> Turn on hiring for new departments. Enforce every cap in config/policy.json. Add per-ticket tracing (cost, time, agent tree) visible in the HUD, and a small eval set of known tasks per department run by `jarvis eval`.

**Done when:** a 9th concurrent agent is refused cleanly, `jarvis eval` passes, and the HUD shows cost per department for today.
