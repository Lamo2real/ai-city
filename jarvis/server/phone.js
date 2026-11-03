// The iPhone option in SPEC.md: a second listener on the Mac's LAN address, behind
// a passcode, open only while the Mac is on the network the owner chose as home.
// Off until scripts/enable-iphone.sh has written iphone.json.
import { execFile } from "node:child_process";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const COOKIE = "jarvis_phone";
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
const MIN_PASSCODE = 6;
const MAX_PASSCODE = 200;
const FREE_ATTEMPTS = 5;
const LOCK_BASE_MS = 60_000;
const LOCK_MAX_MS = 60 * 60_000;
const RECHECK_MS = 30_000;

const configFile = (dataDir) => join(dataDir, "iphone.json");
const hashWith = (passcode, salt) => scryptSync(passcode, Buffer.from(salt, "hex"), 32).toString("hex");

export function readConfig(dataDir) {
  try {
    return JSON.parse(readFileSync(configFile(dataDir), "utf8"));
  } catch {
    return null;
  }
}

export function enable(dataDir, passcode, network) {
  if (passcode.length < MIN_PASSCODE || passcode.length > MAX_PASSCODE) throw new Error(`The passcode must be at least ${MIN_PASSCODE} characters.`);
  const salt = randomBytes(16).toString("hex");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(configFile(dataDir), JSON.stringify({ salt, hash: hashWith(passcode, salt), networkId: network.networkId }), { mode: 0o600 });
}

export const disable = (dataDir) => rmSync(configFile(dataDir), { force: true });

// Sessions live in memory, so a restart asks for the passcode again. The lockout
// is global because anyone on the network can use many addresses; it only ever
// locks the phone route, never localhost.
export function createPhoneAccess({ dataDir, now = Date.now }) {
  const sessions = new Map();
  let sessionsFor = null;
  let failures = 0;
  let lockedUntil = 0;

  function config() {
    const current = readConfig(dataDir);
    if (current?.hash !== sessionsFor) {
      sessions.clear();
      sessionsFor = current?.hash ?? null;
    }
    return current;
  }

  return {
    login(passcode) {
      const current = config();
      if (!current || typeof passcode !== "string" || passcode.length > MAX_PASSCODE) return { ok: false };
      if (lockedUntil > now()) return { ok: false, retryInMs: lockedUntil - now() };
      const match = timingSafeEqual(Buffer.from(hashWith(passcode, current.salt), "hex"), Buffer.from(current.hash, "hex"));
      if (!match) {
        failures += 1;
        if (failures >= FREE_ATTEMPTS) {
          lockedUntil = now() + Math.min(LOCK_BASE_MS * 2 ** (failures - FREE_ATTEMPTS), LOCK_MAX_MS);
          return { ok: false, retryInMs: lockedUntil - now() };
        }
        return { ok: false };
      }
      failures = 0;
      const token = randomBytes(32).toString("hex");
      sessions.set(token, now() + COOKIE_MAX_AGE_S * 1000);
      return { ok: true, cookie: `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}` };
    },

    authed(cookieHeader) {
      if (!config()) return false;
      const token = String(cookieHeader ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      const expires = sessions.get(token);
      if (!expires) return false;
      if (expires > now()) return true;
      sessions.delete(token);
      return false;
    },
  };
}

export function inSubnet(peer, { address, netmask }) {
  const toInt = (ip) => String(ip).split(".").reduce((n, part) => (n * 256 + Number(part)) >>> 0, 0);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(String(peer))) return false;
  const mask = toInt(netmask);
  return ((toInt(peer) & mask) >>> 0) === ((toInt(address) & mask) >>> 0);
}

// Null when there is no plain LAN route, for example behind a VPN.
export async function currentNetwork() {
  try {
    const { stdout: route } = await run("/sbin/route", ["-n", "get", "default"], { timeout: 5000 });
    const gateway = route.match(/gateway: (\d+\.\d+\.\d+\.\d+)/)?.[1];
    const iface = route.match(/interface: (\w+)/)?.[1];
    if (!gateway || !iface) return null;
    const v4 = networkInterfaces()[iface]?.find((a) => a.family === "IPv4");
    // macOS hides the router's MAC address and the Wi-Fi name from Node, so home is
    // recognised by what the router's DHCP answer says.
    const option = (name) => run("/usr/sbin/ipconfig", ["getoption", iface, name], { timeout: 5000 }).then((r) => r.stdout.trim(), () => "");
    const [dhcpServer, domain] = await Promise.all([option("server_identifier"), option("domain_name")]);
    const { stdout: name } = await run("/usr/sbin/scutil", ["--get", "LocalHostName"], { timeout: 5000 });
    if (!v4 || !dhcpServer) return null;
    return { address: v4.address, netmask: v4.netmask, gateway, domain, networkId: [gateway, v4.netmask, dhcpServer, domain].join("|"), host: `${name.trim().toLowerCase()}.local` };
  } catch {
    return null;
  }
}

// Rechecks on a timer: opens on the home network, closes when the Mac leaves it
// or when the option is turned off, and moves when the address changes.
export function startPhoneListener({ dataDir, port, handler, logger = () => {}, network = currentNetwork, bindAddress }) {
  let server = null;
  let boundTo = null;

  function close() {
    if (!server) return;
    server.close();
    server.closeAllConnections();
    server = null;
    logger(`iPhone listener closed on ${boundTo}`);
    boundTo = null;
  }

  async function check() {
    const config = readConfig(dataDir);
    const net = config ? await network() : null;
    const wanted = net && net.networkId === config.networkId ? (bindAddress ?? net.address) : null;
    if (wanted !== boundTo) close();
    if (!wanted) return;
    if (server) {
      server.currentNet = net;
      return;
    }
    const next = createHttpServer((req, res) => handler(req, res, next.currentNet));
    next.currentNet = net;
    next.on("error", (err) => {
      logger(`iPhone listener failed: ${err.message}`);
      if (server === next) {
        server = null;
        boundTo = null;
      }
    });
    server = next;
    boundTo = wanted;
    next.listen(port, wanted, () => logger(`iPhone listener open at http://${net.host}:${next.address().port}`));
  }

  const timer = setInterval(() => check().catch((err) => logger(`iPhone check failed: ${err.message}`)), RECHECK_MS);
  timer.unref();
  const ready = check().catch((err) => logger(`iPhone check failed: ${err.message}`));
  return {
    ready,
    check,
    port: () => server?.address()?.port ?? null,
    stop() {
      clearInterval(timer);
      close();
    },
  };
}

export const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jarvis</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0605;color:#f4e9e4;font:16px -apple-system,system-ui,sans-serif}
  form{width:min(320px,calc(100vw - 32px))}
  h1{font-size:18px;letter-spacing:.2em;color:#ff5a2e;margin:0 0 16px}
  input,button{width:100%;box-sizing:border-box;min-height:48px;padding:0 12px;font-size:16px;border:1px solid #5a2a1e;background:#160c0a;color:inherit;border-radius:0}
  button{margin-top:8px;background:#ff5a2e;border-color:#ff5a2e;color:#000;font-weight:600}
  p{min-height:22px;margin:12px 0 0;color:#ff8a70;font-size:14px}
</style></head><body>
<form id="f"><h1>JARVIS</h1><label for="p">Passcode</label><input id="p" type="password" autocomplete="current-password" autofocus required><button>Unlock</button><p id="m" role="alert"></p></form>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const m = document.getElementById("m");
  m.textContent = "";
  try {
    const r = await fetch("./login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode: document.getElementById("p").value }) });
    if (r.ok) return location.reload();
    const j = await r.json().catch(() => ({}));
    m.textContent = j.error || "That did not work.";
  } catch { m.textContent = "Could not reach the Mac."; }
});
</script></body></html>`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.JARVIS_DATA_DIR ?? join(homedir(), "Library/Application Support/Jarvis");
  const [command] = process.argv.slice(2);
  if (command === "network") {
    const net = await currentNetwork();
    if (!net) {
      console.error("No plain network connection found. Turn off any VPN and join your home Wi-Fi.");
      process.exit(1);
    }
    console.log(`${net.address} via router ${net.gateway}, network domain "${net.domain || "none"}", reachable as http://${net.host}:7777`);
  } else if (command === "enable") {
    const net = await currentNetwork();
    if (!net) {
      console.error("No plain network connection found. Nothing was changed.");
      process.exit(1);
    }
    try {
      enable(dataDir, readFileSync(0, "utf8"), net);
    } catch (err) {
      console.error(`${err.message} Nothing was changed.`);
      process.exit(1);
    }
    console.log(`Enabled. On the iPhone, on this Wi-Fi: http://${net.host}:7777`);
  } else if (command === "disable") {
    disable(dataDir);
    console.log("Disabled. The listener closes within 30 seconds.");
  } else {
    console.error("Usage: phone.js network|enable|disable");
    process.exit(1);
  }
}
