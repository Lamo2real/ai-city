"""Voice is a client of the same route the HUD's text box uses, with the same session id."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from jarvis_voice.session import JarvisSession, SessionError

SEEN = []
CLOSED = threading.Event()


class FakeJarvisServer(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SEEN.append({"path": self.path, "host": self.headers["Host"], "type": self.headers["Content-Type"], **body})
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        if body["message"] == "fail":
            self.wfile.write(json.dumps({"type": "error", "error": "Jarvis could not get an answer"}).encode() + b"\n")
            return
        if body["message"] == "stall":
            self.wfile.write(json.dumps({"type": "sentence", "text": "Starting."}).encode() + b"\n")
            self.wfile.flush()
            CLOSED.clear()
            self.rfile.read(1)  # returns when the client hangs up
            CLOSED.set()
            return
        for event in [{"type": "filler", "text": "One moment, sir."}, {"type": "sentence", "text": "Math it is —"}, {"type": "sentence", "text": "eighteen."}, {"type": "done", "reply": "Math it is — eighteen."}]:
            self.wfile.write(json.dumps(event).encode() + b"\n")
            self.wfile.flush()

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.wfile.write(b": connected\n\n")
        self.wfile.write(b'data: {"type":"jarvis","sessionId":"other","text":"not for you"}\n\n')
        self.wfile.write(b'data: {"type":"jarvis","sessionId":"owner","text":"The team is done, sir."}\n\n')


@pytest.fixture(scope="module")
def server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), FakeJarvisServer)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def test_voice_and_text_turns_land_in_the_same_session(server):
    SEEN.clear()
    voice = JarvisSession(server)  # the pipeline, default session
    typed = JarvisSession(server, session_id="owner")  # what the HUD's text box sends
    assert list(voice.sentences("what's 9+9")) == ["Math it is —", "eighteen."]
    assert [e["type"] for e in typed.turn("and twice that?")] == ["filler", "sentence", "sentence", "done"]
    assert [s["sessionId"] for s in SEEN] == ["owner", "owner"]
    assert all(s["path"] == "/api/chat/stream" and s["voice"] is False and s["type"] == "application/json" for s in SEEN)
    assert SEEN[0]["host"].startswith("127.0.0.1:"), "the server only answers its own host"


def test_a_server_error_raises(server):
    with pytest.raises(SessionError, match="could not get an answer"):
        list(JarvisSession(server).sentences("fail"))


def test_unprompted_messages_for_this_session_only(server):
    events = JarvisSession(server).events()
    assert next(events) == "The team is done, sir."


def test_cancel_drops_the_running_turn_and_the_server_sees_the_hang_up(server):
    session = JarvisSession(server)
    turn = session.sentences("stall")
    assert next(turn) == "Starting."
    session.cancel()
    assert list(turn) == []
    assert CLOSED.wait(2)
    session.cancel()  # nothing running: harmless
