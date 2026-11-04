import { test } from "node:test";
import assert from "node:assert/strict";
import { createSafariMac, SCRIPTS } from "../safari/mac.js";
import { mapOsaError } from "../safari/errors.js";

function fake(stdout = "", fail) {
  const calls = [];
  const execFile = (bin, args, opts, cb) => {
    calls.push({ bin, script: args[1], args: args.slice(2) });
    fail ? cb(Object.assign(new Error("Command failed: osascript -e SCRIPT"), { stderr: fail }), "", fail) : cb(null, stdout + "\n", "");
  };
  return { calls, mac: createSafariMac({ execFile }) };
}
const EVIL = 'https://x.test/"; do shell script "id" --"';

test("values travel as argv and never appear in the script text", async () => {
  const { calls, mac } = fake();
  await mac.open(EVIL, "window");
  await mac.navigate(2, 3, EVIL);
  await mac.runJs(1, 0, `alert("${EVIL}")`);
  for (const c of calls) {
    assert.equal(c.bin, "osascript");
    assert.ok(!c.script.includes("do shell script"));
    assert.ok(!c.script.includes("x.test"));
  }
  assert.deepEqual(calls[0].args, [EVIL, "window"]);
  assert.deepEqual(calls[1].args, ["2", "3", EVIL]);
  assert.deepEqual(calls[2].args, ["1", "0", `alert("${EVIL}")`]);
});

test("every command uses its script with the right args", async () => {
  const { calls, mac } = fake("");
  await mac.isRunning(); await mac.launch(); await mac.windows(); await mac.tabs();
  await mac.open("https://a.test", "tab"); await mac.switchTo(2, 5); await mac.closeTab(1, 4); await mac.closeWindow(3);
  await mac.navigate(1, 0, "https://b.test"); await mac.runJs(1, 2, "1+1");
  assert.deepEqual(calls.map((c) => c.script), [SCRIPTS.isRunning, SCRIPTS.launch, SCRIPTS.windows, SCRIPTS.tabs, SCRIPTS.open, SCRIPTS.switch, SCRIPTS.closeTab, SCRIPTS.closeWindow, SCRIPTS.navigate, SCRIPTS.runJs]);
  assert.deepEqual(calls.slice(4).map((c) => c.args), [["https://a.test", "tab"], ["2", "5"], ["1", "4"], ["3"], ["1", "0", "https://b.test"], ["1", "2", "1+1"]]);
  assert.match(SCRIPTS.open, /make new tab/);
  assert.match(SCRIPTS.open, /make new document/);
  assert.match(SCRIPTS.runJs, /do JavaScript \(item 3 of argv\)/);
  assert.match(SCRIPTS.closeTab, /close tab t of window w/);
});

test("windows and tabs parse the separator-delimited replies", async () => {
  assert.deepEqual(await fake("1\x1fHome\x1f2\x1e2\x1fDocs\x1f1\x1e").mac.windows(), [{ index: 1, title: "Home", tabs: 2 }, { index: 2, title: "Docs", tabs: 1 }]);
  assert.deepEqual(await fake("1\x1f1\x1fA\x1fhttps://a.test\x1ftrue\x1e1\x1f2\x1fB\x1fhttps://b.test\x1ffalse\x1e").mac.tabs(), [
    { window: 1, index: 1, title: "A", url: "https://a.test", active: true },
    { window: 1, index: 2, title: "B", url: "https://b.test", active: false },
  ]);
  assert.equal(await fake("true").mac.isRunning(), true);
});

test("osascript failures map to plain errors without echoing the script", async () => {
  const cases = [
    ["execution error: Not authorized to send Apple events to Safari. (-1743)", "AUTOMATION_DENIED", /System Settings → Privacy & Security → Automation/],
    ["execution error: Safari got an error: You must enable 'Allow JavaScript from Apple Events' in the Develop menu. (8)", "JS_DISABLED", /Allow JavaScript from Apple Events/],
    ["execution error: Safari got an error: Can’t get window 9. Invalid index. (-1719)", "NO_SUCH_TAB", /no such Safari window or tab/],
    ["execution error: Safari got an error: Can’t get tab 7 of window 1. (-1728)", "NO_SUCH_TAB", /tabs/],
  ];
  for (const [stderr, code, re] of cases) {
    const { mac } = fake("", stderr);
    await assert.rejects(mac.runJs(1, 0, "x"), (e) => e.code === code && re.test(e.message) && !e.message.includes("osascript -e"));
  }
  assert.equal(mapOsaError({ stderr: "5:9: syntax error" }).code, "SAFARI_ERROR");
});
