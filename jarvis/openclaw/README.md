# jarvis/openclaw — the phone channel

OpenClaw here is only a messaging channel into AI City: a message from your phone goes to Jarvis, word for word, and Jarvis's reply comes back. It is not a second orchestrator and it cannot act on the Mac. Everything real happens inside the city under `config/policy.json`.

- `openclaw.json`: the gateway on `127.0.0.1` only, token auth required, Control UI off, mDNS off; the model backend is your logged-in `claude` CLI (no API key, no OAuth token copied anywhere); every built-in tool denied; no bundled or ClawHub skills; one plugin.
- `plugins/jarvis-relay/`: the one tool, `ask_jarvis`. It POSTs to Jarvis's relay route `/api/relay/chat` on `127.0.0.1` with the relay token. That route has the phone's rights, not the HUD's: a merge to main can never be confirmed through OpenClaw, and a merge it starts is cancelled. It uses the shared `owner` conversation. Tested in `test/` and `jarvis/test/relay-route.test.js`.
- `workspace/AGENTS.md`, `SOUL.md`: the agent's standing instruction: relay, never answer yourself.
- Pinned to `openclaw@2026.10.10`, which includes the fixes for CVE-2026-25253 (fixed in 2026.1.29) and CVE-2026-32922 (fixed in 2026.3.11). `test/config.test.js` fails if the pin, the single tool, the deny list, the loopback bind or the "no secrets in config" rule ever loosens.

## Run it

Every secret lives in the Keychain and nowhere else. `openclaw.json` only names environment variables, which `bin/gateway` fills from the Keychain at start.

```bash
security add-generic-password -s jarvis.openclaw-gateway -a jarvis -w "$(openssl rand -hex 32)"   # clients -> gateway
security add-generic-password -s jarvis.openclaw-relay   -a jarvis -w "$(openssl rand -hex 32)"   # relay -> Jarvis
```

```bash
./jarvis/openclaw/bin/gateway
```

`bin/gateway` passes OpenClaw only those tokens, plus the Telegram bot token if you've stored one. It strips any Claude OAuth token or API key from the environment, because OpenClaw's Claude CLI backend uses the `claude` login on this Mac by itself. It also keeps `openclaw.json` at mode 600 and the state dir at 700, which git does not preserve. The Jarvis server must be running (`npm start` at the root) and reads the relay token from the same Keychain item. The gateway refuses any connection without its token, and Jarvis refuses the relay route without the relay token.

## Pair Telegram (later, phase 1; needs you; nothing here sends a message by itself)

1. In Telegram, open **@BotFather**, send `/newbot`, pick a name and a username, and copy the bot token. Leave groups off.
2. Store the token in the Keychain. Paste it at the prompt, so it never lands in a file, your shell history or a command line:
   ```bash
   security add-generic-password -s jarvis.openclaw-telegram -a jarvis -w
   ```
   **Do not** use `openclaw channels add --token`: it writes the token into `openclaw.json`, which is tracked by git. `test/config.test.js` fails if a token ever appears there.
3. Set `channels.telegram.enabled` to `true` in `openclaw.json`, then start the gateway (above). It reads the bot token from the Keychain as `TELEGRAM_BOT_TOKEN`.
4. Send any message to your bot from your own Telegram account. The bot answers with a pairing code; it does **not** process the message. Approve yourself:
   ```bash
   ./jarvis/openclaw/bin/gateway pairing approve telegram <CODE>
   ```
   Nobody else can reach the bot: DM policy is `pairing` and groups are disabled.
5. Send "what's 9+9" to the bot. The reply is Jarvis's, from the same conversation as the HUD.

## Audit

```bash
./jarvis/openclaw/bin/gateway security audit --deep
```

With the gateway running: `JARVIS_OPENCLAW_URL=ws://127.0.0.1:18789 JARVIS_OPENCLAW_TOKEN=$(security find-generic-password -s jarvis.openclaw-gateway -w) npm test -w jarvis/openclaw` also proves the token refusal.

The result from the night it was set up is in `MORNING_REPORT.md`.
