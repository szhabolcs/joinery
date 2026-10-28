/**
 * One inline comment thread, rendered as a `CodeView` line
 * annotation. Outdated threads collapse to their anchor context by default;
 * "changed since you commented" is a softer warning that keeps the thread
 * open. Resolve/reopen and reply round-trip through the API and then ask the
 * parent to reload threads.
 */
import { Toggle } from '@base-ui-components/react/toggle';
import { Bot, Check, ChevronDown, Loader2, MessageSquare, Trash2, User, X } from 'lucide-react';
import { useState } from 'react';
import type { Thread } from '@joinery/core';
import { getAgentModel } from '../lib/agentModel.ts';
import { callApi } from '../lib/apiClient.ts';
import { AskButton } from './AskButton.tsx';
import { CommentComposer, hasUnsent } from './CommentComposer.tsx';
import { ConfirmDelete } from './ConfirmDelete.tsx';
import { Markdown } from './Markdown.tsx';
import { ReactionBar, ReactionPicker } from './ReactionBar.tsx';
import { threadSummary } from '../lib/threadSummary.ts';
import { useReview } from '../state/ReviewContext.tsx';
import { Hint } from './controls.tsx';

/**
 * `createdAt` comes from SQLite's `unixepoch()` (seconds); anything that
 * small would render as January 1970 through `Date`. Accept both units so a
 * millisecond timestamp from elsewhere still formats correctly.
 */
function toMs(createdAt: number): number {
  return createdAt < 1e12 ? createdAt * 1000 : createdAt;
}

function formatTimestamp(createdAt: number): string {
  const date = new Date(toMs(createdAt));
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

function Badge({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="flex h-5 items-center text-micro font-medium text-chrome-warning">{children}</span>;
}

export function ThreadArticle({
  thread,
  onChanged,
}: {
  thread: Thread;
  onChanged: () => void;
}): React.JSX.Element {
  const { threadRuns, askAgent, cancelRun, activeThreadId, setActiveThreadId } = useReview();
  // Interacting with a thread makes it the "current thread" that `r`
  // resolves and `]`/`[` continue from (see ReviewContext `activeThreadId`).
  const active = activeThreadId === thread.id;
  const markActive = () => {
    if (!active) setActiveThreadId(thread.id);
  };
  const replyKey = `reply:${thread.id}`;
  // Reopen a reply left half-written when the diff unmounted this card.
  const [replying, setReplying] = useState(() => hasUnsent(replyKey));
  // Resolved threads start collapsed; resolving/reopening re-syncs the
  // default (derived from props),
  // while a manual toggle in between is respected until the status changes.
  const [collapsed, setCollapsed] = useState(thread.status === 'resolved');
  const [prevStatus, setPrevStatus] = useState(thread.status);
  if (thread.status !== prevStatus) {
    setPrevStatus(thread.status);
    setCollapsed(thread.status === 'resolved');
  }

  const resolve = async (resolved: boolean) => {
    await callApi('resolveThread', { params: [thread.id], body: { resolved } });
    onChanged();
  };

  const reply = async (body: string, askAgent: boolean) => {
    await callApi('reply', {
      params: [thread.id],
      body: { body, author: 'user', askAgent, ...(askAgent ? { model: getAgentModel() } : {}) },
    });
    setReplying(false);
    onChanged();
  };

  const deleteThread = async () => {
    await callApi('deleteThread', { params: [thread.id] });
    onChanged();
  };

  const deleteComment = async (commentId: string) => {
    await callApi('deleteComment', { params: [commentId] });
    onChanged();
  };

  const resolved = thread.status === 'resolved';
  const hasBadges = thread.outdated || thread.changedSinceComment;
  const commentCount = thread.comments.length;
  const summary = threadSummary(thread.comments[0]?.body ?? '');

  const runEntry = threadRuns.get(thread.id);
  // The agent often keeps working (a closing summary) after calling `reply`;
  // once its comment for this run has landed the ghost has nothing left to say.
  const replied = runEntry !== undefined && thread.comments.some((c) => c.agentRunId === runEntry.run.id);
  const runLive =
    runEntry !== undefined && !replied && (runEntry.run.status === 'pending' || runEntry.run.status === 'running');

  if (collapsed) {
    // One diff line tall, no card: a collapsed thread should read as part
    // of the code (like a hunk separator), not as a floating box.
    return (
      <article
        aria-label={`Thread on ${thread.path} line ${thread.startLine} (collapsed)`}
        aria-current={active ? 'true' : undefined}
        onPointerDownCapture={markActive}
        onFocusCapture={markActive}
        className="w-full max-w-2xl rounded-[4px] font-sans"
      >
        <Hint label={commentCount === 1 ? '1 comment' : `${commentCount} comments`}>
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            aria-expanded={false}
            className="flex h-[22px] w-full min-w-0 items-center gap-2 rounded-[4px] px-2 text-left text-xs text-chrome-fg-muted transition-colors hover:bg-chrome-bg-hover"
          >
            <MessageSquare
              size={12}
              strokeWidth={1.75}
              fill="currentColor"
              className={`shrink-0 ${resolved ? 'text-chrome-success' : 'text-chrome-accent'}`}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">{summary}</span>
          </button>
        </Hint>
      </article>
    );
  }

  return (
    <article
      aria-label={`Thread on ${thread.path} line ${thread.startLine}`}
      aria-current={active ? 'true' : undefined}
      onPointerDownCapture={markActive}
      onFocusCapture={markActive}
      className="mx-1 my-1.5 flex w-[calc(100%-0.5rem)] max-w-2xl flex-col rounded-lg bg-chrome-bg-raised font-sans text-chrome-fg shadow-chrome ring-1 ring-chrome-fg/8"
    >
      <div
        // Empty space in the header collapses the thread; buttons and the
        // delete confirmation keep their own clicks. The confirmation is
        // portaled, but React still bubbles its clicks up through here.
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button, [role="dialog"]') === null) setCollapsed(true);
        }}
        className={`flex cursor-pointer items-center gap-1.5 pl-2 pr-3 pt-2 ${hasBadges ? 'pb-0.5' : '-mb-1.5'}`}
      >
        <Hint label="Collapse thread">
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-expanded
            aria-label="Collapse thread"
            className="chrome-icon-btn size-6 text-chrome-fg-subtle"
          >
            <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
          </button>
        </Hint>
        {hasBadges && (
          <>
          {thread.outdated && (
            <Badge>
              Outdated
            </Badge>
          )}
          {thread.changedSinceComment && !thread.outdated && (
            <Badge>
              Changed since you commented
            </Badge>
          )}
          </>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {/* A toggle names its state, not the action: "Resolved, pressed" rather than "Reopen thread, pressed". */}
          <Hint label={resolved ? 'Reopen thread' : 'Resolve thread'}>
            <Toggle
              pressed={resolved}
              onPressedChange={(next) => void resolve(next)}
              aria-label="Resolved"
              className={`chrome-icon-btn h-6 gap-1 text-xs font-medium ${
                resolved ? 'w-auto px-1.5 text-chrome-success! hover:text-chrome-success!' : 'w-6 text-chrome-fg-subtle'
              }`}
            >
              <Check size={14} strokeWidth={resolved ? 2.5 : 1.75} aria-hidden />
              {resolved && 'Resolved'}
            </Toggle>
          </Hint>
          <ConfirmDelete
            onConfirm={deleteThread}
            prompt="Delete this thread and all its comments?"
            triggerLabel="Delete thread"
            triggerClassName="chrome-icon-btn size-6 text-chrome-fg-subtle hover:text-chrome-danger"
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </ConfirmDelete>
        </div>
      </div>

      {thread.outdated && (
        <pre className="mx-3 mb-1 mt-2 overflow-x-auto rounded-md bg-chrome-bg-sunken p-2 font-mono text-xs leading-relaxed text-chrome-fg-subtle">
          {thread.anchorContext}
        </pre>
      )}
      <ul className="flex flex-col gap-1 py-1">
          {thread.comments.map((comment) => {
            const agent = comment.author === 'agent';
            return (
              <li key={comment.id} className="group/comment flex gap-2.5 px-3 py-1.5">
                <span
                  className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${
                    agent ? 'bg-chrome-accent-soft text-chrome-accent' : 'bg-chrome-bg-sunken text-chrome-fg-muted'
                  }`}
                  aria-hidden
                >
                  {agent ? <Bot size={12} strokeWidth={1.75} /> : <User size={12} strokeWidth={1.75} />}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-baseline gap-2 text-micro">
                    <span className="font-medium text-chrome-fg">{agent ? 'Agent' : 'You'}</span>
                    <time className="text-chrome-fg-subtle" dateTime={new Date(toMs(comment.createdAt)).toISOString()}>
                      {formatTimestamp(comment.createdAt)}
                    </time>
                    <div className="-my-1 ml-auto flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/comment:opacity-100 has-[[aria-expanded=true]]:opacity-100 has-[[data-popup-open]]:opacity-100">
                      <ReactionPicker comment={comment} />
                      <ConfirmDelete
                        onConfirm={() => deleteComment(comment.id)}
                        prompt={commentCount === 1 ? 'Delete this comment and its thread?' : 'Delete this comment?'}
                        triggerLabel="Delete comment"
                        triggerClassName="chrome-icon-btn size-5 text-chrome-fg-subtle hover:text-chrome-danger"
                      >
                        <Trash2 size={12} strokeWidth={1.75} aria-hidden />
                      </ConfirmDelete>
                    </div>
                  </div>
                  <Markdown>{comment.body}</Markdown>
                  <ReactionBar comment={comment} />
                </div>
              </li>
            );
          })}
          {runLive && runEntry !== undefined && (
            <li className="flex gap-2.5 px-3 py-1.5 opacity-60" aria-live="polite">
              <span
                className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-chrome-accent-soft text-chrome-accent"
                aria-hidden
              >
                <Bot size={12} strokeWidth={1.75} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-baseline gap-2 text-micro">
                  <span className="font-medium text-chrome-fg">Agent</span>
                </div>
                <div className="flex items-center gap-1.5 text-micro text-chrome-fg-subtle">
                  <Loader2 size={12} strokeWidth={2} className="shrink-0 animate-spin" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{runEntry.activity ?? 'Thinking…'}</span>
                  <button
                    type="button"
                    onClick={() => void cancelRun(runEntry.run.id)}
                    disabled={runEntry.run.id.startsWith('local_')}
                    className="flex h-[26px] items-center rounded-md bg-chrome-bg-hover px-2.5 text-xs font-medium text-chrome-fg transition-colors hover:bg-chrome-bg-active disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </li>
          )}
        </ul>

      <div className="px-3 pb-2.5 pt-1">
        {replying ? (
          <CommentComposer
            variant="inline"
            draftKey={replyKey}
            placeholder="Reply…"
            onSubmit={(body, ask) => void reply(body, ask)}
            onCancel={() => setReplying(false)}
          />
        ) : (
          <div className="flex items-center justify-end gap-1.5">
            <button type="button" onClick={() => setReplying(true)} className="chrome-btn">
              Reply
            </button>
            <AskButton
              onAsk={() => void askAgent(thread.id)}
              disabled={runLive}
              title="Ask {model} to reply, without composing a new comment"
            />
          </div>
        )}
      </div>
    </article>
  );
}
