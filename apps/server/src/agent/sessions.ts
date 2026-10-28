/**
 * Agent sessions: one per thread, so a follow-up resumes the conversation
 * (and what the agent already read) instead of starting over, and a run cut
 * off by a restart picks up where it stopped.
 *
 * Transcripts live under `data/sessions/<review>/`, one JSONL file per
 * session, through the SDK's `sessionStore`: every entry is mirrored there
 * as the run goes, and a resume loads the session back from it. The CLI
 * still writes its own copy under its config dir while a run is going;
 * `removeLocalTranscript` deletes exactly that file afterwards. The config
 * dir itself is left alone, since that is where the user's login lives:
 * pointing it into `data/` would hide a subscription login from the agent,
 * and copying the OAuth credentials across would race the user's own
 * Claude Code on token refresh.
 *
 * A review's sessions last until it is archived or deleted
 * (`deleteReviewSessions`), or the settings page clears them all
 * (`deleteAllSessions`): like agent worktrees they are a cache, and a
 * thread whose session is gone just starts a fresh one. A run that resumes
 * one is told when the code changed since its last turn (`codeKey`), so it
 * re-reads instead of answering from stale reads.
 */
import type { SDKMessage, SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { FileEntry } from '@joinery/core';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clearAllSessions, clearReviewSessions, setRunResumeCursor, setRunSessionId, type Db, type ResumeCursor } from '../db/index.ts';
import { resolveDataPaths } from '../db/paths.ts';

/** Every review's transcripts, one dir per review. */
export function sessionsDir(): string {
  return join(resolveDataPaths().root, 'sessions');
}

function reviewSessionsDir(reviewId: string): string {
  return join(sessionsDir(), reviewId);
}

/** Session ids are UUIDs and subpaths SDK-chosen names; neither may climb out of the review's dir. */
function safeName(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) throw new Error(`unexpected session file name: ${name}`);
  return name;
}

function transcriptFile(reviewId: string, key: Pick<SessionKey, 'sessionId' | 'subpath'>): string {
  const base = join(reviewSessionsDir(reviewId), safeName(key.sessionId));
  return key.subpath === undefined ? `${base}.jsonl` : join(base, `${key.subpath.split('/').map(safeName).join('__')}.jsonl`);
}

/**
 * The `sessionStore` for one review's runs. Keyed by session id alone, not
 * the SDK's cwd-derived `projectKey`: a thread's runs can read from
 * different worktrees as the branch moves, and must find the same session.
 */
export function createSessionStore(reviewId: string): SessionStore {
  // `sessionStoreFlush: 'eager'` (set where the store is used) hands each
  // entry over as it is written, so a crash loses next to nothing.
  return {
    async append(key, entries) {
      const file = transcriptFile(reviewId, key);
      await mkdir(join(file, '..'), { recursive: true });
      await appendFile(file, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
    },
    async load(key) {
      let text: string;
      try {
        text = await readFile(transcriptFile(reviewId, key), 'utf8');
      } catch {
        return null;
      }
      // An append retried after a timeout can land twice; `uuid` is the idempotency key.
      const seen = new Set<string>();
      const entries: SessionStoreEntry[] = [];
      for (const line of text.split('\n')) {
        if (line === '') continue;
        const entry = JSON.parse(line) as SessionStoreEntry;
        if (entry.uuid !== undefined) {
          if (seen.has(entry.uuid)) continue;
          seen.add(entry.uuid);
        }
        entries.push(entry);
      }
      return entries;
    },
    async delete(key) {
      await rm(transcriptFile(reviewId, key), { force: true });
    },
  };
}

/** Deletes a review's sessions (on archive or delete); its threads start fresh if it comes back. */
export async function deleteReviewSessions(db: Db, reviewId: string): Promise<void> {
  const sessionIds = await clearReviewSessions(db, reviewId);
  await rm(reviewSessionsDir(reviewId), { recursive: true, force: true });
  for (const id of sessionIds) await removeLocalTranscript(id);
}

/** Deletes every review's sessions (settings' data cleanup); returns how many. Threads start fresh afterwards. */
export async function deleteAllSessions(db: Db): Promise<number> {
  const count = (await listSessionFiles()).length;
  await clearAllSessions(db);
  await rm(sessionsDir(), { recursive: true, force: true });
  return count;
}

/** The transcripts on disk, laid out `<review>/<session>.jsonl`. */
export async function listSessionFiles(): Promise<string[]> {
  const list = (path: string): Promise<string[]> => readdir(path).catch(() => [] as string[]);
  const reviews = await list(sessionsDir());
  const nested = await Promise.all(
    reviews.map(async (review) => (await list(join(sessionsDir(), review))).filter((name) => name.endsWith('.jsonl'))),
  );
  return nested.flat();
}

/**
 * Deletes the CLI's own copy of one of our sessions: `<id>.jsonl` and its
 * `<id>/` subagent dir under each project dir of its config dir. Only these
 * exact names, which only our runs created; nothing else there is touched.
 */
export async function removeLocalTranscript(sessionId: string): Promise<void> {
  const projects = join(process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'projects');
  let dirs: string[];
  try {
    dirs = await readdir(projects);
  } catch {
    return;
  }
  const name = safeName(sessionId);
  for (const dir of dirs) {
    await rm(join(projects, dir, `${name}.jsonl`), { force: true });
    await rm(join(projects, dir, name), { recursive: true, force: true });
  }
}

/** What the agent read is valid while this is unchanged: the head and every changed file's blob. */
export function codeKey(headSha: string, files: readonly FileEntry[]): string {
  const hash = createHash('sha1').update(headSha);
  for (const f of files) hash.update(`\n${f.path}\0${f.newBlob}`);
  return hash.digest('hex');
}

/** Told to a resumed session whose code moved since its last turn. */
export function codeMovedNote(previous: ResumeCursor | null, headSha: string, key: string): string | null {
  if (previous?.codeKey === undefined || previous.codeKey === key) return null;
  const how =
    previous.headSha !== undefined && previous.headSha !== headSha
      ? `The branch moved from ${previous.headSha.slice(0, 10)} to ${headSha.slice(0, 10)}`
      : 'The working tree changed';
  return `${how} since your last turn. What you read before may be stale: re-read any file before relying on it.`;
}

/**
 * Follows a run's messages to keep its row resumable: the session id from
 * `init`, the code the run reads, and its turn count.
 */
export class SessionTracker {
  readonly #db: Db;
  readonly #runId: string;
  readonly #code: { readonly key: string; readonly headSha: string };
  #sessionId: string | null = null;
  #turns = 0;

  constructor(db: Db, runId: string, code: { readonly key: string; readonly headSha: string }) {
    this.#db = db;
    this.#runId = runId;
    this.#code = code;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  async observe(message: SDKMessage): Promise<void> {
    if (message.type === 'system' && message.subtype === 'init' && this.#sessionId !== message.session_id) {
      this.#sessionId = message.session_id;
      await setRunSessionId(this.#db, this.#runId, message.session_id);
    } else if (message.type === 'assistant') {
      this.#turns++;
    } else {
      return;
    }
    await setRunResumeCursor(this.#db, this.#runId, {
      resume: true,
      // Read from the store at resume time (`safeResumePoint`): only it knows what was saved.
      resumeSessionAt: null,
      turnCount: this.#turns,
      codeKey: this.#code.key,
      headSha: this.#code.headSha,
    });
  }
}

/**
 * The last message of a stored session a resume can restart from: one that
 * leaves no tool call waiting for its result, so a restart never resumes
 * into a half-finished tool call. Read from the store rather than recorded
 * as the run went, since a crash can cut the mirror short of the run.
 * Null when there is no such point (nothing usable was saved).
 */
export async function safeResumePoint(reviewId: string, sessionId: string): Promise<string | null> {
  const entries = await createSessionStore(reviewId).load({ projectKey: '', sessionId });
  if (entries === null) return null;
  const open = new Set<string>();
  let point: string | null = null;
  for (const entry of entries) {
    if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.uuid === undefined) continue;
    const content = (entry as { message?: { content?: unknown } }).message?.content;
    for (const block of Array.isArray(content) ? (content as { type?: string; id?: string; tool_use_id?: string }[]) : []) {
      if (block.type === 'tool_use' && block.id !== undefined) open.add(block.id);
      if (block.type === 'tool_result' && block.tool_use_id !== undefined) open.delete(block.tool_use_id);
    }
    if (open.size === 0) point = entry.uuid;
  }
  return point;
}

/** The SDK's error for a session it can't find (e.g. deleted with an archived review). */
export function isMissingSession(err: unknown): boolean {
  return err instanceof Error && err.message.includes('No conversation found');
}
