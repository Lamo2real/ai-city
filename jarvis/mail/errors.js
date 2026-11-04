// One error type for every Gmail failure Jarvis must explain to the owner.
// `code` is stable (the CLI prints it as JSON); `message` is a plain sentence Jarvis can say.
export const CODES = {
  NOT_CONFIGURED: "NOT_CONFIGURED", // no client ID/secret in Keychain: run `jarvis-mail setup`
  SIGN_IN_REQUIRED: "SIGN_IN_REQUIRED", // no tokens, or refresh rejected: run `jarvis-mail login`
  FORBIDDEN: "FORBIDDEN", // 403: missing scope or access denied
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED", // 429; `retryAfter` seconds
  BAD_REQUEST: "BAD_REQUEST", // the command was used wrongly
  API: "API", // anything else
};

export class MailError extends Error {
  constructor(code, message, { status, retryAfter, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "MailError";
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}
