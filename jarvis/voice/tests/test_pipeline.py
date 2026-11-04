"""One owner turn through the shared session, and what he heard before a barge-in."""
import subprocess

from jarvis_voice.pipeline import NO_ANSWER, JarvisTurnProcessor, summarize_with_haiku
from jarvis_voice.session import SessionError
from jarvis_voice.timing import TimingLog


class FakeSession:
    def __init__(self, replies=("Math it is, eighteen sir.",), error=None):
        self.replies, self.error, self.sent, self.cancels = replies, error, [], 0

    def sentences(self, text):
        self.sent.append(text)
        yield from self.replies
        if self.error:
            raise self.error

    def cancel(self):
        self.cancels += 1


class Clock:
    t = 100.0

    def __call__(self):
        return self.t


def make(session=None, summarize=lambda older: "SUMMARY", path=None):
    clock, lines = Clock(), []
    timing = TimingLog(path, log=lines.append)
    return JarvisTurnProcessor(session or FakeSession(), timing, log=lines.append, summarize=summarize, clock=clock), clock, lines


def test_clauses_come_out_as_they_are_ready():
    turns, _, _ = make(FakeSession(("Math it is, eighteen sir.", "Anything else?")))
    assert list(turns.owner_said("nine plus nine")) == ["Math it is,", "eighteen sir.", "Anything else?"]


def test_a_failed_turn_is_said_out_loud():
    for error in (SessionError("no answer"), OSError("connection refused")):
        turns, _, lines = make(FakeSession((), error))
        assert list(turns.owner_said("hello")) == [NO_ANSWER["en"]]
        assert any("no answer from Jarvis" in line for line in lines)


def test_offline_the_owner_hears_it_at_once_in_his_language_and_only_once():
    turns, _, _ = make(FakeSession((), SessionError("no answer")))
    turns.online = lambda: False
    assert list(turns.owner_said("Vad är klockan, och är det kallt ute?")) == [NO_ANSWER["sv"]]
    turns.session = FakeSession(("Eighteen, sir.",))
    assert list(turns.owner_said("what is nine plus nine")) == [NO_ANSWER["en"], "Eighteen,", "sir."]


def test_timer_marks_a_whole_turn_from_the_end_of_speech(tmp_path):
    path = tmp_path / "t.jsonl"
    turns, clock, _ = make(path=str(path))
    clock.t = 100.5
    turns.start_turn(speech_end=100.0, stt_final=100.3)
    list(turns.owner_said("nine plus nine"))
    clock.t = 101.0
    turns.mark("tts_first_byte")
    turns.on_bot_started()
    turns.finish_turn()
    turns.finish_turn()  # once only
    lines = path.read_text().splitlines()
    assert len(lines) == 1 and '"stt_final": 300' in lines[0] and '"turn_decided": 500' in lines[0] and '"playback_start": 1000' in lines[0]


def test_barge_in_cuts_memory_to_the_words_played_and_tells_the_next_turn():
    session = FakeSession()
    turns, clock, _ = make(session)
    turns.on_bot_started()
    for word in ("Math", "it", "is"):
        turns.on_tts_word(word)
        clock.t += 0.3
    turns.on_tts_word("eighteen")
    assert turns.interrupted() == ""
    assert session.cancels == 1
    assert turns.heard == "Math it is eighteen [interrupted]"
    list(turns.owner_said("what were you saying?"))
    assert 'saying: "Math it is eighteen [interrupted]"' in session.sent[-1] and session.sent[-1].endswith("what were you saying?")
    list(turns.owner_said("next"))
    assert session.sent[-1] == "next"  # the note goes out once


def test_without_word_timestamps_what_was_heard_is_estimated_from_time():
    turns, clock, _ = make()
    turns.on_queued("one two three four five six seven eight nine ten")
    turns.on_bot_started()
    clock.t += 1.0  # 2.5 words a second: starts at 0, 0.4, 0.8
    turns.interrupted()
    assert turns.heard == "one two three [interrupted]"


def test_played_time_skips_the_silence_between_clauses():
    turns, clock, _ = make()
    turns.on_queued("one two three four five six seven eight nine ten")
    turns.on_bot_started()
    clock.t += 0.5
    turns.on_bot_stopped()
    clock.t += 10
    turns.on_bot_started()
    clock.t += 0.5
    turns.interrupted()
    assert turns.heard == "one two three [interrupted]"


def test_cutting_in_before_any_audio_keeps_his_words_for_the_next_turn():
    session = FakeSession()
    turns, _, _ = make(session)
    list(turns.owner_said("what's the weather"))
    assert turns.interrupted() == "what's the weather"
    assert turns.heard == ""


def test_a_cancelled_turn_says_nothing_more():
    turns, _, _ = make(FakeSession(("First one is here.", "Second one is here.")))
    pieces = turns.owner_said("hello")
    assert next(pieces) == "First one is here."
    turns.interrupted()
    assert list(pieces) == []


def test_a_long_turn_is_summarized_and_a_failed_summary_is_not_lost():
    words = " ".join(f"w{i}" for i in range(1600))
    session = FakeSession()
    turns, _, _ = make(session)
    list(turns.owner_said(words))
    assert session.sent[-1].startswith("[Summary of what the owner said first: SUMMARY]\nw1300 ")

    def broken(_):
        raise subprocess.TimeoutExpired("claude", 120)

    turns, _, lines = make(session, summarize=broken)
    list(turns.owner_said(words))
    assert "(summary failed; it began) w0 w1" in session.sent[-1] and session.sent[-1].endswith(" w1599")
    assert any("summary failed" in line for line in lines)


def test_summary_uses_haiku_with_no_tools_and_no_api_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "must-not-reach-the-child")
    seen = {}

    def run(cmd, **kwargs):
        seen.update(cmd=cmd, **kwargs)
        return subprocess.CompletedProcess(cmd, 0, stdout=" The owner described a trip. \n")

    assert summarize_with_haiku("long talk", run=run) == "The owner described a trip."
    assert seen["input"] == "long talk"
    assert seen["cmd"][seen["cmd"].index("--model") + 1] == "claude-haiku-5-5"
    assert seen["cmd"][seen["cmd"].index("--tools") + 1] == ""
    assert "ANTHROPIC_API_KEY" not in seen["env"]
    assert "data" in seen["cmd"][seen["cmd"].index("--system-prompt") + 1]  # the prompt treats speech as data
