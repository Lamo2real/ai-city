// Gmail sign-in (Google "Desktop app" client: Authorization Code + PKCE S256 over a loopback redirect)
// and the Keychain token store. Client ID, client secret and tokens live only in the macOS Keychain.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { CODES, MailError } from "./errors.js";
import { addSecret, redact } from "./redact.js";
import { AUTHORIZE_URL, KEYCHAIN, SCOPE, TOKEN_URL } from "./scopes.js";

const CLIENT_ID_RE = /^[0-9]+-[a-z0-9_]+\.apps\.googleusercontent\.com$/i;
const CLIENT_SECRET_RE = /^[\w-]{8,}$/;
const REFRESH_MARGIN_MS = 60_000;
const REVOKED = "Gmail access expired or was revoked. Run jarvis-mail login to approve it again. (Only a Google app left in Testing mode loses sign-in every 7 days.)";

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

  async function getCredential(service, what) {
    const v = await keychain.get(service);
    if (!v) throw new MailError(CODES.NOT_CONFIGURED, `Gmail is not set up. Run jarvis-mail setup to add the ${what}.`);
    addSecret(v);
    return v;
  }
  const getClientId = () => getCredential(KEYCHAIN.clientId, "client ID");
  const getClientSecret = () => getCredential(KEYCHAIN.clientSecret, "client secret");

  async function setCredentials(id, secret) {
    const clientId = String(id ?? "").trim();
    const clientSecret = String(secret ?? "").trim();
    if (!CLIENT_ID_RE.test(clientId)) throw new Error("A Google client ID looks like 123456-abc.apps.googleusercontent.com.");
    if (!CLIENT_SECRET_RE.test(clientSecret)) throw new Error("That does not look like a Google client secret.");
    addSecret(clientId);
    addSecret(clientSecret);
    await keychain.set(KEYCHAIN.clientId, clientId);
    await keychain.set(KEYCHAIN.clientSecret, clientSecret);
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
    if (!tokens?.refresh_token) throw new MailError(CODES.SIGN_IN_REQUIRED, "Not signed in to Gmail. Run jarvis-mail login.");
    const [clientId, clientSecret] = [await getClientId(), await getClientSecret()];
    const res = await postToken(fetch, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId, client_secret: clientSecret });
    if (res.status === 429) {
      const retryAfter = Number(res.headers?.get?.("retry-after")) || undefined;
      throw new MailError(CODES.RATE_LIMITED, "Google is rate limiting sign-in refresh. Try again shortly.", { status: 429, retryAfter });
    }
    const body = await res.json().catch(() => ({}));
    if (body.error === "invalid_grant") {
      await keychain.remove(KEYCHAIN.tokens);
      throw new MailError(CODES.SIGN_IN_REQUIRED, REVOKED, { status: res.status });
    }
    if (body.error === "invalid_client") throw new MailError(CODES.NOT_CONFIGURED, "Google rejected the client ID or secret. Run jarvis-mail setup again.", { status: res.status });
    if (!res.ok) throw new MailError(CODES.API, `Gmail token refresh failed (${res.status}).`, { status: res.status });
    return (await saveTokens(body)).access_token;
  }

  function refresh() {
    inflight ??= doRefresh().finally(() => { inflight = null; });
    return inflight;
  }

  async function getAccessToken() {
    const tokens = await load();
    if (!tokens?.access_token) throw new MailError(CODES.SIGN_IN_REQUIRED, "Not signed in to Gmail. Run jarvis-mail login.");
    if (tokens.expires_at - now() >= REFRESH_MARGIN_MS) return tokens.access_token;
    try {
      return await refresh();
    } catch (err) {
      if (err?.code === CODES.RATE_LIMITED && tokens.expires_at > now()) return tokens.access_token;
      throw err;
    }
  }

  async function status() {
    const [id, secret, tokens] = [await keychain.get(KEYCHAIN.clientId), await keychain.get(KEYCHAIN.clientSecret), await load()];
    return {
      configured: Boolean(id && secret),
      signedIn: Boolean(tokens?.access_token),
      scopes: tokens?.scope ? tokens.scope.split(" ").filter(Boolean) : [],
      expiresAt: tokens?.expires_at ?? null,
    };
  }

  async function clear() {
    await keychain.remove(KEYCHAIN.tokens);
  }

  return { getClientId, getClientSecret, setCredentials, getAccessToken, refresh, saveTokens, status, clear };
}

// ---- Sign-in ----

export const base64url = (buf) => Buffer.from(buf).toString("base64url");
export const challengeFor = (verifier) => base64url(createHash("sha256").update(verifier).digest());

const defaultOpenUrl = (url) => new Promise((resolve, reject) => {
  execFile("open", [url], (err) => (err ? reject(err) : resolve()));
});

const PAGE = (msg) => `<!doctype html><meta charset="utf-8"><title>Jarvis</title><body style="font-family:system-ui;padding:3rem"><p>${msg}</p>`;

// Google accepts any port on a loopback IP for Desktop clients, so the OS picks a free one (port 0).
export function signIn({ store, fetch = globalThis.fetch, openUrl = defaultOpenUrl, port = 0, timeoutMs = 300_000, log = console.error }) {
  return new Promise((resolve, reject) => {
    const verifier = base64url(randomBytes(48)); // 64 chars
    const state = base64url(randomBytes(16));
    addSecret(verifier);
    let settled = false;
    let timer;
    let clientId, clientSecret, redirectUri;
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
        return finish(new MailError(CODES.SIGN_IN_REQUIRED, denied ? "Gmail access was denied in the browser." : `Gmail sign-in failed: ${q.get("error")}.`));
      }
      const code = q.get("code");
      if (!code) {
        reply(res, 400, "Missing code.");
        return finish(new MailError(CODES.API, "Sign-in failed: no code returned."));
      }
      try {
        const r = await postToken(fetch, { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret, code_verifier: verifier });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new MailError(CODES.API, `Gmail token exchange failed (${r.status}): ${redact(body.error_description || body.error || "unknown")}`, { status: r.status });
        if (!body.refresh_token) throw new MailError(CODES.API, "Google returned no refresh token. Remove Jarvis under myaccount.google.com → Security → Third-party access, then run login again.");
        if (!String(body.scope || "").split(" ").includes(SCOPE)) throw new MailError(CODES.FORBIDDEN, "Google did not grant full Gmail access. Run login again and allow every permission.");
        await store.saveTokens(body);
        reply(res, 200, "Signed in, you can close this tab.");
        finish(null, { signedIn: true, scopes: String(body.scope || "").split(" ").filter(Boolean) });
      } catch (e) {
        reply(res, 500, "Sign-in failed. You can close this tab.");
        finish(e);
      }
    });
    server.on("error", (e) => finish(e));

    Promise.all([store.getClientId(), store.getClientSecret()]).then(([id, secret]) => {
      [clientId, clientSecret] = [id, secret];
      if (settled) return;
      server.listen(port, "127.0.0.1", () => {
        redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
        const url = `${AUTHORIZE_URL}?${form({
          response_type: "code", client_id: clientId, scope: SCOPE, redirect_uri: redirectUri,
          code_challenge_method: "S256", code_challenge: challengeFor(verifier), state,
          access_type: "offline", prompt: "consent",
        })}`;
        timer = setTimeout(() => finish(new MailError(CODES.SIGN_IN_REQUIRED, "Sign-in timed out waiting for the browser.")), timeoutMs);
        Promise.resolve().then(() => openUrl(url)).catch(() => log(`Open this URL in your browser to sign in:\n${url}`));
      });
    }, (e) => finish(e));
  });
}

// ---- Prompts for setup ----

export async function promptClientId({ input = process.stdin, output = process.stderr } = {}) {
  const rl = createInterface({ input, output });
  try {
    for (let i = 0; i < 3; i++) {
      const answer = (await rl.question("Google client ID: ")).trim();
      if (CLIENT_ID_RE.test(answer)) return answer;
      output.write("That is not a client ID (123456-abc.apps.googleusercontent.com).\n");
    }
    throw new Error("No valid Google client ID entered.");
  } finally {
    rl.close();
  }
}

// The secret is typed without echo: output is muted once the prompt has been shown.
export async function promptClientSecret({ input = process.stdin, output = process.stderr } = {}) {
  let muted = false;
  const sink = new Writable({ write(chunk, _enc, cb) { if (!muted) output.write(chunk); cb(); } });
  const rl = createInterface({ input, output: sink, terminal: Boolean(input.isTTY) });
  try {
    for (let i = 0; i < 3; i++) {
      output.write("Google client secret (hidden): ");
      muted = true;
      const answer = (await rl.question("")).trim();
      muted = false;
      output.write("\n");
      if (CLIENT_SECRET_RE.test(answer)) return answer;
      output.write("That does not look like a client secret.\n");
    }
    throw new Error("No valid Google client secret entered.");
  } finally {
    rl.close();
  }
}
