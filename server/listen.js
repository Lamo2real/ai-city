// Speech to text with whisper.cpp, on this Mac: audio never leaves it.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
// Biases Whisper towards the words it would otherwise mishear ("Javas", "domain"). It must not
// end in the name: Whisper then takes a spoken "Jarvis" for a repeat of the prompt and drops it.
const PROMPT = "The owner is talking to his assistant, whose name is Jarvis, about pull requests and merges to main.";
const NAME = "(?:jarvis|javis|jarvas|javas|jarves|jervis|görvis)";
const GREETING = "(?:hi|hiya|hello|hey|hej|hallå|good (?:morning|afternoon|evening)|god (?:morgon|kväll))";
// "Jarvis" opening what you say, or "yo Jarvis" or a greeting anywhere. A mention mid-sentence is not a call.
const WAKE = new RegExp(`^\\W*(?:ok(?:ay)?\\W+)?${NAME}\\b[\\s,.!?-]*|(?:^|[\\s,.!?])(?:yo|yoh|jo|${GREETING})[\\s,.!-]*${NAME}\\b[\\s,.!?-]*`, "i");
const ONLY_GREETING = new RegExp(`^\\W*${GREETING}\\W+${NAME}\\W*$`, "i");

export function cleanTranscript(text) {
  return String(text ?? "").replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

// Finds the wake phrase. Only what follows it is the command.
export function parseWake(text) {
  const match = WAKE.exec(text);
  if (!match) return { wake: false, command: "" };
  // "Hi Jarvis" is something to answer, not only a wake word.
  if (ONLY_GREETING.test(text)) return { wake: true, command: text.trim() };
  return { wake: true, command: text.slice(match.index + match[0].length).trim() };
}

export function isWav(buffer) {
  return buffer.length > 44 && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WAVE";
}

export function createTranscriber({ dataDir }) {
  const model = join(dataDir, "models", "ggml-small.bin");
  let queue = Promise.resolve();

  async function once(wav) {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-listen-"));
    try {
      const file = join(dir, "in.wav");
      await writeFile(file, wav);
      const { stdout } = await run("whisper-cli", ["-m", model, "-f", file, "-l", "auto", "-nt", "-np", "--prompt", PROMPT], { timeout: 60_000, maxBuffer: 1024 * 1024 });
      return cleanTranscript(stdout);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return (wav) => {
    const next = queue.catch(() => {}).then(() => once(wav));
    queue = next;
    return next;
  };
}
