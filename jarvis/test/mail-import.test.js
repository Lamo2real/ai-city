import assert from "node:assert/strict";
import { existsSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../bin/jarvis-mail";
import { createKeychain, createTokenStore } from "../mail/auth.js";
import { redact } from "../mail/redact.js";

const ID = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";
const SECRET = "GOCSPX-importedsecret0123";
const installed = { installed: { client_id: ID, client_secret: SECRET, auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token", redirect_uris: ["http://localhost"] } };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-import-"));
  const calls = [];
  const keychain = createKeychain({ run: async (args, o = {}) => { calls.push({ args, input: o.input }); return { code: 0, stdout: "", stderr: "" }; } });
  const deps = { store: createTokenStore({ keychain }), redact, downloadsDir: dir };
  const out = async (argv) => { const r = await run(argv, deps); return { code: r.code, json: JSON.parse(r.line), line: r.line }; };
  return { dir, calls, out };
}
const write = (dir, name, content) => { const p = join(dir, name); writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content)); return p; };

test("import stores both values via stdin, deletes the file, prints no secret", async () => {
  const t = setup();
  const file = write(t.dir, "client.json", installed);
  const r = await t.out(["setup", "--import", file]);
  assert.deepEqual(r.json, { ok: true, client_id: "123456…", file_deleted: true });
  assert.ok(!existsSync(file));
  assert.equal(t.calls.length, 2);
  assert.ok(t.calls.every((c) => c.args.length === 1 && c.args[0] === "-i"));
  assert.match(t.calls[0].input, /-s jarvis\.gmail-client-id -w "123456789012-/);
  assert.match(t.calls[1].input, new RegExp(`-s jarvis\\.gmail-client-secret -w "${SECRET}"`));
  assert.ok(!JSON.stringify(t.calls.map((c) => c.args)).includes(SECRET));
  assert.ok(!r.line.includes(SECRET) && !r.line.includes(ID));
});

test("without a path it picks the newest client_secret_*.json in Downloads", async () => {
  const t = setup();
  const old = write(t.dir, "client_secret_old.apps.googleusercontent.com.json", { installed: { ...installed.installed, client_id: "111111111111-old.apps.googleusercontent.com" } });
  utimesSync(old, 1000, 1000);
  const fresh = write(t.dir, "client_secret_new.apps.googleusercontent.com.json", installed);
  write(t.dir, "unrelated.json", "{}");
  const r = await t.out(["setup", "--import"]);
  assert.equal(r.json.client_id, "123456…");
  assert.ok(!existsSync(fresh) && existsSync(old));
  assert.equal((await setup().out(["setup", "--import"])).json.error, "BAD_REQUEST");
});

test("a Web application client is refused and the file stays", async () => {
  const t = setup();
  const file = write(t.dir, "web.json", { web: { client_id: ID, client_secret: SECRET } });
  const r = await t.out(["setup", "--import", file]);
  assert.equal(r.code, 1);
  assert.match(r.json.message, /Desktop app/);
  assert.ok(existsSync(file));
  assert.equal(t.calls.length, 0);
  assert.ok(!r.line.includes(SECRET));
});

test("malformed or incomplete JSON is refused, file kept, with a message", async () => {
  const t = setup();
  const bad = write(t.dir, "bad.json", "{ not json");
  const r = await t.out(["setup", "--import", bad]);
  assert.equal(r.code, 1);
  assert.match(r.json.message, /not valid JSON/);
  assert.ok(existsSync(bad));
  const partial = write(t.dir, "partial.json", { installed: { client_id: ID } });
  assert.match((await t.out(["setup", "--import", partial])).json.message, /not a Desktop-app OAuth client/);
  const wrongId = write(t.dir, "wrong.json", { installed: { ...installed.installed, client_id: "nonsense" } });
  const w = await t.out(["setup", "--import", wrongId]);
  assert.equal(w.code, 1);
  assert.ok(existsSync(wrongId) && existsSync(partial));
  assert.equal(t.calls.length, 0);
});

test("only regular files: directories, symlinks and missing paths are refused", async () => {
  const t = setup();
  const real = write(t.dir, "real.json", installed);
  const link = join(t.dir, "link.json");
  symlinkSync(real, link);
  assert.match((await t.out(["setup", "--import", t.dir])).json.message, /not a regular file/);
  assert.match((await t.out(["setup", "--import", link])).json.message, /not a regular file/);
  assert.match((await t.out(["setup", "--import", join(t.dir, "missing.json")])).json.message, /no file/);
  assert.ok(existsSync(real));
});
