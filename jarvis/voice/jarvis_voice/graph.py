"""The Pipecat graph: mic → Silero VAD → MLX Whisper → smart-turn → the shared Jarvis
session → clause aggregator → Cartesia Sonic, or Kokoro/Piper when offline → speaker."""
from __future__ import annotations

import asyncio
import http.client
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

from loguru import logger
from pipecat.audio.turn.smart_turn.base_smart_turn import SmartTurnParams
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    DataFrame,
    ErrorFrame,
    InterruptionFrame,
    ManuallySwitchServiceFrame,
    StartFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
    TTSTextFrame,
    TTSUpdateSettingsFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.service_switcher import ServiceSwitcher, ServiceSwitcherStrategyManual
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.kokoro.tts import KokoroTTSService
from pipecat.services.piper.tts import PiperTTSService
from pipecat.services.whisper.stt import MLXModel, WhisperSTTServiceMLX
from pipecat.transcriptions.language import Language
from pipecat.turns.user_start import VADUserTurnStartStrategy
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_processor import UserTurnProcessor
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from .fallback import EngineRouter
from .pipeline import JarvisTurnProcessor, summarize_with_haiku
from .session import JarvisSession
from .timing import TimingLog

BARGE_IN_START_S = 0.3  # the skill's "owner speech > 300 ms"
TURN_CEILING_S = 2.5  # smart-turn says "incomplete" → keep listening, up to this much silence
CARTESIA_RETRY_S = 30  # after an error (bad key, lost connection), the offline voices speak for this long
CARTESIA_LANGUAGE = {"en": Language.EN, "sv": Language.SV}


@dataclass
class _TurnEnded(DataFrame):
    """Queues behind the transcripts: UserStoppedSpeakingFrame is a system frame and overtakes them."""


class JarvisProcessor(FrameProcessor):
    """Collects the owner's words until smart-turn ends his turn, then streams Jarvis's reply to TTS."""

    def __init__(self, turns: JarvisTurnProcessor, router: EngineRouter, services: dict[str, FrameProcessor], log: Callable[[str], None] = print, **kwargs):
        super().__init__(**kwargs)
        self.turns = turns
        self.router = router
        self.services = services
        self.log = log
        self.active = next(iter(services.values()))
        self.cartesia_language = "en"
        self.words: list[str] = []
        self.speech_start = self.speech_end = self.stt_final = 0.0
        self.ended_without_text = False
        self.reply: asyncio.Task | None = None
        self.bot_speaking = False
        self.cut_at: float | None = None  # when a barge-in told playback to stop
        self.cartesia_down_until = 0.0
        network = router.probe  # reachable is not the same as working
        router.probe = lambda: network() and time.monotonic() >= self.cartesia_down_until

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, StartFrame):
            await self.push_frame(frame, direction)
            threading.Thread(target=self._relay_unprompted, args=(asyncio.get_running_loop(),), daemon=True).start()
        elif isinstance(frame, TranscriptionFrame):
            self.words.append(frame.text.strip())
            self.stt_final = time.monotonic()
            if self.ended_without_text:  # Whisper finished after the turn's safety net ran out
                await self._start_reply()
        elif isinstance(frame, UserStoppedSpeakingFrame):
            await self.push_frame(frame, direction)
            await self.queue_frame(_TurnEnded())
        elif isinstance(frame, _TurnEnded):
            await self._start_reply()
        elif isinstance(frame, InterruptionFrame):
            await self._interrupt()
            await self.push_frame(frame, direction)
        elif isinstance(frame, BotStartedSpeakingFrame):
            if direction == FrameDirection.UPSTREAM:
                self.bot_speaking = True
                self.turns.on_bot_started()
            await self.push_frame(frame, direction)
        elif isinstance(frame, BotStoppedSpeakingFrame):
            if direction == FrameDirection.UPSTREAM:
                self.bot_speaking = False
                self.turns.on_bot_stopped()
                self._bot_stopped()
            await self.push_frame(frame, direction)
        else:
            if isinstance(frame, ErrorFrame) and frame.processor is self.services.get("cartesia"):
                self.cartesia_down_until = time.monotonic() + CARTESIA_RETRY_S
                self.log(f"tts: cartesia failed, offline voices for {CARTESIA_RETRY_S} s: {frame.error}")
            elif isinstance(frame, UserStartedSpeakingFrame):
                self.ended_without_text = False
            elif isinstance(frame, VADUserStartedSpeakingFrame):
                self.speech_start = time.monotonic() - frame.start_secs
            elif isinstance(frame, VADUserStoppedSpeakingFrame):
                self.speech_end = time.monotonic() - frame.stop_secs
            await self.push_frame(frame, direction)

    async def _start_reply(self) -> None:
        text = " ".join(w for w in self.words if w).strip()
        self.ended_without_text = not text
        if not text:
            return
        self.words = []
        self.log(f"owner: {text}")
        self.turns.start_turn(self.speech_end, self.stt_final)
        self.reply = self.create_task(self._reply(text), "jarvis-reply")

    async def _reply(self, text: str) -> None:
        loop = asyncio.get_running_loop()
        pieces: asyncio.Queue[str | None] = asyncio.Queue()

        def worker():  # the session is blocking HTTP; pieces reach the graph as they are ready
            try:
                for piece in self.turns.owner_said(text):
                    loop.call_soon_threadsafe(pieces.put_nowait, piece)
            except Exception as err:
                logger.exception(err)
            finally:
                loop.call_soon_threadsafe(pieces.put_nowait, None)

        loop.run_in_executor(None, worker)
        while (piece := await pieces.get()) is not None:
            await self.say(piece)

    async def say(self, piece: str) -> None:
        """One clause to the engine the router picks: Cartesia, or Kokoro/Piper when offline."""
        engine, language = self.router.route(piece)
        service = self.services[engine]
        if service is not self.active:
            await self.push_frame(ManuallySwitchServiceFrame(service=service))
            self.active = service
        if engine == "cartesia" and language != self.cartesia_language:
            await self.push_frame(TTSUpdateSettingsFrame(delta=CartesiaTTSService.Settings(language=CARTESIA_LANGUAGE[language]), service=service))
            self.cartesia_language = language
        self.turns.on_queued(piece)
        self.log(f"jarvis [{engine}]: {piece}")
        await self.push_frame(TTSSpeakFrame(piece, append_to_context=False))

    async def _interrupt(self) -> None:
        running = self.reply is not None and not self.reply.done()
        if not running and not self.bot_speaking:
            return
        self.cut_at = time.monotonic()
        earlier = self.turns.interrupted()
        if earlier:
            self.words.insert(0, earlier)
        if running:
            await self.cancel_task(self.reply)
        if not self.bot_speaking:
            self.cut_at = None
            self.turns.finish_turn()

    def _bot_stopped(self) -> None:
        if self.cut_at is not None:
            now = time.monotonic()
            stop = {"stop_ms": round((now - self.cut_at) * 1000), "stop_from_onset_ms": round((now - self.speech_start) * 1000)}
            self.cut_at = None
            self.log(f"barge-in: playback stopped {stop}")
            if self.turns.timer:
                self.turns.timer.extra.update(stop)
            self.turns.finish_turn()

    async def cleanup(self):
        await super().cleanup()
        self.turns.finish_turn()  # the last turn's line

    def _relay_unprompted(self, loop: asyncio.AbstractEventLoop) -> None:
        """What Jarvis says on his own (questions, results). Reconnects if the server restarts."""
        while True:
            try:
                for text in self.turns.session.events():
                    asyncio.run_coroutine_threadsafe(self.say(text), loop)
            except (OSError, ValueError, http.client.HTTPException) as err:
                self.log(f"event stream: {type(err).__name__}: {err}, retrying")
            time.sleep(2)


class FirstAudioTap(FrameProcessor):
    """Before the output: when the first TTS audio arrives."""

    def __init__(self, turns: JarvisTurnProcessor, **kwargs):
        super().__init__(**kwargs)
        self.turns = turns

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSAudioRawFrame):
            self.turns.mark("tts_first_byte")
        await self.push_frame(frame, direction)


class PlayedWordsTap(FrameProcessor):
    """After the output: the transport releases each timed word as its audio plays."""

    def __init__(self, turns: JarvisTurnProcessor, **kwargs):
        super().__init__(**kwargs)
        self.turns = turns

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSTextFrame) and frame.pts:  # Kokoro and Piper have no timed words
            self.turns.on_tts_word(frame.text)
        await self.push_frame(frame, direction)


def build_tts(cfg: dict, cartesia_key: str | None, cartesia_url: str | None = None) -> dict[str, FrameProcessor]:
    """All engines load at start, so a network pulled later finds the offline voices ready.
    The first run downloads Kokoro and Piper, so it needs the network."""
    services: dict[str, FrameProcessor] = {}
    if cartesia_key:
        # Cartesia Sonic, one stock British voice fixed in config/voice.json. Never a clone of a real person.
        extra = {"url": cartesia_url} if cartesia_url else {}
        services["cartesia"] = CartesiaTTSService(api_key=cartesia_key, settings=CartesiaTTSService.Settings(voice=cfg["cartesia"]["voice_id"], model=cfg["cartesia"].get("model", "sonic-3")), **extra)
    offline = cfg["offline"]
    services["kokoro"] = KokoroTTSService(settings=KokoroTTSService.Settings(voice=offline["en"]["voice"], language=Language.EN_GB))
    services["piper"] = PiperTTSService(settings=PiperTTSService.Settings(voice=offline["sv"]["voice"]))
    return services


def warm_whisper(model: str = MLXModel.LARGE_V3_TURBO) -> None:
    """Pipecat loads the model on the first words; load it now, so the first turn isn't the slow one."""
    import mlx_whisper
    import numpy as np

    mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32), path_or_hf_repo=model)


def real_transport(echo_cancellation: bool = True):
    if echo_cancellation:
        from .voice_io import VoiceProcessingTransport

        return VoiceProcessingTransport()
    from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioTransportParams

    return LocalAudioTransport(LocalAudioTransportParams(audio_in_enabled=True, audio_out_enabled=True))


def build_pipeline(cfg: dict, *, transport, services: dict[str, FrameProcessor], probe: Callable[[], bool], log: Callable[[str], None] = print, stt=None, summarize: Callable[[str], str] = summarize_with_haiku):
    timing = TimingLog(os.path.expanduser(cfg.get("timing_log", "~/Library/Logs/jarvis-voice-timings.jsonl")), log)
    session = JarvisSession(cfg.get("server", "http://127.0.0.1:7777"), cfg.get("session_id", "owner"))
    turns = JarvisTurnProcessor(session, timing, log, summarize, online=probe)
    router = EngineRouter(probe=probe, log=log)
    jarvis = JarvisProcessor(turns, router, services, log)
    # language=None: Whisper detects it, so the owner can speak Swedish.
    if stt is None:
        warm_whisper()
    stt = stt or WhisperSTTServiceMLX(settings=WhisperSTTServiceMLX.Settings(model=MLXModel.LARGE_V3_TURBO, language=None), ttfs_p99_latency=2.0)
    turn_taking = UserTurnProcessor(user_turn_strategies=UserTurnStrategies(
        start=[VADUserTurnStartStrategy()],
        stop=[TurnAnalyzerUserTurnStopStrategy(turn_analyzer=LocalSmartTurnAnalyzerV3(params=SmartTurnParams(stop_secs=TURN_CEILING_S)))],
    ))
    pipeline = Pipeline([
        transport.input(),
        VADProcessor(vad_analyzer=SileroVADAnalyzer(params=VADParams(start_secs=BARGE_IN_START_S))),
        stt,
        turn_taking,
        jarvis,
        ServiceSwitcher(services=list(services.values()), strategy_type=ServiceSwitcherStrategyManual),
        FirstAudioTap(turns),
        transport.output(),
        PlayedWordsTap(turns),
    ])
    # idle_timeout_secs=None: a quiet room must not end the pipeline.
    task = PipelineTask(pipeline, params=PipelineParams(audio_in_sample_rate=16000), idle_timeout_secs=None)
    return PipelineRunner(handle_sigint=True), task
