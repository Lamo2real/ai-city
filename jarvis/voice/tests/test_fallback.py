from jarvis_voice.fallback import EngineRouter, detect_language, select_engine


def test_language_is_guessed_from_the_words():
    assert detect_language("The report is ready, sir.") == "en"
    assert detect_language("Rapporten är klar och jag har skickat den.") == "sv"


def test_online_uses_cartesia_and_offline_falls_back_per_language():
    assert select_engine("Good evening, sir.", online=True) == ("cartesia", "en")
    assert select_engine("God kväll, det är klart.", online=True) == ("cartesia", "sv")
    assert select_engine("Good evening, sir.", online=False) == ("kokoro", "en")
    assert select_engine("God kväll, det är klart.", online=False) == ("piper", "sv")


def test_pulling_the_network_shows_in_the_log_once():
    online = [True, True, False, False, True]
    lines = []
    router = EngineRouter(probe=lambda: online.pop(0), log=lines.append)
    assert router.route("Hello sir, the report is ready.") == ("cartesia", "en")
    assert router.route("Hello sir, the report is ready.") == ("cartesia", "en")
    assert router.route("Hello sir, the report is ready.") == ("kokoro", "en")
    assert router.route("Hej, det är klart nu.") == ("piper", "sv")
    assert router.route("Hello sir, the report is ready.") == ("cartesia", "en")
    assert lines == ["tts: cartesia (en, online)", "tts: kokoro (en, offline fallback)", "tts: piper (sv, offline fallback)", "tts: cartesia (en, online)"]
