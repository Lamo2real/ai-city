#!/usr/bin/env node
// jarvis "<prompt>": talk to Jarvis from the terminal. Same Jarvis, same city as the HUD.
// Streams the reply, then stays for questions and results while the city works; type answers on stdin.
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { assertNoApiKey, createCity, createRunner, loadPolicy, sdkEnv } from "city";
import { createCityChat } from "../server/city-chat.js";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error('usage: jarvis "<prompt>"');
  process.exit(2);
}
assertNoApiKey();
const verbose = process.env.JARVIS_VERBOSE === "1";
const log = (line) => { if (verbose) console.error(`  · ${line}`); };
const dataDir = process.env.JARVIS_DATA_DIR ?? join(homedir(), "Library/Application Support/Jarvis");
const policy = loadPolicy();
const env = await sdkEnv();
const runner = createRunner({ policy, env });
const city = createCity({ runner, policy, log });
const chat = createCityChat({ city, runner, dataDir, logger: log });
const SESSION = "owner"; // the same conversation as the HUD and the voice pipeline

chat.on(({ text }) => process.stdout.write(`\nJarvis: ${text}\n`));

async function say(text) {
  let shown = false;
  process.stdout.write("Jarvis: ");
  const reply = await chat(text, SESSION, { onEvent: (e) => { if (e.type === "text") { shown = true; process.stdout.write(e.text); } } });
  if (!shown) process.stdout.write(reply);
  process.stdout.write("\n");
}

await city.resume();
await say(prompt);
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => { if (line.trim()) say(line.trim()).catch((err) => console.error(err.message)); });

// Stay while the city has work from this conversation; leave once it is all reported and told.
while (city.openTickets().length) {
  await new Promise((r) => setTimeout(r, 1000));
  await city.idle();
}
await city.idle();
await chat.idle();
rl.close();
city.close();
process.exit(0);
