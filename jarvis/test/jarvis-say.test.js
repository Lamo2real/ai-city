// bin/jarvis-say with fake say and ffmpeg, and no Piper model: the fallback path.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "jarvis-say");
const dir = mkdtempSync(join(tmpdir(), "jarvis-say-test-"));
const bin = join(dir, "bin");
const calls = join(dir, "calls.log");
mkdirSync(bin);
const fake = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`); chmodSync(join(bin, name), 0o755); };
fake("say", `while [ $# -gt 0 ]; do [ "$1" = "-o" ] && echo aiff > "$2"; shift; done`);
fake("ffmpeg", `for last; do :; done; echo mp3 > "$last"`);
const config = join(dir, "voice.json");
writeFileSync(config, JSON.stringify({ en_model_dir: join(dir, "missing"), sv_model_dir: join(dir, "missing"), filter: "lowpass=f=6000", speed: 5 }));
// HOME points away, so the real venv and log are not used.
const env = { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}`, JARVIS_VOICE_CONFIG: config };
const run = (...args) => spawnSync(SCRIPT, args, { env, encoding: "utf8" });

test("falls back to say, through the same filter, by language", () => {
  const en = join(dir, "en.mp3");
  assert.equal(run("Good evening, sir.", "--out", en).status, 0);
  assert.ok(existsSync(en));
  assert.equal(run("God kväll.", "--lang", "sv", "--out", join(dir, "sv.mp3")).status, 0);
  const log = readFileSync(calls, "utf8");
  assert.match(log, /say -v Daniel/);
  assert.match(log, /say -v Alva/);
  assert.match(log, /-af lowpass=f=6000 -ar 44100 -codec:a libmp3lame -b:a 128k/);
});

test("does not read out IDs, links, hashes or paths", () => {
  writeFileSync(calls, "");
  run("See application#67 at https://x.y/1 and abc1234 in docs/build/STATUS.md now", "--out", join(dir, "c.mp3"));
  assert.match(readFileSync(calls, "utf8"), /-- See application pull request at and in now/);
});

test("a total failure exits non-zero with one line", () => {
  fake("ffmpeg", "exit 1");
  const res = run("Hello.", "--out", join(dir, "x.mp3"));
  fake("ffmpeg", `for last; do :; done; echo mp3 > "$last"`);
  assert.notEqual(res.status, 0);
  assert.equal(res.stderr.trim().split("\n").length, 1);
});
