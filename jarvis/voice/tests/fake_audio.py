"""A transport with no devices: scripted 16 kHz PCM goes in, what would be played is
captured. Everything else in the graph is real."""
import asyncio

from pipecat.frames.frames import InputAudioRawFrame, OutputAudioRawFrame, StartFrame
from pipecat.transports.base_input import BaseInputTransport
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import BaseTransport, TransportParams

CHUNK = 320 * 2  # 20 ms at 16 kHz


class FakeInput(BaseInputTransport):
    def __init__(self, params, feed):
        super().__init__(params)
        self.feed = feed

    async def start(self, frame: StartFrame):
        await super().start(frame)
        await self.set_transport_ready(frame)
        self.create_task(self.feed(self), "fake-mic")

    async def send(self, pcm: bytes):
        """Real time, like a microphone."""
        for i in range(0, len(pcm), CHUNK):
            await self.push_audio_frame(InputAudioRawFrame(audio=pcm[i:i + CHUNK].ljust(CHUNK, b"\0"), sample_rate=16000, num_channels=1))
            await asyncio.sleep(0.02)

    async def silence(self, seconds: float):
        await self.send(b"\0" * int(seconds * 16000) * 2)


class FakeOutput(BaseOutputTransport):
    def __init__(self, params):
        super().__init__(params)
        self.played = bytearray()

    async def start(self, frame: StartFrame):
        await super().start(frame)
        await self.set_transport_ready(frame)

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        self.played += frame.audio
        await asyncio.sleep(len(frame.audio) / 2 / frame.sample_rate)  # a device blocks for as long as it plays
        return True


class FakeAudioTransport(BaseTransport):
    def __init__(self, feed):
        super().__init__()
        params = TransportParams(audio_in_enabled=True, audio_out_enabled=True)
        self._in, self._out = FakeInput(params, feed), FakeOutput(params)

    def input(self):
        return self._in

    def output(self):
        return self._out
