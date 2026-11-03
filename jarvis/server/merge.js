// Merges to main. The model can only ask (guard.js writes a request file); the
// owner confirms here, by button or by saying exactly "I confirm", and this
// server runs the merge itself, pinned to the commit the owner was shown.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const CONFIRM_MS = 120_000;

export const isConfirmPhrase = (text) => String(text ?? "").trim().toLowerCase().replace(/[.!,]+$/, "") === "i confirm";

export function ciSummary(checks = []) {
  const states = checks.map((c) => String(c.conclusion || c.state || c.status || "").toUpperCase());
  const failed = states.filter((s) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(s)).length;
  const pending = states.filter((s) => ["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED", "WAITING"].includes(s)).length;
  if (failed) return `${failed} failed`;
  if (pending) return `${pending} still running`;
  return states.length ? `${states.length} passed` : "no checks";
}

export function createMergeGate({ dataDir, logger = () => {}, now = Date.now }) {
  const pending = new Map();

  function current(sessionId) {
    const item = pending.get(sessionId);
    if (item && item.expires <= now()) {
      pending.delete(sessionId);
      return null;
    }
    return item ?? null;
  }

  return {
    requestFile: () => join(dataDir, `merge-request-${randomUUID()}.json`),

    // Called after a turn. Returns true if that turn asked for a merge to main.
    collect(file, sessionId) {
      let request;
      try {
        request = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return false;
      }
      rmSync(file, { force: true });
      pending.set(sessionId, { ...request, id: randomUUID(), expires: now() + CONFIRM_MS });
      logger(`merge to main awaiting confirmation: ${request.repo}#${request.number}`);
      return true;
    },

    current,

    describe(sessionId) {
      const item = current(sessionId);
      if (!item) return null;
      const { id, repo, number, title, url, ci, mergeable } = item;
      return { id, repo, number, title, url, ci, mergeable, expiresInMs: item.expires - now() };
    },

    prompt(sessionId) {
      const item = current(sessionId);
      if (!item) return null;
      const name = item.repo.split("/").pop();
      return `The ${name} pull request, ${item.title}, to main. Checks: ${item.ci}. This goes to production. Press Merge, or say exactly: I confirm.`;
    },

    cancel(sessionId, id) {
      const item = current(sessionId);
      if (!item || (id && item.id !== id)) return false;
      pending.delete(sessionId);
      logger(`merge to main cancelled: ${item.repo}#${item.number}`);
      return true;
    },

    // Single use: the confirmation is spent even if the merge then fails.
    async confirm(sessionId, id) {
      const item = current(sessionId);
      if (!item || (id && item.id !== id)) return null;
      pending.delete(sessionId);
      const name = `The ${item.repo.split("/").pop()} pull request`;
      try {
        await run("gh", ["pr", "merge", String(item.number), "-R", item.repo, "--squash", "--match-head-commit", item.head], { timeout: 60_000 });
      } catch (err) {
        logger(`merge to main failed: ${item.repo}#${item.number}: ${String(err.stderr ?? err.message).slice(0, 300)}`);
        return { ok: false, reply: `I could not merge ${name.replace("The", "the")}, sir. GitHub refused it, or the branch changed after you confirmed. Nothing was merged.` };
      }
      logger(`merged to main: ${item.repo}#${item.number} at ${item.head}`);
      return { ok: true, reply: `${name} is merged to main, sir. The production deploy starts now.` };
    },
  };
}
