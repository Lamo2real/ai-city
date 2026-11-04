// A git worktree per ticket, so engineering work in the same repo never collides and a failed
// attempt is one folder to look at. The owner's checkout is never touched.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run("git", ["-C", cwd, ...args], { timeout: 60_000 })).stdout.trim();

export interface Workspace { repo: string; path: string; branch: string; base: string }

export async function allocateWorkspace(root: string, ticketId: string, repo: string, allowedRoots: string[], branch?: string): Promise<Workspace> {
  // Real paths on both sides: a link inside an allowed root must not lead out of it.
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const abs = real(repo);
  if (!allowedRoots.map(real).some((r) => abs === r || abs.startsWith(r + sep))) throw new Error(`${abs} is outside the repos agents may work in (${allowedRoots.join(", ")})`);
  if (!existsSync(join(abs, ".git"))) throw new Error(`${abs} is not the top of a git repository`);
  if (!/^[\w.-]+$/.test(ticketId)) throw new Error("bad ticket id");
  const name = branch ?? `city/${ticketId}`;
  if (!/^[\w./-]+$/.test(name) || name.startsWith("-") || name.includes("..") || /^(main|master)$/.test(name)) throw new Error(`bad branch name ${name}`);
  const path = join(root, ticketId);
  if (existsSync(path)) return { repo: abs, path, branch: await git(path, "rev-parse", "--abbrev-ref", "HEAD"), base: "" };
  mkdirSync(root, { recursive: true });
  const base = await git(abs, "rev-parse", "HEAD");
  await git(abs, "worktree", "add", "-q", "-b", name, path, base);
  return { repo: abs, path, branch: name, base };
}

// Removed only when nothing can be lost: no uncommitted files, and no commits that exist only here.
// Otherwise the worktree stays and the reason comes back.
export async function releaseWorkspace(w: Workspace): Promise<{ removed: boolean; reason?: string }> {
  if (!existsSync(w.path)) return { removed: true };
  if (await git(w.path, "status", "--porcelain")) return { removed: false, reason: "uncommitted changes" };
  const own = await git(w.path, "log", "--oneline", "HEAD", ...(w.base ? [`^${w.base}`] : []), "--not", "--remotes");
  if (own) return { removed: false, reason: "commits not pushed to a remote" };
  await git(w.repo, "worktree", "remove", w.path);
  return { removed: true };
}
