/**
 * Resolves the directory an embedded agent run reads from.
 *
 * When the review's branch is checked out on disk (`state.root.attachedPath`
 * set), that directory *is* the cwd — the agent sees exactly what the user
 * sees. Otherwise the review has no working copy at all right now, so the
 * agent gets a detached worktree at the review's `head` sha, cached by
 * `(repoId, headSha)` in `agent_worktree` (`db/worktrees.ts`) and reused
 * across runs rather than re-cloned every time. This is a cache, not review
 * state: it is pruned by the maintenance sweep after an hour unused, and a
 * branch's worktree for an older commit goes as soon as a newer one is made
 * (`agent/maintenance.ts`); losing one just costs a rebuild.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileEntry, Review } from '@joinery/core';
import {
  createWorktree,
  deleteWorktree,
  getRepoById,
  getWorktree,
  touchWorktree,
  type Db,
} from '../db/index.ts';
import { resolveDataPaths } from '../db/paths.ts';
import { createDetachedWorktree, slugifyBranch, worktreeDirName } from '../git/index.ts';
import { removeSupersededWorktrees } from './maintenance.ts';

export type WorktreeDeps = {
  readonly db: Db;
};

/** What `resolveRunCwd` needs from the review's engine. */
export type EngineForCwd = {
  getState(): Promise<{ root: { attachedPath: string | null } }>;
  getFileList(revision?: 'head'): { headSha: string; files: FileEntry[] };
};

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The attached root when the review's branch is checked out; otherwise a
 * detached worktree at the review's `head` sha, created and cached under
 * `data/worktrees/<repo>/<sha-short>-<branch-slug>`.
 */
export async function resolveRunCwd(deps: WorktreeDeps, review: Review, engine: EngineForCwd): Promise<string> {
  const state = await engine.getState();
  if (state.root.attachedPath !== null) return state.root.attachedPath;

  const repo = await getRepoById(deps.db, review.repoId);
  if (repo === null) throw new Error(`repo ${review.repoId} not found for review ${review.id}`);

  const headSha = engine.getFileList('head').headSha;

  const existing = await getWorktree(deps.db, repo.id, headSha);
  if (existing !== null && (await directoryExists(existing.path))) {
    await touchWorktree(deps.db, repo.id, headSha);
    return existing.path;
  }

  const dataPaths = resolveDataPaths();
  const shaShort = headSha.slice(0, 12);
  const branchSlug = review.branch !== null ? slugifyBranch(review.branch) : null;
  const path = join(dataPaths.worktreesDir, repo.id, worktreeDirName(shaShort, branchSlug));

  const created = await createDetachedWorktree({
    repoCwd: repo.rootPath,
    sha: headSha,
    path,
    dataDir: dataPaths.root,
  });

  // A row existed but its directory was gone (e.g. manually cleaned up) —
  // replace it rather than fail the (repoId, sha) primary key on insert.
  if (existing !== null) {
    await deleteWorktree(deps.db, repo.id, headSha);
  }
  await createWorktree(deps.db, repo.id, headSha, created.path);
  if (branchSlug !== null && branchSlug !== '') await removeSupersededWorktrees(deps.db, repo.id, headSha, branchSlug);
  return created.path;
}
