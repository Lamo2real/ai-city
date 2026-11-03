from jarvis_voice.aggregator import ClauseAggregator


def stream(text, chunk=3):
    agg = ClauseAggregator()
    out = []
    for i in range(0, len(text), chunk):
        out += agg.push(text[i:i + chunk])
    return agg, out


def test_first_clause_flushes_at_a_comma():
    agg, out = stream("Math it is, sir. Nine plus nine is eighteen. ")
    assert out[0] == "Math it is,"
    assert out[1:] == ["sir.", "Nine plus nine is eighteen."]
    assert agg.flush() == []


def test_first_clause_flushes_at_a_dash():
    _, out = stream("Ah, the calendar — you have lunch at noon. ")
    assert out[0] == "Ah,"
    agg2, out2 = stream("Right then — the report is on its way. ")
    assert out2[0] == "Right then —"
    assert out2[1] == "the report is on its way."


def test_first_clause_flushes_at_six_words_without_punctuation():
    agg, out = stream("one two three four five six seven eight")
    assert out == ["one two three four five six"]
    assert agg.flush() == ["seven eight"]


def test_a_short_sentence_is_the_first_clause():
    agg, out = stream("Eighteen. Anything else?")
    assert out == ["Eighteen."]
    assert agg.flush() == ["Anything else?"]


def test_after_the_first_clause_only_whole_sentences_go_out():
    agg = ClauseAggregator()
    out = agg.push("On it, sir. I am assembling a team, with two")
    assert out == ["On it,", "sir."]
    assert agg.push(" workers and a manager. Done") == ["I am assembling a team, with two workers and a manager."]
    assert agg.flush() == ["Done"]
    assert agg.push("x") == [] and agg.flush() == ["x"]


def test_reset_starts_a_new_reply():
    agg = ClauseAggregator()
    agg.push("Well, hello there")
    agg.reset()
    assert agg.push("Yes, sir") == ["Yes,"]
