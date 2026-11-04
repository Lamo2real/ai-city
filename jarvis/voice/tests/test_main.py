"""main() itself, up to a running pipeline: only the audio devices and the keychain are faked."""
import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

pytest.importorskip("pipecat")


def test_main_refuses_a_placeholder_voice(monkeypatch, tmp_path, capsys):
    from jarvis_voice import pipeline

    config = tmp_path / "voice.json"
    config.write_text(json.dumps({"cartesia": {"voice_id": "PICK-BY-EAR: one"}}))
    monkeypatch.setattr(pipeline, "keychain", lambda _: "key")
    monkeypatch.setattr(sys, "argv", ["pipeline", "--config", str(config)])
    with pytest.raises(SystemExit, match="no Cartesia voice"):
        pipeline.main()


def test_main_reaches_a_running_pipeline(tmp_path):
    config = tmp_path / "voice.json"
    real = json.loads((Path(__file__).parents[3] / "config" / "voice.json").read_text())
    config.write_text(json.dumps({**real, "server": "http://127.0.0.1:9", "timing_log": str(tmp_path / "t.jsonl"), "cartesia": {"voice_id": "test", "model": "sonic-3"}}))
    code = textwrap.dedent(f"""
        import asyncio, os, sys
        sys.path.insert(0, {str(Path(__file__).parent)!r})
        sys.argv = ["pipeline", "--config", {str(config)!r}]
        from fake_audio import FakeAudioTransport
        from jarvis_voice import fallback, graph, pipeline

        async def feed(mic):
            await asyncio.sleep(1)
            print("PIPELINE RUNNING", flush=True)
            os._exit(0)

        pipeline.keychain = lambda _: "not-a-real-key"
        graph.real_transport = lambda _echo_cancellation: FakeAudioTransport(feed)
        fallback.OnlineProbe = lambda: (lambda: False)
        pipeline.main()
    """)
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=180, env=env)
    assert "PIPELINE RUNNING" in done.stdout, done.stderr[-2000:]
