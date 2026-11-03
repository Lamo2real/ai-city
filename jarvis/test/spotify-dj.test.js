import { test } from "node:test";
import assert from "node:assert/strict";
import { startDj } from "../spotify/dj.js";
import { DJ_URI } from "../spotify/scopes.js";

const playingDj = { is_playing: true, item: null, context: { uri: DJ_URI } };

function fakes({ nowSeq, webPlayFails = false, macState = "playing" }) {
  const log = [];
  const seq = [...nowSeq];
  const client = {
    devices: async () => [{ id: "mac1", type: "Computer" }],
    play: async (a) => { log.push(["web", a]); if (webPlayFails) throw new Error("boom"); },
    nowPlaying: async () => { const v = seq.length > 1 ? seq.shift() : seq[0]; if (v instanceof Error) throw v; return v; },
  };
  const mac = { playUri: async (u) => log.push(["mac", u]), nowPlaying: async () => ({ state: macState }) };
  return { client, mac, log, sleep: async () => {} };
}

test("web API route confirmed even when item is null", async () => {
  const f = fakes({ nowSeq: [playingDj] });
  assert.deepEqual(await startDj(f), { ok: true, via: "web-api" });
  assert.deepEqual(f.log, [["web", { uri: DJ_URI, deviceId: "mac1" }]]);
});

test("falls back to AppleScript when the web API silently stops", async () => {
  const f = fakes({ nowSeq: [{ is_playing: false, context: { uri: DJ_URI } }, playingDj] });
  assert.deepEqual(await startDj(f), { ok: true, via: "applescript" });
  assert.deepEqual(f.log.map((l) => l[0]), ["web", "mac"]);
  assert.equal(f.log[1][1], DJ_URI);
});

test("web play error goes straight to AppleScript; unverifiable uses player state", async () => {
  const f = fakes({ nowSeq: [new Error("signed out")], webPlayFails: true });
  assert.deepEqual(await startDj(f), { ok: true, via: "applescript" });
});

test("honest failure when neither route is confirmed", async () => {
  const f = fakes({ nowSeq: [{ is_playing: false }], macState: "paused" });
  const r = await startDj(f);
  assert.equal(r.ok, false);
  assert.match(r.message, /doesn't let apps start DJ reliably/);
});

test("wrong context after AppleScript is a failure, not a false positive", async () => {
  const f = fakes({ nowSeq: [{ is_playing: true, context: { uri: "spotify:playlist:other" } }] });
  assert.equal((await startDj(f)).ok, false);
});
