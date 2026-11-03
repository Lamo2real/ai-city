# Jarvis OS — Claude Code build kit

Drop these files into the root of your `~/projects/jarvis-os` repo, then follow Setup. After that, open Claude Code in the repo and work through `BUILD_PLAN.md`.

## What's in the kit

| Path | What it is |
|---|---|
| `CLAUDE.md` | Project instructions Claude Code reads every session: architecture, stack, rules. |
| `BUILD_PLAN.md` | 10 phases, each with a prompt to paste and "done when" checks. |
| `.mcp.json` | MCP servers for the project: GitHub, Terraform, Meta Ads (official), Playwright. |
| `.claude/settings.json` | No-prompt permissions for normal work, plus the policy-gate hook on every tool call. |
| `.claude/hooks/policy_gate.py` + `config/policy.json` | The safety gate: blocks or escalates the short list of dangerous actions and writes an audit log. Self-test: `python3 .claude/hooks/policy_gate.py --selftest`. |
| `.claude/skills/agent-factory/` | How hiring, reuse, @mentions, questions, ledger and retiring work. |
| `.claude/skills/jarvis-voice-streaming/` | The real-time voice loop: barge-in, interruption memory, lead-ins, latency targets. |
| `agents/core/*.md` | Jarvis, Orchestrator, Secretary, Reviewer prompts (with model + effort). |
| `agents/templates/*.md` | Manager and worker templates the Factory fills in at runtime. |
| `schemas/*.json` | Ticket, agent spec and question formats. |

## Setup (once, on your Mac)

1. **Tools:** `brew install uv ffmpeg gh node docker` (start Docker Desktop). Install Xcode from the App Store for iOS work.
2. **Claude Code:** install it, sign in, then run `claude` in the repo once so it picks up `CLAUDE.md`, skills and settings.
3. **Secrets in Keychain** (never in files):
   ```bash
   security add-generic-password -s jarvis.github  -a jarvis -w '<fine-grained PAT>'
   security add-generic-password -s jarvis.cartesia -a jarvis -w '<cartesia key>'
   security add-generic-password -s jarvis.anthropic -a jarvis -w '<anthropic key for the runtime>'
   ```
   Before starting Claude Code: `export GITHUB_PAT="$(security find-generic-password -s jarvis.github -w)"`. `.mcp.json` reads it as `${GITHUB_PAT}`.
4. **MCP servers:** start `claude` and run `/mcp`. Approve the project servers. Sign in to **meta-ads** with your Facebook Business login when asked. Check with `claude mcp list`.
5. **Your Mac's personal-assistant MCP** (calendar, mail, notes, reminders, texts, terminal, draw.io) is already installed for the Claude desktop app. Add the same server to Claude Code at user scope (`claude mcp add -s user personal-assistant -- <same command as in your desktop config>`), so Jarvis's fast path can use it.
6. **Policy self-test:** `python3 .claude/hooks/policy_gate.py --selftest` should report 16 cases passed.
7. **Agent isolation (recommended):** run the Jarvis daemon under a separate macOS user that only has access to `~/projects` and the Keychain items above.

## Skills to have enabled

| Skill | Where it comes from | Used for |
|---|---|---|
| `ponytail`, `ponytail-review`, `ponytail-audit` | your account | all coding, every PR review, periodic audits |
| `impeccable` | your account | the HUD |
| `jarvis-voice` | your account | offline Piper/Swedish fallback (the streaming skill here supersedes its batch path) |
| `booqy-meta-ads`, `booqy-site-builder` | your account | when Jarvis builds Booqy features |
| `agent-factory`, `jarvis-voice-streaming` | this kit (`.claude/skills`) | runtime and voice |
| `engineering:architecture`, `engineering:testing-strategy`, `engineering:deploy-checklist` | plugin | design decisions, test plans, release checks |
| `skill-creator` | built in | when a new department needs its own worker skill |

## Connectors / MCP servers

| Need | Server | Notes |
|---|---|---|
| GitHub | `github` (official, hosted) | Fine-grained PAT scoped to the repos Jarvis may touch. |
| Terraform | `terraform` (HashiCorp, Docker) | Registry/provider lookups; actual `plan`/`apply` run through Bash and are gated by policy. |
| Meta Ads | `meta-ads` (Meta's official hosted server) | OAuth through your Business login. Campaigns start paused. |
| Browser | `playwright` | Research, travel search, sites without an API. |
| Calendar, Mail, Notes, Reminders, SMS/calls, draw.io, terminal | your `personal-assistant` MCP | Fast path. |
| AWS | AWS CLI with SSO profiles (`aws sso login`) | Add an AWS MCP server later if you want one; check the current awslabs server names first. |
| Spotify | `osascript` | No server needed: `tell application "Spotify" to playpause`. |
| Video | `ffmpeg` + YouTube Data API | Add an upload MCP or a small script in Phase 7. |
| Voice | Cartesia API, Kokoro-MLX, Piper | Python libraries, not MCP. |

## Where to build it

Build it in **Claude Code on your Mac**: it needs your real files, Xcode, audio devices, long-running background processes and git. Use the Claude app (like this chat) for planning, diagrams, research and reviewing results. Jarvis itself runs on the **Claude Agent SDK**, so it doesn't depend on any chat window.
