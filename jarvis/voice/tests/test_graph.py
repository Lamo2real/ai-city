"""JarvisProcessor and word tracking inside a real Pipecat pipeline, with a fake TTS that
reports word timestamps the way Cartesia does. Skipped without the `pipeline` extra."""
import asyncio
import time

import pytest

pytest.importorskip("pipecat")

from fake_audio import FakeOutput  # noqa: E402
from pipecat.frames.frames import (  # noqa: E402
    EndFrame,
    InterruptionFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline  # noqa: E402
from pipecat.pipeline.runner import PipelineRunner  # noqa: E402
from pipecat.pipeline.service_switcher import ServiceSwitcher, ServiceSwitcherStrategyManual  # noqa: E402
from pipecat.pipeline.task import PipelineTask  # noqa: E402
from pipecat.services.tts_service import WordTTSService  # noqa: E402
from pipecat.transports.base_transport import TransportParams  # noqa: E402

from jarvis_voice.fallback import EngineRouter  # noqa: E402
from jarvis_voice.graph import FirstAudioTap, JarvisProcessor, PlayedWordsTap  # noqa: E402
from jarvis_voice.pipeline import JarvisTurnProcessor  # noqa: E402
from jarvis_voice.timing import TimingLog  # noqa: E402


class BrokenTTS(WordTTSService):
    def can_generate_metrics(self):
        return False

    async def run_tts(self, text, context_id):
        self.spoken = getattr(self, "spoken", []) + [text]
        await self.push_error("Websocket not connected")
        return
        yield


class WordTTS(WordTTSService):
    """0.3 s of tone per word, each word time-stamped."""

    def __init__(self, name, **kwargs):
        super().__init__(push_text_frames=False, push_start_frame=True, push_stop_frames=True, **kwargs)
        self.engine = name
        self.spoken = []

    def can_generate_metrics(self):
        return False

    async def run_tts(self, text, context_id):
        self.spoken.append(text)
        words = text.split()
        await self.add_word_timestamps([(w, i * 0.3) for i, w in enumerate(words)], context_id)
        for _ in words:
            await asyncio.sleep(0.01)
            yield TTSAudioRawFrame(audio=b"\x10\x00" * int(self.sample_rate * 0.3), sample_rate=self.sample_rate, num_channels=1, context_id=context_id)


class FakeSession:
    def __init__(self, sentences):
        self.sentences_out, self.sent, self.cancelled = sentences, [], 0

    def sentences(self, text):
        self.sent.append(text)
        yield from self.sentences_out

    def cancel(self):
        self.cancelled += 1

    def events(self):
        time.sleep(3600)
        return iter(())


async def scenario(sentences, script, online=lambda: True, cartesia=None):
    lines = []
    session = FakeSession(sentences)
    timing = TimingLog(None, log=lines.append)
    turns = JarvisTurnProcessor(session, timing, log=lines.append)
    cartesia, kokoro, piper = cartesia or WordTTS("cartesia"), WordTTS("kokoro"), WordTTS("piper")
    services = {"cartesia": cartesia, "kokoro": kokoro, "piper": piper}
    jarvis = JarvisProcessor(turns, EngineRouter(probe=online, log=lines.append), services, log=lines.append)
    output = FakeOutput(TransportParams(audio_out_enabled=True))
    pipeline = Pipeline([jarvis, ServiceSwitcher(services=list(services.values()), strategy_type=ServiceSwitcherStrategyManual), FirstAudioTap(turns), output, PlayedWordsTap(turns)])
    task = PipelineTask(pipeline, idle_timeout_secs=None)

    async def run_script():
        await asyncio.sleep(0.3)
        await script(task)
        await task.queue_frame(EndFrame())

    await asyncio.gather(PipelineRunner(handle_sigint=False).run(task), run_script())
    return turns, session, services, lines


async def owner_says(task, text):
    await task.queue_frames([TranscriptionFrame(text, "owner", "now"), UserStoppedSpeakingFrame()])


def test_a_barge_in_cuts_memory_to_the_words_actually_played():
    async def script(task):
        await owner_says(task, "tell me a story")
        await asyncio.sleep(1.0)  # about three of the words have played
        await task.queue_frame(InterruptionFrame())
        await asyncio.sleep(0.3)

    turns, session, services, lines = asyncio.run(scenario(["one two three four five six seven eight nine ten"], script))
    played = turns.heard.removesuffix(" [interrupted]").split()
    assert 2 <= len(played) <= 6, turns.heard
    assert played == "one two three four five six".split()[: len(played)]
    assert any("barge-in: playback stopped" in line for line in lines)
    stops = [line for line in lines if "playback stopped" in line]
    assert len(stops) == 1


def test_only_the_active_engine_speaks_and_the_switch_follows_the_network():
    state = {"online": True}

    async def script(task):
        await owner_says(task, "hello")
        await asyncio.sleep(1.0)
        state["online"] = False
        await owner_says(task, "and again")
        await asyncio.sleep(1.0)

    _, _, services, lines = asyncio.run(scenario(["Good evening."], script, online=lambda: state["online"]))
    assert services["cartesia"].spoken == ["Good evening."]
    assert services["kokoro"].spoken == ["Good evening."]
    assert services["piper"].spoken == []
    assert "tts: cartesia (en, online)" in lines and "tts: kokoro (en, offline fallback)" in lines


def test_cartesia_errors_hand_over_to_the_offline_voices_though_the_network_is_up():
    async def script(task):
        await owner_says(task, "hello")
        await asyncio.sleep(0.5)
        await owner_says(task, "are you there")
        await asyncio.sleep(1.0)

    _, _, services, lines = asyncio.run(scenario(["Good evening."], script, cartesia=BrokenTTS(push_text_frames=False)))
    assert services["cartesia"].spoken == ["Good evening."]
    assert services["kokoro"].spoken == ["Good evening."]
    assert any("cartesia failed" in line for line in lines)


def test_words_collect_until_the_turn_ends():
    async def script(task):
        await task.queue_frames([TranscriptionFrame("I was thinking", "owner", "now"), TranscriptionFrame("about the weather", "owner", "now")])
        await asyncio.sleep(0.1)
        await task.queue_frame(UserStoppedSpeakingFrame())
        await asyncio.sleep(0.5)

    _, session, _, _ = asyncio.run(scenario(["Noted."], script))
    assert session.sent == ["I was thinking about the weather"]
