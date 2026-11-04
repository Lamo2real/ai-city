"""Mic and speaker through one AVAudioEngine with macOS voice processing on, so Jarvis does
not hear himself. Both directions share the engine: the canceller subtracts what this engine
plays, and voice processing ducks playback from anywhere else, such as PyAudio."""
from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

import AVFoundation as AV
import numpy as np
import soxr
from pipecat.frames.frames import InputAudioRawFrame, OutputAudioRawFrame, StartFrame
from pipecat.transports.base_input import BaseInputTransport
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import BaseTransport, TransportParams

MIC_RATE = 16000
SPEAKER_RATE = 24000
MIC_CHUNK = MIC_RATE // 50 * 2  # 20 ms of 16-bit mono, what the PyAudio path delivered
TAP_FRAMES = 1024
MAX_QUEUED = 3  # at Pipecat's 40 ms chunks, the most a barge-in still plays out is 120 ms
STALL_S = 1.0  # no buffer finished in this long: the engine is down, drop the audio
RESTART_DELAY_S = 0.5
MIC_DENIED = (AV.AVAuthorizationStatusDenied, AV.AVAuthorizationStatusRestricted)


def mic_pcm(buffer, resampler) -> bytes:
    """Channel 0 of a tap buffer, as 16-bit PCM at the resampler's rate. Voice processing can
    report several channels; the processed voice is the first."""
    samples = np.frombuffer(buffer.floatChannelData()[0].as_buffer(int(buffer.frameLength())), dtype=np.float32)
    return resampler.resample_chunk((np.clip(samples, -1, 1) * 32767).astype(np.int16)).tobytes()


def speaker_buffer(pcm: bytes, fmt):
    ints = np.frombuffer(pcm, dtype=np.int16)
    buffer = AV.AVAudioPCMBuffer.alloc().initWithPCMFormat_frameCapacity_(fmt, len(ints))
    buffer.setFrameLength_(len(ints))
    np.frombuffer(buffer.floatChannelData()[0].as_buffer(len(ints)), dtype=np.float32)[:] = ints / 32768
    return buffer


class VoiceIO:
    def __init__(self, voice_processing: bool = True, log: Callable[[str], None] = print):
        self.voice_processing = voice_processing
        self.log = log
        self.on_mic: Callable[[bytes], None] | None = None  # 20 ms chunks of 16 kHz PCM
        self.format = AV.AVAudioFormat.alloc().initWithCommonFormat_sampleRate_channels_interleaved_(AV.AVAudioPCMFormatFloat32, float(SPEAKER_RATE), 1, False)
        self._lock = threading.Lock()
        self._running = False
        self._engine = self._player = self._observer = None
        self._room = threading.Semaphore(MAX_QUEUED)
        self._tail = b""

    def start(self) -> None:
        status = AV.AVCaptureDevice.authorizationStatusForMediaType_(AV.AVMediaTypeAudio)
        if status in MIC_DENIED:  # the engine would run and deliver silence
            self.log("mic: access denied, Jarvis hears nothing. Allow your terminal app in System Settings → Privacy & Security → Microphone and restart it.")
        with self._lock:
            self._running = True
            self._open()

    def stop(self) -> None:
        with self._lock:
            self._running = False
            self._close()

    def play(self, pcm: bytes) -> bool:
        """Blocks while MAX_QUEUED buffers wait, so the caller is paced like a blocking write."""
        room = self._room
        if not room.acquire(timeout=STALL_S):
            self.log("speaker: stalled, dropping audio")
            return False
        with self._lock:
            if self._player is None:
                return False
            self._player.scheduleBuffer_completionHandler_(speaker_buffer(pcm, self.format), lambda: room.release())
        return True

    def _new_engine(self):
        return AV.AVAudioEngine.new()

    def _open(self) -> None:
        engine = self._new_engine()
        mic = engine.inputNode()
        if self.voice_processing:
            ok, err = mic.setVoiceProcessingEnabled_error_(True, None)
            if not ok:
                raise RuntimeError(f"voice processing would not turn on: {err}. To use headphones instead, set echo_cancellation to false in config/voice.json.")
        mic_format = mic.outputFormatForBus_(0)  # read after enabling: voice processing changes it
        if mic_format.sampleRate() <= 0:
            raise RuntimeError("no audio input device")
        resampler = soxr.ResampleStream(mic_format.sampleRate(), MIC_RATE, 1, dtype="int16")
        mic.installTapOnBus_bufferSize_format_block_(0, TAP_FRAMES, mic_format, lambda buffer, _when: self._on_tap(buffer, resampler))
        player = AV.AVAudioPlayerNode.new()
        engine.attachNode_(player)
        engine.connect_to_format_(player, engine.mainMixerNode(), self.format)
        self._observer = AV.NSNotificationCenter.defaultCenter().addObserverForName_object_queue_usingBlock_(AV.AVAudioEngineConfigurationChangeNotification, engine, None, self._on_config_change)
        self._engine, self._player = engine, player
        self._room = threading.Semaphore(MAX_QUEUED)
        ok, err = engine.startAndReturnError_(None)
        if not ok:
            raise RuntimeError(f"audio engine would not start: {err}")
        player.play()
        self.log(f"audio: voice processing {'on' if mic.isVoiceProcessingEnabled() else 'OFF, use headphones'}, mic {mic_format.sampleRate():.0f} Hz, {mic_format.channelCount()} ch")

    def _close(self) -> None:
        if self._engine is None:
            return
        AV.NSNotificationCenter.defaultCenter().removeObserver_(self._observer)
        self._engine.stop()
        self._engine.inputNode().removeTapOnBus_(0)
        self._engine = self._player = self._observer = None

    def _on_tap(self, buffer, resampler) -> None:
        try:  # an exception crossing back into the audio framework would take the process down
            self._tail += mic_pcm(buffer, resampler)
            while len(self._tail) >= MIC_CHUNK:
                chunk, self._tail = self._tail[:MIC_CHUNK], self._tail[MIC_CHUNK:]
                if self.on_mic:
                    self.on_mic(chunk)
        except Exception as err:
            self.log(f"mic: {type(err).__name__}: {err}")

    def _on_config_change(self, _note) -> None:
        """The device changed (headphones, AirPods) and the engine stopped itself. Apple forbids
        tearing it down from inside this handler, so a timer does it."""
        threading.Timer(RESTART_DELAY_S, self._restart).start()

    def _restart(self) -> None:
        with self._lock:
            if not self._running or self._engine.isRunning():  # starting can post this too; that must not loop
                return
            self.log("audio: device changed, restarting")
            self._close()
            try:
                self._open()
            except Exception as err:
                self.log(f"audio: restart failed, Jarvis can't hear or speak: {err}")
                self._running = False


class VoiceProcessingInput(BaseInputTransport):
    def __init__(self, io: VoiceIO, params: TransportParams, **kwargs):
        super().__init__(params, **kwargs)
        self._io = io

    async def setup(self, setup):
        await super().setup(setup)
        self._io.start()  # Pipecat logs a failure here and ends the run, so he is never left deaf

    async def start(self, frame: StartFrame):
        await super().start(frame)
        loop = self.get_event_loop()

        def on_mic(pcm: bytes) -> None:
            asyncio.run_coroutine_threadsafe(self.push_audio_frame(InputAudioRawFrame(audio=pcm, sample_rate=MIC_RATE, num_channels=1)), loop)

        self._io.on_mic = on_mic
        await self.set_transport_ready(frame)

    async def cleanup(self):
        await super().cleanup()
        self._io.on_mic = None
        self._io.stop()


class VoiceProcessingOutput(BaseOutputTransport):
    def __init__(self, io: VoiceIO, params: TransportParams, **kwargs):
        super().__init__(params, **kwargs)
        self._io = io
        self._executor = ThreadPoolExecutor(max_workers=1)  # one writer keeps the buffers in order

    async def start(self, frame: StartFrame):
        await super().start(frame)
        await self.set_transport_ready(frame)

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        return await self.get_event_loop().run_in_executor(self._executor, self._io.play, frame.audio)

    async def cleanup(self):
        await super().cleanup()
        self._executor.shutdown(wait=False)


class VoiceProcessingTransport(BaseTransport):
    def __init__(self, io: VoiceIO | None = None):
        super().__init__()
        io = io or VoiceIO()
        params = TransportParams(audio_in_enabled=True, audio_out_enabled=True, audio_in_sample_rate=MIC_RATE, audio_out_sample_rate=SPEAKER_RATE)
        self._input, self._output = VoiceProcessingInput(io, params), VoiceProcessingOutput(io, params)

    def input(self):
        return self._input

    def output(self):
        return self._output
