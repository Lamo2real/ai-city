// Safari must never reach local or internal hosts: the Jarvis HUD itself lives on one, and a page there could answer
// the owner's questions as the owner. Checked on the WHATWG-parsed URL (it normalises 127.1 and 2130706433), on DNS
// answers, and again on whatever page Safari ends up on.
import { hostname as osHostname } from "node:os";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SafariError } from "./errors.js";

const v4 = (s) => s.split(".").map(Number);
export function internalV4(ip) {
  const [a, b] = v4(ip);
  return a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

// "::ffff:7f00:1", "::1", "fe80::1%en0", "1:2::3:4" → 8 groups of 16 bits, or null.
function groups6(ip) {
  let s = ip.split("%")[0].toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) { const [a, b, c, d] = v4(tail[1]); s = s.slice(0, -tail[1].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16); }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const all = [...head, ...Array(fill).fill("0"), ...rest].map((g) => parseInt(g || "0", 16));
  return all.length === 8 && all.every((g) => g >= 0 && g <= 0xffff) ? all : null;
}
export function internalV6(ip) {
  const g = groups6(ip);
  if (!g) return true; // unreadable: refuse
  if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return true; // :: and ::1
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80) return true; // fc00::/7, fe80::/10
  const mapped = (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
  if (mapped) return internalV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  return false;
}
export const internalIp = (ip) => (isIP(ip) === 4 ? internalV4(ip) : internalV6(ip));

// Name-only check (no DNS). `url` is a string; unparsable URLs are not judged here (the open/navigate path rejects them).
export function internalHost(url, own = osHostname()) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === "about:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) return true;
  if (isIP(host)) return internalIp(host);
  const mine = String(own).toLowerCase().replace(/\.local$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".ts.net") || host.endsWith(".local") || host.endsWith(".internal")
    || !host.includes(".") || host === mine || host === `${mine}.local`;
}

const blocked = () => new SafariError("INTERNAL_HOST", "I can't open local or tailnet addresses, including the Jarvis HUD itself.");

// Throws INTERNAL_HOST for a URL on an internal name, or whose DNS answers include an internal address.
export async function assertPublicUrl(url, lookup = (h) => dnsLookup(h, { all: true })) {
  if (internalHost(url)) throw blocked();
  const u = new URL(url);
  if (u.protocol === "about:") return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return;
  let answers = [];
  try { answers = await lookup(host); } catch { return; } // can't resolve: Safari can't load it either
  if ((Array.isArray(answers) ? answers : [answers]).some((a) => internalIp(typeof a === "string" ? a : a.address))) throw blocked();
}

// Sync check for the page Safari is on now.
export function assertPublicPage(url) {
  if (url && internalHost(url)) throw blocked();
}
