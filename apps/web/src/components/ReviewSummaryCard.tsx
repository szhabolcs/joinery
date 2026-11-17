/**
 * The card above the first file (`renderCodeViewHeader`): what the review
 * header doesn't already say — title, PR facts, CI, size, and the PR
 * description behind a disclosure. A branch with no PR (or no `gh`)
 * shows the stats only.
 */
import { Collapsible } from '@base-ui-components/react/collapsible';
import type { CiStatus, PullDetail, PullStack, PullState, ResponseOf } from '@joinery/core';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { callApi } from '../lib/apiClient.ts';
import { queryKeys } from '../lib/liveQueries.ts';
import { useReview } from '../state/ReviewContext.tsx';
import { Chip, CiIcon, DiffStat, type Tone } from './home/primitives.tsx';
import { Markdown } from './Markdown.tsx';

const CI_TONE: Record<CiStatus, Tone> = {
  passing: 'success',
  failing: 'danger',
  pending: 'warning',
};

const STATE_LABEL: Record<PullState, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
};

const STATE_TONE: Record<PullState, Tone> = {
  open: 'success',
  draft: 'neutral',
  merged: 'accent',
  closed: 'danger',
};

/**
 * The review's PR as the server's engine last stored it. Kept live by the
 * review window watching `review:<id>`: when the poller sees the PR change
 * (title, CI, merged, retargeted), the query re-reads.
 */
export function useReviewPull(reviewId: string | undefined): PullDetail | null {
  return useReviewPullQuery(reviewId)?.pull ?? null;
}

/** The stack the review's PR belongs to (GitHub stacked PRs), from the same read; null when it's in none. */
export function useReviewStack(reviewId: string | undefined): PullStack | null {
  return useReviewPullQuery(reviewId)?.stack ?? null;
}

function useReviewPullQuery(reviewId: string | undefined): ResponseOf<'getReviewPull'> | undefined {
  return useQuery({
    queryKey: queryKeys.reviewPull(reviewId ?? ''),
    queryFn: () => callApi('getReviewPull', { params: [reviewId ?? ''], query: {} }),
    enabled: reviewId !== undefined,
  }).data;
}

export function ReviewSummaryCard(): React.JSX.Element | null {
  const { review, fileList } = useReview();
  const pull = useReviewPull(review?.id);
  const [descriptionOpen, setDescriptionOpen] = useState(false);

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of fileList) {
      additions += f.additions ?? 0;
      deletions += f.deletions ?? 0;
    }
    return { additions, deletions };
  }, [fileList]);

  if (review === null) return null;

  const title = pull?.title ?? review.branch ?? review.pinnedSha?.slice(0, 7) ?? 'Review';
  const hasDescription = pull !== null && pull.body.trim() !== '';

  // Same footprint as a file card (ReviewCodeView's FILE_CARD_CSS): full
  // width, 10px radius, the island ring, and the 8px seam below.
  return (
    <section className="mb-2 rounded-[10px] bg-chrome-bg-raised font-sans outline outline-1 -outline-offset-1 outline-[var(--chrome-island-ring,var(--chrome-border))]">
      <div className="flex flex-col gap-1.5 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="min-w-0 truncate text-[15px] font-semibold text-chrome-fg">{title}</h2>
          {pull !== null && (
            <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
              <Chip tone={STATE_TONE[pull.state]}>{STATE_LABEL[pull.state]}</Chip>
              {pull.ci !== null && (
                <Chip tone={CI_TONE[pull.ci]} icon={<CiIcon ci={pull.ci} size={11} />}>
                  {pull.ci === 'pending' ? 'CI running' : `CI ${pull.ci}`}
                </Chip>
              )}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-chrome-fg-muted">
          {pull !== null && (
            <>
              <span>
                {pull.authorLogin !== null && <span className="text-chrome-fg">{pull.authorLogin} </span>}
                into <span className="font-mono">{pull.baseRefName}</span>
              </span>
            </>
          )}
          <span className="ml-auto inline-flex items-center gap-3">
            <span className="tabular-nums">
              {fileList.length} {fileList.length === 1 ? 'file' : 'files'}
            </span>
            <DiffStat additions={totals.additions} deletions={totals.deletions} />
          </span>
        </div>
      </div>
      {hasDescription && (
        <Collapsible.Root open={descriptionOpen} onOpenChange={setDescriptionOpen} className="border-t border-chrome-border">
          <Collapsible.Trigger className="flex h-8 w-full items-center gap-1.5 px-3 text-xs font-medium text-chrome-fg-muted hover:text-chrome-fg">
            {descriptionOpen ? (
              <ChevronDown size={14} strokeWidth={1.5} aria-hidden />
            ) : (
              <ChevronRight size={14} strokeWidth={1.5} aria-hidden />
            )}
            Description
          </Collapsible.Trigger>
          <Collapsible.Panel className="px-4 pb-3">
            <Markdown>{pull.body}</Markdown>
          </Collapsible.Panel>
        </Collapsible.Root>
      )}
    </section>
  );
}
