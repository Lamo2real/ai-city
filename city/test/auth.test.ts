import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiKeyRefused, assertNoApiKey, sdkEnv } from "../src/auth.ts";

test("an API key refuses to start unless JARVIS_ALLOW_API_KEY=1", () => {
  assert.throws(() => assertNoApiKey({ ANTHROPIC_API_KEY: "sk-ant-x" }), ApiKeyRefused);
  assert.doesNotThrow(() => assertNoApiKey({ ANTHROPIC_API_KEY: "sk-ant-x", JARVIS_ALLOW_API_KEY: "1" }));
  assert.doesNotThrow(() => assertNoApiKey({}));
});

test("the SDK env has no API key and takes the OAuth token from the Keychain when unset", async () => {
  const asked: string[] = [];
  const env = await sdkEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk", JARVIS_ALLOW_API_KEY: "1" }, async (s) => { asked.push(s); return "tok"; });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "tok");
  assert.deepEqual(asked, ["jarvis.claude-oauth"]);
  const kept = await sdkEnv({ CLAUDE_CODE_OAUTH_TOKEN: "mine", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "outer", CLAUDE_AGENT_SDK_VERSION: "x" }, async () => { throw new Error("not asked"); });
  assert.equal(kept.CLAUDE_CODE_OAUTH_TOKEN, "mine");
  assert.deepEqual(Object.keys(kept), ["CLAUDE_CODE_OAUTH_TOKEN"], "a surrounding Claude Code session's variables never reach an agent");
  const none = await sdkEnv({ PATH: "/bin" }, async () => undefined);
  assert.equal(none.CLAUDE_CODE_OAUTH_TOKEN, undefined, "the logged-in CLI is enough");
});
