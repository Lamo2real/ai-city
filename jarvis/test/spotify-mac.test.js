import { test } from "node:test";
import assert from "node:assert/strict";
import { createMac } from "../spotify/mac.js";

function fake(stdout = "") {
  const calls = [];
  const execFile = (bin, args, opts, cb) => { calls.push({ bin, args }); cb(null, stdout); };
  return { calls, mac: createMac({ execFile }) };
}

test("URIs travel as argv, never inside the script", async () => {
  const evil = 'spotify:track:abc" & (do shell script "id") & "';
  const { calls, mac } = fake();
  await mac.playUri(evil);
  const { bin, args } = calls[0];
  assert.equal(bin, "osascript");
  assert.equal(args[0], "-e");
  assert.ok(args.includes(evil));
  assert.ok(!args[1].includes("abc"));
  assert.ok(!args[1].includes("do shell script"));
  assert.match(args[1], /on run argv/);
});

test("volume is clamped and passed as argv; shuffle as true/false", async () => {
  const { calls, mac } = fake();
  await mac.setVolume(250); await mac.setShuffle(false);
  assert.equal(calls[0].args.at(-1), "100");
  assert.equal(calls[1].args.at(-1), "false");
});

test("nowPlaying parses the tab-separated reply; isRunning parses text", async () => {
  assert.deepEqual(await fake("playing\tSong\tBand\tAlbum\tspotify:track:1").mac.nowPlaying(), { running: true, state: "playing", name: "Song", artist: "Band", album: "Album", url: "spotify:track:1" });
  assert.equal((await fake("not running").mac.nowPlaying()).running, false);
  assert.equal(await fake("true").mac.isRunning(), true);
});
