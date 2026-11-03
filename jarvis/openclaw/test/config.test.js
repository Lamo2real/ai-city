// Locks OpenClaw's rights down: this fails if anyone loosens the config, the pin, or lets a secret into a tracked file.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const JSON5 = createRequire(import.meta.url)("json5"); // the parser OpenClaw itself uses, shipped with the pinned openclaw
const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIGS = ["openclaw.json", "openclaw.json.last-good"];
const load = (name) => JSON5.parse(readFileSync(join(HERE, name), "utf8"));

const DENIED = ["group:runtime", "group:fs", "group:ui", "group:web", "group:nodes", "group:automation", "group:media", "group:sessions", "group:agents", "group:memory",
  "exec", "process", "read", "write", "edit", "apply_patch", "browser", "canvas", "cron", "gateway", "image", "nodes", "sessions_spawn", "sessions_send", "openclaw", "plugins"];

for (const name of CONFIGS) {
  test(`${name}: one tool (ask_jarvis), everything else denied, no skills, only our plugin`, () => {
    const c = load(name);
    assert.deepEqual(c.tools.allow, ["ask_jarvis"]);
    for (const d of DENIED) assert.ok(c.tools.deny.includes(d), `tools.deny must include ${d}`);
    assert.equal(c.tools.elevated.enabled, false);
    assert.equal(c.browser.enabled, false);
    assert.deepEqual(c.skills.allowBundled, []);
    assert.deepEqual(c.plugins.allow, ["jarvis-relay"]);
    assert.deepEqual(Object.keys(c.plugins.entries), ["jarvis-relay"]);
    assert.match(c.plugins.entries["jarvis-relay"].config.server, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test(`${name}: gateway on loopback with token auth; no discovery, Control UI or public exposure`, () => {
    const c = load(name);
    assert.equal(c.gateway.bind, "loopback");
    assert.equal(c.gateway.mode, "local");
    assert.equal(c.gateway.auth.mode, "token");
    assert.equal(c.gateway.controlUi.enabled, false);
    assert.equal(c.discovery.mdns.mode, "off");
    const text = JSON.stringify(c).toLowerCase();
    for (const word of ["funnel", "tunnel", "0.0.0.0"]) assert.ok(!text.includes(word), `no ${word} in the config`);
  });

  test(`${name}: Telegram DMs from the owner's numeric ID only; no groups, no owner commands, no bot token in the file`, () => {
    const c = load(name);
    const t = c.channels.telegram;
    assert.equal(t.dmPolicy, "allowlist", "only allowlisted senders reach the relay; never pairing or open");
    assert.deepEqual(t.allowFrom, ["${TELEGRAM_OWNER_ID}"], "exactly one sender: the owner's ID from the Keychain");
    assert.equal(t.groupPolicy, "disabled");
    assert.ok(!("groupAllowFrom" in t) && !("groups" in t) && !("accounts" in t), "no groups and no extra bot accounts");
    assert.ok(!("botToken" in t) && !("tokenFile" in t), "the bot token comes from the Keychain via TELEGRAM_BOT_TOKEN, never the config");
    assert.ok(!("webhookUrl" in t), "polling only: no inbound webhook port");
    assert.ok(!c.commands?.ownerAllowFrom, "no OpenClaw owner commands are granted");
    assert.deepEqual(Object.keys(c.channels), ["telegram"], "Telegram is the only channel");
  });

  test(`${name}: every secret-looking value is only a \${ENV} reference`, () => {
    const walk = (v, path) => {
      if (v && typeof v === "object") return Object.entries(v).forEach(([k, x]) => walk(x, `${path}.${k}`));
      if (/token|secret|password|apikey|api_key/i.test(path) && typeof v === "string" && !/^(token|none)$/.test(v)) {
        assert.match(v, /^\$\{[A-Z0-9_]+\}$/, `${path} must reference an environment variable, not hold a value`);
      }
    };
    walk(load(name), "");
  });
}

// Telegram bot tokens look like 123456789:AA… ; also catch any long random string a token or key would be.
const TOKEN_LIKE = [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/, /\b[A-Fa-f0-9]{40,}\b/, /\b[A-Za-z0-9_-]{48,}\b/];
const tracked = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  if (f === "node_modules" || f === ".openclaw") return [];
  return statSync(p).isDirectory() ? tracked(p) : [p];
});

test("no token-like value in any OpenClaw file in the repo", () => {
  for (const file of tracked(HERE)) {
    const text = readFileSync(file, "utf8");
    for (const re of TOKEN_LIKE) assert.ok(!re.test(text), `${relative(HERE, file)} contains something that looks like a secret (${re})`);
  }
});

test("openclaw stays pinned to one exact version", () => {
  const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
  assert.match(pkg.dependencies.openclaw, /^\d{4}\.\d+\.\d+$/, "an exact version, no ^ or ~");
  assert.equal(pkg.dependencies.openclaw, "2026.10.10");
});

test("bin/gateway names every secret by its Keychain item and never writes a token into config", () => {
  const sh = readFileSync(join(HERE, "bin/gateway"), "utf8");
  assert.match(sh, /need OPENCLAW_GATEWAY_TOKEN jarvis\.openclaw-gateway/);
  assert.match(sh, /need JARVIS_RELAY_TOKEN jarvis\.openclaw-relay/);
  assert.match(sh, /need_entered TELEGRAM_BOT_TOKEN jarvis\.openclaw-telegram /);
  assert.match(sh, /need_entered TELEGRAM_OWNER_ID jarvis\.openclaw-telegram-owner /);
  assert.match(sh, /unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN/);
  assert.ok(!/channels add/.test(sh));
});
