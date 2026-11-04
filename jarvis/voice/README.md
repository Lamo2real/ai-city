# jarvis/voice — the real-time voice loop

A Pipecat client of the shared Jarvis conversation. Spoken turns go to the same server route and session (`owner`) as the HUD's text box, so Jarvis keeps its context when you switch between talking and typing. The pipeline speaks through Cartesia Sonic (Kokoro for English and Piper for Swedish when offline) and plays what Jarvis says unprompted (questions, results) from the server's event stream.

## Tested without audio (`uv run pytest`)

| Module | What it does | Test |
|---|---|---|
| `aggregator.py` | first clause flushed at a comma, a dash or six words; then whole sentences | `tests/test_aggregator.py` |
| `bargein.py` | owner speech > 300 ms that is not a backchannel ("mm", "yeah", "okay") stops playback; memory cut to the words played + ` [interrupted]` | `tests/test_bargein.py` |
| `longturn.py` | past 1,500 words the older part is summarized, the latest 300 stay verbatim | `tests/test_longturn.py` |
| `fallback.py` | Cartesia online; Kokoro (en) / Piper (sv) offline; the log says which | `tests/test_fallback.py` |
| `timing.py` | per-turn marks from turn end: STT final, smart-turn decision, first words from the server, TTS first byte, playback start; p50 | `tests/test_timing.py` |
| `pipeline.py` | one turn through the session; what the owner heard before a barge-in; the Haiku long-turn summary; said out loud when Claude can't be reached | `tests/test_pipeline.py` |
| `graph.py` | the Pipecat graph, inside a real Pipecat pipeline with a fake TTS and output; `main()` up to a running pipeline (skipped without the `pipeline` extra) | `tests/test_graph.py`, `tests/test_main.py` |
| `voice_io.py` | mic and speaker on one `AVAudioEngine` with voice processing: tap to 20 ms of 16 kHz PCM, playback paced to 120 ms ahead, restart when the device changes | `tests/test_voice_io.py` (offline rendering, no device; voice processing itself can't run offline) |
| `echo_check.py` | speaker to mic with voice processing off and on: level, and whether Silero heard speech | `tests/test_echo_check.py` (the verdict and the plumbing; the real check opens the mic, see below) |
| `session.py` | voice and text turns land in the same session (`owner`), events for this session only | `tests/test_session.py` |

```bash
cd jarvis/voice && uv run pytest
```

`tests/smoke_graph.py` runs the whole graph with no microphone or speaker: macOS `say` speaks into a fake mic, real Silero, smart-turn, Whisper, Kokoro and Piper run, and playback is captured to a WAV. It loads models and takes about three minutes, so pytest does not collect it.

```bash
cd jarvis/voice && uv sync --extra pipeline && uv run python tests/smoke_graph.py
```

## Running it

You need Homebrew's `portaudio` to build `pyaudio` (`config/voice.json` can still choose it), the Keychain item `jarvis.cartesia`, a voice id, and the Jarvis server running on 7777.

```bash
brew install portaudio
```

```bash
cd jarvis/voice && uv sync --extra pipeline
```

```bash
security add-generic-password -s jarvis.cartesia -a jarvis -w '<cartesia key>'
```

Pick a stock British male voice id in the Cartesia library by ear and put it in `config/voice.json` (`cartesia.voice_id`). The pipeline refuses to start without the key or the voice id, and does not fall back to the offline voices to get around them.

```bash
cd jarvis/voice && uv run python -m jarvis_voice.pipeline
```

The first start downloads Whisper turbo (about 1.6 GB), Kokoro and Piper, so it needs the network; later starts run from the cache. macOS asks for microphone access for your terminal app on the first start. If you denied it, Jarvis hears nothing and logs nothing: allow it in System Settings → Privacy & Security → Microphone and restart the terminal. The start logs a line if access is denied.

## Echo cancellation

Jarvis is meant to work over speakers without headphones, using macOS voice processing on `AVAudioEngine` (reached through PyObjC, `voice_io.py`). **This has never run on a real microphone or speaker.** Nothing in `uv run pytest` proves it cancels anything, because voice processing needs real devices. The steps below are the proof.

Mic and speaker share one engine because the canceller subtracts what that engine plays, and voice processing ducks audio played by anything else. That means other apps' sound, such as music, may get quieter while Jarvis runs, and his own voice may sound a little thinner than it did over PyAudio. Tap buffers may also arrive in bigger pieces than PyAudio's 20 ms, which would add to the barge-in time. Listen for all three.

To go back to PyAudio and headphones, set `"echo_cancellation": false` in `config/voice.json`. The pipeline never falls back to that on its own: if voice processing won't start, it logs why and stops.

### Verify it by ear (about five minutes, needs you)

Use the built-in speakers at your normal volume, with headphones unplugged and no music or calls playing, in a quiet room.

**1. Measure it.** This takes about a minute. It plays a sentence twice and records the mic, so stay silent.

```bash
cd jarvis/voice && uv sync --extra pipeline && uv run python -m jarvis_voice.echo_check
```

- `PASS` means Silero heard Jarvis with voice processing off and did not with it on.
- `INCONCLUSIVE` means the speakers were too quiet for the test to mean anything. Turn them up and rerun.
- `FAIL`, or a crash, means it doesn't work on this Mac. Keep the output: that is what needs fixing.

**2. Listen to the recordings.** The check prints their folder. Delete them when you're done, since they are recordings of your room.

```bash
afplay <folder>/heard-off.wav
```

```bash
afplay <folder>/heard-on.wav
```

The first should clearly have Jarvis's voice in it. In the second he should be gone or a faint residue.

**3. Run the real thing** (needs the Cartesia setup above and the Jarvis server), and check that the start logs `audio: voice processing on`.

```bash
cd jarvis/voice && uv run python -m jarvis_voice.pipeline
```

- [ ] Ask "tell me about Stockholm in five sentences" and stay silent. He finishes without stopping and no `barge-in:` line appears. **UNVERIFIED: needs owner**
- [ ] Ask again and talk over him. He stops about 300 ms after you start, a `barge-in: playback stopped` line appears, and he answers what you said rather than what he heard himself say. **UNVERIFIED: needs owner**
- [ ] Repeat both at high volume. A false interruption here is residual echo reaching Silero, so note the volume. **UNVERIFIED: needs owner**
- [ ] Plug in headphones or connect AirPods while he talks. The log says `audio: device changed, restarting`, and he can still hear and speak on the new device. **UNVERIFIED: needs owner**

## What has and has not run

Ran on 2026-11-05, without opening a microphone or speaker: `voice_io.py` on a real `AVAudioEngine` in offline rendering mode with voice processing off (playback to a buffer, pacing, start and stop), and its transport in a real Pipecat pipeline with a fake device. The tap got handmade buffers. Voice processing, the mic path and `echo_check` against real devices have not run.

Ran on 2026-11-04, no human, no microphone, no speaker, no Cartesia (`jarvis.cartesia` is not in the Keychain), through a fake transport, so before `voice_io.py` existed:

- [x] All of `graph.py` starts and runs with synthetic speech from `say`: Silero, smart-turn v3, Whisper turbo, Kokoro, Piper (`tests/smoke_graph.py`, all checks pass). Whisper transcribed the captured playback: the English came back word for word, the Swedish came back Swedish but garbled ("Det är klar och jag har ickat…"). Nobody has listened to it.
- [x] One turn through a real Jarvis server (scratch home, port 7791): spoken "what is nine plus nine?" came back as audio saying "Eighteen, sir."
- [x] A pause of 1 s mid-sentence stayed one turn. One pause, one synthetic voice: not the 5-minute check.
- [x] Barge-in cancels the reply and the next turn is told what was heard. Playback-stopped frame 3 ms after the decision, 303 ms after the first sound.
- [x] Offline routing logs the change; Swedish reached Piper and English Kokoro. Simulated with a flag and a dead local Cartesia port, not by pulling a network.
- [x] A failing Cartesia does not stop the graph; the offline voices take over for 30 s. A dead port only: real Cartesia has not run.
- [x] The Haiku long-turn summary, one real call through `claude -p` (13 s), on a short text with an instruction planted in it, which it did not follow. Not run on 1,500 words.

**Measured latency (ms from the end of speech):**

| Path | STT final | Smart-turn decided | First words from server | Playback start |
|---|---|---|---|---|
| Scripted Jarvis, Kokoro, short reply, p50 of 7 turns | 600 | 600 | 650 | 900 |
| Same, opening with the longer "can't reach Claude" line, p50 of 7 turns | 600 | 600 | 650 | 1,119 |
| Real Jarvis (scratch), Kokoro, 1 turn | 596 | 2,818 | 5,989 | 6,439 |

These come from a fake output, so device latency is not in them, and Cartesia is not in them.

**Known to miss the targets:**

- **First audio ≤ 800 ms will not be met.** Direct server turns took 5.4 to 10.7 s to the first sentence (4 turns), far above everything in this pipeline. The server emits whole sentences, and each Jarvis turn resumes an SDK session. With no Claude wait at all, Whisper and Kokoro alone were about 900 ms.
- **Smart-turn waited for the 2.5 s ceiling** on "Hey Jarvis, what is nine plus nine?" in all three runs with the synthetic voice, and on some short follow-ups. Check it with a real voice.
- **Stop ≤ 200 ms conflicts with "speech > 300 ms".** The first sound to the stop is at least 300 ms by the skill's own rule. `stop_ms` measures from the decision; `stop_from_onset_ms` from the first sound. Neither includes the audio device's buffer.

**Known gaps** (the code has `shortcut:` where it applies):

- Backchannels stop playback if they last over 300 ms. MLX Whisper has no text until the owner stops, so the graph can't tell "yeah" from a real interruption in time. It needs a streaming STT.
- Echo cancellation has never run on real devices (see above). Barge-in does not flush what is queued, so up to 120 ms more plays out after the stop, plus the device's own buffer.
- Whisper is segmented, not streaming, and the offline English voice is Kokoro on ONNX (Pipecat's service), not MLX.
- A clause already sent to Cartesia when the connection drops is lost; the next one goes to Kokoro.
- Word timing on the real Cartesia stream is untested; `tests/test_graph.py` uses a fake that reports timestamps the same way. Without timed words, what was heard is estimated at 2.5 words a second.
- Swedish through Cartesia (`TTSUpdateSettingsFrame`) has not run.
- Offline Jarvis can't think: he says he can't reach Claude, in the owner's language, and the server keeps trying.
- The HUD does not show this pipeline's transcript or state.

## Checks from the skill: needs the owner

- [ ] "hey Jarvis, what's 9 plus 9?" → audio with a lead-in, says eighteen. Expect the answer to be right and the 800 ms target to be missed (see above). **UNVERIFIED: needs owner**
- [ ] Talk over Jarvis mid-sentence → he stops about 300 ms after you start; "what were you saying?" → he knows where he was cut off. **UNVERIFIED: needs owner**
- [ ] Speak for 5 minutes with pauses mid-sentence → no premature reply. **UNVERIFIED: needs owner**
- [ ] Pull the network → English falls back to Kokoro, Swedish to Piper, and the log says so. **UNVERIFIED: needs owner**
- [ ] Logged latency: `uv run python -m jarvis_voice.timing` prints the p50s from `~/Library/Logs/jarvis-voice-timings.jsonl`. **UNVERIFIED: needs owner**
