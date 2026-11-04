import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { challengeFor, createKeychain, createTokenStore, promptClientSecret, signIn } from "../mail/auth.js";
import { redact } from "../mail/redact.js";
import { KEYCHAIN, SCOPE } from "../mail/scopes.js";

const CLIENT_ID = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-testsecret0123456789";

function memoryKeychain(initial = {}) {
  const data = { ...initial };
  return { data, get: async (s) => data[s] ?? null, set: async (s, v) => { data[s] = v; }, remove: async (s) => { delete data[s]; } };
}
const configured = () => memoryKeychain({ [KEYCHAIN.clientId]: CLIENT_ID, [KEYCHAIN.clientSecret]: CLIENT_SECRET });
const jsonRes = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] }, json: async () => body });

test("the scope is exactly full mailbox access", () => assert.equal(SCOPE, "https://mail.google.com/"));

test("keychain.set keeps the secret out of argv and quotes safely", async () => {
  const calls = [];
  const kc = createKeychain({ run: async (args, o = {}) => { calls.push({ args, input: o.input }); return { code: 0, stdout: "", stderr: "" }; } });
  await kc.set("svc", 'sec"ret\\SECRET123');
  assert.deepEqual(calls[0].args, ["-i"]);
  assert.equal(calls[0].input, 'add-generic-password -U -a jarvis -s svc -w "sec\\"ret\\\\SECRET123"\n');
  await assert.rejects(kc.set("svc", "a\nb"), /control/);
});

test("keychain get, missing and remove", async () => {
  const calls = [];
  const run = (code, stdout = "") => async (args) => { calls.push(args); return { code, stdout, stderr: "" }; };
  assert.equal(await createKeychain({ run: run(0, "v\n") }).get("svc"), "v");
  assert.deepEqual(calls[0], ["find-generic-password", "-a", "jarvis", "-s", "svc", "-w"]);
  assert.equal(await createKeychain({ run: run(44) }).get("svc"), null);
  await createKeychain({ run: run(0) }).remove("svc");
  assert.deepEqual(calls.at(-1), ["delete-generic-password", "-a", "jarvis", "-s", "svc"]);
});

test("setCredentials validates and stores both in the Keychain", async () => {
  const kc = memoryKeychain();
  const store = createTokenStore({ keychain: kc });
  await assert.rejects(store.getClientId(), { code: "NOT_CONFIGURED" });
  await assert.rejects(store.setCredentials("nope", CLIENT_SECRET), /client ID/);
  await assert.rejects(store.setCredentials(CLIENT_ID, "x"), /secret/);
  await store.setCredentials(CLIENT_ID, CLIENT_SECRET);
  assert.equal(kc.data[KEYCHAIN.clientId], CLIENT_ID);
  assert.equal(kc.data[KEYCHAIN.clientSecret], CLIENT_SECRET);
  assert.equal(redact(`oops ${CLIENT_SECRET}`), "oops [REDACTED]");
});

test("refresh before expiry sends the client secret and keeps the old refresh token", async () => {
  let t = 1_000_000;
  const kc = configured();
  const bodies = [];
  const fetch = async (url, init) => { bodies.push({ url, body: new URLSearchParams(init.body) }); return jsonRes(200, { access_token: "access-token-2", expires_in: 3599 }); };
  const store = createTokenStore({ keychain: kc, fetch, now: () => t });
  await store.saveTokens({ access_token: "access-token-1", refresh_token: "refresh-token-1", expires_in: 3600, scope: SCOPE });
  assert.equal(await store.getAccessToken(), "access-token-1");
  assert.equal(bodies.length, 0);
  t += 3600_000 - 30_000;
  assert.equal(await store.getAccessToken(), "access-token-2");
  assert.equal(bodies[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(bodies[0].body.get("grant_type"), "refresh_token");
  assert.equal(bodies[0].body.get("refresh_token"), "refresh-token-1");
  assert.equal(bodies[0].body.get("client_id"), CLIENT_ID);
  assert.equal(bodies[0].body.get("client_secret"), CLIENT_SECRET);
  const saved = JSON.parse(kc.data[KEYCHAIN.tokens]);
  assert.equal(saved.refresh_token, "refresh-token-1");
  assert.equal(saved.scope, SCOPE);
});

test("no tokens → SIGN_IN_REQUIRED", async () => {
  await assert.rejects(createTokenStore({ keychain: configured() }).getAccessToken(), { code: "SIGN_IN_REQUIRED" });
});

test("invalid_grant deletes the tokens and says to run login again", async () => {
  const kc = configured();
  const store = createTokenStore({ keychain: kc, fetch: async () => jsonRes(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }) });
  await store.saveTokens({ access_token: "access-token-1", refresh_token: "refresh-token-1", expires_in: 3600 });
  await assert.rejects(store.refresh(), (e) => e.code === "SIGN_IN_REQUIRED" && /jarvis-mail login/.test(e.message) && /Testing mode/.test(e.message));
  assert.equal(kc.data[KEYCHAIN.tokens], undefined);
});

test("429 on refresh is RATE_LIMITED and keeps the tokens; invalid_client asks for setup", async () => {
  const kc = configured();
  const store = createTokenStore({ keychain: kc, fetch: async () => jsonRes(429, {}, { "retry-after": "7" }) });
  await store.saveTokens({ access_token: "access-token-1", refresh_token: "refresh-token-1", expires_in: 3600 });
  await assert.rejects(store.refresh(), (e) => e.code === "RATE_LIMITED" && e.retryAfter === 7);
  assert.ok(kc.data[KEYCHAIN.tokens]);
  const bad = createTokenStore({ keychain: kc, fetch: async () => jsonRes(401, { error: "invalid_client" }) });
  await assert.rejects(bad.refresh(), { code: "NOT_CONFIGURED" });
  assert.ok(kc.data[KEYCHAIN.tokens]);
});

test("status has no secrets", async () => {
  const store = createTokenStore({ keychain: configured() });
  await store.saveTokens({ access_token: "access-token-1", refresh_token: "refresh-token-1", expires_in: 3600, scope: SCOPE });
  const s = await store.status();
  assert.deepEqual(Object.keys(s).sort(), ["configured", "expiresAt", "scopes", "signedIn"]);
  assert.equal(s.configured, true);
  const text = JSON.stringify(s);
  for (const secret of ["access-token-1", "refresh-token-1", CLIENT_ID, CLIENT_SECRET]) assert.ok(!text.includes(secret));
  await store.clear();
  assert.equal((await store.status()).signedIn, false);
});

test("PKCE S256 matches the RFC 7636 appendix B vector", () => {
  assert.equal(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

const callbackFor = (authUrl, params) => {
  const u = new URL(new URL(authUrl.searchParams.get("redirect_uri")).origin + "/callback");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
};
function harness(fetch, hit) {
  const keychain = configured();
  const store = createTokenStore({ keychain, fetch });
  const urls = [];
  const openUrl = async (url) => { urls.push(url); setImmediate(() => hit(new URL(url))); };
  return { keychain, store, urls, run: (extra = {}) => signIn({ store, fetch, openUrl, timeoutMs: 2000, log: () => {}, ...extra }) };
}
const goodTokens = { access_token: "access-token-9", refresh_token: "refresh-token-9", expires_in: 3599, scope: SCOPE };

test("signIn end to end: PKCE, offline access, 127.0.0.1, secret in the exchange, tokens in Keychain", async () => {
  const posts = [];
  let hit, page;
  const fetch = async (url, init) => { posts.push({ url, body: new URLSearchParams(init.body) }); return jsonRes(200, goodTokens); };
  const h = harness(fetch, (auth) => {
    hit = (async () => {
      assert.equal(new URL(auth.searchParams.get("redirect_uri")).hostname, "127.0.0.1");
      page = await (await globalThis.fetch(callbackFor(auth, { code: "auth-code-1", state: auth.searchParams.get("state") }))).text();
    })();
  });
  const result = await h.run();
  await hit;
  assert.equal(result.signedIn, true);
  assert.match(page, /Signed in, you can close this tab/);
  const auth = new URL(h.urls[0]);
  assert.equal(auth.origin + auth.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(auth.searchParams.get("scope"), SCOPE);
  assert.equal(auth.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("access_type"), "offline");
  assert.ok(!auth.searchParams.has("client_secret"));
  const { url, body } = posts[0];
  assert.equal(url, "https://oauth2.googleapis.com/token");
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "auth-code-1");
  assert.equal(body.get("client_secret"), CLIENT_SECRET);
  assert.equal(body.get("redirect_uri"), auth.searchParams.get("redirect_uri"));
  assert.equal(body.get("code_verifier").length, 64);
  assert.equal(challengeFor(body.get("code_verifier")), auth.searchParams.get("code_challenge"));
  assert.equal(JSON.parse(h.keychain.data[KEYCHAIN.tokens]).refresh_token, "refresh-token-9");
});

test("signIn ignores a callback with the wrong state, then accepts the real one", async () => {
  let hit;
  const h = harness(async () => jsonRes(200, goodTokens), (auth) => {
    hit = (async () => {
      const bad = await globalThis.fetch(callbackFor(auth, { code: "c", state: "wrong" }));
      assert.equal(bad.status, 400);
      await (await globalThis.fetch(callbackFor(auth, { code: "c", state: auth.searchParams.get("state") }))).text();
    })();
  });
  assert.equal((await h.run()).signedIn, true);
  await hit;
});

test("signIn surfaces access_denied", async () => {
  const h = harness(async () => jsonRes(200, {}), async (auth) => { await globalThis.fetch(callbackFor(auth, { error: "access_denied", state: auth.searchParams.get("state") })); });
  await assert.rejects(h.run(), (e) => e.code === "SIGN_IN_REQUIRED" && /denied/.test(e.message));
});

test("signIn refuses a grant without full scope or without a refresh token", async () => {
  for (const [tokens, re] of [[{ ...goodTokens, scope: "https://www.googleapis.com/auth/gmail.readonly" }, /full Gmail access/], [{ ...goodTokens, refresh_token: undefined }, /no refresh token/]]) {
    const h = harness(async () => jsonRes(200, tokens), async (auth) => { await globalThis.fetch(callbackFor(auth, { code: "c", state: auth.searchParams.get("state") })); });
    await assert.rejects(h.run(), re);
    assert.equal(h.keychain.data[KEYCHAIN.tokens], undefined);
  }
});

test("signIn: error responses leak no secrets; timeout closes; URL printed only if open fails", async () => {
  const h = harness(async () => jsonRes(400, { error: "invalid_request", error_description: `bad ${CLIENT_SECRET}` }), async (auth) => { await globalThis.fetch(callbackFor(auth, { code: "c", state: auth.searchParams.get("state") })); });
  await h.run().then(() => assert.fail("should reject"), (e) => assert.ok(!JSON.stringify(redact(e)).includes(CLIENT_SECRET)));
  const store = createTokenStore({ keychain: configured() });
  const logs = [];
  await assert.rejects(signIn({ store, openUrl: async () => { throw new Error("no browser"); }, timeoutMs: 100, log: (m) => logs.push(m) }), /timed out/);
  assert.match(logs[0], /accounts\.google\.com\/o\/oauth2\/v2\/auth/);
});

test("the client secret prompt does not echo what is typed", async () => {
  const input = new PassThrough();
  const out = [];
  const output = { write: (s) => { out.push(String(s)); return true; } };
  const p = promptClientSecret({ input, output });
  input.write(`${CLIENT_SECRET}\n`);
  assert.equal(await p, CLIENT_SECRET);
  assert.ok(!out.join("").includes(CLIENT_SECRET));
  assert.match(out.join(""), /hidden/);
});

test("redact covers client_secret and id_token in forms, JSON strings and objects", () => {
  assert.ok(!redact(`client_secret=${CLIENT_SECRET}&grant_type=refresh_token`).includes(CLIENT_SECRET));
  const json = redact('{"client_secret":"abc","id_token":"jwt","x":1}');
  assert.deepEqual(JSON.parse(json), { client_secret: "[REDACTED]", id_token: "[REDACTED]", x: 1 });
  assert.equal(redact({ client_secret: "abc", ok: 1 }).client_secret, "[REDACTED]");
});
