import {
  ArrowLeft,
  ArrowUpRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Loader2,
  MessageSquare,
  Play,
  Rows2,
  Search,
} from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../lib/apiClient.ts';
import { goHomebase } from '../lib/router.ts';
import { useReview } from '../state/ReviewContext.tsx';
import { useReviewPull } from './ReviewSummaryCard.tsx';
import { RevisionPicker } from './RevisionPicker.tsx';
import { Hint } from './controls.tsx';
import { pathSegments } from '../lib/paths.ts';

/**
 * "Start review" / "Reopen review" — moves a `draft`/`archived` review to
 * `open`. Hidden for `open`/`orphaned`. Its
 * in-flight and error state are local rather than in `ReviewContext`: a
 * failed status flip doesn't belong in `state.error` (that's "the review
 * failed to load"), and nothing else needs to know about it.
 */
function StartReviewButton({ status }: { status: 'draft' | 'archived' }): React.JSX.Element {
  const { startReview } = useReview();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async (): Promise<void> => {
    setStarting(true);
    setError(null);
    try {
      await startReview();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start review');
    } finally {
      setStarting(false);
    }
  };

  return (
    <Hint label={error ?? undefined}>
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={starting}
        className="chrome-btn-primary ml-2"
      >
        {starting ? (
          <Loader2 size={13} strokeWidth={1.75} className="animate-spin" aria-hidden />
        ) : (
          <Play size={13} strokeWidth={1.75} aria-hidden />
        )}
        {status === 'archived' ? 'Reopen review' : 'Start review'}
      </button>
    </Hint>
  );
}

/**
 * Same frame + divider as lucide's `PanelLeft`/`PanelRight`, but the open
 * state is read from a solid sidebar rather than a direction arrow — an
 * arrow reads as "click to move this way," which is backwards half the
 * time (opening the *left* panel means the content the arrow points at
 * doesn't exist yet). A filled-vs-hollow sidebar reads as pure state, no
 * direction implied.
 */
function PanelToggleIcon({
  side,
  filled,
}: {
  side: 'left' | 'right';
  filled: boolean;
}): React.JSX.Element {
  const dividerX = side === 'left' ? 9 : 15;
  const sidebarX = side === 'left' ? 4 : 15;
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect width="18" height="18" x="3" y="3" rx="3" />
      <path d={`M${dividerX} 3v18`} />
      {filled && <rect width="5" height="16" x={sidebarX} y="4" rx="1.5" fill="currentColor" stroke="none" />}
    </svg>
  );
}

export function Header({ onOpenPalette }: { onOpenPalette: () => void }): React.JSX.Element {
  const {
    review,
    reviewState,
    repo,
    leftPanelOpen,
    rightPanelOpen,
    toggleLeftPanel,
    toggleRightPanel,
    diffStyle,
    setDiffStyle,
    collapseAllFiles,
    expandAllFiles,
    setRightPanelOpen,
    threadsPanelOpen,
    setThreadsPanelOpen,
  } = useReview();
  const pull = useReviewPull(review?.id);
  const threadsShown = rightPanelOpen && threadsPanelOpen;

  const repoName = repo == null ? undefined : pathSegments(repo.rootPath).at(-1);

  return (
    <header className="chrome-island flex h-11 shrink-0 items-center gap-1 px-2">
      <button type="button" onClick={goHomebase} aria-label="Back to Homebase" className="chrome-icon-btn">
        <ArrowLeft size={15} strokeWidth={1.75} aria-hidden />
      </button>

      {/* Breadcrumb: repo › branch. The full path is a tooltip, not a second
          line of tiny text competing with the branch name. */}
      <Hint label={repo?.rootPath}>
        <div className="flex min-w-0 items-center gap-1.5 pl-1 text-body">
          {repoName !== undefined && (
            <>
              <span className="truncate text-chrome-fg-muted">{repoName}</span>
              <span className="text-chrome-fg-subtle" aria-hidden>
                /
              </span>
            </>
          )}
          <span className="truncate font-medium text-chrome-fg">
            {review?.branch ?? review?.pinnedSha?.slice(0, 10) ?? '…'}
          </span>
          {pull !== null &&
            (pull.url !== null ? (
              <Hint label="Open pull request in a new window">
                <a
                  href={pull.url}
                  target="_blank"
                  rel="noreferrer"
                  className="group inline-flex shrink-0 items-center gap-0.5 tabular-nums text-chrome-fg-subtle hover:text-chrome-fg hover:underline"
                >
                  #{pull.number}
                  <ArrowUpRight size={12} strokeWidth={1.5} aria-hidden className="opacity-0 group-hover:opacity-100" />
                </a>
              </Hint>
            ) : (
              <span className="shrink-0 tabular-nums text-chrome-fg-subtle">#{pull.number}</span>
            ))}
        </div>
      </Hint>

      {/* Nothing left to start on once the branch has landed. */}
      {(review?.status === 'draft' || review?.status === 'archived') && reviewState?.merged !== true && (
        <StartReviewButton status={review.status} />
      )}

      <div className="flex-1" />

      <Hint label="Jump to… (⌘K)">
        <button
          type="button"
          onClick={onOpenPalette}
          aria-label="Jump to file, step, or command"
          className="chrome-icon-btn"
        >
          <Search size={15} strokeWidth={1.75} aria-hidden />
        </button>
      </Hint>

      <div className="mx-1.5 h-4 w-px bg-chrome-border-strong opacity-60" aria-hidden />

      <RevisionPicker />

      <div className="mx-1.5 h-4 w-px bg-chrome-border-strong opacity-60" aria-hidden />

      <div className="flex items-center gap-0.5">
        <Hint label="Collapse all files">
          <button
            type="button"
            onClick={collapseAllFiles}
            aria-label="Collapse all files"
            className="chrome-icon-btn"
          >
            <ChevronsDownUp size={15} strokeWidth={1.75} aria-hidden />
          </button>
        </Hint>
        <Hint label="Expand all files">
          <button
            type="button"
            onClick={expandAllFiles}
            aria-label="Expand all files"
            className="chrome-icon-btn"
          >
            <ChevronsUpDown size={15} strokeWidth={1.75} aria-hidden />
          </button>
        </Hint>
        <Hint label={diffStyle === 'split' ? 'Switch to unified diff' : 'Switch to split diff'}>
          <button
            type="button"
            aria-label={diffStyle === 'split' ? 'Switch to unified diff' : 'Switch to split diff'}
            onClick={() => setDiffStyle(diffStyle === 'split' ? 'unified' : 'split')}
            className="chrome-icon-btn"
          >
            {diffStyle === 'split' ? (
              <Columns2 size={15} strokeWidth={1.75} aria-hidden />
            ) : (
              <Rows2 size={15} strokeWidth={1.75} aria-hidden />
            )}
          </button>
        </Hint>
        {/* Threads live in the right pane, so opening them opens that too. */}
        <Hint label={threadsShown ? 'Close threads (T)' : 'Open threads (T)'}>
          <button
            type="button"
            aria-label={threadsShown ? 'Close threads' : 'Open threads'}
            aria-expanded={threadsShown}
            onClick={() => {
              if (threadsShown) {
                setThreadsPanelOpen(false);
              } else {
                setRightPanelOpen(true);
                setThreadsPanelOpen(true);
              }
            }}
            className="chrome-icon-btn"
          >
            <MessageSquare
              size={15}
              strokeWidth={1.75}
              fill={threadsShown ? 'currentColor' : 'none'}
              aria-hidden
            />
          </button>
        </Hint>
      </div>

      <div className="mx-1.5 h-4 w-px bg-chrome-border-strong opacity-60" aria-hidden />

      <div className="flex items-center gap-0.5">
        <Hint label="Toggle file tree">
          <button
            type="button"
            aria-label="Toggle file tree"
            aria-expanded={leftPanelOpen}
            onClick={toggleLeftPanel}
            className="chrome-icon-btn"
          >
            <PanelToggleIcon side="left" filled={leftPanelOpen} />
          </button>
        </Hint>
        <Hint label="Toggle reading order">
          <button
            type="button"
            aria-label="Toggle reading order"
            aria-expanded={rightPanelOpen}
            onClick={toggleRightPanel}
            className="chrome-icon-btn"
          >
            <PanelToggleIcon side="right" filled={rightPanelOpen} />
          </button>
        </Hint>
      </div>
    </header>
  );
}
