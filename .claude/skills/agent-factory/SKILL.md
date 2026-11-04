---
name: agent-factory
description: How Jarvis OS hires, reuses, addresses and retires agents at runtime, and how tickets and questions flow. Use when building or changing runtime/factory, registry, ledger, the question bus, or any hire_agent/ask_user/send_ticket code.
---

# Agent Factory, Registry, Ledger and Bus

## Hiring (hire_agent)
1. Validate the spec against `schemas/agent_spec.schema.json`. Reject unknown fields.
2. Policy check against `config/policy.json` caps: concurrent agents, workers per manager, daily spend per department. A manager may only grant tools within its own allowlist.
3. Render the prompt from `agents/templates/{manager|worker}.md` by replacing `{{…}}` placeholders. No template engine.
4. Save the rendered file to `~/.jarvis/agents/<id>.md` and a registry row (id, role, kind, department, parent, model, tools, skills, lifecycle, created_at, last_active_at, total_cost_usd).
5. Start a `ClaudeSDKClient` session for it with: the rendered prompt as system prompt, `model`, `allowed_tools`, the in-process `jarvis` MCP server, the external MCP servers its tools need, and `can_use_tool` wired to `policy_gate.decide()`. Store the session id for resume.

## Reuse (list_registry)
Return matches by role, department and skills, including retired persistent agents. Reviving a saved specialist resumes its session and notes, so it remembers past projects.

## Addressing
- Every agent has an inbox: open tickets where `to = id` or `id in cc`.
- `@id …` from the owner becomes a `direct_instruction` ticket to that agent with its parent cc'd. Delivered at the agent's next turn boundary, never mid-tool-call.

## Questions (ask_user)
- Validate against `schemas/question.schema.json`. Set the ticket status to `waiting_on_owner` only if `blocking`.
- The asking agent's parent sees it first. If the parent answers from context within one turn, the owner is never asked.
- Otherwise it goes to Jarvis, which asks the owner using `path` ("App Manager › iOS Developer"). The answer comes straight back to the asking agent as a `direct_instruction`.
- Dedupe identical open questions from the same team.

## Ledger
SQLite at `~/.jarvis/ledger.db`, tables `tickets`, `agents`, `questions`, `costs`. Every state change is one transaction. On daemon start, resume `in_progress` tickets from their agents' saved sessions. Ticket ids are idempotency keys: a repeated `send_ticket` with the same id is a no-op.

## Retiring
`temporary` agents retire when their root ticket is `done`, `failed` or `cancelled`. `persistent` agents retire after `idle_retire_minutes` but stay in the registry for reuse.

## Tests that must exist
Spec validation rejects bad input; caps block the agent over `max_concurrent_agents` (the test pins a cap of 4 and expects the 5th to be refused; the real cap is in `config/policy.json`, currently 10) and the 5th worker of one manager; `@id` routes with cc; a parent-answered question never reaches the owner; the daemon resumes an `in_progress` ticket after a kill.
