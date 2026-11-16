/**
 * Repo facts: default branch, remote owner/name, `$GIT_COMMON_DIR`,
 * merge-base computation, PR divergence, in-progress-operation detection,
 * and `refs/review/<id>` pinning.
 */
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { git, gitOrThrow, type GitCallOptions } from './run.ts';
import type { GitOperation } from '@joinery/core';

/** `git rev-parse --git-common-dir`, resolved to an absolute path. */
export async function gitCommonDir(options: GitCallOptions): Promise<string> {
  const result = await gitOrThrow(['rev-parse', '--git-common-dir'], options);
  const raw = new TextDecoder().decode(result.stdout).trim();
  if (raw.startsWith('/')) return raw;
  // rev-parse can return a path relative to cwd.
  return resolve(options.cwd, raw);
}

/** `git rev-parse --show-toplevel`. */
export async function showToplevel(options: GitCallOptions): Promise<string> {
  const result = await gitOrThrow(['rev-parse', '--show-toplevel'], options);
  return new TextDecoder().decode(result.stdout).trim();
}

/**
 * The default branch's short name (e.g. "main"), read from the remote
 * HEAD symref. Falls back to `null` if it cannot be determined (no remote,
 * or the symref was never set locally by a clone/fetch).
 */
export async function defaultBranch(options: GitCallOptions): Promise<string | null> {
  const result = await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], options);
  if (result.exitCode !== 0) return null;
  const ref = new TextDecoder().decode(result.stdout).trim();
  const prefix = 'refs/remotes/origin/';
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}

export type RemoteIdentity = {
  owner: string | null;
  name: string | null;
};

/**
 * Parse `owner/name` out of an origin URL; a GitLab nested group keeps its whole path as `owner` (`a/b/c` is owner `a/b`). Handles the common SSH and HTTPS
 * GitHub shapes; returns nulls for anything else rather than guessing.
 */
export function parseRemoteIdentity(url: string): RemoteIdentity {
  const trimmed = url.trim().replace(/\.git$/u, '');

  // ssh://git@host/owner/name, with an optional port (self-hosted Gitea often uses one)
  const sshUrlMatch = /^ssh:\/\/git@[^:/]+(?::\d+)?\/(.+)\/([^/]+)$/u.exec(trimmed);
  if (sshUrlMatch !== null) {
    return { owner: sshUrlMatch[1] ?? null, name: sshUrlMatch[2] ?? null };
  }

  // git@github.com:owner/name  or  ssh://git@github.com/owner/name
  const sshMatch = /^(?:ssh:\/\/)?git@[^:/]+[:/](.+)\/([^/]+)$/u.exec(trimmed);
  if (sshMatch !== null) {
    return { owner: sshMatch[1] ?? null, name: sshMatch[2] ?? null };
  }

  // https://github.com/owner/name, with an optional port
  const httpsMatch = /^https?:\/\/[^/]+\/(.+)\/([^/]+)$/u.exec(trimmed);
  if (httpsMatch !== null) {
    return { owner: httpsMatch[1] ?? null, name: httpsMatch[2] ?? null };
  }

  return { owner: null, name: null };
}

/** `git config --get remote.origin.url`, parsed into owner/name. Null fields if there's no origin. */
export async function remoteIdentity(options: GitCallOptions): Promise<RemoteIdentity> {
  const result = await git(['config', '--get', 'remote.origin.url'], options);
  if (result.exitCode !== 0) return { owner: null, name: null };
  const url = new TextDecoder().decode(result.stdout).trim();
  if (url === '') return { owner: null, name: null };
  return parseRemoteIdentity(url);
}

/** Lowercased hostname of an origin URL (SSH or HTTPS); null for anything else. Picks the forge (`git/forge`). */
export function parseRemoteHost(url: string): string | null {
  const match = /^(?:ssh:\/\/git@|git@|https?:\/\/)([^:/]+)[:/]/u.exec(url.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

/** `git config --get remote.origin.url`, parsed into its host. Null if there's no origin. */
export async function remoteHost(options: GitCallOptions): Promise<string | null> {
  const result = await git(['config', '--get', 'remote.origin.url'], options);
  return result.exitCode === 0 ? parseRemoteHost(new TextDecoder().decode(result.stdout)) : null;
}

/** `git merge-base <a> <b>`. Null if the revisions share no history. */
export async function mergeBase(a: string, b: string, options: GitCallOptions): Promise<string | null> {
  const result = await git(['merge-base', a, b], options);
  if (result.exitCode !== 0) return null;
  const sha = new TextDecoder().decode(result.stdout).trim();
  return sha === '' ? null : sha;
}

/**
 * A review's base commit: `merge-base` against `origin/<baseRef>` first, so
 * a stale local `main` doesn't pull already-merged upstream commits into the
 * diff (the remote poll keeps `origin/<baseRef>` current; the local branch
 * nobody fetches into). Falls back to `baseRef` as given — a local-only
 * branch, a tag, a sha — when there's no remote-tracking ref.
 */
export async function baseMergeBase(baseRef: string, head: string, options: GitCallOptions): Promise<string | null> {
  return (await mergeBase(`refs/remotes/origin/${baseRef}`, head, options)) ?? (await mergeBase(baseRef, head, options));
}

/** `git rev-parse <rev>`, resolved to a full SHA. Null if it doesn't resolve. */
export async function revParse(rev: string, options: GitCallOptions): Promise<string | null> {
  const result = await git(['rev-parse', '--verify', rev], options);
  if (result.exitCode !== 0) return null;
  const sha = new TextDecoder().decode(result.stdout).trim();
  return sha === '' ? null : sha;
}

export type Divergence = {
  ahead: number;
  behind: number;
};

/**
 * `git rev-list --left-right --count <head>...<pr>`. Output is "<ahead>\t<behind>".
 */
export async function divergence(head: string, pr: string, options: GitCallOptions): Promise<Divergence> {
  const result = await gitOrThrow(
    ['rev-list', '--left-right', '--count', `${head}...${pr}`],
    options,
  );
  const text = new TextDecoder().decode(result.stdout).trim();
  const [aheadText, behindText] = text.split(/\s+/u);
  const ahead = Number(aheadText ?? '0');
  const behind = Number(behindText ?? '0');
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}

const OPERATION_MARKERS: { file: string; op: GitOperation }[] = [
  { file: 'rebase-merge', op: 'rebase' },
  { file: 'rebase-apply', op: 'rebase' },
  { file: 'MERGE_HEAD', op: 'merge' },
  { file: 'CHERRY_PICK_HEAD', op: 'cherry-pick' },
  { file: 'BISECT_LOG', op: 'bisect' },
  { file: 'REVERT_HEAD', op: 'revert' },
];

/**
 * Detect an in-progress operation by checking for the marker files under
 * `$GIT_DIR`. Returns the first one found;
 * order matches `OPERATION_MARKERS`, which lists rebase markers first since
 * a rebase can leave `MERGE_HEAD`-like state behind transiently too.
 *
 * `gitDir` is the *per-worktree* git dir (`$GIT_COMMON_DIR` for the main
 * worktree, or `$GIT_COMMON_DIR/worktrees/<name>` for a linked one) — these
 * markers are worktree-private, unlike `refs/`.
 */
export async function detectInProgressOperation(gitDir: string): Promise<GitOperation | null> {
  for (const marker of OPERATION_MARKERS) {
    try {
      await access(join(gitDir, marker.file));
      return marker.op;
    } catch {
      // not present, keep looking
    }
  }
  return null;
}

/**
 * Pin `sha` at `refs/review/<reviewId>` so the commit survives GC even
 * without a directory on disk. This is the one ref-writing
 * operation in the write allowlist.
 */
export async function pinReviewRef(reviewId: string, sha: string, options: GitCallOptions): Promise<void> {
  await gitOrThrow(['update-ref', `refs/review/${reviewId}`, sha], options);
}

/**
 * Pin the last non-empty diff base under `refs/review/base/<id>`. Once the
 * branch is merged, merge-base(baseRef, head) collapses to head itself; this
 * is what still says where the reviewed changes started.
 */
export async function pinReviewBaseRef(reviewId: string, sha: string, options: GitCallOptions): Promise<void> {
  await gitOrThrow(['update-ref', `refs/review/base/${reviewId}`, sha], options);
}

/**
 * Delete every ref Joinery keeps for a review — the head pin, the base pin
 * and the fetched PR ref — when the review itself is deleted. Best-effort:
 * a ref that was never written, or a repo that's gone, is not an error.
 */
export async function unpinReviewRefs(reviewId: string, options: GitCallOptions): Promise<void> {
  for (const ref of [`refs/review/${reviewId}`, `refs/review/base/${reviewId}`, `refs/review/pr/${reviewId}`]) {
    await git(['update-ref', '-d', ref], options).catch(() => undefined);
  }
}
