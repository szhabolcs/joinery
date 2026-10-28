/**
 * The `thread_reply` run kind.
 * Like `readingOrder.ts`, every SDK message is persisted via `appendEvent`.
 * Unlike it, a run resumes its thread's session (`sessions.ts`), so a
 * follow-up keeps what the agent already read. The agent acts through the
 * `joinery` MCP tools (`tools.ts`), and the "reply" it's asked for is a
 * trigger, not a contract (design
 * decision 4): if it ends having written nothing, the caller (`runs.ts`)
 * appends a fallback reply so the click that started it never vanishes
 * silently.
 */
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentModel, Review, ServerEvent, Thread } from '@joinery/core';
import { isAbsolute, relative } from 'node:path';
import { claudeExecutableOption } from './claudeExecutable.ts';
import { AGENT_MODEL_ID } from './model.ts';
import { makeAgentCanUseTool } from './permissions.ts';
import { gitToolDefinitions } from './gitTools.ts';
import { createReviewTools, trimToLines, type Invoke } from './tools.ts';
import { AGENT_SYSTEM_APPEND, buildPrompt, buildReviewContext, loadReviewContext } from './reviewContext.ts';
import {
  codeKey,
  codeMovedNote,
  createSessionStore,
  isMissingSession,
  removeLocalTranscript,
  safeResumePoint,
  SessionTracker,
} from './sessions.ts';
import { resolveRunCwd, type EngineForCwd } from './worktree.ts';
import { appendEvent, getLatestThreadSession, type Db, type ResumeCursor } from '../db/index.ts';

export type ThreadReplyDeps = {
  readonly db: Db;
  readonly invoke: Invoke;
  readonly emit: (event: ServerEvent) => void;
};

type DiffResponse = { patch: { patch: string } };

async function fetchJson<T>(invoke: Invoke, method: string, path: string): Promise<T> {
  const res = await invoke(method, path);
  if (!res.ok) throw new Error(`${method} ${path} failed (${String(res.status)}): ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * The run's task, after the shared review context: what to do, then the
 * thread rendered as `author: body` in order, its anchor
 * (`path:startLine-endLine` plus the captured context), and the diff for
 * that path trimmed to 200 lines. Exported (and kept free of any SDK call)
 * so its shape is inspectable without spawning a subprocess.
 */
export function buildThreadReplyTask(input: { thread: Thread; diffText: string }): string {
  const { thread, diffText } = input;
  const threadBody = thread.comments.map((c) => `${c.author}: ${c.body}`).join('\n\n');
  return [
    '# Your task',
    '',
    'Answer the latest user message in the thread below by calling `reply`',
    "with that thread's id (given in the thread header). Don't resolve a",
    'thread unless the user explicitly asked you to. Prefer `react` over a',
    'reply for a plain acknowledgement. You may use every joinery tool:',
    'reply, react, create_thread, resolve_thread, mark_viewed,',
    'set_reading_order, set_review_status.',
    '',
    `Thread ${thread.id} on ${thread.path}:${String(thread.startLine)}-${String(thread.endLine)} (${thread.side} side):`,
    '',
    threadBody,
    '',
    'Anchor context (the lines the thread is attached to, captured when it was created):',
    thread.anchorContext,
    '',
    `Diff for ${thread.path}:`,
    diffText,
  ].join('\n');
}

/**
 * The prompt for a run that resumes the thread's session: only what is new
 * since the agent's last turn (the conversation already holds the review
 * and the thread so far), and a note when the code moved in between.
 */
export function buildFollowUpTask(input: { thread: Thread; codeNote: string | null; restarted: boolean }): string {
  const { thread, codeNote, restarted } = input;
  const lastAgent = thread.comments.findLastIndex((c) => c.author === 'agent');
  const fresh = thread.comments.slice(lastAgent + 1);
  // Listed after a restart too: the crash may have cut the session short of them.
  const lines = [
    ...(restarted ? ['The server restarted while you were answering. Pick up where you left off.', ''] : []),
    `New in thread ${thread.id} since your last turn:`,
    '',
    ...fresh.map((c) => `${c.author}: ${c.body}`),
  ];
  if (codeNote !== null) lines.push('', codeNote);
  lines.push(
    '',
    `Answer the latest user message by calling \`reply\` with thread id ${thread.id}.${restarted ? ' If you already replied to it, end your turn.' : ''}`,
  );
  return lines.join('\n');
}

/** Where a run resumes a session from, or null for a fresh one. */
export type ThreadSessionStart = {
  readonly sessionId: string;
  readonly cursor: ResumeCursor | null;
  /** Resuming this same run after a restart, rather than a follow-up from an earlier one. */
  readonly restarted: boolean;
} | null;

/**
 * Runs the agent for one `thread_reply` run and resolves once the agent
 * has finished (or rejects if it failed). It never touches the run row's
 * status: `runs.ts` owns creating and ending the run, and emits `run.ended`.
 *
 * It resumes the thread's session when there is one (`start`, else the
 * thread's latest run), and starts fresh when there is none or it is gone.
 */
export async function runThreadReplyAgent(
  deps: ThreadReplyDeps,
  runId: string,
  review: Review,
  thread: Thread,
  engine: EngineForCwd,
  abortController: AbortController,
  model: AgentModel = AGENT_MODEL_ID,
  start?: ThreadSessionStart,
): Promise<void> {
  const cwd = await resolveRunCwd({ db: deps.db }, review, engine);
  const list = engine.getFileList();
  const code = { key: codeKey(list.headSha, list.files), headSha: list.headSha };
  const from =
    start !== undefined
      ? start
      : await getLatestThreadSession(deps.db, thread.id, runId).then((s) => (s === null ? null : { ...s, restarted: false }));

  const tools = createReviewTools({ invoke: deps.invoke, reviewId: review.id, runId, extraTools: gitToolDefinitions({ cwd }) });
  const tracker = new SessionTracker(deps.db, runId, code);

  // Text of the latest assistant message: if the agent ends without having
  // written anything (e.g. it answered as plain final text), that is the
  // best candidate for the reply.
  let lastText = '';
  const runOnce = async (prompt: string, resume: { sessionId: string; at: string } | null): Promise<void> => {
    const stream = query({
      prompt,
      options: {
        ...claudeExecutableOption(),
        abortController,
        cwd,
        model,
        disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash'],
        canUseTool: makeAgentCanUseTool({ cwd }),
        mcpServers: { joinery: tools.server },
        settingSources: [],
        // The transcript goes to `data/sessions/` (`sessions.ts`); no generated title.
        sessionStore: createSessionStore(review.id),
        sessionStoreFlush: 'eager',
        ...(resume === null ? {} : { resume: resume.sessionId, resumeSessionAt: resume.at }),
        title: 'Joinery: thread reply',
        systemPrompt: { type: 'preset', preset: 'claude_code', append: AGENT_SYSTEM_APPEND },
        maxTurns: 40,
      },
    });
    for await (const message of stream as AsyncIterable<SDKMessage>) {
      for (const label of toolActivityLabels(message, cwd)) {
        deps.emit({ type: 'run.activity', reviewId: review.id, runId, label });
      }
      if (message.type === 'assistant') lastText = assistantText(message);
      await tracker.observe(message);
      await appendEvent(deps.db, runId, message.type, message);
    }
  };

  try {
    let resumed = false;
    // At the session's last safe point: the end of a finished run, or short
    // of a tool call a crash or a cancel left waiting. Nothing saved: fresh.
    const at = from === null ? null : await safeResumePoint(review.id, from.sessionId);
    if (from !== null && at !== null) {
      const task = buildFollowUpTask({ thread, codeNote: codeMovedNote(from.cursor, code.headSha, code.key), restarted: from.restarted });
      try {
        await runOnce(task, { sessionId: from.sessionId, at });
        resumed = true;
      } catch (err) {
        // The session is gone (its review was archived and reopened): start over.
        if (!isMissingSession(err) || abortController.signal.aborted) throw err;
      }
    }
    if (!resumed) {
      const [contextInput, { patch }] = await Promise.all([
        loadReviewContext(deps.db, review, list.files),
        fetchJson<DiffResponse>(deps.invoke, 'GET', `/api/reviews/${encodeURIComponent(review.id)}/diff?path=${encodeURIComponent(thread.path)}`),
      ]);
      await runOnce(buildPrompt(buildReviewContext(contextInput), buildThreadReplyTask({ thread, diffText: trimToLines(patch.patch, 200) })), null);
    }
  } finally {
    if (tracker.sessionId !== null) await removeLocalTranscript(tracker.sessionId);
  }

  if (!abortController.signal.aborted && !tools.wasWritten()) {
    await deps.invoke('POST', `/api/threads/${encodeURIComponent(thread.id)}/replies`, {
      body: lastText !== '' ? lastText : 'Looked at this and had nothing to add.',
      author: 'agent',
      agentRunId: runId,
    });
  }
}

/** Concatenated text blocks of a complete assistant message, trimmed ('' for a tool-only message). */
function assistantText(message: SDKMessage): string {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return '';
  return (content as { type?: string; text?: unknown }[])
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim();
}

/** Short labels ("Reading `src/foo.ts`") for each tool call in a complete assistant message. */
function toolActivityLabels(message: SDKMessage, cwd: string): string[] {
  if (message.type !== 'assistant') return [];
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const labels: string[] = [];
  for (const block of content as { type?: string; name?: string; input?: unknown }[]) {
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      labels.push(describeToolUse(block.name, (block.input ?? {}) as Record<string, unknown>, cwd));
    }
  }
  return labels;
}

function describeToolUse(name: string, input: Record<string, unknown>, cwd: string): string {
  const str = (key: string): string | null => (typeof input[key] === 'string' && input[key] !== '' ? (input[key] as string) : null);
  const rel = (path: string): string => {
    const r = relative(cwd, path);
    return r !== '' && !r.startsWith('..') && !isAbsolute(r) ? r : path;
  };
  switch (name) {
    case 'Read': {
      const path = str('file_path');
      return path === null ? 'Reading' : `Reading \`${rel(path)}\``;
    }
    case 'Grep': {
      const pattern = str('pattern');
      return pattern === null ? 'Searching' : `Searching for \`${pattern}\``;
    }
    case 'Glob': {
      const pattern = str('pattern');
      return pattern === null ? 'Listing files' : `Listing \`${pattern}\``;
    }
    case 'mcp__joinery__reply':
      return 'Writing reply';
    default:
      return name.startsWith('mcp__joinery__git_') ? 'Checking git history' : name;
  }
}
