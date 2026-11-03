# Text to speech for Jarvis. English: Kokoro. Swedish: Piper via sherpa-onnx. macOS `say`
# if those fail. Then the ffmpeg filter from voice.json. `--serve` keeps the models loaded
# for the server. Stock voices only, never a cloned or imitated one.
import argparse
import array
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULTS = {
    "speed": 1.15,
    "filter": "highpass=f=60",
    "volume": 1.0,
    "en_voice": "bm_george",
    "kokoro_dir": "~/.jarvis/tts/kokoro",
    "sv_model_dir": "~/.jarvis/tts/vits-piper-sv_SE-nst-medium",
    "fallback_en": "Daniel",
    "fallback_sv": "Alva",
}


def log(line):
    try:
        with open(os.path.expanduser("~/Library/Logs/jarvis.log"), "a") as out:
            out.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} jarvis-say: {line}\n")
    except OSError:
        pass


def load_config():
    path = os.environ.get("JARVIS_VOICE_CONFIG") or os.path.join(ROOT, "voice.json")
    try:
        with open(path) as f:
            return {**DEFAULTS, **json.load(f)}
    except FileNotFoundError:
        return dict(DEFAULTS)


# Spoken text never reads out URLs, IDs, hashes, paths or code.
def clean(text):
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"`[^`]*`", " ", text)
    text = re.sub(r"\b([\w-]+)#\d+", r"\1 pull request", text)
    text = re.sub(r"\b(PR|pull request)\s*#?\d+", r"\1", text, flags=re.I)
    text = re.sub(r"#\d+", " ", text)
    text = re.sub(r"\b[0-9a-f]{7,40}\b", " ", text)
    text = re.sub(r"(^|\s)[\w.~-]*/[\w./-]+", " ", text)
    text = text.replace("→", " to ")
    text = re.sub(r"[*_`#>|]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def write_wav(samples, rate, out):
    pcm = array.array("h", (int(max(-1.0, min(1.0, float(s))) * 32767) for s in samples))
    if sys.byteorder == "big":
        pcm.byteswap()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


loaded = {}
TRIM = "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse"


def kokoro(text, cfg, speed, out):
    from kokoro_onnx import Kokoro

    folder = os.path.expanduser(cfg["kokoro_dir"])
    engine = loaded.get("kokoro") or Kokoro(os.path.join(folder, "kokoro-v1.0.onnx"), os.path.join(folder, "voices-v1.0.bin"))
    loaded["kokoro"] = engine
    samples, rate = engine.create(text, voice=cfg["en_voice"], speed=speed, lang="en-gb")
    write_wav(samples, rate, out)


def piper(text, model_dir, speed, out):
    import sherpa_onnx

    model_dir = os.path.expanduser(model_dir)
    model = next(f for f in os.listdir(model_dir) if f.endswith(".onnx"))
    vits = sherpa_onnx.OfflineTtsVitsModelConfig(
        model=os.path.join(model_dir, model),
        tokens=os.path.join(model_dir, "tokens.txt"),
        data_dir=os.path.join(model_dir, "espeak-ng-data"),
    )
    config = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(vits=vits, num_threads=4))
    audio = sherpa_onnx.OfflineTts(config).generate(text, sid=0, speed=speed)
    if not len(audio.samples):
        raise RuntimeError("no audio")
    write_wav(audio.samples, audio.sample_rate, out)


def speak(raw, lang, out_path):
    cfg = load_config()
    text = clean(raw)
    if not text:
        raise ValueError("nothing to say")
    speed = min(1.3, max(0.9, float(cfg["speed"])))
    work = tempfile.mkdtemp(prefix="jarvis-say-")
    try:
        source = os.path.join(work, "voice.wav")
        try:
            if lang == "en":
                kokoro(text, cfg, speed, source)
                engine = "kokoro"
            else:
                piper(text, cfg["sv_model_dir"], speed, source)
                engine = "piper"
        except Exception as err:
            log(f"{'kokoro' if lang == 'en' else 'piper'} failed ({type(err).__name__}), using say")
            source = os.path.join(work, "voice.aiff")
            subprocess.run(["say", "-v", cfg[f"fallback_{lang}"], "-o", source, "--", text], check=True, capture_output=True, timeout=60)
            engine = "say"
        audio_filter = cfg["filter"]
        if float(cfg["volume"]) != 1.0:
            audio_filter += f",volume={float(cfg['volume'])}"
        # WAV for the server: MP3 adds silence at both ends, which is audible between sentences.
        as_wav = bool(out_path) and out_path.endswith(".wav")
        target = os.path.join(work, "out.wav" if as_wav else "out.mp3")
        if as_wav:
            codec = ["-af", f"{TRIM},{audio_filter},apad=pad_dur=0.12", "-c:a", "pcm_s16le"]
        else:
            codec = ["-af", audio_filter, "-ar", "44100", "-codec:a", "libmp3lame", "-b:a", "128k"]
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", source, *codec, target], check=True, capture_output=True, timeout=60)
        if out_path:
            shutil.move(target, out_path)
        else:
            subprocess.run(["afplay", target], check=True, timeout=300)
        log(f"engine={engine} lang={lang}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def serve():
    warm = os.path.join(tempfile.gettempdir(), f"jarvis-warm-{os.getpid()}.mp3")
    try:
        speak("Ready.", "en", warm)
        os.remove(warm)
    except Exception:
        pass
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        try:
            req = json.loads(line)
            speak(req["text"], req.get("lang", "en"), req["out"])
            print(json.dumps({"ok": True}), flush=True)
        except Exception as err:
            print(json.dumps({"ok": False, "error": type(err).__name__}), flush=True)


def main():
    if sys.argv[1:] == ["--serve"]:
        return serve()
    parser = argparse.ArgumentParser(prog="jarvis-say")
    parser.add_argument("text")
    parser.add_argument("--lang", choices=["en", "sv"], default="en")
    parser.add_argument("--out")
    args = parser.parse_args()
    try:
        speak(args.text, args.lang, args.out)
    except ValueError as err:
        sys.exit(f"jarvis-say: {err}")
    except (subprocess.SubprocessError, OSError) as err:
        sys.exit(f"jarvis-say: {type(err).__name__}: could not produce audio")


if __name__ == "__main__":
    main()
