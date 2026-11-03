---
name: jarvis-voice-streaming
description: Build or tune Jarvis's real-time voice loop on macOS (Pipecat, Silero VAD, smart-turn, streaming STT, Haiku, Cartesia Sonic with Kokoro-MLX/Piper fallback), including barge-in, interruption memory and instant lead-ins. Use for any voice/ work.
---

# Jarvis real-time voice

Replaces the old batch voice path (synthesize whole reply → MP3 → play). Keep Piper and `jarvis-say` only as the offline Swedish fallback.

## Pipeline (Pipecat, in `voice/`)
mic → macOS voice-processing input (echo cancellation on) → Silero VAD → wake word "Jarvis" (optional; push-to-talk hotkey as alternative) → streaming STT → smart-turn end-of-turn model → Haiku (`claude-haiku-5-5`, streaming, prompt from `agents/core/jarvis.md`) → sentence/clause aggregator → Cartesia Sonic streaming TTS over WebSocket with word timestamps → speaker. HUD gets transcript + state over WebSocket on 127.0.0.1:7777.

## Targets (measure, don't assume)
- End of owner speech → first Jarvis audio: ≤ 800 ms p50.
- Owner starts talking → Jarvis audio stops: ≤ 200 ms.
- Log per-turn timings: turn-end, STT final, LLM first token, TTS first byte, playback start.

## Turn-taking
- Never use a fixed long silence timeout. smart-turn decides "complete" vs "incomplete". Complete → respond. Incomplete → keep listening (VAD silence ceiling ~2.5 s as a backstop).
- No length limit on owner speech: STT streams continuously. If one turn's transcript passes ~1,500 words, summarize the older part before sending to the LLM, keeping the latest 300 words verbatim.

## Barge-in
- While Jarvis is speaking, owner speech (after echo cancellation) for > 300 ms that is not a backchannel ("mm", "yeah", "okay", "mhm") → stop playback, cancel the LLM and TTS streams.
- Memory: truncate Jarvis's last message to the words actually played (TTS word timestamps vs playback position) and append ` [interrupted]`. Keep everything the owner said before and during the interruption. The next LLM call sees both.

## Lead-ins
The prompt makes Haiku open with a short contextual lead-in ("Math it is —"). The aggregator flushes the first clause to TTS as soon as it ends (comma, dash or ≥ 6 words), so audio starts before the full reply exists. For delegated work, Jarvis acknowledges in one line and speaks again when the Secretary's summary arrives.

## Voice
- Main: Cartesia Sonic (latest model), one stock British male voice, picked by ear and fixed in `config/voice.json`. Swedish via the same model when the owner speaks Swedish.
- Offline fallback: Kokoro-MLX `bm_george` (English); Piper sv_SE (Swedish).
- Original voice only: never clone or imitate a real actor's or film character's voice.
- API key from Keychain `jarvis.cartesia`. Keep one warm WebSocket to avoid cold-start latency.

## Checks
- "hey Jarvis, what's 9 plus 9?" → audio starts with a lead-in within target, says eighteen.
- Talk over Jarvis mid-sentence → it stops within target; ask "what were you saying?" → it knows where it was cut off.
- Speak for 5 minutes with pauses mid-sentence → no premature reply.
- Pull the network → English falls back to Kokoro, Swedish to Piper, and the log says so.
