// Running an agent's turn through OpenClaw: real shell, files, browser and desktop on this Mac, on the
// owner's logged-in Claude CLI. `openclaw agent exec` needs no Gateway, so a worker is one isolated run
// with a pinned config. The organization stays here: the bridge below is how a run reaches the city's
// tools and the policy gate, and it is the only way, per run, with a token that dies with the run.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { audit, type Policy } from "./policy.ts";
import { UsageLimit, capModel, isUsageLimit, type Runner, type TurnRequest } from "./sdk.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PLUGIN_DIR = join(ROOT, "city", "openclaw-plugin");
export const OPENCLAW_BIN = join(ROOT, "node_modules", ".bin", "openclaw");
const MAX_BODY = 1024 * 1024;

const CAPABILITY_TOOLS: Record<string, string[]> = {
  shell: ["group:runtime"],
  files: ["group:fs"],
  browser: ["browser"],
  web: ["group:web"],
  desktop: ["group:runtime"], // osascript and open, through exec; the policy gate sees every command
};
// Never granted through this door, whatever the capabilities say: nothing here may change OpenClaw, spawn around the city or message anyone.
const ALWAYS_DENIED = ["gateway", "automations", "cron", "plugins", "openclaw", "nodes", "computer", "message", "group:sessions", "canvas", "group:agents", "tts", "group:memory"];

// What each capability lets a run call. Everything else is refused at the tool hook, whatever the runtime
// offers: on the Claude CLI backend the agent sees native Write, Edit, Agent, Workflow and more regardless of
// config (measured with a live run), and all of them do pass before_tool_call. Tool names compared lowercased.
const CAPABILITY_CALLS: Record<string, string[]> = {
  shell: ["exec", "bash", "process", "code_execution"],
  desktop: ["exec", "bash", "process"],
  files: ["read", "write", "edit", "apply_patch", "glob", "grep", "multiedit", "notebookedit"],
  browser: ["browser"],
  web: ["web_search", "web_fetch", "websearch", "webfetch", "x_search"],
};
export function capabilityAllows(tool: string, capabilities: string[] = []): boolean {
  const t = tool.toLowerCase();
  if (t.startsWith("mcp__city__") || t === "tool_search" || t === "toolsearch") return true;
  return capabilities.some((c) => CAPABILITY_CALLS[c]?.includes(t));
}

// A pinned config per agent, so a run gets exactly its capabilities and nothing ambient.
export function runConfig(capabilities: string[] = [], primary: string, pluginDir = PLUGIN_DIR): Record<string, unknown> {
  const allow = [...new Set(capabilities.flatMap((c) => CAPABILITY_TOOLS[c] ?? []))];
  return {
    discovery: { mdns: { mode: "off" } },
    browser: { enabled: capabilities.includes("browser"), headless: true, defaultProfile: "openclaw" },
    agents: { defaults: { model: { primary }, models: { "anthropic/*": { agentRuntime: { id: "claude-cli" } } } } },
    tools: { profile: "minimal", alsoAllow: [...allow, "group:plugins"], deny: ALWAYS_DENIED, elevated: { enabled: false } },
    skills: { allowBundled: [] },
    plugins: { allow: ["city-bridge", "anthropic", ...(capabilities.includes("browser") ? ["browser"] : [])], load: { paths: [pluginDir] }, entries: { "city-bridge": { enabled: true } } },
  };
}

// The envelope `openclaw agent exec --json` prints (docs: cli/agent, stable). Everything else in it is ignored.
export interface Envelope { ok?: boolean; status?: string; final?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }; costUsd?: number; sessionId?: string; error?: { message?: string; kind?: string }; model?: string }

export function parseEnvelope(stdout: string): Envelope {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error("openclaw printed no result");
  try { return JSON.parse(stdout.slice(start)) as Envelope; } catch { throw new Error("openclaw printed an unreadable result"); }
}

// What the CLI runtime does not price: an estimate from its token counts, labelled as such everywhere.
export function estimateUsd(model: string, u: Envelope["usage"] = {}, policy?: Policy): number {
  const p = policy?.models?.prices_per_mtok?.[model];
  if (!p) return 0;
  return ((u.input ?? 0) * p.input + (u.output ?? 0) * p.output + (u.cacheRead ?? 0) * p.cache_read + (u.cacheWrite ?? 0) * p.cache_write) / 1_000_000;
}

// The loopback door a run comes back through. One server, a token per run.
export function createBridge(policy?: Policy) {
  const grants = new Map<string, TurnRequest>();
  const hooked = new Set<string>(); // runs whose plugin has reported in
  const bearerOf = (req: { headers: { authorization?: string } }) => (req.headers.authorization ?? "").replace(/^Bearer /, "");
  let server: Server | null = null;
  let port = 0;
  async function ensure(): Promise<number> {
    if (server) return port;
    const s = createServer((req, res) => {
      const send = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      const grant = grants.get(bearerOf(req));
      if (!grant) return send(403, { error: "no such run" });
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) req.destroy(); else chunks.push(c); });
      req.on("end", async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { tool?: string; params?: Record<string, unknown> };
          const path = new URL(req.url ?? "/", "http://x").pathname;
          if (path === "/hello") { hooked.add(bearerOf(req)); return send(200, {}); }
          if (path === "/policy") {
            hooked.add(bearerOf(req));
            const tool = String(body.tool ?? "");
            if (!capabilityAllows(tool, grant.capabilities)) {
              if (policy) audit(policy, tool, "deny", "not in this agent's capabilities", grant.agentId);
              return send(200, { allow: false, message: `${tool} is not among this agent's capabilities (${(grant.capabilities ?? []).join(", ") || "none"}).` });
            }
            const g = grant.guard?.(tool, body.params ?? {}) ?? { allow: false as const, message: "no policy gate for this run" };
            return send(200, g);
          }
          const name = /^\/tool\/([a-z_]+)$/.exec(path)?.[1];
          const tool = grant.tools.find((t) => t.name === name);
          if (!tool) return send(404, { error: `${name} is not available to ${grant.agentId}` });
          return send(200, { result: await tool.handler(body.params ?? {}) });
        } catch (err) {
          return send(400, { error: (err as Error).message });
        }
      });
    });
    await new Promise<void>((resolve, reject) => { s.once("error", reject); s.listen(0, "127.0.0.1", resolve); });
    s.unref();
    port = (s.address() as { port: number }).port;
    server = s;
    return port;
  }
  return {
    async open(req: TurnRequest): Promise<{ url: string; token: string; hookLoaded: () => boolean; close: () => void }> {
      const p = await ensure();
      const token = randomBytes(24).toString("hex");
      grants.set(token, req);
      return { url: `http://127.0.0.1:${p}`, token, hookLoaded: () => hooked.has(token), close: () => { grants.delete(token); hooked.delete(token); } };
    },
    close() { server?.close(); server = null; grants.clear(); },
  };
}

// The tools the plugin offers, by the names the run sees them under.
const RUNTIME_PROMPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents", "runtime");
const runtimePrompt = (name: string) => readFileSync(join(RUNTIME_PROMPTS, `${name}.md`), "utf8").trim();
export const roleNote = (req: TurnRequest): string => [
  req.systemPrompt,
  runtimePrompt("openclaw-run").replace("{{capabilities}}", (req.capabilities ?? []).join(", ") || "none"),
  ...(req.capabilities?.includes("browser") ? [runtimePrompt("openclaw-browser")] : []),
  "",
].join("\n\n");

// What a run may not do even if it is told to: reach the owner-only API, or change the city's controls.
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const CONTROLS = ["city", "jarvis", "config", "agents", "schemas", "skills", ".claude", "bin"];
export function sandboxProfile(dataDir: string, port: number, root = ROOT, capabilities: string[] = [], home = homedir()): string {
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  const data = real(dataDir);
  const files = ["ledger.db", "ledger.db-wal", "ledger.db-shm", "audit.jsonl", "events.jsonl"].map((n) => `(literal ${JSON.stringify(join(data, n))})`);
  const repo = real(root), user = real(home);
  const trees = [...CONTROLS, "node_modules", ".git/hooks"].map((d) => join(repo, d)).concat(join(data, "agents"), join(user, "Library/LaunchAgents"), join(user, ".claude/hooks"), join(user, ".claude/skills"));
  const single = [join(repo, ".git/config"), ...[".claude/settings.json", ".claude/settings.local.json", ".zshrc", ".zshenv", ".zprofile", ".bashrc", ".bash_profile", ".profile", ".gitconfig"].map((n) => join(user, n))];
  const code = [...trees.map((d) => `(subpath ${JSON.stringify(d)})`), ...single.map((p) => `(literal ${JSON.stringify(p)})`)];
  // They start things outside this sandbox. The desktop capability needs them, so a desktop run is not contained by this.
  const launchers = capabilities.includes("desktop") ? "" : `(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))\n`;
  return `(version 1)\n(allow default)\n(deny network-outbound (remote ip "localhost:${port}"))\n(deny file-write* ${[...code, ...files].join(" ")})\n${launchers}`;
}

// A crash cannot run this. shortcut: a run outliving a crashed server has every tool blocked (its bridge is gone) and ends at its timeout; add a pid file if that is ever too long.
const liveRuns = new Set<() => void>();
process.on("exit", () => { for (const stop of liveRuns) stop(); });

export interface OpenClawOptions {
  sandbox?: boolean; // default: on, wherever this Mac has sandbox-exec and the real CLI is used
  requireHook?: boolean; // default: on with the real CLI
  policy: Policy;
  env: Record<string, string>;
  dataDir: string;
  bin?: string;
  pluginDir?: string;
  spawnImpl?: typeof spawn;
  timeoutSeconds?: number;
}

const PASS_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SHELL", "TERM", "TZ", "JARVIS_HOME", "JARVIS_MODEL_CAP"];
export function createOpenClawRunner(o: OpenClawOptions): Runner & { bridge: ReturnType<typeof createBridge> } {
  const bridge = createBridge(o.policy);
  const spawnFn = o.spawnImpl ?? spawn;
  // OpenClaw's Claude backend uses the `claude` login on this Mac by itself: no token or key ever goes in.
  // An allowlist: a run can be steered by a web page, so no token or key in this process's environment reaches it.
  const env: Record<string, string> = {};
  for (const k of PASS_ENV) if (o.env[k] !== undefined) env[k] = o.env[k]!;
  const sandbox = o.sandbox ?? (!o.spawnImpl && existsSync(SANDBOX_EXEC));
  const requireHook = o.requireHook ?? !o.spawnImpl;

  const turn = async (req: TurnRequest) => {
    if (req.signal?.aborted) throw new Error("turn cancelled");
    const started = Date.now();
    const model = capModel(req.model);
    const dir = join(o.dataDir, "openclaw", req.agentId);
    const state = join(dir, "state");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify(runConfig(req.capabilities, `anthropic/${model}`, o.pluginDir), null, 2), { mode: 0o600 });
    const door = await bridge.open(req);
    const args = ["agent", "exec", "--config", config, "--state-dir", state, "--cwd", req.cwd ?? dir, "--model", `anthropic/${model}`, "--timeout", String(o.timeoutSeconds ?? 3000), "--json", "--message-file", "-"];
    const fallback = req.fallbackModel && capModel(req.fallbackModel);
    if (fallback && fallback !== model) args.push("--fallback", `anthropic/${fallback}`);
    const message = roleNote(req) + req.prompt; // before the spawn: a failure here must not leave a process behind
    let child: ChildProcess | undefined;
    // Its own process group: the CLI re-executes itself, so killing only the child would leave the real run behind.
    const signal = (s: NodeJS.Signals) => { try { process.kill(-child!.pid!, s); } catch { child?.kill(s); } };
    const kill = () => { signal("SIGTERM"); setTimeout(() => signal("SIGKILL"), 5000).unref(); };
    req.signal?.addEventListener("abort", kill, { once: true });
    try {
      const bin = o.bin ?? OPENCLAW_BIN;
      let command = bin, argv = args;
      // Chrome's own sandbox cannot start inside this one, so a browser run goes without it. That is why the hire
      // refuses browser with shell or files: such a run can only use the browser, and OpenClaw's SSRF policy keeps that off loopback.
      if (sandbox && !req.capabilities?.includes("browser")) {
        const profile = join(dir, "sandbox.sb");
        writeFileSync(profile, sandboxProfile(o.dataDir, Number(o.env.JARVIS_PORT ?? 7777), ROOT, req.capabilities), { mode: 0o600 });
        command = SANDBOX_EXEC;
        argv = ["-f", profile, bin, ...args];
      }
      const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
        child = spawnFn(command, argv, { env: { ...env, CITY_BRIDGE_URL: door.url, CITY_BRIDGE_TOKEN: door.token, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: config }, detached: true, stdio: ["pipe", "pipe", "pipe"], cwd: req.cwd ?? dir });
        let out = "", err = "";
        // The result is the end of the run. With a browser its control server keeps the process alive afterwards
        // (measured: ten minutes after reporting, until killed), which would block this worker's next ticket.
        child.stdout!.on("data", (d) => {
          out += d;
          try { if (parseEnvelope(out).status) { resolve({ stdout: out, stderr: err, code: 0 }); kill(); } } catch { /* not all of it yet */ }
        });
        child.stderr!.on("data", (d) => { err += d; if (err.length > 200_000) err = err.slice(-100_000); });
        const stop = () => signal("SIGTERM");
        liveRuns.add(stop);
        child.on("error", (e) => { liveRuns.delete(stop); reject(e); });
        child.on("close", (c) => { liveRuns.delete(stop); resolve({ stdout: out, stderr: err, code: c }); });
        child.stdin!.on("error", () => {});
        child.stdin!.end(message);
      });
      if (req.signal?.aborted) throw new Error("turn cancelled");
      let e: Envelope;
      // A limit can arrive only in the CLI's error output, because OpenClaw's own message then just says the process exited.
      const limit = (text: string) => { const hit = text.split("\n").find(isUsageLimit); if (hit) throw new UsageLimit(hit.trim()); };
      try { e = parseEnvelope(stdout); } catch (err) { limit(stderr); throw new Error(`${(err as Error).message} (exit ${code}): ${stderr.slice(-400)}`); }
      if (e.status !== "ok") {
        const message = e.error?.message ?? `openclaw ended with ${e.status ?? code}`;
        limit(message);
        limit(stderr);
        throw new Error(`${req.agentId}: ${message}`);
      }
      // Without the hook nothing in this run was gated. Say so, loudly, rather than pass its work on as if it had been.
      if (requireHook && !door.hookLoaded()) throw new Error(`${req.agentId}: the policy hook never loaded in this run, so its actions were not checked. Treat its work as untrusted.`);
      const u = e.usage ?? {};
      const usage = { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 };
      return {
        text: e.final ?? "", sessionId: e.sessionId ?? `openclaw-${door.token.slice(0, 12)}`, costUsd: e.costUsd ?? estimateUsd(e.model ?? model, u, o.policy),
        usage, tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite, contextTokens: 0, durationMs: Date.now() - started,
      };
    } finally {
      door.close();
      req.signal?.removeEventListener("abort", kill);
    }
  };
  // shortcut: OpenClaw's browser takes fixed local ports, so browser runs go one at a time; give each run its own OPENCLAW_GATEWAY_PORT if this queue gets long.
  let browserTurn: Promise<unknown> = Promise.resolve();
  const runner = ((req: TurnRequest) => {
    if (!req.capabilities?.includes("browser")) return turn(req);
    const run = browserTurn.then(() => turn(req));
    browserTurn = run.catch(() => {});
    return run;
  }) as Runner & { bridge: ReturnType<typeof createBridge> };
  runner.bridge = bridge;
  return runner;
}
