"""The shared Jarvis conversation. Voice is a client of the same server route the
HUD's text box uses, with the same session id, so spoken and typed turns land in
one conversation and Jarvis keeps its context when the owner switches."""
import json
import urllib.request
from collections.abc import Iterator

DEFAULT_SESSION = "owner"


class SessionError(RuntimeError):
    pass


class JarvisSession:
    def __init__(self, base_url: str = "http://127.0.0.1:7777", session_id: str = DEFAULT_SESSION, timeout: float = 300.0):
        self.base_url = base_url.rstrip("/")
        self.session_id = session_id
        self.timeout = timeout

    def _post(self, path: str, body: dict) -> urllib.request.addinfourl:
        req = urllib.request.Request(f"{self.base_url}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
        return urllib.request.urlopen(req, timeout=self.timeout)

    def turn(self, text: str) -> Iterator[dict]:
        """Send the owner's words; yield the server's events: filler, sentence, done, error.
        voice=False: this pipeline speaks through its own TTS, the server sends no audio."""
        with self._post("/api/chat/stream", {"message": text, "sessionId": self.session_id, "voice": False}) as res:
            for raw in res:
                line = raw.decode("utf-8").strip()
                if not line:
                    continue
                event = json.loads(line)
                if event.get("type") == "error":
                    raise SessionError(event.get("error", "unknown error"))
                yield event

    def sentences(self, text: str) -> Iterator[str]:
        for event in self.turn(text):
            if event.get("type") == "sentence":
                yield event["text"]

    def events(self) -> Iterator[str]:
        """What Jarvis says unprompted for this session (questions, results), from the
        server's event stream. Blocks; run it in its own thread."""
        req = urllib.request.Request(f"{self.base_url}/api/events", headers={"Accept": "text/event-stream"})
        with urllib.request.urlopen(req, timeout=None) as res:
            for raw in res:
                line = raw.decode("utf-8").rstrip("\n")
                if line.startswith("data: "):
                    event = json.loads(line[6:])
                    if event.get("type") == "jarvis" and event.get("sessionId") == self.session_id:
                        yield event["text"]
