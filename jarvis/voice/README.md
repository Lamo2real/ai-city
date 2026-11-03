# jarvis/voice — the real-time voice loop

A Pipecat client of the shared Jarvis conversation. Spoken turns go to the same server route and session (`owner`) as the HUD's text box, so Jarvis keeps its context when you switch between talking and typing. The pipeline speaks through Cartesia Sonic (Kokoro-MLX for English and Piper for Swedish when offline) and plays what Jarvis says unprompted (questions, results) from the server's event stream.

## Tested without audio (`uv run pytest`)

| Module | What it does | Test |
|---|---|---|
| `aggregator.py` | first clause flushed at a comma, a dash or six words; then whole sentences | `tests/test_aggregator.py` |
| `bargein.py` | owner speech > 300 ms that is not a backchannel ("mm", "yeah", "okay") stops playback; memory cut to the words played + ` [interrupted]` | `tests/test_bargein.py` |
| `longturn.py` | past 1,500 words the older part is summarized, the latest 300 stay verbatim | `tests/test_longturn.py` |
| `fallback.py` | Cartesia online; Kokoro (en) / Piper (sv) offline; the log says which | `tests/test_fallback.py` |
| `timing.py` | per-turn marks from turn end: STT final, LLM first token, TTS first byte, playback start; p50 | `tests/test_timing.py` |
| `session.py` | voice and text turns land in the same session (`owner`), events for this session only | `tests/test_session.py` |

```bash
cd jarvis/voice && uv run pytest
```

## Running it (UNVERIFIED — needs owner)

```bash
cd jarvis/voice && uv sync --extra pipeline
```

```bash
security add-generic-password -s jarvis.cartesia -a jarvis -w '<cartesia key>'
```

Pick a stock British male voice id in the Cartesia library by ear and put it in `config/voice.json` (`cartesia.voice_id`). Then, with the Jarvis server running:

```bash
cd jarvis/voice && uv run python -m jarvis_voice.pipeline
```

`pipeline.py` wires Pipecat 1.15 (local audio transport, Silero VAD, local smart-turn v3, MLX Whisper, Cartesia). Nothing in it has run against a microphone, a speaker or Cartesia. Known gaps, marked `shortcut:` in the code: the offline fallback services are selected but not yet wired into the Pipecat graph; the long-turn summary uses a truncation instead of a Haiku call.

## Checks from the skill — UNVERIFIED, needs owner

- [ ] "hey Jarvis, what's 9 plus 9?" → audio starts with a lead-in within 800 ms p50, says eighteen. **UNVERIFIED — needs owner**
- [ ] Talk over Jarvis mid-sentence → it stops within 200 ms; "what were you saying?" → it knows where it was cut off. **UNVERIFIED — needs owner**
- [ ] Speak for 5 minutes with pauses mid-sentence → no premature reply. **UNVERIFIED — needs owner**
- [ ] Pull the network → English falls back to Kokoro, Swedish to Piper, and the log says so. **UNVERIFIED — needs owner** (the selection and the log line are unit-tested; the audio path is not)
- [ ] Logged p50 latency within target: `python3 -c "from jarvis_voice.timing import p50; print(p50(open('~/Library/Logs/jarvis-voice-timings.jsonl').read().splitlines()))"` **UNVERIFIED — needs owner**
