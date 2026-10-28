/**
 * The comment composer, used both for a new draft thread (opened via the
 * gutter `+` utility or a text selection's comment button) and for replies within an existing thread.
 * `Enter` inserts a newline; `Cmd+Enter` submits. "Ask" has no shortcut.
 *
 * "Ask ▾ Model" (`AskButton`) submits and asks the picked model to reply;
 * the caller reads the pick from `lib/agentModel.ts` when it sends.
 */
import { useEffect, useRef, useState } from 'react';
import { AskButton } from './AskButton.tsx';
import { Hint } from './controls.tsx';

/**
 * Unsent text by `draftKey`. The diff virtualizes its files, so scrolling or
 * jumping past a composer unmounts it; this brings the text back on remount.
 */
const unsent = new Map<string, string>();

/** Whether a composer under `draftKey` holds unsent text (e.g. to reopen a reply). */
export function hasUnsent(draftKey: string): boolean {
  return unsent.has(draftKey);
}

export function CommentComposer({
  onSubmit,
  onCancel,
  placeholder = 'Leave a comment…',
  autoFocus = true,
  variant = 'card',
  initialValue = '',
  draftKey,
}: {
  onSubmit: (body: string, askAgent: boolean) => void;
  onCancel?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** `card` floats on the diff (new draft); `inline` sits flush inside a thread card (reply), with no frame of its own. */
  variant?: 'card' | 'inline';
  /** Prefilled text, read once on mount; the caret starts after it. */
  initialValue?: string;
  /** Keeps unsent text across unmounts; cleared on submit or cancel. */
  draftKey?: string;
}): React.JSX.Element {
  const [restored] = useState(() => (draftKey === undefined ? undefined : unsent.get(draftKey)));
  const [value, setValue] = useState(restored ?? initialValue);
  const ref = useRef<HTMLTextAreaElement>(null);

  const update = (next: string) => {
    setValue(next);
    if (draftKey === undefined) return;
    if (next.length === 0) unsent.delete(draftKey);
    else unsent.set(draftKey, next);
  };

  // A textarea's caret starts at 0, which would put typing above the prefill.
  useEffect(() => {
    const el = ref.current;
    const start = restored ?? initialValue;
    if (el === null || start.length === 0) return;
    el.setSelectionRange(start.length, start.length);
    // Mount only: the prefill is a starting point, not a controlled value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const empty = value.trim().length === 0;

  // Auto-grow with content: reset to auto so shrinking works, then size to
  // the scroll height. The CSS `max-h-*` on the textarea caps it, after
  // which it scrolls internally.
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const submit = (askAgent: boolean) => {
    if (empty) return;
    onSubmit(value, askAgent);
    update('');
  };

  const cancel = () => {
    if (draftKey !== undefined) unsent.delete(draftKey);
    onCancel?.();
  };

  return (
    <div
      className={`flex flex-col overflow-visible font-sans ${
        variant === 'card' ? 'rounded-lg bg-chrome-bg-raised shadow-chrome ring-1 ring-chrome-fg/8' : 'border-t border-chrome-border'
      }`}
    >
      <textarea
        ref={ref}
        // A restored composer remounts as it scrolls back into view; don't let it grab focus then.
        autoFocus={autoFocus && restored === undefined}
        value={value}
        onChange={(e) => update(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit(false);
          } else if (e.key === 'Escape') {
            cancel();
          }
        }}
        placeholder={placeholder}
        rows={2}
        className={`max-h-72 w-full resize-none overflow-y-auto bg-transparent pb-1 pt-2.5 text-body leading-relaxed text-chrome-fg outline-hidden placeholder:text-chrome-fg-subtle ${
          variant === 'card' ? 'px-3' : 'px-0'
        }`}
        aria-label="Comment body"
      />
      <div className={`flex flex-wrap items-center justify-end gap-1.5 pb-2 ${variant === 'card' ? 'px-2' : 'px-0'}`}>
        {onCancel !== undefined && (
          <button type="button" onClick={cancel} className="chrome-btn bg-transparent">
            Cancel
          </button>
        )}

        <AskButton onAsk={() => submit(true)} disabled={empty} title="Submit and ask {model} to reply" onPicked={() => ref.current?.focus()} />

        <Hint label="Comment (⌘Enter)">
          <button type="button" onClick={() => submit(false)} disabled={empty} className="chrome-btn-primary">
            Comment
            <kbd className="font-sans text-micro opacity-70">⌘↵</kbd>
          </button>
        </Hint>
      </div>
    </div>
  );
}
