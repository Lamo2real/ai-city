"""VoiceIO and its Pipecat transport. No device opens: the engine runs in AVAudioEngine's
offline mode, where playback renders to a buffer. The tap gets no samples that way, so it is fed
buffers directly. Voice processing can't run offline; `python -m jarvis_voice.echo_check` is its check."""
import asyncio
import threading
import time
from unittest.mock import Mock

import numpy as np
import pytest

AV = pytest.importorskip("AVFoundation")
pytest.importorskip("pipecat")

from pipecat.frames.frames import EndFrame, InputAudioRawFrame, TTSAudioRawFrame  # noqa: E402
from pipecat.pipeline.pipeline import Pipeline  # noqa: E402
from pipecat.pipeline.runner import PipelineRunner  # noqa: E402
from pipecat.pipeline.task import PipelineTask  # noqa: E402
from pipecat.processors.frame_processor import FrameProcessor  # noqa: E402

from jarvis_voice import voice_io  # noqa: E402
from jarvis_voice.voice_io import MAX_QUEUED, MIC_CHUNK, MIC_RATE, VoiceIO, VoiceProcessingTransport, mic_pcm, speaker_buffer  # noqa: E402


def tap_buffer(channels: list[np.ndarray], rate: float = 48000.0):
    fmt = AV.AVAudioFormat.alloc().initWithCommonFormat_sampleRate_channels_interleaved_(AV.AVAudioPCMFormatFloat32, rate, len(channels), False)
    buffer = AV.AVAudioPCMBuffer.alloc().initWithPCMFormat_frameCapacity_(fmt, len(channels[0]))
    buffer.setFrameLength_(len(channels[0]))
    for i, samples in enumerate(channels):
        np.frombuffer(buffer.floatChannelData()[i].as_buffer(len(samples)), dtype=np.float32)[:] = samples
    return buffer


class OfflineIO(VoiceIO):
    """The real VoiceIO on an engine that touches no device."""

    def __init__(self):
        super().__init__(voice_processing=False, log=lambda _: None)

    def _new_engine(self):
        engine = AV.AVAudioEngine.new()
        ok, err = engine.enableManualRenderingMode_format_maximumFrameCount_error_(AV.AVAudioEngineManualRenderingModeOffline, self.format, 4096, None)
        assert ok, err
        return engine

    def render(self, frames: int) -> np.ndarray:
        out = AV.AVAudioPCMBuffer.alloc().initWithPCMFormat_frameCapacity_(self._engine.manualRenderingFormat(), frames)
        status, err = self._engine.renderOffline_toBuffer_error_(frames, out, None)
        assert status == AV.AVAudioEngineManualRenderingStatusSuccess, err
        return np.frombuffer(out.floatChannelData()[0].as_buffer(int(out.frameLength())), dtype=np.float32).copy()


def test_mic_pcm_takes_the_first_channel_and_resamples():
    import soxr

    tone = 0.5 * np.sin(2 * np.pi * 440 * np.arange(48000) / 48000).astype(np.float32)
    pcm = mic_pcm(tap_buffer([tone, np.ones(48000, dtype=np.float32)]), soxr.ResampleStream(48000.0, MIC_RATE, 1, dtype="int16"))
    got = np.frombuffer(pcm, dtype=np.int16) / 32767
    assert abs(len(got) - MIC_RATE) < 400  # the stream holds a little back
    assert abs(np.sqrt(np.mean(got[1000:] ** 2)) - 0.5 / np.sqrt(2)) < 0.01  # the tone, not channel 1's 1.0


def test_mic_pcm_clips_instead_of_wrapping():
    import soxr

    pcm = mic_pcm(tap_buffer([np.full(4800, 2.0, dtype=np.float32)], 16000.0), soxr.ResampleStream(16000.0, MIC_RATE, 1, dtype="int16"))
    assert np.frombuffer(pcm, dtype=np.int16)[100:].min() > 30000


def test_speaker_buffer_round_trips_pcm():
    pcm = np.array([0, 16384, -16384, 32767], dtype=np.int16).tobytes()
    io = OfflineIO()
    buffer = speaker_buffer(pcm, io.format)
    assert np.frombuffer(buffer.floatChannelData()[0].as_buffer(4), dtype=np.float32).tolist() == pytest.approx([0, 0.5, -0.5, 32767 / 32768])


def test_tap_cuts_the_mic_into_20_ms_chunks_and_survives_a_bad_buffer():
    import soxr

    errors = []
    io = VoiceIO(log=errors.append)
    chunks = []
    io.on_mic = chunks.append
    resampler = soxr.ResampleStream(16000.0, MIC_RATE, 1, dtype="int16")
    for _ in range(5):
        io._on_tap(tap_buffer([np.zeros(1024, dtype=np.float32)], 16000.0), resampler)
    assert chunks and {len(c) for c in chunks} == {MIC_CHUNK}
    io._on_tap(None, resampler)
    assert errors


def test_played_audio_comes_out_of_the_engine():
    io = OfflineIO()
    io.start()
    try:
        tone = (0.5 * np.sin(2 * np.pi * 440 * np.arange(2400) / 24000) * 32767).astype(np.int16)
        assert io.play(tone.tobytes())
        out = io.render(2400)
        assert abs(np.sqrt(np.mean(out**2)) - 0.5 / np.sqrt(2)) < 0.01
    finally:
        io.stop()


def test_play_blocks_until_a_buffer_finishes_and_gives_up_on_a_dead_engine(monkeypatch):
    monkeypatch.setattr(voice_io, "STALL_S", 0.2)
    io = OfflineIO()
    io.start()
    try:
        silence = bytes(960)
        for _ in range(MAX_QUEUED):
            assert io.play(silence)
        started = time.monotonic()
        assert io.play(silence) is False  # nothing rendered, so nothing finished
        assert time.monotonic() - started >= 0.2
        io.render(480 * MAX_QUEUED)
        deadline = time.monotonic() + 2
        while not io.play(silence):
            assert time.monotonic() < deadline
    finally:
        io.stop()
    assert io.play(bytes(960)) is False  # stopped: dropped, not an exception


def test_a_device_change_notification_reaches_the_restart(monkeypatch):
    monkeypatch.setattr(voice_io, "RESTART_DELAY_S", 0)
    io = OfflineIO()
    io.start()
    restarted = threading.Event()
    monkeypatch.setattr(io, "_restart", restarted.set)
    try:
        AV.NSNotificationCenter.defaultCenter().postNotificationName_object_(AV.AVAudioEngineConfigurationChangeNotification, io._engine)
        assert restarted.wait(2)
    finally:
        io.stop()


def test_a_failed_engine_says_how_to_go_back_to_headphones(monkeypatch):
    engine = Mock()
    engine.inputNode.return_value.setVoiceProcessingEnabled_error_.return_value = (False, "no")
    io = VoiceIO(log=lambda _: None)
    monkeypatch.setattr(io, "_new_engine", lambda: engine)
    with pytest.raises(RuntimeError, match="echo_cancellation"):
        io.start()


def test_no_input_device_is_an_error_not_a_crash(monkeypatch):
    engine = Mock()
    engine.inputNode.return_value.outputFormatForBus_.return_value.sampleRate.return_value = 0.0
    io = VoiceIO(voice_processing=False, log=lambda _: None)
    monkeypatch.setattr(io, "_new_engine", lambda: engine)
    with pytest.raises(RuntimeError, match="no audio input device"):
        io.start()


@pytest.mark.parametrize(("running_flag", "engine_running", "reopens"), [(True, False, True), (True, True, False), (False, False, False)])
def test_restart_only_when_the_engine_really_stopped(running_flag, engine_running, reopens):
    io = VoiceIO(log=lambda _: None)
    io._running = running_flag
    io._engine = Mock(isRunning=Mock(return_value=engine_running))
    io._close = Mock()
    io._open = Mock()
    io._restart()
    assert io._open.called is reopens


def test_a_failed_restart_is_logged_and_stops_retrying():
    lines = []
    io = VoiceIO(log=lines.append)
    io._running = True
    io._engine = Mock(isRunning=Mock(return_value=False))
    io._close = Mock()
    io._open = Mock(side_effect=RuntimeError("gone"))
    io._restart()
    assert "gone" in lines[-1]
    assert io._running is False


class FakeIO:
    def __init__(self):
        self.on_mic = None
        self.played = bytearray()
        self.started = self.stopped = 0

    def start(self):
        self.started += 1

    def stop(self):
        self.stopped += 1

    def play(self, pcm):
        self.played += pcm
        return True


class Collect(FrameProcessor):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.mic = []

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            self.mic.append(frame)
        await self.push_frame(frame, direction)


def test_transport_carries_mic_and_speaker_through_a_real_pipeline():
    async def run():
        io = FakeIO()
        transport = VoiceProcessingTransport(io)
        collect = Collect()
        task = PipelineTask(Pipeline([transport.input(), collect, transport.output()]), idle_timeout_secs=None, enable_rtvi=False)

        async def drive():
            while io.on_mic is None:
                await asyncio.sleep(0.01)
            await asyncio.to_thread(io.on_mic, b"\x01\x00" * (MIC_CHUNK // 2))
            await task.queue_frames([TTSAudioRawFrame(audio=b"\x02\x00" * 2400, sample_rate=24000, num_channels=1)])
            await asyncio.sleep(0.5)
            await task.queue_frame(EndFrame())

        await asyncio.gather(PipelineRunner(handle_sigint=False).run(task), drive())
        return io, collect

    io, collect = asyncio.run(asyncio.wait_for(run(), 20))
    assert io.started == io.stopped == 1
    assert collect.mic and collect.mic[0].sample_rate == MIC_RATE and collect.mic[0].num_channels == 1
    assert len(io.played) >= 2400 * 2


def test_a_mic_that_will_not_open_ends_the_run_and_says_why():
    from loguru import logger

    class Refuses(FakeIO):
        def start(self):
            raise RuntimeError("voice processing would not turn on")

    async def run():
        transport = VoiceProcessingTransport(Refuses())
        task = PipelineTask(Pipeline([transport.input(), transport.output()]), idle_timeout_secs=None, enable_rtvi=False)
        await PipelineRunner(handle_sigint=False).run(task)

    lines = []
    sink = logger.add(lines.append, level="ERROR")
    try:
        asyncio.run(asyncio.wait_for(run(), 20))  # a run that went on deaf would time out here
    finally:
        logger.remove(sink)
    assert any("would not turn on" in line for line in lines)


def test_real_transport_picks_voice_processing_unless_told_not_to(monkeypatch):
    from jarvis_voice.graph import real_transport

    assert isinstance(real_transport(True), VoiceProcessingTransport)
    pyaudio_transport = pytest.importorskip("pipecat.transports.local.audio").LocalAudioTransport
    monkeypatch.setattr(pyaudio_transport, "__init__", lambda self, params: None)  # PyAudio() would scan devices
    assert isinstance(real_transport(False), pyaudio_transport)
