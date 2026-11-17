/**
 * The review header's stack switcher: a chevron after the PR number that
 * lists every PR in the review's GitHub stack, bottom (the one on the
 * base) first, the order to review them in, with the current one ticked. Picking another opens its
 * review, creating a draft one for a PR nobody has opened yet.
 *
 * Only rendered when the server reported a stack (`useReviewStack`), which
 * it does only where the forge has a stacks feature.
 */
import { Menu } from '@base-ui-components/react/menu';
import type { PullStack, PullStackMember, PullState } from '@joinery/core';
import { Check, ChevronDown, Layers } from 'lucide-react';
import { useState } from 'react';
import { ApiError, callApi } from '../lib/apiClient.ts';
import { goReview } from '../lib/router.ts';
import { Hint, MENU_POPUP_CLASS, POPUP_ITEM_CLASS, POPUP_LABEL_CLASS, Tick } from './controls.tsx';

const STATE_LABEL: Partial<Record<PullState, string>> = { draft: 'draft', merged: 'merged', closed: 'closed' };

export function StackMenu({
  stack,
  repoId,
  current,
}: {
  stack: PullStack;
  repoId: string;
  /** The PR this review is of. */
  current: number;
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const position = stack.pulls.findIndex((p) => p.number === current) + 1;
  const label = `Stack: ${String(position)} of ${String(stack.pulls.length)}. Switch pull request`;

  const open = async (member: PullStackMember): Promise<void> => {
    if (member.number === current) return;
    if (member.reviewId !== null) {
      goReview(member.reviewId);
      return;
    }
    try {
      const detail = await callApi('createReview', {
        body: { repoId, branch: member.headRefName, prNumber: member.number, status: 'draft' },
      });
      setError(null);
      goReview(detail.review.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to open #${String(member.number)}`);
    }
  };

  return (
    <Menu.Root modal={false}>
      <Hint label={error ?? `Stack · ${String(position)} of ${String(stack.pulls.length)}`}>
        <Menu.Trigger
          aria-label={label}
          className="chrome-icon-btn -ml-0.5 size-5! shrink-0 rounded-[5px]! text-chrome-fg-subtle aria-expanded:bg-chrome-bg-active aria-expanded:text-chrome-fg"
        >
          <ChevronDown size={13} strokeWidth={2} aria-hidden />
        </Menu.Trigger>
      </Hint>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4} collisionPadding={8} className="z-50">
          <Menu.Popup className={`${MENU_POPUP_CLASS} w-80`}>
            <div className={`${POPUP_LABEL_CLASS} flex items-center gap-1.5`}>
              <Layers size={12} strokeWidth={1.75} aria-hidden />
              Stack of {stack.pulls.length} on {stack.baseRefName}
            </div>
            <Menu.RadioGroup value={current}>
              {stack.pulls.map((member, i) => (
                <Menu.RadioItem
                  key={member.number}
                  value={member.number}
                  closeOnClick
                  onClick={() => void open(member)}
                  className={POPUP_ITEM_CLASS}
                >
                  <Tick>
                    <Menu.RadioItemIndicator>
                      <Check size={12} strokeWidth={2} className="text-chrome-accent" aria-hidden />
                    </Menu.RadioItemIndicator>
                  </Tick>
                  <span className="w-3 shrink-0 text-right tabular-nums text-chrome-fg-subtle">{i + 1}</span>
                  <span className="shrink-0 tabular-nums text-chrome-fg-subtle">#{member.number}</span>
                  <span className={`min-w-0 flex-1 truncate ${member.state === 'open' || member.state === 'draft' ? '' : 'text-chrome-fg-muted'}`}>
                    {member.title ?? member.headRefName}
                  </span>
                  {STATE_LABEL[member.state] !== undefined && (
                    <span className="shrink-0 text-micro text-chrome-fg-subtle">{STATE_LABEL[member.state]}</span>
                  )}
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
