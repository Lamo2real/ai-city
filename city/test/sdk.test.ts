// The real runner against a fake SDK query(): streaming, tools, the policy hook and usage limits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { loadPolicy } from "../src/policy.ts";
import { UsageLimit, capModel, createRunner } from "../src/sdk.ts";

const policy = loadPolicy();
type Captured = { prompt: unknown; options: Record<string, any> };

function fakeQuery(messages: unknown[], captured: Captured[]) {
  return ((params: { prompt: unknown; options: Record<string, any> }) => {
    captured.push(params);
    return (async function* () { for (const m of messages) yield m; })();
  }) as any;
}

const result = (extra: Record<string, unknown>) => ({ type: "result", subtype: "success", result: "eighteen", session_id: "sess-1", total_cost_usd: 0.002, errors: [], ...extra });

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
  assert.deepEqual(r, { text: "eighteen", sessionId: "sess-1", costUsd: 0.002 });
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
