"""The echo check's verdict and level, on synthetic audio. Opens no device."""
import asyncio
import math
import shutil

import numpy as np
import pytest

pytest.importorskip("AVFoundation")
pytest.importorskip("pipecat")

from jarvis_voice import echo_check, voice_io  # noqa: E402
from jarvis_voice.echo_check import level_db, speech_seconds, spoken, verdict  # noqa: E402


def test_verdict_needs_the_off_run_to_have_heard_him():
    assert verdict(0, 0)[0] is False and "INCONCLUSIVE" in verdict(0, 0)[1]
    assert verdict(5, 2)[0] is False and "FAIL" in verdict(5, 2)[1]
    assert verdict(5, 0)[0] is True


def test_level_db_of_a_known_tone():
    tone = (0.5 * np.sin(2 * np.pi * 440 * np.arange(16000) / 16000) * 32768).astype(np.int16)
    assert level_db(tone.tobytes()) == pytest.approx(20 * math.log10(0.5 / math.sqrt(2)), abs=0.1)
    assert level_db(b"") == -120.0


@pytest.mark.skipif(not shutil.which("say"), reason="needs macOS say")
def test_silero_hears_speech_and_not_silence(tmp_path):
    import soxr

    pcm24 = spoken("Good evening, sir. The city is quiet tonight.", tmp_path)
    speech = soxr.resample(np.frombuffer(pcm24, dtype=np.int16), 24000, 16000).tobytes()
    assert asyncio.run(speech_seconds(speech)) > 0.5
    assert asyncio.run(speech_seconds(bytes(32000))) == 0


@pytest.mark.skipif(not shutil.which("say"), reason="needs macOS say")
def test_main_runs_both_passes_and_keeps_the_recordings(monkeypatch, tmp_path, capsys):
    modes = []

    class SilentRoom:
        def __init__(self, voice_processing):
            modes.append(voice_processing)
            self.on_mic = None

        def start(self):
            pass

        def stop(self):
            pass

        def play(self, pcm):
            self.on_mic(bytes(640))
            return True

    monkeypatch.setattr(voice_io, "VoiceIO", SilentRoom)
    monkeypatch.setattr(echo_check, "SENTENCE", "Good evening, sir.")
    monkeypatch.setattr(echo_check.tempfile, "mkdtemp", lambda prefix: str(tmp_path))
    with pytest.raises(SystemExit) as done:
        echo_check.main()
    assert done.value.code == 1
    assert modes == [False, True]
    assert (tmp_path / "heard-off.wav").exists() and (tmp_path / "heard-on.wav").exists()
    assert "INCONCLUSIVE" in capsys.readouterr().out
