// The gate every agent turn passes through: how many run at once, what happens when the
// subscription's usage limit hits (the city waits, tickets do not fail), and retries for
// provider hiccups. All agents share one subscription, so this is one gate for the whole city.
import { UsageLimit, isPausableLimit } from "./sdk.ts";

export const DEFAULT_PAUSE_MS = 30 * 60_000;
const MAX_PAUSE_MS = 8 * 3_600_000;
const MAX_DATED_PAUSE_MS = 8 * 24 * 3_600_000;
const MAX_PAUSES_PER_TURN = 12;
const MARGIN_MS = 60_000;

// "You've hit your 5-hour limit · resets 6:30am (Europe/Stockholm)" → when to try again.
export function parseReset(message: string, nowMs: number): number {
  // A weekly limit names a day: "resets Nov 8" or "resets Nov 8, 6am".
  const day = /resets\s+([A-Z][a-z]{2})[a-z]*\s+(\d{1,2})(?:,?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/.exec(message);
  if (day) {
    let hour = Number(day[3] ?? 0);
    if (day[5]?.toLowerCase() === "pm" && hour < 12) hour += 12;
    if (day[5]?.toLowerCase() === "am" && hour === 12) hour = 0;
    const when = (year: number) => new Date(`${day[1]} ${day[2]} ${year} ${hour}:${day[4] ?? "00"}:00`).getTime();
    const year = new Date(nowMs).getFullYear();
    const at = when(year) > nowMs ? when(year) : when(year + 1);
    if (!Number.isNaN(at)) return Math.min(at + MARGIN_MS, nowMs + MAX_DATED_PAUSE_MS);
  }
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(message);
  if (!m) return nowMs + DEFAULT_PAUSE_MS;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3]?.toLowerCase() === "pm" && h < 12) h += 12;
  if (m[3]?.toLowerCase() === "am" && h === 12) h = 0;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: m[4] || undefined, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(nowMs);
    const cur = (Number(parts.find((p) => p.type === "hour")!.value) % 24) * 60 + Number(parts.find((p) => p.type === "minute")!.value);
    const wait = (h * 60 + min - cur + 1440) % 1440 || 1440;
    return nowMs + Math.min(wait * 60_000 + MARGIN_MS, MAX_PAUSE_MS);
  } catch {
    return nowMs + DEFAULT_PAUSE_MS; // an unknown time zone in the message
  }
}

// Worth another attempt: the provider or network hiccuped. Anything else is a real failure.
const TRANSIENT = /overloaded|\b529\b|\b50[234]\b|\b429\b|rate.?limit|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network error|temporarily unavailable|internal server error/i;
export const isTransient = (message: string): boolean => TRANSIENT.test(message);

export interface GateOptions {
  maxConcurrent: number;
  retries?: number;
  backoffMs?: number[];
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onPause?: (until: number, reason: string) => void;
  onResume?: () => void;
  onRetry?: (attempt: number, reason: string) => void;
}

export interface Attempt { attempt: number; signal: AbortSignal; restarted: boolean }
// nested: a turn its caller is waiting for from inside its own slot; taking a slot too could freeze the city.
// canRetry: false once the turn has acted, because running it again would act twice.
export interface RunOptions { nested?: boolean; canRetry?: () => boolean }

export function createGate(o: GateOptions) {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = o.retries ?? 2;
  const backoff = o.backoffMs ?? [5_000, 30_000];
  let active = 0;
  let pausedUntil = 0;
  const waiting: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < o.maxConcurrent) { active++; return Promise.resolve(); }
    return new Promise((resolve) => waiting.push(resolve)); // the releaser hands its slot over
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next(); else active--;
  };
  async function waitUnpaused(): Promise<void> {
    while (pausedUntil > now()) await sleep(Math.max(1, pausedUntil - now()));
    if (pausedUntil) { pausedUntil = 0; o.onResume?.(); }
  }

  async function withDeadline<T>(fn: (a: Attempt) => Promise<T>, attempt: number, paused: boolean, outer?: AbortSignal): Promise<T> {
    const ctrl = new AbortController();
    const onOuter = () => ctrl.abort(outer!.reason);
    if (outer?.aborted) onOuter(); else outer?.addEventListener("abort", onOuter, { once: true });
    const timer = o.timeoutMs ? setTimeout(() => ctrl.abort(new Error(`turn timed out after ${Math.round(o.timeoutMs! / 60_000)} minutes`)), o.timeoutMs) : null;
    try {
      return await Promise.race([
        fn({ attempt, signal: ctrl.signal, restarted: attempt > 0 || paused }),
        new Promise<never>((_, reject) => ctrl.signal.addEventListener("abort", () => reject(ctrl.signal.reason instanceof Error ? ctrl.signal.reason : new Error("turn cancelled")), { once: true })),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    }
  }

  return {
    get paused() { return pausedUntil > now() ? pausedUntil : 0; },
    get active() { return active; },
    get waiting() { return waiting.length; },
    clearPause() { pausedUntil = 1; }, // for tests: the reset has passed
    async run<T>(fn: (a: Attempt) => Promise<T>, signal?: AbortSignal, opts: RunOptions = {}): Promise<T> {
      const take = opts.nested ? () => Promise.resolve() : acquire;
      const give = opts.nested ? () => {} : release;
      let attempt = 0;
      let pauses = 0;
      for (;;) {
        await waitUnpaused();
        await take();
        if (pausedUntil > now()) { give(); continue; } // the limit hit while this turn stood in line
        if (signal?.aborted) { give(); throw new Error("turn cancelled"); }
        let retryIn = 0;
        try {
          return await withDeadline(fn, attempt, pauses > 0, signal);
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          if (err instanceof UsageLimit && isPausableLimit(message) && pauses < MAX_PAUSES_PER_TURN) {
            pauses++;
            pausedUntil = Math.max(pausedUntil, parseReset(message, now()));
            o.onPause?.(pausedUntil, message);
          } else if (!signal?.aborted && isTransient(message) && attempt < retries && (opts.canRetry?.() ?? true)) {
            o.onRetry?.(attempt + 1, message);
            retryIn = backoff[Math.min(attempt, backoff.length - 1)];
            attempt++;
          } else {
            throw err;
          }
        } finally {
          give();
        }
        if (retryIn) await sleep(retryIn); // outside the slot, so a waiting turn can use it
      }
    },
  };
}

export type Gate = ReturnType<typeof createGate>;
