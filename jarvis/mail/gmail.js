// Gmail REST client. 401 → refresh and retry once; 429/5xx → Retry-After or backoff, at most 2 retries.
import { CODES, MailError } from "./errors.js";
import { redact } from "./redact.js";
import { API_BASE } from "./scopes.js";

const MAX_RETRIES = 2;
const MAX_WAIT_MS = 30_000;
const LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "backendError"]);
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function failure(status, body, retryAfter) {
  const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? "";
  const detail = redact(String(body?.error?.message ?? "")).slice(0, 200);
  if (status === 401) return new MailError(CODES.SIGN_IN_REQUIRED, "Gmail access expired or was revoked. Run jarvis-mail login again.", { status });
  if (status === 403) {
    const scope = /insufficient|scope/i.test(`${reason} ${detail}`);
    return new MailError(CODES.FORBIDDEN, scope ? "Gmail has not granted enough access. Run jarvis-mail login again and allow everything." : `Gmail refused this: ${detail || reason || "access denied"}.`, { status });
  }
  if (status === 404) return new MailError(CODES.NOT_FOUND, "Gmail could not find that message, thread or label.", { status });
  if (status === 429) return new MailError(CODES.RATE_LIMITED, "Gmail is rate limiting requests. Try again shortly.", { status, retryAfter });
  if (status === 400) return new MailError(CODES.BAD_REQUEST, `Gmail rejected the request: ${detail || "bad request"}.`, { status });
  return new MailError(CODES.API, `Gmail failed (${status})${detail ? `: ${detail}` : ""}.`, { status, retryAfter });
}

export function createGmailClient({ tokens, fetch = globalThis.fetch, sleep = sleepMs }) {
  async function request(method, path, { query, body } = {}) {
    const url = new URL(`${API_BASE}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      for (const item of [].concat(v)) if (item !== undefined) url.searchParams.append(k, String(item));
    }
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${await tokens.getAccessToken()}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      if (res.ok) {
        const text = await res.text();
        return text ? JSON.parse(text) : {};
      }
      const data = await res.json().catch(() => ({}));
      const retryAfter = Number(res.headers?.get?.("retry-after")) || undefined;
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await tokens.refresh();
        attempt--;
        continue;
      }
      const reason = data?.error?.errors?.[0]?.reason;
      const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && LIMIT_REASONS.has(reason));
      if (retryable && attempt < MAX_RETRIES) {
        await sleep(Math.min(retryAfter ? retryAfter * 1000 : 500 * 2 ** attempt, MAX_WAIT_MS));
        continue;
      }
      throw failure(retryable && res.status === 403 ? 429 : res.status, data, retryAfter);
    }
  }

  const metadata = { format: "metadata", metadataHeaders: ["From", "To", "Cc", "Subject", "Date", "Message-ID", "References", "In-Reply-To", "Reply-To"] };

  return {
    profile: () => request("GET", "/profile"),
    async list({ query, limit = 10 }) {
      const found = await request("GET", "/messages", { query: { q: query, maxResults: limit } });
      const messages = await Promise.all((found.messages ?? []).map((m) => request("GET", `/messages/${encodeURIComponent(m.id)}`, { query: metadata })));
      return messages.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
    },
    get: (id, format = "full") => request("GET", `/messages/${encodeURIComponent(id)}`, { query: format === "metadata" ? metadata : { format } }),
    thread: (id) => request("GET", `/threads/${encodeURIComponent(id)}`, { query: { format: "full" } }),
    labels: () => request("GET", "/labels"),
    modify: (id, { add = [], remove = [] }) => request("POST", `/messages/${encodeURIComponent(id)}/modify`, { body: { addLabelIds: add, removeLabelIds: remove } }),
    trash: (id) => request("POST", `/messages/${encodeURIComponent(id)}/trash`),
    untrash: (id) => request("POST", `/messages/${encodeURIComponent(id)}/untrash`),
    remove: (id) => request("DELETE", `/messages/${encodeURIComponent(id)}`),
    createDraft: (raw, threadId) => request("POST", "/drafts", { body: { message: { raw, ...(threadId && { threadId }) } } }),
    send: (raw, threadId) => request("POST", "/messages/send", { body: { raw, ...(threadId && { threadId }) } }),
    draft: (id) => request("GET", `/drafts/${encodeURIComponent(id)}`, { query: { format: "full" } }),
    sendAs: () => request("GET", "/settings/sendAs"),
    sendDraft: (id) => request("POST", "/drafts/send", { body: { id } }),
  };
}
