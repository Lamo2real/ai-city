// The policy gate, ported from .claude/hooks/policy_gate.py so the runtime's
// can_use_tool makes exactly the decisions the Claude Code hook makes.
// config/policy.json is the single source of rules; both read it.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Decision = "allow" | "ask" | "deny";

export interface Rule {
  tool: string;
  match: string;
  decision: Decision;
  reason: string;
}

export interface Policy {
  audit_log: string;
  caps: {
    ad_daily_budget_cents: number;
    max_active_agents_per_department: number; // active (non-retired, non-core) agents any one department may have
    department_caps?: Record<string, number>; // per-department overrides of the line above
    max_workers_per_manager: number;
    daily_spend_usd_per_department: number;
    max_review_rounds: number;
  };
  rules: Rule[];
}

// A department with no override gets the default, so a brand-new department is capped from its first hire.
// Department names compare trimmed, with inner whitespace collapsed, case-insensitively: "it", "IT " and "IT" are one department.
export const canonDepartment = (name: string): string => name.trim().replace(/\s+/g, " ");
export const departmentKey = (name: string): string => canonDepartment(name).toLowerCase();
export function departmentCap(policy: Policy, department: string): number {
  const caps = policy.caps.department_caps ?? {};
  const k = Object.keys(caps).find((name) => departmentKey(name) === departmentKey(department));
  return (k !== undefined ? caps[k] : undefined) ?? policy.caps.max_active_agents_per_department;
}

export const POLICY_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "policy.json");
const BUDGET_KEYS = ["daily_budget", "lifetime_budget"] as const;

export function loadPolicy(path: string = POLICY_PATH): Policy {
  return JSON.parse(readFileSync(path, "utf8")) as Policy;
}

// Same text the Python hook matches against: JSON with sorted keys.
export function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(", ")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map((k) => `${JSON.stringify(k)}: ${sortedJson(record[k])}`);
    return `{${entries.join(", ")}}`;
  }
  return JSON.stringify(value);
}

export function decide(toolName: string, toolInput: Record<string, unknown>, policy: Policy): [Decision, string] {
  const blob = sortedJson(toolInput);
  let found: [Decision, string] = ["allow", ""];
  for (const r of policy.rules) {
    if (new RegExp(r.tool).test(toolName) && new RegExp(r.match).test(blob)) {
      if (r.decision === "deny") return ["deny", r.reason];
      found = ["ask", r.reason];
    }
  }
  if (toolName.startsWith("mcp__meta-ads__")) {
    const cap = policy.caps.ad_daily_budget_cents;
    for (const k of BUDGET_KEYS) {
      const v = toolInput[k];
      if (v !== undefined && v !== null && Number(v) > cap) return ["ask", `${k} ${v} is over the ${cap}-cent cap.`];
    }
  }
  return found;
}

export const auditPath = (policy: Policy) => policy.audit_log.replace(/^~(?=$|\/)/, homedir());

export function audit(policy: Policy, toolName: string, decision: Decision, reason: string, agent?: string): void {
  const path = auditPath(policy);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ ts: Date.now() / 1000, tool: toolName, decision, reason, ...(agent ? { agent } : {}) })}\n`);
}
