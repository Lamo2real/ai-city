// The Claude that stays running between messages, against a fake claude on PATH.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { claudeArgs, createChat } from "../server/chat.js";

const dir = mkdtempSync(join(tmpdir(), "jarvis-warm-"));
const starts = join(dir, "starts.log");
const originalPath = process.env.PATH;
const count = () => { try { return readFileSync(starts, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };

before(() => {
  // Answers each stdin line in stream-json mode; plain mode answers once, as before.
  writeFileSync(join(dir, "claude"), `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(starts)}, process.argv.includes("--input-format") ? "warm\\n" : "cold\\n");
const say = (t) => { console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } })); console.log(JSON.stringify({ type: "result", is_error: false, result: t, session_id: "11111111-1111-4111-8111-111111111111" })); };
if (!process.argv.includes("--input-format")) { let d = ""; process.stdin.on("data", (c) => { d += c; }); process.stdin.on("end", () => say("cold reply")); }
else { let held = ""; process.stdin.on("data", (c) => { held += c; const ls = held.split("\\n"); held = ls.pop(); for (const l of ls) { if (!l.trim()) continue; const text = JSON.parse(l).message.content; if (text.includes("hang")) continue; if (text.includes("die")) process.exit(1); say("warm reply"); } }); }
`);
  chmodSync(join(dir, "claude"), 0o755);
  process.env.PATH = `${dir}:${originalPath}`;
});
after(() => { process.env.PATH = originalPath; });

const newChat = (name) => createChat({ booqyDir: dir, dataDir: mkdtempSync(join(dir, name)), logger: () => {} });

test("the flag is only used for the running process", () => {
  assert.ok(claudeArgs(null, true).includes("--input-format"));
  assert.ok(!claudeArgs(null).includes("--input-format"));
});

test("after warming up, messages use one running Claude and stream", async () => {
  writeFileSync(starts, "");
  const chat = newChat("a");
  chat.warmUp("s");
  const events = [];
  assert.equal(await chat("hello", "s", { onEvent: (e) => events.push(e) }), "warm reply");
  assert.equal(await chat("again", "s"), "warm reply");
  assert.equal(count(), 1, "no new process per message");
  assert.equal(events[0].text, "warm reply");
  await chat("die", "s").catch(() => {});
});

test("if the running Claude dies, the message still gets an answer", async () => {
  const chat = newChat("b");
  chat.warmUp("s");
  assert.equal(await chat("die", "s"), "cold reply");
  await chat("die", "s").catch(() => {});
});

test("cancelling stops it, and the next message works", async () => {
  const chat = newChat("c");
  chat.warmUp("s");
  const ctrl = new AbortController();
  const hung = chat("hang", "s", { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 50);
  await assert.rejects(hung, (e) => e.cancelled === true);
  assert.equal(await chat("hello", "s"), "warm reply");
  await chat("die", "s").catch(() => {});
});
