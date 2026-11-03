import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { JARVIS_BIN, withJarvisBin } from "../server/city-chat.js";

test("agents get jarvis/bin first on PATH, once, without touching the rest", () => {
  assert.ok(existsSync(join(JARVIS_BIN, "jarvis-spotify")));
  const env = withJarvisBin({ PATH: ["/usr/bin", JARVIS_BIN, "/bin"].join(delimiter), HOME: "/h" });
  assert.deepEqual(env.PATH.split(delimiter), [JARVIS_BIN, "/usr/bin", "/bin"]);
  assert.equal(env.HOME, "/h");
  assert.equal(withJarvisBin({}).PATH, JARVIS_BIN);
});
