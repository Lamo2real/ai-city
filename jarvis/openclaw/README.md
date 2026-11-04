# jarvis/openclaw: Telegram → Jarvis

OpenClaw here is only a messaging channel into AI City. A Telegram direct message from **your own account** goes to Jarvis word for word, and Jarvis's reply comes back. It is not a second orchestrator and it can't act on the Mac itself: everything real happens inside the city under `config/policy.json`. It only answers your messages and never starts a conversation.

**Your decision, recorded:** Telegram has the same rights as the HUD, including approving things and confirming a merge to main with "I confirm". So whoever controls your Telegram account controls Jarvis: turn on Telegram's two-step verification (step 6 below). Every message and every approval that arrives through Telegram is logged (see [Audit](#audit)).

- `openclaw.json`:
  - Gateway: on `127.0.0.1` only, token auth required, Control UI and mDNS off. Telegram is reached by outbound polling, so there's no inbound port.
  - Model backend: your logged-in `claude` CLI (no API key, no OAuth token copied anywhere).
  - Tools and plugins: every built-in tool denied, no bundled or ClawHub skills, one plugin.
  - Telegram: DMs only, from one allowlisted numeric user ID; groups disabled.
  - Defence in depth: a per-sender tool policy (`tools.toolsBySender`) denies `ask_jarvis` to everyone except your Telegram ID. OpenClaw only substitutes `${VARS}` in values, not keys, so `bin/gateway` writes your checked numeric ID into that key in a git-ignored, mode-600 runtime copy, `openclaw.runtime.json`. If that ever failed, you'd be denied too: it fails closed.
- `plugins/jarvis-relay/`: the one tool, `ask_jarvis`. It POSTs to Jarvis's relay route `/api/relay/chat` on `127.0.0.1` with the relay token, in the shared `owner` conversation. It refuses any non-loopback server.
- `workspace/AGENTS.md`, `SOUL.md`: the agent's standing instruction: relay, never answer yourself. Forwarded or quoted content is passed inside a labelled block. Jarvis treats that block as data. The server only confirms a merge when your whole message is exactly "I confirm", so forwarded text can never approve one.
- `launchd/` and `bin/telegram-on`, `bin/telegram-off`: the gateway as a LaunchAgent (`se.lamo.jarvis-openclaw`).
- Pinned to `openclaw@2026.10.10`, which includes the fixes for CVE-2026-25253 (fixed in 2026.1.29) and CVE-2026-32922 (fixed in 2026.3.11). `test/config.test.js` fails if any of these loosen: the pin, the single tool, the deny list, the loopback bind, the one-owner allowlist, or the "no secrets in config" rule. `test/gateway-start.test.js` proves the gateway won't start without every secret and exactly one numeric owner ID.

Every secret lives in the Keychain and nowhere else. `openclaw.json` only names environment variables, which `bin/gateway` fills from the Keychain at start:

| Keychain item | What it is |
|---|---|
| `jarvis.openclaw-gateway` | Clients must present it to the gateway (random) |
| `jarvis.openclaw-relay` | The relay presents it to Jarvis; Jarvis reads the same item (random) |
| `jarvis.openclaw-telegram` | Your bot token from @BotFather (you type it at a prompt) |
| `jarvis.openclaw-telegram-owner` | Your numeric Telegram user ID, the only allowed sender (you type it at a prompt) |

**How it runs:** OpenClaw doesn't read `openclaw.json` directly. At every start, `bin/gateway` writes `openclaw.runtime.json` next to it: the same config with your numeric ID filled into the owner-only tool-policy key. That file is git-ignored, mode 600, and holds no tokens. OpenClaw reads that runtime copy.
- **To change a setting:** edit `openclaw.json`, never the runtime copy, then restart the channel (`bin/telegram-off`, then `bin/telegram-on`).
- **Changes made through OpenClaw itself** (its CLI or doctor) go into the runtime copy, and they're lost at the next start.

## Set up Telegram (once, about 10 minutes)

1. **Create the bot.** In Telegram, open **@BotFather**, send `/newbot`, pick a name and a username, and copy the token it gives you. Don't send the token to anyone or paste it into any chat, including Jarvis.
2. **Store the bot token** in the Keychain. Paste it at the prompt, so it never lands in a file, your shell history or a command line:
   ```bash
   security add-generic-password -s jarvis.openclaw-telegram -a jarvis -w
   ```
   **Never** use `openclaw channels add --token`: it writes the token into `openclaw.json`, which is tracked by git.
3. **Find your numeric Telegram user ID**, a number like `123456789`, not your @username.
   - Option A: send any message to **@userinfobot**, which replies with your ID.
   - Option B: in Telegram Desktop, turn on *Settings → Advanced → Experimental settings → Show Peer IDs in Profile* and look at your profile.

   Store it the same way:
   ```bash
   security add-generic-password -s jarvis.openclaw-telegram-owner -a jarvis -w
   ```
4. **Create the two internal tokens**, which are random and never typed by you:
   ```bash
   security add-generic-password -s jarvis.openclaw-gateway -a jarvis -w "$(openssl rand -hex 32)"
   security add-generic-password -s jarvis.openclaw-relay   -a jarvis -w "$(openssl rand -hex 32)"
   ```
5. **Start it:**
   1. Restart Jarvis so it loads the relay route: `launchctl kickstart -k gui/$(id -u)/se.lamo.jarvis`.
   2. Turn the Telegram channel on: `jarvis/openclaw/bin/telegram-on`.

   It runs in the background and starts again after a reboot. Log: `~/Library/Logs/jarvis-openclaw.log`.
6. **Turn on two-step verification** in Telegram: *Settings → Privacy and Security → Two-Step Verification*. Telegram can approve merges here, so this protects Jarvis too.
7. **Try it:** send your bot "what's 9+9". The reply is Jarvis's, from the same conversation as the HUD. Anyone else who messages the bot is ignored: their messages never reach Jarvis.

**Stop it:**
- `jarvis/openclaw/bin/telegram-off` stops the channel, keeps it off after a reboot, and deletes the runtime copy `openclaw.runtime.json` (and its `.last-good`).
- To also remove the secrets, run `security delete-generic-password -s <item>` for each of the four items.
- To change the bot token, revoke it in @BotFather (`/revoke`), then store the new one with step 2: delete the old item first, or add `-U` to update it.

## Audit

**What arrived through Telegram.** Every relayed message is appended, one JSON line each, to `~/Library/Application Support/Jarvis/telegram-audit.jsonl` (readable only by you). Each line records:
- `ts`: when it arrived.
- `who`: your allowlisted account.
- `kind`: `message`, `merge_confirm` or `merge_cancel`.
- `merge`: for a confirmation or cancel, the repo and PR number.
- After each confirmation, a second line with `kind` `merge_outcome` and `outcome`:
  - `merged`, with the PR head SHA the merge was pinned to
  - `failed`, if GitHub refused it or the branch changed
  - `refused`, if nothing valid was waiting, e.g. the confirmation window had expired

  Failed and refused lines also give the `reason`.
- `text`: the message, with secrets and anything token-shaped redacted, capped at 500 characters.

To see what was approved from Telegram, and what happened:
```bash
grep -E '"kind":"merge_(confirm|cancel|outcome)"' ~/Library/Application\ Support/Jarvis/telegram-audit.jsonl
```

**The gateway's own log** is `~/Library/Logs/jarvis-openclaw.log`. It can show your Telegram user ID and message metadata, so `bin/telegram-on` creates it with mode 600, readable only by you, before launchd first writes to it.

**OpenClaw's own config audit:**
```bash
./jarvis/openclaw/bin/gateway security audit --deep
```

With the gateway running, `JARVIS_OPENCLAW_URL=ws://127.0.0.1:18789 JARVIS_OPENCLAW_TOKEN=$(security find-generic-password -s jarvis.openclaw-gateway -w) npm test -w jarvis/openclaw` also proves the gateway refuses clients without its token.
