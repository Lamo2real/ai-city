# Jarvis OS: local app on the owner's Mac (spec)

Everything runs locally on the owner's Mac, which is always on. No AWS resources, no domain, no hosting. The only outside service is optional: OpenAI GPT-Live for the voice conversation, with `OPENAI_API_KEY` in ~/.zshrc.

The owner opens http://localhost:7777 (Mac) and talks to Jarvis by typing or speaking in the HUD. Jarvis answers in text and a voice, with live status around it. Jarvis keeps the role of the /jarvis skill: reads state, answers, relays instructions to the Booqy Orchestrator routine. It never writes code, deploys or approves. It has GitHub write access, and merges to main only after the owner confirms (see README).

## Pieces

1. **Frontend:** `infrastructure/jarvis-hud/index.html` (the version delivered with this spec). It reads `./state.json` and POSTs `{message, sessionId, voice}` to `./api/chat`, expecting `{reply, audio?}`. Keep its design; fix bugs only, and make it work below 1100 px wide.

2. **Local server:** `infrastructure/jarvis-hud/server/` (Node 22, no framework or a minimal one), listening on 127.0.0.1:7777 only.
   - `GET /` serves the HUD. `GET /state.json` builds the state live (cache 60 s) from: STATUS.md, PIPELINE.md and DECISIONS.md on infrastructure@dev (git fetch + read), open PRs and check status across the six repos via `gh`, schema exactly as the HUD's DEMO object.
   - `POST /api/chat`: runs Claude Code headless in the booqy folder with the Jarvis skill, e.g. `claude -p "<message>" --output-format json` with `--resume <session id>` per HUD sessionId so the conversation continues, model Haiku 5.5 for speed (the Orchestrator, workers and reviewers keep their own models), and a system/append prompt: "You are Jarvis, speaking aloud through the Jarvis HUD. Follow the /jarvis skill. Answer in 1-4 short sentences unless asked for detail; composed, dry, precise British-butler delivery; address the owner as 'sir' in status reports; match Swedish or English to the owner." Check `claude --help` for the exact flags of the installed version; do not guess.
   - Permissions for that headless Claude: read files, run `gh` read commands, `git fetch`, and `curl` to the Orchestrator fire URL only. It must not edit files, push, merge, or approve. Enforce with the CLI's allowed/disallowed tools settings, not only the prompt.
   - Voice (if `voice:true`): synthesise with the macOS `say` command using a built-in en-GB male voice (e.g. Daniel; Swedish replies with a built-in sv-SE voice such as Alva), convert to MP3 or AAC with `afconvert` or ffmpeg if present, return base64 in `audio`. Stock system voices only; no cloned or celebrity-imitation voice.
   - Uses the `ORCHESTRATOR_FIRE_URL` / `ORCHESTRATOR_TOKEN` already in ~/.zshrc; never returns them to the page.
   - Logs to ~/Library/Logs/jarvis.log, no secrets.

3. **Auto-start:** a LaunchAgent `~/Library/LaunchAgents/se.lamo.jarvis.plist` that starts the server at login and restarts it if it crashes (KeepAlive), with the owner's PATH and zsh environment so `claude`, `gh` and the env vars work. Add a one-line install script and an uninstall script.

4. **App feel:** create a small macOS app wrapper or a Safari/Chrome "Add to Dock" web app for http://localhost:7777 so it opens like its own app with the Jarvis name and an orange icon. Simplest that works.

5. **iPhone (optional, still local):** if the owner wants it, bind also to the Mac's LAN address behind a passcode prompt, reachable as http://<mac-name>.local:7777 on the home Wi-Fi only. On iPhone, speech input uses the keyboard's dictation key (browser mic APIs need HTTPS). Ask the owner before enabling this.

## Tests
Server unit tests with `claude` and `gh` mocked (chat returns reply, voice returns audio, state.json shape matches the DEMO object, port bound to 127.0.0.1 only, secrets never in responses). Manual check: open http://localhost:7777, the DATA tag shows LIVE, type "status" and hear a short British-voiced answer matching STATUS.md, press the mic and say "status", say "open the PR to main for X" and see "Passed to the Orchestrator".

## Done when
After a reboot, the owner opens the Jarvis app, it shows LIVE data, and both typing and speaking work.

## Voice

- **Engine:** English: Kokoro through kokoro-onnx (local, neural, licence Apache 2.0, https://huggingface.co/hexgrad/Kokoro-82M), stock voice `bm_george`. Swedish: Piper through sherpa-onnx, pinned to 1.13.8 (2.x has no text frontend for Piper models). Both in `~/.jarvis/venv`, run by `bin/jarvis_say.py`, which the server keeps loaded. Fallback: macOS `say` (Daniel, Alva) through the same filter. The engine used is logged to `~/Library/Logs/jarvis.log`. Everything is local, with no API keys.
- **Why not Piper for English:** the owner found it robotic, and the source of the "alan" voice states "Copyright 2022 Mycroft AI, All Rights Reserved". It is no longer used.
- **Tuning:** `voice.json` (speed, en_voice, filter, volume, model folders, fallback voices).
- **Swedish model:** `~/.jarvis/tts/vits-piper-sv_SE-nst-medium`, same release (Piper voice: https://huggingface.co/rhasspy/piper-voices/tree/main/sv/sv_SE/nst/medium). **Licence:** dataset CC0 (https://www.nb.no/sprakbanken/en/resource-catalogue/oai-nb-no-sbr-17/).
- **Identity:** a stock voice with a light metallic filter. Never clone, imitate or tune towards a real actor's or film character's voice.
- **Other stock British voices:** set `en_voice` to `bm_fable`, `bm_lewis` or `bm_daniel`.

## Conversation

Works like a voice agent: replies stream sentence by sentence with spoken progress while Jarvis works (`POST /api/chat/stream`, one JSON event per line: filler, sentence, done or error), the owner can interrupt at any time, and one turn of speech can last up to 10 minutes.

With `OPENAI_API_KEY` set, an open conversation uses GPT-Live (`gpt-live-1`, voice `vesper`, client delegation) over WebRTC. The key stays on the server: the page sends its SDP offer to `POST /api/live/session`. The wake word stays local. Delegated work runs on the existing Claude backend, and a merge to main is still confirmed only by the owner's button or their transcribed words, never by the model.


## Phone app bridge

A token-authenticated API for the Jarvis iPhone app, in `server/app-api.js`. It exists only on the tailnet listener (`tailscale serve` HTTPS → 127.0.0.1:7778), after the Host, HTTPS and Tailscale owner-login checks. It is not served on localhost or the LAN listener.

**Auth:** `Authorization: Bearer <token>`, compared in constant time (both sides SHA-256 hashed, then `timingSafeEqual`) with the Keychain item `jarvis.phone-pairing`. Missing or wrong → `401 {"error":"not paired"}`. The token is cached and re-read from Keychain at most every 10 s when one does not match, so re-pairing needs no restart. The token and the Authorization header are never logged.

**Limits:** 5 wrong tokens lock the API (all callers, even the right token) for 30 s, doubling on each repeat up to 1 h, with `429` and `Retry-After`; a correct token resets it. 30 requests a minute per token and one chat in flight → `429` with `Retry-After`. Request bodies up to 96 KB, messages 1 to 20000 characters. POST needs `Content-Type: application/json`.

**Endpoints** (base `/api/app/v1`):
- `GET /health` → `{"ok":true,"name":"Jarvis"}`
- `POST /chat` `{"message": string}` → the normal NDJSON stream (`filler`, `sentence`, then `done` or `error`). It runs as session `owner`, shared with voice and the HUD, with `phone=true`: a merge to main cannot be confirmed from the phone (`confirm` is always null), and there is no audio, since the phone speaks. Jarvis creates tickets itself through `send_ticket`, as from the HUD.
- `GET /events` → server-sent events, only `{"type":"jarvis","text":...}` for session `owner` (results and questions Jarvis raises unprompted). No audio, no city events. A `: keepalive` comment every 25 s.

**Pairing:** `jarvis/scripts/pair-iphone.sh` (`node server/app-api.js pair`) needs `tailnet.json` (run `scripts/enable-tailscale.sh` first). It makes 32 random bytes (base64url, 43 characters), stores them in Keychain through `security -i` on stdin (replacing any old token, which rotates it), and shows `jarvis-pair://v1?host=<tailnet host>&token=<token>` as a terminal QR code (`scripts/qr.swift`, payload on stdin) plus once as text. Nothing is written to files. `pair-iphone.sh unpair` removes the item.
