// The phone bridge: a small token-authenticated API for the Jarvis iPhone app, served only on the
// tailnet listener (after Tailscale's owner check). The phone talks to Jarvis's normal conversation,
// the same session as voice and the HUD, so there is one interface to the city.
// `node server/app-api.js pair | unpair` manages the pairing token.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKeychain } from "./keychain.js";
import { readConfig } from "./tailnet.js";

export const PREFIX = "/api/app/v1";
export const PAIRING_SERVICE = "jarvis.phone-pairing";
export const SESSION = "owner";
const MAX_MESSAGE = 20_000;
const MAX_BODY = 96 * 1024; // MAX_MESSAGE characters at up to 4 bytes, plus JSON.
const REREAD_MS = 10_000;
const FAILS_BEFORE_LOCK = 5;
const LOCK_BASE_MS = 30_000;
const LOCK_MAX_MS = 3_600_000;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const KEEPALIVE_MS = 25_000;
const QR_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../scripts/qr.swift");

const sha = (s) => createHash("sha256").update(s).digest();
const bearer = (req) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(JSON.stringify(value));
}
const tooMany = (res, seconds, error) => sendJson(res, 429, { error }, { "Retry-After": String(Math.max(1, Math.ceil(seconds))) });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// chatStream(req, res, { message, sessionId, voice }) runs the normal streaming chat with phone=true.
// events.subscribe(fn) calls fn({ sessionId, text }) for Jarvis's unprompted replies and returns an unsubscribe.
export function createAppApi({ keychain, chatStream, events, now = Date.now, logger = () => {}, keepaliveMs = KEEPALIVE_MS }) {
  let pairedHash = null;
  let readAt = -Infinity;
  let failures = 0;
  let lockouts = 0;
  let lockedUntil = 0;
  let hits = [];
  let chatBusy = false;

  async function loadPairing() {
    readAt = now();
    try {
      const token = await keychain.get(PAIRING_SERVICE);
      pairedHash = token ? sha(token) : null;
    } catch {
      pairedHash = null;
      logger("phone pairing could not be read from Keychain");
    }
  }
  const matches = (hash) => pairedHash !== null && timingSafeEqual(hash, pairedHash);

  // A token that doesn't match triggers a re-read at most every 10 s, so re-pairing needs no restart.
  async function authorized(token) {
    if (!token) return null;
    const hash = sha(token);
    if (readAt === -Infinity) await loadPairing();
    if (matches(hash)) return hash;
    if (now() - readAt >= REREAD_MS) {
      await loadPairing();
      if (matches(hash)) return hash;
    }
    return null;
  }

  function registerFailure() {
    if (++failures < FAILS_BEFORE_LOCK) return;
    failures = 0;
    lockedUntil = now() + Math.min(LOCK_BASE_MS * 2 ** lockouts, LOCK_MAX_MS);
    lockouts++;
    logger("phone pairing locked after repeated wrong tokens");
  }

  function rateWait(key) {
    const t = now();
    hits = hits.filter((h) => t - h.at < RATE_WINDOW_MS);
    const mine = hits.filter((h) => h.key === key);
    if (mine.length >= RATE_LIMIT) return (mine[0].at + RATE_WINDOW_MS - t) / 1000;
    hits.push({ at: t, key });
    return 0;
  }

  async function chat(req, res) {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      return sendJson(res, err.status ?? 400, { error: "bad request" });
    }
    const message = body?.message;
    if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE) return sendJson(res, 400, { error: "bad message" });
    if (chatBusy) return tooMany(res, 2, "a chat is already running");
    chatBusy = true;
    try {
      await chatStream(req, res, { message, sessionId: SESSION, voice: false });
    } finally {
      chatBusy = false;
    }
  }

  function eventStream(req, res) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no" });
    res.write(": connected\n\n");
    const off = events.subscribe(({ sessionId, text }) => {
      if (sessionId === SESSION && typeof text === "string") res.write(`data: ${JSON.stringify({ type: "jarvis", text })}\n\n`);
    });
    const timer = setInterval(() => res.write(": keepalive\n\n"), keepaliveMs);
    timer.unref();
    req.on("close", () => {
      clearInterval(timer);
      off();
    });
  }

  async function handle(req, res) {
    const path = new URL(req.url, "http://localhost").pathname;
    if (now() < lockedUntil) return tooMany(res, (lockedUntil - now()) / 1000, "too many wrong tokens");
    const token = bearer(req);
    const hash = await authorized(token);
    if (!hash) {
      // Only a wrong token counts towards the lock. A request with none (the owner's browser,
      // a prefetch) must not lock the paired phone out.
      if (token) registerFailure();
      return sendJson(res, 401, { error: "not paired" });
    }
    failures = 0;
    lockouts = 0;
    const wait = rateWait(hash.toString("hex"));
    if (wait) return tooMany(res, wait, "slow down");
    const route = { [`${PREFIX}/health`]: ["GET", () => sendJson(res, 200, { ok: true, name: "Jarvis" })], [`${PREFIX}/chat`]: ["POST", () => chat(req, res)], [`${PREFIX}/events`]: ["GET", () => eventStream(req, res)] }[path];
    if (!route) return sendJson(res, 404, { error: "not found" });
    if (req.method !== route[0]) return sendJson(res, 405, { error: "method not allowed" });
    return route[1]();
  }

  return { handle, isAppPath: (path) => path === PREFIX || path.startsWith(`${PREFIX}/`) };
}

// ---- Pairing ----

// The payload goes to the QR renderer on stdin, never as an argument.
export function renderQr(payload, { spawnFn = spawn, script = QR_SCRIPT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn("swift", [script], { stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`QR renderer exited with ${code}`))));
    child.stdin.end(payload);
  });
}

export async function pair({ dataDir, keychain = createKeychain(), render = renderQr, out = console.log }) {
  const config = readConfig(dataDir);
  if (!config) throw new Error("Run scripts/enable-tailscale.sh first.");
  const token = randomBytes(32).toString("base64url");
  await keychain.set(PAIRING_SERVICE, token); // Replaces any old token: that is the rotation.
  const payload = `jarvis-pair://v1?host=${encodeURIComponent(config.host)}&token=${token}`;
  await render(payload).catch((err) => out(`Could not draw the QR code (${err.message}). Use the text below.`));
  out("Pairing text, for pasting into the app. It is shown only now and is not saved anywhere else:");
  out(payload);
  return payload;
}

export async function unpair({ keychain = createKeychain(), out = console.log } = {}) {
  await keychain.remove(PAIRING_SERVICE);
  out("The iPhone app is unpaired.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.JARVIS_DATA_DIR ?? join(homedir(), "Library/Application Support/Jarvis");
  const command = process.argv[2];
  try {
    if (command === "pair") await pair({ dataDir });
    else if (command === "unpair") await unpair();
    else throw new Error("usage: app-api.js pair | unpair");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
