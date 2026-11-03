"""The Pipecat pipeline: mic → Silero VAD → streaming STT → smart-turn → the shared
Jarvis session → clause aggregator → Cartesia Sonic (Kokoro/Piper offline) → speaker.

UNVERIFIED — needs owner: nothing here has run against a microphone, a speaker or
Cartesia. Pipecat is imported lazily so the tested modules never need it. Install with
`uv sync --extra pipeline`, run with `uv run python -m jarvis_voice.pipeline`.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import threading
from pathlib import Path

from .aggregator import ClauseAggregator
from .bargein import interruption_note, should_interrupt, truncate_spoken
from .fallback import EngineRouter
from .longturn import condense
from .session import JarvisSession
from .timing import TimingLog

CONFIG = Path(__file__).resolve().parents[3] / "config" / "voice.json"


def load_config(path: Path = CONFIG) -> dict:
    return json.loads(path.read_text())


def keychain(service: str) -> str | None:
    """Secrets come from the Keychain only; never from files or the environment."""
    try:
        return subprocess.run(["security", "find-generic-password", "-s", service, "-w"], capture_output=True, text=True, check=True).stdout.strip() or None
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


class JarvisTurnProcessor:
    """Owner transcript in, clauses to speak out, through the shared session.

    Built as a Pipecat FrameProcessor at runtime (see build_pipeline) so this module
    imports without Pipecat. Keeps the interruption memory: what the owner heard of the
    last reply goes in front of the next turn, the same way the HUD does it.
    """

    def __init__(self, session: JarvisSession, timing: TimingLog, log=print):
        self.session = session
        self.timing = timing
        self.log = log
        self.aggregator = ClauseAggregator()
        self.heard: str = ""  # Jarvis's last reply, cut to what was played, if interrupted
        self.spoken_words: list[tuple[str, float]] = []
        self.played_s = 0.0
        self.summarize = lambda older: older[:400]  # shortcut: no LLM summary of a long turn yet; replace with a Haiku call when the pipeline runs

    def owner_said(self, transcript: str):
        """One owner turn. Yields the pieces to speak as they are ready."""
        timer = self.timing.start()
        timer.mark("turn_end")
        timer.mark("stt_final")
        text = condense(transcript, self.summarize)
        if self.heard:
            text = interruption_note(self.heard, text)
            self.heard = ""
        self.aggregator.reset()
        self.spoken_words, self.played_s = [], 0.0
        first = True
        try:
            for sentence in self.session.sentences(text):
                if first:
                    timer.mark("llm_first_token")
                    first = False
                for piece in self.aggregator.push(sentence + " "):
                    yield piece
            yield from self.aggregator.flush()
        finally:
            self.timing.finish(timer)

    def on_tts_word(self, word: str, start_s: float) -> None:
        self.spoken_words.append((word, start_s))

    def on_played(self, seconds: float) -> None:
        self.played_s = seconds

    def interrupted(self, speech_ms: float, text: str = "") -> bool:
        if not should_interrupt(speech_ms, text):
            return False
        self.heard = truncate_spoken("", self.spoken_words, self.played_s)
        self.log(f"barge-in: heard up to '{self.heard}'")
        return True


def build_pipeline(config: dict | None = None, log=print):
    """UNVERIFIED — needs owner. Wires Pipecat; names follow pipecat-ai 1.15."""
    from pipecat.audio.vad.silero import SileroVADAnalyzer  # type: ignore[import-not-found]
    from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3  # type: ignore[import-not-found]
    from pipecat.frames.frames import EndFrame, InterruptionFrame, TextFrame, TranscriptionFrame  # type: ignore[import-not-found]
    from pipecat.pipeline.pipeline import Pipeline  # type: ignore[import-not-found]
    from pipecat.pipeline.runner import PipelineRunner  # type: ignore[import-not-found]
    from pipecat.pipeline.task import PipelineParams, PipelineTask  # type: ignore[import-not-found]
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor  # type: ignore[import-not-found]
    from pipecat.services.cartesia.tts import CartesiaTTSService  # type: ignore[import-not-found]
    from pipecat.services.whisper.stt import MLXModel, WhisperSTTServiceMLX  # type: ignore[import-not-found]
    from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioTransportParams  # type: ignore[import-not-found]

    cfg = config or load_config()
    session = JarvisSession(cfg.get("server", "http://127.0.0.1:7777"), cfg.get("session_id", "owner"))
    timing = TimingLog(os.path.expanduser(cfg.get("timing_log", "~/Library/Logs/jarvis-voice-timings.jsonl")), log)
    turns = JarvisTurnProcessor(session, timing, log)
    router = EngineRouter(log=log)

    class JarvisProcessor(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, TranscriptionFrame):
                loop = asyncio.get_running_loop()
                for piece in await loop.run_in_executor(None, lambda: list(turns.owner_said(frame.text))):
                    await self.push_frame(TextFrame(piece), direction)
            elif isinstance(frame, InterruptionFrame):
                turns.interrupted(BARGE_IN_ASSUMED_MS)
                await self.push_frame(frame, direction)
            else:
                await self.push_frame(frame, direction)

    # Cartesia Sonic, one stock British voice fixed in config/voice.json. Never a clone of a real person.
    api_key = keychain("jarvis.cartesia")
    if not api_key:
        raise SystemExit("Keychain item jarvis.cartesia is missing: security add-generic-password -s jarvis.cartesia -a jarvis -w '<key>'")
    tts = CartesiaTTSService(api_key=api_key, voice_id=cfg["cartesia"]["voice_id"], model=cfg["cartesia"].get("model", "sonic-3"))
    # shortcut: offline fallback (router → Kokoro/Piper services) is selected per clause by EngineRouter but only Cartesia is wired; add the fallback services once this runs.

    transport = LocalAudioTransport(LocalAudioTransportParams(
        audio_in_enabled=True, audio_out_enabled=True,
        vad_analyzer=SileroVADAnalyzer(),
        turn_analyzer=LocalSmartTurnAnalyzerV3(),
    ))
    stt = WhisperSTTServiceMLX(model=MLXModel.LARGE_V3_TURBO)
    pipeline = Pipeline([transport.input(), stt, JarvisProcessor(), tts, transport.output()])
    task = PipelineTask(pipeline, params=PipelineParams(allow_interruptions=True))

    def relay_unprompted():
        for text in session.events():
            asyncio.run_coroutine_threadsafe(task.queue_frames([TextFrame(text)]), asyncio.get_event_loop())

    threading.Thread(target=relay_unprompted, daemon=True).start()
    return PipelineRunner(), task


BARGE_IN_ASSUMED_MS = 301  # Pipecat's VAD already waited for real speech before it sent InterruptionFrame


def main() -> None:
    if os.environ.get("ANTHROPIC_API_KEY") and os.environ.get("JARVIS_ALLOW_API_KEY") != "1":
        raise SystemExit("ANTHROPIC_API_KEY is set. AI City runs on the Claude subscription; unset it.")
    runner, task = build_pipeline()
    asyncio.run(runner.run(task))


if __name__ == "__main__":
    main()
