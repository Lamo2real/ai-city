# AI City architecture

Written 2026-11-04 from the code on branch `feat/openclaw-nervous-system` (commit `b82cab3`). Every statement was checked against the source named next to it. Where a claim could not be checked it says so. Nothing here describes the result of a live run; live results are in `docs/ROADMAP.md` once the coordinating session fills them in.

`docs/ai-city.drawio` is the owner's blueprint and wins over this file where they differ. This file describes the code, not the drawing.

## Diagram

```mermaid
flowchart TB
  owner(["Owner"])

  subgraph front["Front door"]
    jarvis["Jarvis<br/>claude-haiku-5-5, low"]
    inputs["HUD text, voice client, CLI,<br/>Telegram relay"]
  end

  subgraph fixed["Fixed core"]
    orch["Orchestrator<br/>claude-opus-5-5, medium"]
    sec["Executive Secretary<br/>claude-sonnet-5-5"]
    rev["Reviewer Gate<br/>claude-fable-5-1"]
  end

  subgraph dyn["Dynamic zone, hired on demand"]
    mgr["Department managers<br/>persistent, one per department"]
    wrk["Workers<br/>temporary, reviewed then released"]
  end

  subgraph rt["City runtime, city/src/runtime.ts, one Node process"]
    ledger[("Ledger<br/>SQLite: tickets, agents, questions,<br/>costs, approvals, departments, memory")]
    policy["Policy gate<br/>decide + autonomy + approvals<br/>config/policy.json"]
    reliab["Reliability gate<br/>concurrency, retry, timeout,<br/>usage-limit pause"]
    memory["Memory<br/>FTS5, 5 scopes"]
    skills["Skills<br/>skills/*/SKILL.md"]
    flows["Workflows<br/>config/workflows/*.json"]
    events["Event routing<br/>config/automations.json"]
    trace["Trace<br/>events.jsonl"]
  end

  subgraph exec["Executors, chosen per agent"]
    sdk["Claude Agent SDK session<br/>core, managers, SDK workers"]
    ocr["openclaw agent exec<br/>Claude CLI backend<br/>workers with capabilities"]
    bridge["Per-run loopback bridge<br/>127.0.0.1, token dies with the run"]
    plugin["OpenClaw plugin city-bridge<br/>city_* tools + before_tool_call hook"]
  end

  subgraph ext["Outside the city"]
    sched["OpenClaw Gateway cron<br/>off until the owner enables"]
    cev["jarvis/bin/city-event<br/>POST /api/city/events"]
  end

  owner <--> inputs
  inputs <--> jarvis
  jarvis -- "send_ticket" --> orch
  orch -- "create_department, hire_agent, send_ticket" --> mgr
  mgr -- "hire_agent, send_ticket" --> wrk
  wrk -- "report" --> mgr
  mgr -- "review_deliverable" --> wrk
  orch -- "request_review" --> rev
  orch -- "report" --> sec
  sec -- "summary" --> jarvis
  owner -. "@agent-id direct instruction, answers" .-> mgr
  owner -. "@agent-id direct instruction, answers" .-> wrk

  jarvis --- ledger
  orch --- ledger
  mgr --- ledger
  wrk --- ledger

  rt --> reliab
  reliab --> sdk
  reliab --> ocr
  sdk -- "PreToolUse hook" --> policy
  ocr --> plugin
  plugin -- "POST /policy, POST /tool/name" --> bridge
  bridge --> policy
  bridge -- "same tool handlers" --> rt
  sdk -- "in-process jarvis MCP server" --> rt

  memory --- ledger
  skills -. "one-line index in the prompt,<br/>body via read_skill" .-> mgr
  flows -- "expands into tickets with depends_on,<br/>approval steps wait for the owner" --> ledger
  events -- "ingestEvent" --> ledger
  sched --> cev
  cev --> events
  rt --> trace
```

The two executors share one runtime. A worker whose spec has `executor: "openclaw"` runs through `createOpenClawRunner`; every other agent runs through `createRunner` (the Claude Agent SDK). Both are called from `callRunner` in `city/src/runtime.ts`, which wraps them in the reliability gate and the policy guard.

## What each part is

| Part | Where | What it does, as coded |
|---|---|---|
| Jarvis | `agents/core/jarvis.md`, `jarvis/server/city-chat.js` | The owner's conversation. Its own SDK session, shared by typed and spoken turns (conversation id `owner`). Hands work on with `send_ticket`. Its turns are recorded through `recordJarvisTurn`. |
| Orchestrator | `agents/core/orchestrator.md` | Plans, creates departments, hires managers, sends tickets, calls `request_review`, reports to the Secretary. The only agent with `reset_session`, `create_department`, `update_department`. Has no file or shell tools. |
| Secretary | `agents/core/secretary.md` | Gets a finished owner-side ticket and writes the plain-language summary. Its text becomes the `result` event Jarvis delivers. |
| Reviewer | `agents/core/reviewer.md` | Runs after the repo's own checks (`city/src/checks.ts`). Must answer PASS or FAIL as JSON; a reply with no verdict counts as FAIL. |
| Managers and workers | created by `hire` in `runtime.ts` from `agents/templates/*.md` | Hired from a spec validated against `schemas/agent_spec.schema.json`, stored in the ledger's `agents` table, reused when the id comes back. |
| Ledger | `city/src/ledger.ts`, file `~/.jarvis/ledger.db` | Tickets, agents, questions, costs, session baselines, compactions, departments, approvals. WAL mode, file mode 0600. Ticket ids are idempotency keys. |
| Policy gate | `city/src/policy.ts`, `config/policy.json`, `.claude/hooks/policy_gate.py` | `decide()` over regex rules, plus the runtime's `guardFor` for autonomy levels and approvals. |
| Reliability gate | `city/src/scheduler.ts` | One gate for every model call: at most `caps.max_concurrent_turns` (4) at once, `turn_timeout_minutes` (60) per turn, two retries with 5 s and 30 s backoff on transient errors, and a city-wide pause when the subscription's usage limit hits. |
| Memory | `city/src/memory.ts` | SQLite FTS5 (porter), ranked by BM25 plus a recency term. Scopes: agent, department, project, organization, jarvis. Refuses text that looks like a key. |
| Skills | `skills/`, `city/src/agents.ts` | 18 folders, each a `SKILL.md`. Departments and specs name skills; the prompt carries one line per skill. |
| Workflows | `config/workflows/`, `city/src/workflows.ts` | Four JSON workflows. `startWorkflow` turns steps into tickets with `depends_on`. An `approval` step is a ticket with `gate: true` that waits for the owner. |
| Event routing | `config/automations.json`, `ingestEvent` | An event `{source, type, summary, data}` is matched to a route and becomes one ticket to a department's manager, an agent, or the Orchestrator. Event data is quoted as untrusted. |
| Trace | `city/src/observability.ts`, file `~/.jarvis/events.jsonl` | One JSON line per city event (log lines excluded), mode 0600. `trace(ticketId)` reads back a ticket and everything split from it. |
| SDK executor | `city/src/sdk.ts` | One `query()` per turn, resumed by session id. Built-in tools limited to what the agent's prompt lists. City tools come from an in-process MCP server named `jarvis`. |
| OpenClaw executor | `city/src/openclaw.ts` | One `openclaw agent exec --json` process per turn with a pinned per-agent config. Needs no Gateway. |
| Bridge | `createBridge` in `openclaw.ts` | One HTTP server on `127.0.0.1`, random port, one random bearer token per run. Two routes: `/policy` and `/tool/<name>`. Body limit 1 MiB. The token is deleted when the run ends. |
| OpenClaw plugin | `city/openclaw-plugin/index.js` | Registers `city_report`, `city_ask_user`, `city_remember`, `city_recall`, `city_read_skill`, and a `before_tool_call` hook at priority 1000 that asks the bridge for every tool call. If the bridge cannot be reached, the call is blocked. |

OpenClaw has a second, separate role in this repo: `jarvis/openclaw/` is a Telegram-to-Jarvis relay that does need the Gateway. It is a messaging channel, not an executor, and is described in `jarvis/openclaw/README.md`.

## How a ticket flows

1. **In.** The owner talks to Jarvis by text, voice or the relay. Jarvis answers quick personal tasks itself and otherwise calls `send_ticket`, which reaches `sendTicket` in `runtime.ts`.
2. **Validate and store.** The ticket is checked against `schemas/ticket.schema.json` and written to the ledger. A repeated id is a no-op. A ticket to a retired agent first revives it, which goes through the department cap; a refusal means no ticket is created. If `depends_on` names unfinished tickets it waits; if one of them already failed, this one fails at once.
3. **Dispatch.** `dispatch` sets the ticket `in_progress` and puts the target worker in `assigned`. Unless it is a direct instruction, or the target is the Secretary or Reviewer, the prompt gets up to four lines of relevant memory and the results of the tickets it waited for. Turns for one agent run one at a time (`deliver` keeps a queue per agent).
4. **Turn.** `turn` picks a session: managers and core agents keep one per root ticket, workers start fresh per ticket. A session past 60 % of its window is compacted first (the SDK's own `/compact`, else a Haiku summary, else a handover built from the ledger). The call goes through `callRunner`: reliability gate, policy guard, executor.
5. **Split.** The Orchestrator creates or reuses a department (`create_department` refuses a near-duplicate), then sends a ticket to its manager. The manager hires workers with `hire_agent`. Hiring is refused when the department is at its cap, when an idle worker with the same role exists, when the manager already has 4 workers, or when the department has already spent its daily budget. A manager can only hire into its own department and cannot hire a manager.
6. **Work.** A worker may ask for its own git worktree with `allocate_workspace`; the path becomes the ticket's scope and working directory. Questions go to the asker's parent first (`ask_user`); only what the parent answers `{"escalate": true}` to reaches the owner.
7. **Report.** `report` calls `finish`. The ticket becomes `done` or `failed`, the worker moves to `review` or `failed`, and the sender hears about it. For an OpenClaw worker the final message is the report.
8. **Accept.** A manager receiving a worker's `done` is told to call `review_deliverable`. Accept moves the worker to `completed`, writes the deliverable to department or project memory, and releases a temporary worker (session cleared, row kept). "Changes" sends a `fix` ticket back to the same worker. A manager that says nothing counts as having accepted.
9. **Review gate.** Before a PR or other gated step, `request_review` runs the repo's `npm test`, `lint` and `typecheck` (and pytest) in the ticket's scope, then the Reviewer. FAIL creates a `fix` ticket for the owning manager. After `max_review_rounds` (3) the owner is asked.
10. **Out.** When a ticket from the owner side finishes, the Secretary writes the summary and the runtime emits a `result` event. Jarvis tells the owner.
11. **Crash.** `resume()` re-asks open questions, re-dispatches unfinished tickets, re-opens approval steps, and parks anything idle for more than `resume_max_age_hours` (1) for the owner to resume or cancel.

Tickets that start outside a conversation (a schedule, a watcher) enter at step 2 through `ingestEvent`, with `from: "automation"`. Their results reach the owner the same way, through the Secretary and Jarvis.

## Where capabilities and approvals are enforced

The aim is that a prompt can be ignored or talked around and the tool layer still holds. These are the places where that is true in code.

**SDK agents** (`city/src/sdk.ts`, `runtime.ts`):
- `permissionMode: "dontAsk"`, `settingSources: []`, `strictMcpConfig: true`. Anything not on the allow list is denied rather than prompted.
- Built-in tools are limited to those the agent's prompt frontmatter lists (`builtinTools(allowedTools)`). A worker also gets `WORKER_TOOLS` (report, ask_user, remember, recall, read_skill) whatever its spec says.
- City tools are filtered per agent (`toolsForTurn`): an agent whose prompt does not list `mcp__jarvis__hire_agent` is not given the tool at all.
- A `PreToolUse` hook calls `guardFor` for every tool call. It runs `decide()`; then, for tools outside the city's own and a short read-only list, the department's autonomy level (`read_only` denies, `supervised` asks); then the approvals table.
- Rules inside handlers: only the Orchestrator or owner side may create departments or hire managers; only a parent or the Orchestrator may retire an agent; `reset_session` is the Orchestrator's alone; `cancel_ticket` needs the sender, the manager or the owner side.

**OpenClaw workers** (`city/src/openclaw.ts`, `city/openclaw-plugin/index.js`):
- A pinned config is written per agent per run: minimal tool profile, only the groups its `capabilities` map to, a deny list (`gateway`, `cron`, `plugins`, `message`, `computer`, `group:agents`, and others), elevated tools off, bundled skills off, mDNS off.
- The measured behaviour that justifies the second layer (stated in a comment in `openclaw.ts`): on the Claude CLI backend the agent also sees native tools such as Write, Edit and Agent whatever the config says. All of them pass `before_tool_call`, so that hook is the real boundary. `capabilityAllows` lets a call through only if its tool is in the agent's capability table (or is a `city_*` tool); then the same `guardFor` as SDK agents applies.
- The hook fails closed: no bridge URL, no token, a non-loopback URL or a failed request all block the call.

**Approvals** (`guardFor`, `answer`, `askGate` in `runtime.ts`):
- An `ask` decision stores a pending approval keyed by a hash of agent, tool and sorted input, opens a blocking question and parks the ticket in `waiting_on_owner`. The tool call is refused for now.
- When the owner answers in the inbox, the answer is stored as granted or denied. The agent is told to repeat the exact call; it passes once and the approval is marked `used`.
- A relayed message cannot approve: a direct instruction from the owner side does not answer a question that has an approval attached. Only `answer()` does.
- A workflow approval step is a ticket with `gate: true` and an approval row `gate:<ticket>`. It survives a restart and is re-asked by `resume()`.

**What is not enforced at the tool layer** (stated so nobody assumes it is):
- The daily spend cap is checked only when hiring (`hire`). It does not stop turns by agents that are already hired. `Ticket.budget_usd` is in the schema and unused. A per-turn spend limit exists on the unmerged branch `fix/turn-spend-limit`.
- `idle_retire_minutes` is stored on the agent and never read.
- Several rules in `config/policy.json` apply only to the tool name `Bash` (force-push, push to main, recursive delete of root or home, `terraform destroy`, `terraform apply` to prod, piping a download into a shell, the `git -c` and git-redirect rules). An OpenClaw run's shell tool is named `exec`. Checked with `decide()`: `exec terraform destroy` is `allow`, `Bash terraform destroy` is `ask`. The rules that cover `exec` as well are the Keychain, publishing, AWS delete and destructive SQL ones. So an OpenClaw worker with the `shell` capability is not stopped by the other rules. Fixing it means changing the `tool` pattern of those rules and the matching Python hook and self-test.
- Everything runs directly on the owner's Mac. There is no sandbox (see limits).

## Limits, stated plainly

- **No OpenClaw sandbox.** Docker is not installed on this Mac (`which docker` finds nothing; `config/integrations.json` probes it for this reason). OpenClaw's sandboxing needs it. Workers with `shell`, `files`, `browser` or `desktop` capabilities act on the real filesystem, bounded only by the pinned tool config, the capability hook and the policy gate.
- **No inbound webhooks.** They would need the Gateway to be publicly reachable, which the owner has forbidden. Events come from schedules and from a local `POST /api/city/events` on `127.0.0.1`.
- **Schedules are off.** `jarvis/bin/city-automations enable <id>` installs one in OpenClaw's scheduler, and it needs the Gateway. The Gateway is not running (nothing listens on port 18789 as of this writing). Nothing runs on a schedule today.
- **Anthropic models only.** No non-Anthropic provider is configured or used.
- **Lobster is not used.** It runs tool pipelines inside one agent. These workflows span departments, so they are tickets with dependencies in the ledger instead (`city/src/workflows.ts` says the same).
- **No third-party skills.** All 18 skills in `skills/` were written for this repo. `skills/README.md` sets the review rule for adding any.
- **Cost figures are estimates at API list prices, not charges.** The SDK reports a dollar figure per session and the runtime stores the per-turn difference. For OpenClaw runs, which do not price their turns, the figure is computed from token counts and the prices in `config/policy.json`. Those prices were not checked against Anthropic's published list for this document. `costReport()` labels its output `estimated: true`. Whether extra usage was ever billed on the subscription has not been verified.
- **`ANTHROPIC_API_KEY` is refused.** `assertNoApiKey` throws at start unless `JARVIS_ALLOW_API_KEY=1`. The OpenClaw runner also strips `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` from the environment it passes, because OpenClaw's Claude backend uses the `claude` login by itself. Everything runs on the Claude subscription.
- **External MCP servers do not reach SDK agents.** The SDK runner passes only the in-process `jarvis` server with `strictMcpConfig`, and loads no settings files. The servers in `.mcp.json` (github, terraform, meta-ads, playwright) and the `mcp__personal-assistant__*` tools named in Jarvis's prompt are therefore not available to a city agent through this runner. Read from code; not confirmed with a live call.
- **One process owns the ledger.** The HUD server or the CLI, not both (comment in `jarvis/server/server.js`).
- **The Python voice pipeline has never run.** `jarvis/voice/` is unit-tested without audio; its README marks the audio path unverified.
