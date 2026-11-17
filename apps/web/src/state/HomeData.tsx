/**
 * Homebase / Explore data: repos, reviews (+ their summaries), and open pulls
 * per repo — TanStack Query queries over the API, kept live by watching the
 * `home` and `repo:<id>` topics (`lib/liveQueries.ts`). The query cache
 * outlives any one screen, so navigating between Homebase and Explore reuses
 * the last answer instead of refetching.
 *
 * Everything shown here is what the server's engine stored; nothing is
 * derived on this side (a review's "done" bucket included).
 */
import {
  repoTopic,
  type AgentModel,
  type Branch,
  type Me,
  type Pull,
  type PullStack,
  type Repo,
  type ResponseOf,
  type Review,
  type ReviewSummary,
} from '@joinery/core';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { setGenerationModel } from '../lib/agentModel.ts';
import { ApiError, callApi } from '../lib/apiClient.ts';
import type { ForgeNotice } from '../lib/forgeNotice.ts';
import { queryClient, queryKeys, useWatchTopics } from '../lib/liveQueries.ts';
import { goReview } from '../lib/router.ts';

export type Bucket = 'attention' | 'done';

export interface HomeReview {
  review: Review;
  summary: ReviewSummary;
  repo: Repo;
  bucket: Bucket;
}

export interface HomeSnapshot {
  repos: Repo[];
  /** Only `open` and `orphaned` reviews; archived and draft excluded. */
  reviews: HomeReview[];
  /** `draft` reviews — started but not yet claimed. */
  drafts: HomeReview[];
  /** Repo id → open pulls (all, including already-reviewed ones; screens filter). */
  pullsByRepo: ReadonlyMap<string, Pull[]>;
  /** Repo id → whether the forge CLI was available for that repo's pull list. */
  pullsAvailable: ReadonlyMap<string, boolean>;
  /** Repo id → why its pull list is unavailable, when the server said. */
  pullsNotice: ReadonlyMap<string, ForgeNotice>;
  /** Repo id → its open stacked PRs (GitHub stacks); absent or empty where the forge has none. */
  stacksByRepo: ReadonlyMap<string, PullStack[]>;
  /** The "Custom" order of Currently reviewing: review ids, top first (shared with the CLI). */
  reviewOrder: readonly string[];
  me: Me | null;
  /** True while the first load is in flight (no data yet). */
  loading: boolean;
  /** True while a later refresh is in flight. */
  refreshing: boolean;
  /** Last load or action error message; cleared on the next success. */
  error: string | null;
  lastLoadedAt: number | null;
}

export type ListDirsResult = ResponseOf<'listDirs'>;
export interface AddReposResult {
  added: Repo[];
  failed: { path: string; message: string; hint?: string | undefined }[];
}

export interface HomeActions {
  refresh(options?: { force?: boolean }): Promise<void>;
  openPull(repoId: string, pull: Pull): Promise<void>;
  /** For a PR not in the open list (a search hit): the server resolves its head/base from the number. */
  openPullNumber(repoId: string, prNumber: number): Promise<void>;
  openBranch(repoId: string, branch: Branch | string): Promise<void>;
  archiveReview(id: string): Promise<void>;
  unarchiveReview(id: string): Promise<void>;
  generateReadingOrder(id: string, model: AgentModel): Promise<void>;
  /** Save the whole "Custom" order (review ids, top first). */
  setReviewOrder(reviewIds: readonly string[]): Promise<void>;
  addRepo(path: string): Promise<Repo>;
  addRepos(paths: string[]): Promise<AddReposResult>;
  listDirs(path?: string): Promise<ListDirsResult>;
}

type ReviewsResponse = ResponseOf<'listReviews'>;

interface RepoPulls {
  available: boolean;
  pulls: Pull[];
  stacks: PullStack[];
  notice: ForgeNotice | null;
}

function defaultSummary(reviewId: string): ReviewSummary {
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

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** Set once the first full snapshot is in; the query cache outlives every screen, and so does this. */
let everLoaded = false;

// --- action errors: the one bit of state that isn't a query ---

let actionError: string | null = null;
const errorListeners = new Set<() => void>();

function setActionError(next: string | null): void {
  if (next === actionError) return;
  actionError = next;
  for (const listener of errorListeners) listener();
}

function subscribeActionError(listener: () => void): () => void {
  errorListeners.add(listener);
  return () => {
    errorListeners.delete(listener);
  };
}

const getActionError = (): string | null => actionError;

// --- queries ---

async function loadPulls(repo: Repo, refresh: boolean): Promise<RepoPulls> {
  try {
    const res = await callApi('listPulls', { params: [repo.id], query: refresh ? { refresh: 'true' } : {} });
    const notice: ForgeNotice | null =
      res.unavailableReason === undefined
        ? null
        : { reason: res.unavailableReason, host: res.unavailableHost ?? null, forge: repo.forge };
    return { available: res.available, pulls: res.pulls, stacks: res.stacks, notice };
  } catch {
    return { available: false, pulls: [], stacks: [], notice: null };
  }
}

function invalidateHome(): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: queryKeys.home });
}

// --- actions ---

/**
 * Re-read everything Homebase shows. `force` also asks the server to re-poll
 * every repo now (git fetch + forge); what that finds arrives as `home` /
 * `repo:<id>` events a moment later.
 */
async function refresh(options?: { force?: boolean }): Promise<void> {
  if (options?.force === true) {
    try {
      await callApi('listReviews', { query: { refresh: 'true' } });
    } catch (err) {
      setActionError(errorMessage(err, 'Failed to refresh'));
    }
  }
  await invalidateHome();
}

async function createAndOpen(body: Parameters<typeof callApi<'createReview'>>[1], failure: string): Promise<void> {
  try {
    const detail = await callApi('createReview', body);
    setActionError(null);
    goReview(detail.review.id);
  } catch (err) {
    setActionError(errorMessage(err, failure));
    throw err;
  } finally {
    void invalidateHome();
  }
}

async function openPull(repoId: string, pull: Pull): Promise<void> {
  if (pull.reviewId !== null) {
    goReview(pull.reviewId);
    return;
  }
  // The server reads the PR's head and target branch itself; the number is all it needs.
  await createAndOpen(
    { body: { repoId, branch: pull.headRefName, prNumber: pull.number, status: 'draft' } },
    'Failed to open pull request',
  );
}

async function openPullNumber(repoId: string, prNumber: number): Promise<void> {
  await createAndOpen({ body: { repoId, prNumber, status: 'draft' } }, 'Failed to open pull request');
}

async function openBranch(repoId: string, branch: Branch | string): Promise<void> {
  const name = typeof branch === 'string' ? branch : branch.name;
  const reviewId = typeof branch === 'string' ? null : branch.reviewId;
  if (reviewId !== null) {
    goReview(reviewId);
    return;
  }
  await createAndOpen({ body: { repoId, branch: name, status: 'draft' } }, 'Failed to open branch');
}

/** Patch the cached reviews list in place (an optimistic update the next re-read reconciles). */
function patchReviews(update: (res: ReviewsResponse) => ReviewsResponse): void {
  queryClient.setQueryData<ReviewsResponse>(queryKeys.reviews, (res) => (res === undefined ? res : update(res)));
}

async function archiveReview(id: string): Promise<void> {
  // Optimistic: drop it at once; the re-read below reconciles either way
  // (including undoing this if the request failed).
  patchReviews((res) => ({ ...res, reviews: res.reviews.filter((r) => r.id !== id) }));
  try {
    await callApi('setReviewStatus', { params: [id], body: { status: 'archived' } });
  } catch (err) {
    setActionError(errorMessage(err, 'Failed to archive review'));
  }
  await invalidateHome();
}

async function unarchiveReview(id: string): Promise<void> {
  try {
    await callApi('setReviewStatus', { params: [id], body: { status: 'open' } });
  } catch (err) {
    setActionError(errorMessage(err, 'Failed to unarchive review'));
  }
  await invalidateHome();
}

async function generateReadingOrder(id: string, model: AgentModel): Promise<void> {
  // Remembered so the review page's pane and palette offer it next time too.
  setGenerationModel(model);
  patchReviews((res) => ({
    ...res,
    summaries: res.summaries.map((s) => (s.reviewId === id ? { ...s, agentRunning: true } : s)),
  }));
  try {
    await callApi('generateReadingOrder', { params: [id], body: { model } });
  } catch (err) {
    setActionError(errorMessage(err, 'Failed to generate reading order'));
  }
  await invalidateHome();
}

async function setReviewOrder(reviewIds: readonly string[]): Promise<void> {
  // Optimistic, so a drop lands at once; the server's answer (archived ids
  // dropped) replaces it.
  queryClient.setQueryData<ResponseOf<'getReviewOrder'>>(queryKeys.reviewOrder, { reviewIds: [...reviewIds] });
  try {
    const res = await callApi('setReviewOrder', { body: { reviewIds: [...reviewIds], mode: 'replace' } });
    queryClient.setQueryData(queryKeys.reviewOrder, res);
  } catch (err) {
    setActionError(errorMessage(err, 'Failed to save the order'));
    await queryClient.invalidateQueries({ queryKey: queryKeys.reviewOrder });
  }
}

async function addRepo(path: string): Promise<Repo> {
  try {
    const res = await callApi('addRepo', { body: { path } });
    await invalidateHome();
    return res.repo;
  } catch (err) {
    setActionError(errorMessage(err, 'Failed to add repository'));
    throw err;
  }
}

async function addRepos(paths: string[]): Promise<AddReposResult> {
  const result: AddReposResult = { added: [], failed: [] };
  for (const path of paths) {
    try {
      result.added.push((await callApi('addRepo', { body: { path } })).repo);
    } catch (err) {
      result.failed.push({
        path,
        message: errorMessage(err, 'Failed to add repository'),
        hint: err instanceof ApiError ? err.hint : undefined,
      });
    }
  }
  await invalidateHome();
  return result;
}

function listDirs(path?: string): Promise<ListDirsResult> {
  return callApi('listDirs', { query: path === undefined ? {} : { path } });
}

const actions: HomeActions = {
  refresh,
  openPull,
  openPullNumber,
  openBranch,
  archiveReview,
  unarchiveReview,
  generateReadingOrder,
  setReviewOrder,
  addRepo,
  addRepos,
  listDirs,
};

export function useHomeData(): HomeSnapshot & HomeActions {
  const reposQuery = useQuery({ queryKey: queryKeys.repos, queryFn: () => callApi('listRepos') });
  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: () => callApi('me') });
  const reviewsQuery = useQuery({ queryKey: queryKeys.reviews, queryFn: () => callApi('listReviews') });
  const reviewOrderQuery = useQuery({ queryKey: queryKeys.reviewOrder, queryFn: () => callApi('getReviewOrder') });
  const reviewOrder = useMemo(() => reviewOrderQuery.data?.reviewIds ?? [], [reviewOrderQuery.data]);
  const repos = useMemo(() => reposQuery.data?.repos ?? [], [reposQuery.data]);
  const combinePulls = useCallback(
    (results: ReadonlyArray<{ data: RepoPulls | undefined; isFetching: boolean; isPending: boolean }>) => {
      const pullsByRepo = new Map<string, Pull[]>();
      const pullsAvailable = new Map<string, boolean>();
      const pullsNotice = new Map<string, ForgeNotice>();
      const stacksByRepo = new Map<string, PullStack[]>();
      repos.forEach((repo, i) => {
        const data = results[i]?.data;
        if (data === undefined) return;
        pullsByRepo.set(repo.id, data.pulls);
        if (data.stacks.length > 0) stacksByRepo.set(repo.id, data.stacks);
        pullsAvailable.set(repo.id, data.available);
        if (data.notice !== null) pullsNotice.set(repo.id, data.notice);
      });
      return {
        pullsByRepo,
        pullsAvailable,
        pullsNotice,
        stacksByRepo,
        fetching: results.some((r) => r.isFetching),
        pending: results.some((r) => r.isPending),
      };
    },
    [repos],
  );
  const { fetching: pullsFetching, pending: pullsPending, ...pulls } = useQueries({
    queries: repos.map((repo) => ({ queryKey: queryKeys.pulls(repo.id), queryFn: () => loadPulls(repo, false) })),
    combine: combinePulls,
  });
  const error = useSyncExternalStore(subscribeActionError, getActionError, getActionError);

  useWatchTopics(['home', ...repos.map((r) => repoTopic(r.id))]);

  const lists = useMemo(() => {
    const reviews: HomeReview[] = [];
    const drafts: HomeReview[] = [];
    const res = reviewsQuery.data;
    if (res === undefined) return { reviews, drafts };
    const repoById = new Map(repos.map((r) => [r.id, r] as const));
    const summaryByReviewId = new Map(res.summaries.map((s) => [s.reviewId, s] as const));
    for (const review of res.reviews) {
      if (review.status === 'archived') continue;
      const repo = repoById.get(review.repoId);
      if (repo === undefined) continue;
      const summary = summaryByReviewId.get(review.id) ?? defaultSummary(review.id);
      const hr: HomeReview = { review, summary, repo, bucket: summary.done ? 'done' : 'attention' };
      if (review.status === 'draft') drafts.push(hr);
      else reviews.push(hr);
    }
    return { reviews, drafts };
  }, [reviewsQuery.data, repos]);

  // The first load shows everything at once, as one snapshot: Homebase only
  // counts as loaded once repos, reviews, `me` and every repo's pulls are in,
  // so it never renders (or starts onboarding) from a half-loaded state.
  // After that, a repo added later loads its pulls without blanking the screen.
  const complete = !reposQuery.isPending && !reviewsQuery.isPending && !meQuery.isPending && !pullsPending;
  if (complete) everLoaded = true;
  const loading = !everLoaded && !complete;
  const fetching = reposQuery.isFetching || reviewsQuery.isFetching || pullsFetching;
  const queryError = reposQuery.error ?? reviewsQuery.error;

  return {
    repos,
    ...lists,
    ...pulls,
    me: meQuery.data ?? null,
    reviewOrder,
    loading,
    refreshing: !loading && fetching,
    error: error ?? (queryError === null ? null : errorMessage(queryError, 'Failed to load')),
    lastLoadedAt: everLoaded ? reviewsQuery.dataUpdatedAt : null,
    ...actions,
  };
}
