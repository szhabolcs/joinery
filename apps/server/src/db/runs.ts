/**
 * `agent_run` + `agent_event`. Every SDK message is persisted with a
 * `seq` monotonic per run, so the work-in-progress UI is replayable and
 * survives a reload or restart.
 */
import { agentEvent, agentRun } from '@joinery/core/db';
import type { AgentRun, RunKind, RunStatus } from '@joinery/core';
import { runId as newRunId, runKindSchema, runStatusSchema } from '@joinery/core';
import { and, asc, desc, eq, inArray, isNotNull, max, ne, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { narrowUnion } from './narrow.ts';

function toAgentRun(row: typeof agentRun.$inferSelect): AgentRun {
  return {
    id: row.id,
    reviewId: row.reviewId,
    threadId: row.threadId,
    kind: narrowUnion(row.kind, runKindSchema.options, 'agent_run.kind'),
    status: narrowUnion(row.status, runStatusSchema.options, 'agent_run.status'),
    sessionId: row.sessionId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    error: row.error,
  };
}

/**
 * Where a run's session can be resumed from, persisted as JSON: the last
 * message uuid it is safe to resume at, and the code the run was reading
 * (`codeKey`, `headSha`), so a resume can tell the agent when that moved.
 */
export type ResumeCursor = {
  readonly resume: boolean;
  readonly resumeSessionAt: string | null;
  readonly turnCount: number;
  readonly codeKey?: string;
  readonly headSha?: string;
};

export type CreateRunInput = {
  readonly reviewId: string;
  readonly threadId?: string | null;
  readonly kind: RunKind;
};

export async function createRun(db: Db, input: CreateRunInput): Promise<AgentRun> {
  const rows = await db
    .insert(agentRun)
    .values({ id: newRunId(), reviewId: input.reviewId, threadId: input.threadId ?? null, kind: input.kind })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error('createRun: insert returned no row');
  return toAgentRun(row);
}

/** Runs still `pending` or `running` — at boot, necessarily orphans of a previous process. */
export async function listUnfinishedRuns(db: Db): Promise<AgentRun[]> {
  const rows = await db.select().from(agentRun).where(inArray(agentRun.status, ['pending', 'running']));
  return rows.map(toAgentRun);
}

/** The newest `pending`/`running` run of `kind` for a review, or null. */
export async function getActiveRun(db: Db, reviewId: string, kind: RunKind): Promise<AgentRun | null> {
  const rows = await db
    .select()
    .from(agentRun)
    .where(
      and(eq(agentRun.reviewId, reviewId), eq(agentRun.kind, kind), inArray(agentRun.status, ['pending', 'running'])),
    )
    .orderBy(desc(agentRun.startedAt))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toAgentRun(row);
}

export async function getRun(db: Db, id: string): Promise<AgentRun | null> {
  const rows = await db.select().from(agentRun).where(eq(agentRun.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toAgentRun(row);
}

/** The raw `resume_cursor` JSON for `id`, parsed, or `null` if unset. */
export async function getResumeCursor(db: Db, id: string): Promise<ResumeCursor | null> {
  const rows = await db.select({ resumeCursor: agentRun.resumeCursor }).from(agentRun).where(eq(agentRun.id, id)).limit(1);
  const row = rows[0];
  if (row === undefined || row.resumeCursor === null) return null;
  return JSON.parse(row.resumeCursor) as ResumeCursor;
}

async function update(db: Db, id: string, set: Partial<typeof agentRun.$inferInsert>): Promise<AgentRun> {
  const rows = await db.update(agentRun).set(set).where(eq(agentRun.id, id)).returning();
  const row = rows[0];
  if (row === undefined) throw new Error(`agent_run ${id} not found`);
  return toAgentRun(row);
}

export async function setRunStatus(db: Db, id: string, status: RunStatus): Promise<AgentRun> {
  const set: Partial<typeof agentRun.$inferInsert> = { status };
  if (status === 'done' || status === 'error' || status === 'cancelled') {
    set.endedAt = Math.floor(Date.now() / 1000);
  }
  return update(db, id, set);
}

export async function setRunSessionId(db: Db, id: string, sessionId: string | null): Promise<AgentRun> {
  return update(db, id, { sessionId });
}

export async function setRunResumeCursor(db: Db, id: string, cursor: ResumeCursor | null): Promise<AgentRun> {
  return update(db, id, { resumeCursor: cursor === null ? null : JSON.stringify(cursor) });
}

/** The newest run of a thread that has a session, other than `exceptRunId`: what a follow-up resumes. */
export async function getLatestThreadSession(
  db: Db,
  threadId: string,
  exceptRunId: string,
): Promise<{ sessionId: string; cursor: ResumeCursor | null } | null> {
  const rows = await db
    .select({ id: agentRun.id, sessionId: agentRun.sessionId, resumeCursor: agentRun.resumeCursor })
    .from(agentRun)
    .where(and(eq(agentRun.threadId, threadId), isNotNull(agentRun.sessionId), ne(agentRun.id, exceptRunId)))
    .orderBy(desc(agentRun.startedAt), desc(sql`rowid`))
    .limit(1);
  const row = rows[0];
  if (row?.sessionId == null) return null;
  return { sessionId: row.sessionId, cursor: row.resumeCursor === null ? null : (JSON.parse(row.resumeCursor) as ResumeCursor) };
}

/** Forgets every session of a review's runs (their transcripts are being deleted); returns their ids. */
export async function clearReviewSessions(db: Db, reviewId: string): Promise<string[]> {
  const rows = await db
    .update(agentRun)
    .set({ sessionId: null, resumeCursor: null })
    .where(and(eq(agentRun.reviewId, reviewId), isNotNull(agentRun.sessionId)))
    .returning({ sessionId: agentRun.sessionId });
  return [...new Set(rows.map((r) => r.sessionId).filter((id): id is string => id !== null))];
}

/** Forgets every run's session (all transcripts are being deleted). */
export async function clearAllSessions(db: Db): Promise<void> {
  await db.update(agentRun).set({ sessionId: null, resumeCursor: null }).where(isNotNull(agentRun.sessionId));
}

export async function setRunError(db: Db, id: string, error: string | null): Promise<AgentRun> {
  return update(db, id, { error });
}

export type AgentEventRecord = {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: number;
};

/** Append an event to `runId`, assigning the next monotonic `seq` atomically. */
export async function appendEvent(db: Db, runId: string, type: string, payload: unknown): Promise<AgentEventRecord> {
  return db.transaction((tx) => {
    const maxSeqRows = tx
      .select({ maxSeq: max(agentEvent.seq) })
      .from(agentEvent)
      .where(eq(agentEvent.runId, runId))
      .all();
    const seq = (maxSeqRows[0]?.maxSeq ?? -1) + 1;

    const rows = tx
      .insert(agentEvent)
      .values({ runId, seq, type, payload: JSON.stringify(payload) })
      .returning()
      .all();
    const row = rows[0];
    if (row === undefined) throw new Error('appendEvent: insert returned no row');

    return { seq: row.seq, type: row.type, payload: JSON.parse(row.payload) as unknown, createdAt: row.createdAt };
  });
}

/** Read a run's events back in order, for replay. */
export async function listEvents(db: Db, runId: string): Promise<AgentEventRecord[]> {
  const rows = await db.select().from(agentEvent).where(eq(agentEvent.runId, runId)).orderBy(asc(agentEvent.seq));
  return rows.map((row) => ({
    seq: row.seq,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.createdAt,
  }));
}
