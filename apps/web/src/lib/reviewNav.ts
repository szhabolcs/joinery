/**
 * Pure derivations behind the review window's navigation shortcuts (`j`/`k` hunks, `n`/`p` steps, `]`/`[` threads). Kept free of React and the
 * DOM so the ordering rules live in one place; `useReviewShortcuts` does the
 * actual scrolling.
 */
import type { CodeViewDiffItem, Hunk, SelectionSide } from '@pierre/diffs';
import type { ReadingOrder, Thread } from '@joinery/core';
import { isPreviewDiff } from './preview.ts';

type ReadingOrderStep = ReadingOrder['steps'][number];

/**
 * Which reading-order step the reader is on. The explicit `currentStepId`
 * (set by `n`/`p` or a click inside a step) wins while the selected file is
 * still one of its files; once the reader has moved to a file elsewhere
 * (file tree, thread jump, `j`/`k`) the first step containing that file takes
 * over. `-1` when neither identifies a step.
 */
export function resolveCurrentStepIndex(
  steps: readonly ReadingOrderStep[],
  currentStepId: string | null,
  selectedPath: string | null,
): number {
  const byId = currentStepId === null ? -1 : steps.findIndex((s) => s.id === currentStepId);
  const hasSelected = (i: number) => steps[i]?.files.some((f) => f.path === selectedPath) === true;
  if (byId !== -1 && (selectedPath === null || hasSelected(byId))) return byId;
  if (selectedPath !== null) {
    const bySelection = steps.findIndex((s) => s.files.some((f) => f.path === selectedPath));
    if (bySelection !== -1) return bySelection;
  }
  return byId;
}

/**
 * Threads in file order: the diff's own item order, then the line the
 * card renders under (`endLine` — see `buildAnnotationsFor`), then
 * old-side before new-side on the same line. Threads on paths not in the
 * current file list sort last.
 */
export function threadsInFileOrder(threads: readonly Thread[], order: readonly string[]): Thread[] {
  const pos = new Map(order.map((path, i) => [path, i]));
  return [...threads].sort((a, b) => compareThreads(a, b, pos));
}

function compareThreads(a: Thread, b: Thread, pos: ReadonlyMap<string, number>): number {
  const pa = pos.get(a.path) ?? Number.MAX_SAFE_INTEGER;
  const pb = pos.get(b.path) ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.endLine !== b.endLine) return a.endLine - b.endLine;
  if (a.startLine !== b.startLine) return a.startLine - b.startLine;
  if (a.side !== b.side) return a.side === 'old' ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The open thread after (`+1`) or before (`-1`) `fromId` in file order,
 * wrapping at either end. `fromId` may itself be resolved (e.g. just resolved
 * with `r`) — it's still used as the position to continue from. With no
 * `fromId`, `+1` starts at the first open thread and `-1` at the last.
 */
export function adjacentOpenThread(
  threads: readonly Thread[],
  order: readonly string[],
  fromId: string | null,
  delta: 1 | -1,
): Thread | null {
  const open = threadsInFileOrder(
    threads.filter((t) => t.status === 'open'),
    order,
  );
  if (open.length === 0) return null;
  const from = fromId === null ? undefined : threads.find((t) => t.id === fromId);
  if (from === undefined) return (delta > 0 ? open[0] : open[open.length - 1]) ?? null;
  const pos = new Map(order.map((path, i) => [path, i]));
  if (delta > 0) {
    return open.find((t) => t.id !== from.id && compareThreads(t, from, pos) > 0) ?? open[0] ?? null;
  }
  for (let i = open.length - 1; i >= 0; i--) {
    const t = open[i];
    if (t !== undefined && t.id !== from.id && compareThreads(t, from, pos) < 0) return t;
  }
  return open[open.length - 1] ?? null;
}

/** A hunk as a scroll target: its file, index in `fileDiff.hunks`, and first changed line. */
export interface HunkTarget {
  path: string;
  hunkIndex: number;
  lineNumber: number;
  side: SelectionSide;
}

/**
 * The first changed line of a hunk — the line `j`/`k` lands on, rather than
 * the hunk's leading context. Additions side when the first change block
 * adds anything, else the deletions side (a pure removal).
 */
export function firstChangedLine(hunk: Hunk): { lineNumber: number; side: SelectionSide } {
  let addLine = hunk.additionStart;
  let delLine = hunk.deletionStart;
  for (const content of hunk.hunkContent) {
    if (content.type === 'context') {
      addLine += content.lines;
      delLine += content.lines;
      continue;
    }
    return content.additions > 0
      ? { lineNumber: addLine, side: 'additions' }
      : { lineNumber: delLine, side: 'deletions' };
  }
  return hunk.additionCount > 0
    ? { lineNumber: hunk.additionStart, side: 'additions' }
    : { lineNumber: hunk.deletionStart, side: 'deletions' };
}

/**
 * Every navigable hunk across the review, in item order. Collapsed files
 * are skipped (their hunks aren't on screen), as are files whose patch hasn't
 * loaded yet (placeholders carry no hunks).
 */
export function hunkTargets<T>(items: readonly CodeViewDiffItem<T>[]): HunkTarget[] {
  const out: HunkTarget[] = [];
  for (const item of items) {
    // A preview's one hunk is a hidden stub, nothing to land on.
    if (item.collapsed === true || isPreviewDiff(item.fileDiff)) continue;
    item.fileDiff.hunks.forEach((hunk, hunkIndex) => {
      out.push({ path: item.id, hunkIndex, ...firstChangedLine(hunk) });
    });
  }
  return out;
}

/**
 * Index into `hunks` of the hunk containing (or nearest after) `line` — used
 * to find "the hunk at the cursor" from a line selection.
 */
export function hunkIndexForLine(hunks: readonly Hunk[], line: number, side: SelectionSide): number {
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    if (h === undefined) continue;
    const start = side === 'deletions' ? h.deletionStart : h.additionStart;
    const count = side === 'deletions' ? h.deletionCount : h.additionCount;
    if (line < start + count) return i;
  }
  return Math.max(hunks.length - 1, 0);
}
