/**
 * What the settings page reads and does, apart from repo and review
 * deletion (`cleanup.ts`):
 *
 * - integrations: is `claude` there, are `gh`/`glab` on PATH, can each
 *   forge host the registered repos point at actually be asked, and which
 *   language server would answer hover/peek per language;
 * - Full Disk Access for the installed binary on macOS, opening the pane
 *   to grant it, and restarting the background service so a grant applies;
 * - the data directory's footprint, and clearing what's only a cache
 *   (agent and review worktrees, agent sessions, cached forge answers).
 */
import { spawn } from 'node:child_process';
import { open, readdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DataUsage, FullDiskAccess, Integrations } from '@joinery/core';
import { removeAgentWorktree, removeOwnWorktree } from './agent/maintenance.ts';
import { findClaudeExecutable } from './agent/claudeExecutable.ts';
import { deleteAllSessions, listSessionFiles, sessionsDir } from './agent/sessions.ts';
import { cacheEntryStats, clearCacheEntries, listRepos, listUnfinishedRuns, listWorktrees, type Db } from './db/index.ts';
import { resolveDataPaths } from './db/paths.ts';
import { diagnose } from './git/forge/cli.ts';
import { installedServers } from './lsp/index.ts';
import { lspViews } from './lsp/views.ts';
import { conflict } from './http/errors.ts';
import { runsAsService, runtimeLayout, serviceRestartCommand } from './runtime.ts';
import { clearAllStoredCaches } from './storedCache.ts';

const FULL_DISK_ACCESS_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

export async function getIntegrations(db: Db): Promise<Integrations> {
  const repos = await listRepos(db);
  // One row per forge host, probed from the first repo that points at it.
  const byHost = new Map<string, { forge: 'github' | 'gitlab'; cwd: string; repos: number }>();
  for (const r of repos) {
    if (r.remoteHost === null || (r.forge !== 'github' && r.forge !== 'gitlab')) continue;
    const entry = byHost.get(r.remoteHost);
    if (entry === undefined) byHost.set(r.remoteHost, { forge: r.forge, cwd: r.rootPath, repos: 1 });
    else entry.repos += 1;
  }
  const hosts = await Promise.all(
    Array.from(byHost, async ([host, { forge, cwd, repos: count }]) => {
      const cli = forge === 'github' ? ('gh' as const) : ('glab' as const);
      return { host, forge, cli, repos: count, reason: await diagnose(cli, host, cwd) };
    }),
  );
  return {
    git: { path: Bun.which('git') },
    claude: { path: findClaudeExecutable(), bundled: runtimeLayout().mode !== 'installed' },
    clis: (['gh', 'glab'] as const).map((cli) => ({ cli, path: Bun.which(cli) })),
    hosts: hosts.sort((a, b) => a.host.localeCompare(b.host)),
    lsp: await installedServers(),
  };
}

/** The installed binary macOS keys the grant on (the real file, not a symlink); null in a source checkout. */
async function installedBinary(): Promise<string | null> {
  const layout = runtimeLayout();
  if (layout.mode !== 'installed') return null;
  try {
    return await realpath(join(layout.home, 'current', 'joinery'));
  } catch {
    return null;
  }
}

/**
 * Whether this process has Full Disk Access: only a granted process may
 * read the TCC database, so opening it is the check. Doesn't prompt.
 */
async function hasFullDiskAccess(): Promise<boolean> {
  try {
    const handle = await open(join(homedir(), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db'), 'r');
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

export async function getFullDiskAccess(): Promise<FullDiskAccess> {
  const binary = await installedBinary();
  const applies = process.platform === 'darwin' && binary !== null;
  return {
    applies,
    granted: applies ? await hasFullDiskAccess() : null,
    binary,
    canRestart: applies && runsAsService(),
  };
}

function openDetached(args: readonly string[]): void {
  spawn('open', [...args], { detached: true, stdio: 'ignore' }).unref();
}

/** The same two steps as `joinery permissions`: the pane, and the binary revealed in Finder to drag in. */
export async function openFullDiskAccess(): Promise<void> {
  const binary = await installedBinary();
  if (process.platform !== 'darwin' || binary === null) {
    throw conflict('Full Disk Access only applies to an installed build on macOS', 'Grant it to your terminal instead.');
  }
  openDetached([FULL_DISK_ACCESS_PANE]);
  openDetached(['-R', binary]);
}

/** Restarting the service replaces this process, so it's spawned detached and the response goes out first. */
export function restartServer(): void {
  if (!runsAsService()) {
    throw conflict('the server is not running as the background service', 'Restart `joinery serve` yourself.');
  }
  const [cmd, ...args] = serviceRestartCommand();
  const child = spawn(cmd ?? '', args, { detached: true, stdio: 'ignore' });
  child.unref();
}

/** Total bytes on disk under `path`, via `du` (fast on a big tree); 0 when it's missing. */
async function diskUsage(path: string): Promise<number> {
  try {
    await stat(path);
  } catch {
    return 0;
  }
  const proc = Bun.spawn(['du', '-sk', path], { stdout: 'pipe', stderr: 'ignore' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const kib = Number.parseInt(out.trim().split(/\s+/)[0] ?? '', 10);
  return Number.isFinite(kib) ? kib * 1024 : 0;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** The checkouts on disk under `dir`, laid out `<repo>/<checkout>`. */
async function checkoutDirs(dir: string, skip: ReadonlySet<string> = new Set()): Promise<string[]> {
  const list = async (path: string): Promise<string[]> =>
    (await readdir(path).catch(() => [] as string[])).filter((name) => !name.startsWith('.'));
  const repos = (await list(dir)).filter((name) => !skip.has(name));
  const nested = await Promise.all(
    repos.map(async (repo) => (await list(join(dir, repo))).map((name) => join(dir, repo, name))),
  );
  return nested.flat();
}

/** Agent worktrees on disk, rows or not: one left by a lost database still takes space. */
function agentWorktreeDirs(worktreesDir: string): Promise<string[]> {
  return checkoutDirs(worktreesDir, new Set(['lsp']));
}

export async function getDataUsage(db: Db): Promise<DataUsage> {
  const paths = resolveDataPaths();
  const lspDir = join(paths.worktreesDir, 'lsp');
  const [db0, wal, agentDirs, worktreeBytes, reviewDirs, reviewBytes, sessionFiles, sessionBytes, cached] = await Promise.all([
    fileSize(paths.dbFile),
    fileSize(`${paths.dbFile}-wal`),
    agentWorktreeDirs(paths.worktreesDir),
    diskUsage(paths.worktreesDir),
    checkoutDirs(lspDir),
    diskUsage(lspDir),
    listSessionFiles(),
    diskUsage(sessionsDir()),
    cacheEntryStats(db),
  ]);
  return {
    root: paths.root,
    databaseBytes: db0 + wal,
    worktrees: { count: agentDirs.length, bytes: worktreeBytes },
    reviewWorktrees: { count: reviewDirs.length, bytes: reviewBytes },
    sessions: { count: sessionFiles.length, bytes: sessionBytes },
    cachedAnswers: cached,
  };
}

/**
 * Remove every agent worktree; returns how many. Refused while a run is going, since its worktree would be pulled out
 * from under it.
 */
export async function clearWorktrees(db: Db): Promise<number> {
  if ((await listUnfinishedRuns(db)).length > 0) {
    throw conflict('an agent run is in progress', 'Wait for it to finish, or cancel it, then try again.');
  }
  let removed = 0;
  for (const worktree of await listWorktrees(db)) {
    try {
      await removeAgentWorktree(db, worktree);
      removed += 1;
    } catch (err) {
      console.log(`[worktrees] could not remove ${worktree.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Left without a row (e.g. by an earlier database): nothing runs in them.
  const { worktreesDir } = resolveDataPaths();
  for (const path of await agentWorktreeDirs(worktreesDir)) {
    await removeOwnWorktree(path, null).catch(() => undefined);
    await rm(path, { recursive: true, force: true });
    removed += 1;
  }
  for (const repo of await readdir(worktreesDir).catch(() => [] as string[])) {
    if (repo !== 'lsp') await rm(join(worktreesDir, repo), { recursive: true, force: true });
  }
  return removed;
}

/** Remove every review worktree (language-server checkout); returns how many. */
export function clearReviewWorktrees(): Promise<number> {
  return lspViews.clearCheckouts();
}

/**
 * Delete every agent session; returns how many. Refused while a run is
 * going, since it is writing to its own. Threads start fresh sessions after.
 */
export async function clearSessions(db: Db): Promise<number> {
  if ((await listUnfinishedRuns(db)).length > 0) {
    throw conflict('an agent run is in progress', 'Wait for it to finish, or cancel it, then try again.');
  }
  return deleteAllSessions(db);
}

/** Delete every cached answer, from the database and from memory; returns how many rows. */
export async function clearCachedAnswers(db: Db): Promise<number> {
  const removed = await clearCacheEntries(db);
  clearAllStoredCaches();
  return removed;
}
