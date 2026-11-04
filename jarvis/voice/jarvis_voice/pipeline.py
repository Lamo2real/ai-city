"""The voice loop's logic and entry point: one owner turn through the shared Jarvis
session, what he heard before a barge-in, the long-turn summary. The Pipecat graph is
in graph.py; this module imports without Pipecat.

Install with `uv sync --extra pipeline`, run with `uv run python -m jarvis_voice.pipeline`.
"""
from __future__ import annotations

import argparse
import asyncio
import http.client
import json
import os
import subprocess
import sys
import time
from collections.abc import Callable, Iterator
from pathlib import Path

from .aggregator import ClauseAggregator
from .bargein import estimate_word_starts, interruption_note, truncate_spoken
from .fallback import detect_language
from .longturn import condense
from .session import JarvisSession, SessionError
from .timing import TimingLog, TurnTimer

ROOT = Path(__file__).resolve().parents[3]
CONFIG = ROOT / "config" / "voice.json"
SUMMARIZER_PROMPT = ROOT / "agents" / "voice" / "summarizer.md"
NO_ANSWER = {"en": "I can't reach Claude right now, sir.", "sv": "Jag når inte Claude just nu."}


def load_config(path: Path = CONFIG) -> dict:
    return json.loads(Path(path).read_text())


def keychain(service: str) -> str | None:
    """Secrets come from the Keychain only; never from files or the environment."""
    try:
        return subprocess.run(["security", "find-generic-password", "-s", service, "-w"], capture_output=True, text=True, check=True).stdout.strip() or None
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def summarize_with_haiku(older: str, run=subprocess.run) -> str:
    """Haiku through the logged-in `claude` CLI, on the subscription. No tools, no session."""
    prompt = SUMMARIZER_PROMPT.read_text().split("---", 2)[2].strip()
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    done = run(
        ["claude", "-p", "--model", "claude-haiku-5-5", "--system-prompt", prompt, "--tools", "", "--strict-mcp-config", "--no-session-persistence"],
        input=older, capture_output=True, text=True, timeout=120, env=env, check=True,
    )
    return done.stdout.strip()


class JarvisTurnProcessor:
    """Owner transcript in, clauses to speak out, through the shared session.

    Keeps the interruption memory: what the owner heard of the last reply goes in front
    of the next turn, the same way the HUD does it.
    """

    def __init__(self, session: JarvisSession, timing: TimingLog, log: Callable[[str], None] = print, summarize: Callable[[str], str] = summarize_with_haiku, clock: Callable[[], float] = time.monotonic, online: Callable[[], bool] = lambda: True):
        self.session = session
        self.timing = timing
        self.log = log
        self.summarize = summarize
        self.clock = clock
        self.online = online
        self.aggregator = ClauseAggregator()
        self.timer: TurnTimer | None = None
        self.heard = ""  # Jarvis's last reply, cut to what was played, if interrupted
        self.owner_text = ""
        self.generation = 0  # a cancelled turn must not touch the next one
        self._reset_playback()

    def _reset_playback(self) -> None:
        self.spoken_words: list[tuple[str, float]] = []
        self.queued = ""
        self.played_s = 0.0
        self.playing_since: float | None = None

    def start_turn(self, speech_end: float, stt_final: float) -> None:
        self.finish_turn()
        self.timer = self.timing.start(self.clock)
        self.timer.mark("turn_end", speech_end)
        self.timer.mark("stt_final", stt_final)
        self.timer.mark("turn_decided")
        self._reset_playback()

    def finish_turn(self) -> None:
        if self.timer:
            self.timing.finish(self.timer)
            self.timer = None

    def mark(self, name: str) -> None:
        if self.timer:
            self.timer.mark(name)

    def _condensed(self, transcript: str) -> str:
        def summarize(older: str) -> str:
            try:
                return self.summarize(older)
            except (OSError, subprocess.SubprocessError) as err:
                self.log(f"long-turn summary failed ({type(err).__name__}): sending the start of the older part instead")
                return f"(summary failed; it began) {older[:400]}"

        return condense(transcript, summarize)

    def owner_said(self, transcript: str) -> Iterator[str]:
        """One owner turn. Yields the pieces to speak as they are ready. Runs in a worker thread."""
        generation = self.generation
        self.owner_text = transcript
        told = not self.online()
        if told:  # the server may retry for minutes before it gives up; say so now, it may still answer
            self.log("offline: telling the owner, still asking Jarvis")
            yield NO_ANSWER[detect_language(transcript)]
        text = self._condensed(transcript)
        if generation != self.generation:
            return
        if self.heard:
            text = interruption_note(self.heard, text)
            self.heard = ""
        self.aggregator.reset()
        try:
            for sentence in self.session.sentences(text):
                if generation != self.generation:
                    return
                self.mark("llm_first_token")
                yield from self.aggregator.push(sentence + " ")
        except (OSError, http.client.HTTPException, SessionError) as err:
            self.log(f"no answer from Jarvis ({type(err).__name__}): {err}")
            if not told:
                yield NO_ANSWER[detect_language(transcript)]
            return
        if generation == self.generation:
            yield from self.aggregator.flush()

    def on_queued(self, piece: str) -> None:
        self.queued = f"{self.queued} {piece}".strip()

    def on_tts_word(self, word: str) -> None:
        self.spoken_words.append((word, self._played()))

    def on_bot_started(self) -> None:
        self.mark("playback_start")
        self.playing_since = self.clock()

    def on_bot_stopped(self) -> None:
        self.played_s = self._played()
        self.playing_since = None

    def _played(self) -> float:
        return self.played_s + (self.clock() - self.playing_since if self.playing_since is not None else 0.0)

    def interrupted(self) -> str:
        """The owner cut in. Returns his earlier words if none of the reply was played: they
        still need an answer. Otherwise the next turn is told what he heard."""
        self.generation += 1
        self.session.cancel()
        played = self._played()
        if not played:
            self.log("barge-in: nothing played yet, his earlier words go with the next turn")
            return self.owner_text
        self.heard = truncate_spoken("", self.spoken_words or estimate_word_starts(self.queued), played)
        self.log(f"barge-in: heard up to '{self.heard}'")
        return ""


def main() -> None:
    if os.environ.get("ANTHROPIC_API_KEY") and os.environ.get("JARVIS_ALLOW_API_KEY") != "1":
        raise SystemExit("ANTHROPIC_API_KEY is set. AI City runs on the Claude subscription; unset it.")
    parser = argparse.ArgumentParser(description="Jarvis's real-time voice loop")
    parser.add_argument("--config", default=CONFIG, help="config file (default: config/voice.json)")
    cfg = load_config(parser.parse_args().config)

    api_key = keychain("jarvis.cartesia")
    if not api_key:
        raise SystemExit("Keychain item jarvis.cartesia is missing. Add your Cartesia key:\n  security add-generic-password -s jarvis.cartesia -a jarvis -w '<key>'")
    if cfg["cartesia"]["voice_id"].startswith("PICK-BY-EAR"):
        raise SystemExit("config/voice.json has no Cartesia voice yet: pick a stock British male voice in the Cartesia library and put its id in cartesia.voice_id.")

    from loguru import logger

    from .fallback import OnlineProbe
    from .graph import build_pipeline, build_tts, real_transport  # Pipecat loads only after the checks above

    logger.remove()  # Pipecat's DEBUG output drowns the tts:, timing and barge-in lines the owner reads
    logger.add(sys.stderr, level="WARNING")
    JarvisSession(cfg.get("server", "http://127.0.0.1:7777"), cfg.get("session_id", "owner")).warm()

    async def run() -> None:  # Pipecat's task needs a running event loop from the moment it is built
        runner, task = build_pipeline(cfg, transport=real_transport(cfg.get("echo_cancellation", True)), services=build_tts(cfg, api_key), probe=OnlineProbe())
        print("Jarvis is listening. Ctrl-C stops him.", flush=True)
        await runner.run(task)

    asyncio.run(run())


if __name__ == "__main__":
    main()
