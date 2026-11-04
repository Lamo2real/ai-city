// The department registry: departments are data, created and changed without touching source code.
import { overlap } from "./memory.ts";
import { departmentKey } from "./policy.ts";

export interface Department {
  key: string;
  name: string;
  mission: string;
  responsibilities: string[];
  manager_id: string | null;
  model?: string;
  skills: string[];
  tools: string[];
  autonomy: "read_only" | "standard" | "supervised";
  state: "active" | "archived" | "deleted";
  created_at: string;
  updated_at: string;
}

const SIMILAR = 0.6;
const profile = (d: Pick<Department, "name" | "mission" | "responsibilities">) => `${d.name} ${d.mission} ${d.responsibilities.join(" ")}`;

// An existing department that already covers this one: expand it rather than build a second.
export function findOverlap(wanted: Pick<Department, "name" | "mission" | "responsibilities">, existing: Department[]): { department: Department; score: number } | null {
  const key = departmentKey(wanted.name);
  let best: { department: Department; score: number } | null = null;
  for (const d of existing) {
    if (d.state === "deleted") continue;
    const score = d.key === key ? 1 : overlap(profile(wanted), profile(d));
    if (score >= SIMILAR && (!best || score > best.score)) best = { department: d, score };
  }
  return best;
}

export const managerId = (name: string): string => `mgr-${departmentKey(name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 34) || "dept"}`;
