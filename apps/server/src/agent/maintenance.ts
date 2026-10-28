/**
 * Housekeeping for agent runs and their worktrees.
 *
 * - `clearOrphanedIndicators` runs once at boot: a run still
 *   `pending`/`running` in the database belongs to a previous server
 *   process, so any `eyes` working indicator it left on a comment is
 *   cleared. `runs.ts`'s `resumeInterruptedRuns` then resumes each such run
 *   from its session, and marks one it can't resume `error`.
 * - `startWorktreeSweep` keeps pruning cached agent worktrees
 *   ("agent worktrees are a cache, not state") for as long as the server
 *   runs: once at start, then on a fixed interval. A worktree unused for
 *   `maxAgeSeconds` is removed from disk, from git's registry, and from
 *   `agent_worktree`; the next run that needs it just rebuilds it. A sweep
 *   is skipped while a run is going, so its worktree isn't pulled out from
 *   under it.
 * - `removeSupersededWorktrees` drops a branch's older worktrees as soon as
 *   one for a newer commit is made, instead of leaving them to age out.
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  clearAgentReactions,
  deleteWorktree,
  getRepoById,
  listStaleWorktrees,
  listUnfinishedRuns,
  listWorktrees,
  type AgentWorktree,
  type Db,
} from '../db/index.ts';
import { resolveDataPaths } from '../db/paths.ts';
import { gitCommonDir, scopedRemoveWorktree, worktreeDirName } from '../git/index.ts';

export async function clearOrphanedIndicators(db: Db): Promise<void> {
  await clearAgentReactions(db, 'eyes');
}

export type WorktreeSweepOptions = {
  /** Remove worktrees whose last use is older than this. Default: 1 hour. */
  readonly maxAgeSeconds?: number;
  /** How often to sweep. Default: 10 minutes. */
  readonly intervalMs?: number;
  readonly log?: (message: string) => void;
};

/** Starts sweeping now and on every interval; call the returned function to stop. */
export function startWorktreeSweep(db: Db, options: WorktreeSweepOptions = {}): () => void {
  const maxAgeSeconds = options.maxAgeSeconds ?? 60 * 60;
  const log = options.log ?? ((message: string) => console.log(`[worktrees] ${message}`));
  let sweeping = false;

  const sweep = async (): Promise<void> => {
    if (sweeping) return;
    sweeping = true;
    try {
      if ((await listUnfinishedRuns(db)).length > 0) return;
      for (const worktree of await listStaleWorktrees(db, maxAgeSeconds)) {
        try {
          await removeAgentWorktree(db, worktree);
          log(`removed ${worktree.path}`);
        } catch (err) {
          log(`could not remove ${worktree.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      sweeping = false;
    }
  };

  // An escaped rejection (e.g. the stale-worktree query failing) would take the server down.
  const run = (): void => {
    sweep().catch((err: unknown) => log(`sweep failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  run();
  const timer = setInterval(run, options.intervalMs ?? 10 * 60 * 1000);
  return () => clearInterval(timer);
}

/**
 * Remove `repoId`'s worktrees for other commits of the same branch (named
 * `<sha-short>-<branchSlug>` by `worktreeDirName`), keeping `keepSha`'s.
 * Left alone while a run is going, since it may be using one of them; the
 * sweep gets them later.
 */
export async function removeSupersededWorktrees(
  db: Db,
  repoId: string,
  keepSha: string,
  branchSlug: string,
): Promise<void> {
  if ((await listUnfinishedRuns(db)).length > 0) return;
  for (const worktree of await listWorktrees(db, repoId)) {
    if (worktree.sha === keepSha || basename(worktree.path) !== worktreeDirName(worktree.sha.slice(0, 12), branchSlug)) {
      continue;
    }
    try {
      await removeAgentWorktree(db, worktree);
      console.log(`[worktrees] removed superseded ${worktree.path}`);
    } catch (err) {
      console.log(`[worktrees] could not remove ${worktree.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Remove one cached worktree: from disk, from git's registry, and from `agent_worktree`. */
export async function removeAgentWorktree(db: Db, worktree: AgentWorktree): Promise<void> {
  const repo = await getRepoById(db, worktree.repoId);
  await removeOwnWorktree(worktree.path, repo?.rootPath ?? null);
  await deleteWorktree(db, worktree.repoId, worktree.sha);
}

/**
 * Remove a worktree of ours under the data dir, from disk and from git's
 * registry. `repoRoot` locates the registry when the directory is already
 * gone; null when the repo itself is gone too.
 */
export async function removeOwnWorktree(path: string, repoRoot: string | null): Promise<void> {
  const registry = await registryEntry(path, repoRoot);
  if (registry !== null) {
    await scopedRemoveWorktree({
      worktreePath: path,
      gitCommonDir: registry.gitCommonDir,
      worktreeName: registry.name,
      dataDir: resolveDataPaths().root,
    });
  }
}

/**
 * Where git registered this worktree: read from the worktree's own `.git`
 * file (`gitdir: <common>/worktrees/<name>`), which is exact even when git
 * had to suffix the name; if the directory is already gone, fall back to the
 * repo's common dir and the directory's basename (git's default name).
 * `null` when the repo itself is gone — then there's no registry to clean.
 */
async function registryEntry(path: string, repoRoot: string | null): Promise<{ gitCommonDir: string; name: string } | null> {
  try {
    const text = await readFile(join(path, '.git'), 'utf8');
    const raw = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
    // Relative under `worktree.useRelativePaths`; it is relative to the worktree, not our cwd.
    const gitDir = raw === undefined ? undefined : resolve(path, raw);
    if (gitDir !== undefined) return { gitCommonDir: dirname(dirname(gitDir)), name: basename(gitDir) };
  } catch {
    // Directory already gone — fall through.
  }
  if (repoRoot === null) return null;
  try {
    return { gitCommonDir: await gitCommonDir({ cwd: repoRoot }), name: basename(path) };
  } catch {
    return null;
  }
}
