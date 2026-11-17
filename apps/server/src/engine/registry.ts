/**
 * `EngineRegistry` — the engine's front door for the HTTP layer: the topic
 * bus (`bus.ts`), the per-repo pollers that keep stored state current
 * (`repoPoller.ts`), and one live `ReviewEngine` worker per open review,
 * created lazily and kept alive while a window watches it.
 */
import { reviewTopic, type ServerEvent } from '@joinery/core';
import type { Db } from '../db/index.ts';
import { getRepoById, getReview } from '../db/index.ts';
import { EventBus } from './bus.ts';
import { RepoPollers } from './repoPoller.ts';
import { forgetPins } from './reviewState.ts';
import { ReviewEngine } from './reviewEngine.ts';

/**
 * Idle-eviction constants. Workers are a ceiling on concurrency, not a promise
 * to keep every worker ever touched alive forever. A `ReviewEngine` pins two
 * recursive `fs.watch` handles and a live `git cat-file --batch` child
 * process. A one-shot HTTP/CLI call (e.g. `joinery files <id>`) goes through
 * the same `requireEngine` path as a live review window and would otherwise
 * leak both for the life of the server.
 *
 * `SWEEP_INTERVAL_MS` is how often the registry looks for idle workers.
 * `IDLE_GRACE_MS` is how long an unwatched worker survives after its last
 * `get()` before it's disposed. A live review window always watches its
 * `review:<id>` topic (`subscriberCount > 0`), so it is exempt from the sweep
 * no matter how long it sits idle on screen — only unwatched workers age out.
 * Stored state doesn't depend on any of this: the repo pollers keep it
 * current whether a worker runs or not.
 */
const SWEEP_INTERVAL_MS = 60_000;
const IDLE_GRACE_MS = 120_000;

/**
 * Told when a window starts or stops showing a review, and when a shown
 * review moves (a tick, a revision switch): language servers get their
 * checkout ready ahead of the first hover, and give it back after.
 */
export interface ReviewViewListener {
  opened(engine: ReviewEngine): void;
  changed(engine: ReviewEngine): void;
  closed(reviewId: string): void;
}

interface EngineEntry {
  engine: ReviewEngine;
  lastUsedAt: number;
}

export class EngineRegistry {
  readonly #db: Db;
  readonly bus: EventBus;
  readonly pollers: RepoPollers;
  readonly #engines = new Map<string, EngineEntry>();
  readonly #creating = new Map<string, Promise<ReviewEngine | null>>();
  readonly #sweepTimer: ReturnType<typeof setInterval>;
  #viewListener: ReviewViewListener | null = null;

  constructor(db: Db, bus: EventBus = new EventBus()) {
    this.#db = db;
    this.bus = bus;
    this.pollers = new RepoPollers({
      db,
      bus,
      // The poller already announced it; the live worker (if any) re-reads.
      onReviewChanged: (reviewId) => this.#engines.get(reviewId)?.engine.notifyRemoteChange(),
    });
    this.#sweepTimer = setInterval(() => this.#sweep(), SWEEP_INTERVAL_MS);
    // Don't let the sweep alone keep the process alive (e.g. in tests or a
    // CLI-driven server that should exit once its real work is done).
    this.#sweepTimer.unref?.();
  }

  /** Returns the worker for `reviewId`, creating it on first use. Null if the review doesn't exist. */
  async get(reviewId: string): Promise<ReviewEngine | null> {
    const existing = this.#engines.get(reviewId);
    // A cached entry can be disposed out from under a caller that resumed
    // after an `await` right as the idle sweep ran — treat that as a cache
    // miss and rebuild rather than handing back a worker whose `cat-file`
    // process and watchers are already torn down.
    if (existing !== undefined && !existing.engine.disposed) {
      existing.lastUsedAt = Date.now();
      return existing.engine;
    }

    const inFlight = this.#creating.get(reviewId);
    if (inFlight !== undefined) return inFlight;

    const promise = this.#create(reviewId);
    this.#creating.set(reviewId, promise);
    try {
      return await promise;
    } finally {
      this.#creating.delete(reviewId);
    }
  }

  async #create(reviewId: string): Promise<ReviewEngine | null> {
    const review = await getReview(this.#db, reviewId);
    if (review === null) return null;
    const repo = await getRepoById(this.#db, review.repoId);
    if (repo === null) return null;

    const engine = await ReviewEngine.create({
      db: this.#db,
      repo,
      review,
      // A worker's live events (file lists, state, relocated threads) only
      // concern the review's own window.
      emit: (event) => {
        this.bus.publish(reviewTopic(reviewId), event);
        const entry = this.#engines.get(reviewId);
        if ((event.type === 'files.changed' || event.type === 'root.rebound') && entry !== undefined) {
          this.#viewListener?.changed(entry.engine);
        }
      },
      onStateChanged: (id) => this.bus.reviewChanged(id),
      onPushed: (repoId) => this.pollers.kick(repoId),
    });
    this.#engines.set(reviewId, { engine, lastUsedAt: Date.now() });
    return engine;
  }

  /**
   * Disposes every worker that's both unwatched (`subscriberCount === 0` —
   * no live review window pinning it open) and idle past `IDLE_GRACE_MS`.
   */
  #sweep(): void {
    const now = Date.now();
    for (const [reviewId, entry] of this.#engines) {
      if (entry.engine.subscriberCount > 0) continue;
      if (now - entry.lastUsedAt < IDLE_GRACE_MS) continue;
      entry.engine.dispose();
      this.#engines.delete(reviewId);
    }
  }

  /**
   * Publish a review's row event (a thread created or replied to, a reading
   * order written, a run started/ended) to its window, and tell Homebase,
   * whose cards count threads and runs.
   */
  dispatch(reviewId: string, event: ServerEvent): void {
    this.bus.publish(reviewTopic(reviewId), event);
    this.bus.changed('home');
  }

  /**
   * A window started watching `review:<id>`: keep its worker alive until the
   * returned release runs. Null if the review doesn't exist.
   */
  async watch(reviewId: string): Promise<{ engine: ReviewEngine; release: () => void } | null> {
    const engine = await this.get(reviewId);
    if (engine === null) return null;
    engine.subscribe();
    this.#viewListener?.opened(engine);
    // A watched repo polls on the quick interval; poll it now rather than at the old one.
    const review = await getReview(this.#db, reviewId);
    if (review !== null) this.pollers.kick(review.repoId);
    let released = false;
    return {
      engine,
      release: () => {
        if (released) return;
        released = true;
        engine.unsubscribe();
        this.#viewListener?.closed(reviewId);
      },
    };
  }

  setViewListener(listener: ReviewViewListener): void {
    this.#viewListener = listener;
  }

  /** The review's window regained focus: re-check disk, and re-poll its repo now. */
  async focus(reviewId: string): Promise<void> {
    const engine = await this.get(reviewId);
    engine?.focus();
    const review = await getReview(this.#db, reviewId);
    if (review !== null) this.pollers.kick(review.repoId);
  }

  /** Called after an HTTP mutation (revision switch, viewed check, ...) so the review ticks promptly. */
  async notifyExternalChange(reviewId: string): Promise<void> {
    const engine = await this.get(reviewId);
    engine?.notifyExternalChange();
  }

  disposeAll(): void {
    clearInterval(this.#sweepTimer);
    this.pollers.stopAll();
    for (const entry of this.#engines.values()) entry.engine.dispose();
    this.#engines.clear();
  }

  dispose(reviewId: string): void {
    forgetPins(reviewId);
    const entry = this.#engines.get(reviewId);
    if (entry === undefined) return;
    entry.engine.dispose();
    this.#engines.delete(reviewId);
  }
}
