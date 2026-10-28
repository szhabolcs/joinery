/**
 * Agent runs. `generateReadingOrder` is the `reading_order` run
 * kind: it drives `@anthropic-ai/claude-agent-sdk` end to end (prompt,
 * read-only tool gating, structured output, schema validation) and persists
 * the result through the same `writeReadingOrderPlan` code path the CLI's
 * `joinery reading-order set --file plan.json` uses.
 * See `agent/readingOrder.ts` for the agent side; the full session machinery
 * is deliberately not implemented there.
 *
 * `requestThreadReply` is the `thread_reply` run kind: create the run, put an
 * `eyes` reaction (as the agent) on
 * the thread's latest user comment as a working indicator, run the agent
 * (`threadReply.ts`) against the `joinery` MCP tools, then remove the `eyes`
 * reaction and close out the run — on success or on error either way, so a
 * run never leaves a stray `eyes` reaction behind.
 *
 * Both run kinds return their `running` run as soon as it's recorded; the
 * agent itself runs in the background and reports back through `run.*`
 * events, so no HTTP request is held open for the length of an agent run.
 */
import { agentModelSchema, type AgentModel, type AgentRun, type FileEntry, type Review, type ServerEvent } from '@joinery/core';
import {
  appendEvent,
  createRun,
  getResumeCursor,
  getReview,
  getRun,
  getThreadWithComments,
  listEvents,
  listUnfinishedRuns,
  setRunError,
  setRunStatus,
  writeReadingOrderPlan,
  type Db,
  type ResumeCursor,
} from '../db/index.ts';
import { generateReadingOrderPlan, ReadingOrderAgentError } from './readingOrder.ts';
import { buildReviewContext, loadReviewContext } from './reviewContext.ts';
import { codeKey } from './sessions.ts';
import { runThreadReplyAgent, type ThreadSessionStart } from './threadReply.ts';
import type { Invoke } from './tools.ts';
import { resolveRunCwd, type EngineForCwd } from './worktree.ts';

/** Live runs by id: the controller that aborts the agent, and a promise that settles once the run row is closed out. */
const activeRuns = new Map<string, { controller: AbortController; ended: Promise<void> }>();

export type RunsDeps = {
  readonly db: Db;
  readonly invoke: Invoke;
  readonly emit: (event: ServerEvent) => void;
};

/** What `generateReadingOrder` needs from the review's engine (`cwd` = the review root). */
export type ReadingOrderContext = {
  readonly cwd: string;
  readonly review: Review;
  readonly files: readonly FileEntry[];
  /** The head the files are at, recorded so a resumed run can tell whether the code moved. */
  readonly headSha: string;
  /** The model for the run; Claude Code's own default when absent. */
  readonly model?: AgentModel;
};

/**
 * `POST /api/reviews/:id/reading-order/generate`. Creates a
 * `reading_order` run, marks it `running`, and returns it straight away;
 * the agent itself runs in the background (see `runInBackground`). It
 * explores `context.cwd` with `context.files` as the changed-file list, the
 * plan it submits is validated against `readingOrderPlanSchema`, and the
 * plan is persisted via `writeReadingOrderPlan` (the same path
 * `joinery reading-order set` uses). Completion is reported through
 * `reading_order.updated` and `run.ended`; on any failure the run is marked
 * `error` with a real message.
 */
export async function generateReadingOrder(deps: RunsDeps, reviewId: string, context: ReadingOrderContext): Promise<AgentRun> {
  const created = await createRun(deps.db, { reviewId, kind: 'reading_order' });
  deps.emit({ type: 'run.started', reviewId, run: created });
  const run = await setRunStatus(deps.db, created.id, 'running');

  runReadingOrder(deps, run.id, context);
  return run;
}

/** The background half of a reading-order run, fresh or (`restart`) resumed after a restart. */
function runReadingOrder(
  deps: RunsDeps,
  runId: string,
  context: ReadingOrderContext,
  restart?: { readonly sessionId: string; readonly cursor: ResumeCursor | null },
): void {
  const reviewId = context.review.id;
  runInBackground(deps, reviewId, runId, async (signal) => {
    if (context.files.length === 0) {
      throw new ReadingOrderAgentError('review has no changed files to build a reading order from');
    }
    const plan = await generateReadingOrderPlan({
      db: deps.db,
      cwd: context.cwd,
      context: buildReviewContext(await loadReviewContext(deps.db, context.review, context.files)),
      invoke: deps.invoke,
      reviewId,
      runId,
      code: { key: codeKey(context.headSha, context.files), headSha: context.headSha },
      ...(restart === undefined ? {} : { restart }),
      abortController: signal,
      ...(context.model === undefined ? {} : { model: context.model }),
      onMessage: async (message) => {
        const type = typeof (message as { type?: unknown }).type === 'string' ? (message as { type: string }).type : 'unknown';
        await appendEvent(deps.db, runId, type, message);
      },
    });
    signal.signal.throwIfAborted();
    await writeReadingOrderPlan(deps.db, reviewId, plan, runId);
    deps.emit({ type: 'reading_order.updated', reviewId });
  }, {
    describeError: (err) =>
      err instanceof ReadingOrderAgentError || err instanceof Error ? err.message : `reading-order generation failed: ${String(err)}`,
  });
}

/**
 * `POST /api/threads/:id/ask`, and the same trigger `createThread`/
 * `reply` fire with `askAgent: true` — "the latest user message in this
 * thread, in the context of the thread and the review".
 * Returns the `running` run straight away; the agent runs in the
 * background. `engine` is whichever engine the caller already resolved for
 * `review.id` (routes.ts holds one per request); `resolveRunCwd` (via
 * `runThreadReplyAgent`) decides whether that means the attached root or a
 * cached detached worktree.
 *
 * One run per thread at a time: a second ask while one is going gets that
 * run, since two runs resuming one session would fork its conversation.
 * `startingThreads` covers the gap between the check and the new row, so
 * two asks in quick succession can't both start one.
 */
export function requestThreadReply(
  deps: RunsDeps,
  review: Review,
  threadId: string,
  engine: EngineForCwd,
  model?: AgentModel,
): Promise<AgentRun> {
  const starting = startingThreads.get(threadId);
  if (starting !== undefined) return starting;
  const started = startThreadReply(deps, review, threadId, engine, model).finally(() => startingThreads.delete(threadId));
  startingThreads.set(threadId, started);
  return started;
}

/** Thread-reply runs being created, by thread: settles once the run's row says `running`. */
const startingThreads = new Map<string, Promise<AgentRun>>();

async function startThreadReply(
  deps: RunsDeps,
  review: Review,
  threadId: string,
  engine: EngineForCwd,
  model: AgentModel | undefined,
): Promise<AgentRun> {
  const reviewId = review.id;
  const active = (await listUnfinishedRuns(deps.db)).find((r) => r.threadId === threadId);
  if (active !== undefined) return active;
  const created = await createRun(deps.db, { reviewId, threadId, kind: 'thread_reply' });
  deps.emit({ type: 'run.started', reviewId, run: created });
  const run = await setRunStatus(deps.db, created.id, 'running');
  await runThreadReply(deps, run.id, review, threadId, engine, model);
  return run;
}

/** The background half of a thread-reply run, fresh or (`start`) resuming a given session. */
async function runThreadReply(
  deps: RunsDeps,
  runId: string,
  review: Review,
  threadId: string,
  engine: EngineForCwd,
  model: AgentModel | undefined,
  start?: ThreadSessionStart,
): Promise<void> {
  const reviewId = review.id;
  const thread = await getThreadWithComments(deps.db, threadId);
  const latestUserComment = thread === null ? undefined : [...thread.comments].reverse().find((c) => c.author === 'user');
  const setEyes = async (on: boolean): Promise<void> => {
    if (latestUserComment === undefined) return;
    await deps.invoke('POST', `/api/comments/${encodeURIComponent(latestUserComment.id)}/reactions`, {
      kind: 'eyes',
      actor: 'agent',
      on,
    });
  };
  await setEyes(true);

  runInBackground(deps, reviewId, runId, async (signal) => {
    try {
      if (thread === null) throw new Error(`thread ${threadId} not found`);
      await runThreadReplyAgent(deps, runId, review, thread, engine, signal, model, start);
    } catch (err) {
      // A cancel is not a failure: no "Agent run failed" reply.
      if (signal.signal.aborted) throw err;
      const message = err instanceof Error ? err.message : `thread-reply agent run failed: ${String(err)}`;
      await deps.invoke('POST', `/api/threads/${encodeURIComponent(threadId)}/replies`, {
        body: `Agent run failed: ${message}`,
        author: 'agent',
        agentRunId: runId,
      });
      throw err;
    } finally {
      await setEyes(false);
    }
  }, {
    describeError: (err) => (err instanceof Error ? err.message : `thread-reply agent run failed: ${String(err)}`),
  });
}

export type ResumeDeps = Omit<RunsDeps, 'emit'> & {
  readonly dispatch: (reviewId: string, event: ServerEvent) => void;
  /** The review's engine, or null when the review is gone. */
  readonly engineFor: (reviewId: string) => Promise<EngineForCwd | null>;
};

/**
 * At boot: picks up each run the last shutdown cut off, resuming its own
 * session at its cursor (the agent is told when the code moved meanwhile).
 * A run that never got a session, or whose review or thread is gone, is
 * marked `error` as before. Returns how many were resumed.
 */
export async function resumeInterruptedRuns(deps: ResumeDeps): Promise<number> {
  let resumed = 0;
  for (const run of await listUnfinishedRuns(deps.db)) {
    const cursor = await getResumeCursor(deps.db, run.id);
    const review = await getReview(deps.db, run.reviewId);
    const engine = review === null ? null : await deps.engineFor(review.id);
    if (run.sessionId === null || cursor === null || review === null || engine === null) {
      await setRunError(deps.db, run.id, 'The server restarted while this run was in progress.');
      await setRunStatus(deps.db, run.id, 'error');
      continue;
    }
    const start = { sessionId: run.sessionId, cursor };
    const runDeps: RunsDeps = { db: deps.db, invoke: deps.invoke, emit: (event) => deps.dispatch(review.id, event) };
    if (run.kind === 'reading_order') {
      const list = engine.getFileList();
      const cwd = await resolveRunCwd({ db: deps.db }, review, engine);
      runReadingOrder(runDeps, run.id, { cwd, review, files: list.files, headSha: list.headSha, ...modelOf(await listEvents(deps.db, run.id)) }, start);
    } else if (run.threadId !== null) {
      const model = modelOf(await listEvents(deps.db, run.id)).model;
      await runThreadReply(runDeps, run.id, review, run.threadId, engine, model, { ...start, restarted: true });
    }
    resumed++;
  }
  return resumed;
}

/** The model a run was started with, from its `init` message. */
function modelOf(events: readonly { type: string; payload: unknown }[]): { model?: AgentModel } {
  const init = events.find((e) => e.type === 'system' && (e.payload as { subtype?: unknown }).subtype === 'init');
  const model = (init?.payload as { model?: unknown } | undefined)?.model;
  const parsed = agentModelSchema.safeParse(model);
  return parsed.success ? { model: parsed.data } : {};
}

/**
 * `POST /api/runs/:id/cancel`. Aborts the run's agent and waits for the run
 * to be closed out as `cancelled` (`run.ended` is emitted by then). A no-op
 * for a run that already finished; a `running` row with no live agent behind
 * it (an orphan) is closed out directly.
 */
export async function cancelRun(deps: RunsDeps, runId: string): Promise<AgentRun | null> {
  const run = await getRun(deps.db, runId);
  if (run === null) return null;
  if (run.status !== 'pending' && run.status !== 'running') return run;
  const active = activeRuns.get(runId);
  if (active === undefined) {
    const ended = await setRunStatus(deps.db, runId, 'cancelled');
    deps.emit({ type: 'run.ended', reviewId: run.reviewId, run: ended });
    return ended;
  }
  active.controller.abort();
  await active.ended;
  return getRun(deps.db, runId);
}

/**
 * Runs `body` detached from the HTTP request that started the run, then
 * closes the run out as `done` (`cancelled` if `cancelRun` aborted it, `error`
 * with `describeError`'s message otherwise) and emits `run.ended`. Never
 * rejects — a failure here has no caller left to report to, so it lands on
 * the run row and the event stream instead.
 */
function runInBackground(
  deps: RunsDeps,
  reviewId: string,
  runId: string,
  body: (controller: AbortController) => Promise<void>,
  options: { describeError: (err: unknown) => string },
): void {
  const controller = new AbortController();
  const ended = (async () => {
    let status: 'done' | 'error' | 'cancelled' = 'done';
    try {
      await body(controller);
      if (controller.signal.aborted) status = 'cancelled';
    } catch (err) {
      if (controller.signal.aborted) {
        status = 'cancelled';
      } else {
        status = 'error';
        await setRunError(deps.db, runId, options.describeError(err)).catch(() => undefined);
      }
    }
    try {
      const run = await setRunStatus(deps.db, runId, status);
      deps.emit({ type: 'run.ended', reviewId, run });
    } catch (err) {
      console.error(`agent run ${runId}: failed to record its end`, err);
    } finally {
      activeRuns.delete(runId);
    }
  })();
  activeRuns.set(runId, { controller, ended });
}
