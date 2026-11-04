// Validates tickets, agent specs and questions against the JSON schemas in
// schemas/, which stay the source of truth. Covers the keywords those three
// schemas use; shortcut: no $ref, allOf or format checks, add them when a schema needs one.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");

type Schema = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  enum?: unknown[];
  items?: Schema;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  default?: unknown;
};

const cache = new Map<string, Schema>();
export function loadSchema(name: "ticket" | "agent_spec" | "question" | "department"): Schema {
  let s = cache.get(name);
  if (!s) {
    s = JSON.parse(readFileSync(join(SCHEMAS_DIR, `${name}.schema.json`), "utf8")) as Schema;
    cache.set(name, s);
  }
  return s;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeOk(want: string | string[], v: unknown): boolean {
  const got = typeOf(v);
  const list = Array.isArray(want) ? want : [want];
  return list.some((t) => t === got || (t === "number" && got === "integer"));
}

export function errors(schema: Schema, value: unknown, path = "$"): string[] {
  const out: string[] = [];
  if (schema.type && !typeOk(schema.type, value)) return [`${path}: expected ${schema.type}, got ${typeOf(value)}`];
  if (schema.enum && !schema.enum.includes(value)) out.push(`${path}: must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${path}: does not match ${schema.pattern}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${path}: shorter than ${schema.minLength}`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) out.push(`${path}: below ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => out.push(...errors(schema.items!, v, `${path}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in obj)) out.push(`${path}: missing ${k}`);
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (sub) out.push(...errors(sub, v, `${path}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${path}: unknown field ${k}`);
    }
  }
  return out;
}

export class SchemaError extends Error {
  readonly problems: string[];
  constructor(schema: string, problems: string[]) {
    super(`${schema} is not valid: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

export function validate<T>(name: "ticket" | "agent_spec" | "question" | "department", value: unknown): T {
  const problems = errors(loadSchema(name), value);
  if (problems.length) throw new SchemaError(name, problems);
  return value as T;
}
