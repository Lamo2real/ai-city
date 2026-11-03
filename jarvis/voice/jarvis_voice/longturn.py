"""Long owner turns: past ~1,500 words the older part is summarized before it goes
to Jarvis, the latest 300 words stay verbatim."""
from collections.abc import Callable

LIMIT_WORDS = 1500
KEEP_WORDS = 300


def needs_summary(transcript: str, limit: int = LIMIT_WORDS) -> bool:
    return len(transcript.split()) > limit


def split(transcript: str, keep: int = KEEP_WORDS) -> tuple[str, str]:
    """(older part, latest `keep` words verbatim)."""
    words = transcript.split()
    if len(words) <= keep:
        return "", transcript.strip()
    return " ".join(words[:-keep]), " ".join(words[-keep:])


def condense(transcript: str, summarize: Callable[[str], str], limit: int = LIMIT_WORDS, keep: int = KEEP_WORDS) -> str:
    """The text to send: unchanged below the limit, else a summary of the older part
    followed by the latest words verbatim. `summarize` is the LLM call."""
    if not needs_summary(transcript, limit):
        return transcript.strip()
    older, latest = split(transcript, keep)
    return f"[Summary of what the owner said first: {summarize(older).strip()}]\n{latest}"
