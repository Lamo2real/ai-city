// Reusable multi-step work: config/workflows/*.json expands into tickets with depends_on, so state,
// recovery, parallelism and history are the ledger's, not a second engine's. An approval step waits for the owner.
// OpenClaw's Lobster is not used: it runs tool pipelines inside one agent, and these steps belong to different departments.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKFLOWS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "workflows");

export interface WorkflowStep { id: string; department?: string; goal?: string; approval?: string; depends_on?: string[]; acceptance_criteria?: string[]; complexity?: "simple" | "standard" | "complex" }
export interface Workflow { name: string; description: string; inputs?: string[]; steps: WorkflowStep[] }

// The whole shape is checked before any ticket exists: a bad workflow starts nothing.
export function checkWorkflow(w: Workflow): void {
  if (!w.name || !Array.isArray(w.steps) || !w.steps.length) throw new Error("a workflow needs a name and steps");
  const ids = new Set<string>();
  for (const s of w.steps) {
    if (!/^[a-z0-9-]+$/.test(s.id ?? "")) throw new Error(`bad step id ${s.id}`);
    if (ids.has(s.id)) throw new Error(`step ${s.id} appears twice`);
    ids.add(s.id);
    if (!s.approval && !(s.department && s.goal)) throw new Error(`step ${s.id} needs a department and a goal, or an approval`);
    // Steps are in order, so a dependency must come earlier: that also rules out cycles.
    for (const d of s.depends_on ?? []) if (d === s.id || !ids.has(d)) throw new Error(`step ${s.id} depends on ${d}, which is not an earlier step`);
  }
}

export function loadWorkflows(dir = WORKFLOWS_DIR): Workflow[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    const w = JSON.parse(readFileSync(join(dir, f), "utf8")) as Workflow;
    checkWorkflow(w);
    return w;
  });
}

// {{name}} from the inputs; a missing one stops the start rather than sending an agent a hole in its goal.
export function fill(text: string, inputs: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (inputs[k] === undefined) throw new Error(`workflow input ${k} is missing`);
    return inputs[k];
  });
}
