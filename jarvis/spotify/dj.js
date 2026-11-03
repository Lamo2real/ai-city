// Starts Spotify DJ. There is no documented DJ API, so try the Web API, then the desktop app, then say so.
import { DJ_URI } from "./scopes.js";

const FAIL = { ok: false, message: "Spotify doesn't let apps start DJ reliably. Open DJ in the Spotify app and I can control it from there." };
const WAIT_MS = 2500;

// While DJ talks, `item` can be null, so only is_playing and the context are checked.
async function isDjPlaying(client) {
  try {
    const p = await client.nowPlaying();
    return Boolean(p?.is_playing && p.context?.uri === DJ_URI);
  } catch {
    return null; // couldn't check (e.g. not signed in)
  }
}

async function viaWebApi(client) {
  const devices = await client.devices().catch(() => []);
  const mac = devices.find((d) => d.type === "Computer");
  await client.play({ uri: DJ_URI, deviceId: mac?.id });
}

export async function startDj({ client, mac, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  try {
    await viaWebApi(client);
    await sleep(WAIT_MS);
    if (await isDjPlaying(client)) return { ok: true, via: "web-api" };
  } catch { /* try the desktop app */ }
  try {
    await mac.playUri(DJ_URI);
    await sleep(WAIT_MS);
    const confirmed = await isDjPlaying(client);
    // Without the Web API the desktop app's player state is the only evidence we have.
    if (confirmed || (confirmed === null && (await mac.nowPlaying?.())?.state === "playing")) return { ok: true, via: "applescript" };
  } catch { /* fall through */ }
  return { ...FAIL };
}
