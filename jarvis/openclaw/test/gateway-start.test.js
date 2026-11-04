// Runs the real bin/gateway with a fake `security` (the Keychain) and a fake `npx` (OpenClaw) on PATH,
// to prove it starts only with every secret present and exactly one numeric owner ID, and fails closed otherwise.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const GATEWAY = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "gateway");
const FULL = {
  "jarvis.openclaw-gateway": "gw-token-AAAAAAAA",
  "jarvis.openclaw-relay": "relay-token-BBBBBBBB",
  "jarvis.openclaw-telegram": "telegram-bot-token-CCCCCCCC",
  "jarvis.openclaw-telegram-owner": "123456789",
};

function start(items) {
  const bin = mkdtempSync(join(tmpdir(), "gw-bin-"));
  const state = mkdtempSync(join(tmpdir(), "gw-state-"));
  writeFileSync(join(bin, "items.json"), JSON.stringify(items));
  // security find-generic-password -s <item> -w
  writeFileSync(join(bin, "security"), `#!/bin/sh\nnode -e 'const i=require(process.argv[1]); const s=process.argv[2]; if(!(s in i)) process.exit(44); process.stdout.write(i[s])' "${join(bin, "items.json")}" "$3"\n`);
  // npx openclaw …: record what OpenClaw would get, then exit
  writeFileSync(join(bin, "npx"), `#!/bin/sh\nnode -e 'const e=process.env; require("fs").writeFileSync(process.argv[1], JSON.stringify({args: process.argv.slice(2), gw: e.OPENCLAW_GATEWAY_TOKEN, relay: e.JARVIS_RELAY_TOKEN, bot: e.TELEGRAM_BOT_TOKEN, owner: e.TELEGRAM_OWNER_ID, anthropic: e.ANTHROPIC_API_KEY ?? null, oauth: e.CLAUDE_CODE_OAUTH_TOKEN ?? null, config: e.OPENCLAW_CONFIG_PATH}))' "${join(bin, "ran.json")}" "$@"\n`);
  chmodSync(join(bin, "security"), 0o755);
  chmodSync(join(bin, "npx"), 0o755);
  const r = spawnSync("/bin/sh", [GATEWAY], { env: { PATH: `${bin}:/usr/bin:/bin:${dirname(process.execPath)}`, HOME: state, OPENCLAW_STATE_DIR: join(state, "oc"), ANTHROPIC_API_KEY: "must-not-pass", CLAUDE_CODE_OAUTH_TOKEN: "must-not-pass", OPENCLAW_RUNTIME_CONFIG: join(state, "openclaw.runtime.json") }, encoding: "utf8" });
  let ran = null;
  try { ran = JSON.parse(readFileSync(join(bin, "ran.json"), "utf8")); } catch { /* OpenClaw was never started */ }
  return { code: r.status, err: r.stderr, ran };
}

test("with every Keychain item it starts OpenClaw with the secrets in its environment only, and no Claude credentials", () => {
  const { code, ran } = start(FULL);
  assert.equal(code, 0);
  assert.deepEqual(ran.args, ["openclaw", "gateway"]);
  assert.equal(ran.gw, FULL["jarvis.openclaw-gateway"]);
  assert.equal(ran.relay, FULL["jarvis.openclaw-relay"]);
  assert.equal(ran.bot, FULL["jarvis.openclaw-telegram"]);
  assert.equal(ran.owner, "123456789");
  assert.equal(ran.anthropic, null);
  assert.equal(ran.oauth, null);
});

test("a missing secret or owner ID: it refuses to start and says which Keychain item to create", () => {
  for (const item of Object.keys(FULL)) {
    const items = { ...FULL };
    delete items[item];
    const { code, err, ran } = start(items);
    assert.equal(code, 1, item);
    assert.equal(ran, null, `${item}: OpenClaw must not start`);
    assert.match(err, new RegExp(item.replace(/\./g, "\\.")));
    assert.ok(!Object.values(FULL).some((v) => err.includes(v)), "no secret in the error output");
  }
});

test("the allowlist is exactly one numeric ID: wildcards, lists and usernames are refused", () => {
  for (const owner of ["*", "123,456", "123 456", "@lamo", "tg:123", "", "12a"]) {
    const { code, ran } = start({ ...FULL, "jarvis.openclaw-telegram-owner": owner });
    assert.equal(code, 1, JSON.stringify(owner));
    assert.equal(ran, null, `${JSON.stringify(owner)}: OpenClaw must not start`);
  }
});

test("OpenClaw gets a private runtime copy with the owner's real ID in the tool-policy key; the tracked file keeps the placeholder", () => {
  const tracked = readFileSync(join(dirname(GATEWAY), "..", "openclaw.json"), "utf8");
  const { code, ran } = start(FULL);
  assert.equal(code, 0);
  const runtime = readFileSync(ran.config, "utf8");
  assert.equal(statSync(ran.config).mode & 0o777, 0o600);
  assert.match(runtime, /"channel:telegram:123456789": \{\}/);
  assert.match(runtime, /"\*": \{ deny: \["ask_jarvis"\] \}/, "everyone else is still denied ask_jarvis");
  assert.match(runtime, /allowFrom: \["\$\{TELEGRAM_OWNER_ID\}"\]/, "the allowlist stays an env reference");
  assert.match(runtime, /token: "\$\{OPENCLAW_GATEWAY_TOKEN\}"/, "no token is written into the runtime copy");
  assert.ok(!runtime.includes(FULL["jarvis.openclaw-gateway"]) && !runtime.includes(FULL["jarvis.openclaw-telegram"]));
  assert.equal(readFileSync(join(dirname(GATEWAY), "..", "openclaw.json"), "utf8"), tracked, "the tracked config is never changed");
});
