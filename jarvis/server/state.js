// Builds /state.json live from infrastructure@dev and GitHub. Same shape as the
// HUD's DEMO object. uptime and alarms are null: nothing local measures them.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const ORG = "BookingSystemAdvancedOrg";
export const REPOS = ["infrastructure", "application", "admin-front-end", "booqy-console", "customer-front-end", "booqy-website"];
const DOCS = {
  status: "docs/build/STATUS.md",
  pipeline: "docs/build/PIPELINE.md",
  decisions: "docs/adr/DECISIONS.md",
};
const CACHE_MS = 60_000;
const ACTION_CHARS = 90;
const MIN_CLAUSE = 30;
const LOG_CHARS = 140;

function section(md, heading) {
  const lines = (md ?? "").split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).map((l) => l.trim()).filter(Boolean);
}

const cells = (row) => row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function shorten(text, max) {
  const clean = text.replace(/\*\*/g, "").trim();
  // Cut at the first clause only if what remains still says something.
  const cut = clean.search(/:\s|\.\s/);
  const head = cut >= MIN_CLAUSE && cut <= max ? clean.slice(0, cut) : clean;
  return head.length > max ? `${head.slice(0, max - 3).trimEnd()}...` : head;
}

export function parseFeatures(statusMd) {
  const rows = section(statusMd, "Feature ledger").filter((l) => l.startsWith("|"));
  if (rows.length < 2) return { features: [], humanActions: [] };
  const header = cells(rows[0]).map((c) => c.toLowerCase());
  const statusAt = header.indexOf("status");
  const actionsAt = header.indexOf("human actions needed");
  const features = [];
  const humanActions = [];
  for (const row of rows.slice(1)) {
    const c = cells(row);
    const m = c[0].match(/^([A-Z])\.\s*(.+)$/);
    if (!m) continue;
    features.push({ id: m[1], name: m[2], status: (c[statusAt] || "todo").toLowerCase() });
    const action = c[actionsAt];
    if (action && !/^depends on/i.test(action)) humanActions.push(action);
  }
  return { features, humanActions };
}

export function parsePipeline(pipelineMd) {
  const lockLine = section(pipelineMd, "Lock")[0] ?? "";
  const position = section(pipelineMd, "Position");
  const stepLine = position.find((l) => /^step:/i.test(l))?.replace(/^step:\s*/i, "") ?? "";
  const [step, ...rest] = stepLine.split(/\.\s+/);
  return {
    pipeline: {
      step: step.replace(/\.$/, "") || "idle",
      feature: step.match(/\(([^)]*)\)/)?.[1] ?? "",
      round: Number(stepLine.match(/round (\d+)/i)?.[1] ?? 0),
      lock: !lockLine ? "unknown" : /^(unlocked|free)/i.test(lockLine) ? "free" : "held",
    },
    progress: rest.join(". "),
    next: position.find((l) => /^next run:/i.test(l)) ?? "",
    needsOwner: section(pipelineMd, "Needs owner").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)),
  };
}

export function parseDecisions(decisionsMd) {
  return (decisionsMd ?? "").split("\n").filter((l) => /\[NEEDS YOUR OK\]/.test(l)).map((l) => l.replace(/^[-*|\s]+/, ""));
}

function rollupState(rollup) {
  const checks = rollup ?? [];
  const failed = (c) => ["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ERROR", "ACTION_REQUIRED"].includes(c.conclusion ?? c.state);
  if (checks.some(failed)) return "fail";
  if (checks.some((c) => (c.__typename === "StatusContext" ? c.state === "PENDING" : c.status !== "COMPLETED"))) return "running";
  return "pass";
}

export function prState(pr) {
  const ci = rollupState(pr.statusCheckRollup);
  if (pr.isDraft) return "draft";
  if (ci === "fail") return "ci_failing";
  if (ci === "running") return "ci_running";
  if (pr.reviewDecision === "APPROVED") return "approved";
  return "awaiting_approval";
}

// Latest run per workflow on dev, skipping runs that never really ran.
export function ciStatus(runs) {
  const seen = new Set();
  let status = "none";
  for (const r of runs) {
    if (seen.has(r.workflowName)) continue;
    if (r.status === "completed" && ["skipped", "neutral", "cancelled"].includes(r.conclusion)) continue;
    seen.add(r.workflowName);
    if (r.status !== "completed") status = status === "fail" ? "fail" : "running";
    else if (r.conclusion !== "success") status = "fail";
    else if (status === "none") status = "pass";
  }
  return status;
}

export function createStateSource({ booqyDir, logger = () => {}, now = Date.now }) {
  const infra = join(booqyDir, "infrastructure");
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oConnectTimeout=10" };
  const ghEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
  const gh = async (...args) => (await run("gh", args, { env: ghEnv, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout;

  let cached = null;
  let cachedAt = 0;
  let inFlight = null;
  const lastGood = new Map();

  async function readDocs() {
    let fetched = true;
    try {
      await run("git", ["-C", infra, "fetch", "--quiet", "origin", "dev"], { env: gitEnv, timeout: 30_000 });
    } catch (err) {
      fetched = false;
      logger(`git fetch failed (${err.code ?? "error"}), reading through gh`);
    }
    const read = async (path) => {
      try {
        if (fetched) return (await run("git", ["-C", infra, "show", `origin/dev:${path}`], { env: gitEnv, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
        return await gh("api", "-H", "Accept: application/vnd.github.raw", `repos/${ORG}/infrastructure/contents/${path}?ref=dev`);
      } catch (err) {
        // A missing file is an answer. Anything else on the gh path is a failure.
        if (fetched || /404|Not Found/i.test(String(err.stderr))) return null;
        throw err;
      }
    };
    const [status, pipeline, decisions] = await Promise.all([read(DOCS.status), read(DOCS.pipeline), read(DOCS.decisions)]);
    return { status, pipeline, decisions };
  }

  async function readRepo(repo) {
    try {
      const [prs, runs] = await Promise.all([
        gh("pr", "list", "-R", `${ORG}/${repo}`, "--state", "open", "--limit", "50", "--json", "number,title,url,baseRefName,isDraft,reviewDecision,statusCheckRollup"),
        gh("run", "list", "-R", `${ORG}/${repo}`, "--branch", "dev", "--limit", "20", "--json", "status,conclusion,workflowName"),
      ]);
      const data = {
        prs: JSON.parse(prs).map((p) => ({ repo, number: p.number, title: p.title, state: prState(p), url: p.url })),
        ci: { repo, status: ciStatus(JSON.parse(runs)) },
      };
      lastGood.set(repo, data);
      return { ...data, stale: false };
    } catch (err) {
      logger(`gh failed for ${repo} (${err.code ?? "error"})`);
      return { ...(lastGood.get(repo) ?? { prs: [], ci: { repo, status: "unknown" } }), stale: true };
    }
  }

  async function build() {
    const docs = await readDocs();
    if (!docs.status) throw new Error("STATUS.md could not be read");
    const repos = await Promise.all(REPOS.map(readRepo));
    const { features, humanActions } = parseFeatures(docs.status);
    const { pipeline, progress, next, needsOwner } = parsePipeline(docs.pipeline);
    const actions = [...needsOwner, ...parseDecisions(docs.decisions), ...humanActions].map((a) => shorten(a, ACTION_CHARS));
    const ci = repos.map((r) => r.ci);
    const known = ci.filter((c) => c.status === "pass" || c.status === "fail");
    const stale = repos.filter((r) => r.stale).map((r) => r.ci.repo);
    const updated = docs.status.match(/^Last updated:\s*(.+)$/m)?.[1];
    return {
      generatedAt: new Date(now()).toISOString(),
      demo: false,
      pipeline,
      features,
      prs: repos.flatMap((r) => r.prs),
      ci,
      actions: [...new Set(actions)],
      uptime: null,
      ciPass: known.length ? Math.round((100 * known.filter((c) => c.status === "pass").length) / known.length) : null,
      alarms: null,
      log: [
        stale.length ? `GitHub unreachable for ${stale.join(", ")}: showing last known data` : "",
        updated ? `STATUS.md: ${updated}` : "",
        progress,
        next,
      ].filter(Boolean).map((l) => (l.length > LOG_CHARS ? `${l.slice(0, LOG_CHARS - 3).trimEnd()}...` : l)),
    };
  }

  return async function getState() {
    if (cached && now() - cachedAt < CACHE_MS) return cached;
    inFlight ??= build()
      .then((state) => {
        cached = state;
        cachedAt = now();
        return state;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
