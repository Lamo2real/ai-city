// The OpenClaw execution path without OpenClaw: config, envelope, the bridge's door, capability enforcement.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { z } from "zod";
import { capabilityAllows, createBridge, createOpenClawRunner, estimateUsd, parseEnvelope, runConfig } from "../src/openclaw.ts";
import { loadPolicy } from "../src/policy.ts";
import { createCity, type CityEvent } from "../src/runtime.ts";
import { UsageLimit, type TurnRequest } from "../src/sdk.ts";

const policy = { ...loadPolicy(), audit_log: join(mkdtempSync(join(tmpdir(), "audit-")), "audit.jsonl") };
const base = (extra: Partial<TurnRequest> = {}): TurnRequest => ({ agentId: "w1", systemPrompt: "You are a worker.", model: "claude-haiku-5-5", effort: "low", allowedTools: [], tools: [], prompt: "do it", ...extra });

test("a capability allows exactly its tools; everything else the runtime offers is refused", () => {
  assert.ok(capabilityAllows("exec", ["shell"]));
  assert.ok(capabilityAllows("write", ["files"]) && capabilityAllows("Write", ["files"]));
  assert.ok(capabilityAllows("browser", ["browser"]));
  assert.ok(capabilityAllows("mcp__city__report", []), "the organization tools are always there");
  assert.ok(capabilityAllows("tool_search", []));
  // What a zero-capability worker saw in a live run on the Claude CLI backend:
  for (const t of ["write", "Edit", "Agent", "Workflow", "Skill", "AskUserQuestion", "exec", "browser", "read"]) assert.equal(capabilityAllows(t, []), false, t);
  assert.equal(capabilityAllows("exec", ["files"]), false);
  assert.equal(capabilityAllows("Agent", ["shell", "files", "browser", "web", "desktop"]), false, "no sub-agents around the city");
});

test("a run's config grants only its capabilities, on the Claude CLI, and never the control plane", () => {
  const c = runConfig(["shell"], "anthropic/claude-haiku-5-5", "/plugin") as any;
  assert.deepEqual(c.tools.alsoAllow, ["group:runtime", "group:plugins"]);
  for (const d of ["gateway", "automations", "cron", "plugins", "openclaw", "nodes", "message", "group:sessions"]) assert.ok(c.tools.deny.includes(d), d);
  assert.equal(c.tools.elevated.enabled, false);
  assert.equal(c.browser.enabled, false);
  assert.deepEqual(c.agents.defaults.models["anthropic/*"], { agentRuntime: { id: "claude-cli" } });
  assert.deepEqual(c.skills.allowBundled, []);
  assert.deepEqual(c.plugins.allow, ["city-bridge", "anthropic"]);
  assert.deepEqual(c.plugins.load.paths, ["/plugin"]);
  assert.ok(!JSON.stringify(c).includes("apiKey"));
  const b = runConfig(["browser"], "anthropic/x", "/p") as any;
  assert.equal(b.browser.enabled, true);
  assert.ok(b.plugins.allow.includes("browser"));
});

test("the envelope is read from stdout, and estimates use the policy's prices", () => {
  assert.equal(parseEnvelope('{"ok":true,"status":"ok","final":"hi"}').final, "hi");
  assert.throws(() => parseEnvelope("nothing"), /no result/);
  assert.throws(() => parseEnvelope("{broken"), /unreadable/);
  assert.ok(Math.abs(estimateUsd("claude-opus-5-5", { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }, policy) - (4 + 20 + 0.2 + 8)) < 1e-9);
  assert.equal(estimateUsd("unknown", { input: 5 }, policy), 0);
});

test("the prices reproduce a real session's cost from the CLI's own accounting", () => {
  // From a session transcript: claude-opus-5-5, $32.131045.
  const usd = estimateUsd("claude-opus-5-5", { input: 1280, output: 232532, cacheRead: 95280305, cacheWrite: 1052403 }, policy);
  assert.ok(Math.abs(usd - 32.131) < 0.01, `got ${usd}`);
  const sonnet = estimateUsd("claude-sonnet-5-5", { input: 320, output: 103101, cacheRead: 16866078, cacheWrite: 273200 }, policy);
  assert.ok(Math.abs(sonnet - 3.811) < 0.01, `got ${sonnet}`);
});

test("the bridge: no token no door; a closed run's token is dead; tools and policy answer per run", async () => {
  const bridge = createBridge(policy);
  const seen: string[] = [];
  const door = await bridge.open(base({
    capabilities: ["shell"],
    tools: [{ name: "remember", description: "", schema: { text: z.string() }, handler: async (a) => { seen.push(JSON.stringify(a)); return { id: "m-1" }; } }],
    guard: (tool) => (tool === "exec" ? { allow: true } : { allow: false, message: "no" }),
  }));
  const post = (path: string, body: unknown, token: string = door.token) => fetch(`${door.url}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  assert.match(door.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await post("/policy", { tool: "exec" }, "wrong")).status, 403);
  assert.deepEqual(await (await post("/policy", { tool: "exec", params: { command: "ls" } })).json(), { allow: true });
  const refused = await (await post("/policy", { tool: "Agent", params: {} })).json() as { allow: boolean; message: string };
  assert.equal(refused.allow, false);
  assert.match(refused.message, /not among this agent's capabilities \(shell\)/);
  assert.deepEqual(await (await post("/tool/remember", { params: { text: "hello" } })).json(), { result: { id: "m-1" } });
  assert.deepEqual(seen, ['{"text":"hello"}']);
  assert.equal((await post("/tool/send_ticket", { params: {} })).status, 404, "only the tools this run was given");
  door.close();
  assert.equal((await post("/policy", { tool: "exec" })).status, 403);
  bridge.close();
});

function fakeSpawn(envelope: unknown, record: { args?: string[]; env?: Record<string, string>; stdin?: string; killed?: boolean; detached?: boolean; linger?: boolean; running?: number; most?: number }, code = 0) {
  return ((_bin: string, args: string[], opts: { env: Record<string, string>; detached?: boolean }) => {
    record.args = args;
    record.env = opts.env;
    record.detached = opts.detached;
    record.running = (record.running ?? 0) + 1;
    record.most = Math.max(record.most ?? 0, record.running);
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    let input = "";
    child.stdin.on("data", (d: Buffer) => { input += d; });
    child.on("close", () => { record.running!--; });
    child.kill = () => { record.killed = true; child.emit("close", null); return true; };
    child.stdin.on("finish", () => {
      record.stdin = input;
      if (envelope === "hang") return;
      child.stdout.write(typeof envelope === "string" ? envelope : JSON.stringify(envelope));
      if (!record.linger) setImmediate(() => child.emit("close", code));
    });
    return child;
  }) as any;
}

test("a turn: the right command line, no Claude credentials in its environment, usage from the envelope", async () => {
  const record: Parameters<typeof fakeSpawn>[1] = {};
  const dataDir = mkdtempSync(join(tmpdir(), "oc-"));
  const runner = createOpenClawRunner({ policy, env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk", CLAUDE_CODE_OAUTH_TOKEN: "secret-token" }, dataDir, bin: "/bin/openclaw", spawnImpl: fakeSpawn({ ok: true, status: "ok", final: "built it", usage: { input: 10, output: 5, cacheRead: 1000, cacheWrite: 100 }, sessionId: "s-1", model: "claude-haiku-5-5" }, record) });
  const r = await runner(base({ capabilities: ["shell", "files"], cwd: dataDir, fallbackModel: "claude-opus-5-5", prompt: "the ticket" }));
  assert.equal(r.text, "built it");
  assert.equal(r.tokens, 1115);
  assert.equal(r.sessionId, "s-1");
  assert.ok(r.costUsd > 0, "an estimate from the tokens, because the CLI runtime does not price");
  const a = record.args!;
  assert.deepEqual(a.slice(0, 2), ["agent", "exec"]);
  assert.equal(a[a.indexOf("--model") + 1], "anthropic/claude-haiku-5-5");
  assert.equal(a[a.indexOf("--fallback") + 1], "anthropic/claude-opus-5-5");
  assert.equal(a[a.indexOf("--cwd") + 1], dataDir);
  assert.ok(a.includes("--json"));
  assert.equal(record.env!.ANTHROPIC_API_KEY, undefined);
  assert.equal(record.env!.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.match(record.env!.CITY_BRIDGE_URL, /^http:\/\/127\.0\.0\.1/);
  assert.match(record.stdin!, /You are a worker\.[\s\S]*city_report[\s\S]*the ticket/);
  const cfg = JSON.parse(readFileSync(a[a.indexOf("--config") + 1], "utf8"));
  assert.deepEqual(cfg.tools.alsoAllow, ["group:runtime", "group:fs", "group:plugins"]);
  runner.bridge.close();
});

test("a turn: a usage limit is a UsageLimit, an error names the agent, junk output fails clearly, a cancel stops the child", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "oc-"));
  const make = (envelope: unknown, record = {}) => createOpenClawRunner({ policy, env: {}, dataDir, bin: "/x", spawnImpl: fakeSpawn(envelope, record) });
  await assert.rejects(make({ status: "error", error: { message: "You've hit your 5-hour limit · resets 6am" } })(base()), UsageLimit);
  await assert.rejects(make({ status: "error", error: { message: "model exploded" } })(base()), /w1: model exploded/);
  await assert.rejects(make({ status: "timeout" })(base()), /ended with timeout/);
  await assert.rejects(make("not json")(base()), /printed no result/);
  const record: { killed?: boolean } = {};
  const ctrl = new AbortController();
  const running = make("hang", record)(base({ signal: ctrl.signal }));
  await new Promise((r) => setTimeout(r, 20));
  ctrl.abort();
  await assert.rejects(running, /cancelled|no result/);
  assert.ok(record.killed);
});

test("a limit that only appears in the CLI's error output still pauses the city", async () => {
  const spawnImpl = ((_b: string, _a: string[]) => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stderr.write("[agent/cli-backend] cli exec\nYou've hit your 5-hour limit · resets 6am\n");
      child.stdout.end(JSON.stringify({ status: "error", error: { message: "Claude Code process exited with code 1" } }));
      setImmediate(() => child.emit("close", 1));
    });
    return child;
  }) as any;
  const runner = createOpenClawRunner({ policy, env: {}, dataDir: mkdtempSync(join(tmpdir(), "oc-")), bin: "/x", spawnImpl });
  await assert.rejects(runner(base()), (err: Error) => err instanceof UsageLimit && /resets 6am/.test(err.message));
  runner.bridge.close();
});

test("a run that printed its result but never exits is finished and killed, so the worker's next ticket can start", async () => {
  const record: Parameters<typeof fakeSpawn>[1] = { linger: true };
  const runner = createOpenClawRunner({ policy, env: {}, dataDir: mkdtempSync(join(tmpdir(), "oc-")), bin: "/x", spawnImpl: fakeSpawn({ status: "ok", final: "done" }, record) });
  const r = await Promise.race([runner(base({ capabilities: ["browser"] })), new Promise((_, no) => setTimeout(() => no(new Error("the run never finished")), 1000))]) as { text: string };
  assert.equal(r.text, "done");
  assert.ok(record.killed);
  assert.equal(record.detached, true, "its own process group, so the whole run can be killed");
  runner.bridge.close();
});

test("a shell run goes inside the OS sandbox and sees no secrets; a browser run stays outside it", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "oc-"));
  const calls: Array<{ bin: string; args: string[]; env: Record<string, string> }> = [];
  const inner = fakeSpawn({ status: "ok", final: "x" }, {});
  const spawnImpl = ((bin: string, args: string[], opts: { env: Record<string, string> }) => { calls.push({ bin, args, env: opts.env }); return inner(bin, args, opts); }) as any;
  const runner = createOpenClawRunner({ policy, env: { PATH: "/bin", GITHUB_PAT: "p", CARTESIA_API_KEY: "c", JARVIS_PORT: "7790" }, dataDir, bin: "/bin/openclaw", spawnImpl, sandbox: true });
  await runner(base({ capabilities: ["shell"] }));
  assert.equal(calls[0].bin, "/usr/bin/sandbox-exec");
  assert.equal(calls[0].args[2], "/bin/openclaw");
  assert.match(readFileSync(calls[0].args[1], "utf8"), /localhost:7790/);
  assert.equal(calls[0].env.GITHUB_PAT, undefined);
  assert.equal(calls[0].env.CARTESIA_API_KEY, undefined);
  assert.equal(calls[0].env.PATH, "/bin");
  await runner(base({ capabilities: ["browser"] }));
  assert.equal(calls[1].bin, "/bin/openclaw");
  runner.bridge.close();
});

test("a run whose policy hook never reported in has failed, whatever it says", async () => {
  const runner = createOpenClawRunner({ policy, env: {}, dataDir: mkdtempSync(join(tmpdir(), "oc-")), bin: "/x", spawnImpl: fakeSpawn({ status: "ok", final: "all good" }, {}), requireHook: true });
  await assert.rejects(runner(base()), /policy hook never loaded/);
  runner.bridge.close();
});

test("browser runs take turns because their ports are fixed, and other runs do not wait for them", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "oc-"));
  const record: Parameters<typeof fakeSpawn>[1] = {};
  const spawnImpl = fakeSpawn({ status: "ok", final: "x" }, record);
  const browser = createOpenClawRunner({ policy, env: {}, dataDir, bin: "/x", spawnImpl });
  await Promise.all([browser(base({ agentId: "a", capabilities: ["browser"] })), browser(base({ agentId: "b", capabilities: ["browser"] })), browser(base({ agentId: "c", capabilities: ["browser"] }))]);
  assert.equal(record.most, 1);
  // One failed run must not stop the next.
  const failing = createOpenClawRunner({ policy, env: {}, dataDir, bin: "/x", spawnImpl: fakeSpawn({ status: "error", error: { message: "boom" } }, {}) });
  const results = await Promise.allSettled([failing(base({ agentId: "a", capabilities: ["browser"] })), failing(base({ agentId: "b", capabilities: ["browser"] }))]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
  browser.bridge.close(); failing.bridge.close();
});

test("in the city: an openclaw worker's final message is its report; managers cannot run there; absent runner refuses the hire", async () => {
  const dir = mkdtempSync(join(tmpdir(), "city-"));
  const sdk = async () => ({ text: "", sessionId: "s", costUsd: 0.01, tokens: 1 });
  const calls: TurnRequest[] = [];
  const openclawRunner = async (req: TurnRequest) => { calls.push(req); return { text: "Booked the table for 12.", sessionId: `oc-${calls.length}`, costUsd: 0.002, tokens: 30000 }; };
  const city = createCity({ runner: sdk, openclawRunner, dataDir: dir, ledgerPath: ":memory:", policy });
  const events: CityEvent[] = [];
  city.on((e) => events.push(e));
  const { manager } = city.createDepartment({ name: "Personal", mission: "errands" });
  const hire = city.toolsFor(manager).find((t) => t.name === "hire_agent")!.handler;
  await hire({ spec: { id: "web-dev", role: "Browser worker", kind: "worker", parent: manager, mission: "m", tools: ["Read"], lifecycle: "temporary", budget_usd_per_day: 1, executor: "openclaw", capabilities: ["browser"] } });
  await assert.rejects(city.toolsFor("orchestrator").find((t) => t.name === "hire_agent")!.handler({ spec: { id: "mgr-oc", role: "M", kind: "manager", parent: "orchestrator", department: "Z", mission: "m", tools: ["Read"], lifecycle: "persistent", budget_usd_per_day: 1, executor: "openclaw" } }), /only workers run on openclaw/);
  await assert.rejects(hire({ spec: { id: "bad-caps", role: "x", kind: "worker", parent: manager, mission: "m", tools: ["Read"], lifecycle: "temporary", budget_usd_per_day: 1, capabilities: ["shell"] } }), /capabilities need executor openclaw/);
  await assert.rejects(hire({ spec: { id: "web-shell", role: "x", kind: "worker", parent: manager, mission: "m", tools: ["Read"], lifecycle: "temporary", budget_usd_per_day: 1, executor: "openclaw", capabilities: ["browser", "shell"] } }), /hire two workers/);
  const t = await city.toolsFor(manager).find((x) => x.name === "send_ticket")!.handler({ ticket: { to: "web-dev", goal: "book a table" } }) as { id: string };
  await city.idle();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].capabilities, ["browser"]);
  assert.equal(city.ledger.getTicket(t.id)?.status, "done");
  assert.equal(city.ledger.getTicket(t.id)?.result?.summary, "Booked the table for 12.");
  assert.equal(city.agent("web-dev").worker_state, "released");
  assert.ok(city.ledger.costReport().by_agent["web-dev"].tokens >= 30000);
  city.close();
  const none = createCity({ runner: sdk, dataDir: dir, ledgerPath: ":memory:", policy });
  const m = none.createDepartment({ name: "Other", mission: "m" }).manager;
  await assert.rejects(none.toolsFor(m).find((x) => x.name === "hire_agent")!.handler({ spec: { id: "web-two", role: "x", kind: "worker", parent: m, mission: "m", tools: ["Read"], lifecycle: "temporary", budget_usd_per_day: 1, executor: "openclaw" } }), /not available/);
  none.close();
});
