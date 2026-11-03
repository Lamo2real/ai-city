// Spotify Web API client (post Feb 2026 routes). Tokens come from the auth module; everything is injectable.
import { hostname as osHostname } from "node:os";
import { SpotifyError, CODES } from "./errors.js";
import { mac as defaultMac } from "./mac.js";

const BASE = "https://api.spotify.com/v1";
const MAX_SEARCH = 10;
const MAX_RETRY_AFTER = 10;
const MAX_COVER_BYTES = 256 * 1024;
const CONTEXT_TYPES = new Set(["album", "playlist", "artist", "show"]);

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const typeOf = (uri) => /^spotify:([a-z]+):/.exec(uri)?.[1];
const plId = (id) => String(id).replace(/^spotify:playlist:/, "");
const norm = (s) => String(s || "").toLowerCase().replace(/\.local$/, "").replace(/[^a-z0-9]/g, "");

async function readBody(res) {
  const text = await res.text?.();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function apiError(status, body) {
  const reason = body?.error?.reason;
  const msg = String(body?.error?.message ?? "");
  const E = (code, message) => new SpotifyError(code, message, { status });
  if (status === 403) {
    if (reason === "PREMIUM_REQUIRED" || /premium/i.test(msg)) return E(CODES.PREMIUM_REQUIRED, "Playback control needs Spotify Premium.");
    return E(CODES.FORBIDDEN, "Spotify refused that. Either a permission (scope) is missing, so run `jarvis-spotify login` again, or this account isn't on the app's allow-list in the Spotify developer dashboard.");
  }
  if (status === 404) {
    if (reason === "NO_ACTIVE_DEVICE") return E(CODES.NO_ACTIVE_DEVICE, "No Spotify device is active.");
    return E(CODES.NOT_FOUND, msg || "Spotify couldn't find that.");
  }
  return E(CODES.API, `Spotify error ${status}${msg ? `: ${msg}` : ""}`);
}

export function createSpotifyClient({ tokens, fetch = globalThis.fetch, sleep = defaultSleep, mac = defaultMac, hostname = osHostname() }) {
  async function request(method, path, { query, body, raw } = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    let refreshed = false;
    let rateRetries = 0;
    for (;;) {
      const headers = { Authorization: `Bearer ${await tokens.getAccessToken()}` };
      if (raw) headers["Content-Type"] = raw.contentType;
      else if (body !== undefined) headers["Content-Type"] = "application/json";
      const payload = raw ? raw.body : body !== undefined ? JSON.stringify(body) : undefined;
      const res = await fetch(url.toString(), { method, headers, ...(payload !== undefined && { body: payload }) });
      if (res.status === 401) {
        if (refreshed) throw new SpotifyError(CODES.SIGN_IN_REQUIRED, "Spotify sign-in expired. Run `jarvis-spotify login` in Terminal.", { status: 401 });
        refreshed = true;
        await tokens.refresh();
        continue;
      }
      if (res.status === 429) {
        const wait = Number(res.headers?.get?.("Retry-After") ?? 1);
        if (wait > MAX_RETRY_AFTER || rateRetries >= 2) {
          throw new SpotifyError(CODES.RATE_LIMITED, `Spotify is rate limiting me. Try again in ${wait} seconds.`, { status: 429, retryAfter: wait });
        }
        rateRetries++;
        await sleep(wait * 1000);
        continue;
      }
      if (res.status === 202 || res.status === 204) return null;
      const data = await readBody(res);
      if (!res.ok) throw apiError(res.status, data);
      return data;
    }
  }

  const findComputer = (devices) => {
    const computers = devices.filter((d) => d.type === "Computer");
    return computers.find((d) => norm(d.name) === norm(hostname)) ?? computers[0];
  };

  async function wakeMac() {
    try { await mac.open(); } catch { /* fall through to polling */ }
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const device = findComputer(await devices().catch(() => []));
      if (device) {
        await transfer(device.id, false);
        return true;
      }
    }
    return false;
  }

  async function player(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err?.code !== CODES.NO_ACTIVE_DEVICE) throw err;
      if (!(await wakeMac())) throw new SpotifyError(CODES.NO_ACTIVE_DEVICE, "Spotify isn't running on any device. I couldn't wake it on the Mac.");
      return fn();
    }
  }

  const search = (q, types = ["track"], limit = 5) =>
    request("GET", "/search", { query: { q, type: [].concat(types).join(","), limit: Math.max(1, Math.min(MAX_SEARCH, Number(limit) || 5)) } });

  const play = ({ uri, uris, offset, deviceId } = {}) => {
    const body = {};
    if (uris) body.uris = uris;
    else if (uri && CONTEXT_TYPES.has(typeOf(uri))) body.context_uri = uri;
    else if (uri) body.uris = [uri];
    if (offset !== undefined) body.offset = offset;
    return player(() => request("PUT", "/me/player/play", { query: { device_id: deviceId }, body: Object.keys(body).length ? body : undefined }));
  };
  const simple = (method, path, query) => player(() => request(method, path, { query }));
  const devices = async () => (await request("GET", "/me/player/devices"))?.devices ?? [];
  const transfer = (deviceId, play = false) => request("PUT", "/me/player", { body: { device_ids: [deviceId], play: Boolean(play) } });
  const MAX_LIBRARY_URIS = 40; // Spotify's limit per /me/library request
  const lib = async (method, path, uris) => {
    if (uris.length > MAX_LIBRARY_URIS) throw new SpotifyError(CODES.API, `That's more than ${MAX_LIBRARY_URIS} items at once. Spotify takes at most ${MAX_LIBRARY_URIS}.`);
    return request(method, path, { query: { uris: uris.join(",") } });
  };

  const me = async () => {
    const u = await request("GET", "/me");
    return { id: u?.id, display_name: u?.display_name, product: u?.product };
  };
  const setPlaylistCover = (id, jpegBase64) => {
    if (Buffer.byteLength(jpegBase64) > MAX_COVER_BYTES) throw new SpotifyError(CODES.API, "That image is too big for a playlist cover. Spotify's limit is 256 KB.");
    return request("PUT", `/playlists/${plId(id)}/images`, { raw: { contentType: "image/jpeg", body: jpegBase64 } });
  };

  return {
    me,
    setPlaylistCover,
    search,
    play,
    pause: () => simple("PUT", "/me/player/pause"),
    resume: () => play(),
    next: () => simple("POST", "/me/player/next"),
    previous: () => simple("POST", "/me/player/previous"),
    seek: (ms) => simple("PUT", "/me/player/seek", { position_ms: Math.max(0, Math.round(ms)) }),
    volume: (pct) => simple("PUT", "/me/player/volume", { volume_percent: Math.max(0, Math.min(100, Math.round(pct))) }),
    shuffle: (on) => simple("PUT", "/me/player/shuffle", { state: Boolean(on) }),
    repeat: (state) => simple("PUT", "/me/player/repeat", { state }),
    queue: (uri) => simple("POST", "/me/player/queue", { uri }),
    devices,
    transfer,
    nowPlaying: () => request("GET", "/me/player"),
    recent: () => request("GET", "/me/player/recently-played", { query: { limit: 20 } }),
    top: (type = "tracks") => request("GET", `/me/top/${type}`, { query: { limit: 10 } }),
    myPlaylists: () => request("GET", "/me/playlists", { query: { limit: 20 } }),
    playlistItems: (id) => request("GET", `/playlists/${plId(id)}/items`, { query: { limit: 50 } }),
    createPlaylist: (name, { public: isPublic = false, description } = {}) =>
      request("POST", "/me/playlists", { body: { name, public: isPublic, ...(description && { description }) } }),
    addToPlaylist: (id, uris) => request("POST", `/playlists/${plId(id)}/items`, { body: { uris } }),
    removeFromPlaylist: (id, uris) => request("DELETE", `/playlists/${plId(id)}/items`, { body: { items: uris.map((uri) => ({ uri })) } }),
    savedTracks: () => request("GET", "/me/tracks", { query: { limit: 20 } }),
    followedArtists: () => request("GET", "/me/following", { query: { type: "artist", limit: 20 } }),
    save: (uris) => lib("PUT", "/me/library", uris),
    unsave: (uris) => lib("DELETE", "/me/library", uris),
    contains: (uris) => lib("GET", "/me/library/contains", uris),
  };
}
