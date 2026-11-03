// Billing guard. Everything runs on the owner's Claude subscription through the
// logged-in `claude` CLI or an OAuth token from the Keychain. Never an API key.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const OAUTH_KEYCHAIN_ITEM = "jarvis.claude-oauth";

export class ApiKeyRefused extends Error {}

export function assertNoApiKey(env: NodeJS.ProcessEnv = process.env): void {
  if (env.ANTHROPIC_API_KEY && env.JARVIS_ALLOW_API_KEY !== "1") {
    throw new ApiKeyRefused(
      "ANTHROPIC_API_KEY is set. AI City runs on the Claude subscription (the logged-in `claude` CLI or Keychain item jarvis.claude-oauth), never on pay-per-use billing. Unset it, or set JARVIS_ALLOW_API_KEY=1 if you really mean it.",
    );
  }
}

export async function readKeychain(service: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", service, "-w"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

// The environment the SDK's Claude process gets: no API key, and the OAuth token
// from the Keychain if the CLI is not already logged in through its own store.
export async function sdkEnv(env: NodeJS.ProcessEnv = process.env, keychain: (s: string) => Promise<string | undefined> = readKeychain): Promise<Record<string, string>> {
  assertNoApiKey(env);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== "ANTHROPIC_API_KEY") out[k] = v;
  if (!out.CLAUDE_CODE_OAUTH_TOKEN) {
    const token = await keychain(OAUTH_KEYCHAIN_ITEM);
    if (token) out.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
  return out;
}
