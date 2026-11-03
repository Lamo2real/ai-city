import assert from "node:assert/strict";
import { test } from "node:test";
import { challengeFor, createKeychain, createTokenStore, signIn } from "../spotify/auth.js";
import { redact } from "../spotify/redact.js";
import { KEYCHAIN, SCOPES } from "../spotify/scopes.js";

const CLIENT_ID = "0123456789abcdef0123456789abcdef";

function fakeRun(responder = () => ({ code: 0, stdout: "", stderr: "" })) {
  const calls = [];
  const run = async (args, opts = {}) => { calls.push({ args, input: opts.input }); return responder(args, opts); };
  return { run, calls };
}

function memoryKeychain(initial = {}) {
  const data = { ...initial };
  return { data, get: async (s) => data[s] ?? null, set: async (s, v) => { data[s] = v; }, remove: async (s) => { delete data[s]; } };
}

const jsonRes = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] }, json: async () => body });

test("keychain.set keeps the secret out of argv", async () => {
  const { run, calls } = fakeRun();
  const secret = 'tok"en\\with-quote-SECRET123';
  await createKeychain({ run }).set("jarvis.x", secret);
  assert.deepEqual(calls[0].args, ["-i"]);
  assert.ok(!JSON.stringify(calls[0].args).includes("SECRET123"));
  assert.equal(calls[0].input, 'add-generic-password -U -a jarvis -s jarvis.x -w "tok\\"en\\\\with-quote-SECRET123"\n');
});

test("keychain.set rejects newlines and surfaces failure without the value", async () => {
  const kc = createKeychain({ run: fakeRun(() => ({ code: 1, stdout: "", stderr: "boom" })).run });
  await assert.rejects(kc.set("s", "a\nb"), /control/);
  await assert.rejects(kc.set("s", "hidden-value-1"), (e) => !e.message.includes("hidden-value-1"));
});

test("keychain.get returns value, null when not found, and never uses a secret in argv", async () => {
  const ok = fakeRun(() => ({ code: 0, stdout: "value\n", stderr: "" }));
  assert.equal(await createKeychain({ run: ok.run }).get("svc"), "value");
  assert.deepEqual(ok.calls[0].args, ["find-generic-password", "-a", "jarvis", "-s", "svc", "-w"]);
  const miss = fakeRun(() => ({ code: 44, stdout: "", stderr: "could not be found" }));
  assert.equal(await createKeychain({ run: miss.run }).get("svc"), null);
});

test("keychain.remove deletes and tolerates not-found", async () => {
  const f = fakeRun(() => ({ code: 44, stdout: "", stderr: "" }));
  await createKeychain({ run: f.run }).remove("svc");
  assert.deepEqual(f.calls[0].args, ["delete-generic-password", "-a", "jarvis", "-s", "svc"]);
});

test("NOT_CONFIGURED without a client id; setClientId validates", async () => {
  const store = createTokenStore({ keychain: memoryKeychain() });
  await assert.rejects(store.getClientId(), { code: "NOT_CONFIGURED" });
  await assert.rejects(store.setClientId("nope"), (e) => e.constructor === Error);
  await store.setClientId(CLIENT_ID);
  assert.equal(await store.getClientId(), CLIENT_ID);
});

test("getAccessToken: SIGN_IN_REQUIRED with no tokens; fresh token returned without fetch", async () => {
  let t = 1_000_000;
  const keychain = memoryKeychain();
  const fetch = async () => { throw new Error("no network"); };
  const store = createTokenStore({ keychain, fetch, now: () => t });
  await assert.rejects(store.getAccessToken(), { code: "SIGN_IN_REQUIRED" });
  await store.saveTokens({ access_token: "access-token-1", refresh_token: "refresh-token-1", expires_in: 3600, scope: "a b" });
  assert.equal(await store.getAccessToken(), "access-token-1");
});

test("token near expiry refreshes and keeps the old refresh_token when none returned", async () => {
  let t = 1_000_000;
  const keychain = memoryKeychain({ [KEYCHAIN.clientId]: CLIENT_ID });
  const bodies = [];
  const fetch = async (url, init) => { bodies.push({ url, body: new URLSearchParams(init.body) }); return jsonRes(200, { access_token: "access-token-2", expires_in: 3600 }); };
  const store = createTokenStore({ keychain, fetch, now: () => t });
  await store.saveTokens({ access_token: "access-token-1", refresh_token: "refresh-token-1", expires_in: 3600, scope: "a b" });
  t += 3600_000 - 30_000;
  assert.equal(await store.getAccessToken(), "access-token-2");
  assert.equal(bodies[0].url, "https://accounts.spotify.com/api/token");
  assert.equal(bodies[0].body.get("grant_type"), "refresh_token");
  assert.equal(bodies[0].body.get("refresh_token"), "refresh-token-1");
  assert.equal(bodies[0].body.get("client_id"), CLIENT_ID);
  assert.ok(!bodies[0].body.has("client_secret"));
  const saved = JSON.parse(keychain.data[KEYCHAIN.tokens]);
  assert.equal(saved.refresh_token, "refresh-token-1");
  assert.equal(saved.scope, "a b");
  assert.equal(saved.expires_at, t + 3600_000);
});

test("invalid_grant and 401 delete tokens and throw SIGN_IN_REQUIRED; 429 is RATE_LIMITED", async () => {
  for (const res of [jsonRes(400, { error: "invalid_grant" }), jsonRes(401, {})]) {
    const keychain = memoryKeychain({ [KEYCHAIN.clientId]: CLIENT_ID });
    const store = createTokenStore({ keychain, fetch: async () => res });
    await store.saveTokens({ access_token: "access-token-1", refresh_token: "refresh-token-1", expires_in: 3600 });
    await assert.rejects(store.refresh(), (e) => e.code === "SIGN_IN_REQUIRED" && e.message === "Spotify access expired or was revoked. Run sign-in again.");
    assert.equal(keychain.data[KEYCHAIN.tokens], undefined);
  }
  const keychain = memoryKeychain({ [KEYCHAIN.clientId]: CLIENT_ID });
  const store = createTokenStore({ keychain, fetch: async () => jsonRes(429, {}, { "retry-after": "7" }) });
  await store.saveTokens({ access_token: "access-token-1", refresh_token: "refresh-token-1", expires_in: 3600 });
  await assert.rejects(store.refresh(), (e) => e.code === "RATE_LIMITED" && e.retryAfter === 7);
  assert.ok(keychain.data[KEYCHAIN.tokens]);
});

test("status has no secrets", async () => {
  const keychain = memoryKeychain({ [KEYCHAIN.clientId]: CLIENT_ID });
  const store = createTokenStore({ keychain });
  await store.saveTokens({ access_token: "access-token-1", refresh_token: "refresh-token-1", expires_in: 3600, scope: "x y" });
  const s = await store.status();
  assert.deepEqual(Object.keys(s).sort(), ["configured", "expiresAt", "scopes", "signedIn"]);
  assert.deepEqual(s.scopes, ["x", "y"]);
  const text = JSON.stringify(s);
  assert.ok(!text.includes("access-token-1") && !text.includes("refresh-token-1") && !text.includes(CLIENT_ID));
  await store.clear();
  assert.equal((await store.status()).signedIn, false);
});

test("PKCE S256 matches the RFC 7636 appendix B vector", () => {
  assert.equal(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

async function setupSignIn(fetch, hit) {
  const keychain = memoryKeychain({ [KEYCHAIN.clientId]: CLIENT_ID });
  const store = createTokenStore({ keychain, fetch });
  const urls = [];
  const logs = [];
  const openUrl = async (url) => { urls.push(url); setImmediate(() => hit(new URL(url))); };
  return { keychain, store, urls, logs, run: (extra = {}) => signIn({ store, fetch, openUrl, port: 0, log: (m) => logs.push(m), ...extra }) };
}

const callbackFor = (authUrl, params) => {
  const redirect = new URL(authUrl.searchParams.get("redirect_uri"));
  const u = new URL(redirect.origin + "/callback");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
};

test("signIn end to end: PKCE, 127.0.0.1, token exchange, tokens stored", async () => {
  const posts = [];
  const fetch = async (url, init) => { posts.push(new URLSearchParams(init.body)); return jsonRes(200, { access_token: "access-token-9", refresh_token: "refresh-token-9", expires_in: 3600, scope: "a b" }); };
  let page, hit;
  const ctx = await setupSignIn(fetch, (auth) => { hit = (async () => {
    const redirect = new URL(auth.searchParams.get("redirect_uri"));
    assert.equal(redirect.hostname, "127.0.0.1");
    const res = await globalThis.fetch(callbackFor(auth, { code: "auth-code-1", state: auth.searchParams.get("state") }));
    page = await res.text();
  })(); });
  const result = await ctx.run();
  await hit;
  assert.equal(result.signedIn, true);
  assert.match(page, /Signed in, you can close this tab/);
  const auth = new URL(ctx.urls[0]);
  assert.equal(auth.origin + auth.pathname, "https://accounts.spotify.com/authorize");
  assert.equal(auth.searchParams.get("response_type"), "code");
  assert.equal(auth.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(auth.searchParams.get("scope"), SCOPES.join(" "));
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  const body = posts[0];
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "auth-code-1");
  assert.equal(body.get("redirect_uri"), auth.searchParams.get("redirect_uri"));
  assert.equal(body.get("code_verifier").length, 64);
  assert.equal(challengeFor(body.get("code_verifier")), auth.searchParams.get("code_challenge"));
  assert.ok(!body.has("client_secret"));
  assert.equal(JSON.parse(ctx.keychain.data[KEYCHAIN.tokens]).refresh_token, "refresh-token-9");
});

test("signIn binds to 127.0.0.1 only", async () => {
  let address;
  const ctx = await setupSignIn(async () => jsonRes(200, {}), async (auth) => {
    const redirect = new URL(auth.searchParams.get("redirect_uri"));
    address = redirect.hostname;
    await globalThis.fetch(callbackFor(auth, { error: "access_denied", state: auth.searchParams.get("state") }));
  });
  await assert.rejects(ctx.run(), /denied/);
  assert.equal(address, "127.0.0.1");
});

test("a wrong-state callback gets 400, exchanges nothing, and sign-in keeps waiting for the real one", async () => {
  const exchanged = [];
  const ctx = await setupSignIn(async (_url, init) => {
    exchanged.push(new URLSearchParams(init.body).get("code"));
    return jsonRes(200, { access_token: "access-token-1", refresh_token: "refresh-token-1", expires_in: 3600, scope: "a" });
  }, async (auth) => {
    const forged = await globalThis.fetch(callbackFor(auth, { code: "forged", state: "wrong" }));
    assert.equal(forged.status, 400);
    assert.equal(ctx.keychain.data[KEYCHAIN.tokens], undefined);
    await globalThis.fetch(callbackFor(auth, { code: "real", state: auth.searchParams.get("state") }));
  });
  assert.equal((await ctx.run()).signedIn, true);
  assert.deepEqual(exchanged, ["real"]);
});

test("a wrong-state callback alone ends in the timeout, never in tokens", async () => {
  const ctx = await setupSignIn(async () => assert.fail("no exchange"), async (auth) => {
    await globalThis.fetch(callbackFor(auth, { code: "forged", state: "wrong" }));
  });
  await assert.rejects(ctx.run({ timeoutMs: 300 }), (e) => e.code === "SIGN_IN_REQUIRED" && /timed out/.test(e.message));
  assert.equal(ctx.keychain.data[KEYCHAIN.tokens], undefined);
});

test("a 429 on refresh keeps a still-valid token; an expired one still throws", async () => {
  let t = 1_000_000;
  const keychain = memoryKeychain({ [KEYCHAIN.clientId]: CLIENT_ID });
  const store = createTokenStore({ keychain, now: () => t, fetch: async () => jsonRes(429, {}, { "retry-after": "30" }) });
  await store.saveTokens({ access_token: "access-token-1", refresh_token: "refresh-token-1", expires_in: 30 }); // inside the 60 s refresh margin
  assert.equal(await store.getAccessToken(), "access-token-1");
  t += 31_000; // now expired
  await assert.rejects(store.getAccessToken(), (e) => e.code === "RATE_LIMITED");
});

test("signIn surfaces access_denied clearly", async () => {
  const ctx = await setupSignIn(async () => jsonRes(200, {}), async (auth) => {
    await globalThis.fetch(callbackFor(auth, { error: "access_denied", state: auth.searchParams.get("state") }));
  });
  await assert.rejects(ctx.run(), (e) => e.code === "SIGN_IN_REQUIRED" && /denied/.test(e.message));
});

test("signIn serves only GET /callback", async () => {
  const ctx = await setupSignIn(async () => jsonRes(200, {}), async (auth) => {
    const base = new URL(auth.searchParams.get("redirect_uri")).origin;
    assert.equal((await globalThis.fetch(base + "/other")).status, 404);
    assert.equal((await globalThis.fetch(base + "/callback", { method: "POST" })).status, 404);
    await globalThis.fetch(callbackFor(auth, { error: "access_denied", state: auth.searchParams.get("state") }));
  });
  await assert.rejects(ctx.run(), /denied/);
});

test("signIn times out and closes", async () => {
  const keychain = memoryKeychain({ [KEYCHAIN.clientId]: CLIENT_ID });
  const store = createTokenStore({ keychain });
  await assert.rejects(signIn({ store, openUrl: async () => {}, port: 0, timeoutMs: 50, log: () => {} }), /timed out/);
});

test("signIn prints the URL only when openUrl fails", async () => {
  const keychain = memoryKeychain({ [KEYCHAIN.clientId]: CLIENT_ID });
  const store = createTokenStore({ keychain });
  const logs = [];
  await assert.rejects(signIn({ store, openUrl: async () => { throw new Error("no browser"); }, port: 0, timeoutMs: 100, log: (m) => logs.push(m) }), /timed out/);
  assert.match(logs[0], /^Open this URL[\s\S]*accounts\.spotify\.com\/authorize/);
});

test("registered secrets are scrubbed after the store loads them", async () => {
  const keychain = memoryKeychain({ [KEYCHAIN.clientId]: CLIENT_ID });
  const store = createTokenStore({ keychain });
  await store.saveTokens({ access_token: "scrub-access-tok", refresh_token: "scrub-refresh-tok", expires_in: 60 });
  await store.getClientId();
  const out = redact(`x scrub-access-tok y scrub-refresh-tok z ${CLIENT_ID}`);
  assert.equal(out, "x [REDACTED] y [REDACTED] z [REDACTED]");
});
