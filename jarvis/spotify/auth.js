// Spotify sign-in (Authorization Code + PKCE, no client secret) and the Keychain token store.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { CODES, SpotifyError } from "./errors.js";
import { addSecret, redact } from "./redact.js";
import { KEYCHAIN, REDIRECT_PORT, SCOPES } from "./scopes.js";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const CLIENT_ID_RE = /^[0-9a-f]{32}$/i;
const REFRESH_MARGIN_MS = 60_000;
const REVOKED = "Spotify access expired or was revoked. Run sign-in again.";

// ---- Keychain ----

function runSecurity(args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile("/usr/bin/security", args, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// security -i reads commands from stdin: double quotes, backslash escapes.
function quote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error("Keychain value must not contain control characters.");
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

export function createKeychain({ run = runSecurity } = {}) {
  const account = KEYCHAIN.account;
  return {
    async get(service) {
      const r = await run(["find-generic-password", "-a", account, "-s", service, "-w"]);
      if (r.code === 44 || /could not be found/i.test(r.stderr || "")) return null;
      if (r.code !== 0) throw new Error(`Keychain read failed for ${service} (exit ${r.code}).`);
      return r.stdout.replace(/\n$/, "");
    },
    async set(service, value) {
      const line = `add-generic-password -U -a ${account} -s ${service} -w ${quote(value)}\n`;
      const r = await run(["-i"], { input: line });
      if (r.code !== 0 || /security:|error/i.test(r.stderr || "")) throw new Error(`Keychain write failed for ${service} (exit ${r.code}).`);
    },
    async remove(service) {
      const r = await run(["delete-generic-password", "-a", account, "-s", service]);
      if (r.code !== 0 && r.code !== 44) throw new Error(`Keychain delete failed for ${service} (exit ${r.code}).`);
    },
  };
}

// ---- Token store ----

const form = (obj) => new URLSearchParams(obj).toString();

async function postToken(fetch, body) {
  return fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form(body) });
}

export function createTokenStore({ keychain, fetch = globalThis.fetch, now = Date.now }) {
  let inflight = null;

  async function getClientId() {
    const id = await keychain.get(KEYCHAIN.clientId);
    if (!id) throw new SpotifyError(CODES.NOT_CONFIGURED, "Spotify is not set up. Run setup to add the Client ID.");
    addSecret(id);
    return id;
  }

  async function setClientId(id) {
    const v = String(id ?? "").trim();
    if (!CLIENT_ID_RE.test(v)) throw new Error("A Spotify Client ID is 32 hexadecimal characters.");
    addSecret(v);
    await keychain.set(KEYCHAIN.clientId, v);
  }

  async function load() {
    const raw = await keychain.get(KEYCHAIN.tokens);
    if (!raw) return null;
    try {
      const t = JSON.parse(raw);
      addSecret(t.access_token);
      addSecret(t.refresh_token);
      return t;
    } catch {
      return null;
    }
  }

  async function saveTokens(res) {
    const prev = await load();
    const tokens = {
      access_token: res.access_token,
      refresh_token: res.refresh_token || prev?.refresh_token,
      expires_at: now() + (Number(res.expires_in) || 3600) * 1000,
      scope: res.scope ?? prev?.scope ?? "",
    };
    addSecret(tokens.access_token);
    addSecret(tokens.refresh_token);
    await keychain.set(KEYCHAIN.tokens, JSON.stringify(tokens));
    return tokens;
  }

  async function doRefresh() {
    const tokens = await load();
    if (!tokens?.refresh_token) throw new SpotifyError(CODES.SIGN_IN_REQUIRED, "Not signed in to Spotify. Run sign-in.");
    const clientId = await getClientId();
    const res = await postToken(fetch, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    if (res.status === 429) {
      const retryAfter = Number(res.headers?.get?.("retry-after")) || undefined;
      throw new SpotifyError(CODES.RATE_LIMITED, "Spotify is rate limiting sign-in refresh. Try again shortly.", { status: 429, retryAfter });
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || (res.status === 400 && body.error === "invalid_grant")) {
      await keychain.remove(KEYCHAIN.tokens);
      throw new SpotifyError(CODES.SIGN_IN_REQUIRED, REVOKED, { status: res.status });
    }
    if (!res.ok) throw new SpotifyError(CODES.API, `Spotify token refresh failed (${res.status}).`, { status: res.status });
    return (await saveTokens(body)).access_token;
  }

  function refresh() {
    inflight ??= doRefresh().finally(() => { inflight = null; });
    return inflight;
  }

  async function getAccessToken() {
    const tokens = await load();
    if (!tokens?.access_token) throw new SpotifyError(CODES.SIGN_IN_REQUIRED, "Not signed in to Spotify. Run sign-in.");
    if (tokens.expires_at - now() >= REFRESH_MARGIN_MS) return tokens.access_token;
    try {
      return await refresh();
    } catch (err) {
      // Rate limited while the current token still works: keep using it, refresh next time.
      if (err?.code === CODES.RATE_LIMITED && tokens.expires_at > now()) return tokens.access_token;
      throw err;
    }
  }

  async function status() {
    const [id, tokens] = [await keychain.get(KEYCHAIN.clientId), await load()];
    return {
      configured: Boolean(id),
      signedIn: Boolean(tokens?.access_token),
      scopes: tokens?.scope ? tokens.scope.split(" ").filter(Boolean) : [],
      expiresAt: tokens?.expires_at ?? null,
    };
  }

  async function clear() {
    await keychain.remove(KEYCHAIN.tokens);
  }

  return { getClientId, setClientId, getAccessToken, refresh, saveTokens, status, clear };
}

// ---- Sign-in ----

export const base64url = (buf) => Buffer.from(buf).toString("base64url");
export const challengeFor = (verifier) => base64url(createHash("sha256").update(verifier).digest());

const defaultOpenUrl = (url) => new Promise((resolve, reject) => {
  execFile("open", [url], (err) => (err ? reject(err) : resolve()));
});

const PAGE = (msg) => `<!doctype html><meta charset="utf-8"><title>Jarvis</title><body style="font-family:system-ui;padding:3rem"><p>${msg}</p>`;

export function signIn({ store, fetch = globalThis.fetch, openUrl = defaultOpenUrl, port = REDIRECT_PORT, timeoutMs = 300_000, log = console.error }) {
  return new Promise((resolve, reject) => {
    const verifier = base64url(randomBytes(48)); // 64 chars
    const state = base64url(randomBytes(16));
    addSecret(verifier);
    let settled = false;
    let timer;
    const server = createServer();

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      setImmediate(() => server.closeAllConnections());
      err ? reject(err) : resolve(value);
    };
    const reply = (res, status, msg) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(PAGE(msg));
    };

    server.on("request", async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== "/callback") return reply(res, 404, "Not found.");
      const q = url.searchParams;
      // A stray or forged callback is refused, but the real one can still arrive until the timeout.
      if (q.get("state") !== state) return reply(res, 400, "This sign-in link doesn't match. Use the tab Jarvis opened.");
      if (q.get("error")) {
        const denied = q.get("error") === "access_denied";
        reply(res, 400, denied ? "Access was denied. You can close this tab." : "Sign-in failed. You can close this tab.");
        return finish(new SpotifyError(CODES.SIGN_IN_REQUIRED, denied ? "Spotify access was denied in the browser." : `Spotify sign-in failed: ${q.get("error")}.`));
      }
      const code = q.get("code");
      if (!code) {
        reply(res, 400, "Missing code.");
        return finish(new SpotifyError(CODES.API, "Sign-in failed: no code returned."));
      }
      try {
        const r = await postToken(fetch, { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new SpotifyError(CODES.API, `Spotify token exchange failed (${r.status}): ${redact(body.error_description || body.error || "unknown")}`, { status: r.status });
        await store.saveTokens(body);
        reply(res, 200, "Signed in, you can close this tab.");
        finish(null, { signedIn: true, scopes: String(body.scope || "").split(" ").filter(Boolean) });
      } catch (e) {
        reply(res, 500, "Sign-in failed. You can close this tab.");
        finish(e);
      }
    });
    server.on("error", (e) => finish(e));

    let clientId, redirectUri;
    store.getClientId().then((id) => {
      clientId = id;
      if (settled) return;
      server.listen(port, "127.0.0.1", () => {
        redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
        const url = `${AUTHORIZE_URL}?${form({
          response_type: "code", client_id: clientId, scope: SCOPES.join(" "), redirect_uri: redirectUri,
          code_challenge_method: "S256", code_challenge: challengeFor(verifier), state,
        })}`;
        timer = setTimeout(() => finish(new SpotifyError(CODES.SIGN_IN_REQUIRED, "Sign-in timed out waiting for the browser.")), timeoutMs);
        Promise.resolve().then(() => openUrl(url)).catch(() => log(`Open this URL in your browser to sign in:\n${url}`));
      });
    }, (e) => finish(e));
  });
}

export async function promptClientId({ input = process.stdin, output = process.stderr } = {}) {
  const rl = createInterface({ input, output });
  try {
    for (let i = 0; i < 3; i++) {
      const answer = (await rl.question("Spotify Client ID: ")).trim();
      if (CLIENT_ID_RE.test(answer)) return answer;
      output.write("That is not a Client ID (32 hexadecimal characters).\n");
    }
    throw new Error("No valid Spotify Client ID entered.");
  } finally {
    rl.close();
  }
}
