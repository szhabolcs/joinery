/**
 * The `joinery` MCP server: every action the embedded agent can take on the
 * app, as a thin
 * wrapper over the same in-process `invoke` the HTTP routes themselves run
 * through (`http/app.ts`'s `createApp().invoke`). A handler never touches
 * the database directly — it builds a `Request`, calls `invoke`, and turns
 * the `Response` into the tool result — so validation, events, and side
 * effects are exactly the HTTP route's, never a second implementation.
 *
 * Every tool is bound to the run's `reviewId`: it is
 * closed over here, never accepted as a tool argument, so the model cannot
 * name a different review. Tools that take a thread or comment id
 * (`get_thread`, `reply`, `resolve_thread`, `react`) additionally verify
 * that thread (or the comment's thread) belongs to this review before
 * calling through, returning a plain error string otherwise rather than a
 * thrown exception — the SDK surfaces tool errors as text back to the model,
 * which is exactly what a misuse like this should get.
 *
 * `wrote` (returned as `wasWritten()`) tracks whether any tool call in this
 * server's lifetime performed a write — `threadReply.ts` uses it to decide
 * whether the run needs its "nothing to add" fallback reply.
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { reactionKindSchema, threadSideSchema, type ReadingOrderPlan } from '@joinery/core';
import { z } from 'zod';

export type Invoke = (method: string, path: string, body?: unknown) => Promise<Response>;

/** Trim `text` to at most `maxLines` lines, appending a note when it was longer. */
export function trimToLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  const shown = lines.slice(0, maxLines).join('\n');
  return `${shown}\n… (truncated: ${String(lines.length - maxLines)} more line(s))`;
}

function textResult(text: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): { content: [{ type: 'text'; text: string }]; isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

/** GET a path through `invoke` and parse its JSON body, for internal ownership checks (never returned to the model as-is). */
async function getJson(invoke: Invoke, path: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await invoke('GET', path);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { ok: res.ok, status: res.status, body };
}

async function bodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export type CreateReviewToolsOptions = {
  readonly invoke: Invoke;
  readonly reviewId: string;
  /** The run posting replies/reactions as `agent` — carried on every reply so it links back to this run. */
  readonly runId: string;
  /** More read-only tools served alongside these, e.g. `gitToolDefinitions`. */
  readonly extraTools?: readonly SdkMcpToolDefinition<any>[];
  /**
   * Takes over `set_reading_order`'s handler: a reading-order run collects
   * the plan instead of writing it straight away. The tool's definition
   * stays the same, so every run kind's prompt still shares one prefix.
   */
  readonly onSetReadingOrder?: (plan: ReadingOrderPlan) => Promise<string>;
};

export type ReviewTools = {
  readonly server: McpSdkServerConfigWithInstance;
  /** True once any tool call in this server's lifetime performed a write. */
  wasWritten(): boolean;
};

export function createReviewTools(options: CreateReviewToolsOptions): ReviewTools {
  const { invoke, reviewId, runId } = options;
  let wrote = false;

  /** Call `invoke`, return its body as the tool's text result (or an error string on non-2xx), and mark `wrote` on success. */
  async function callAndMarkWritten(method: string, path: string, body?: unknown) {
    const res = await invoke(method, path, body);
    const text = await bodyText(res);
    if (!res.ok) return errorResult(`request failed (${String(res.status)}): ${text}`);
    wrote = true;
    return textResult(text);
  }

  async function callReadOnly(method: string, path: string, body?: unknown) {
    const res = await invoke(method, path, body);
    const text = await bodyText(res);
    if (!res.ok) return errorResult(`request failed (${String(res.status)}): ${text}`);
    return textResult(text);
  }

  /** `get_thread`/`reply`/`resolve_thread`: the thread must belong to this run's review. */
  async function requireOwnedThread(threadId: string): Promise<string | null> {
    const { ok, body } = await getJson(invoke, `/api/threads/${encodeURIComponent(threadId)}`);
    const thread = ok ? (body as { thread?: { reviewId?: string } }).thread : undefined;
    if (thread === undefined) return `thread "${threadId}" was not found`;
    if (thread.reviewId !== reviewId) return `thread "${threadId}" does not belong to this review`;
    return null;
  }

  /** `react`: the comment's thread must belong to this run's review. */
  async function requireOwnedComment(commentId: string): Promise<string | null> {
    const { ok, body } = await getJson(invoke, `/api/comments/${encodeURIComponent(commentId)}`);
    const info = ok ? (body as { reviewId?: string }) : undefined;
    if (info?.reviewId === undefined) return `comment "${commentId}" was not found`;
    if (info.reviewId !== reviewId) return `comment "${commentId}" does not belong to this review`;
    return null;
  }

  const server = createSdkMcpServer({
    name: 'joinery',
    tools: [
      ...(options.extraTools ?? []),
      tool(
        'get_review',
        'Get this review: the repo it belongs to, its branch/base/PR identity, and its current state (attached root, divergence from the remote, operation in progress). Use this to orient yourself before answering a thread.',
        {},
        async () => callReadOnly('GET', `/api/reviews/${encodeURIComponent(reviewId)}`),
      ),
      tool(
        'list_files',
        'List every changed file in this review (path, status, added/deleted line counts) at its current revision.',
        {},
        async () => callReadOnly('GET', `/api/reviews/${encodeURIComponent(reviewId)}/files`),
      ),
      tool(
        'get_diff',
        'Get the unified diff for one changed file in this review, trimmed to 400 lines. Use the exact path from list_files or a thread.',
        { path: z.string().min(1) },
        async ({ path }) => {
          const res = await invoke('GET', `/api/reviews/${encodeURIComponent(reviewId)}/diff?path=${encodeURIComponent(path)}`);
          if (!res.ok) return errorResult(`request failed (${String(res.status)}): ${await bodyText(res)}`);
          const body = (await res.json()) as { patch: { patch: string } };
          return textResult(trimToLines(body.patch.patch, 400));
        },
      ),
      tool(
        'get_file',
        'Get the full contents of one side (old or new) of a changed file in this review, for context beyond what the diff shows.',
        { path: z.string().min(1), side: z.enum(['old', 'new']) },
        async ({ path, side }) => {
          const res = await invoke('GET', `/api/reviews/${encodeURIComponent(reviewId)}/contents?path=${encodeURIComponent(path)}`);
          if (!res.ok) return errorResult(`request failed (${String(res.status)}): ${await bodyText(res)}`);
          const body = (await res.json()) as { contents: { oldContents: string | null; newContents: string | null } };
          const text = side === 'old' ? body.contents.oldContents : body.contents.newContents;
          return textResult(text ?? `(no ${side} side for "${path}")`);
        },
      ),
      tool(
        'get_reading_order',
        "Get this review's reading order (if one has been generated): the steps, their guidance, and which files belong to each.",
        {},
        async () => callReadOnly('GET', `/api/reviews/${encodeURIComponent(reviewId)}/reading-order`),
      ),
      tool(
        'list_threads',
        "List this review's comment threads, optionally filtered to just open or just resolved ones.",
        { status: z.enum(['open', 'resolved']).optional() },
        async ({ status }) => {
          const qs = status === undefined ? '' : `?status=${status}`;
          return callReadOnly('GET', `/api/reviews/${encodeURIComponent(reviewId)}/threads${qs}`);
        },
      ),
      tool(
        'get_thread',
        'Get one thread by id: its anchor (path, side, lines), status, and every comment so far, in order. The thread must belong to this review.',
        { threadId: z.string().min(1) },
        async ({ threadId }) => {
          const err = await requireOwnedThread(threadId);
          if (err !== null) return errorResult(err);
          return callReadOnly('GET', `/api/threads/${encodeURIComponent(threadId)}`);
        },
      ),
      tool(
        'reply',
        'Post a reply as yourself (the agent) in an existing thread. Use this to answer the question that triggered your run, or to follow up. The thread must belong to this review.',
        { threadId: z.string().min(1), body: z.string().min(1) },
        async ({ threadId, body }) => {
          const err = await requireOwnedThread(threadId);
          if (err !== null) return errorResult(err);
          return callAndMarkWritten('POST', `/api/threads/${encodeURIComponent(threadId)}/replies`, {
            body,
            author: 'agent',
            agentRunId: runId,
          });
        },
      ),
      tool(
        'create_thread',
        "Start a new comment thread on a specific line range of a changed file in this review, posted as yourself (the agent). Use this to raise something the triggering thread didn't ask about but that's worth flagging where it lives in the diff.",
        {
          path: z.string().min(1),
          side: threadSideSchema,
          startLine: z.number().int().positive(),
          endLine: z.number().int().positive(),
          body: z.string().min(1),
        },
        async ({ path, side, startLine, endLine, body }) =>
          callAndMarkWritten('POST', `/api/reviews/${encodeURIComponent(reviewId)}/threads`, {
            path,
            side,
            startLine,
            endLine,
            body,
            author: 'agent',
          }),
      ),
      tool(
        'resolve_thread',
        'Resolve or reopen a thread. Do not resolve a thread unless the user explicitly asked you to. The thread must belong to this review.',
        { threadId: z.string().min(1), resolved: z.boolean().default(true) },
        async ({ threadId, resolved }) => {
          const err = await requireOwnedThread(threadId);
          if (err !== null) return errorResult(err);
          return callAndMarkWritten('POST', `/api/threads/${encodeURIComponent(threadId)}/resolve`, { resolved });
        },
      ),
      tool(
        'react',
        "Set or clear one of your (the agent's) reactions on a comment: thumbs_up/thumbs_down to agree or disagree, eyes while you're looking at something, check when you've addressed it, question when something is unclear, tada to celebrate. Prefer this over a reply for a plain acknowledgement. The comment's thread must belong to this review.",
        { commentId: z.string().min(1), kind: reactionKindSchema, on: z.boolean().default(true) },
        async ({ commentId, kind, on }) => {
          const err = await requireOwnedComment(commentId);
          if (err !== null) return errorResult(err);
          return callAndMarkWritten('POST', `/api/comments/${encodeURIComponent(commentId)}/reactions`, {
            kind,
            actor: 'agent',
            on,
          });
        },
      ),
      tool(
        'mark_viewed',
        "Mark (or unmark) a file as viewed at its current blob, the same as the user checking it off in the file tree.",
        { path: z.string().min(1), viewed: z.boolean().default(true) },
        async ({ path, viewed }) =>
          callAndMarkWritten('POST', `/api/reviews/${encodeURIComponent(reviewId)}/viewed`, { path, viewed }),
      ),
      tool(
        'set_reading_order',
        'Replace this review\'s reading order with a new plan: an ordered list of steps, each with a title, short markdown guidance, an optional attention level (focus or skim), and the files (with optional per-file notes) it covers. Every changed file should appear in exactly one step.',
        {
          steps: z
            .array(
              z.object({
                title: z.string().min(1),
                guidance: z.string().default(''),
                attention: z.enum(['focus', 'skim']).nullable().default(null),
                files: z.array(z.object({ path: z.string().min(1), note: z.string().nullable().default(null) })).min(1),
              }),
            )
            .min(1),
        },
        async ({ steps }) =>
          options.onSetReadingOrder === undefined
            ? callAndMarkWritten('PUT', `/api/reviews/${encodeURIComponent(reviewId)}/reading-order`, { steps })
            : textResult(await options.onSetReadingOrder({ steps })),
      ),
      tool(
        'set_review_status',
        'Open or archive this review.',
        { status: z.enum(['open', 'archived']) },
        async ({ status }) =>
          callAndMarkWritten('POST', `/api/reviews/${encodeURIComponent(reviewId)}/status`, { status }),
      ),
    ],
  });

  return { server, wasWritten: () => wrote };
}
