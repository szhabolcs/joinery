/**
 * The review window's navigation and diff-action shortcuts: the
 * `KeymapActions` that need more than a one-line call into `ReviewContext` —
 * hunks (`j`/`k`, `e`, `Shift+E`), steps (`n`/`p`), threads (`]`/`[`, `r`)
 * and commenting on a line selection (`c`). `ReviewWindow` spreads the
 * result into `useGlobalKeymap`.
 *
 * Everything here goes through `CodeView`'s public handle (`scrollTo`,
 * `getSelectedLines`, `getInstance().getRenderedItems()`); the one reach
 * past `CodeViewHandle` is calling `expandHunk` on a *rendered* item's
 * `VirtualizedFileDiff` instance — the same method Pierre's own hunk
 * separator ("N unchanged lines") calls when clicked.
 */
import { useRef } from 'react';
import type { CodeViewDiffItem, SelectionSide } from '@pierre/diffs';
import type { KeymapActions } from '../lib/keymap.ts';
import { callApi } from '../lib/apiClient.ts';
import {
  adjacentOpenThread,
  hunkIndexForLine,
  hunkTargets,
  resolveCurrentStepIndex,
  type HunkTarget,
} from '../lib/reviewNav.ts';
import { captureTopVisiblePath, useReview, type ThreadAnnotationMeta } from './ReviewContext.tsx';

/**
 * How far one `e` press opens the gap on each side of the current hunk.
 * Matches `expansionLineCount` in ReviewCodeView.tsx (one separator click).
 */
const EXPAND_STEP = 20;
/** "Everything": regions are clamped to their real size by Pierre. */
const EXPAND_ALL = 1_000_000_000;
/** Frames to wait for a just-scrolled-to file to render before giving up. */
const RENDER_WAIT_FRAMES = 30;

type ExpandableInstance = {
  expandHunk: (hunkIndex: number, direction: 'up' | 'down' | 'both', count?: number) => void;
};

type ShortcutActions = Pick<
  KeymapActions,
  | 'nextHunk'
  | 'prevHunk'
  | 'nextStep'
  | 'prevStep'
  | 'nextThread'
  | 'prevThread'
  | 'commentOnSelection'
  | 'resolveThread'
  | 'expandHunk'
  | 'expandWholeFile'
>;

export function useReviewShortcuts(): ShortcutActions {
  const review = useReview();
  const {
    items,
    threads,
    readingOrder,
    selectedPath,
    setSelectedPath,
    currentStepId,
    setCurrentStepId,
    activeThreadId,
    setActiveThreadId,
    codeViewRef,
    expandFileForNavigation,
    showDiff,
    startDraftThread,
    reloadThreads,
  } = review;

  /**
   * The hunk `j`/`k` last landed on — the "cursor" for `e`. Only trusted
   * while its file is still the selected one: selecting a different file any
   * other way (tree, step, thread) restarts hunk navigation from that file.
   */
  const hunkCursorRef = useRef<{ path: string; hunkIndex: number } | null>(null);

  const order = items.map((i) => i.id);

  /** The file the reader is on: the selection, else the topmost visible file. */
  const focusedPath = (): string | null => {
    if (selectedPath !== null && order.includes(selectedPath)) return selectedPath;
    return captureTopVisiblePath(codeViewRef.current) ?? order[0] ?? null;
  };

  const reveal = (path: string) => {
    setSelectedPath(path);
    expandFileForNavigation(path);
  };

  const scrollToLine = (path: string, lineNumber: number, side: SelectionSide) => {
    codeViewRef.current?.scrollTo({ type: 'line', id: path, lineNumber, side, align: 'center' });
  };

  // ── hunks ────────────────────────────────────────────────────────────
  const goHunk = (delta: 1 | -1) => {
    const targets = hunkTargets(items);
    if (targets.length === 0) return;
    const cursor = hunkCursorRef.current;
    let next: HunkTarget | undefined;
    const at =
      cursor !== null && cursor.path === selectedPath
        ? targets.findIndex((t) => t.path === cursor.path && t.hunkIndex === cursor.hunkIndex)
        : -1;
    if (at !== -1) {
      next = targets[at + delta];
      if (next === undefined) return; // At the first/last hunk: stay put.
    } else {
      // No cursor yet (or the reader moved on): start at the focused file's
      // first hunk, or the first hunk of the next file that has any.
      const anchor = focusedPath();
      const anchorIdx = anchor === null ? 0 : Math.max(order.indexOf(anchor), 0);
      next = targets.find((t) => order.indexOf(t.path) >= anchorIdx) ?? targets[targets.length - 1];
    }
    if (next === undefined) return;
    hunkCursorRef.current = { path: next.path, hunkIndex: next.hunkIndex };
    setSelectedPath(next.path);
    scrollToLine(next.path, next.lineNumber, next.side);
  };

  // ── steps ────────────────────────────────────────────────────────────
  const goStep = (delta: 1 | -1) => {
    const steps = readingOrder?.steps ?? [];
    if (steps.length === 0) return;
    const current = resolveCurrentStepIndex(steps, currentStepId, selectedPath);
    const nextIdx =
      current === -1 ? (delta > 0 ? 0 : steps.length - 1) : Math.min(Math.max(current + delta, 0), steps.length - 1);
    if (nextIdx === current) return;
    const step = steps[nextIdx];
    if (step === undefined) return;
    setCurrentStepId(step.id);
    const first = step.files[0];
    if (first === undefined) return;
    reveal(first.path);
    codeViewRef.current?.scrollTo({ type: 'item', id: first.path, align: 'start' });
  };

  // ── threads ──────────────────────────────────────────────────────────
  const goThread = (delta: 1 | -1) => {
    const next = adjacentOpenThread(threads, order, activeThreadId, delta);
    if (next === null) return;
    setActiveThreadId(next.id);
    reveal(next.path);
    // The card renders under the thread's last line, so centre on that.
    void showDiff(next.path).then(() =>
      scrollToLine(next.path, next.endLine, next.side === 'old' ? 'deletions' : 'additions'),
    );
  };

  const resolveThread = () => {
    const thread = threads.find((t) => t.id === activeThreadId);
    if (thread === undefined || thread.status !== 'open') return;
    void callApi('resolveThread', { params: [thread.id], body: { resolved: true } })
      .then(() => reloadThreads())
      .catch(() => {
        // Nothing to roll back: the thread simply stays open.
      });
  };

  // ── commenting ───────────────────────────────────────────────────────
  const commentOnSelection = () => {
    const selection = codeViewRef.current?.getSelectedLines();
    if (selection === null || selection === undefined) return;
    const { range } = selection;
    startDraftThread({
      path: selection.id,
      side: (range.side ?? 'additions') === 'deletions' ? 'old' : 'new',
      startLine: Math.min(range.start, range.end),
      endLine: Math.max(range.start, range.end),
    });
  };

  // ── expanding context ────────────────────────────────────────────────
  /**
   * Runs `fn` against `path`'s rendered diff instance. Expansion state lives
   * on that instance (not on our item), and only rendered items expose one
   * publicly — so an off-screen target is scrolled to first and retried
   * for a few frames until the virtualizer mounts it.
   */
  const withRenderedDiff = (
    path: string,
    fn: (instance: ExpandableInstance, item: CodeViewDiffItem<ThreadAnnotationMeta>) => void,
  ) => {
    const find = () => {
      for (const r of codeViewRef.current?.getInstance()?.getRenderedItems() ?? []) {
        if (r.id === path && r.type === 'diff') return { instance: r.instance, item: r.item };
      }
      return undefined;
    };
    const now = find();
    if (now !== undefined) {
      fn(now.instance, now.item);
      return;
    }
    codeViewRef.current?.scrollTo({ type: 'item', id: path, align: 'start' });
    let frames = 0;
    const retry = () => {
      const r = find();
      if (r !== undefined) {
        fn(r.instance, r.item);
        return;
      }
      if (++frames < RENDER_WAIT_FRAMES) requestAnimationFrame(retry);
    };
    requestAnimationFrame(retry);
  };

  /** The hunk `e` acts on in `path`: the `j`/`k` cursor, else the selection's hunk, else the first. */
  const cursorHunkIn = (path: string, item: CodeViewDiffItem<ThreadAnnotationMeta>): number => {
    const cursor = hunkCursorRef.current;
    if (cursor !== null && cursor.path === path) return cursor.hunkIndex;
    const selection = codeViewRef.current?.getSelectedLines();
    if (selection !== null && selection !== undefined && selection.id === path) {
      const side = selection.range.side ?? 'additions';
      return hunkIndexForLine(item.fileDiff.hunks, Math.min(selection.range.start, selection.range.end), side);
    }
    return 0;
  };

  const expandHunk = () => {
    const path = focusedPath();
    if (path === null) return;
    expandFileForNavigation(path);
    withRenderedDiff(path, (instance, item) => {
      const hunks = item.fileDiff.hunks;
      if (hunks.length === 0) return;
      const i = Math.min(cursorHunkIn(path, item), hunks.length - 1);
      // Pierre indexes the gap *before* hunk `i` as region `i` (the gap after
      // the last hunk is region `hunks.length`). `'down'` grows a region from
      // its bottom edge — the lines just above hunk `i`; `'up'` grows it from
      // its top edge — the lines just below the previous hunk. So: open the
      // gap above this hunk from below, and the gap below it from above.
      if ((hunks[i]?.collapsedBefore ?? 0) > 0) instance.expandHunk(i, 'down', EXPAND_STEP);
      instance.expandHunk(i + 1, 'up', EXPAND_STEP);
    });
  };

  const expandWholeFile = () => {
    const path = focusedPath();
    if (path === null) return;
    expandFileForNavigation(path);
    withRenderedDiff(path, (instance, item) => {
      const hunks = item.fileDiff.hunks;
      if (hunks.length === 0) return;
      for (let i = 0; i <= hunks.length; i++) instance.expandHunk(i, 'up', EXPAND_ALL);
    });
  };

  return {
    nextHunk: () => goHunk(1),
    prevHunk: () => goHunk(-1),
    nextStep: () => goStep(1),
    prevStep: () => goStep(-1),
    nextThread: () => goThread(1),
    prevThread: () => goThread(-1),
    commentOnSelection,
    resolveThread,
    expandHunk,
    expandWholeFile,
  };
}
