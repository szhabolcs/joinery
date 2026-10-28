/**
 * Reading-order generation (the `reading_order` run kind): one `query()`
 * (resumed once more if a restart cuts it off) whose agent explores the review root with read-only, path-fenced tools
 * (`permissions.ts`'s `makeAgentCanUseTool`, no shell) and hands its plan
 * to the `set_reading_order` tool.
 *
 * The plan goes through a tool rather than `outputFormat` structured output
 * so this run is offered exactly the tools a thread reply is: structured
 * output adds a tool of its own, and a different tool list shares no cached
 * prefix (see `reviewContext.ts`). The tool call is collected here, not
 * written, and the plan is still `readingOrderPlanSchema.parse()`d before
 * `runs.ts` persists it.
 */
import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { READING_ORDER_RULES, readingOrderPlanSchema, type AgentModel, type ReadingOrderPlan } from '@joinery/core';
import { claudeExecutableOption } from './claudeExecutable.ts';
import { gitToolDefinitions } from './gitTools.ts';
import { makeAgentCanUseTool } from './permissions.ts';
import { AGENT_SYSTEM_APPEND, buildPrompt } from './reviewContext.ts';
import {
  codeMovedNote,
  createSessionStore,
  isMissingSession,
  removeLocalTranscript,
  safeResumePoint,
  SessionTracker,
} from './sessions.ts';
import { createReviewTools, type Invoke } from './tools.ts';
import type { Db, ResumeCursor } from '../db/index.ts';

/** What a reading-order run may call: the reads, the git tools, and `set_reading_order` to submit. */
const READING_ORDER_TOOLS: ReadonlySet<string> = new Set([
  'get_review',
  'list_files',
  'get_diff',
  'get_file',
  'get_reading_order',
  'list_threads',
  'get_thread',
  'git_log',
  'git_show',
  'git_blame',
  'set_reading_order',
]);

/** The run's task, after the shared review context (which lists the changed files). */
export function buildReadingOrderTask(): string {
  return [
    '# Your task',
    '',
    'Write a reading order for this change: a short series of steps a reviewer',
    'reads in order, explaining what each part does and how it fits together.',
    '',
    '1. Read each changed file in the review root (Read, Grep, Glob). Use the',
    '   git tools (git_log, git_show, git_blame) when history explains a change.',
    '   Read surrounding code too where it explains what the change builds on.',
    '   Done when you can say in one sentence what every file adds or changes',
    '   and which part is the heart of the change.',
    '2. Group the files into steps following the rules below. Done when every',
    '   changed file sits in exactly one step, under its exact path.',
    '3. Order the steps and write each one following the rules below.',
    '',
    'Rules:',
    READING_ORDER_RULES,
    '',
    'Respond only with structured output: call set_reading_order once with the',
    'whole plan. No other joinery tool is available to you in this task.',
  ].join('\n');
}

export type GenerateReadingOrderPlanOptions = {
  readonly db: Db;
  readonly cwd: string;
  /** `buildReviewContext`'s text: the same bytes every run of the review starts with. */
  readonly context: string;
  readonly invoke: Invoke;
  readonly reviewId: string;
  readonly runId: string;
  /** Claude Code's own default model when absent. */
  readonly model?: AgentModel;
  /** Aborting it stops the agent; the stream then ends or throws. */
  readonly abortController?: AbortController;
  /** Called with every SDK message as it streams in, for event logging. */
  readonly onMessage?: (message: unknown) => void | Promise<void>;
  /** The code the run reads (`sessions.ts`'s `codeKey`), recorded so a resume can tell when it moved. */
  readonly code: { readonly key: string; readonly headSha: string };
  /** This same run's session, to resume after a restart cut it off; a fresh session when absent. */
  readonly restart?: { readonly sessionId: string; readonly cursor: ResumeCursor | null };
};

export class ReadingOrderAgentError extends Error {}

/**
 * Runs the agent and returns a validated `ReadingOrderPlan`. Throws
 * `ReadingOrderAgentError` on any failure (turn ended in error, no plan
 * submitted) — the caller (`runs.ts`) is responsible for recording that as
 * the run's error.
 */
export async function generateReadingOrderPlan(options: GenerateReadingOrderPlanOptions): Promise<ReadingOrderPlan> {
  let executable: ReturnType<typeof claudeExecutableOption>;
  try {
    executable = claudeExecutableOption();
  } catch (err) {
    throw new ReadingOrderAgentError(err instanceof Error ? err.message : String(err));
  }

  let plan: ReadingOrderPlan | undefined;
  const tools = createReviewTools({
    invoke: options.invoke,
    reviewId: options.reviewId,
    runId: options.runId,
    extraTools: gitToolDefinitions({ cwd: options.cwd }),
    onSetReadingOrder: async (submitted) => {
      const parsed = readingOrderPlanSchema.safeParse(submitted);
      if (!parsed.success) return `Not saved, the plan is malformed: ${parsed.error.message}`;
      plan = parsed.data;
      return 'Saved. Your task is done.';
    },
  });

  const tracker = new SessionTracker(options.db, options.runId, options.code);
  const runOnce = async (prompt: string, resume: { sessionId: string; at: string } | null): Promise<SDKResultMessage | undefined> => {
    const stream = query({
      prompt,
      options: {
        ...executable,
        ...(options.abortController === undefined ? {} : { abortController: options.abortController }),
        cwd: options.cwd,
        ...(options.model === undefined ? {} : { model: options.model }),
        mcpServers: { joinery: tools.server },
        // `Bash` is removed outright rather than gated through a read-only
        // allowlist: no shell at all for the embedded agent, on either run kind.
        disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash'],
        canUseTool: makeAgentCanUseTool({ cwd: options.cwd, joineryTools: READING_ORDER_TOOLS }),
        // Refuses to load the reviewed repo's own `.claude/settings*.json` —
        // reviewing a branch that adds a permissive `allow` rule there must
        // not be able to reopen tool access this run intentionally removed.
        settingSources: [],
        // Kept in `data/sessions/` (`sessions.ts`) so a restart can resume
        // the run; regenerating starts a fresh session. No generated title.
        sessionStore: createSessionStore(options.reviewId),
        sessionStoreFlush: 'eager',
        ...(resume === null ? {} : { resume: resume.sessionId, resumeSessionAt: resume.at }),
        title: 'Joinery: reading order',
        systemPrompt: { type: 'preset', preset: 'claude_code', append: AGENT_SYSTEM_APPEND },
      },
    });
    let last: SDKResultMessage | undefined;
    for await (const message of stream as AsyncIterable<SDKMessage>) {
      await tracker.observe(message);
      await options.onMessage?.(message);
      if (message.type === 'result') last = message;
    }
    return last;
  };

  let result: SDKResultMessage | undefined;
  try {
    // After a restart, resume at the session's last safe point; with none
    // saved (or the session gone), the run starts over.
    const { restart } = options;
    const at = restart === undefined ? null : await safeResumePoint(options.reviewId, restart.sessionId);
    let resumed = false;
    if (restart !== undefined && at !== null) {
      const codeNote = codeMovedNote(restart.cursor, options.code.headSha, options.code.key);
      const prompt = [
        'The server restarted while you were writing the reading order. Pick up where you left off.',
        ...(codeNote === null ? [] : [codeNote]),
        'Then call set_reading_order once with the whole plan.',
      ].join('\n\n');
      try {
        result = await runOnce(prompt, { sessionId: restart.sessionId, at });
        resumed = true;
      } catch (err) {
        if (!isMissingSession(err) || options.abortController?.signal.aborted === true) throw err;
      }
    }
    if (!resumed) result = await runOnce(buildPrompt(options.context, buildReadingOrderTask()), null);
  } finally {
    if (tracker.sessionId !== null) await removeLocalTranscript(tracker.sessionId);
  }

  if (result === undefined) {
    throw new ReadingOrderAgentError('agent run ended without a result message');
  }
  if (result.subtype !== 'success' || result.is_error) {
    throw new ReadingOrderAgentError(`agent run did not complete successfully (${result.subtype})`);
  }
  if (plan === undefined) {
    throw new ReadingOrderAgentError('agent run ended without submitting a reading order');
  }
  return plan;
}
