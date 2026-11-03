import { test } from "node:test";
import assert from "node:assert/strict";
import { run, parseArgs } from "../bin/jarvis-spotify";
import { redact } from "../spotify/redact.js";
import { SpotifyError, CODES } from "../spotify/errors.js";

function deps(client = {}, extra = {}) {
  const macCalls = [];
  const rec = (n) => async (...a) => { macCalls.push([n, ...a]); };
  const mac = { playUri: rec("playUri"), play: rec("play"), pause: rec("pause"), next: rec("next"), previous: rec("previous"), setVolume: rec("setVolume"), setShuffle: rec("setShuffle"), nowPlaying: async () => ({ running: true, state: "playing", name: "S" }) };
  return { client, mac, redact, macCalls, store: {}, startDj: async () => ({ ok: true, via: "web-api" }), ...extra };
}
const out = async (argv, d) => { const r = await run(argv, d); return { code: r.code, json: JSON.parse(r.line), line: r.line }; };
const track = { name: "Dancing Queen", artists: [{ name: "ABBA" }], album: { name: "Arrival" }, uri: "spotify:track:1", popularity: 90 };

test("parseArgs splits positionals and flags", () => {
  assert.deepEqual(parseArgs(["search", "hello", "world", "--type", "track,album", "--limit", "3"]), { cmd: "search", args: ["hello", "world"], flags: { type: "track,album", limit: "3" } });
  assert.deepEqual(parseArgs(["playlist-create", "x", "--public"]).flags, { public: true });
  assert.throws(() => parseArgs(["play", "--search"]), /needs a value/);
});

test("search prints one trimmed JSON line", async () => {
  const d = deps({ search: async (q, types, limit) => { d.seen = { q, types, limit }; return { tracks: { items: [track] } }; } });
  const r = await out(["search", "dancing", "queen", "--type", "track", "--limit", "3"], d);
  assert.equal(r.code, 0);
  assert.equal(r.line.includes("\n"), false);
  assert.deepEqual(r.json, { tracks: [{ name: "Dancing Queen", artists: ["ABBA"], album: "Arrival", uri: "spotify:track:1" }] });
  assert.deepEqual(d.seen, { q: "dancing queen", types: ["track"], limit: 3 });
});

test("play --search plays the top result", async () => {
  let played;
  const d = deps({ search: async () => ({ albums: { items: [{ name: "Arrival", artists: [{ name: "ABBA" }], uri: "spotify:album:9" }] } }), play: async (a) => { played = a; return null; } });
  const r = await out(["play", "--search", "arrival", "--type", "album"], d);
  assert.deepEqual(played, { uri: "spotify:album:9" });
  assert.equal(r.json.playing.name, "Arrival");
});

test("now trims, devices, transfer by name", async () => {
  let to;
  const d = deps({
    nowPlaying: async () => ({ is_playing: true, item: track, progress_ms: 61000, device: { id: "d", name: "Mac", type: "Computer", is_active: true } }),
    devices: async () => [{ id: "d1", name: "Kitchen Echo", type: "Speaker", is_active: false }],
    transfer: async (id, play) => { to = [id, play]; },
  });
  const now = await out(["now"], d);
  assert.equal(now.json.progress_s, 61);
  assert.equal(now.json.track.name, "Dancing Queen");
  assert.equal(now.json.device.name, "Mac");
  await out(["transfer", "kitchen"], d);
  assert.deepEqual(to, ["d1", true]);
});

test("playlist items read item.item (new field)", async () => {
  const d = deps({ playlistItems: async () => ({ items: [{ item: track }] }) });
  assert.equal((await out(["playlist", "spotify:playlist:abc"], d)).json.tracks[0].uri, "spotify:track:1");
});

test("AppleScript fallback for basic controls, with via and note", async () => {
  for (const code of [CODES.NOT_CONFIGURED, CODES.SIGN_IN_REQUIRED, CODES.PREMIUM_REQUIRED]) {
    const boom = async () => { throw new SpotifyError(code, "x"); };
    const d = deps({ pause: boom, volume: boom, play: boom, nowPlaying: boom });
    const p = await out(["pause"], d);
    assert.equal(p.code, 0);
    assert.equal(p.json.via, "applescript");
    assert.match(p.json.note, /\S/);
    await out(["volume", "40"], d);
    await out(["play", "spotify:album:1"], d);
    assert.deepEqual(d.macCalls, [["pause"], ["setVolume", 40], ["playUri", "spotify:album:1"]]);
    assert.equal((await out(["now"], d)).json.via, "applescript");
  }
});

test("no fallback for search/library, or for other error codes", async () => {
  const d = deps({ search: async () => { throw new SpotifyError(CODES.SIGN_IN_REQUIRED, "Run login"); }, pause: async () => { throw new SpotifyError(CODES.RATE_LIMITED, "slow", { retryAfter: 30 }); } });
  let r = await out(["search", "x"], d);
  assert.deepEqual([r.code, r.json.error], [1, "SIGN_IN_REQUIRED"]);
  r = await out(["pause"], d);
  assert.deepEqual([r.code, r.json.error, r.json.retry_after], [1, "RATE_LIMITED", 30]);
  assert.equal(d.macCalls.length, 0);
});

test("tokens in error messages are redacted", async () => {
  const d = deps({ pause: async () => { throw new Error("fetch failed: Authorization: Bearer BQD-secret-token-123 access_token=abc123def456"); } });
  const r = await out(["pause"], d);
  assert.equal(r.code, 1);
  assert.ok(!r.line.includes("BQD-secret-token-123"));
  assert.ok(!r.line.includes("abc123def456"));
});

test("dj, setup, status, bad input", async () => {
  let saved;
  const d = deps({}, { store: { setClientId: async (v) => { saved = v; }, status: async () => ({ signedIn: true }) }, promptClientId: async () => "cid-value-123" });
  assert.deepEqual((await out(["dj"], d)).json, { ok: true, via: "web-api" });
  const s = await out(["setup"], d);
  assert.equal(saved, "cid-value-123");
  assert.match(s.json.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal((await out(["status"], d)).json.signedIn, true);
  assert.equal((await out(["volume", "300"], d)).code, 1);
  assert.equal((await out(["shuffle", "maybe"], d)).code, 1);
  assert.equal((await out(["bogus"], d)).json.error, "API");
  assert.ok((await out(["help"], d)).json.help);
});

test("library and playlist write commands pass URIs through", async () => {
  const seen = [];
  const d = deps({
    save: async (u) => seen.push(["save", u]), unsave: async (u) => seen.push(["unsave", u]),
    addToPlaylist: async (p, u) => seen.push(["add", p, u]), removeFromPlaylist: async (p, u) => seen.push(["rm", p, u]),
    createPlaylist: async (n, o) => ({ name: n, uri: "spotify:playlist:n", public: o.public }),
  });
  await out(["save", "spotify:track:1", "spotify:album:2"], d);
  await out(["unsave", "spotify:track:1"], d);
  await out(["playlist-add", "p1", "spotify:track:1"], d);
  await out(["playlist-remove", "p1", "spotify:track:1"], d);
  const c = await out(["playlist-create", "Road", "trip", "--public"], d);
  assert.equal(c.json.playlist.name, "Road trip");
  assert.deepEqual(seen, [["save", ["spotify:track:1", "spotify:album:2"]], ["unsave", ["spotify:track:1"]], ["add", "p1", ["spotify:track:1"]], ["rm", "p1", ["spotify:track:1"]]]);
});

test("account block: premium, free, and product missing", async () => {
  const cases = [
    [{ id: "u", display_name: "Ali", product: "premium" }, (a) => assert.deepEqual([a.premium, a.note], [true, undefined])],
    [{ id: "u", display_name: "Ali", product: "free" }, (a) => assert.deepEqual([a.premium, /isn't Premium/.test(a.note)], [false, true])],
    [{ id: "u", display_name: "Ali" }, (a) => assert.deepEqual([a.premium, /no longer tells apps/.test(a.note), a.name], [null, true, "Ali"])],
  ];
  for (const [me, check] of cases) {
    const d = deps({ me: async () => me }, { store: { status: async () => ({ signedIn: true }) }, signIn: async () => {} });
    for (const cmd of ["status", "login"]) check((await out([cmd], d)).json.account);
  }
});

test("status without sign-in skips the account lookup; a failing me() doesn't fail login", async () => {
  let called = false;
  const d = deps({ me: async () => { called = true; throw new SpotifyError(CODES.SIGN_IN_REQUIRED, "x"); } }, { store: { status: async () => ({ signedIn: false }) }, signIn: async () => {} });
  assert.deepEqual((await out(["status"], d)).json, { signedIn: false });
  assert.equal(called, false);
  const l = await out(["login"], d);
  assert.deepEqual([l.code, l.json.account], [0, undefined]);
});

test("premium fallback note says the account needs Premium", async () => {
  const d = deps({ pause: async () => { throw new SpotifyError(CODES.PREMIUM_REQUIRED, "x"); } });
  assert.match((await out(["pause"], d)).json.note, /needs Spotify Premium/);
});

test("playlist-cover reads the file as base64", async () => {
  let seen;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const d = deps({ setPlaylistCover: async (p, b) => { seen = [p, b]; return null; } }, { readFile: async () => jpeg });
  assert.equal((await out(["playlist-cover", "p1", "/tmp/c.jpg"], d)).json.ok, true);
  assert.deepEqual(seen, ["p1", jpeg.toString("base64")]);
  // Anything that isn't a JPEG never leaves the Mac.
  let uploaded = false;
  const notJpeg = deps({ setPlaylistCover: async () => { uploaded = true; } }, { readFile: async () => Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----") });
  assert.equal((await out(["playlist-cover", "p1", "/Users/x/.ssh/id_ed25519"], notJpeg)).code, 1);
  assert.equal(uploaded, false);
  const bad = deps({}, { readFile: async () => { throw new Error("ENOENT /secret/path"); } });
  assert.equal((await out(["playlist-cover", "p1", "/nope"], bad)).code, 1);
});

test("follow/unfollow go through the library with artist, user or playlist URIs only", async () => {
  const seen = [];
  const d = deps({ save: async (u) => { seen.push(["save", u]); return null; }, unsave: async (u) => { seen.push(["unsave", u]); return null; } });
  assert.equal((await out(["follow", "spotify:artist:abc", "spotify:user:bob"], d)).json.ok, true);
  assert.equal((await out(["unfollow", "spotify:playlist:p1"], d)).json.ok, true);
  assert.deepEqual(seen, [["save", ["spotify:artist:abc", "spotify:user:bob"]], ["unsave", ["spotify:playlist:p1"]]]);
  for (const bad of [["follow"], ["follow", "spotify:track:1"], ["unfollow", "Daft Punk"]]) {
    const r = await out(bad, d);
    assert.equal(r.code, 1);
  }
  assert.equal(seen.length, 2);
});

test("help lists every command, including playlist-cover, follow and unfollow", async () => {
  const { json } = await out(["help"], deps());
  for (const cmd of ["playlist-cover", "follow", "unfollow", "save", "dj", "transfer"]) assert.match(json.help, new RegExp(`\\b${cmd}\\b`));
});
