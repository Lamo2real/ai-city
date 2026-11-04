// The real runner against a fake SDK query(): streaming, tools, the policy hook and usage limits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { loadPolicy } from "../src/policy.ts";
import { UsageLimit, capModel, createRunner, createWarmRunner } from "../src/sdk.ts";

const policy = loadPolicy();
type Captured = { prompt: unknown; options: Record<string, any> };

function fakeQuery(messages: unknown[], captured: Captured[]) {
  return ((params: { prompt: unknown; options: Record<string, any> }) => {
    captured.push(params);
    return (async function* () { for (const m of messages) yield m; })();
  }) as any;
}

const result = (extra: Record<string, unknown>) => ({ type: "result", subtype: "success", result: "eighteen", session_id: "sess-1", total_cost_usd: 0.002, usage: { input_tokens: 120, output_tokens: 30 }, errors: [], ...extra });

test("a turn streams text, reports tool use, and returns the final text, session and cost", async () => {
  const captured: Captured[] = [];
  const runner = createRunner({ policy, env: { PATH: "/bin" }, queryFn: fakeQuery([
    { type: "system", subtype: "init" },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Math it is — " } } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__jarvis__send_ticket", input: { ticket: {} } }] } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "eighteen." } } },
    result({}),
  ], captured) });
  const text: string[] = [];
  const tools: string[] = [];
  const r = await runner({ agentId: "jarvis", systemPrompt: "You are Jarvis", model: "claude-haiku-5-5", effort: "low", allowedTools: ["mcp__jarvis__send_ticket"], tools: [{ name: "send_ticket", description: "d", schema: { ticket: z.record(z.string(), z.unknown()) }, handler: async () => ({ ok: true }) }], prompt: "what's 9+9", resume: "old", onText: (t) => text.push(t), onTool: (n) => tools.push(n) });
  assert.deepEqual(r, { text: "eighteen", sessionId: "sess-1", costUsd: 0.002, tokens: 150, usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0 }, contextTokens: 120, durationMs: 0 });
  assert.deepEqual(text, ["Math it is — ", "eighteen."]);
  assert.deepEqual(tools, ["mcp__jarvis__send_ticket"]);
  const { options } = captured[0];
  assert.equal(options.model, "claude-haiku-5-5");
  assert.equal(options.resume, "old");
  assert.equal(options.permissionMode, "dontAsk");
  assert.deepEqual(options.settingSources, []);
  assert.deepEqual(options.systemPrompt, { type: "custom", prompt: "You are Jarvis" });
  assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
  assert.ok(options.mcpServers.jarvis.instance, "the in-process jarvis MCP server is attached");
});

test("the PreToolUse hook applies config/policy.json and audits; anything that would prompt is denied", async () => {
  const captured: Captured[] = [];
  const runner = createRunner({ policy, env: {}, queryFn: fakeQuery([result({})], captured) });
  await runner({ agentId: "py-dev", systemPrompt: "", model: "claude-sonnet-5-5", effort: "medium", allowedTools: ["Bash"], tools: [], prompt: "go" });
  const hook = captured[0].options.hooks.PreToolUse[0].hooks[0];
  const deny = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin main" } }, "id", { signal: new AbortController().signal });
  assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /Never push to main/);
  const askBecomesDeny = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "terraform destroy" } }, "id", { signal: new AbortController().signal });
  assert.equal(askBecomesDeny.hookSpecificOutput.permissionDecision, "deny");
  assert.match(askBecomesDeny.hookSpecificOutput.permissionDecisionReason, /ask_user/);
  const allow = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin feature/x" } }, "id", { signal: new AbortController().signal });
  assert.deepEqual(allow, {});
});

test("a usage-limit result stops live work with UsageLimit; other errors name the agent", async () => {
  const limit = createRunner({ policy, env: {}, queryFn: fakeQuery([result({ result: "You've hit your limit for today" })], []) });
  await assert.rejects(limit({ agentId: "a", systemPrompt: "", model: "claude-haiku-5-5", effort: "low", allowedTools: [], tools: [], prompt: "x" }), UsageLimit);
  const failed = createRunner({ policy, env: {}, queryFn: fakeQuery([{ type: "result", subtype: "error_max_turns", errors: ["too many turns"], session_id: "s", total_cost_usd: 0 }], []) });
  await assert.rejects(failed({ agentId: "a", systemPrompt: "", model: "claude-haiku-5-5", effort: "low", allowedTools: [], tools: [], prompt: "x" }), /a: error_max_turns: too many turns/);
});

test("JARVIS_MODEL_CAP lowers models above the cap and leaves the rest", () => {
  assert.equal(capModel("claude-opus-5-5", "claude-sonnet-5-5"), "claude-sonnet-5-5");
  assert.equal(capModel("claude-fable-5-1", "claude-sonnet-5-5"), "claude-sonnet-5-5");
  assert.equal(capModel("claude-haiku-5-5", "claude-sonnet-5-5"), "claude-haiku-5-5");
  assert.equal(capModel("claude-opus-5-5", undefined), "claude-opus-5-5");
  assert.equal(capModel("claude-opus-5-5", "nonsense"), "claude-opus-5-5");
});

test("an agent's session has only the built-in tools its prompt lists", async () => {
  const captured: Captured[] = [];
  const runner = createRunner({ policy, env: {}, queryFn: fakeQuery([result({})], captured) });
  await runner({ agentId: "jarvis", systemPrompt: "", model: "claude-haiku-5-5", effort: "low", allowedTools: ["mcp__jarvis__send_ticket", "Bash(osascript:*)", "Read", "Read"], tools: [], prompt: "x" });
  assert.deepEqual(captured[0].options.tools, ["Bash", "Read"]);
  await runner({ agentId: "orchestrator", systemPrompt: "", model: "claude-opus-5-5", effort: "medium", allowedTools: ["mcp__jarvis__hire_agent"], tools: [], prompt: "x" });
  assert.deepEqual(captured[1].options.tools, [], "the Orchestrator has no Agent, Bash or file tools: it hires");
});

test("tokens include the cache split", async () => {
  const runner = createRunner({ policy, env: { PATH: "/bin" }, queryFn: fakeQuery([result({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } })], []) });
  const r = await runner({ agentId: "a", systemPrompt: "s", model: "claude-haiku-5-5", effort: "low", allowedTools: [], tools: [], prompt: "p" });
  assert.deepEqual(r.usage, { input: 10, output: 5, cacheRead: 1000, cacheWrite: 200 });
  assert.equal(r.tokens, 1215);
});

// A fake long-lived process: one reply per user message, with interrupt() and the options it was started with.
function fakeProcesses(reply: (text: string, proc: any) => AsyncGenerator<unknown> | unknown[]) {
  const procs: any[] = [];
  const queryFn = ((params: { prompt: AsyncIterable<any>; options: Record<string, any> }) => {
    const proc: any = { options: params.options, said: [], interrupts: 0, onInterrupt: () => {}, closed: false };
    params.options.abortController.signal.addEventListener("abort", () => { proc.closed = true; });
    procs.push(proc);
    const gen = (async function* () {
      for await (const m of params.prompt) {
        proc.said.push(m.message.content);
        yield* reply(m.message.content, proc) as any;
      }
    })();
    return Object.assign(gen, { interrupt: async () => { proc.interrupts++; proc.onInterrupt(); } });
  }) as any;
  return { queryFn, procs };
}

const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const ok = (text: string, session = "sess-1") => ({ type: "result", subtype: "success", result: text, session_id: session, total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 1 } });
const base = { agentId: "jarvis", systemPrompt: "", model: "claude-haiku-5-5", effort: "low" as const, allowedTools: [], tools: [] };

test("warm: one process serves turn after turn, and each turn gets its own streaming callbacks", async () => {
  const { queryFn, procs } = fakeProcesses((text) => [{ type: "system", subtype: "init", session_id: "sess-1" }, delta(`to ${text}`), { type: "stream_event", event: { type: "content_block_stop" } }, ok(`to ${text}`)]);
  const warm = createWarmRunner({ policy, env: {}, queryFn });
  warm.warmUp("hud", { ...base, prompt: "" });
  assert.equal(procs.length, 1, "started before any turn");
  const seen: string[] = [];
  const first = await warm.run("hud", { ...base, prompt: "a", onText: (t) => seen.push(t), onTextEnd: () => seen.push("|") });
  const second = await warm.run("hud", { ...base, prompt: "b", resume: first.sessionId, onText: (t) => seen.push(t), onTextEnd: () => seen.push("|") });
  assert.equal(second.text, "to b");
  assert.deepEqual(seen, ["to a", "|", "to b", "|"]);
  assert.equal(procs.length, 1);
  assert.deepEqual(procs[0].said, ["a", "b"]);
  warm.close();
  assert.equal(procs[0].closed, true);
});

test("warm: the policy hook is on the long-lived process too", async () => {
  const { queryFn, procs } = fakeProcesses(() => [ok("x")]);
  const warm = createWarmRunner({ policy, env: {}, queryFn });
  warm.warmUp("hud", { ...base, agentId: "py-dev", allowedTools: ["Bash"], prompt: "" });
  const hook = procs[0].options.hooks.PreToolUse[0].hooks[0];
  const deny = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin main" } }, "id", { signal: new AbortController().signal });
  assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(procs[0].options.tools, ["Bash"]);
  warm.close();
});

test("warm: a process on another session is replaced, and a new one resumes the session asked for", async () => {
  const { queryFn, procs } = fakeProcesses(() => [ok("x", "other")]);
  const warm = createWarmRunner({ policy, env: {}, queryFn });
  warm.warmUp("hud", { ...base, prompt: "", resume: "old" });
  await warm.run("hud", { ...base, prompt: "a", resume: "new" });
  assert.equal(procs.length, 2);
  assert.equal(procs[0].closed, true);
  assert.equal(procs[1].options.resume, "new");
  warm.close();
});

test("warm: barge-in stops the turn at once and the next turn finds the same process", async () => {
  const { queryFn, procs } = fakeProcesses(async function* (text: string, proc: any) {
    if (text === "long") {
      yield delta("Once upon");
      await new Promise<void>((r) => { proc.onInterrupt = r; });
      yield { type: "result", subtype: "error_during_execution", errors: [], session_id: "sess-1" };
    } else yield ok("short");
  } as any);
  const warm = createWarmRunner({ policy, env: {}, queryFn });
  const cancel = new AbortController();
  const turn = warm.run("hud", { ...base, prompt: "long", signal: cancel.signal, onText: () => cancel.abort() });
  await assert.rejects(turn, (err: any) => err.cancelled === true);
  const next = await warm.run("hud", { ...base, prompt: "next" });
  assert.equal(next.text, "short");
  assert.equal(procs.length, 1);
  assert.equal(procs[0].interrupts, 1);
  warm.close();
});

test("warm: a process that cannot be interrupted is dropped, and the next turn starts a new one", async () => {
  const { queryFn, procs } = fakeProcesses(async function* (text: string) {
    yield delta("x");
    if (text === "long") throw new Error("gone");
    yield ok("fine");
  } as any);
  const warm = createWarmRunner({ policy, env: {}, queryFn });
  const cancel = new AbortController();
  await assert.rejects(warm.run("hud", { ...base, prompt: "long", signal: cancel.signal, onText: () => cancel.abort() }), (err: any) => err.cancelled === true);
  assert.equal((await warm.run("hud", { ...base, prompt: "next" })).text, "fine");
  assert.equal(procs.length, 2);
  warm.close();
});

test("warm: a parked process that died is replaced without losing the turn, whether it threw or just ended", async () => {
  for (const die of [async function* () { throw new Error("exit 1"); }, async function* () {}]) {
    const started: unknown[] = [];
    const queryFn = ((params: { prompt: AsyncIterable<any> }) => {
      const n = started.push(params) - 1;
      return Object.assign(n === 0 ? die() : (async function* () { for await (const m of params.prompt) { void m; yield ok("alive"); } })(), { interrupt: async () => {} });
    }) as any;
    const warm = createWarmRunner({ policy, env: {}, queryFn });
    warm.warmUp("hud", { ...base, prompt: "" });
    assert.equal((await warm.run("hud", { ...base, prompt: "a" })).text, "alive");
    assert.equal(started.length, 2);
    warm.close();
  }
});

test("warm: an expired session reaches the caller after one retry, for it to start over", async () => {
  const { queryFn, procs } = fakeProcesses(async function* () { throw new Error("No conversation found with session ID x"); } as any);
  const warm = createWarmRunner({ policy, env: {}, queryFn });
  warm.warmUp("hud", { ...base, prompt: "", resume: "x" });
  await assert.rejects(warm.run("hud", { ...base, prompt: "a", resume: "x" }), /no conversation found/i);
  assert.equal(procs.length, 2);
  warm.close();
});

test("warm: a process that dies mid-turn is not retried, so nothing runs twice", async () => {
  const { queryFn, procs } = fakeProcesses(async function* () { yield delta("half"); } as any);
  const ending = ((params: any) => {
    const inner = queryFn(params);
    return Object.assign((async function* () { yield (await inner.next()).value; })(), { interrupt: inner.interrupt });
  }) as any;
  const warm = createWarmRunner({ policy, env: {}, queryFn: ending });
  warm.warmUp("hud", { ...base, prompt: "" });
  await assert.rejects(warm.run("hud", { ...base, prompt: "a" }), /warm process ended/);
  assert.equal(procs.length, 1);
  warm.close();
});

test("warm: usage limits and error results fail the turn the same way as the plain runner", async () => {
  const { queryFn } = fakeProcesses((text) => (text === "limit" ? [ok("You've hit your limit for today")] : [{ type: "result", subtype: "error_max_turns", errors: ["too many turns"], session_id: "s" }]));
  const warm = createWarmRunner({ policy, env: {}, queryFn });
  await assert.rejects(warm.run("hud", { ...base, prompt: "limit" }), UsageLimit);
  await assert.rejects(warm.run("hud", { ...base, prompt: "other" }), /jarvis: error_max_turns: too many turns/);
  warm.close();
});

test("warm: at most two processes are kept, the least recently used goes", async () => {
  const { queryFn, procs } = fakeProcesses(() => [ok("x", "s")]);
  const warm = createWarmRunner({ policy, env: {}, queryFn });
  await warm.run("a", { ...base, prompt: "1" });
  await warm.run("b", { ...base, prompt: "1" });
  await warm.run("a", { ...base, prompt: "2", resume: "s" });
  await warm.run("c", { ...base, prompt: "1" });
  assert.deepEqual(procs.map((p) => p.closed), [false, true, false]);
  assert.equal(procs.length, 3);
  warm.close();
});
