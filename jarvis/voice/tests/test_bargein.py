from jarvis_voice.bargein import interruption_note, is_backchannel, should_interrupt, truncate_spoken


def test_backchannels_do_not_interrupt():
    for text in ["mm", "Mhm.", "yeah", "okay", "uh-huh", "ja", "mm yeah"]:
        assert is_backchannel(text), text
        assert not should_interrupt(900, text)
    for text in ["okay stop", "wait", "no, the other one", "yeah but what about Friday"]:
        assert not is_backchannel(text), text


def test_only_speech_over_300ms_interrupts():
    assert not should_interrupt(250, "wait")
    assert should_interrupt(301, "wait")
    assert should_interrupt(2000, "")


def test_memory_is_cut_to_the_words_actually_played():
    words = [("The", 0.0), ("report", 0.2), ("is", 0.4), ("ready", 0.5), ("sir", 0.8), ("and", 1.0), ("the", 1.1), ("team", 1.2)]
    assert truncate_spoken("The report is ready sir and the team", words, played_s=0.9) == "The report is ready sir [interrupted]"
    assert truncate_spoken("The report", words, played_s=0.0) == "The [interrupted]"
    assert truncate_spoken("x", [], played_s=5.0) == "[interrupted]"
    assert truncate_spoken("x", None, played_s=5.0) == "[interrupted]"
    assert truncate_spoken("x", [("Later", 3.0)], played_s=1.0) == "[interrupted]"


def test_the_next_turn_tells_jarvis_what_was_heard():
    note = interruption_note("The report is ready sir [interrupted]", "what were you saying?")
    assert note.startswith('[You were interrupted. The owner stopped you while you were saying: "The report is ready sir [interrupted]"')
    assert note.endswith("\nwhat were you saying?")
