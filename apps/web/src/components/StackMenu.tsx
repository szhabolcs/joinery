/**
 * The review header's stack switcher, drawn like GitHub's: a pill after the
 * PR link (stack icon, "3/4") opens a list of the stack, top first. Each
 * PR is two lines (title; number and branch) with its state icon on a line
 * that runs down the stack to the base branch. The current PR is
 * highlighted. Picking another opens its review, creating a draft one for a
 * PR nobody has opened yet.
 *
 * Only rendered when the server reported a stack (`useReviewStack`), which
 * it does only where the forge has a stacks feature.
 */
import { Menu } from '@base-ui-components/react/menu';
import type { PullStack, PullStackMember, PullState } from '@joinery/core';
import { Circle, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react';
import { useState } from 'react';
import { ApiError, callApi } from '../lib/apiClient.ts';
import { goReview } from '../lib/router.ts';
import { Hint, MENU_POPUP_CLASS } from './controls.tsx';
import { STACK_PILL_CLASS, StackPillContent } from './StackPill.tsx';

/** GitHub's PR state icons and colours. */
const STATE_ICON: Record<PullState, { icon: typeof GitPullRequest; className: string; label: string }> = {
  open: { icon: GitPullRequest, className: 'text-chrome-success', label: 'Open' },
  draft: { icon: GitPullRequestDraft, className: 'text-chrome-fg-subtle', label: 'Draft' },
  merged: { icon: GitMerge, className: 'text-chrome-accent', label: 'Merged' },
  closed: { icon: GitPullRequestClosed, className: 'text-chrome-danger', label: 'Closed' },
};

/**
 * The rail: icons sit in a 14px column at the row's 8px padding, 9px from
 * the row's top (the title's first line), so the line runs at x = 15px.
 */
const RAIL = 'pointer-events-none absolute left-[15px] w-px -translate-x-1/2 bg-chrome-border-strong';
const ICON_TOP = 9;
const ICON_SIZE = 14;

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
  // Top of the stack first, as on GitHub; the base branch closes the list.
  const members = [...stack.pulls].reverse();

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
          aria-label={`Stack: ${String(position)} of ${String(stack.pulls.length)}. Switch pull request`}
          className={`${STACK_PILL_CLASS} ml-1 transition-colors hover:bg-chrome-bg-hover hover:text-chrome-fg aria-expanded:bg-chrome-bg-active aria-expanded:text-chrome-fg`}
        >
          <StackPillContent position={position} size={stack.pulls.length} />
        </Menu.Trigger>
      </Hint>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={8} className="z-50">
          <Menu.Popup className={`${MENU_POPUP_CLASS} w-[26rem] p-1.5`}>
            <div className="px-2 pt-1 pb-2 text-body font-semibold text-chrome-fg">Stack #{stack.number}</div>
            <Menu.RadioGroup value={current}>
              {members.map((member, i) => {
                const state = STATE_ICON[member.state];
                const Icon = state.icon;
                return (
                  <Menu.RadioItem
                    key={member.number}
                    value={member.number}
                    closeOnClick
                    onClick={() => void open(member)}
                    className="relative flex cursor-default select-none gap-2 rounded-md px-2 py-2 outline-hidden data-checked:bg-chrome-bg-active not-data-checked:data-highlighted:bg-chrome-bg-hover"
                  >
                    {i > 0 && <span aria-hidden className={RAIL} style={{ top: 0, height: ICON_TOP }} />}
                    <span aria-hidden className={RAIL} style={{ top: ICON_TOP + ICON_SIZE, bottom: 0 }} />
                    <Icon size={ICON_SIZE} strokeWidth={2} className={`relative mt-px shrink-0 ${state.className}`} aria-label={state.label} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-body font-medium text-chrome-fg">{member.title ?? member.headRefName}</span>
                      <span className="truncate text-micro text-chrome-fg-subtle">
                        <span className="tabular-nums">#{member.number}</span> · {member.headRefName}
                      </span>
                    </span>
                  </Menu.RadioItem>
                );
              })}
            </Menu.RadioGroup>
            {/* Where the stack sits: not a PR, so not an item. */}
            <div className="relative flex items-start gap-2 px-2 pt-2 pb-1.5">
              <span aria-hidden className={RAIL} style={{ top: 0, height: ICON_TOP }} />
              <Circle size={ICON_SIZE} strokeWidth={2.25} className="relative mt-px shrink-0 text-chrome-fg-subtle" aria-hidden />
              <span className="rounded bg-chrome-bg-hover px-1.5 font-mono text-micro leading-4 text-chrome-fg-muted">{stack.baseRefName}</span>
            </div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
