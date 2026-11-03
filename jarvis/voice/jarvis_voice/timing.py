"""Per-turn timings, measured against the end of the owner's speech:
STT final, LLM first token, TTS first byte, playback start. One JSON line per turn."""
import json
import time
from collections.abc import Callable

MARKS = ("turn_end", "stt_final", "llm_first_token", "tts_first_byte", "playback_start", "barge_in")
TARGET_FIRST_AUDIO_MS = 800
TARGET_STOP_MS = 200


class TurnTimer:
    def __init__(self, turn: int, clock: Callable[[], float] = time.monotonic):
        self.turn = turn
        self.clock = clock
        self.marks: dict[str, float] = {}

    def mark(self, name: str) -> None:
        if name not in MARKS:
            raise ValueError(f"unknown mark {name}")
        self.marks.setdefault(name, self.clock())  # the first time counts

    def ms(self, name: str) -> int | None:
        if name not in self.marks or "turn_end" not in self.marks:
            return None
        return round((self.marks[name] - self.marks["turn_end"]) * 1000)

    def line(self) -> str:
        row = {"turn": self.turn, **{name: self.ms(name) for name in MARKS[1:] if name in self.marks}}
        first_audio = self.ms("playback_start")
        if first_audio is not None:
            row["within_target"] = first_audio <= TARGET_FIRST_AUDIO_MS
        return json.dumps(row)


class TimingLog:
    def __init__(self, path: str | None, log: Callable[[str], None] = print):
        self.path = path
        self.log = log
        self.turns = 0

    def start(self, clock: Callable[[], float] = time.monotonic) -> TurnTimer:
        self.turns += 1
        return TurnTimer(self.turns, clock)

    def finish(self, timer: TurnTimer) -> str:
        line = timer.line()
        self.log(f"timing {line}")
        if self.path:
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        return line


def p50(lines: list[str], key: str = "playback_start") -> int | None:
    values = sorted(v for v in (json.loads(l).get(key) for l in lines if l.strip()) if v is not None)
    return values[len(values) // 2] if values else None
