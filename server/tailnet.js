// Reaching Jarvis away from home: `tailscale serve` terminates HTTPS on the private
// tailnet and forwards to a loopback port used for nothing else. Never Funnel, never
// public. Off until scripts/enable-tailscale.sh has written tailnet.json.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const TAILNET_PORT = 7778;
const configFile = (dataDir) => join(dataDir, "tailnet.json");

export function readConfig(dataDir) {
  try {
    const { host, login } = JSON.parse(readFileSync(configFile(dataDir), "utf8"));
    return host && login ? { host: host.toLowerCase(), login: login.toLowerCase() } : null;
  } catch {
    return null;
  }
}

// Tailscale serve sets this header itself and drops any sent by the client, so
// another device or user on the tailnet cannot pass as the owner.
export const isOwner = (req, { login }) => String(req.headers["tailscale-user-login"] ?? "").toLowerCase() === login;

export function startTailnetListener({ dataDir, handler, port = TAILNET_PORT, logger = () => {} }) {
  const config = readConfig(dataDir);
  if (!config) return null;
  const server = createHttpServer((req, res) => handler(req, res, config));
  server.requestTimeout = 0;
  server.on("error", (err) => logger(`tailnet listener failed: ${err.message}`));
  server.listen(port, "127.0.0.1", () => logger(`tailnet listener for https://${config.host} on 127.0.0.1:${server.address().port}`));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.JARVIS_DATA_DIR ?? join(homedir(), "Library/Application Support/Jarvis");
  const [command, host, login] = process.argv.slice(2);
  if (command === "enable" && host && login) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(configFile(dataDir), JSON.stringify({ host: host.replace(/\.$/, ""), login }), { mode: 0o600 });
  } else if (command === "disable") {
    rmSync(configFile(dataDir), { force: true });
  } else {
    console.error("usage: tailnet.js enable <host> <login> | disable");
    process.exit(1);
  }
}
