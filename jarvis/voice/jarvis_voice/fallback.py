"""Which voice engine speaks: Cartesia when the network is there, otherwise
Kokoro for English and Piper for Swedish. The log says which."""
import re
import socket
import threading
import time
from collections.abc import Callable

_SV = re.compile(r"[åäö]|\b(och|är|jag|det|inte|för|att|på|som|med|har|till|ett|den|av|kan|vi|du|ni|nu|hej)\b", re.I)
_EN = re.compile(r"\b(the|is|and|to|of|in|on|for|that|with|are|has|you|it|sir|no|there|not|what|how)\b", re.I)

ENGINES = {
    ("en", True): "cartesia",
    ("sv", True): "cartesia",
    ("en", False): "kokoro",
    ("sv", False): "piper",
}


def detect_language(text: str) -> str:
    return "sv" if len(_SV.findall(text)) > len(_EN.findall(text)) else "en"


def network_ok(host: str = "api.cartesia.ai", port: int = 443, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


class OnlineProbe:
    """Keeps the answer current in the background: a turn must never wait on a socket."""

    def __init__(self, check: Callable[[], bool] = network_ok, every_s: float = 2.0):
        self.check = check
        self.every_s = every_s
        self.online = check()
        threading.Thread(target=self._watch, daemon=True).start()

    def _watch(self) -> None:
        while True:
            time.sleep(self.every_s)
            self.online = self.check()

    def __call__(self) -> bool:
        return self.online


def select_engine(text: str, online: bool) -> tuple[str, str]:
    """(engine, language) for this piece of text."""
    language = detect_language(text)
    return ENGINES[(language, online)], language


class EngineRouter:
    """Remembers the last choice and logs every change, so 'pull the network' shows in the log."""

    def __init__(self, probe: Callable[[], bool] = network_ok, log: Callable[[str], None] = print):
        self.probe = probe
        self.log = log
        self.current: str | None = None

    def route(self, text: str) -> tuple[str, str]:
        online = self.probe()
        engine, language = select_engine(text, online)
        if engine != self.current:
            self.log(f"tts: {engine} ({language}, {'online' if online else 'offline fallback'})")
            self.current = engine
        return engine, language
