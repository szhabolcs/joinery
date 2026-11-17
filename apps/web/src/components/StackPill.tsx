/**
 * A PR's place in its GitHub stack, drawn the way GitHub draws it: a
 * rounded pill with the stack icon and "position/size", counted from the
 * bottom of the stack. The review header makes it the stack menu's trigger;
 * Homebase shows it on stacked cards.
 */
import { Layers } from 'lucide-react';

export const STACK_PILL_CLASS =
  'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-chrome-border-strong px-1.5 text-micro font-medium tabular-nums text-chrome-fg-muted';

export function StackPillContent({ position, size }: { position: number; size: number }): React.JSX.Element {
  return (
    <>
      <Layers size={11} strokeWidth={2} aria-hidden />
      {position}/{size}
    </>
  );
}
