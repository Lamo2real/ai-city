// AppleScript control of the Spotify desktop app. Values travel as `on run argv` arguments,
// never inside the script text, so a URI or a number can't inject script code.
import { execFile as nodeExecFile } from "node:child_process";

const wrap = (body) => `on run argv\n${body}\nend run`;
const tell = (cmd) => wrap(`tell application "Spotify" to ${cmd}`);

const SCRIPTS = {
  open: tell("activate"),
  playUri: tell("play track (item 1 of argv)"),
  play: tell("play"),
  pause: tell("pause"),
  playpause: tell("playpause"),
  next: tell("next track"),
  previous: tell("previous track"),
  setVolume: tell("set sound volume to (item 1 of argv as integer)"),
  setShuffle: tell("set shuffling to ((item 1 of argv) is \"true\")"),
  isRunning: wrap('return (application "Spotify" is running) as text'),
  nowPlaying: wrap(`if application "Spotify" is not running then return "not running"
tell application "Spotify"
set stateText to player state as text
if stateText is "stopped" then return stateText
return stateText & tab & (name of current track) & tab & (artist of current track) & tab & (album of current track) & tab & (spotify url of current track)
end tell`),
};

export function createMac({ execFile = nodeExecFile } = {}) {
  const osa = (script, ...args) =>
    new Promise((resolve, reject) => {
      execFile("osascript", ["-e", script, ...args.map(String)], { timeout: 15_000 }, (err, stdout) =>
        err ? reject(err) : resolve(String(stdout).trim()),
      );
    });
  const run = (name, ...args) => osa(SCRIPTS[name], ...args);
  return {
    open: () => run("open"),
    playUri: (uri) => run("playUri", uri),
    play: () => run("play"),
    pause: () => run("pause"),
    playpause: () => run("playpause"),
    next: () => run("next"),
    previous: () => run("previous"),
    setVolume: (pct) => run("setVolume", Math.max(0, Math.min(100, Math.round(Number(pct))))),
    setShuffle: (on) => run("setShuffle", on ? "true" : "false"),
    isRunning: async () => (await run("isRunning")) === "true",
    async nowPlaying() {
      const out = await run("nowPlaying");
      if (out === "not running") return { running: false, state: "not running" };
      const [state, name, artist, album, url] = out.split("\t");
      return { running: true, state, ...(name !== undefined && { name, artist, album, url }) };
    },
  };
}

export const mac = createMac();
export const { open, playUri, play, pause, playpause, next, previous, setVolume, setShuffle, nowPlaying, isRunning } = mac;
