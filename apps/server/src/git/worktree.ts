/**
 * `git worktree list --porcelain` parsing and the worktree registry rules.
 * Agent worktrees are a cache, not state.
 *
 * **The engine never prunes, moves, repairs, or removes a worktree it did
 * not create.** `git worktree prune` is global — there is no
 * `git worktree prune <path>` — so a single call could take out a user
 * worktree we know nothing about, along with any uncommitted work in it.
 * That rule is enforced structurally here: this module has no function that
 * calls `prune`, `repair`, or `remove` on anything but a path we ourselves
 * created under the data directory.
 *
 * Worktrees we create are always `git worktree add --detach`, so they never
 * hold a branch and can never collide with a checkout ("already checked out
 * at ..."), and cleanup of our own is scoped filesystem deletion — never a
 * git subcommand that could touch a worktree we did not create.
 */
import { rm } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import { canonicalizePath } from './paths.ts';
import { git, gitOrThrow, type GitCallOptions } from './run.ts';

export type WorktreeEntry = {
  /** Realpath of the worktree's working directory. */
  path: string;
  headSha: string | null;
  /** Fully-qualified ref, e.g. "refs/heads/feat/x". Null when detached. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
};

/**
 * Parse `git worktree list --porcelain` output. Pure function over the raw
 * text so it is unit-testable without a repo.
 *
 * Records are separated by a blank line; within a record, lines are
 * `key[ value]`. See `git-worktree(1)`.
 */
export function parseWorktreeListPorcelain(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  // Normalize trailing newline, then split into records on blank lines.
  const blocks = text.replace(/\n+$/u, '').split(/\n\n+/u);

  for (const block of blocks) {
    if (block.trim() === '') continue;
    const lines = block.split('\n');

    let path: string | null = null;
    let headSha: string | null = null;
    let branch: string | null = null;
    let detached = false;
    let bare = false;
    let locked = false;
    let lockReason: string | null = null;
    let prunable = false;
    let prunableReason: string | null = null;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        headSha = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length);
      } else if (line === 'detached') {
        detached = true;
      } else if (line === 'bare') {
        bare = true;
      } else if (line === 'locked') {
        locked = true;
      } else if (line.startsWith('locked ')) {
        locked = true;
        lockReason = line.slice('locked '.length);
      } else if (line === 'prunable') {
        prunable = true;
      } else if (line.startsWith('prunable ')) {
        prunable = true;
        prunableReason = line.slice('prunable '.length);
      }
      // Unknown fields are ignored rather than rejected.
    }

    if (path === null) continue;
    entries.push({
      path,
      headSha,
      branch,
      detached,
      bare,
      locked,
      lockReason,
      prunable,
      prunableReason,
    });
  }

  return entries;
}

/**
 * `git worktree list --porcelain`, run from any worktree of the repo —
 * location never matters, the registry is central.
 */
export async function listWorktrees(options: GitCallOptions): Promise<WorktreeEntry[]> {
  const result = await gitOrThrow(['worktree', 'list', '--porcelain'], options);
  const text = new TextDecoder().decode(result.stdout);
  // Git for Windows reports `C:/...`; everything here compares native paths.
  return parseWorktreeListPorcelain(text).map((entry) => ({ ...entry, path: normalize(entry.path) }));
}

/**
 * Find which worktree, if any, currently holds `branch` (a short name like
 * `feat/x`, matched against the `refs/heads/<branch>` ref reported by
 * `worktree list`). Paths are canonicalized before comparison and returned as
 * realpaths.
 */
export async function findWorktreeForBranch(
  branch: string,
  options: GitCallOptions,
): Promise<WorktreeEntry | null> {
  const wanted = `refs/heads/${branch}`;
  const entries = await listWorktrees(options);
  for (const entry of entries) {
    if (entry.branch === wanted) {
      const canonicalPath = await canonicalizePath(entry.path);
      return { ...entry, path: canonicalPath };
    }
  }
  return null;
}

export type CreateDetachedWorktreeParams = {
  /** The repo to create the worktree in (any worktree root works). */
  repoCwd: string;
  /** The commit to detach at. */
  sha: string;
  /** Absolute path to create the worktree at; must resolve under `dataDir`. */
  path: string;
  /** The data directory that writes are scoped under. */
  dataDir: string;
};

/**
 * Create a detached worktree at `sha` under the data directory. Always
 * `--detach`, so it never holds a branch and can never collide with a
 * checkout elsewhere. `--force` because a directory of ours that was deleted
 * by hand leaves its registry entry behind, and git otherwise refuses the
 * path forever ("missing but already registered worktree"); it still
 * refuses a path that exists on disk.
 */
export async function createDetachedWorktree(params: CreateDetachedWorktreeParams): Promise<WorktreeEntry> {
  await gitOrThrow(['worktree', 'add', '--detach', '--force', params.path, params.sha], {
    cwd: params.repoCwd,
    dataDir: params.dataDir,
  });
  const canonicalPath = await canonicalizePath(params.path);
  return {
    path: canonicalPath,
    headSha: params.sha,
    branch: null,
    detached: true,
    bare: false,
    locked: false,
    lockReason: null,
    prunable: false,
    prunableReason: null,
  };
}

/**
 * Move a detached worktree of ours (under `dataDir`) to `sha`. `--force`
 * because nothing in it is anyone's work: it is only ever read.
 */
export async function checkoutDetached(params: { worktreePath: string; sha: string; dataDir: string }): Promise<void> {
  await gitOrThrow(['checkout', '--detach', '--force', params.sha], { cwd: params.worktreePath, dataDir: params.dataDir });
}

export type ScopedRemoveParams = {
  /** The worktree directory we created, under `dataDir`. */
  worktreePath: string;
  /** `$GIT_COMMON_DIR` of the repo this worktree belongs to. */
  gitCommonDir: string;
  /** The registry entry name under `$GIT_COMMON_DIR/worktrees/`. */
  worktreeName: string;
  dataDir: string;
};

/**
 * Remove a worktree *we created*. This is deliberately not `git worktree
 * remove` or `git worktree prune`. The recipe is
 * (`rm -rf` the directory, then delete exactly the one registry entry)
 * because it must work even when the directory is already gone, and because
 * `prune` is global and could destroy a co-resident worktree we don't own.
 *
 * Refuses (throws) unless `worktreePath` resolves under `dataDir`, so this
 * function itself cannot be used to remove anything but our own cache.
 */
export async function scopedRemoveWorktree(params: ScopedRemoveParams): Promise<void> {
  const normalizedDataDir = `${resolve(params.dataDir)}${sep}`;
  const normalizedWorktreePath = `${resolve(params.worktreePath)}${sep}`;
  if (!normalizedWorktreePath.startsWith(normalizedDataDir)) {
    throw new Error(
      `refusing to remove worktree outside data dir: ${params.worktreePath} (data dir: ${params.dataDir})`,
    );
  }

  await rm(params.worktreePath, { recursive: true, force: true });
  await rm(join(params.gitCommonDir, 'worktrees', params.worktreeName), {
    recursive: true,
    force: true,
  });
}

/** Identity of an agent-run worktree: `(repo, sha)`, deduped by us. */
export function worktreeDirName(shaShort: string, branchSlug: string | null): string {
  return branchSlug === null || branchSlug === '' ? shaShort : `${shaShort}-${branchSlug}`;
}

/** Slugify a branch name for use in a worktree directory name (legibility only, not identity). */
export function slugifyBranch(branch: string): string {
  return branch
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60);
}

// Re-export so callers scoping writes don't need to import `run.ts` separately.
export type { GitCallOptions };
export { git };
