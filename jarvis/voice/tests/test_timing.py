import json

import pytest

from jarvis_voice.timing import TimingLog, TurnTimer, p50


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


def test_marks_are_measured_from_the_end_of_owner_speech(tmp_path):
    clock = Clock()
    log = TimingLog(str(tmp_path / "timings.jsonl"), log=lambda _: None)
    timer = log.start(clock)
    timer.mark("turn_end")
    clock.t += 0.12
    timer.mark("stt_final")
    clock.t += 0.2
    timer.mark("llm_first_token")
    clock.t += 0.15
    timer.mark("tts_first_byte")
    clock.t += 0.1
    timer.mark("playback_start")
    timer.mark("playback_start")  # a repeat never moves the first
    line = json.loads(log.finish(timer))
    assert line == {"turn": 1, "stt_final": 120, "llm_first_token": 320, "tts_first_byte": 470, "playback_start": 570, "within_target": True}
    assert (tmp_path / "timings.jsonl").read_text().strip() == json.dumps(line)


def test_slow_turns_are_marked_and_unknown_marks_refused():
    clock = Clock()
    timer = TurnTimer(2, clock)
    timer.mark("turn_end")
    clock.t += 1.2
    timer.mark("playback_start")
    assert json.loads(timer.line())["within_target"] is False
    assert timer.ms("stt_final") is None
    with pytest.raises(ValueError):
        timer.mark("coffee")


def test_p50_over_logged_turns():
    lines = [json.dumps({"turn": i, "playback_start": v}) for i, v in enumerate([900, 400, 650])] + [json.dumps({"turn": 9})]
    assert p50(lines) == 650
    assert p50([]) is None
