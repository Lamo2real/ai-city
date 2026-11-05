# AI City

An organization of AI agents on the owner's Mac that turns prompts into work by hiring agents on demand. **Jarvis** is its front door: the local assistant at http://localhost:7777 you talk to by voice or by typing. The **city** behind it plans, hires, builds, reviews and reports.

- `jarvis/`: the app. HUD, server, voice, install scripts. Built from [jarvis/SPEC.md](jarvis/SPEC.md).
- `city/`: the runtime. Orchestrator loop, Agent Factory, Registry, Ledger, Question Bus, policy gate.
- `agents/`: the prompts of the core agents and the manager and worker templates.
- `schemas/`: tickets, agent specs and questions. The only things agents pass to each other.
- `config/policy.json`: what agents may do without asking, what needs the owner, and the caps.
- `docs/ai-city.drawio`: the blueprint. Where it differs from the files, the drawing wins.
- `BUILD_PLAN.md`: phases, each with a prompt and "done when" checks.

## How the city works

1. You talk or type to Jarvis (Haiku). Quick personal things (calendar, mail, notes, reminders, Spotify, simple facts) it does itself.
2. Anything bigger becomes a ticket to the **Orchestrator** (Opus), which asks you the one or two questions that change the plan, then finds or hires a **manager** through the **Agent Factory**. Managers hire **workers**. Nothing in the dynamic zone exists until a prompt needs it; saved specialists are reused, idle ones retired.
3. Before a PR to main, a push to dev or any spend, the **Reviewer Gate** (Fable) reviews. FAIL comes back as a fix ticket; after `max_review_rounds` the question goes to you.
4. The **Executive Secretary** (Sonnet) turns the result into a short plain summary that Jarvis tells you.
5. Any agent can ask you a question through the **bus**, tagged with who is asking. `@ios-dev …` reaches that agent directly, its manager cc'd.

Everything runs on the owner's Claude subscription through the logged-in `claude` CLI (or the OAuth token in Keychain item `jarvis.claude-oauth`). `ANTHROPIC_API_KEY` is never used; the runtime refuses to start if it is set.

## Setup (once, on your Mac)

1. **Tools:** `brew install uv ffmpeg gh node` (Node ≥ 24). Docker only if you use the Terraform MCP server. Xcode from the App Store for iOS work.
2. **Claude Code:** install it, sign in, then run `claude` in the repo once so it picks up `CLAUDE.md`, skills and settings.
3. **Dependencies:** `npm install` at the root installs both workspaces.
4. **Secrets in Keychain** (never in files):
   ```bash
   security add-generic-password -s jarvis.claude-oauth -a jarvis -w '<token from: claude setup-token>'
   ```
   ```bash
   security add-generic-password -s jarvis.github -a jarvis -w '<fine-grained PAT>'
   ```
   ```bash
   security add-generic-password -s jarvis.cartesia -a jarvis -w '<cartesia key>'
   ```
   `jarvis/bin/jarvis-env <command>` runs a command with these in its environment. `.mcp.json` reads the PAT as `${GITHUB_PAT}`.
5. **MCP servers:** start `claude` and run `/mcp`. Approve the project servers. Sign in to **meta-ads** with your Facebook Business login when asked. Check with `claude mcp list`.
6. **Your Mac's personal-assistant MCP** (calendar, mail, notes, reminders, texts, terminal, draw.io) is installed for the Claude desktop app. Add the same server to Claude Code at user scope (`claude mcp add -s user personal-assistant -- <same command as in your desktop config>`), so Jarvis's fast path can use it.
7. **Checks:** `npm test` and `python3 .claude/hooks/policy_gate.py --selftest` (16 cases).
8. **Agent isolation (recommended):** run the city under a separate macOS user that only has access to `~/projects` and the Keychain items above.

### Skills to have enabled

| Skill | Where it comes from | Used for |
|---|---|---|
| `ponytail`, `ponytail-review`, `ponytail-audit` | your account | all coding, every PR review, periodic audits |
| `impeccable` | your account | the HUD |
| `jarvis-voice` | your account | offline Piper/Swedish fallback (the streaming skill supersedes its batch path) |
| `booqy-meta-ads`, `booqy-site-builder` | your account | when the city builds Booqy features |
| `agent-factory`, `jarvis-voice-streaming` | this repo (`.claude/skills`) | runtime and voice |
| `engineering:architecture`, `engineering:testing-strategy`, `engineering:deploy-checklist` | plugin | design decisions, test plans, release checks |
| `skill-creator` | built in | when a new department needs its own worker skill |

### Connectors / MCP servers

| Need | Server | Notes |
|---|---|---|
| GitHub | `github` (official, hosted) | Fine-grained PAT scoped to the repos the city may touch. |
| Terraform | `terraform` (HashiCorp, Docker) | Registry/provider lookups; `plan`/`apply` run through Bash and are gated by policy. |
| Meta Ads | `meta-ads` (Meta's official hosted server) | OAuth through your Business login. Campaigns start paused. |
| Browser | `playwright` | Research, travel search, sites without an API. |
| Calendar, Mail, Notes, Reminders, SMS/calls, draw.io, terminal | your `personal-assistant` MCP | Jarvis's fast path. |
| AWS | AWS CLI with SSO profiles (`aws sso login`) | Add an AWS MCP server later if you want one. |
| Spotify | Spotify Web API via `jarvis/bin/jarvis-spotify` (PKCE, tokens in Keychain) | Set up once: [docs/spotify-setup.md](docs/spotify-setup.md). Falls back to `osascript` for basic controls. |
| Gmail | Gmail API via `jarvis/bin/jarvis-mail` (full mailbox access, PKCE, tokens in Keychain, audit log) | Set up once: [docs/gmail-setup.md](docs/gmail-setup.md). Jarvis on every channel can then read and send your mail. |
| Video | `ffmpeg` + YouTube Data API | Add an upload MCP or a small script in Phase 7. |
| Voice | Cartesia API, Kokoro, Piper | Python libraries, not MCP. |

## Try it

```bash
./jarvis/bin/jarvis.js "what's 9+9"
```

```bash
npm start
```

Then open http://localhost:7777, press the chat button and type, or press the microphone and talk. The city button opens the **City View**: an isometric voxel city of the agents, drawn from the registry and the ledger (HQ in the centre, one building per department, hired workers walking in). Click an agent or a building for its panel, answer questions in the bottom-right inbox, double-click a building to zoom in, Esc to zoom out. Both go to the same Jarvis conversation. The CLI stays open while the city works on something you asked for, prints questions and results as they come, and takes your answers on stdin.

| Variable | Meaning |
|---|---|
| `JARVIS_BACKEND=booqy` | The old headless Claude in the Booqy folder instead of the city. |
| `JARVIS_HOME` | Where the ledger, hired agents' prompts and the audit log live (default `~/.jarvis`). |
| `JARVIS_MODEL_CAP=claude-sonnet-5-5` | Run every agent above that model on it (smoke tests). |
| `JARVIS_VERBOSE=1` | The CLI prints every agent turn, hire and retirement. |
| `JARVIS_ALLOW_API_KEY=1` | Only for future customer-facing features. Without it an `ANTHROPIC_API_KEY` in the environment stops the start. |

One process at a time owns the ledger: the HUD server or the CLI, not both.

## Jarvis: the app

Local assistant at http://localhost:7777. Everything below lives in `jarvis/`.

```bash
./jarvis/scripts/install.sh
```

```bash
./jarvis/scripts/setup-voice.sh
```

```bash
./jarvis/scripts/uninstall.sh
```

```bash
npm test
```

- `jarvis/hud/`: the page.
- `jarvis/server/server.js`: HTTP, on 127.0.0.1 only. Refuses other hosts and cross-site requests.
- `jarvis/server/state.js`: `/state.json`, from infrastructure@dev and `gh`, cached 60 s.
- `jarvis/server/chat.js`: `/api/chat`, headless Claude in the Booqy folder using the /jarvis skill.
- `jarvis/server/guard.js`: the PreToolUse hook that decides what that Claude may run. Default deny.
- `jarvis/server/progress.js`: splits streamed replies into sentences, and the spoken progress lines.
- `jarvis/server/merge.js`: merges to main. Only the owner's button or the exact words "I confirm" run one.
- `jarvis/server/listen.js`: speech to text with local Whisper, and the "Jarvis" wake word.
- `jarvis/server/voice.js`, `jarvis/bin/jarvis-say`: Kokoro for English and Piper for Swedish, tuned in `jarvis/voice.json`. macOS `say` is the fallback.
- `jarvis/app/`, `jarvis/scripts/`: LaunchAgent template, the native Mac app `~/Applications/Jarvis.app` (`Jarvis.swift`, built by `scripts/build-app.sh`), install scripts.

Logs: `~/Library/Logs/jarvis.log`. Conversation ids: `~/Library/Application Support/Jarvis/sessions.json`.

After changing anything in `jarvis/server/`:

```bash
launchctl kickstart -k gui/$(id -u)/se.lamo.jarvis
```

### Talking to Jarvis

- Voice and text are two inputs to one conversation. Type in the chat box or press the microphone; both share the same session and memory, and you can switch mid-conversation.
- Pressing the microphone turns it on and opens the conversation. Pressing it again turns it off.
- The screen shows only the core. The buttons under it open the chat or the status panels beside it; neither covers the core. A merge to main opens the chat, because its card needs you.
- With the microphone on and the window open, saying "Jarvis" first ("Jarvis, status") wakes him, and a chime confirms it. The conversation then stays open: no need to say his name again.
- It closes after 5 minutes of quiet, when you say "that's all" or "goodbye", or when you turn the microphone off.
- Talk over Jarvis, or tap the mic, and he stops speaking and listens. If it was only a noise, he carries on.
- You can talk for up to 10 minutes. Speech goes to Whisper in pieces of about 25 s at natural pauses, so the transcript grows as you talk. The longer you have talked, the longer a pause may be (1.1 s up to 2.5 s) before your turn ends.
- Replies stream: `/api/chat/stream` sends a short acknowledgement at once, progress lines while tools run or the wait is long (`jarvis/server/progress.js`), then the answer sentence by sentence. Talking over him cancels a reply still being worked on.
- Jarvis's replies use Haiku 5.5 for speed. The Orchestrator, workers and reviewers keep their own models.
- With `OPENAI_API_KEY` set, the conversation runs on OpenAI's GPT-Live over WebRTC (`jarvis/server/live.js`): it hears and speaks directly and can listen while talking. Without the key, or if it fails, the local voice takes over.
- "Jarvis" is detected on this Mac by Whisper, so nothing reaches OpenAI until you wake him or press the mic. While a conversation is open, your audio and what Jarvis says go to OpenAI. GPT-Live costs $0.05 a minute while open, with 15 s billed up front at each start and credited against that session's duration.
- Real work (Booqy, GitHub, the Orchestrator) still runs on Claude on this Mac, with the same guard and merge gate. GPT-Live passes on the result, so those results go to OpenAI as well.
- To change the voice, set `live_voice` in `jarvis/voice.json` (`vesper` is British and masculine) and restart. Local speech stays on this Mac when GPT-Live is not in use.
- To tune the voice, edit `jarvis/voice.json` and test with `jarvis/bin/jarvis-say "Good evening, sir. All systems are running."`. No restart needed.

### GitHub access

Headless Jarvis can create, edit, comment on, close and reopen PRs and issues, merge PRs into dev, rerun or cancel
runs, and `git push origin <branch>` to anything but main. `jarvis/server/guard.js` enforces this; default deny.

A merge to main is never run by the model. The guard records the request from GitHub's own data and denies it. The
server shows the PR and asks; on the Merge button or the exact words "I confirm", within 2 minutes, the server merges
that PR itself, pinned to the commit you were shown. Always denied: force push, deleting branches or repos, `--admin`,
approving PRs, secrets, workflow dispatch, writes through `gh api`.

### Choices worth knowing

- UPTIME and ALARMS read N/A: nothing local measures them, and the spec names no source.
- Headless Jarvis runs with auto-memory off. Booqy's memories are rules for coding sessions and
  made it refuse "open the PR to main for X", which the /jarvis skill defines as the owner's go-ahead.
- `--setting-sources project` keeps Booqy's `settings.local.json` allow list, user plugins and MCP
  servers out of it. The /jarvis skill still loads.

### iPhone

```bash
./jarvis/scripts/enable-iphone.sh
```

```bash
./jarvis/scripts/disable-iphone.sh
```

Then open `http://<mac-name>.local:7777` on the iPhone, on the same Wi-Fi, and use the keyboard's dictation key to speak.

- `jarvis/server/phone.js` listens on the LAN address only while the network matches the one chosen at setup, rechecked every 30 s. A VPN closes it.
- The network is recognised by its router address, netmask, DHCP server and domain, because macOS hides the router's MAC address and Wi-Fi name from Node. Another network with identical values would also open the listener, still behind the passcode.
- Every route needs the passcode. Only its scrypt hash is stored, in `iphone.json`. Five wrong tries lock the phone route, from 1 minute up to 1 hour.
- The Mac's firewall must allow incoming connections to `node`. If it blocks all incoming connections, the iPhone cannot connect.
- The connection is plain HTTP, so someone who can read traffic on your Wi-Fi could read the passcode and the session cookie. For that reason the phone cannot confirm a merge to main; that stays on the Mac.

### Away from home: Tailscale

Reach Jarvis from your iPhone anywhere, over HTTPS on your private tailnet. Nothing is exposed to the internet: no Funnel, no open port.

```bash
./jarvis/scripts/enable-tailscale.sh
```

```bash
./jarvis/scripts/disable-tailscale.sh
```

- `tailscale serve` forwards to `127.0.0.1:7778`, which `jarvis/server/tailnet.js` opens only while `tailnet.json` exists.
- Only the Tailscale login recorded at setup gets in, by the identity header Tailscale itself sets. Other users on the tailnet get 403.
- This route has the same rights as the Mac, including the microphone and confirming a merge to main.
- To use it as an app on the iPhone: open the address in Safari, then Share > Add to Home Screen. Tailscale must be on when you open it.
- For long absences: plug the Mac in, keep it from sleeping, and turn off key expiry for this Mac in the Tailscale admin console.

## Where to build it

Build it in **Claude Code on your Mac**: it needs your real files, Xcode, audio devices, long-running background processes and git. Use the Claude app for planning, diagrams, research and reviewing results. The city runs on the **Claude Agent SDK**, so it doesn't depend on any chat window.

## Safari spending

Jarvis can only spend with a `spend_approval` ticket the Orchestrator sent after the owner said yes (the ticket cites that question). The approval caps the amount Jarvis states with `--amount`; check the shop total yourself. Where the page shows a total (`[data-total]` or a "Total" line near the button), jarvis-safari also refuses when it exceeds the approved maximum. See docs/safari-setup.md.
