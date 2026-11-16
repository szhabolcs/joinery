/**
 * One poll loop per registered repo — the engine's background job, run the
 * way lazygit runs its auto-fetch: on a timer, quicker while someone is
 * watching the repo, and never while a git operation is in progress there.
 *
 * Each round:
 *   1. one `git fetch origin` for the whole repo, plus the PR head of every
 *      review with a PR (into `refs/review/pr/<id>`);
 *   2. one forge call for the repo's open pulls, stored in `repo_state`;
 *   3. per review: match its PR, keep its base on the PR's current target
 *      branch, ask the forge once for a merged PR's pre-merge base, and hand
 *      the rest to `refreshReviewState`, the one writer of `review_state`.
 *
 * Every git and forge call goes through a p-queue, so a dozen repos polling
 * at once never run more than a few processes, and the forge never sees a
 * burst.
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import PQueue from 'p-queue';
import { pullDetailSchema, repoTopic, reviewTopic, type PullDetail, type Repo, type Review } from '@joinery/core';
import {
  getRepoById,
  getRepoState,
  getReviewState,
  listRepos,
  listReviews,
  putRepoState,
  setBaseRef,
  setDefaultBranch,
  setPrNumber,
  type Db,
} from '../db/index.ts';
import {
  baseMergeBase,
  bytesToText,
  forgeFor,
  getMe,
  git,
  gitCommonDir,
  pinReviewBaseRef,
  revParse,
  type Forge,
  type ListOpenPullsResult,
} from '../git/index.ts';
import type { EventBus } from './bus.ts';
import { pullFactsOf, refreshReviewState, type PullFacts } from './reviewState.ts';

/** A repo someone is looking at (Homebase, Explore, or one of its reviews). */
const WATCHED_INTERVAL_MS = 15_000;
const IDLE_INTERVAL_MS = 180_000;
/** A fetch that hangs (dead network, an SSH prompt nobody can answer) is killed rather than left holding the loop. */
const FETCH_TIMEOUT_MS = 60_000;

/** `git fetch` and `ls-remote`: network-bound, a few at a time across every repo. */
const network = new PQueue({ concurrency: 3 });
/** `gh`/`glab`/`gt`: a few at a time, and no more than 10 a second across every repo. */
const forgeCalls = new PQueue({ concurrency: 3, interval: 1_000, intervalCap: 10 });
/** Local git work per review (rev-parse, merge-base, diff): bounded so a big repo can't starve the rest. */
const local = new PQueue({ concurrency: 4 });

export type RepoPollerDeps = {
  readonly db: Db;
  readonly bus: EventBus;
  /** A review's stored state or row changed (after commit): its live worker re-reads it. */
  readonly onReviewChanged: (reviewId: string) => void;
};

class RepoPoller {
  readonly #deps: RepoPollerDeps;
  readonly #repoId: string;
  #stopped = false;
  #wake: (() => void) | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Review ids from the last round, to tell whether any of them is being watched. */
  #reviewIds: string[] = [];
  #defaultBranchChecked = false;
  /** Merged PRs whose pre-merge base was already asked of the forge this process. */
  readonly #mergedAsked = new Set<string>();

  constructor(deps: RepoPollerDeps, repoId: string) {
    this.#deps = deps;
    this.#repoId = repoId;
  }

  start(): void {
    void this.#loop();
  }

  stop(): void {
    this.#stopped = true;
    this.kick();
  }

  /** Poll now instead of at the next interval. */
  kick(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  async #loop(): Promise<void> {
    while (!this.#stopped) {
      try {
        await this.#pollOnce();
      } catch (err) {
        console.error(`[poller ${this.#repoId}] poll failed:`, err);
      }
      if (this.#stopped) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        this.#timer = setTimeout(() => this.kick(), this.#watched() ? WATCHED_INTERVAL_MS : IDLE_INTERVAL_MS);
        // The loop alone must not keep the process alive.
        this.#timer.unref?.();
      });
    }
  }

  #watched(): boolean {
    const { bus } = this.#deps;
    if (bus.watchers('home') > 0 || bus.watchers(repoTopic(this.#repoId)) > 0) return true;
    return this.#reviewIds.some((id) => bus.watchers(reviewTopic(id)) > 0);
  }

  async #pollOnce(): Promise<void> {
    const { db } = this.#deps;
    let repo = await getRepoById(db, this.#repoId);
    if (repo === null) {
      this.#stopped = true;
      return;
    }
    const reviews = (await listReviews(db, { repoId: repo.id })).filter((r) => r.status !== 'archived');
    this.#reviewIds = reviews.map((r) => r.id);
    const forge = forgeFor(repo);

    // Like lazygit: never fetch under a git command the user is running.
    if (!(await gitBusy(repo))) {
      repo = await this.#fetch(repo, reviews, forge);
    }

    const pulls = await this.#pollPulls(repo, forge);
    await Promise.all(reviews.map((review) => local.add(() => this.#refreshReview(repo, review, forge, pulls))));
  }

  /** One fetch for the repo, one for every review's PR head; returns the repo with its default branch current. */
  async #fetch(repo: Repo, reviews: readonly Review[], forge: Forge): Promise<Repo> {
    const cwd = repo.rootPath;
    await network.add(() => git(['fetch', '--no-write-fetch-head', 'origin'], { cwd, timeoutMs: FETCH_TIMEOUT_MS }));

    const prRefspecs = reviews.flatMap((r) => {
      const source = r.prNumber === null ? null : forge.pullHeadRef(r.prNumber);
      return source === null ? [] : [`+${source}:refs/review/pr/${r.id}`];
    });
    if (prRefspecs.length > 0) {
      const all = await network.add(() =>
        git(['fetch', '--no-write-fetch-head', 'origin', ...prRefspecs], { cwd, timeoutMs: FETCH_TIMEOUT_MS }),
      );
      // One missing PR ref fails the whole fetch; then fetch them one by one.
      if (all.exitCode !== 0) {
        for (const refspec of prRefspecs) {
          await network.add(() =>
            git(['fetch', '--no-write-fetch-head', 'origin', refspec], { cwd, timeoutMs: FETCH_TIMEOUT_MS }),
          );
        }
      }
    }

    if (this.#defaultBranchChecked) return repo;
    this.#defaultBranchChecked = true;
    const remoteDefault = await network.add(() => remoteDefaultBranch(cwd));
    if (remoteDefault === null || remoteDefault === repo.defaultBranch) return repo;
    await setDefaultBranch(this.#deps.db, repo.id, remoteDefault);
    return { ...repo, defaultBranch: remoteDefault };
  }

  /** The repo's open pulls, stored (and announced) when they changed. The last good list survives a failed call. */
  async #pollPulls(repo: Repo, forge: Forge): Promise<ListOpenPullsResult> {
    const { db, bus } = this.#deps;
    const stored = await getRepoState(db, repo.id);
    const previous = stored === null ? null : parsePulls(stored.pulls);

    const { login } = await getMe(repo.rootPath, forge, repo.remoteHost);
    const result = await forgeCalls.add(() => forge.listOpenPulls({ cwd: repo.rootPath, login }));
    if (!result.available && previous?.available === true) return previous;
    const json = JSON.stringify(result);
    if (stored === null || stored.pulls !== json) {
      await putRepoState(db, repo.id, json, stored?.version ?? null);
      bus.repoChanged(repo.id);
    }
    return result;
  }

  async #refreshReview(repo: Repo, original: Review, forge: Forge, pulls: ListOpenPullsResult): Promise<void> {
    const { db } = this.#deps;
    let review = original;
    let facts: PullFacts = pullFactsOf(await getReviewState(db, review.id));

    if (forge.kind !== 'none' && pulls.available) {
      // A branch review gets its PR once one is opened for the branch.
      if (review.prNumber === null && review.branch !== null) {
        const branch = review.branch;
        const match = pulls.pulls.find((p) => p.headRefName === branch);
        if (match !== undefined) review = await setPrNumber(db, review.id, match.number);
      }
      if (review.prNumber !== null) {
        facts = await this.#pullFacts(repo, review, review.prNumber, forge, pulls, facts);
        // A retargeted PR moves the review's base with it.
        const target = facts.pull?.baseRefName;
        if (target !== undefined && target !== review.baseRef) review = await setBaseRef(db, review.id, target);
      }
    }

    const rowChanged = review.prNumber !== original.prNumber || review.baseRef !== original.baseRef;
    const before = await getReviewState(db, review.id);
    const after = await refreshReviewState({ db, onChanged: () => {} }, repo, review, { pull: facts });
    const stateChanged = after !== null && after.version !== before?.version;
    if (rowChanged || stateChanged) {
      this.#deps.bus.reviewChanged(review.id);
      this.#deps.onReviewChanged(review.id);
    }
  }

  /**
   * The PR as the forge reports it. An open PR comes from the repo's list
   * (fresh CI, title, draft, target branch every round); its full detail
   * (description, url, size) is re-read only when the forge's `updatedAt`
   * moved. A PR missing from the open list is merged or closed: asked
   * directly until it's merged, which is final.
   */
  async #pullFacts(
    repo: Repo,
    review: Review,
    prNumber: number,
    forge: Forge,
    pulls: ListOpenPullsResult,
    facts: PullFacts,
  ): Promise<PullFacts> {
    const cwd = repo.rootPath;
    const known = facts.pull !== null && facts.pull.number === prNumber ? facts.pull : null;
    const open = pulls.pulls.find((p) => p.number === prNumber);

    let next: PullFacts;
    if (open !== undefined) {
      const stale = known === null || facts.pullUpdatedAt !== open.updatedAt || known.state === 'merged';
      // A failed read keeps the last known detail (and is retried next round).
      const read = stale ? normalize(await forgeCalls.add(() => forge.viewPull(prNumber, { cwd }))) : null;
      const detail = read ?? known;
      const pull: PullDetail | null =
        detail === null
          ? null
          : {
              ...detail,
              title: open.title,
              state: open.isDraft ? 'draft' : 'open',
              baseRefName: open.baseRefName,
              ci: open.ci,
            };
      next = {
        pull,
        pullHeadSha: open.headSha,
        pullUpdatedAt: stale && read === null ? facts.pullUpdatedAt : open.updatedAt,
        mergedBaseSha: facts.mergedBaseSha,
      };
    } else if (known?.state === 'merged') {
      next = facts;
    } else {
      const detail = normalize(await forgeCalls.add(() => forge.viewPull(prNumber, { cwd })));
      next = detail === null ? facts : { ...facts, pull: detail, pullHeadSha: null, pullUpdatedAt: null };
    }

    if (next.pull?.state === 'merged' && next.mergedBaseSha === null && !this.#mergedAsked.has(review.id)) {
      this.#mergedAsked.add(review.id);
      next = { ...next, mergedBaseSha: await mergedBase(repo, review, prNumber, forge) };
    }
    return next;
  }
}

/**
 * The base before a merge commit merged the PR: the merge-base of the merge
 * commit's first parent (the target branch just before) and the PR's head.
 * Null for a squash or rebase merge (head isn't in the base then, so the
 * plain merge-base already shows the PR), or on any failure. Pinned under
 * `refs/review/base/<id>` so git keeps the commit.
 */
async function mergedBase(repo: Repo, review: Review, prNumber: number, forge: Forge): Promise<string | null> {
  const cwd = repo.rootPath;
  try {
    const merged = await forgeCalls.add(() => forge.viewMergedPrCommits(prNumber, { cwd }));
    if (merged === null) return null;
    const { mergeCommit } = merged;
    if ((await revParse(`${mergeCommit}^{commit}`, { cwd })) === null) {
      await network.add(() =>
        git(['fetch', '--no-write-fetch-head', 'origin', mergeCommit], { cwd, timeoutMs: FETCH_TIMEOUT_MS }),
      );
    }
    const head = (await revParse(`refs/review/pr/${review.id}`, { cwd })) ?? merged.headRefOid;
    const parents = await git(['rev-list', '--parents', '-n', '1', mergeCommit], { cwd });
    const fields = bytesToText(parents.stdout).trim().split(/\s+/);
    // `<commit> <parent1> <parent2>`: anything but a two-parent merge is a squash/rebase.
    if (parents.exitCode !== 0 || fields.length !== 3) return null;
    if ((await git(['merge-base', '--is-ancestor', head, mergeCommit], { cwd })).exitCode !== 0) return null;
    const firstParent = fields[1];
    if (firstParent === undefined) return null;
    const base = (await baseMergeBase(firstParent, head, { cwd })) ?? firstParent;
    await pinReviewBaseRef(review.id, base, { cwd }).catch(() => undefined);
    return base;
  } catch {
    return null;
  }
}

/** Whether a git command is running in the repo right now (its index lock is held). */
async function gitBusy(repo: Repo): Promise<boolean> {
  try {
    const dir = await gitCommonDir({ cwd: repo.rootPath });
    await access(join(dir, 'index.lock'));
    return true;
  } catch {
    return false;
  }
}

/** The remote's default branch, from `ls-remote --symref origin HEAD`; null when it can't tell. */
async function remoteDefaultBranch(cwd: string): Promise<string | null> {
  const result = await git(['ls-remote', '--symref', 'origin', 'HEAD'], { cwd, timeoutMs: FETCH_TIMEOUT_MS });
  if (result.exitCode !== 0) return null;
  const match = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(bytesToText(result.stdout));
  return match?.[1] ?? null;
}

function parsePulls(json: string): ListOpenPullsResult | null {
  try {
    return JSON.parse(json) as ListOpenPullsResult;
  } catch {
    return null;
  }
}

/** Through the schema, so a stored pull compares equal to a re-read one whatever the forge's key order. */
function normalize(detail: PullDetail | null): PullDetail | null {
  if (detail === null) return null;
  const parsed = pullDetailSchema.safeParse(detail);
  return parsed.success ? parsed.data : null;
}

/** Every repo's poller: started with the server, added and removed with repos. */
export class RepoPollers {
  readonly #deps: RepoPollerDeps;
  readonly #pollers = new Map<string, RepoPoller>();
  #started = false;

  constructor(deps: RepoPollerDeps) {
    this.#deps = deps;
  }

  /** Start polling every registered repo. Until this runs (tests), nothing polls. */
  async start(): Promise<void> {
    this.#started = true;
    for (const repo of await listRepos(this.#deps.db)) this.ensure(repo.id);
  }

  /** Make sure `repoId` is being polled (a newly added repo), and poll it now. */
  ensure(repoId: string): void {
    if (!this.#started) return;
    const existing = this.#pollers.get(repoId);
    if (existing !== undefined) {
      existing.kick();
      return;
    }
    const poller = new RepoPoller(this.#deps, repoId);
    this.#pollers.set(repoId, poller);
    poller.start();
  }

  kick(repoId: string): void {
    this.#pollers.get(repoId)?.kick();
  }

  kickAll(): void {
    for (const poller of this.#pollers.values()) poller.kick();
  }

  remove(repoId: string): void {
    this.#pollers.get(repoId)?.stop();
    this.#pollers.delete(repoId);
  }

  stopAll(): void {
    for (const poller of this.#pollers.values()) poller.stop();
    this.#pollers.clear();
    this.#started = false;
  }
}
