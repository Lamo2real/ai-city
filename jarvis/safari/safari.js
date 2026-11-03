// Safari commands with the owner's rules enforced in code: no passwords or codes, payments need approval,
// page content is labelled as data, and risky actions are audited.
import { SafariError, MESSAGES } from "./errors.js";
import { pageJs, isPaymentPage, writesSensitiveField, wrapContent } from "./page.js";

const REFUSED = new Set(["PASSWORD_FIELD", "SPEND_NEEDS_APPROVAL"]);
const PAGE_MESSAGES = {
  ...MESSAGES,
  BAD_SELECTOR: "That isn't a valid CSS selector.",
  NOT_A_FORM: "That selector isn't a form.",
  NOT_FILLABLE: "That element can't be filled in.",
  EVAL_BLOCKED: "The page blocks script evaluation.",
};

export function normalizeUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new SafariError("BAD_URL", "I need a URL.");
  const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try { parsed = new URL(url); } catch { throw new SafariError("BAD_URL", "That doesn't look like a URL."); }
  // javascript: and data: URLs would run code in a page without passing the guards.
  if (!["http:", "https:", "file:", "about:"].includes(parsed.protocol)) throw new SafariError("BAD_URL", "I only open http, https and file addresses.");
  return url;
}

export function createSafari({ mac, audit, isApproved, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  async function ensureRunning() {
    if (!(await mac.isRunning())) await mac.launch();
  }

  // Runs a page script and parses its single JSON answer. In-page errors become SafariErrors.
  async function page(tab, source) {
    const out = await mac.runJs(tab.window, tab.index, source);
    let data;
    try { data = JSON.parse(out); } catch { throw new SafariError("SAFARI_ERROR", "The page gave an unreadable answer."); }
    if (data.error) throw new SafariError(data.error, PAGE_MESSAGES[data.error] ?? data.error);
    return data;
  }

  function record(entry) {
    try { audit.append({ ...entry }); return {}; } catch { return { audit_warning: "I couldn't write the audit log." }; }
  }

  // Payment gate for click / submit / js. Returns { url, spendTicket? } or throws SPEND_NEEDS_APPROVAL.
  async function gate(tab, spendTicket) {
    const probe = await page(tab, pageJs.probe());
    if (!isPaymentPage(probe)) return { url: probe.url };
    if (spendTicket && (await isApproved(spendTicket))) return { url: probe.url, spendTicket };
    const msg = spendTicket ? `${MESSAGES.SPEND_NEEDS_APPROVAL} That ticket isn't a finished approval from the orchestrator.` : MESSAGES.SPEND_NEEDS_APPROVAL;
    throw Object.assign(new SafariError("SPEND_NEEDS_APPROVAL", msg), { url: probe.url, spend_ticket: spendTicket });
  }

  // Runs an action and writes the audit line: the result, or the refusal / failure code.
  // `out.spend_ticket` (if any) goes to the audit line, not to the output. `worthLogging` filters successes.
  async function audited(meta, fn, worthLogging = () => true) {
    let out;
    try {
      out = await fn();
    } catch (err) {
      record({ ...meta, url: err.url, spend_ticket: err.spend_ticket, result: `${REFUSED.has(err.code) ? "refused" : "error"}:${err.code ?? "ERROR"}` });
      throw err;
    }
    const { spend_ticket, ...rest } = out;
    return worthLogging(out) ? { ...rest, ...record({ ...meta, url: out.url, spend_ticket, result: "ok" }) } : rest;
  }

  const opened = async (fn) => { await ensureRunning(); return fn(); };

  return {
    windows: () => opened(async () => ({ windows: await mac.windows() })),
    tabs: () => opened(async () => ({ tabs: await mac.tabs() })),
    open: (url, mode) => opened(async () => { await mac.open(normalizeUrl(url), mode === "window" ? "window" : "tab"); return { ok: true }; }),
    switchTo: (w, t) => opened(async () => { await mac.switchTo(w, t); return { ok: true }; }),
    close: (w, t) => opened(async () => { await mac.closeTab(w, t); return { ok: true }; }),
    closeWindow: (w) => opened(async () => { await mac.closeWindow(w); return { ok: true }; }),
    navigate: (tab, url) => opened(async () => { await mac.navigate(tab.window, tab.index, normalizeUrl(url)); return { ok: true }; }),
    history: (tab, dir) => opened(async () => { await page(tab, pageJs.history(dir)); return { ok: true }; }),

    read: (tab) => opened(async () => {
      const p = await page(tab, pageJs.read());
      return { url: p.url, truncated: p.truncated, content: wrapContent(`Title: ${p.title}\n\n${p.text}`) };
    }),
    html: (tab, selector) => opened(async () => {
      const p = await page(tab, pageJs.html(selector));
      return { url: p.url, truncated: p.truncated, content: wrapContent(p.html) };
    }),

    js: (tab, code, { spendTicket } = {}) => opened(() =>
      audited({ action: "js", selector: null }, async () => {
        if (writesSensitiveField(code)) throw new SafariError("PASSWORD_FIELD", MESSAGES.PASSWORD_FIELD);
        const g = await gate(tab, spendTicket);
        let p = await page(tab, pageJs.js(code)).catch((e) => (e.code === "EVAL_BLOCKED" ? null : Promise.reject(e)));
        if (p === null) p = { url: g.url, value: JSON.stringify(await mac.runJs(tab.window, tab.index, pageJs.rawJs(code))), raw: true };
        const text = p.jsError ? `Error: ${p.jsError}` : p.value;
        return { url: p.url ?? g.url, content: wrapContent(text), ...(p.truncated && { truncated: true }), ...(p.raw && { note: "The page blocks eval, so this is Safari's plain-text result." }), spend_ticket: g.spendTicket };
      })),

    click: (tab, selector, { spendTicket } = {}) => opened(() =>
      audited({ action: "click", selector }, async () => {
        const g = await gate(tab, spendTicket);
        const p = await page(tab, pageJs.click(selector));
        return { ok: true, url: p.url, submits: p.submits, spend_ticket: g.spendTicket };
      }, (out) => out.submits || out.spend_ticket)),

    fill: (tab, selector, value) => opened(() =>
      audited({ action: "fill", selector }, async () => {
        const p = await page(tab, pageJs.fill(selector, value));
        return { ok: true, url: p.url };
      })),

    submit: (tab, selector, { spendTicket } = {}) => opened(() =>
      audited({ action: "submit", selector }, async () => {
        const g = await gate(tab, spendTicket);
        const p = await page(tab, pageJs.submit(selector));
        return { ok: true, url: p.url ?? g.url, spend_ticket: g.spendTicket };
      })),

    async wait(tab, selector, timeoutS = 10) {
      await ensureRunning();
      const end = now() + timeoutS * 1000;
      for (;;) {
        if ((await page(tab, pageJs.exists(selector))).found) return { ok: true, found: true };
        if (now() >= end) throw new SafariError("WAIT_TIMEOUT", `"${selector}" didn't appear within ${timeoutS} seconds.`);
        await sleep(500);
      }
    },
  };
}
