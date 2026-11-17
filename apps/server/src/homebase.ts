/**
 * Composes `ReviewSummary` for `GET /api/reviews` and the pull lists for
 * Homebase/Explore — reads only. The DB aggregate (`summarizeReviews`) plus
 * what the engine stored: each review's `review_state` (diff size, head
 * commit, its PR) and each repo's `repo_state` (open pulls). Nothing here
 * runs git or asks the forge; the repo pollers keep that state current and
 * announce changes on the `home` topic.
 */
import type { CiStatus, PullDetail, PullStack, Repo, Review, ReviewSummary } from '@joinery/core';
import {
  findReviewByBranch,
  getRepoState,
  listRepos,
  listReviewStates,
  listViewedForReviews,
  summarizeReviews,
  type Db,
  type StoredReviewState,
} from './db/index.ts';
import { getMe, type Me } from './git/me.ts';
import { forgeFor, type ListOpenPullsResult } from './git/forge/index.ts';
import { createStoredCache, type StoredCacheDeps } from './storedCache.ts';

export type HomebaseDeps = StoredCacheDeps;

/** `getMe` resolves once per process; this only spares a restart the wait on the forge login lookup. */
const meCache = createStoredCache<Me>({
  namespace: 'me',
  version: 1,
  staleAfterMs: 60_000,
  // A half-resolved `Me` (offline `gh`) never replaces a fully resolved one.
  keepPrevious: (next, previous) =>
    (next.login === null && previous.login !== null) || (next.name === null && previous.name !== null),
});

/**
 * `me` for `GET /api/me`. Repos can sit on different forges, so the login comes
 * from the first distinct `kind@host` (in registration order) that resolves
 * one; the git name comes from the first repo's clone (or the server's cwd).
 */
export async function getMeCached(deps: HomebaseDeps): Promise<Me> {
  const repos = await listRepos(deps.db);
  const first = repos[0];
  const cwd = first?.rootPath ?? null;
  return meCache.get(deps, 'me', async () => {
    let me = await getMe(cwd, forgeFor(first), first?.remoteHost ?? null);
    const seen = new Set([`${forgeFor(first).kind}@${first?.remoteHost ?? ''}`]);
    for (const repo of repos) {
      if (me.login !== null) break;
      const forge = forgeFor(repo);
      const key = `${forge.kind}@${repo.remoteHost ?? ''}`;
      if (forge.kind === 'none' || seen.has(key)) continue;
      seen.add(key);
      me = await getMe(repo.rootPath, forge, repo.remoteHost);
    }
    return me;
  });
}

/**
 * The repo's open pulls as the poller last stored them. Before its first
 * poll lands this is an empty, available list; the poller's `repo:<id>`
 * event then makes the screen re-read.
 */
export async function getStoredPulls(db: Db, repo: Repo): Promise<ListOpenPullsResult> {
  const stored = await getRepoState(db, repo.id);
  if (stored === null) return { available: true, pulls: [] };
  try {
    return JSON.parse(stored.pulls) as ListOpenPullsResult;
  } catch {
    return { available: true, pulls: [] };
  }
}

/** CI ran on the forge's head; it only describes the review while that's still the review's head. */
function ciOf(state: StoredReviewState): CiStatus | null {
  const pull = state.pull;
  if (pull === null) return null;
  if (state.pullHeadSha !== null && state.pullHeadSha !== state.headSha) return null;
  return pull.ci;
}

/** Build the full `ReviewSummary[]` for `reviews`: the DB aggregate plus each review's stored engine state. */
export async function buildReviewSummaries(db: Db, reviews: readonly Review[]): Promise<ReviewSummary[]> {
  if (reviews.length === 0) return [];
  const ids = reviews.map((r) => r.id);
  const [baseSummaries, states, viewedByReview] = await Promise.all([
    summarizeReviews(db, ids),
    listReviewStates(db, ids),
    listViewedForReviews(db, ids),
  ]);
  const baseById = new Map(baseSummaries.map((s) => [s.reviewId, s]));

  return reviews.map((review) => {
    const base = baseById.get(review.id) ?? emptySummary(review.id);
    const state = states.get(review.id);
    if (state === undefined) return { ...base, title: review.branch };

    // A viewed mark counts only while it's for the file's current blob.
    const viewedFiles = (viewedByReview.get(review.id) ?? []).filter(
      (v) => state.blobByPath[v.path] === v.blobSha,
    ).length;
    const pull = state.pull;
    return {
      ...base,
      title: pull?.title ?? review.branch ?? state.subject,
      // The git name first, so a PR and a local branch by the same person get the same avatar.
      authorName: state.authorName ?? pull?.authorLogin ?? null,
      filesTotal: state.filesTotal,
      additions: state.additions,
      deletions: state.deletions,
      headSha: state.headSha,
      headCommittedAt: state.committedAt,
      ci: ciOf(state),
      draft: pull?.state === 'draft',
      viewedFiles,
      // A merged or closed PR is over: cleared whatever is left unviewed or open on it.
      done:
        pull?.state === 'merged' ||
        pull?.state === 'closed' ||
        (state.filesTotal > 0 && viewedFiles >= state.filesTotal && base.openThreads === 0),
    };
  });
}

function emptySummary(reviewId: string): ReviewSummary {
  return {
    reviewId,
    openThreads: 0,
    resolvedThreads: 0,
    viewedFiles: 0,
    hasReadingOrder: false,
    agentRunning: false,
    lastActivityAt: null,
    title: null,
    authorName: null,
    filesTotal: null,
    additions: null,
    deletions: null,
    headSha: null,
    headCommittedAt: null,
    ci: null,
    draft: false,
    unreadAgentReplies: 0,
    done: false,
  };
}

/**
 * A `PullDetail` from the repo's stored open-pull list, for a review whose
 * own detail the poller hasn't read yet. It has no description or url (only
 * `gh pr view` reports those); null when the list doesn't have the PR.
 */
export async function openPullDetail(db: Db, repo: Repo, prNumber: number): Promise<PullDetail | null> {
  const open = (await getStoredPulls(db, repo)).pulls.find((p) => p.number === prNumber);
  if (open === undefined) return null;
  return {
    number: open.number,
    title: open.title,
    body: '',
    state: open.isDraft ? 'draft' : 'open',
    authorLogin: open.authorLogin,
    baseRefName: open.baseRefName,
    ci: open.ci,
    additions: open.additions,
    deletions: open.deletions,
    changedFiles: open.changedFiles,
    url: null,
  };
}

/**
 * The repo's stacks as `PullStack`s: the stored members, with each one's
 * title from the open-pull list and its review (if any) from the DB.
 */
export async function readStacks(db: Db, repo: Repo, stored: ListOpenPullsResult): Promise<PullStack[]> {
  const titles = new Map(stored.pulls.map((p) => [p.number, p.title] as const));
  return Promise.all(
    (stored.stacks ?? []).map(async (stack) => ({
      ...stack,
      pulls: await Promise.all(
        stack.pulls.map(async (member) => ({
          ...member,
          title: titles.get(member.number) ?? null,
          reviewId: (await findReviewByBranch(db, repo.id, member.headRefName))?.id ?? null,
        })),
      ),
    })),
  );
}
