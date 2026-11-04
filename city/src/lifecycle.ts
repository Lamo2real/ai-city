// A temporary worker's life: REQUESTED → HIRED → ASSIGNED → WORKING → REVIEW → COMPLETED → RELEASED,
// plus IDLE, BLOCKED, FAILED, PAUSED and CANCELLED. A pure table, so an impossible jump is visible in tests.
export type WorkerState = "requested" | "hired" | "assigned" | "working" | "review" | "completed" | "released" | "idle" | "blocked" | "failed" | "paused" | "cancelled";

const NEXT: Record<WorkerState, WorkerState[]> = {
  requested: ["hired", "cancelled"],
  hired: ["assigned", "idle", "released"],
  assigned: ["working", "blocked", "cancelled", "failed", "released"],
  working: ["review", "assigned", "blocked", "failed", "paused", "cancelled", "idle"],
  review: ["completed", "assigned", "failed"],
  completed: ["released", "idle", "assigned"],
  released: ["hired"],
  idle: ["assigned", "working", "released"],
  blocked: ["working", "assigned", "failed", "cancelled"],
  failed: ["assigned", "released"],
  paused: ["working", "cancelled"],
  cancelled: ["released", "assigned"],
};

export const canMove = (from: WorkerState, to: WorkerState): boolean => from === to || NEXT[from].includes(to);
