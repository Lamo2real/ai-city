// One error type for every Safari failure Jarvis must explain. `code` is stable; `message` is a plain sentence.
export class SafariError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SafariError";
    this.code = code;
  }
}

export const MESSAGES = {
  PASSWORD_FIELD: "You type passwords and codes yourself, sir.",
  SPEND_NEEDS_APPROVAL: "Payments go through the approval gate: I'll ask the orchestrator.",
  AUTOMATION_DENIED: "macOS isn't letting me control Safari. Allow it in System Settings → Privacy & Security → Automation (tick Safari under the app that runs Jarvis), then try again.",
  JS_DISABLED: "Safari is blocking scripts from Apple Events. Turn on Develop → Developer Settings → Allow JavaScript from Apple Events (see docs/safari-setup.md), then try again.",
  NO_SUCH_TAB: "There's no such Safari window or tab. Run `jarvis-safari tabs` to see what's open.",
  NO_SUCH_ELEMENT: "I couldn't find that element on the page.",
};

// Turns an osascript failure into a SafariError. Only stderr is used: err.message repeats the script text.
export function mapOsaError(err) {
  if (err instanceof SafariError) return err;
  const text = String(err?.stderr || "").trim();
  if (/-1743|not authori[sz]ed to send apple events/i.test(text)) return new SafariError("AUTOMATION_DENIED", MESSAGES.AUTOMATION_DENIED);
  if (/allow javascript from apple events/i.test(text)) return new SafariError("JS_DISABLED", MESSAGES.JS_DISABLED);
  if (/-1728|-1719|invalid index|can.t get (window|tab|document)/i.test(text)) return new SafariError("NO_SUCH_TAB", MESSAGES.NO_SUCH_TAB);
  if (err?.killed || err?.code === "ETIMEDOUT") return new SafariError("SAFARI_ERROR", "Safari didn't answer in time.");
  const line = text.split("\n").filter(Boolean).pop() || "Safari failed.";
  return new SafariError("SAFARI_ERROR", line.replace(/^\d+:\d+: /, "").slice(0, 300));
}
