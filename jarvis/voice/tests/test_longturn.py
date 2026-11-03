from jarvis_voice.longturn import condense, needs_summary, split


def words(n, prefix="w"):
    return " ".join(f"{prefix}{i}" for i in range(n))


def test_summary_triggers_past_1500_words_only():
    assert not needs_summary(words(1500))
    assert needs_summary(words(1501))


def test_the_latest_300_words_stay_verbatim():
    older, latest = split(words(1600), keep=300)
    assert latest.split()[0] == "w1300" and latest.split()[-1] == "w1599"
    assert older.split()[-1] == "w1299"
    assert split("short talk") == ("", "short talk")


def test_condense_summarizes_the_older_part_once_and_keeps_the_rest():
    calls = []

    def summarize(text):
        calls.append(text)
        return "The owner described the trip."

    short = condense("just a few words", summarize)
    assert short == "just a few words" and calls == []
    long = condense(words(1700), summarize)
    assert len(calls) == 1 and calls[0].split()[-1] == "w1399"
    assert long.startswith("[Summary of what the owner said first: The owner described the trip.]\nw1400 ")
    assert long.endswith(" w1699")
