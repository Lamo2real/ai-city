# jarvis/openclaw — the phone channel

OpenClaw here is only a messaging channel into AI City: a message from your phone goes to Jarvis, word for word, and Jarvis's reply comes back. It is not a second orchestrator and it cannot act on the Mac. Everything real happens inside the city under `config/policy.json`.

- `openclaw.json`: the gateway on `127.0.0.1` only, token auth required, Control UI off, mDNS off; the model backend is your logged-in `claude` CLI (no API key, no OAuth token copied anywhere); every built-in tool denied; no bundled or ClawHub skills; one plugin.
- `plugins/jarvis-relay/`: the one tool, `ask_jarvis`, which POSTs to the Jarvis server's `/api/chat` in the shared `owner` conversation. Tested in `test/`.
- `workspace/AGENTS.md`, `SOUL.md`: the agent's standing instruction: relay, never answer yourself.
- Pinned to `openclaw@2026.10.10`, which includes the fixes for CVE-2026-25253 (fixed in 2026.1.29) and CVE-2026-32922 (fixed in 2026.3.11).

## Run it

The gateway token is a secret. Keep it in the Keychain; never write it into a file.

```bash
security add-generic-password -s jarvis.openclaw-gateway -a jarvis -w "$(openssl rand -hex 32)"
```

```bash
./jarvis/openclaw/bin/gateway
```

`bin/gateway` passes OpenClaw only that token (and strips any Claude OAuth token or API key from the environment: OpenClaw's Claude CLI backend uses the `claude` login on this Mac by itself). It also keeps `openclaw.json` at mode 600 and the state dir at 700, which git does not preserve. The Jarvis server must be running (`npm start` at the root). The gateway refuses any connection without the token.

## Pair Telegram (needs you; nothing here sends a message by itself)

1. In Telegram, open **@BotFather**, send `/newbot`, pick a name and a username. Copy the bot token. In BotFather also run `/setprivacy` → Disable is **not** needed (DM-only use); leave groups off.
2. Put the token into the config without pasting it in a file by hand:
   ```bash
   ./jarvis/openclaw/bin/gateway channels add --channel telegram --token '<bot token>'
   ```
   Then set `channels.telegram.enabled` to `true` in `openclaw.json` (the CLI may do it for you; check with `./jarvis/openclaw/bin/gateway config get channels.telegram.enabled`).
3. Start the gateway (above). Send any message to your bot from your own Telegram account. The bot answers with a pairing code; it does **not** process the message.
4. Approve yourself:
   ```bash
   ./jarvis/openclaw/bin/gateway pairing approve telegram <CODE>
   ```
   This also makes your Telegram account the command owner (`commands.ownerAllowFrom`). Nobody else can reach the bot: DM policy is `pairing` and groups are disabled.
5. Send "what's 9+9" to the bot. The reply is Jarvis's, from the same conversation as the HUD.

## Audit

```bash
./jarvis/openclaw/bin/gateway security audit --deep
```

With the gateway running: `JARVIS_OPENCLAW_URL=ws://127.0.0.1:18789 JARVIS_OPENCLAW_TOKEN=$(security find-generic-password -s jarvis.openclaw-gateway -w) npm test -w jarvis/openclaw` also proves the token refusal.

The result from the night it was set up is in `MORNING_REPORT.md`.
