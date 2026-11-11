/**
 * One live worker per open review.
 *
 * Owns what only a watcher on disk can know: the root binding, the
 * uncommitted `working` revision, and warm file lists for every revision, kept
 * in memory for the diff view. Runs a serialized, debounced tick on any
 * filesystem/git signal, ignoring event payloads entirely — every signal means
 * exactly one thing: run a tick.
 *
 * It decides nothing about base and head itself: `reviewState.ts` holds that
 * rule, and the repo poller (`repoPoller.ts`) does all fetching and forge
 * calls, then tells this worker (`notifyRemoteChange`) when the review's
 * stored state moved. When a local commit moves head before the next poll,
 * this worker stores the new state through the same `refreshReviewState`.
 */
import { watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import type {
  Divergence,
  FileList,
  GitOperation,
  HeadSource,
  Review,
  ReviewState,
  Revision,
  Repo,
  RootBinding,
  ServerEvent,
  Thread,
} from '@joinery/core';
import { diffFileLists, isEmptyDelta, type FileListDelta } from '@joinery/core';
import {
  bytesToText,
  buildFileList,
  CatFile,
  detectInProgressOperation,
  divergence,
  getFileContents,
  git,
  gitCommonDir,
  gitOrThrow,
  baseMergeBase,
  revParse,
} from '../git/index.ts';
import {
  adoptBranch,
  findReviewByBranch,
  getReview,
  getReviewState,
  getThreadWithComments,
  listThreadsByReview,
  renamePaths,
  updateAnchors,
  type Db,
  type Rename,
  type ThreadAnchorUpdate,
} from '../db/index.ts';
import { relocate } from './anchor.ts';
import {
  forgeFactsOf,
  pinRange,
  pullFactsOf,
  refreshReviewState,
  resolveBase,
  resolvePrRange,
  resolveReviewRange,
  type ForgeFacts,
  type ReviewRange,
} from './reviewState.ts';
import { resolveRoot } from './root.ts';

const DEBOUNCE_MS = 150;
const DEBOUNCE_CEILING_MS = 1_000;

export type ReviewEngineParams = {
  readonly db: Db;
  readonly repo: Repo;
  readonly review: Review;
  readonly emit: (event: ServerEvent) => void;
  /** This worker stored a new `review_state` version (after commit). */
  readonly onStateChanged?: (reviewId: string) => void;
};

/**
 * True when an `fs.watch` filename names one of *our own* bookkeeping refs
 * under `refs/review/` — the head pin and the fetched PR ref.
 *
 * One `update-ref` produces several distinct paths, and the path is relative
 * to whichever directory fired, so matching a fixed prefix is not enough:
 *
 *   refs/review/<id>                 git-dir watch
 *   .git/refs/review/<id>            root watch, collapsed onto the main clone
 *   .git/refs/review/<id>.lock       the transient lock git writes first
 *   .git/logs/refs/review/<id>       the reflog, when core.logAllRefUpdates is on
 *   refs, .git/refs                  Windows also reports the parent when the first pin creates `refs/review`
 *
 * So this matches a `refs/review/` path *segment* anywhere. The theoretical
 * cost is swallowing a signal for a tracked source file that genuinely lives
 * at `.../refs/review/...` in a worktree; that is worth it against the
 * certainty of the engine waking itself on every head move.
 */
function isOwnRefWrite(filename: string | Buffer | null): boolean {
  if (filename === null) return false;
  const name = (typeof filename === 'string' ? filename : filename.toString('utf8')).replaceAll('\\', '/');
  if (name === 'refs' || name === '.git/refs') return true; // a real change inside still reports its own path
  return name === 'refs/review' || name.startsWith('refs/review/') || name.includes('/refs/review/');
}

/**
 * True when `child` is `parent` or nested under it (both already realpaths).
 * The `/` is deliberate on Windows too: there `.git` must keep its own watch,
 * because only that watch marks `head` stale after a commit.
 */
function isUnderOrEqual(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSlash = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(withSlash);
}

export class ReviewEngine {
  readonly #db: Db;
  readonly #repo: Repo;
  #review: Review;
  readonly #emit: (event: ServerEvent) => void;
  readonly #onStateChanged: (reviewId: string) => void;
  readonly #catFile: CatFile;
  #gitCommonDir: string | null = null;

  #attachedPath: string | null = null;
  #detachedReason: RootBinding['detachedReason'] = 'not-checked-out';
  #operationInProgress: GitOperation | null = null;
  /** Which rung of the fallback ladder last resolved `head`; null until the first tick resolves it. */
  #headSource: HeadSource | null = null;
  /** Head is already inside the base and the diff shows what was merged (`reviewState.ts`). */
  #merged = false;
  /** One cached snapshot per revision — kept warm proactively so a revision switch is a cache read, not a recompute. */
  #snapshots: Record<Revision, FileList>;
  #built = new Set<Revision>();
  /**
   * The expensive, git-derived half of `ReviewState` — `divergence` and
   * `basesMismatched` — recomputed only inside the tick path (`#emitState`)
   * and reused by every `getState()` call in between. Every input to these
   * two fields (HEAD, the PR ref `refs/review/pr/<id>`, `baseRef`) only moves
   * via a detector signal that already schedules a tick, so a revision
   * *switch* (which does not go through the tick path) can never invalidate
   * this cache. `null` until the first computation, so `getState()` falls
   * back to computing it lazily rather than serving a placeholder.
   */
  #cachedRevisionState: Pick<ReviewState, 'divergence' | 'basesMismatched'> | null = null;
  /**
   * Which detector(s) fired since the last tick, so a tick only rebuilds the
   * revision(s) that detector actually invalidates rather than all three.
   * `remote-default` invalidates every revision's `baseSha` (shared
   * `merge-base(baseRef, ...)`), so it always forces a full rebuild.
   */
  #pendingSources = new Set<'root' | 'git' | 'remote-default' | 'remote-pr'>([
    'root',
    'git',
    'remote-default',
    'remote-pr',
  ]);

  #rootWatcher: FSWatcher | null = null;
  #gitWatcher: FSWatcher | null = null;
  #watchedRoot: string | null = null;

  #ticking = false;
  #dirty = false;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #firstSignalAt: number | null = null;

  #disposed = false;
  #subscriberCount = 0;

  private constructor(params: ReviewEngineParams) {
    this.#db = params.db;
    this.#repo = params.repo;
    this.#review = params.review;
    this.#emit = params.emit;
    this.#onStateChanged = params.onStateChanged ?? (() => {});
    this.#catFile = new CatFile(params.repo.rootPath);
    const placeholder = (revision: Revision): FileList => ({
      reviewId: params.review.id,
      revision,
      baseSha: '',
      headSha: '',
      files: [],
    });
    this.#snapshots = {
      working: placeholder('working'),
      head: placeholder('head'),
      pr: placeholder('pr'),
    };
  }

  static async create(params: ReviewEngineParams): Promise<ReviewEngine> {
    const engine = new ReviewEngine(params);
    try {
      engine.#gitCommonDir = await gitCommonDir({ cwd: params.repo.rootPath });
    } catch {
      engine.#gitCommonDir = null;
    }
    await engine.tick();
    return engine;
  }

  get reviewId(): string {
    return this.#review.id;
  }

  get repo(): Repo {
    return this.#repo;
  }

  /** The cached snapshot for `revision`, or the review's current revision when omitted. */
  getFileList(revision?: Revision): FileList {
    return this.#snapshots[revision ?? this.#resolveEffectiveRevision()];
  }

  /**
   * The cheap fields (`currentRevision`, `operationInProgress`, ...) are
   * always rebuilt fresh, since `setCurrentRevisionHint()` and the operation
   * detector can change them without a tick. The expensive git-derived
   * fields come from `#cachedRevisionState`, computed lazily here on first
   * access if no tick has populated it yet.
   */
  async getState(): Promise<ReviewState> {
    if (this.#cachedRevisionState === null) return this.#computeState();
    return this.#buildState();
  }

  /**
   * The cwd/blobs backing the *current* snapshot, for per-file patch/content
   * fetches. Scoped to the review's current revision — fetching a
   * different revision's patch for one file is a known gap.
   */
  getRenderContext(): {
    cwd: string;
    /** The review's branch checked out on disk; null when it isn't anywhere. */
    attachedPath: string | null;
    revision: Revision;
    baseSha: string;
    headSha: string;
  } {
    const snapshot = this.#snapshots[this.#resolveEffectiveRevision()];
    return {
      cwd: this.#attachedPath ?? this.#repo.rootPath,
      attachedPath: this.#attachedPath,
      revision: snapshot.revision,
      baseSha: snapshot.baseSha,
      headSha: snapshot.headSha,
    };
  }

  /**
   * Updates the in-memory "current revision" immediately after an HTTP
   * switch, without waiting for a tick to reload the review row — the switch
   * itself already persisted it (routes.ts), and the target revision's
   * snapshot is already warm, so there is nothing left to recompute.
   */
  setCurrentRevisionHint(revision: Revision): void {
    this.#review = { ...this.#review, currentRevision: revision };
  }

  getCatFile(): CatFile {
    return this.#catFile;
  }

  subscribe(): void {
    this.#subscriberCount++;
  }

  unsubscribe(): void {
    this.#subscriberCount = Math.max(0, this.#subscriberCount - 1);
  }

  get subscriberCount(): number {
    return this.#subscriberCount;
  }

  /**
   * Whether `dispose()` has already run. `EngineRegistry.get()` checks this
   * so a cached-but-disposed entry (e.g. evicted by the idle sweep just as a
   * caller resumes after an `await`) is treated as a cache miss and rebuilt,
   * rather than handing back an engine whose `cat-file` process and watchers
   * are already torn down.
   */
  get disposed(): boolean {
    return this.#disposed;
  }

  /** The window came back into focus: re-check disk now (the registry also re-polls the repo). */
  focus(): void {
    this.#scheduleTick();
  }

  /**
   * The repo poller fetched, or the review's stored state or row moved
   * (target branch, PR, merged): every revision's base or head may have.
   */
  notifyRemoteChange(): void {
    this.#pendingSources.add('git');
    this.#pendingSources.add('remote-default');
    this.#pendingSources.add('remote-pr');
    this.#scheduleTick();
  }

  /** Call after any HTTP-side mutation that should be reflected promptly. */
  notifyExternalChange(): void {
    this.#pendingSources.add('root');
    this.#pendingSources.add('git');
    this.#scheduleTick();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#rootWatcher?.close();
    this.#gitWatcher?.close();
    if (this.#debounceTimer !== null) clearTimeout(this.#debounceTimer);
    this.#catFile.close();
  }

  // --- signal handling / debounce ---

  // Filtered for the same reason as `#onGitSignal` below: when the attached
  // root *is* the main clone, `#syncGitWatcher` collapses the git watch into
  // this one, so our own ref writes surface here as
  // `.git/refs/review/...` instead.
  #onRootSignal = (_event: string, filename: string | Buffer | null): void => {
    if (isOwnRefWrite(filename)) return;
    this.#pendingSources.add('root');
    this.#scheduleTick();
  };

  /**
   * Our own bookkeeping refs live under `refs/review/` inside
   * `$GIT_COMMON_DIR` — the `refs/review/<id>` head pin this engine writes
   * during a tick and the `refs/review/pr/<id>` ref the remote
   * poll fetches into. Both are *our* writes, so treating them as "git
   * changed" makes the engine wake itself: tick -> pin -> watcher fires ->
   * tick -> `#emitState`, broadcasting a spurious `root.rebound` for a
   * review whose root never moved. The sha guard on the pin stops it after
   * one extra round, but one extra round per head move is still UI churn
   * and still wrong.
   *
   * Everything else under the git dir is a genuine external signal and must
   * still get through — including `refs/remotes/origin/*`, which the poll
   * writes but which represents a real remote move.
   */
  #onGitSignal = (_event: string, filename: string | Buffer | null): void => {
    if (isOwnRefWrite(filename)) return;
    this.#pendingSources.add('git');
    this.#scheduleTick();
  };

  #scheduleTick(): void {
    if (this.#disposed) return;
    const now = Date.now();
    this.#firstSignalAt ??= now;
    if (this.#debounceTimer !== null) clearTimeout(this.#debounceTimer);
    const elapsed = now - this.#firstSignalAt;
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, DEBOUNCE_CEILING_MS - elapsed));
    this.#debounceTimer = setTimeout(() => {
      this.#firstSignalAt = null;
      this.#debounceTimer = null;
      // Nothing awaits a timer-driven tick, and an escaped rejection would
      // take the whole server down; the next signal simply ticks again.
      this.tick().catch((err: unknown) => {
        console.error(`[engine ${this.#review.id}] tick failed:`, err);
      });
    }, wait);
  }

  /**
   * Run a tick now, serialized against any tick already in flight: an event
   * mid-tick sets a dirty flag scheduling exactly one more rather than
   * overlapping. Public so callers (tests, an explicit "refresh" route) can
   * force a synchronous recompute instead of waiting on the debounce.
   */
  async tick(): Promise<void> {
    if (this.#disposed) return;
    if (this.#ticking) {
      this.#dirty = true;
      return;
    }
    this.#ticking = true;
    try {
      do {
        this.#dirty = false;
        await this.#tickOnce();
      } while (this.#dirty && !this.#disposed);
    } finally {
      this.#ticking = false;
    }
  }

  // --- watchers ---

  #syncWatchers(attachedPath: string | null): void {
    if (attachedPath !== this.#watchedRoot) {
      this.#rootWatcher?.close();
      this.#rootWatcher = null;
      if (attachedPath !== null) {
        try {
          this.#rootWatcher = watch(attachedPath, { recursive: true }, this.#onRootSignal);
        } catch {
          this.#rootWatcher = null;
        }
      }
      this.#watchedRoot = attachedPath;
    }
    this.#syncGitWatcher();
  }

  /** Collapses into the root watch when the attached root is the main clone. */
  #syncGitWatcher(): void {
    const gitDir = this.#gitCommonDir;
    const collapsed = gitDir !== null && this.#watchedRoot !== null && isUnderOrEqual(gitDir, this.#watchedRoot);
    const shouldWatch = gitDir !== null && !collapsed;

    if (shouldWatch === (this.#gitWatcher !== null)) return;
    this.#gitWatcher?.close();
    this.#gitWatcher = null;
    if (shouldWatch && gitDir !== null) {
      try {
        this.#gitWatcher = watch(gitDir, { recursive: true }, this.#onGitSignal);
      } catch {
        this.#gitWatcher = null;
      }
    }
  }

  // --- the tick ---

  async #tickOnce(): Promise<void> {
    const previousPrNumber = this.#review.prNumber;
    const reloaded = await getReview(this.#db, this.#review.id);
    if (reloaded === null) return; // review deleted; registry disposes separately
    this.#review = reloaded;
    // Newly discovered/changed independently of the file list (e.g. `#detectPr`)
    // — the early-outs below only skip `#emitState` for an unchanged file list,
    // and this must not get swallowed by them the same way root/operation don't.
    const prNumberChanged = reloaded.prNumber !== previousPrNumber;

    await this.#maybeAdoptBranch();

    // 1. Re-run root resolution.
    const rootRes = await resolveRoot(this.#repo, this.#review);
    const rootChanged = rootRes.attachedPath !== this.#attachedPath;
    this.#attachedPath = rootRes.attachedPath;
    this.#detachedReason = rootRes.detachedReason;
    this.#syncWatchers(this.#attachedPath);

    const operation = this.#attachedPath === null ? null : await this.#detectOperation(this.#attachedPath);
    const operationChanged = operation !== this.#operationInProgress;
    this.#operationInProgress = operation;

    if (operation !== null) {
      // Mid-operation states: hold the last good snapshot. The
      // cached `divergence`/`basesMismatched` can still be stale though — a
      // commit or remote move that landed mid-operation still moved them —
      // so the same signal check as below applies here too, against the
      // signals accumulated so far (not yet snapshotted/cleared at this
      // point in the tick).
      if (rootChanged || operationChanged || prNumberChanged || this.#stateSignalsFired(this.#pendingSources)) {
        await this.#emitState();
      }
      return;
    }

    const review = this.#review;
    const effectiveRevision = this.#resolveEffectiveRevision();
    const cwd = this.#attachedPath ?? this.#repo.rootPath;
    const available = this.availableRevisions();

    // Snapshot and clear the accumulated signals for this tick. Anything that
    // arrives while this tick is running lands in a fresh set the *next* tick
    // reads — see the `#dirty` loop in `tick()`, which guarantees there is a
    // next tick whenever a signal arrives mid-run.
    const sources = new Set(this.#pendingSources);
    this.#pendingSources.clear();

    // 2-5, per revision: only the revision(s) an actual detector invalidated
    // get rebuilt — a worktree edit only touches `working`, a commit only
    // touches `head`, the PR ref moving only touches `pr`. `root` changing
    // (the attached directory itself moved or vanished) can change how every
    // revision resolves, so it forces all of them. `remote-default` moving
    // the base is the one case that must invalidate every revision even
    // though only one detector fired, because `merge-base(baseRef, ...)` is
    // shared across all three.
    // What the forge last said (merged, the pre-merge base), as the repo poller stored it.
    const forge: ForgeFacts = forgeFactsOf(pullFactsOf(await getReviewState(this.#db, review.id)));

    for (const rev of available) {
      const needsRebuild =
        rootChanged ||
        !this.#built.has(rev) ||
        sources.has('remote-default') ||
        (rev === 'working' && sources.has('root')) ||
        (rev === 'head' && sources.has('git')) ||
        // `head` falls back to the fetched PR ref once the branch is gone
        // (rung d of the ladder), and the forge's merged facts land with it.
        (rev === 'head' && review.prNumber !== null && sources.has('remote-pr')) ||
        (rev === 'pr' && sources.has('remote-pr'));
      if (!needsRebuild) continue;

      // Resolve the range to commits, once, before anything reads it.
      //
      // Everything downstream has to agree on a single commit even if a ref
      // moves mid-tick, and `headSha` is what a later tick compares against to
      // decide whether head actually moved — a ref *name* would always compare
      // equal to itself, so storing one silently disables that check. The
      // rule itself lives in `reviewState.ts`, shared with the repo poller.
      let headSha: string;
      let baseSha: string;
      let headRange: ReviewRange | null = null;
      if (rev === 'head') {
        // Only give up on `head` (and `continue`, holding the last snapshot)
        // once every rung of the ladder has come back empty.
        headRange = await resolveReviewRange({ repo: this.#repo, review, attachedPath: this.#attachedPath, forge });
        if (headRange === null) continue;
        headSha = headRange.headSha;
        baseSha = headRange.baseSha;
        this.#headSource = headRange.headSource;
        this.#merged = headRange.merged;
        await pinRange(this.#repo, review.id, headRange);
      } else if (rev === 'pr') {
        const prRange = await resolvePrRange({ review, cwd, forge });
        if (prRange === null) continue;
        headSha = prRange.headSha;
        baseSha = prRange.baseSha;
      } else {
        const resolved = await revParse('HEAD', { cwd });
        if (resolved === null) continue;
        headSha = resolved;
        baseSha = (await resolveBase(review, headSha, cwd, forge)).baseSha;
      }

      // Build the file list (includes the one `hash-object` spawn for working).
      let newFiles;
      try {
        newFiles = await buildFileList(
          rev === 'working' ? { cwd, revision: rev, baseSha } : { cwd, revision: rev, baseSha, targetSha: headSha },
        );
      } catch {
        // A git error mid-tick — hold this revision's last good snapshot rather than crash the actor.
        continue;
      }

      this.#built.add(rev);
      const previous = this.#snapshots[rev];

      // A local commit moves head before the next repo poll: store it now,
      // from the list just built, so Homebase sees it at once too.
      if (headRange !== null) {
        await refreshReviewState(
          { db: this.#db, onChanged: this.#onStateChanged },
          this.#repo,
          review,
          { attachedPath: this.#attachedPath, built: { range: headRange, files: newFiles } },
        );
      }

      // The early-out: list identical -> stop. Zero UI work.
      const delta = diffFileLists(previous.files, newFiles);
      if (isEmptyDelta(delta)) {
        // The *files* are unchanged, but head may still have moved under them
        // (an amend, a rebase that preserved the tree). Per-file patch fetches
        // key off these shas, so keep them current even though there is nothing
        // for the client to redraw.
        this.#snapshots[rev] = { ...previous, baseSha, headSha };
        continue;
      }

      // Renames are derived from *this build's* rename detection (git diff -M
      // against `baseSha`), not from `delta.renamed` — a file that was
      // unmodified relative to base was never in the previous snapshot at all,
      // so the client-facing delta has nothing to call a "rename" for it, but
      // a thread anchored to its old path still needs to follow.
      const renames: Rename[] = [];
      for (const f of newFiles) {
        if (f.oldPath !== null) renames.push({ from: f.oldPath, to: f.path });
      }
      // Thread anchors are re-derived only against the review's persisted
      // (default) revision. A non-default revision's file list can genuinely
      // differ from the default's — e.g. `working` has an uncommitted change
      // `head` doesn't — and re-anchoring the one shared thread row against
      // two different revisions' deltas in the same tick would race. Cross-
      // revision thread positions are handled separately at render time.
      if (rev === effectiveRevision) {
        if (renames.length > 0) {
          await renamePaths(this.#db, review.id, renames);
        }
        await this.#reanchorThreads(delta, renames, rev, cwd);
      }

      this.#snapshots[rev] = {
        reviewId: review.id,
        revision: rev,
        baseSha,
        headSha,
        files: newFiles,
      };
      this.#emit({ type: 'files.changed', reviewId: review.id, list: this.#snapshots[rev] });
    }

    // `#cachedRevisionState` (divergence, basesMismatched) is only ever
    // refreshed here, inside `#emitState`. `root`/`operation`/`prNumber`
    // changing are not the only things that can move it: `git` (HEAD moved),
    // `remote-pr` (the PR ref moved), and `remote-default` (`baseRef`'s
    // merge-base moved) all feed `divergence`/`basesMismatched` directly and
    // must also force a refresh, or the cache would keep serving values from
    // the last root/operation/pr-number change indefinitely.
    if (rootChanged || operationChanged || prNumberChanged || this.#stateSignalsFired(sources)) {
      await this.#emitState();
    }
  }

  /** Whether any of `sources` can move `divergence`/`basesMismatched` (see `#cachedRevisionState`). */
  #stateSignalsFired(sources: ReadonlySet<'root' | 'git' | 'remote-default' | 'remote-pr'>): boolean {
    return sources.has('git') || sources.has('remote-pr') || sources.has('remote-default');
  }

  /** Revisions that actually exist right now (the picker). */
  availableRevisions(): Revision[] {
    const available: Revision[] = [];
    if (this.#attachedPath !== null) available.push('working');
    available.push('head');
    if (this.#review.prNumber !== null) available.push('pr');
    return available;
  }

  /**
   * The first time a named branch's history contains a `(repo, sha)`
   * review's pinned commit, adopt it. `git branch --contains` can return
   * several candidates; walk them in git's order and adopt the first one not
   * already owned by another review in this repo (the `(repo_id, branch)`
   * unique index forbids two reviews sharing a branch — stealing it would
   * silently orphan the other review's threads). If every candidate is
   * taken, stay detached: adoption is an optimisation, not a requirement.
   * Never let adoption failure take the tick down with it.
   */
  async #maybeAdoptBranch(): Promise<void> {
    const review = this.#review;
    if (review.branch !== null || review.pinnedSha === null) return;
    try {
      const result = await git(['branch', '--format=%(refname:short)', '--contains', review.pinnedSha], {
        cwd: this.#repo.rootPath,
      });
      if (result.exitCode !== 0) return;
      const text = bytesToText(result.stdout).trim();
      if (text === '') return;
      const candidates = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      for (const branchName of candidates) {
        const owner = await findReviewByBranch(this.#db, review.repoId, branchName);
        if (owner !== null) continue;
        this.#review = await adoptBranch(this.#db, review.id, branchName);
        return;
      }
    } catch {
      // Adoption is an optimisation; a failure here must not crash the tick.
      return;
    }
  }

  /**
   * The stored choice always wins when present; falling
   * back for unavailability must never overwrite it, so a branch that goes
   * away and comes back restores the prior choice rather than adopting
   * whatever the fallback picked in the meantime.
   */
  #resolveEffectiveRevision(): Revision {
    const review = this.#review;
    const attached = this.#attachedPath !== null;
    const desired = review.currentRevision ?? (attached ? 'working' : 'head');
    if (desired === 'working' && !attached) return 'head';
    if (desired === 'pr' && review.prNumber === null) return 'head';
    return desired;
  }

  async #detectOperation(attachedPath: string): Promise<GitOperation | null> {
    try {
      const result = await gitOrThrow(['rev-parse', '--git-dir'], { cwd: attachedPath });
      const raw = bytesToText(result.stdout).trim();
      const gitDir = raw.startsWith('/') ? raw : resolve(attachedPath, raw);
      return await detectInProgressOperation(gitDir);
    } catch {
      return null;
    }
  }

  /**
   * Threads across snapshots. Exact match on `anchor_blob_sha`
   * is free and never reaches this function (nothing in `delta` mentions an
   * unchanged file). Otherwise search the new blob for the captured context:
   * hit updates line numbers, miss sets `outdated` and keeps the thread.
   */
  async #reanchorThreads(
    delta: FileListDelta,
    renames: readonly Rename[],
    revision: Revision,
    cwd: string,
  ): Promise<void> {
    const threads = await listThreadsByReview(this.#db, this.#review.id);
    if (threads.length === 0) return;

    const renamedFrom = new Set(renames.map((r) => r.from));
    const updates: ThreadAnchorUpdate[] = [];

    for (const removedEntry of delta.removed) {
      if (renamedFrom.has(removedEntry.path)) continue;
      for (const t of threads) {
        if (t.path === removedEntry.path && !t.outdated) {
          updates.push(outdatedUpdate(t));
        }
      }
    }

    for (const c of delta.changed) {
      const pathThreads = threads.filter((t) => t.path === c.after.path);
      if (pathThreads.length === 0) continue;

      let contents: { oldContents: string | null; newContents: string | null } | null;
      try {
        contents = await getFileContents({
          cwd,
          revision,
          path: c.after.path,
          oldBlob: c.after.oldBlob,
          newBlob: c.after.newBlob,
          catFile: this.#catFile,
        });
      } catch {
        contents = null;
      }

      for (const t of pathThreads) {
        const sideBlob = t.side === 'old' ? c.after.oldBlob : c.after.newBlob;
        if (sideBlob === t.anchorBlobSha) {
          if (!t.outdated) continue; // this thread's side didn't change — free
          // The file was reverted back to this thread's anchor blob: the
          // original startLine/endLine are valid again by definition.
          updates.push({
            id: t.id,
            startLine: t.startLine,
            endLine: t.endLine,
            anchorBlobSha: t.anchorBlobSha,
            outdated: false,
            changedSinceComment: true,
          });
          continue;
        }

        const text = t.side === 'old' ? (contents?.oldContents ?? null) : (contents?.newContents ?? null);
        if (text === null) {
          updates.push(outdatedUpdate(t));
          continue;
        }

        const located = relocate(text.split('\n'), t);
        if (located === null) {
          updates.push(outdatedUpdate(t));
        } else {
          updates.push({
            id: t.id,
            startLine: located.startLine,
            endLine: located.endLine,
            anchorBlobSha: sideBlob,
            outdated: false,
            changedSinceComment: true,
          });
        }
      }
    }

    if (updates.length === 0) return;
    await updateAnchors(this.#db, updates);

    const ids = [...new Set(updates.map((u) => u.id))];
    const updatedThreads = (await Promise.all(ids.map((id) => getThreadWithComments(this.#db, id)))).filter(
      (t): t is Thread => t !== null,
    );
    if (updatedThreads.length > 0) {
      this.#emit({ type: 'thread.relocated', reviewId: this.#review.id, threads: updatedThreads });
    }
  }

  /**
   * Recomputes the expensive git-derived half of the state (`divergence`,
   * `basesMismatched`), stores it in `#cachedRevisionState`, and returns the
   * full `ReviewState` built from that plus the always-fresh cheap fields.
   * Only called from the tick path (`#emitState`) and, lazily, the first
   * `getState()` before any tick has run.
   */
  async #computeState(): Promise<ReviewState> {
    const review = this.#review;

    let divergenceValue: Divergence | null = null;
    let basesMismatched = false;
    if (review.prNumber !== null) {
      const cwd = this.#attachedPath ?? this.#repo.rootPath;
      const prRef = `refs/review/pr/${review.id}`;
      // Reuse the `head` snapshot's already-resolved sha rather than
      // re-deriving a ref here: it went through the full fallback ladder
      // (`#resolveHeadTarget`), and duplicating a subset of that ladder here
      // would silently under-resolve for a branch that only exists on the
      // remote — exactly the bug this change fixes elsewhere. Empty only
      // before the first tick has ever built `head` (the placeholder).
      const headRef = this.#snapshots.head.headSha !== '' ? this.#snapshots.head.headSha : 'HEAD';
      try {
        // Independent git calls — run them concurrently rather than serially.
        const [d, baseHead, basePr] = await Promise.all([
          divergence(headRef, prRef, { cwd }),
          baseMergeBase(review.baseRef, headRef, { cwd }),
          baseMergeBase(review.baseRef, prRef, { cwd }),
        ]);
        divergenceValue = d;
        basesMismatched = baseHead !== null && basePr !== null && baseHead !== basePr;
      } catch {
        // Any of the three throwing leaves both fields at their defaults.
        divergenceValue = null;
      }
    }

    this.#cachedRevisionState = { divergence: divergenceValue, basesMismatched };
    return this.#buildState();
  }

  /** Assembles a `ReviewState` from `#cachedRevisionState` plus the cheap fields, all computed fresh. */
  #buildState(): ReviewState {
    const review = this.#review;
    return {
      reviewId: review.id,
      availableRevisions: this.availableRevisions(),
      currentRevision: this.#resolveEffectiveRevision(),
      root: { attachedPath: this.#attachedPath, detachedReason: this.#detachedReason },
      divergence: this.#cachedRevisionState?.divergence ?? null,
      basesMismatched: this.#cachedRevisionState?.basesMismatched ?? false,
      operationInProgress: this.#operationInProgress,
      prNumber: review.prNumber,
      headSource: this.#headSource,
      merged: this.#merged,
    };
  }

  async #emitState(): Promise<void> {
    const state = await this.#computeState();
    this.#emit({ type: 'root.rebound', reviewId: this.#review.id, state });
  }
}

function outdatedUpdate(t: Thread): ThreadAnchorUpdate {
  return {
    id: t.id,
    startLine: t.startLine,
    endLine: t.endLine,
    anchorBlobSha: t.anchorBlobSha,
    outdated: true,
    changedSinceComment: true,
  };
}
