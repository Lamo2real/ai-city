import { test } from "node:test";
import assert from "node:assert/strict";
import { run, parseArgs } from "../bin/jarvis-safari";
import { SafariError } from "../safari/errors.js";

function deps(stdin = "") {
  const calls = [];
  const rec = (n) => async (...a) => (calls.push([n, ...a]), { ok: true });
  const safari = Object.fromEntries(["windows", "tabs", "open", "switchTo", "close", "closeWindow", "navigate", "history", "read", "html", "js", "click", "fill", "submit", "wait"].map((n) => [n, rec(n)]));
  return { calls, safari, readStdin: async () => stdin };
}
const out = async (argv, d) => { const r = await run(argv, d); return { code: r.code, json: JSON.parse(r.line), line: r.line }; };

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["fill", "#a", "-5", "--tab", "2:3"]), { cmd: "fill", args: ["#a", "-5"], flags: { tab: "2:3" } });
  assert.throws(() => parseArgs(["wait", "x", "--timeout"]), /needs a value/);
});

test("every command reaches the right method with the right arguments", async () => {
  const d = deps();
  const cases = [
    [["windows"], ["windows"]], [["tabs"], ["tabs"]],
    [["open", "a.test", "--new-window"], ["open", "a.test", "window"]], [["open", "a.test"], ["open", "a.test", "tab"]],
    [["switch", "2", "3"], ["switchTo", 2, 3]], [["close", "1", "2"], ["close", 1, 2]], [["close-window", "4"], ["closeWindow", 4]],
    [["navigate", "a.test", "--tab", "2:1"], ["navigate", { window: 2, index: 1 }, "a.test"]],
    [["back"], ["history", { window: 1, index: 0 }, "back"]], [["forward"], ["history", { window: 1, index: 0 }, "forward"]], [["reload"], ["history", { window: 1, index: 0 }, "reload"]],
    [["read", "--tab", "1:2"], ["read", { window: 1, index: 2 }]], [["html", "--selector", "main"], ["html", { window: 1, index: 0 }, "main"]],
    [["click", "#b", "--spend-ticket", "t-1", "--amount", "12.5"], ["click", { window: 1, index: 0 }, "#b", { spendTicket: "t-1", amount: "12.5" }]],
    [["submit", "form"], ["submit", { window: 1, index: 0 }, "form", { spendTicket: undefined, amount: undefined }]],
    [["wait", "#x", "--timeout", "3"], ["wait", { window: 1, index: 0 }, "#x", 3]],
  ];
  for (const [argv, expected] of cases) {
    d.calls.length = 0;
    const r = await out(argv, d);
    assert.equal(r.code, 0, argv.join(" "));
    assert.deepEqual(d.calls[0], expected, argv.join(" "));
    assert.equal(r.line.includes("\n"), false);
  }
});

test("js and fill read code and values from stdin with -", async () => {
  const d = deps("document.title\n");
  await out(["js", "-"], d);
  assert.deepEqual(d.calls[0].slice(0, 3), ["js", { window: 1, index: 0 }, "document.title"]);
  await out(["fill", "#q", "-"], d);
  assert.deepEqual(d.calls[1], ["fill", { window: 1, index: 0 }, "#q", "document.title"]);
});

test("errors print {error, message} and exit 1; usage mistakes too", async () => {
  const d = deps();
  d.safari.read = async () => { throw new SafariError("PASSWORD_FIELD", "You type passwords and codes yourself, sir."); };
  assert.deepEqual(await out(["read"], d), { code: 1, json: { error: "PASSWORD_FIELD", message: "You type passwords and codes yourself, sir." }, line: JSON.stringify({ error: "PASSWORD_FIELD", message: "You type passwords and codes yourself, sir." }) });
  for (const argv of [["bogus"], ["open"], ["switch", "x", "1"], ["read", "--tab", "bad"], ["wait", "#a", "--timeout", "0"]]) {
    const r = await out(argv, d);
    assert.deepEqual([r.code, r.json.error], [1, "USAGE"], argv.join(" "));
  }
  assert.ok((await out(["help"], d)).json.help);
});
