"""The real graph with no microphone or speaker: `say` speaks into the fake mic, real
Silero, smart-turn, Whisper, Kokoro and Piper run, and playback is captured. Not a pytest
test: it loads models and takes minutes.

    uv run python tests/smoke_graph.py [--server http://127.0.0.1:PORT] [--out DIR]

Without --server a scripted Jarvis answers, so no Claude call is made. Cartesia points at a
dead local port, which is what a pulled network looks like to it.
"""
import argparse
import asyncio
import json
import subprocess
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from fake_audio import FakeAudioTransport  # noqa: E402

from pipecat.services.whisper.stt import WhisperSTTServiceMLX  # noqa: E402

from jarvis_voice.graph import build_pipeline, build_tts  # noqa: E402
from jarvis_voice.pipeline import load_config  # noqa: E402

LONG = "Very well, sir. " + " ".join(f"This is sentence number {i} of a rather long answer about nothing at all." for i in range(1, 9))
HEARD = []


class ScriptedJarvis(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        message = json.loads(self.rfile.read(int(self.headers["Content-Length"])))["message"]
        HEARD.append(message)
        low = message.splitlines()[-1].lower()  # the owner's words, not an interruption note
        reply = "Math it is, eighteen sir." if "nine" in low else LONG if "long" in low else "Det är klart, och jag har skickat rapporten." if "swedish" in low else "Noted, sir."
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        time.sleep(0.05)
        for event in [{"type": "sentence", "text": s.strip() + "."} for s in reply.split(".") if s.strip()] + [{"type": "done", "reply": reply}]:
            self.wfile.write(json.dumps(event).encode() + b"\n")
            self.wfile.flush()

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        time.sleep(3600)


def spoken(text: str, folder: Path, voice: str = "Daniel") -> bytes:
    path = folder / f"{abs(hash(text))}.wav"
    subprocess.run(["say", "-v", voice, "-o", str(path), "--file-format=WAVE", "--data-format=LEI16@16000", text], check=True)
    with wave.open(str(path)) as f:
        return f.readframes(f.getnframes())


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server")
    parser.add_argument("--whisper", help="another MLX Whisper model, for a quick run")
    parser.add_argument("--out", default=tempfile.mkdtemp(prefix="jarvis-voice-smoke-"))
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    base = args.server
    if not base:
        fake = ThreadingHTTPServer(("127.0.0.1", 0), ScriptedJarvis)
        threading.Thread(target=fake.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{fake.server_port}"

    log_lines: list[str] = []

    def log(line: str) -> None:
        log_lines.append(line)
        print(f"{time.strftime('%H:%M:%S')} {line}", flush=True)

    async def wait_for(text: str, seconds: float, mic) -> bool:
        """Keep the mic running until the log says `text`."""
        for _ in range(int(seconds / 0.2)):
            if any(text in line for line in log_lines):
                return True
            await mic.silence(0.2)
        return False

    results: dict[str, bool] = {}
    online = [False]

    async def replied(mic, seconds: float = 40) -> bool:
        """Keep the mic running until Jarvis has said something and gone quiet."""
        if not await wait_for("jarvis [", seconds, mic):
            return False
        played = -1
        while played != (played := len(transport.output().played)):
            await mic.silence(1.5)
        return True

    async def feed(mic):
        await mic.silence(1)
        log("--- 9 plus 9")
        await mic.send(spoken("Hey Jarvis, what is nine plus nine?", out))
        results["answers"] = await replied(mic, 60 if args.server else 40)
        if args.server:  # against the real Jarvis there is one question, not a script
            await task.cancel()
            return

        log_lines.clear()
        log("--- a pause mid-sentence is one turn")
        await mic.send(spoken("I was thinking about the weather, and", out))
        await mic.silence(1.0)
        await mic.send(spoken("what I should wear tomorrow when I go to the office.", out))
        results["answered"] = await replied(mic)
        results["one_turn"] = sum(line.startswith("owner:") for line in log_lines) == 1

        log_lines.clear()
        log("--- barge-in")
        await mic.send(spoken("Please give me a long answer.", out))
        results["long_started"] = await wait_for("jarvis [", 25, mic)
        await mic.silence(4)
        log_lines.clear()
        await mic.send(spoken("Stop right there, that is enough for now.", out))
        results["cut"] = await wait_for("barge-in: playback stopped", 5, mic)
        results["reply_after_cut"] = await replied(mic)
        results["told_what_was_heard"] = "You were interrupted" in HEARD[-1] and "Stop right there" in HEARD[-1] and "[interrupted]" in HEARD[-1]

        log_lines.clear()
        log("--- Swedish offline goes to Piper")
        await mic.send(spoken("Please reply in swedish.", out))
        results["piper"] = await wait_for("tts: piper (sv, offline fallback)", 25, mic) and await replied(mic)

        log_lines.clear()
        log("--- network back with Cartesia dead: the graph survives and the offline voices take over")
        await mic.silence(35)  # the failed connect at start holds Cartesia off for 30 s
        online[0] = True
        await mic.send(spoken("Tell me what nine times nine is.", out))
        results["back_online_logged"] = await wait_for("tts: cartesia (en, online)", 25, mic)
        results["error_seen"] = await wait_for("tts: cartesia failed", 10, mic)
        await mic.silence(3)
        log_lines.clear()
        await mic.send(spoken("Please reply in english with something else.", out))
        results["falls_back"] = await wait_for("tts: kokoro (en, offline fallback)", 25, mic) and await replied(mic)
        await task.cancel()

    cfg = {**load_config(), "server": base, "timing_log": str(out / "timings.jsonl")}
    transport = FakeAudioTransport(feed)
    services = build_tts(cfg, "dead-port-no-real-key", cartesia_url="ws://127.0.0.1:9")
    stt = WhisperSTTServiceMLX(settings=WhisperSTTServiceMLX.Settings(model=args.whisper, language=None), ttfs_p99_latency=2.0) if args.whisper else None
    runner, task = build_pipeline(cfg, transport=transport, services=services, probe=lambda: online[0], log=log, stt=stt)
    await runner.run(task)

    with wave.open(str(out / "played.wav"), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(task._params.audio_out_sample_rate or 24000)
        f.writeframes(bytes(transport.output().played))
    print(json.dumps({"results": results, "heard_by_server": HEARD, "out": str(out)}, indent=1))
    return 0 if results and all(results.values()) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
