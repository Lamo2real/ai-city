"""Barge-in: when to stop Jarvis, and what he remembers having said."""
import re

BARGE_IN_MIN_MS = 300
BACKCHANNELS = {"mm", "mhm", "mm-hm", "mmhmm", "hmm", "yeah", "yep", "yes", "okay", "ok", "right", "uh-huh", "sure", "ja", "jaha", "mm-m", "aha", "okej"}
_WORD = re.compile(r"[^\w'-]+")


def is_backchannel(text: str) -> bool:
    """'mm', 'yeah', 'okay' and the like: the owner is listening, not interrupting."""
    words = [w for w in _WORD.split(text.lower().strip()) if w]
    return bool(words) and len(words) <= 2 and all(w in BACKCHANNELS for w in words)


def should_interrupt(speech_ms: float, text: str = "") -> bool:
    """Owner speech longer than 300 ms that is not a backchannel stops playback.

    shortcut: the live graph applies only the 300 ms (VAD start_secs). MLX Whisper has no
    text until the owner stops, so a spoken "yeah" stops playback too; use this with a streaming STT.
    """
    return speech_ms > BARGE_IN_MIN_MS and not is_backchannel(text)


def truncate_spoken(text: str, word_starts: list[tuple[str, float]] | None, played_s: float) -> str:
    """Jarvis's last message cut to the words actually played, plus ' [interrupted]'.

    word_starts: (word, start seconds) from the TTS word timestamps, in order. Without
    timestamps nothing can be proven played, so only the marker remains.
    """
    if not word_starts:
        return "[interrupted]"
    played = [w for w, start in word_starts if start <= played_s]
    return (" ".join(played) + " [interrupted]").strip() if played else "[interrupted]"


def estimate_word_starts(text: str, words_per_s: float = 2.5) -> list[tuple[str, float]]:
    """For engines without word timestamps (Kokoro, Piper): when each word roughly played."""
    return [(word, i / words_per_s) for i, word in enumerate(text.split())]


def interruption_note(heard: str, owner_text: str) -> str:
    """What the next turn tells Jarvis, in the same words the HUD uses."""
    return f'[You were interrupted. The owner stopped you while you were saying: "{heard}" They did not hear anything after that.]\n{owner_text}'
