#!/bin/zsh
# Installs local speech: whisper.cpp + Whisper small (listening), Kokoro and Piper (Jarvis's voice). No accounts or keys.
set -euo pipefail
WHISPER="$HOME/Library/Application Support/Jarvis/models"
TTS="$HOME/.jarvis/tts"
RELEASES=https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models
mkdir -p "$WHISPER" "$TTS"
command -v whisper-cli >/dev/null || brew install whisper-cpp
command -v ffmpeg >/dev/null || brew install ffmpeg
[ -s "$WHISPER/ggml-small.bin" ] || curl -fL --retry 3 -o "$WHISPER/ggml-small.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
[ -x "$HOME/.jarvis/venv/bin/python" ] || python3 -m venv "$HOME/.jarvis/venv"
"$HOME/.jarvis/venv/bin/pip" -q install "sherpa-onnx==1.13.8" # 2.x has no text frontend for Piper models
"$HOME/.jarvis/venv/bin/pip" -q install kokoro-onnx
[ -d "$TTS/vits-piper-sv_SE-nst-medium" ] || curl -fL --retry 3 "$RELEASES/vits-piper-sv_SE-nst-medium.tar.bz2" | tar xj -C "$TTS"
mkdir -p "$TTS/kokoro"
for file in kokoro-v1.0.onnx voices-v1.0.bin; do
  [ -s "$TTS/kokoro/$file" ] || curl -fL --retry 3 -o "$TTS/kokoro/$file" "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/$file"
done
echo "Voice ready. Restart Jarvis: launchctl kickstart -k gui/$(id -u)/se.lamo.jarvis"
