// One turn of one agent through the Claude Agent SDK. Everything the runtime
// needs from the SDK goes through `Runner`, so tests can swap in a fake.
import { USAGE_LIMIT_ERROR_PREFIXES, createSdkMcpServer, query, tool, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";
import { audit, decide, type Policy } from "./policy.ts";

export interface JarvisTool {
  name: string;
  description: string;
  schema: Record<string, z.ZodType>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface TurnRequest {
  agentId: string;
  systemPrompt: string;
  model: string;
  effort: "low" | "medium" | "high";
  allowedTools: string[];
  tools: JarvisTool[];
  prompt: string;
  resume?: string | null;
  cwd?: string;
  onText?: (text: string) => void;
  onTool?: (name: string, input: unknown) => void;
  signal?: AbortSignal;
}

export interface TurnResult {
  text: string;
  sessionId: string;
  costUsd: number;
  tokens?: number; // input + output tokens of the turn, from the SDK's usage
}

export type Runner = (req: TurnRequest) => Promise<TurnResult>;

export class UsageLimit extends Error {}
export const isUsageLimit = (text: string) => USAGE_LIMIT_ERROR_PREFIXES.some((p) => text.startsWith(p));

// JARVIS_MODEL_CAP=claude-sonnet-5-5 runs everything above Sonnet on Sonnet (smoke tests).
const RANK = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"];
export function capModel(model: string, cap = process.env.JARVIS_MODEL_CAP): string {
  if (!cap || RANK.indexOf(cap) < 0) return model;
  return RANK.indexOf(model) > RANK.indexOf(cap) ? cap : model;
}

type QueryFn = typeof query;

// "Bash(osascript:*)" → "Bash"; MCP tools are not built-ins. An agent whose prompt lists none gets none.
export const builtinTools = (allowed: string[]) => [...new Set(allowed.map((t) => t.replace(/\(.*$/, "")).filter((t) => !t.startsWith("mcp__")))];

export function createRunner({ policy, env, queryFn = query }: { policy: Policy; env: Record<string, string>; queryFn?: QueryFn }): Runner {
  return async (req) => {
    const abort = new AbortController();
    req.signal?.addEventListener("abort", () => abort.abort(), { once: true });
    const jarvis = createSdkMcpServer({
      name: "jarvis",
      tools: req.tools.map((t) => tool(t.name, t.description, t.schema, async (args) => {
        try {
          return { content: [{ type: "text", text: JSON.stringify(await t.handler(args as Record<string, unknown>)) }] };
        } catch (err) {
          return { content: [{ type: "text", text: `error: ${(err as Error).message}` }], isError: true };
        }
      })),
    });
    const options: Options = {
      model: capModel(req.model),
      effort: req.effort,
      systemPrompt: { type: "custom", prompt: req.systemPrompt },
      allowedTools: req.allowedTools,
      tools: builtinTools(req.allowedTools),
      permissionMode: "dontAsk",
      settingSources: [],
      mcpServers: { jarvis },
      strictMcpConfig: true,
      includePartialMessages: true,
      persistSession: true,
      cwd: req.cwd,
      env,
      abortController: abort,
      resume: req.resume ?? undefined,
      // dontAsk denies anything that would prompt; the hook below gates every call, allowed or not.
      hooks: {
        PreToolUse: [{
          hooks: [async (input) => {
            if (input.hook_event_name !== "PreToolUse") return {};
            const [decision, reason] = decide(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, policy);
            audit(policy, input.tool_name, decision, reason, req.agentId);
            if (decision === "allow") return {};
            // shortcut: "ask" is denied with the reason, the agent asks the owner through ask_user; add an approvals store when a gated action must be retried after a yes.
            return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${reason} Not run. Ask the owner with ask_user if it is needed.` } };
          }],
        }],
      },
    };
    let text = "";
    let sessionId = req.resume ?? "";
    let costUsd = 0;
    let tokens = 0;
    for await (const m of queryFn({ prompt: req.prompt, options }) as AsyncIterable<SDKMessage>) {
      if (m.type === "stream_event") {
        const e = m.event as { type: string; delta?: { type?: string; text?: string } };
        if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) req.onText?.(e.delta.text);
      } else if (m.type === "assistant") {
        for (const part of m.message.content) if (part.type === "tool_use") req.onTool?.(part.name, part.input);
      } else if (m.type === "result") {
        sessionId = m.session_id;
        costUsd = m.total_cost_usd ?? 0;
        tokens = (m.usage?.input_tokens ?? 0) + (m.usage?.output_tokens ?? 0);
        if (m.subtype === "success") text = m.result;
        else {
          const detail = m.errors.join("; ");
          if (isUsageLimit(detail)) throw new UsageLimit(detail);
          throw new Error(`${req.agentId}: ${m.subtype}: ${detail}`);
        }
      }
    }
    if (isUsageLimit(text)) throw new UsageLimit(text);
    return { text, sessionId, costUsd, tokens };
  };
}
