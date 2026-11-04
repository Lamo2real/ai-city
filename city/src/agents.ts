// Agent prompts live in agents/**/*.md with YAML-ish frontmatter (name, model,
// effort, tools). This reads them and fills the {{placeholders}} of templates.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");

// Every worker can report to its sender and ask (its manager answers first), whatever its spec lists.
export const WORKER_TOOLS = ["mcp__jarvis__report", "mcp__jarvis__ask_user"];

export interface AgentPrompt {
  name: string;
  description: string;
  model: string;
  effort: "low" | "medium" | "high";
  tools: string[];
  body: string;
}

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/s, "$1");

export function parsePrompt(text: string): AgentPrompt {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error("agent prompt has no frontmatter");
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = unquote(line.slice(i + 1));
  }
  for (const k of ["name", "model", "tools"]) if (!meta[k]) throw new Error(`agent prompt is missing ${k}`);
  return {
    name: meta.name,
    description: meta.description ?? "",
    model: meta.model,
    effort: (meta.effort as AgentPrompt["effort"]) ?? "medium",
    tools: meta.tools.split(",").map((t) => t.trim()).filter(Boolean),
    body: m[2].trim(),
  };
}

export function loadCorePrompt(name: "jarvis" | "orchestrator" | "secretary" | "reviewer", dir = AGENTS_DIR): AgentPrompt {
  return parsePrompt(readFileSync(join(dir, "core", `${name}.md`), "utf8"));
}

// No template engine: every {{key}} is replaced by its value; unknown keys are an error.
export function renderTemplate(kind: "manager" | "worker", values: Record<string, string>, dir = AGENTS_DIR): string {
  const text = readFileSync(join(dir, "templates", `${kind}.md`), "utf8");
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`template ${kind} needs {{${key}}}`);
    return values[key];
  });
}
