# Jarvis OS

Local assistant for Booqy, at http://localhost:7777. Built from [SPEC.md](SPEC.md).

```bash
./scripts/install.sh
```

```bash
./scripts/setup-voice.sh
```

```bash
./scripts/uninstall.sh
```

```bash
npm test
```

- `hud/`: the page.
- `server/server.js`: HTTP, on 127.0.0.1 only. Refuses other hosts and cross-site requests.
- `server/state.js`: `/state.json`, from infrastructure@dev and `gh`, cached 60 s.
- `server/chat.js`: `/api/chat`, headless Claude in the Booqy folder using the /jarvis skill.
- `server/guard.js`: the PreToolUse hook that decides what that Claude may run. Default deny.
- `server/progress.js`: splits streamed replies into sentences, and the spoken progress lines.
- `server/merge.js`: merges to main. Only the owner's button or the exact words "I confirm" run one.
- `server/listen.js`: speech to text with local Whisper, and the "Jarvis" wake word.
- `server/voice.js`, `bin/jarvis-say`: Kokoro for English and Piper for Swedish, tuned in `voice.json`. macOS `say` is the fallback.
- `app/`, `scripts/`: LaunchAgent template, `~/Applications/Jarvis.app`, install scripts.

Logs: `~/Library/Logs/jarvis.log`. Conversation ids: `~/Library/Application Support/Jarvis/sessions.json`.

After changing anything in `server/`:

```bash
launchctl kickstart -k gui/$(id -u)/se.lamo.jarvis
```

## Talking to Jarvis

- Pressing the microphone turns it on and opens the conversation. Pressing it again turns it off.
- The screen shows only the core. The buttons under it open the chat or the status panels beside it; neither covers the core. A merge to main opens the chat, because its card needs you.
- With the microphone on and the window open, saying "Jarvis" first ("Jarvis, status") wakes him, and a chime confirms it. The conversation then stays open: no need to say his name again.
- It closes after 5 minutes of quiet, when you say "that's all" or "goodbye", or when you turn the microphone off.
- Talk over Jarvis, or tap the mic, and he stops speaking and listens. If it was only a noise, he carries on.
- You can talk for up to 10 minutes. Speech goes to Whisper in pieces of about 25 s at natural pauses, so the transcript grows as you talk. The longer you have talked, the longer a pause may be (1.1 s up to 2.5 s) before your turn ends.
- Replies stream: `/api/chat/stream` sends a short acknowledgement at once, progress lines while tools run or the wait is long (`server/progress.js`), then the answer sentence by sentence. Talking over him cancels a reply still being worked on.
- Jarvis's replies use Haiku 5.5 for speed. The Orchestrator, workers and reviewers keep their own models.
- With `OPENAI_API_KEY` set, the conversation runs on OpenAI's GPT-Live over WebRTC (`server/live.js`): it hears and speaks directly and can listen while talking. Without the key, or if it fails, the local voice takes over.
- "Jarvis" is detected on this Mac by Whisper, so nothing reaches OpenAI until you wake him or press the mic. While a conversation is open, your audio and what Jarvis says go to OpenAI. GPT-Live costs $0.05 a minute while open, with 15 s billed up front at each start and credited against that session's duration.
- Real work (Booqy, GitHub, the Orchestrator) still runs on Claude on this Mac, with the same guard and merge gate. GPT-Live passes on the result, so those results go to OpenAI as well.
- To change the voice, set `live_voice` in `voice.json` (`vesper` is British and masculine) and restart. Local speech stays on this Mac when GPT-Live is not in use.
- To tune the voice, edit `voice.json` and test with `bin/jarvis-say "Good evening, sir. All systems are running."`. No restart needed.

## GitHub access

Headless Jarvis can create, edit, comment on, close and reopen PRs and issues, merge PRs into dev, rerun or cancel
runs, and `git push origin <branch>` to anything but main. `server/guard.js` enforces this; default deny.

A merge to main is never run by the model. The guard records the request from GitHub's own data and denies it. The
server shows the PR and asks; on the Merge button or the exact words "I confirm", within 2 minutes, the server merges
that PR itself, pinned to the commit you were shown. Always denied: force push, deleting branches or repos, `--admin`,
approving PRs, secrets, workflow dispatch, writes through `gh api`.

## Choices worth knowing

- UPTIME and ALARMS read N/A: nothing local measures them, and the spec names no source.
- Headless Jarvis runs with auto-memory off. Booqy's memories are rules for coding sessions and
  made it refuse "open the PR to main for X", which the /jarvis skill defines as the owner's go-ahead.
- `--setting-sources project` keeps Booqy's `settings.local.json` allow list, user plugins and MCP
  servers out of it. The /jarvis skill still loads.

## iPhone

```bash
./scripts/enable-iphone.sh
```

```bash
./scripts/disable-iphone.sh
```

Then open `http://<mac-name>.local:7777` on the iPhone, on the same Wi-Fi, and use the keyboard's dictation key to speak.

- `server/phone.js` listens on the LAN address only while the network matches the one chosen at setup, rechecked every 30 s. A VPN closes it.
- The network is recognised by its router address, netmask, DHCP server and domain, because macOS hides the router's MAC address and Wi-Fi name from Node. Another network with identical values would also open the listener, still behind the passcode.
- Every route needs the passcode. Only its scrypt hash is stored, in `iphone.json`. Five wrong tries lock the phone route, from 1 minute up to 1 hour.
- The Mac's firewall must allow incoming connections to `node`. If it blocks all incoming connections, the iPhone cannot connect.
- The connection is plain HTTP, so someone who can read traffic on your Wi-Fi could read the passcode and the session cookie. For that reason the phone cannot confirm a merge to main; that stays on the Mac.

## Away from home: Tailscale

Reach Jarvis from your iPhone anywhere, over HTTPS on your private tailnet. Nothing is exposed to the internet: no Funnel, no open port.

```bash
./scripts/enable-tailscale.sh
```

```bash
./scripts/disable-tailscale.sh
```

- `tailscale serve` forwards to `127.0.0.1:7778`, which `server/tailnet.js` opens only while `tailnet.json` exists.
- Only the Tailscale login recorded at setup gets in, by the identity header Tailscale itself sets. Other users on the tailnet get 403.
- This route has the same rights as the Mac, including the microphone and confirming a merge to main.
- To use it as an app on the iPhone: open the address in Safari, then Share > Add to Home Screen. Tailscale must be on when you open it.
- For long absences: plug the Mac in, keep it from sleeping, and turn off key expiry for this Mac in the Tailscale admin console.
