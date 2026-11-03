import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpotifyClient } from "../spotify/client.js";
import { CODES } from "../spotify/errors.js";

const json = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k] ?? null },
  text: async () => (body === undefined ? "" : JSON.stringify(body)),
});

function setup(responses, { devicesPoll } = {}) {
  const calls = [];
  const queue = [...responses];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname.replace("/v1", ""), q: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization });
    const next = queue.shift();
    return typeof next === "function" ? next(calls.at(-1)) : next;
  };
  let token = "tok1";
  const refreshes = [];
  const tokens = { getAccessToken: async () => token, refresh: async () => { refreshes.push(1); token = "tok2"; } };
  const sleeps = [];
  const macCalls = [];
  const mac = { open: async () => macCalls.push("open") };
  const client = createSpotifyClient({ tokens, fetch, sleep: async (ms) => sleeps.push(ms), mac, hostname: "Alis-MacBook.local" });
  return { client, calls, refreshes, sleeps, macCalls };
}

test("401 refreshes once and retries with the new token", async () => {
  const { client, calls, refreshes } = setup([json(401, {}), json(200, { devices: [] })]);
  assert.deepEqual(await client.devices(), []);
  assert.equal(refreshes.length, 1);
  assert.deepEqual(calls.map((c) => c.auth), ["Bearer tok1", "Bearer tok2"]);
});

test("a second 401 is SIGN_IN_REQUIRED", async () => {
  const { client } = setup([json(401, {}), json(401, {})]);
  await assert.rejects(client.devices(), { code: CODES.SIGN_IN_REQUIRED });
});

test("403 premium vs other 403", async () => {
  let s = setup([json(403, { error: { status: 403, message: "Player command failed: Premium required", reason: "PREMIUM_REQUIRED" } })]);
  await assert.rejects(s.client.pause(), { code: CODES.PREMIUM_REQUIRED, message: "Playback control needs Spotify Premium." });
  s = setup([json(403, { error: { status: 403, message: "Forbidden" } })]);
  await assert.rejects(s.client.myPlaylists(), (e) => e.code === CODES.FORBIDDEN && /scope/.test(e.message) && /allow-list/.test(e.message));
});

test("404 NO_ACTIVE_DEVICE wakes the Mac, transfers and retries once", async () => {
  const noDev = json(404, { error: { status: 404, reason: "NO_ACTIVE_DEVICE" } });
  const { client, calls, macCalls } = setup([
    noDev,
    json(200, { devices: [] }),
    json(200, { devices: [{ id: "phone", type: "Smartphone", name: "Phone" }, { id: "m2", type: "Computer", name: "Other Mac" }, { id: "m1", type: "Computer", name: "Alis-MacBook" }] }),
    json(204),
    json(204),
  ]);
  assert.equal(await client.pause(), null);
  assert.deepEqual(macCalls, ["open"]);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["PUT /me/player/pause", "GET /me/player/devices", "GET /me/player/devices", "PUT /me/player", "PUT /me/player/pause"]);
  assert.deepEqual(calls[3].body, { device_ids: ["m1"], play: false });
});

test("wake failure throws NO_ACTIVE_DEVICE with the plain message", async () => {
  const noDev = json(404, { error: { reason: "NO_ACTIVE_DEVICE" } });
  const { client, sleeps } = setup([noDev, ...Array(25).fill(null).map(() => json(200, { devices: [] }))]);
  await assert.rejects(client.next(), { code: CODES.NO_ACTIVE_DEVICE, message: "Spotify isn't running on any device. I couldn't wake it on the Mac." });
  assert.ok(sleeps.reduce((a, b) => a + b, 0) >= 9000);
});

test("429 with a short Retry-After sleeps and retries (max 2)", async () => {
  const limited = json(429, {}, { "Retry-After": "2" });
  let s = setup([limited, json(200, { devices: [] })]);
  await s.client.devices();
  assert.deepEqual(s.sleeps, [2000]);
  s = setup([limited, limited, limited]);
  await assert.rejects(s.client.devices(), { code: CODES.RATE_LIMITED, retryAfter: 2 });
  assert.equal(s.calls.length, 3);
});

test("429 with a long Retry-After throws at once", async () => {
  const { client, calls, sleeps } = setup([json(429, {}, { "Retry-After": "60" })]);
  await assert.rejects(client.devices(), { code: CODES.RATE_LIMITED, retryAfter: 60 });
  assert.equal(calls.length, 1);
  assert.equal(sleeps.length, 0);
});

test("search caps limit at 10, defaults to 5", async () => {
  const { client, calls } = setup([json(200, {}), json(200, {}), json(200, {})]);
  await client.search("abba", ["track", "album"], 50);
  await client.search("abba");
  assert.deepEqual(calls[0].q, { q: "abba", type: "track,album", limit: "10" });
  assert.equal(calls[1].q.limit, "5");
});

test("play: tracks/episodes go in uris, containers in context_uri", async () => {
  const { client, calls } = setup(Array(5).fill(null).map(() => json(204)));
  await client.play({ uri: "spotify:track:1" });
  await client.play({ uri: "spotify:episode:2" });
  for (const t of ["album", "playlist", "artist"]) await client.play({ uri: `spotify:${t}:x`, deviceId: "d1" });
  assert.deepEqual(calls[0].body, { uris: ["spotify:track:1"] });
  assert.deepEqual(calls[1].body, { uris: ["spotify:episode:2"] });
  assert.deepEqual(calls[2].body, { context_uri: "spotify:album:x" });
  assert.equal(calls[2].q.device_id, "d1");
  assert.equal(calls[4].body.context_uri, "spotify:artist:x");
});

test("resume sends play with no body; player param shapes", async () => {
  const { client, calls } = setup(Array(5).fill(null).map(() => json(204)));
  await client.resume(); await client.seek(12345); await client.volume(150); await client.shuffle(true); await client.queue("spotify:track:1");
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[1].q.position_ms, "12345");
  assert.equal(calls[2].q.volume_percent, "100");
  assert.equal(calls[3].q.state, "true");
  assert.deepEqual([calls[4].method, calls[4].path, calls[4].q.uri], ["POST", "/me/player/queue", "spotify:track:1"]);
});

test("nowPlaying 204 is null", async () => {
  assert.equal(await setup([json(204)]).client.nowPlaying(), null);
});

test("playlist routes use /items, /me/playlists and the items body key", async () => {
  const { client, calls } = setup(Array(4).fill(null).map(() => json(200, { id: "p" })));
  await client.playlistItems("spotify:playlist:abc");
  await client.createPlaylist("Road", { public: true, description: "d" });
  await client.addToPlaylist("abc", ["spotify:track:1"]);
  await client.removeFromPlaylist("abc", ["spotify:track:1", "spotify:track:2"]);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /playlists/abc/items", "POST /me/playlists", "POST /playlists/abc/items", "DELETE /playlists/abc/items"]);
  assert.deepEqual(calls[1].body, { name: "Road", public: true, description: "d" });
  assert.deepEqual(calls[2].body, { uris: ["spotify:track:1"] });
  assert.deepEqual(calls[3].body, { items: [{ uri: "spotify:track:1" }, { uri: "spotify:track:2" }] });
});

test("library save/unsave/contains use /me/library with URIs", async () => {
  const { client, calls } = setup([json(200), json(200), json(200, [true, false])]);
  await client.save(["spotify:track:1", "spotify:album:2"]);
  await client.unsave(["spotify:track:1"]);
  assert.deepEqual(await client.contains(["spotify:track:1", "spotify:artist:3"]), [true, false]);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["PUT /me/library", "DELETE /me/library", "GET /me/library/contains"]);
  assert.equal(calls[0].q.uris, "spotify:track:1,spotify:album:2");
  assert.equal(calls[2].q.uris, "spotify:track:1,spotify:artist:3");
});

test("library listing routes", async () => {
  const { client, calls } = setup([json(200, {}), json(200, {})]);
  await client.savedTracks(); await client.followedArtists();
  assert.deepEqual([calls[0].path, calls[1].path, calls[1].q.type], ["/me/tracks", "/me/following", "artist"]);
});

test("me() returns id, display_name and product (product may be missing)", async () => {
  const s = setup([json(200, { id: "u1", display_name: "Ali", product: "premium", email: "x@y.z" }), json(200, { id: "u1", display_name: "Ali" })]);
  assert.deepEqual(await s.client.me(), { id: "u1", display_name: "Ali", product: "premium" });
  assert.equal((await s.client.me()).product, undefined);
  assert.equal(s.calls[0].path, "/me");
});

test("setPlaylistCover sends raw base64 as image/jpeg and enforces 256 KB", async () => {
  let seen;
  const s = setup([]);
  const tokens = { getAccessToken: async () => "t", refresh: async () => {} };
  const client = createSpotifyClient({ tokens, fetch: async (url, init) => { seen = { url, ...init }; return json(202); }, sleep: async () => {} });
  assert.equal(await client.setPlaylistCover("spotify:playlist:abc", "QUJD"), null);
  assert.equal(new URL(seen.url).pathname, "/v1/playlists/abc/images");
  assert.equal(seen.method, "PUT");
  assert.equal(seen.headers["Content-Type"], "image/jpeg");
  assert.equal(seen.body, "QUJD");
  assert.throws(() => client.setPlaylistCover("abc", "A".repeat(256 * 1024 + 1)), /too big.*256 KB/);
  assert.equal(s.calls.length, 0);
});

test("library calls take at most 40 URIs, Spotify's limit", async () => {
  const { client, calls } = setup([]);
  const uris = Array.from({ length: 41 }, (_, i) => `spotify:track:${i}`);
  for (const fn of ["save", "unsave", "contains"]) await assert.rejects(client[fn](uris), { code: CODES.API });
  assert.equal(calls.length, 0);
});
