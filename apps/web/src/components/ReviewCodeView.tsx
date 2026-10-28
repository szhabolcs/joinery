/**
 * The centre pane: one `CodeView` for the whole review — never one
 * `FileDiff` per file. Items are the file list, in reading-order-adjacent
 * sequence. The current step's title + explanation live in the reading-order
 * pane instead of a header here (see ReadingOrderPane.tsx); `lineAnnotations`
 * + `renderAnnotation` render inline comment threads; `enableGutterUtility`
 * + `onGutterUtilityClick` drive the hover `+` for starting a new thread;
 * the token events drive hover and peek-definition (CodeIntel.tsx).
 */
import { Checkbox } from '@base-ui-components/react/checkbox';
import { CodeView } from '@pierre/diffs/react';
import type { CodeViewAnnotationArgs, CodeViewReactOptions } from '@pierre/diffs/react';
import type { SelectedLineRange, CodeViewItem } from '@pierre/diffs';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { CODE_INTEL_CSS } from '../lib/codeIntel.ts';
import { makeLoadDiffFiles } from '../lib/diffLoader.ts';
import { canSwitchView, PREVIEW_ANNOTATION_ID, PREVIEW_CSS, previewKindOf, type FileView } from '../lib/preview.ts';
import { PREFERRED_HIGHLIGHTER } from '../lib/workerPool.tsx';
import {
  DRAFT_THREAD_ID,
  pathAtScrollTop,
  useReview,
  type ThreadAnnotationMeta,
} from '../state/ReviewContext.tsx';
import { useTheme } from '../state/ThemeContext.tsx';
import { useCodeIntel } from './CodeIntel.tsx';
import { CommentComposer } from './CommentComposer.tsx';
import { FilePreview } from './FilePreview.tsx';
import { ReviewFooter } from './ReviewFooter.tsx';
import { ReviewSummaryCard } from './ReviewSummaryCard.tsx';
import { useSelectionComment } from './SelectionComment.tsx';
import { ThreadArticle } from './ThreadArticle.tsx';
import { Hint, Segment, Segmented } from './controls.tsx';

/**
 * Diff density, in one place. These are *both* the `@pierre/diffs` CSS custom
 * properties we override and the `itemMetrics` we hand `CodeView` — they must
 * be the same numbers, which is why they are not written down twice.
 *
 * `CodeView` virtualizes the file list and computes every item's height
 * analytically from `itemMetrics`; `reconcileHeights()` only re-measures the
 * DOM for items that carry line annotations (see `VirtualizedFileDiff.js`,
 * the `overflow === 'scroll' && lineAnnotations.length === 0` early return),
 * so for an ordinary file these numbers are never corrected by measurement.
 * Overriding the density CSS without matching `itemMetrics` therefore
 * mis-sizes the whole scroll range — upstream says as much on
 * `VirtualFileMetrics.spacing` ("You should not change this from the default
 * if you aren't applying custom CSS"). The error is per-line and per-file, so
 * it accumulates downward and strands the *last* file: the scroll container
 * stops short of content that is laid out but unreachable.
 */
const DIFF_LINE_HEIGHT = 22;
/** Mirrors `--chrome-space-2` (src/styles/index.css); `--diffs-gap-block`. */
const DIFF_GAP_BLOCK = 8;
/**
 * Upstream's own header sizing is `min-height: calc(1lh + (gap * 3))` (see
 * `[data-diffs-header="default"]` in `@pierre/diffs/dist/style.js`), and its
 * default metric is exactly `20 + 8 * 3 = 44`. Deriving it the same way keeps
 * the two in step if the density above is ever retuned.
 */
const DIFF_HEADER_HEIGHT = DIFF_LINE_HEIGHT + DIFF_GAP_BLOCK * 3;

/**
 * Injected into every file item's shadow root. Each file becomes its own
 * card on the sunken shell (the centre pane has no island of its own, see
 * ReviewWindow.tsx) so file boundaries are unmistakable — previously the end
 * of one file ran straight into the next file's header on one continuous
 * surface. `clip-path` rather than `overflow: clip` so sticky headers keep
 * working. The frame matches `chrome-island` in styles/index.css, from the
 * same theme tokens (custom properties inherit into the shadow root). The
 * clip-path would cut off an outer ring or shadow, so the hairline is an
 * outline drawn 1px *inside* the edge (outlines paint over the content and
 * follow the radius), and the soft top sheen is an inset shadow on the
 * header. The card's surface is the islands' own: `--diffs-bg` (which the
 * library sets straight to the theme's background) is replaced by
 * `--chrome-bg` — the same editor background, copied there by
 * lib/deriveChrome.ts — so the two can't drift apart. Every derived diff
 * colour (context, separators, additions, deletions) follows from it.
 */
const FILE_CARD_CSS = `
:host {
  --diffs-bg: var(--chrome-bg);
  border-radius: 10px;
  clip-path: inset(0 round 10px);
  outline: 1px solid var(--chrome-island-ring, var(--chrome-border));
  outline-offset: -1px;
}
[data-diffs-header] {
  border-radius: 10px 10px 0 0;
  box-shadow: inset 0 40px 40px -40px var(--chrome-island-sheen, transparent);
}
/*
 * The fold chevron's ::after stretches over the whole header (see
 * renderHeaderPrefix), so its empty space folds the file. The text is lifted
 * above that layer so it stays selectable.
 */
[data-title],
[data-prev-name],
[data-additions-count],
[data-deletions-count] {
  position: relative;
  z-index: 1;
}
/*
 * Corner masks. While a header is stuck, the file's code scrolls up under
 * it and shows through the two rounded top corners (the header's own
 * background stops at its border). These paint the region *outside* each
 * corner arc in the shell colour, so the card keeps a clean rounded top at
 * every scroll position. Off-screen (unstuck) they sit over shell that is
 * already that colour, so they are invisible. --chrome-bg-sunken inherits
 * through the shadow roots like any custom property.
 */
[data-diffs-header]::before,
[data-diffs-header]::after {
  content: '';
  position: absolute;
  top: 0;
  width: 10px;
  height: 10px;
  pointer-events: none;
  z-index: 3;
}
[data-diffs-header]::before {
  left: 0;
  background: radial-gradient(circle at 100% 100%, transparent 9.5px, var(--chrome-bg-sunken) 10px);
}
[data-diffs-header]::after {
  right: 0;
  background: radial-gradient(circle at 0 100%, transparent 9.5px, var(--chrome-bg-sunken) 10px);
}
`;

export function ReviewCodeView(): React.JSX.Element {
  const {
    review,
    reviewState,
    fileList,
    isViewed,
    toggleViewed,
    items,
    diffStyle,
    threads,
    draftThread,
    startDraftThread,
    cancelDraftThread,
    submitDraftThread,
    reloadThreads,
    codeViewRef,
    toggleFileCollapsed,
    setScrolledPath,
    fileViewOf,
    setFileView,
  } = useReview();
  const { chromeMode } = useTheme();
  const { active: selectionOffered, trackItem, overlay: selectionOverlay } = useSelectionComment(startDraftThread);
  const { onTokenEnter, onTokenLeave, onTokenClick, onPostRender: codeIntelPostRender, overlay } = useCodeIntel({
    hoverSuppressed: selectionOffered,
  });
  const onPostRender = useCallback<typeof codeIntelPostRender>(
    (node, instance, phase, context) => {
      trackItem(node, phase, context.item.id);
      codeIntelPostRender(node, instance, phase, context);
    },
    [codeIntelPostRender, trackItem],
  );

  // `onScroll` below only fires once the reader scrolls, so take the first
  // reading here: the items mount a frame or more after `items` arrives
  // (virtualized, laid out by CodeView itself), so retry each frame until one
  // spans the top edge. Re-running on `items` also catches layout changes
  // that move the top without a scroll, e.g. folding a file.
  useEffect(() => {
    if (items.length === 0) return;
    let frame = 0;
    let tries = 0;
    const read = () => {
      const path = pathAtScrollTop(codeViewRef.current?.getInstance());
      if (path !== null) setScrolledPath(path);
      else if (++tries < 60) frame = requestAnimationFrame(read);
    };
    frame = requestAnimationFrame(read);
    return () => cancelAnimationFrame(frame);
  }, [items, codeViewRef, setScrolledPath]);

  // `pathAtScrollTop` reads layout, so the scroll handler runs it at most once
  // a frame rather than on every wheel event. A `null` reading (the edge sits
  // in the gap between two cards) keeps the last path instead of clearing it.
  const scrollFrameRef = useRef(0);
  useEffect(() => () => cancelAnimationFrame(scrollFrameRef.current), []);
  const onScroll = () => {
    if (scrollFrameRef.current !== 0) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = 0;
      const path = pathAtScrollTop(codeViewRef.current?.getInstance());
      if (path !== null) setScrolledPath(path);
    });
  };

  const loadDiffFiles = useMemo(
    () => makeLoadDiffFiles(review?.id ?? '', reviewState?.currentRevision),
    [review?.id, reviewState?.currentRevision],
  );

  const options = useMemo<CodeViewReactOptions<ThreadAnnotationMeta, undefined>>(
    () => ({
      diffStyle,
      // `CodeView` renders into its own shadow root and sets `:host {
      // color-scheme }` from `themeType`, which defaults to 'system' — i.e.
      // it follows the OS preference, NOT this app's chrome toggle. Without
      // this, flipping the app to light on a dark-mode machine leaves the
      // diff's own chrome (gutters, scrollbars, form controls) dark.
      themeType: chromeMode,
      // The pool's choice, for anything rendered before the pool is up.
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
      hunkSeparators: 'line-info',
      // Must agree with the CSS custom properties set on the host element
      // below — see the DIFF_* constants above for why.
      itemMetrics: {
        lineHeight: DIFF_LINE_HEIGHT,
        spacing: DIFF_GAP_BLOCK,
        diffHeaderHeight: DIFF_HEADER_HEIGHT,
      },
      // Logs an error whenever an item's reconciled height disagrees with its
      // real DOM height, i.e. exactly the drift above. Upstream gates this to
      // its own dev build too, since it measures on every reconcile.
      __devOnlyValidateItemHeights: import.meta.env.DEV,
      enableGutterUtility: true,
      // Click (and shift-click / drag) line numbers to select a range; `c`
      // then opens the composer on it (see useReviewShortcuts.ts). The
      // gutter `+` still starts a comment directly.
      enableLineSelection: true,
      // Upstream default is 100 lines per "more unchanged context" click —
      // too much to page through at once for this app's density.
      expansionLineCount: 20,
      stickyHeaders: true,
      disableVirtualizationBuffers: false,
      unsafeCSS: FILE_CARD_CSS + CODE_INTEL_CSS + PREVIEW_CSS,
      // Seams between file cards match the shell's 8px island gap.
      layout: { paddingTop: 0, paddingBottom: 80, gap: 8 },
      loadDiffFiles,
      onTokenEnter,
      onTokenLeave,
      onTokenClick,
      onPostRender,
      onGutterUtilityClick(range: SelectedLineRange, context) {
        startDraftThread({
          path: context.item.id,
          side: (range.side ?? 'additions') === 'deletions' ? 'old' : 'new',
          startLine: Math.min(range.start, range.end),
          endLine: Math.max(range.start, range.end),
        });
      },
    }),
    [chromeMode, diffStyle, loadDiffFiles, onPostRender, onTokenClick, onTokenEnter, onTokenLeave, startDraftThread],
  );

  const byPath = useMemo(() => new Map(fileList.map((f) => [f.path, f])), [fileList]);

  // Both read the review through `useReview()` themselves, so these callbacks
  // close over nothing and never go stale.
  const renderHeader = useCallback(() => <ReviewSummaryCard />, []);
  const renderFooter = useCallback(() => <ReviewFooter />, []);

  if (review === null) {
    return (
      <div className="flex h-full items-center justify-center text-body text-chrome-fg-muted">
        Loading review…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-body text-chrome-fg-muted">
        {reviewState?.merged === true
          ? `Merged into ${review.baseRef}, and there's no earlier base left to diff against.`
          : 'No changed files in this revision.'}
      </div>
    );
  }

  return (
    <>
      {overlay}
      {selectionOverlay}
      <CodeView<ThreadAnnotationMeta, undefined>
        ref={codeViewRef}
        items={items}
        options={options}
        renderCodeViewHeader={renderHeader}
        renderCodeViewFooter={renderFooter}
        // Lets the reading order follow along (it unfolds the step holding
        // the file being read). React bails out when the path is unchanged,
        // so this only re-renders as a new file reaches the top.
        onScroll={onScroll}
        // `--diffs-gap-block`/`--diffs-line-height` are `@pierre/diffs`' own
        // density knobs (see `dist/style.js`: `padding-block: var(--diffs-gap-block,
        // var(--diffs-gap-fallback))` at 8px, `line-height: var(--diffs-line-height, 20px)`)
        // — custom properties inherit through the shadow root the same way
        // `chromeToTreeStyles` feeds `--trees-theme-*` into `@pierre/trees`
        // (FileTreePane.tsx), so nudging them here loosens hunk/line spacing to
        // match the rest of the chrome's density pass without touching
        // internals we don't own.
        // They live here rather than in a Tailwind arbitrary-property class so
        // they and `options.itemMetrics` come from the same constants: the two
        // must never drift (see the DIFF_* constants above).
        //
        // `outline-hidden!`: `@pierre/diffs` gives this scroll container its
        // own `tabIndex={-1}` (so it has somewhere to send focus back to if a
        // focused, virtualized item gets recycled out from under it) — but a
        // plain click anywhere in here that doesn't land on a real focusable
        // descendant also focuses this same container per the browser's
        // nearest-focusable-ancestor fallback, and any key pressed afterwards
        // (not just a shortcut aimed at this pane) then paints the app-wide
        // `:focus-visible` ring around the *entire* pane. That's just noise —
        // this container was never a Tab stop (`-1`) and isn't one of our own
        // keyboard-shortcut landing targets, so there's no case where its own
        // outline is informative. Real focusable descendants (e.g. the
        // "Viewed" button below) are separate elements and keep their own
        // ring untouched. `!` is needed to beat the unlayered `:focus-visible`
        // rule in styles/index.css — see the identical workaround note in
        // CommandPalette.tsx.
        className="h-full w-full outline-hidden!"
        style={
          {
            height: '100%',
            overflow: 'auto',
            '--diffs-gap-block': `${DIFF_GAP_BLOCK}px`,
            '--diffs-line-height': `${DIFF_LINE_HEIGHT}px`,
            // File headers are chrome, not code: they take the UI face so the
            // path reads as a title rather than another line of monospace.
            '--diffs-header-font-family': 'var(--chrome-font-sans)',
            '--diffs-font-family': 'var(--chrome-font-mono)',
            '--diffs-font-size': '12.5px',
          } as React.CSSProperties
        }
        // The right-hand side of each file's title bar: the Diff/Preview
        // switch for a file that has both, then the GitHub-style "viewed"
        // check. Kept to a single compact row so it stays inside the header's
        // `1lh + gap * 3` min-height — a taller control here would silently
        // invalidate DIFF_HEADER_HEIGHT above.
        renderHeaderMetadata={(item: CodeViewItem<ThreadAnnotationMeta>) => {
          const entry = byPath.get(item.id);
          if (entry === undefined) return null;
          const viewed = isViewed(entry);
          const kind = previewKindOf(entry.path);
          const view = fileViewOf(entry.path);
          return (
            <div className="flex items-center gap-2">
              {kind !== null && view !== null && canSwitchView(kind) && (
                <Segmented<FileView>
                  value={view}
                  onChange={(next) => setFileView(entry.path, next)}
                  aria-label={`View of ${entry.path}`}
                  className="relative z-1 flex shrink-0 gap-0.5 font-sans"
                >
                  <Segment value="diff">Diff</Segment>
                  <Segment value="preview">Preview</Segment>
                </Segmented>
              )}
              <Hint label={viewed ? 'Viewed — unchecks itself when this file changes' : 'Mark as viewed'}>
                <Checkbox.Root
                  checked={viewed}
                  onCheckedChange={() => void toggleViewed(entry.path)}
                  className="relative z-1 flex h-6 shrink-0 select-none items-center gap-1.5 rounded-md px-2 font-sans text-xs text-chrome-fg-muted transition-colors not-data-checked:hover:bg-chrome-bg-hover not-data-checked:hover:text-chrome-fg data-checked:bg-chrome-success-bg data-checked:text-chrome-success"
                >
                  <Check size={12} strokeWidth={viewed ? 2.5 : 1.75} aria-hidden />
                  Viewed
                </Checkbox.Root>
              </Hint>
            </div>
          );
        }}
        renderHeaderPrefix={(item: CodeViewItem<ThreadAnnotationMeta>) => (
          <Hint label={item.collapsed === true ? `Expand ${item.id}` : `Collapse ${item.id}`}>
            <button
              type="button"
              onClick={() => toggleFileCollapsed(item.id)}
              aria-label={item.collapsed === true ? `Expand ${item.id}` : `Collapse ${item.id}`}
              aria-expanded={item.collapsed !== true}
              // `after:` stretches the hit area over the whole header (the
              // nearest positioned ancestor), so its empty space folds the file
              // too; the title, counts, and "Viewed" sit above it.
              className="chrome-icon-btn -ml-1 size-6 text-chrome-fg-subtle after:absolute after:inset-0 after:cursor-pointer"
            >
              {item.collapsed === true ? (
                <ChevronRight size={14} strokeWidth={1.5} aria-hidden />
              ) : (
                <ChevronDown size={14} strokeWidth={1.5} aria-hidden />
              )}
            </button>
          </Hint>
        )}
        renderAnnotation={(...[annotation, , item]: CodeViewAnnotationArgs<ThreadAnnotationMeta>) => {
          const meta = annotation.metadata;
          if (meta === undefined) return null;
          if (meta.threadId === PREVIEW_ANNOTATION_ID) {
            const entry = byPath.get(item.id);
            return entry === undefined ? null : <FilePreview entry={entry} />;
          }
          if (meta.threadId === DRAFT_THREAD_ID) {
            return (
              <div className="my-2 w-full max-w-2xl font-sans">
                <CommentComposer
                  // A new draft (e.g. a second selection) starts from its own prefill.
                  key={`${draftThread?.path}:${draftThread?.side}:${draftThread?.endLine}:${draftThread?.body ?? ''}`}
                  initialValue={draftThread?.body ?? ''}
                  placeholder="Comment on this line…"
                  onSubmit={(body, ask) => void submitDraftThread(body, ask)}
                  onCancel={cancelDraftThread}
                />
              </div>
            );
          }
          const thread = threads.find((t) => t.id === meta.threadId);
          if (thread === undefined) return null;
          return <ThreadArticle thread={thread} onChanged={() => void reloadThreads()} />;
        }}
      />
    </>
  );
}
