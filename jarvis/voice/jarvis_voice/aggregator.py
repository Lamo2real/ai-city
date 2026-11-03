"""Clause aggregator: turns streamed reply text into pieces to speak.

The first clause goes out as soon as it ends (a comma, a dash, or six words), so
audio starts before the full reply exists. After that, whole sentences.
"""
import re

_FIRST_BOUNDARY = re.compile(r"^(.*?\S)([,:;]|\s[—–-]\s|—)\s*", re.S)
_SENTENCE_END = re.compile(r"(.*?[.!?…]+[\"')\]]*)(\s+|$)", re.S)
FIRST_CLAUSE_WORDS = 6


class ClauseAggregator:
    def __init__(self, first_clause_words: int = FIRST_CLAUSE_WORDS):
        self.buffer = ""
        self.first_done = False
        self.first_clause_words = first_clause_words

    def push(self, delta: str) -> list[str]:
        """Add streamed text; return the pieces that are ready to speak."""
        self.buffer += delta
        out: list[str] = []
        while True:
            piece = self._first_clause() if not self.first_done else self._sentence()
            if piece is None:
                return out
            out.append(piece)

    def flush(self) -> list[str]:
        rest = self.buffer.strip()
        self.buffer = ""
        self.first_done = True
        return [rest] if rest else []

    def reset(self) -> None:
        self.buffer = ""
        self.first_done = False

    def _take(self, end: int) -> str:
        piece = self.buffer[:end].strip()
        self.buffer = self.buffer[end:]
        return piece

    def _first_clause(self) -> str | None:
        # The earliest boundary wins: a comma, a dash, or a sentence end ("Eighteen." must not wait for a comma).
        ends = []
        m = _SENTENCE_END.match(self.buffer)
        if m and m.group(2):
            ends.append(m.end())
        m = _FIRST_BOUNDARY.match(self.buffer)
        if m:
            ends.append(m.end())
        if ends:
            self.first_done = True
            return self._take(min(ends))
        words = self.buffer.split()
        if len(words) > self.first_clause_words or (len(words) == self.first_clause_words and self.buffer.endswith((" ", "\n"))):
            cut = len(self.buffer) - len(self.buffer.lstrip())
            for _ in range(self.first_clause_words):
                nxt = self.buffer.find(" ", cut + 1)
                cut = nxt if nxt >= 0 else len(self.buffer)
            self.first_done = True
            return self._take(cut)
        return None

    def _sentence(self) -> str | None:
        m = _SENTENCE_END.match(self.buffer)
        if m and m.group(2):
            return self._take(m.end())
        return None
