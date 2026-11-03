// One error type for every Spotify failure Jarvis must explain to the owner.
// `code` is stable (the CLI prints it as JSON); `message` is a plain sentence Jarvis can say.
export const CODES = {
  NOT_CONFIGURED: "NOT_CONFIGURED", // no Client ID in Keychain: run `jarvis-spotify setup`
  SIGN_IN_REQUIRED: "SIGN_IN_REQUIRED", // no tokens, or refresh rejected (revoked/expired): run `jarvis-spotify login`
  PREMIUM_REQUIRED: "PREMIUM_REQUIRED", // 403 on a player endpoint
  NO_ACTIVE_DEVICE: "NO_ACTIVE_DEVICE", // 404 NO_ACTIVE_DEVICE and the Mac could not be woken
  RATE_LIMITED: "RATE_LIMITED", // 429; `retryAfter` seconds
  FORBIDDEN: "FORBIDDEN", // other 403 (missing scope, dev-mode user not allow-listed, restricted endpoint)
  NOT_FOUND: "NOT_FOUND",
  API: "API", // anything else
};

export class SpotifyError extends Error {
  constructor(code, message, { status, retryAfter, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SpotifyError";
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
  toJSON() {
    return { error: this.code, message: this.message, ...(this.status && { status: this.status }), ...(this.retryAfter !== undefined && { retry_after: this.retryAfter }) };
  }
}
