// Non-allowlisted senders never reach Jarvis: our real openclaw.json allowlist, run through OpenClaw's own
// sender check (openclaw/plugin-sdk/allow-from, the pinned 2026.10.10). The relay agent only ever sees
// messages that pass it, so a stranger's message never becomes an ask_jarvis call.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isSenderIdAllowed } from "openclaw/plugin-sdk/allow-from";

const JSON5 = createRequire(import.meta.url)("json5");
const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "123456789";

// What OpenClaw does with "${TELEGRAM_OWNER_ID}": substitute it, or leave it visibly unresolved when unset.
const resolve = (entries, env) => entries.map((e) => e.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (m, k) => env[k] || m));
const allowFrom = (env) => {
  const entries = resolve(JSON5.parse(readFileSync(join(HERE, "openclaw.json"), "utf8")).channels.telegram.allowFrom, env);
  return { entries, hasWildcard: entries.includes("*"), hasEntries: entries.length > 0 };
};
const allowed = (sender, env = { TELEGRAM_OWNER_ID: OWNER }) => isSenderIdAllowed(allowFrom(env), sender, false);

test("the owner's own Telegram ID is let through", () => {
  assert.equal(allowed(OWNER), true);
});

test("anyone else is dropped before the relay: other IDs, near misses, empty and username senders", () => {
  for (const sender of ["987654321", "12345678", "1234567890", "123456789 ", "", undefined, "@lamo", "*"]) {
    assert.equal(allowed(sender), false, `sender ${JSON.stringify(sender)}`);
  }
});

test("if the owner ID was never set, the unresolved reference matches nobody, not everybody", () => {
  // Telegram sender IDs are always numeric, so the literal "${TELEGRAM_OWNER_ID}" can't belong to anyone.
  // bin/gateway also refuses to start without the ID (test/gateway-start.test.js).
  assert.equal(allowed(OWNER, {}), false);
  assert.equal(allowed("987654321", {}), false);
});

test("why bin/gateway refuses a wildcard owner ID: OpenClaw would then let everyone in", () => {
  assert.equal(allowed("987654321", { TELEGRAM_OWNER_ID: "*" }), true);
});
