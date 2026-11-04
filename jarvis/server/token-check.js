// A Bearer token checked against a Keychain item: SHA-256 of both sides, compared in constant time.
// The item is read on first use and re-read at most every `rereadMs` when a token doesn't match,
// so rotating it (re-pairing) needs no restart. Tokens are never logged.
import { createHash, timingSafeEqual } from "node:crypto";

const sha = (s) => createHash("sha256").update(s).digest();
export const bearer = (req) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";

export function createTokenCheck({ keychain, service, now = Date.now, rereadMs = 10_000, logger = () => {} }) {
  let expected = null;
  let readAt = -Infinity;

  async function load() {
    readAt = now();
    try {
      const token = await keychain.get(service);
      expected = token ? sha(token) : null;
    } catch {
      expected = null;
      logger(`${service} could not be read from Keychain`);
    }
  }
  const matches = (hash) => expected !== null && timingSafeEqual(hash, expected);

  // The hash of the token when it is right, else null.
  return async function check(token) {
    if (!token) return null;
    const hash = sha(token);
    if (readAt === -Infinity) await load();
    if (matches(hash)) return hash;
    if (now() - readAt >= rereadMs) {
      await load();
      if (matches(hash)) return hash;
    }
    return null;
  };
}
