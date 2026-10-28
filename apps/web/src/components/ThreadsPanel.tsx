/**
 * The threads panel: slides over the reading-order pane. It is an
 * index and jump-to surface only — threads themselves render inline in the
 * diff via `ThreadArticle`.
 */
import { Check, Loader2, MessageSquare, X } from 'lucide-react';
import { useState } from 'react';
import type { Thread } from '@joinery/core';
import { useReview } from '../state/ReviewContext.tsx';
import { Hint, Segment, Segmented } from './controls.tsx';
import { threadSummary } from '../lib/threadSummary.ts';

/** Whether the agent currently has `eyes` on any comment in the thread. */
function agentIsLooking(thread: Thread): boolean {
  return thread.comments.some((c) =>
    c.reactions.some((r) => r.kind === 'eyes' && r.actors.includes('agent')),
  );
}

export function ThreadsPanel(): React.JSX.Element {
  const { threads, threadRuns, toggleThreadsPanel, setSelectedPath, setActiveThreadId, codeViewRef, showDiff } =
    useReview();
  const [filter, setFilter] = useState<'open' | 'resolved'>('open');
  const visible = threads.filter((t) => t.status === filter);

  const jumpTo = (thread: Thread) => {
    setSelectedPath(thread.path);
    // Jumping to a thread makes it the one `r` resolves and `]`/`[` continue from.
    setActiveThreadId(thread.id);
    void showDiff(thread.path).then(() =>
      codeViewRef.current?.scrollTo({
        type: 'line',
        id: thread.path,
        lineNumber: thread.startLine,
        side: thread.side === 'old' ? 'deletions' : 'additions',
        align: 'center',
      }),
    );
  };

  return (
    <div
      role="region"
      aria-label="Threads"
      // Covers the reading-order island, so it repeats that island's surface and highlight.
      className="chrome-island-fill absolute inset-0 z-10 flex flex-col"
    >
      <div className="flex h-10 items-center justify-between pl-4 pr-2">
        {/* Quieter than a section micro-header: this label's only job is to
            tell you the reading order is covered by the threads panel, not
            to title self-evident content, so it takes the same weight as a
            step title rather than the shoutier uppercase treatment. */}
        <h2 className="text-body font-medium text-chrome-fg">Threads</h2>
        <button
          type="button"
          onClick={toggleThreadsPanel}
          aria-label="Close threads panel"
          className="chrome-icon-btn"
        >
          <X size={15} strokeWidth={1.5} aria-hidden />
        </button>
      </div>
      <Segmented value={filter} onChange={setFilter} aria-label="Show threads" className="flex gap-1 px-4 pb-1.5">
        <Segment value="open">Open</Segment>
        <Segment value="resolved">Resolved</Segment>
      </Segmented>
      <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-4 pb-4 pt-1">
        {visible.length === 0 && (
          <li className="p-2 text-center text-xs text-chrome-fg-muted">No {filter} threads.</li>
        )}
        {visible.map((thread) => {
          const run = threadRuns.get(thread.id)?.run;
          const runLive = run !== undefined && (run.status === 'pending' || run.status === 'running');
          return (
            <li key={thread.id}>
              <button
                type="button"
                onClick={() => jumpTo(thread)}
                className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-chrome-bg-hover"
              >
                <span className="flex items-center gap-1.5 font-mono text-micro text-chrome-fg-subtle">
                  {thread.status === 'resolved' ? (
                    <Check size={12} strokeWidth={1.5} className="shrink-0" aria-hidden />
                  ) : (
                    <MessageSquare size={12} strokeWidth={1.5} className="shrink-0" aria-hidden />
                  )}
                  <span className="truncate">
                    {thread.path}:{thread.startLine}
                  </span>
                </span>
                <span className="flex items-center gap-1.5 truncate text-body text-chrome-fg">
                  <span className="min-w-0 flex-1 truncate">
                    {threadSummary(thread.comments[0]?.body ?? '') || '(empty)'}
                  </span>
                  {agentIsLooking(thread) && (
                    <Hint label="Agent is looking">
                      <span role="img" aria-label="Agent is looking" className="shrink-0">
                        👀
                      </span>
                    </Hint>
                  )}
                  {runLive && (
                    <Loader2
                      size={12}
                      strokeWidth={2}
                      className="shrink-0 animate-spin text-chrome-fg-subtle"
                      aria-hidden
                    />
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
