// Agent prompts live in agents/**/*.md with YAML-ish frontmatter (name, model,
// effort, tools). This reads them and fills the {{placeholders}} of templates.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");

// Every worker can report to its sender and ask (its manager answers first), whatever its spec lists.
export const OPENCLAW_CAPABILITIES = ["shell", "files", "web", "desktop"];
export const WORKER_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "mcp__jarvis__report", "mcp__jarvis__ask_user", "mcp__jarvis__remember", "mcp__jarvis__recall", "mcp__jarvis__read_skill", "mcp__jarvis__ask_colleague"];

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

// Skills (agents/skills/*.md) are shared rules appended to the prompt of every manager and worker.
export function loadSkills(dir = AGENTS_DIR): string {
  const d = join(dir, "skills");
  if (!existsSync(d)) return "";
  return readdirSync(d).filter((f) => f.endsWith(".md")).sort().map((f) => readFileSync(join(d, f), "utf8").trim()).join("\n\n");
}

// Managers default to Sonnet; Opus only when the orchestrator hires them. Workers are always Sonnet-or-lower.
export function modelFor(kind: string, parent: string, requested: string): string {
  if (requested !== "claude-opus-5-5") return requested;
  return kind === "manager" && parent === "orchestrator" ? requested : "claude-sonnet-5-5";
}

// The organization's skills library: skills/<name>/SKILL.md. A new skill is a new folder, no code change.
export const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
export interface Skill { name: string; description: string; version: string; path: string }
export function listSkills(dir = SKILLS_DIR): Skill[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md"))).map((e) => {
    const path = join(dir, e.name, "SKILL.md");
    const head = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path, "utf8"))?.[1] ?? "";
    const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(head)?.[1].trim().replace(/^"(.*)"$/, "$1") ?? "";
    return { name: e.name, description: field("description"), version: field("version") || "1", path };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
export function readSkill(name: string, dir = SKILLS_DIR): string {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("bad skill name");
  const path = join(dir, name, "SKILL.md");
  if (!existsSync(path)) throw new Error(`no skill ${name}; see list_skills`);
  return readFileSync(path, "utf8");
}
// Cheap to carry in every prompt: names and one line each. The body is read only when needed.
export function skillsIndex(names: string[], dir = SKILLS_DIR): string {
  const all = new Map(listSkills(dir).map((s) => [s.name, s]));
  const lines = [...new Set(names)].map((n) => all.get(n)).filter((s): s is Skill => !!s).map((s) => `- ${s.name}: ${s.description}`);
  return lines.length ? `\n\n## Skills assigned to you\nRead one with read_skill before work it covers.\n${lines.join("\n")}` : "";
}
