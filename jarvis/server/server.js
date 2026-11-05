// Jarvis OS local server. Listens on 127.0.0.1, on the LAN only if the iPhone option is on (phone.js), and takes tailnet traffic only if that is on (tailnet.js).
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createHttpServer } from "node:http";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createChat, redactTokens, scrubSecrets } from "./chat.js";
import { createCityChat, withJarvisBin } from "./city-chat.js";
import { createTranscriber, isWav, parseWake } from "./listen.js";
import { createLiveSession, liveAvailable } from "./live.js";
import { createMailGate, spokenForm } from "./mail-gate.js";
import { createMergeGate, isConfirmPhrase } from "./merge.js";
import { FILLERS, allFillers, fillerLanguage, sentenceSplitter, toolFiller } from "./progress.js";
import { createKeychain } from "./keychain.js";
import { createAppApi } from "./app-api.js";
import { bearer, createTokenCheck } from "./token-check.js";

// The OpenClaw relay's own route and Keychain item (see jarvis/openclaw/README.md).
export const RELAY_PATH = "/api/relay/chat";
export const RELAY_SERVICE = "jarvis.openclaw-relay";
const RELAY_SESSION = "owner"; // the shared conversation, like the HUD, voice and the phone
export const RELAY_AUDIT = "telegram-audit.jsonl";

// The outcome of a merge confirmed from Telegram, as its own audit line: merged (at the PR head SHA the
// gate required), failed (GitHub refused it or the branch moved), or refused (nothing valid was pending,
// e.g. the confirmation window had expired).
export function auditRelayOutcome(dataDir, item, result) {
  const outcome = !item || result == null ? "refused" : result.ok ? "merged" : "failed";
  const entry = {
    ts: new Date().toISOString(), via: "telegram", who: "owner (allowlisted Telegram account)", kind: "merge_outcome", outcome,
    ...(item && { merge: { repo: item.repo, number: item.number, head: item.head } }),
    ...(outcome === "refused" && { reason: "no merge was awaiting confirmation (none requested, or it expired)" }),
    ...(outcome === "failed" && { reason: "GitHub refused the merge or the branch changed after the confirmation" }),
  };
  writeAudit(dataDir, entry);
}

function writeAudit(dataDir, entry) {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dataDir, RELAY_AUDIT), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (err) {
    log(`telegram audit failed: ${err.message}`);
  }
}

// redactTokens (every token pattern, the audit file uses it) lives in chat.js with scrubSecrets; re-exported here.
export { redactTokens };

// What arrived through Telegram, so the owner can see what was approved there: who, when, what.
// Merge confirmations and cancellations name the pull request. Text is scrubbed of secrets and capped.
export function auditRelay(dataDir, message, pending) {
  const text = message.trim();
  const kind = pending && isConfirmPhrase(text) ? "merge_confirm" : pending && /^\s*(cancel|avbryt)[.!]?\s*$/i.test(text) ? "merge_cancel" : "message";
  const entry = { ts: new Date().toISOString(), via: "telegram", who: "owner (allowlisted Telegram account)", kind, ...(pending && kind !== "message" && { merge: { repo: pending.repo, number: pending.number } }), text: redactTokens(scrubSecrets(text)).slice(0, 500) };
  writeAudit(dataDir, entry);
}
import { LOGIN_PAGE, createPhoneAccess, inSubnet, startPhoneListener } from "./phone.js";
import { createStateSource } from "./state.js";
import { isOwner, startTailnetListener } from "./tailnet.js";
import { synthesize } from "./voice.js";

const HUD_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "hud");
const THREE_DIR = dirname(createRequire(import.meta.url).resolve("three")); // three's build/ folder, served as /vendor
const HOST = "127.0.0.1";
const MAX_BODY = 64 * 1024;
const MAX_MESSAGE = 20_000; // About ten minutes of speech.
const MAX_AUDIO_BODY = 3 * 1024 * 1024; // About 60 s of 16 kHz speech, base64 in JSON.
const FIRST_WAIT_MS = 5_000; // Silence this long before "one moment". Quick replies never hear it.
const STILL_WORKING_MS = 12_000;
const MIN_FILLER_GAP_MS = 5_000;
const SESSION_ID = /^[\w-]{1,64}$/;
const voiceBySession = new Map(); // Unprompted messages are spoken if the session's last turn was.
const PHONE_MERGE = "A merge to main can only be confirmed on the Mac, sir. Nothing was merged.";
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
  "/eyes.png": ["eyes.png", "image/png"],
  "/icon-192.png": ["icon-192.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
  "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"],
  "/city.js": ["city.js", "text/javascript; charset=utf-8"],
  "/city-state.js": ["city-state.js", "text/javascript; charset=utf-8"],
  "/vendor/three.module.js": [join(THREE_DIR, "three.module.js"), "text/javascript; charset=utf-8"],
  "/vendor/three.core.js": [join(THREE_DIR, "three.core.js"), "text/javascript; charset=utf-8"],
};
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "media-src data:",
  "img-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

export function log(line) {
  console.log(`${new Date().toISOString()} ${scrubSecrets(line)}`);
}

function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": CSP });
  res.end(body);
}
const sendJson = (res, status, value) => send(res, status, "application/json", JSON.stringify(value));

// Images the owner attaches in chat. Checked by their bytes, not by what the request claims.
const MAX_UPLOAD = 20 * 1024 * 1024; // about 15 MB once decoded from base64
const imageExt = (b) => (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "png" : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? "jpg" : b.subarray(0, 4).toString("latin1") === "GIF8" ? "gif" : b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" ? "webp" : null);
// shortcut: uploads are kept, because a ticket may need them days later; add a clean-up if the folder ever gets big.
async function handleUpload(req, res, dataDir) {
  const body = JSON.parse((await readBody(req, MAX_UPLOAD)) || "{}");
  const data = Buffer.from(typeof body.data === "string" ? body.data : "", "base64");
  const ext = imageExt(data);
  if (!ext) return sendJson(res, 415, { error: "only PNG, JPEG, GIF or WebP images" });
  const dir = join(dataDir, "uploads");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${randomUUID()}.${ext}`);
  writeFileSync(path, data, { mode: 0o600 });
  return sendJson(res, 200, { path });
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// This server can start real work, so a web page open in the same browser must
// not be able to reach it: the Host check stops DNS rebinding, and the Origin,
// Sec-Fetch-Site and JSON checks stop cross-site POSTs.
function allowedRequest(req, hosts, scheme = "http") {
  if (!hosts.includes(req.headers.host?.toLowerCase())) return false;
  if (req.method === "GET" || req.method === "HEAD") return true;
  const { origin } = req.headers;
  if (origin && !hosts.some((h) => origin === `${scheme}://${h}`)) return false;
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  return /^application\/json\b/i.test(req.headers["content-type"] ?? "");
}

async function reply(res, text, voice, speak, gate, sessionId, phone = false) {
  text = scrubSecrets(text);
  const out = { reply: text, confirm: phone ? null : scrubDeep(gate.describe(sessionId)) };
  if (voice === true) {
    try {
      Object.assign(out, await speak(spokenForm(text)));
    } catch (err) {
      log(`voice failed: ${err.message}`);
    }
  }
  return sendJson(res, 200, out);
}

async function handleConfirm(req, res, { gate, speak }) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(res, err.status ?? 400, { error: "bad request" });
  }
  const { sessionId, id, action, voice } = body ?? {};
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId) || typeof id !== "string") return sendJson(res, 400, { error: "bad request" });
  if (action === "cancel") {
    return gate.cancel(sessionId, id) ? reply(res, "Cancelled, sir. Nothing was merged.", voice, speak, gate, sessionId) : sendJson(res, 409, { error: "That confirmation has expired. Nothing was merged." });
  }
  if (action !== "merge") return sendJson(res, 400, { error: "bad action" });
  const result = await gate.confirm(sessionId, id);
  if (!result) return sendJson(res, 409, { error: "That confirmation has expired. Nothing was merged." });
  return reply(res, result.reply, voice, speak, gate, sessionId);
}

async function handleListen(req, res, { transcribe }) {
  let body;
  try {
    body = JSON.parse(await readBody(req, MAX_AUDIO_BODY));
  } catch (err) {
    return sendJson(res, err.status ?? 400, { error: "bad request" });
  }
  const wav = Buffer.from(typeof body?.audio === "string" ? body.audio : "", "base64");
  if (!isWav(wav)) return sendJson(res, 400, { error: "bad audio" });
  try {
    const text = await transcribe(wav);
    return sendJson(res, 200, { text, ...parseWake(text) });
  } catch (err) {
    log(`listen failed: ${err.message}`);
    return sendJson(res, 503, { error: "Speech recognition is not available. Run scripts/setup-voice.sh." });
  }
}

// `parsed` is a body a restricted channel (the OpenClaw relay) has already read and checked.
async function handleChat(req, res, { chat, speak, gate, phone, parsed, mail, channel = phone ? "lan" : "hud" }) {
  let body = parsed;
  try {
    body ??= JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(res, err.status ?? 400, { error: "bad request" });
  }
  const { message, sessionId, voice } = body ?? {};
  if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE) return sendJson(res, 400, { error: "bad message" });
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return sendJson(res, 400, { error: "bad sessionId" });
  if (!parsed) voiceBySession.set(sessionId, voice === true); // A relayed turn must not switch the voice session's audio off.

  // Handled here so the model is never part of the confirmation. The phone route
  // is plain HTTP on a shared network, so it can never confirm a merge to main.
  if (!phone && gate.current(sessionId)) {
    if (isConfirmPhrase(message)) return reply(res, (await gate.confirm(sessionId)).reply, voice, speak, gate, sessionId);
    if (/^\s*(cancel|avbryt)[.!]?\s*$/i.test(message)) {
      gate.cancel(sessionId);
      return reply(res, "Cancelled, sir. Nothing was merged.", voice, speak, gate, sessionId);
    }
  }

  // An email to a business contact is approved only by the owner's own words, matched here.
  const mailTurn = mail?.intercept(message, channel);
  if (mailTurn?.reply) return reply(res, mailTurn.reply, voice, speak, gate, sessionId, phone);

  const started = Date.now();
  const before = gate.current(sessionId)?.id;
  let text;
  try {
    text = await chat(mailTurn?.forward ?? message.trim(), sessionId);
  } catch (err) {
    log(`chat failed: ${err.message}: ${(err.detail ?? "").slice(0, 300)}`);
    return sendJson(res, 502, { error: "Jarvis could not get an answer from Claude. See ~/Library/Logs/jarvis.log." });
  }
  log(`chat ok in ${Date.now() - started} ms`);
  // A new merge request is read out from GitHub's facts, not the model's words.
  const after = gate.current(sessionId)?.id;
  if (after && after !== before) {
    if (phone) gate.cancel(sessionId);
    text = phone ? PHONE_MERGE : gate.prompt(sessionId);
  }
  // The owner hears the server's own summary of a held or approved email, not the model's description of it.
  const mailNote = [mail?.announce(), mailTurn?.note].filter(Boolean).join(" ");
  if (mailNote) text = `${text}\n\n${mailNote}`;
  return reply(res, text, voice, speak, gate, sessionId, phone);
}

const fillerAudio = new Map();
function cachedSpeech(text, speak) {
  if (!fillerAudio.has(text)) fillerAudio.set(text, speak(text).catch(() => { fillerAudio.delete(text); return null; }));
  return fillerAudio.get(text);
}
const pick = (list) => list[Math.floor(Math.random() * list.length)];

// As /api/chat, but one JSON line per event, so speech can start before the reply is done:
// filler (a progress line), sentence (part of the reply), then done or error.
// `parsed` is a body the phone bridge has already read and checked.
async function handleChatStream(req, res, { chat, speak, gate, phone, firstWaitMs = FIRST_WAIT_MS, parsed, mail, channel = phone ? "lan" : "hud" }) {
  let body = parsed;
  try {
    body ??= JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(res, err.status ?? 400, { error: "bad request" });
  }
  const { message, sessionId, voice } = body ?? {};
  if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE) return sendJson(res, 400, { error: "bad message" });
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return sendJson(res, 400, { error: "bad sessionId" });
  if (!parsed) voiceBySession.set(sessionId, voice === true); // The phone speaks for itself: its turns must not switch off the voice session's audio.

  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const cancel = new AbortController();
  res.on("close", () => { if (!res.writableEnded) cancel.abort(); });
  const emit = (event) => { if (!cancel.signal.aborted) res.write(`${JSON.stringify(event)}\n`); };

  // Events go out in order, each with its audio, however long synthesis takes.
  let order = Promise.resolve();
  let spoken = false;
  let lastSaid = Date.now();
  const say = (type, text) => {
    text = scrubSecrets(text);
    lastSaid = Date.now();
    if (type === "sentence") spoken = true;
    order = order.then(async () => {
      if (cancel.signal.aborted) return;
      let audio = null;
      if (voice === true) {
        try {
          audio = await (type === "filler" ? cachedSpeech(text, speak) : speak(spokenForm(text)));
        } catch (err) {
          log(`voice failed: ${err.message}`);
        }
      }
      emit({ type, text, ...audio });
    });
  };
  const finish = async (reply) => {
    await order;
    emit({ type: "done", reply: scrubSecrets(reply), confirm: phone ? null : scrubDeep(gate.describe(sessionId)) });
    res.end();
  };

  if (!phone && gate.current(sessionId)) {
    let direct = null;
    if (isConfirmPhrase(message)) direct = (await gate.confirm(sessionId)).reply;
    else if (/^\s*(cancel|avbryt)[.!]?\s*$/i.test(message)) {
      gate.cancel(sessionId);
      direct = "Cancelled, sir. Nothing was merged.";
    }
    if (direct) {
      say("sentence", direct);
      return finish(direct);
    }
  }

  const mailTurn = mail?.intercept(message, channel);
  if (mailTurn?.reply) {
    say("sentence", mailTurn.reply);
    return finish(mailTurn.reply);
  }

  const lines = FILLERS[fillerLanguage(message)];
  const started = Date.now();
  const before = gate.current(sessionId)?.id;
  const splitter = sentenceSplitter((text) => say("sentence", scrubSecrets(text)));
  const waiting = voice === true ? setTimeout(() => { if (!spoken) say("filler", pick(lines.wait)); }, firstWaitMs) : null;
  const still = voice === true ? setInterval(() => {
    if (Date.now() - lastSaid >= STILL_WORKING_MS) say("filler", pick(lines.still));
  }, 1000) : null;
  const onEvent = (event) => {
    if (event.type === "text") splitter.push(event.text);
    else if (event.type === "flush") splitter.flush();
    else if (event.type === "tool" && voice === true && Date.now() - lastSaid >= MIN_FILLER_GAP_MS) {
      const line = toolFiller(event.name, event.input, lines);
      if (line) say("filler", line);
    }
  };

  let text;
  try {
    text = await chat(mailTurn?.forward ?? message.trim(), sessionId, { onEvent, signal: cancel.signal });
    splitter.flush();
  } catch (err) {
    clearInterval(still);
    clearTimeout(waiting);
    if (err.cancelled || cancel.signal.aborted) {
      log("chat cancelled: the owner started talking");
      return res.end();
    }
    log(`chat failed: ${err.message}: ${(err.detail ?? "").slice(0, 300)}`);
    await order;
    emit({ type: "error", error: "Jarvis could not get an answer from Claude. See ~/Library/Logs/jarvis.log." });
    return res.end();
  }
  clearInterval(still);
  clearTimeout(waiting);
  log(`chat ok in ${Date.now() - started} ms`);
  // A new merge request is read out from GitHub's facts, not the model's words.
  const after = gate.current(sessionId)?.id;
  if (after && after !== before) {
    if (phone) gate.cancel(sessionId);
    text = phone ? PHONE_MERGE : gate.prompt(sessionId);
    say("sentence", text);
  } else if (!spoken && text) say("sentence", text);
  // The owner hears the server's own summary of a held or approved email, not the model's description of it.
  const mailNote = [mail?.announce(), mailTurn?.note].filter(Boolean).join(" ");
  if (mailNote) {
    say("sentence", mailNote);
    text = `${text}\n\n${mailNote}`;
  }
  return finish(text);
}

// Saves the wait the first time each line is needed.
export async function warmFillers(speak) {
  for (const line of allFillers()) await cachedSpeech(line, speak);
}

// The page's connection offer goes to OpenAI from here, so the key stays on this Mac.
async function handleLiveSession(req, res, { startLive }) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(res, err.status ?? 400, { error: "bad request" });
  }
  if (typeof body?.sdp !== "string" || !body.sdp.trim()) return sendJson(res, 400, { error: "bad offer" });
  if (!liveAvailable()) return sendJson(res, 503, { error: "OPENAI_API_KEY is not set on the Mac." });
  try {
    const sdp = await startLive(body.sdp);
    log("live voice session started");
    return sendJson(res, 200, { sdp });
  } catch (err) {
    log(`live session failed: ${err.message}`);
    return sendJson(res, 502, { error: "The voice service could not start a session." });
  }
}

async function handleLogin(req, res, access) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(res, err.status ?? 400, { error: "bad request" });
  }
  const result = access.login(body?.passcode);
  if (result.ok) {
    log("iPhone signed in");
    res.setHeader("Set-Cookie", result.cookie);
    return sendJson(res, 200, { ok: true });
  }
  log("iPhone passcode refused");
  if (result.retryInMs) return sendJson(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(result.retryInMs / 60_000)} min.` });
  return sendJson(res, 401, { error: "Wrong passcode." });
}

// What the city says unprompted (questions, results) reaches every open HUD as server-sent events,
// and so does everything that moves in the city (hires, tickets, questions, reviews, cost) for the City View.
// Agents write free text (goals, summaries, questions) and the HUD shows it, so every string leaving for the HUD is scrubbed here.
// Free text gets every token pattern, including "long random string". Fields that are identifiers or links
// (a merge confirmation's UUID, repo, url, commit) look random by design and must reach the HUD intact, so they
// only get the specific patterns.
const IDENTIFIER_KEY = /^(id|url|repo|head|sessionId|.*_id|.*Id|.*_at|.*_path)$/;
export function scrubDeep(value, key = "") {
  if (typeof value === "string") return IDENTIFIER_KEY.test(key) ? scrubSecrets(value) : redactTokens(scrubSecrets(value));
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, k)]));
  return value;
}

function createEventStream(talk, speak, mail) {
  const clients = new Set();
  const listeners = new Set(); // The phone bridge: Jarvis's words only, no audio, no city events.
  talk.city?.on((event) => {
    if (event.type === "log") return;
    for (const res of clients) res.write(`data: ${JSON.stringify({ type: "city", event: scrubDeep(event) })}\n\n`);
  });
  talk.on?.(async ({ sessionId, text }) => {
    const event = { type: "jarvis", sessionId, text: scrubSecrets(text ?? "") };
    // An unprompted turn may have held an email: the owner hears the server's summary of it too,
    // even when the turn itself said nothing.
    const mailNote = mail?.announce();
    if (mailNote) event.text = scrubSecrets(event.text ? `${event.text}\n\n${mailNote}` : mailNote);
    if (!event.text) return;
    for (const fn of listeners) fn({ sessionId, text: event.text });
    if (voiceBySession.get(sessionId)) {
      try {
        Object.assign(event, await speak(spokenForm(event.text)));
      } catch (err) {
        log(`voice failed: ${err.message}`);
      }
    }
    for (const res of clients) res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  const handler = (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no" });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
  };
  handler.subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  return handler;
}

let integrationsCache = null;
const AUTOMATIONS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "automations.json");
const portOpen = (port) => new Promise((resolve) => {
  const s = createConnection({ host: "127.0.0.1", port, timeout: 1000 });
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => resolve(false));
  s.once("timeout", () => { s.destroy(); resolve(false); });
});

// The City View's data: a snapshot to start from, an agent's last actions, and the two ways the owner
// talks back through the bus (an @mention direct instruction, an answer to a question).
// The phone keeps what it had: the view, answering questions and direct instructions. Running the organization needs a trusted listener.
const PHONE_CITY = new Set(["/api/city", "/api/city/agent", "/api/city/audit", "/api/city/instruct", "/api/city/answer"]);
export async function handleCity(req, res, city, path, phone = false) {
  if (!city) return sendJson(res, 404, { error: "the city backend is not running" });
  if (phone && !PHONE_CITY.has(path)) return sendJson(res, 403, { error: "not available from the phone" });
  if (req.method === "GET" && path === "/api/city") return sendJson(res, 200, scrubDeep(city.snapshot()));
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET") {
    const { departmentReport, health, loadIntegrations, probeIntegrations, workforce } = await import("city");
    if (path === "/api/city/agent") {
      const id = url.searchParams.get("id") ?? "";
      if (!/^[\w-]{1,64}$/.test(id) || !city.ledger.getAgent(id)) return sendJson(res, 404, { error: "no such agent" });
      return sendJson(res, 200, scrubDeep(city.agentStatus(id)));
    }
    if (path === "/api/city/costs") return sendJson(res, 200, city.ledger.costReport());
    if (path === "/api/city/workforce") return sendJson(res, 200, scrubDeep(workforce(city.ledger)));
    if (path === "/api/city/report") {
      const days = Number(url.searchParams.get("days") ?? 7);
      return days > 0 && days <= 365 ? sendJson(res, 200, scrubDeep(departmentReport(city.ledger, { days }))) : sendJson(res, 400, { error: "bad days" });
    }
    if (path === "/api/city/health") return sendJson(res, 200, health(city.ledger, city.gate));
    if (path === "/api/city/departments") return sendJson(res, 200, scrubDeep(city.ledger.departments().filter((d) => d.state !== "deleted")));
    if (path === "/api/city/skills") return sendJson(res, 200, city.listSkills().map(({ name, description, version }) => ({ name, description, version })));
    if (path === "/api/city/workflows") return sendJson(res, 200, city.workflows());
    if (path === "/api/city/memory") {
      const q = url.searchParams.get("q") ?? "", dept = url.searchParams.get("department") ?? undefined;
      return sendJson(res, 200, city.memory.recall(q.slice(0, 200), { agent: "owner", department: dept, isJarvis: true }, 10).map((m) => ({ ...m, text: scrubSecrets(m.text) })));
    }
    if (path === "/api/city/trace") {
      const id = url.searchParams.get("ticket") ?? "";
      if (!/^[\w-]{1,64}$/.test(id)) return sendJson(res, 400, { error: "bad ticket" });
      return sendJson(res, 200, scrubDeep(city.trace(id)));
    }
    if (path === "/api/city/integrations") {
      // Real probes, at most every five minutes.
      if (!integrationsCache || Date.now() - integrationsCache.at > 300_000) integrationsCache = { at: Date.now(), states: await probeIntegrations(loadIntegrations(), undefined, portOpen) };
      return sendJson(res, 200, { checked_at: new Date(integrationsCache.at).toISOString(), integrations: integrationsCache.states });
    }
  }
  if (req.method === "GET" && path === "/api/city/audit") {
    const agent = new URL(req.url, "http://localhost").searchParams.get("agent") ?? "";
    return /^[a-z][a-z0-9-]{0,40}$/.test(agent) ? sendJson(res, 200, city.auditTail(agent)) : sendJson(res, 400, { error: "bad agent" });
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(res, err.status ?? 400, { error: "bad request" });
  }
  try {
    if (path === "/api/city/instruct") {
      if (typeof body?.text !== "string" || body.text.length > MAX_MESSAGE) return sendJson(res, 400, { error: "bad text" });
      const ticket = city.instruct(body.text);
      return ticket ? sendJson(res, 200, { ticket }) : sendJson(res, 400, { error: "start with @agent-id" });
    }
    if (path === "/api/city/departments") {
      if (body?.key) return sendJson(res, 200, { department: city.updateDepartment(body) });
      return sendJson(res, 200, city.createDepartment(body));
    }
    if (path === "/api/city/tickets/resume") return sendJson(res, 200, city.resumeParked(Array.isArray(body?.ids) ? body.ids : undefined));
    if (path === "/api/city/tickets/cancel") {
      if (!Array.isArray(body?.ids)) return sendJson(res, 400, { error: "ids needed" });
      return sendJson(res, 200, { cancelled: body.ids.flatMap((id) => city.cancelTicket(String(id)).cancelled) });
    }
    if (path === "/api/city/workflows/start") return sendJson(res, 200, city.startWorkflow(String(body?.name), body?.inputs ?? {}, body?.project));
    if (path === "/api/city/events") {
      const { routes = [] } = JSON.parse(await readFile(AUTOMATIONS_PATH, "utf8"));
      return sendJson(res, 200, city.ingestEvent(body, routes));
    }
    if (path === "/api/city/answer") {
      if (typeof body?.id !== "string" || typeof body?.text !== "string" || !body.text.trim() || body.text.length > MAX_MESSAGE) return sendJson(res, 400, { error: "bad answer" });
      // Plain HTTP and a passcode are not enough to approve an action, as with merges.
      if (phone && city.ledger.approvalByQuestion?.(body.id)) return sendJson(res, 403, { error: "approvals need the Mac" });
      return sendJson(res, 200, { ticket: city.answer(body.id, body.text.trim()) });
    }
  } catch (err) {
    return sendJson(res, 400, { error: scrubSecrets(err.message) });
  }
  return sendJson(res, 404, { error: "not found" });
}

export function createServer({ booqyDir, dataDir, port, getState, chat, speak = synthesize, transcribe, gate, firstWaitMs, startLive = createLiveSession, keychain = createKeychain(), mailGateOptions = {} }) {
  const state = getState ?? createStateSource({ booqyDir, logger: log });
  const mergeGate = gate ?? createMergeGate({ dataDir, logger: log });
  const talk = chat ?? createChat({ booqyDir, dataDir, gate: mergeGate, logger: log });
  const hear = transcribe ?? createTranscriber({ dataDir });
  const access = createPhoneAccess({ dataDir });
  const mailGate = createMailGate({ dataDir, keychain, logger: log, ...mailGateOptions });
  const events = createEventStream(talk, speak, mailGate);
  const appApi = createAppApi({
    keychain,
    events,
    // No merge confirmation from the phone, and the phone speaks, so no audio.
    chatStream: (req, res, parsed) => handleChatStream(req, res, { chat: talk, speak, gate: mergeGate, phone: true, firstWaitMs, parsed, mail: mailGate, channel: "app" }),
    logger: log,
  });
  const relayToken = createTokenCheck({ keychain, service: RELAY_SERVICE, logger: log });
  // The merge gate as the relay sees it: the same gate, but every confirmation's outcome is audited too.
  const relayGate = {
    ...mergeGate,
    async confirm(sessionId, id) {
      const item = mergeGate.current(sessionId);
      const result = await mergeGate.confirm(sessionId, id);
      auditRelayOutcome(dataDir, item, result);
      return result;
    },
  };

  // The OpenClaw relay: Telegram direct messages from the owner's own allowlisted account only (the
  // allowlist is enforced by OpenClaw, see jarvis/openclaw/openclaw.json). By the owner's decision it has
  // the HUD's rights, including confirming a merge to main. Localhost listener only, and only with the
  // relay token, so no other local program can pass as the relay. Every relayed turn is audited.
  async function handleRelay(req, res) {
    if (!(await relayToken(bearer(req)))) return sendJson(res, 401, { error: "relay not authorised" });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      return sendJson(res, err.status ?? 400, { error: "bad request" });
    }
    const message = body?.message;
    if (typeof message === "string" && message.trim() && message.length <= MAX_MESSAGE) auditRelay(dataDir, message, mergeGate.current(RELAY_SESSION));
    return handleChat(req, res, { chat: talk, speak, gate: relayGate, phone: false, mail: mailGate, channel: "telegram", parsed: { message, sessionId: RELAY_SESSION, voice: false } });
  }

  async function route(req, res, phone) {
    const path = new URL(req.url, "http://localhost").pathname;
    if (req.method === "POST" && path === "/api/chat") return await handleChat(req, res, { chat: talk, speak, gate: mergeGate, phone, mail: mailGate });
    if (req.method === "POST" && path === "/api/chat/stream") return await handleChatStream(req, res, { chat: talk, speak, gate: mergeGate, phone, firstWaitMs, mail: mailGate });
    // The LAN route is plain HTTP without a microphone, so live voice is not offered there.
    if (req.method === "POST" && path === "/api/live/session") return phone ? sendJson(res, 403, { error: "forbidden" }) : await handleLiveSession(req, res, { startLive });
    if (req.method === "POST" && path === "/api/upload") return await handleUpload(req, res, dataDir);
    if (req.method === "POST" && path === "/api/warm") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (typeof body.sessionId === "string" && SESSION_ID.test(body.sessionId)) talk.warmUp?.(body.sessionId);
      return sendJson(res, 200, {});
    }
    if (req.method === "GET" && path === "/api/live/status") return sendJson(res, 200, { available: !phone && liveAvailable() });
    if (req.method === "GET" && path === "/api/events") return events(req, res);
    if (path.startsWith("/api/city")) return await handleCity(req, res, talk.city, path, phone);
    // Read-only: what is waiting for this session, so another tab or Telegram-started merge shows up. Confirming is still POST /api/confirm only.
    if (req.method === "GET" && path === "/api/confirm/pending") {
      const sessionId = new URL(req.url, "http://localhost").searchParams.get("sessionId");
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return sendJson(res, 400, { error: "bad sessionId" });
      return sendJson(res, 200, scrubDeep({ confirm: phone ? null : mergeGate.describe(sessionId) }));
    }
    if (req.method === "POST" && path === "/api/confirm") return await handleConfirm(req, res, { gate: mergeGate, speak });
    if (req.method === "POST" && path === "/api/listen") return await handleListen(req, res, { transcribe: hear });
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
    if (path === "/state.json") {
      try {
        return sendJson(res, 200, await state());
      } catch (err) {
        log(`state failed: ${err.message}`);
        return sendJson(res, 503, { error: "state unavailable" });
      }
    }
    const entry = STATIC[path];
    if (!entry) return sendJson(res, 404, { error: "not found" });
    return send(res, 200, entry[1], await readFile(entry[0].startsWith("/") ? entry[0] : join(HUD_DIR, entry[0])));
  }

  function fail(res, err) {
    log(`request failed: ${err.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: "server error" });
    else res.end();
  }

  const server = createHttpServer(async (req, res) => {
    try {
      const localPort = server.address().port ?? port;
      if (!allowedRequest(req, [`localhost:${localPort}`, `127.0.0.1:${localPort}`])) return sendJson(res, 403, { error: "forbidden" });
      if (req.method === "POST" && new URL(req.url, "http://localhost").pathname === RELAY_PATH) return await handleRelay(req, res);
      // jarvis-mail's approval endpoints exist on this listener only, never on the tailnet or the LAN.
      if (new URL(req.url, "http://localhost").pathname.startsWith("/api/mail/")) return await mailGate.handle(req, res);
      return await route(req, res, false);
    } catch (err) {
      fail(res, err);
    }
  });

  // Everything from `tailscale serve` passes here: HTTPS, and the owner's login only.
  // Same rights as the Mac, so a merge can be confirmed while the owner is away.
  server.handleTailnet = async (req, res, config) => {
    try {
      if (!allowedRequest(req, [config.host, `${config.host}:443`], "https") || !isOwner(req, config)) return sendJson(res, 403, { error: "forbidden" });
      // The app API has its own Bearer token on top of the owner check. It exists on this listener only.
      if (appApi.isAppPath(new URL(req.url, "http://localhost").pathname)) return await appApi.handle(req, res);
      return await route(req, res, false);
    } catch (err) {
      fail(res, err);
    }
  };

  // Everything on the LAN listener passes here. It never trusts the localhost route.
  server.handlePhone = async (req, res, net) => {
    try {
      if (!inSubnet(req.socket.remoteAddress, net)) return sendJson(res, 403, { error: "forbidden" });
      const { localPort } = req.socket;
      if (!allowedRequest(req, [`${net.host}:${localPort}`])) return sendJson(res, 403, { error: "forbidden" });
      const path = new URL(req.url, "http://localhost").pathname;
      if (req.method === "POST" && path === "/login") return await handleLogin(req, res, access);
      if (!access.authed(req.headers.cookie)) {
        if ((req.method === "GET" || req.method === "HEAD") && path === "/") return send(res, 200, "text/html; charset=utf-8", LOGIN_PAGE);
        return sendJson(res, 401, { error: "Passcode needed. Reload the page." });
      }
      if (req.method === "POST" && path === "/api/confirm") return sendJson(res, 403, { error: PHONE_MERGE });
      if (req.method === "POST" && path === "/api/listen") return sendJson(res, 403, { error: "Use the dictation key on the keyboard." });
      return await route(req, res, true);
    } catch (err) {
      fail(res, err);
    }
  };
  server.mailGate = mailGate;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.JARVIS_PORT ?? 7777);
  const booqyDir = process.env.JARVIS_BOOQY_DIR ?? join(homedir(), "projects/it-hjalparna/booqy");
  const dataDir = process.env.JARVIS_DATA_DIR ?? join(homedir(), "Library/Application Support/Jarvis");
  // JARVIS_BACKEND=booqy keeps the old headless Claude in the Booqy folder; the default is the city.
  const chat = process.env.JARVIS_BACKEND === "booqy" ? undefined : await cityChat(dataDir);
  const server = createServer({ booqyDir, dataDir, port, chat });
  server.requestTimeout = 0;
  server.listen(port, HOST, () => {
    log(`listening on http://${HOST}:${port}`);
    warmFillers(synthesize).catch((err) => log(`warming voice lines failed: ${err.message}`));
  });
  startPhoneListener({ dataDir, port, handler: server.handlePhone, logger: log });
  startTailnetListener({ dataDir, handler: server.handleTailnet, logger: log });
  if (process.env.JARVIS_BACKEND === "booqy") for (const missing of ["ORCHESTRATOR_FIRE_URL", "ORCHESTRATOR_TOKEN"].filter((n) => !process.env[n])) log(`${missing} is not set: relaying to the Orchestrator will fail`);
  // Open event streams never end by themselves, so close them too: otherwise a restart hangs on any open HUD.
  for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { server.close(() => process.exit(0)); server.closeAllConnections(); });
}

// The city runs inside this process: Jarvis's session, the core agents and the ledger at ~/.jarvis.
// shortcut: one process at a time owns the ledger (this server or the CLI), two would both resume the same tickets; add a lock when both must run.
async function cityChat(dataDir) {
  const { OPENCLAW_BIN, assertNoApiKey, createCity, createImprover, createOpenClawRunner, createRunner, createWarmRunner, loadPolicy, sdkEnv } = await import("city");
  assertNoApiKey();
  const policy = loadPolicy();
  const env = await sdkEnv(withJarvisBin(process.env));
  const runner = createRunner({ policy, env });
  const home = process.env.JARVIS_HOME ?? join(homedir(), ".jarvis");
  const openclawRunner = existsSync(OPENCLAW_BIN) ? createOpenClawRunner({ policy, env, dataDir: home }) : undefined;
  const city = createCity({ runner, openclawRunner, policy, log });
  // JARVIS_WARM_CLAUDE=off goes back to one process per turn, as in chat.js.
  const warm = process.env.JARVIS_WARM_CLAUDE === "off" ? undefined : createWarmRunner({ policy, env });
  const chat = createCityChat({ city, runner, warm, dataDir, logger: log });
  chat.warmUp();
  const [repo] = JSON.parse(await readFile(AUTOMATIONS_PATH, "utf8")).github_repos ?? [];
  if (repo) createImprover({ city, repo, log });
  city.resume().catch((err) => log(`resume failed: ${err.message}`));
  return chat;
}
