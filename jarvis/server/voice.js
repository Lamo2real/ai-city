// Replies go through bin/jarvis_say.py, kept running so the voice models stay loaded and each
// sentence starts quickly (stock voices only, tuned in voice.json). If that fails
// altogether: stock macOS voices, `say` to AIFF, then MP3 or AAC.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_CHARS = 2000;
const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "jarvis_say.py");
const WORKER_TIMEOUT_MS = 45_000;
const SV_WORDS = /\b(och|är|jag|det|inte|för|att|på|som|med|har|till|ett|den|av|kan|vi|du|ni|nu|inga|finns)\b/gi;
const EN_WORDS = /\b(the|is|and|to|of|in|on|for|that|with|are|has|you|it|sir|no|there|not)\b/gi;

export function pickVoice(text) {
  const count = (re) => (text.match(re) ?? []).length;
  return count(SV_WORDS) > count(EN_WORDS) ? "Alva" : "Daniel";
}

export function speechText(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/→/g, " to ")
    // Spoken replies never read out IDs, hashes, paths or code; the written reply keeps them.
    .replace(/`[^`]*`/g, " ")
    .replace(/\b([\w-]+)#\d+/g, "$1 pull request")
    .replace(/\b(PR|pull request)\s*#?\d+/gi, "$1")
    .replace(/#\d+/g, " ")
    .replace(/\b[0-9a-f]{7,40}\b/g, " ")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(^|\s)[\w.~-]*\/[\w./-]+/g, " ")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHARS);
}

async function encode(aiff, dir) {
  const mp3 = join(dir, "out.mp3");
  try {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", aiff, "-codec:a", "libmp3lame", "-q:a", "4", mp3], { timeout: 60_000 });
    return { path: mp3, type: "audio/mpeg" };
  } catch {
    const m4a = join(dir, "out.m4a");
    await run("afconvert", ["-f", "m4af", "-d", "aac", aiff, m4a], { timeout: 60_000 });
    return { path: m4a, type: "audio/mp4" };
  }
}

let worker = null;
function startWorker(python) {
  const proc = spawn(python, ["-I", WORKER, "--serve"], { stdio: ["pipe", "pipe", "ignore"] });
  const waiting = [];
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  createInterface({ input: proc.stdout }).on("line", (line) => {
    let answer = {};
    try { answer = JSON.parse(line); } catch { /* counted as a failure below */ }
    if (answer.ready) markReady();
    else waiting.shift()?.(answer);
  });
  const stopped = () => {
    worker = null;
    markReady();
    for (const resolve of waiting.splice(0)) resolve({ ok: false });
  };
  proc.on("exit", stopped);
  proc.on("error", stopped);
  proc.stdin.on("error", () => {});
  return { proc, waiting, ready };
}

async function jarvisSay(spoken, lang, dir) {
  const python = join(homedir(), ".jarvis", "venv", "bin", "python");
  if (process.env.JARVIS_VOICE_SCRIPT === "off" || !existsSync(python)) return null;
  worker ??= startWorker(python);
  const current = worker;
  await current.ready;
  if (worker !== current) return null;
  const out = join(dir, "reply.wav");
  const answer = new Promise((resolve) => current.waiting.push(resolve));
  current.proc.stdin.write(`${JSON.stringify({ text: spoken, lang, out })}\n`);
  const late = new Promise((resolve) => setTimeout(() => resolve({ ok: false }), WORKER_TIMEOUT_MS).unref());
  if ((await Promise.race([answer, late])).ok !== true) return null;
  return (await readFile(out)).toString("base64");
}

export async function synthesize(text) {
  const spoken = speechText(text);
  if (!spoken) return null;
  const dir = await mkdtemp(join(tmpdir(), "jarvis-voice-"));
  try {
    const system = pickVoice(spoken);
    const audio = await jarvisSay(spoken, system === "Alva" ? "sv" : "en", dir);
    if (audio) return { audio, audioType: "audio/wav" };
    const input = join(dir, "in.txt");
    const aiff = join(dir, "out.aiff");
    await writeFile(input, spoken);
    await run("say", ["-v", system, "-f", input, "-o", aiff], { timeout: 60_000 });
    const { path, type } = await encode(aiff, dir);
    return { audio: (await readFile(path)).toString("base64"), audioType: type };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
