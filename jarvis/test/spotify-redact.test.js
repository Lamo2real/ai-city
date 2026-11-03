import assert from "node:assert/strict";
import { test } from "node:test";
import { SpotifyError } from "../spotify/errors.js";
import { addSecret, redact } from "../spotify/redact.js";

test("redacts Bearer headers", () => {
  assert.equal(redact("Authorization: Bearer abc.def-123"), "Authorization: Bearer [REDACTED]");
  assert.equal(redact({ headers: { Authorization: "Bearer zzz" } }).headers.Authorization, "[REDACTED]");
});

test("redacts token fields in JSON strings", () => {
  const out = redact('{"access_token":"AAAA1111","refresh_token": "BBBB2222","expires_in":3600,"code":"c0de"}');
  assert.ok(!/AAAA1111|BBBB2222|c0de/.test(out));
  assert.match(out, /"expires_in":3600/);
  assert.deepEqual(JSON.parse(out).access_token, "[REDACTED]");
});

test("redacts query strings and form bodies", () => {
  const out = redact("grant_type=refresh_token&refresh_token=RRRR&client_id=CCCC&code_verifier=VVVV&status_code=200");
  assert.equal(out, "grant_type=refresh_token&refresh_token=[REDACTED]&client_id=[REDACTED]&code_verifier=[REDACTED]&status_code=200");
  assert.equal(redact("GET /callback?code=XYZ&state=s1"), "GET /callback?code=[REDACTED]&state=s1");
});

test("redacts nested objects and arrays without mutating the input", () => {
  const input = { a: { access_token: "t1", list: [{ code_verifier: "v", note: "Bearer q" }] }, ok: 1 };
  const out = redact(input);
  assert.equal(out.a.access_token, "[REDACTED]");
  assert.equal(out.a.list[0].code_verifier, "[REDACTED]");
  assert.equal(out.a.list[0].note, "Bearer [REDACTED]");
  assert.equal(out.ok, 1);
  assert.equal(input.a.access_token, "t1");
});

test("redacts registered secrets, ignoring short ones", () => {
  addSecret("super-secret-value");
  addSecret("short");
  assert.equal(redact("x super-secret-value y"), "x [REDACTED] y");
  assert.equal(redact("a short one"), "a short one");
});

test("errors serialised through redact leak nothing", () => {
  addSecret("tok_registered_123");
  const err = new SpotifyError("API", "failed with tok_registered_123 and Bearer abc", { status: 500 });
  const text = JSON.stringify(redact(err));
  assert.ok(!text.includes("tok_registered_123"));
  assert.ok(!text.includes("abc\""));
  assert.match(text, /"code":"API"/);
});
