// The native Mac app: its source compiles, and its bundle asks for what the HUD needs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const app = (name) => new URL(`../app/${name}`, import.meta.url).pathname;
const skip = process.platform !== "darwin" || spawnSync("swiftc", ["--version"]).status !== 0 ? "needs a Mac with swiftc" : false;

test("the Mac app compiles", { skip }, () => {
  execFileSync("swiftc", ["-typecheck", "-swift-version", "5", "-parse-as-library", app("Jarvis.swift")], { stdio: "pipe" });
});

test("the bundle shows in the Dock, can ask for the microphone, and no longer needs Chrome", () => {
  const plist = readFileSync(app("Info.plist"), "utf8");
  assert.ok(!plist.includes("LSUIElement"), "LSUIElement would hide it from the Dock");
  assert.match(plist, /NSMicrophoneUsageDescription/);
  assert.ok(!existsSync(app("launcher.sh")));
  const source = readFileSync(app("Jarvis.swift"), "utf8");
  assert.match(source, /localhost:7777\/\?view=city/, "opens on the City");
  assert.match(source, /type == \.microphone \? \.grant : \.deny/, "the microphone is granted to Jarvis's page only");
});
