// One turn of one agent through the Claude Agent SDK. Everything the runtime
// needs from the SDK goes through `Runner`, so tests can swap in a fake.
import { USAGE_LIMIT_ERROR_PREFIXES, createSdkMcpServer, query, tool, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
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
  onTextEnd?: () => void; // a text block is complete, so whatever is held for a sentence end can go
  onTool?: (name: string, input: unknown) => void;
  onSession?: (id: string) => void; // as soon as the session has an id, so it can be asked about mid-turn
  signal?: AbortSignal;
  fallbackModel?: string;
  attempt?: number;
  // The runtime's policy decision for one tool call (approvals, autonomy levels). Without it: decide() alone.
  guard?: (toolName: string, input: Record<string, unknown>) => { allow: true } | { allow: false; message: string };
  capabilities?: string[];
  // A side question: reads this session's history in a copy, so it needs no turn slot and leaves the agent's own work alone.
  forkSession?: boolean;
}

export interface TurnResult {
  text: string;
  sessionId: string;
  costUsd: number; // CUMULATIVE for the session (SDK total_cost_usd); the ledger turns it into a per-turn delta
  tokens?: number; // input + output + cache read + cache write tokens of the turn
  durationMs?: number;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compact?: { pre: number; post: number }; // set when the SDK compacted the session this turn (a /compact prompt)
  contextTokens?: number; // input + cache_read + cache_write of the last result: how big the session is now
}

export type Runner = (req: TurnRequest) => Promise<TurnResult>;

export class UsageLimit extends Error {}
// The SDK wraps the CLI's text ("Claude Code returned an error result: You've hit your 5-hour limit …"), so this looks inside.
export const isUsageLimit = (text: string) => USAGE_LIMIT_ERROR_PREFIXES.some((p) => text.includes(p));
// A limit that passes with time. "Your seat type doesn't include usage" and the like never will: those stay failures.
export const isPausableLimit = (text: string) => /You've (hit|reached) your|out of (extra )?usage|out of usage credits/i.test(text);

// JARVIS_MODEL_CAP=claude-sonnet-5-5 runs everything above Sonnet on Sonnet (smoke tests).
const RANK = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"];
export function capModel(model: string, cap = process.env.JARVIS_MODEL_CAP): string {
  if (!cap || RANK.indexOf(cap) < 0) return model;
  return RANK.indexOf(model) > RANK.indexOf(cap) ? cap : model;
}

type QueryFn = typeof query;

// "Bash(osascript:*)" → "Bash"; MCP tools are not built-ins. An agent whose prompt lists none gets none.
export const builtinTools = (allowed: string[]) => [...new Set(allowed.map((t) => t.replace(/\(.*$/, "")).filter((t) => !t.startsWith("mcp__")))];

// An outside server reaches only the agents policy.json names, and only when this turn may use one of its tools.
const atHome = (s: string) => s.replace(/^~(?=\/)/, homedir());
export function outsideServers(agentId: string, allowedTools: string[], policy: Policy): NonNullable<Options["mcpServers"]> {
  const usable = Object.entries(policy.mcp_servers ?? {}).filter(([name, s]) => s.agents.includes(agentId) && allowedTools.some((t) => t.startsWith(`mcp__${name}__`)) && existsSync(atHome(s.command)));
  return Object.fromEntries(usable.map(([name, s]) => [name, { type: "stdio" as const, command: atHome(s.command), args: s.args.map(atHome) }]));
}

function turnOptions(req: TurnRequest, policy: Policy, env: Record<string, string>, abort: AbortController): Options {
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
  return {
    model: capModel(req.model),
    fallbackModel: req.fallbackModel && capModel(req.fallbackModel) !== capModel(req.model) ? capModel(req.fallbackModel) : undefined,
    effort: req.effort,
    systemPrompt: { type: "custom", prompt: req.systemPrompt },
    allowedTools: req.allowedTools,
    tools: builtinTools(req.allowedTools),
    permissionMode: "dontAsk",
    settingSources: [],
    mcpServers: { ...outsideServers(req.agentId, req.allowedTools, policy), jarvis },
    strictMcpConfig: true,
    includePartialMessages: true,
    persistSession: true,
    cwd: req.cwd,
    env,
    abortController: abort,
    resume: req.resume ?? undefined,
    forkSession: req.forkSession,
    // dontAsk denies anything that would prompt; the hook below gates every call, allowed or not.
    hooks: {
      PreToolUse: [{
        hooks: [async (input) => {
          if (input.hook_event_name !== "PreToolUse") return {};
          if (req.guard) {
            const g = req.guard(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
            return g.allow ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: g.message } };
          }
          const [decision, reason] = decide(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, policy);
          audit(policy, input.tool_name, decision, reason, req.agentId);
          if (decision === "allow") return {};
          // shortcut: "ask" is denied with the reason, the agent asks the owner through ask_user; add an approvals store when a gated action must be retried after a yes.
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${reason} Not run. Ask the owner with ask_user if it is needed.` } };
        }],
      }],
    },
  };
}

// Reads one turn's messages, whichever executor shape delivers them. take() is true at the turn's result.
function turnReader(req: TurnRequest, resume?: string | null) {
  let text = "";
  let sessionId = resume ?? "";
  let costUsd = 0;
  let tokens = 0;
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let contextTokens = 0;
  let compact: TurnResult["compact"];
  let durationMs = 0;
  let announced = false;
  return {
    take(m: SDKMessage): boolean {
      if (!announced && m.session_id) { announced = true; req.onSession?.(m.session_id); }
      if (m.type === "stream_event") {
        const e = m.event as { type: string; delta?: { type?: string; text?: string } };
        if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) req.onText?.(e.delta.text);
        else if (e.type === "content_block_stop") req.onTextEnd?.();
      } else if (m.type === "assistant") {
        for (const part of m.message.content) if (part.type === "tool_use") req.onTool?.(part.name, part.input);
      } else if (m.type === "system" && m.subtype === "compact_boundary") {
        compact = { pre: m.compact_metadata.pre_tokens, post: m.compact_metadata.post_tokens ?? 0 };
      } else if (m.type === "result") {
        sessionId = m.session_id;
        durationMs = m.duration_ms ?? 0;
        costUsd = m.total_cost_usd ?? 0;
        usage = { input: m.usage?.input_tokens ?? 0, output: m.usage?.output_tokens ?? 0, cacheRead: m.usage?.cache_read_input_tokens ?? 0, cacheWrite: m.usage?.cache_creation_input_tokens ?? 0 };
        tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        contextTokens = (m.usage?.input_tokens ?? 0) + (m.usage?.cache_read_input_tokens ?? 0) + (m.usage?.cache_creation_input_tokens ?? 0);
        if (m.subtype === "success") text = m.result;
        else {
          const detail = m.errors.join("; ");
          if (isUsageLimit(detail)) throw new UsageLimit(detail);
          throw new Error(`${req.agentId}: ${m.subtype}: ${detail}`);
        }
        return true;
      }
      return false;
    },
    finish(): TurnResult {
      // A normal reply may mention limits; only a reply that IS the limit message counts.
      if (USAGE_LIMIT_ERROR_PREFIXES.some((p) => text.startsWith(p))) throw new UsageLimit(text);
      if (compact?.post) contextTokens = compact.post;
      return { text, sessionId, costUsd, tokens, usage, contextTokens, durationMs, ...(compact ? { compact } : {}) };
    },
  };
}

// The SDK also throws on an error result, with the CLI's text inside its own sentence.
const asLimit = (err: unknown) => (!(err instanceof UsageLimit) && isUsageLimit((err as Error).message ?? "") ? new UsageLimit((err as Error).message) : err);

export function createRunner({ policy, env, queryFn = query }: { policy: Policy; env: Record<string, string>; queryFn?: QueryFn }): Runner {
  return async (req) => {
    const abort = new AbortController();
    req.signal?.addEventListener("abort", () => abort.abort(), { once: true });
    const turn = turnReader(req, req.resume);
    try {
      for await (const m of queryFn({ prompt: req.prompt, options: turnOptions(req, policy, env, abort) }) as AsyncIterable<SDKMessage>) turn.take(m);
    } catch (err) {
      throw asLimit(err);
    }
    return turn.finish();
  };
}

// A process waiting for its next turn: start-up and every MCP handshake are already behind it. The session
// is still persisted turn by turn, so a dead process costs one slow turn (the next one resumes), not memory.
export interface WarmRunner {
  run(key: string, req: TurnRequest): Promise<TurnResult>;
  warmUp(key: string, req: TurnRequest): void;
  close(): void;
}

const MAX_WARM = 2; // Each holds about 250 MB and its MCP children, so the least recently used one goes.
const INTERRUPT_MS = 3000;

interface Warm {
  q: Query;
  next: () => Promise<IteratorResult<SDKMessage>>;
  send: (text: string) => void;
  close: () => void;
  session: string | null;
  settling: Promise<void> | null; // an interrupted turn draining to its result
  dead: boolean;
}

export function createWarmRunner({ policy, env, queryFn = query }: { policy: Policy; env: Record<string, string>; queryFn?: QueryFn }): WarmRunner {
  const warms = new Map<string, Warm>();

  function drop(key: string, w: Warm) {
    w.close();
    if (warms.get(key) === w) warms.delete(key);
  }

  function start(key: string, req: TurnRequest): Warm {
    const abort = new AbortController();
    const waiting: SDKUserMessage[] = [];
    let wake: (() => void) | undefined;
    let open = true;
    const input = (async function* () {
      while (open) {
        if (!waiting.length) await new Promise<void>((r) => { wake = r; });
        while (waiting.length) yield waiting.shift()!;
      }
    })();
    const q = queryFn({ prompt: input, options: turnOptions(req, policy, env, abort) });
    const iterator = q[Symbol.asyncIterator]();
    const w: Warm = {
      q,
      next: () => iterator.next(),
      send: (text) => { waiting.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" }); wake?.(); },
      close: () => { w.dead = true; open = false; wake?.(); abort.abort(); },
      session: req.resume ?? null,
      settling: null,
      dead: false,
    };
    warms.delete(key);
    warms.set(key, w);
    for (const [k, other] of warms) if (warms.size > MAX_WARM && other !== w) drop(k, other);
    return w;
  }

  // Stop the turn but keep the process, so the owner's next words (barge-in) still find it warm.
  function interrupt(key: string, w: Warm, pending: Promise<IteratorResult<SDKMessage>>) {
    const drained = (async () => {
      await w.q.interrupt();
      for (let read = pending; ; read = w.next()) {
        const { value, done } = await read;
        if (done) return false;
        if (value.type === "result") return true; // Same session: the caller's id for it, if it has one yet, still fits.
      }
    })().catch(() => false);
    const timeout = new Promise<false>((r) => { setTimeout(r, INTERRUPT_MS, false).unref?.(); });
    w.settling = Promise.race([drained, timeout]).then((ok) => {
      if (!ok) drop(key, w);
      w.settling = null;
    });
  }

  async function deliver(key: string, w: Warm, req: TurnRequest): Promise<TurnResult> {
    const turn = turnReader(req, w.session);
    const stopped = new Promise<never>((_, reject) => {
      const onAbort = () => reject(Object.assign(new Error("turn cancelled"), { cancelled: true }));
      if (req.signal?.aborted) onAbort();
      else req.signal?.addEventListener("abort", onAbort, { once: true });
    });
    stopped.catch(() => {});
    w.send(req.prompt);
    let began = false;
    for (;;) {
      const pending = w.next();
      const { value, done } = await Promise.race([pending, stopped]).catch((err) => {
        if (err.cancelled) interrupt(key, w, pending);
        else err.unstarted = !began;
        throw err;
      });
      if (done) throw Object.assign(new Error(`${req.agentId}: the warm process ended`), { unstarted: !began });
      if (value.type === "stream_event" || value.type === "assistant") began = true;
      if (turn.take(value)) break;
    }
    const result = turn.finish();
    w.session = result.sessionId;
    return result;
  }

  return {
    async run(key, req) {
      let w = warms.get(key);
      if (w?.settling) await w.settling;
      w = warms.get(key);
      const reusing = !!w && !w.dead && w.session === (req.resume ?? null);
      if (w && !reusing) drop(key, w);
      const warm = reusing ? w! : start(key, req);
      warms.delete(key);
      warms.set(key, warm); // most recently used last
      try {
        return await deliver(key, warm, req);
      } catch (err) {
        if ((err as { cancelled?: boolean }).cancelled) throw err;
        drop(key, warm);
        // A parked process can die unseen. Nothing of this turn has happened yet, so a new one can take it.
        if ((err as { unstarted?: boolean }).unstarted && reusing && !isUsageLimit((err as Error).message ?? "")) return this.run(key, req);
        throw asLimit(err);
      }
    },
    warmUp(key, req) {
      const w = warms.get(key);
      if (!w || w.dead) start(key, req);
    },
    close() {
      for (const [k, w] of warms) drop(k, w);
    },
  };
}
