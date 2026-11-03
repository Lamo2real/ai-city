// AppleScript control of Safari. Every value (URL, indices, JavaScript source) travels as an
// `on run argv` argument, never inside the script text, so nothing can inject script code.
import { execFile as nodeExecFile } from "node:child_process";
import { mapOsaError } from "./errors.js";

const wrap = (body) => `on run argv\n${body}\nend run`;
const US = "(ASCII character 31)";
const RS = "(ASCII character 30)";
// tb = the tab addressed by argv items 1 (window) and 2 (tab; 0 = current tab).
const PICK = `set w to (item 1 of argv as integer)
set t to (item 2 of argv as integer)
if t is 0 then
set tb to current tab of window w
else
set tb to tab t of window w
end if`;

export const SCRIPTS = {
  isRunning: wrap('return (application "Safari" is running) as text'),
  launch: wrap('tell application "Safari" to launch'),
  windows: wrap(`tell application "Safari"
set out to ""
repeat with i from 1 to (count of windows)
set nm to ""
set c to 0
try
set nm to name of window i
set c to count of tabs of window i
end try
set out to out & i & ${US} & nm & ${US} & c & ${RS}
end repeat
return out
end tell`),
  tabs: wrap(`tell application "Safari"
set out to ""
repeat with i from 1 to (count of windows)
try
set cur to index of current tab of window i
repeat with j from 1 to (count of tabs of window i)
set tb to tab j of window i
set out to out & i & ${US} & j & ${US} & (name of tb) & ${US} & (URL of tb) & ${US} & (j is cur) & ${RS}
end repeat
end try
end repeat
return out
end tell`),
  open: wrap(`set u to item 1 of argv
set mode to item 2 of argv
tell application "Safari"
activate
if mode is "window" or (count of windows) is 0 then
make new document with properties {URL:u}
else
tell window 1 to set current tab to (make new tab with properties {URL:u})
end if
end tell`),
  switch: wrap(`set w to (item 1 of argv as integer)
set t to (item 2 of argv as integer)
tell application "Safari"
set current tab of window w to tab t of window w
set index of window w to 1
end tell`),
  closeTab: wrap(`set w to (item 1 of argv as integer)
set t to (item 2 of argv as integer)
tell application "Safari" to close tab t of window w`),
  closeWindow: wrap(`set w to (item 1 of argv as integer)
tell application "Safari" to close window w`),
  navigate: wrap(`tell application "Safari"
${PICK}
set URL of tb to (item 3 of argv)
end tell`),
  runJs: wrap(`tell application "Safari"
${PICK}
return do JavaScript (item 3 of argv) in tb
end tell`),
};

const rows = (out) => String(out).split("\x1e").filter(Boolean).map((r) => r.split("\x1f"));

export function createSafariMac({ execFile = nodeExecFile } = {}) {
  const osa = (script, ...args) =>
    new Promise((resolve, reject) => {
      execFile("osascript", ["-e", script, ...args.map(String)], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) { err.stderr = err.stderr ?? stderr; reject(mapOsaError(err)); } else resolve(String(stdout).replace(/\n$/, ""));
      });
    });
  return {
    isRunning: async () => (await osa(SCRIPTS.isRunning)) === "true",
    launch: () => osa(SCRIPTS.launch),
    async windows() {
      return rows(await osa(SCRIPTS.windows)).map(([index, title, tabs]) => ({ index: Number(index), title, tabs: Number(tabs) }));
    },
    async tabs() {
      return rows(await osa(SCRIPTS.tabs)).map(([w, t, title, url, active]) => ({ window: Number(w), index: Number(t), title, url, active: active === "true" }));
    },
    open: (url, mode = "tab") => osa(SCRIPTS.open, url, mode),
    switchTo: (w, t) => osa(SCRIPTS.switch, w, t),
    closeTab: (w, t) => osa(SCRIPTS.closeTab, w, t),
    closeWindow: (w) => osa(SCRIPTS.closeWindow, w),
    navigate: (w, t, url) => osa(SCRIPTS.navigate, w, t, url),
    runJs: (w, t, code) => osa(SCRIPTS.runJs, w, t, code),
  };
}
