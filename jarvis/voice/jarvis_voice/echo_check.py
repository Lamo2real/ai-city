"""Plays a sentence through the speakers with voice processing off, then on, records the mic
both times and runs what it heard through the same Silero settings as the graph. Run it in a
quiet room and stay silent. It opens the microphone, so only the owner runs it."""
from __future__ import annotations

import asyncio
import math
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

import numpy as np

SENTENCE = "Good evening, sir. The city is quiet tonight, all departments report in, and nothing needs your attention before morning. " * 2
SETTLE_S = 1.5  # the canceller needs a moment before it has learned the room
TAIL_S = 0.5
CHUNK = 960 * 2  # 40 ms at 24 kHz


def spoken(text: str, folder: Path) -> bytes:
    path = folder / "played.wav"
    subprocess.run(["say", "-o", str(path), "--data-format=LEI16@24000", text], check=True)
    with wave.open(str(path)) as w:
        return w.readframes(w.getnframes())


def level_db(pcm: bytes) -> float:
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float64) / 32768
    return 20 * math.log10(max(float(np.sqrt(np.mean(samples**2))), 1e-6)) if len(samples) else -120.0


async def speech_seconds(pcm: bytes) -> float:
    """How long Silero stayed in SPEAKING, which is what fires a barge-in in the graph."""
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.audio.vad.vad_analyzer import VADParams, VADState

    from .graph import BARGE_IN_START_S

    vad = SileroVADAnalyzer(params=VADParams(start_secs=BARGE_IN_START_S))
    vad.set_sample_rate(16000)
    chunk, speaking = 640, 0
    for i in range(0, len(pcm), chunk):
        if await vad.analyze_audio(pcm[i:i + chunk]) == VADState.SPEAKING:
            speaking += 1
    return speaking * chunk / 2 / 16000


def verdict(off_speech: float, on_speech: float) -> tuple[bool, str]:
    if off_speech == 0:
        return False, "INCONCLUSIVE: even without voice processing Silero heard nothing. Turn the volume up, use the built-in speakers and try again."
    if on_speech > 0:
        return False, f"FAIL: with voice processing on Silero still heard {on_speech:.1f} s, so Jarvis would interrupt himself. Try a lower volume."
    return True, "PASS: Silero heard him without voice processing and not with it."


def record(voice_processing: bool, pcm: bytes) -> bytes:
    from .voice_io import VoiceIO

    got = bytearray()
    io = VoiceIO(voice_processing)
    io.on_mic = got.extend
    io.start()
    try:
        time.sleep(0.2)
        for i in range(0, len(pcm), CHUNK):
            io.play(pcm[i:i + CHUNK])
        time.sleep(TAIL_S)
    finally:
        io.on_mic = None
        io.stop()
    return bytes(got)[int(SETTLE_S * 16000) * 2:]


def main() -> None:
    folder = Path(tempfile.mkdtemp(prefix="jarvis-echo-check-"))
    played = spoken(SENTENCE, folder)
    seconds = {}
    levels = {}
    for name, on in (("off", False), ("on", True)):
        print(f"Voice processing {name}: playing {len(played) / 2 / 24000:.0f} s, stay silent…", flush=True)
        heard = record(on, played)
        with wave.open(str(folder / f"heard-{name}.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(heard)
        levels[name], seconds[name] = level_db(heard), asyncio.run(speech_seconds(heard))
        print(f"  mic level {levels[name]:.1f} dBFS, Silero heard speech for {seconds[name]:.1f} s", flush=True)
    passed, line = verdict(seconds["off"], seconds["on"])
    print(f"Reduction {levels['off'] - levels['on']:.1f} dB. {line}\nRecordings (delete them when done): {folder}")
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
