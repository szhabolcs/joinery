/**
 * Language intelligence in the diff, from the language server the server runs
 * against the review's checkout (see apps/server/src/lsp):
 *
 * - hover a name → a small popover with its signature and docblock;
 * - ⌘-click it (Ctrl-click elsewhere), or "Definition and uses" in that
 *   popover → the peek window (PeekNavigator.tsx): the definition, its
 *   implementations and every use on the left, the chosen file on the right, where hover and ⌘-click
 *   work again and step through a history of their own;
 * - ⌘⇧-click it (Ctrl⇧-click elsewhere) → straight to what the peek would
 *   open on, with no window: the diff scrolls to it (unfolding the file and
 *   its unchanged context as needed) when it's on the head side of a file
 *   this review changes; anywhere else, or with several implementations to
 *   choose from, the peek opens instead. Each jump is kept in a short
 *   history of `(path, side, line)` anchors that ⌘[ / ⌘] and a mouse's
 *   back/forward buttons step through. The reader starts every jump, so
 *   it's no exception to "never auto-scroll" (ARCHITECTURE.md);
 * - double-click it → every place it appears in that file is marked, from
 *   the server's `documentHighlight` (one file, so cheap); a click elsewhere
 *   or Esc clears them.
 *
 * Tokens come from `@pierre/diffs`' own token events (`onTokenEnter` and
 * friends, enabled by `useTokenTransformer` in lib/workerPool.tsx), which
 * already carry the line number, side, and character span — no hit-testing.
 * Only the head side has positions the server knows: additions and context
 * lines, plus, in split view, a context line's left copy (mapped to its
 * right-hand twin). A deleted line has no head position and gets nothing.
 *
 * Hover cards can be turned off (Settings → Language servers); the peek
 * window can't, it only opens on purpose.
 *
 * Nothing here can hold up the diff: requests start after a hover rests for
 * the delay set in Settings (300 ms by default), the previous one is aborted when the pointer moves on (the
 * server forwards that as `$/cancelRequest`), and answers are cached per
 * (file blob, line, token), which is immutable, for the life of the page.
 */
import type { DiffTokenEventBaseProps, PostRenderPhase, TokenEventBase } from '@pierre/diffs';
import type { LspDefinition, LspFile, LspHighlight, LspHover, LspLanguage, LspReferences } from '@joinery/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { callApi } from '../lib/apiClient.ts';
import {
  cached,
  getHoverDelay,
  getHoverEnabled,
  getImplementationJump,
  IS_MAC,
  JUMP_KEY,
  PEEK_KEY,
  placement,
} from '../lib/codeIntel.ts';
import { isEditableTarget, resolveEventTarget } from '../lib/keymapGuard.ts';
import { useReview } from '../state/ReviewContext.tsx';
import { Markdown } from './Markdown.tsx';
import {
  otherImplementations,
  PeekNavigator,
  useHistorySteps,
  type Load,
  type Nav,
  type NavEntry,
} from './PeekNavigator.tsx';

/** Grace to move the pointer from the token onto the popover. */
const CLOSE_DELAY_MS = 150;
/** How long the line a jump lands on stays highlighted. */
const JUMP_HIGHLIGHT_MS = 1_600;
/** How long "No definition found" stays by the token. */
const MISSING_MS = 1_500;
/** Anchors kept in the diff's jump history. */
const JUMP_HISTORY_LIMIT = 50;
const SUPPORTED = /\.(?:[cm]?[jt]sx?|php)$/i;
/** A token worth asking about has a letter, `_` or `$` in it — not `(`, `=>`, `42`. */
const NAME_LIKE = /[\p{L}_$]/u;

const hoverCache = new Map<string, Promise<LspHover | null>>();
// Whole answers, `off` included; an answer saying the server is off isn't kept, so turning it on takes effect.
const definitionCache = new Map<string, Promise<{ definition: LspDefinition | null; off: LspLanguage | null }>>();
const referencesCache = new Map<string, Promise<{ references: LspReferences | null; off: LspLanguage | null }>>();
const implementationsCache = new Map<string, Promise<{ implementations: LspReferences | null; off: LspLanguage | null }>>();
const highlightsCache = new Map<string, Promise<LspHighlight[]>>();

type TokenProps = TokenEventBase & Partial<Pick<DiffTokenEventBaseProps, 'side'>>;
type TokenContext = { item: { id: string } };
type HeadPosition = { line: number; character: number };
type PositionQuery = { path: string; line: number; character: number };

/** A place in the diff a jump lands on or leaves from, like the anchor updates restore. */
type Anchor = { path: string; side: 'additions'; line: number };
type Jumps = { entries: Anchor[]; index: number };

function sameAnchor(a: Anchor | undefined, b: Anchor): boolean {
  return a !== undefined && a.path === b.path && a.side === b.side && a.line === b.line;
}

/** What a rendered file in the diff (`@pierre/diffs`' VirtualizedFileDiff) offers for unfolding a line. */
type DiffInstance = {
  isLineRenderable: (line: number) => boolean;
  revealLine: (line: number) => boolean;
  expandHunk: (hunkIndex: number, direction: 'up' | 'down' | 'both', count?: number) => void;
};

function isDiffInstance(value: unknown): value is DiffInstance {
  return typeof value === 'object' && value !== null && 'revealLine' in value && 'isLineRenderable' in value && 'expandHunk' in value;
}

/** Resolves true once `ready()` holds, checked every frame, or false after `ms`. */
function untilReady(ready: () => boolean, ms = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const until = performance.now() + ms;
    const check = () => {
      if (ready()) resolve(true);
      else if (performance.now() > until) resolve(false);
      else requestAnimationFrame(check);
    };
    check();
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// An answer saying the server is off is dropped from the cache, so turning it on takes effect.
function definitionOf(reviewId: string, key: string, query: PositionQuery) {
  const answer = cached(definitionCache, key, () => callApi('getDefinition', { params: [reviewId], query }));
  answer.then(({ off }) => off !== null && definitionCache.delete(key), () => undefined);
  return answer;
}

function implementationsOf(reviewId: string, key: string, query: PositionQuery) {
  const answer = cached(implementationsCache, key, () => callApi('getImplementations', { params: [reviewId], query }));
  answer.then(({ off }) => off !== null && implementationsCache.delete(key), () => undefined);
  return answer;
}

function referencesOf(reviewId: string, key: string, query: PositionQuery) {
  const answer = cached(referencesCache, key, () => callApi('getReferences', { params: [reviewId], query }));
  answer.then(({ off }) => off !== null && referencesCache.delete(key), () => undefined);
  return answer;
}

/** Where a token sits on the head side, or null when it only exists in the base. */
function headPosition(props: TokenProps): HeadPosition | null {
  // Middle of the name, robust to a server strict about name boundaries. The
  // highlighter may fold surrounding whitespace into a token (`"const "`).
  const lead = props.tokenText.length - props.tokenText.trimStart().length;
  const name = props.tokenText.trim().length;
  const character = props.lineCharStart + lead + Math.floor((name - 1) / 2);
  if (props.side !== 'deletions') return { line: props.lineNumber, character };
  const row = props.tokenElement.closest('[data-line]');
  if (row?.getAttribute('data-line-type')?.startsWith('context') !== true) return null;
  // `data-line-index` is "<unified>,<split>"; the two columns share the split row.
  const splitIndex = row.getAttribute('data-line-index')?.split(',')[1];
  if (splitIndex === undefined) return null;
  const twin = row
    .closest('pre')
    ?.querySelector(`[data-additions] [data-line][data-line-index$=",${CSS.escape(splitIndex)}"]`);
  const line = Number(twin?.getAttribute('data-line'));
  return Number.isInteger(line) && line > 0 ? { line, character } : null;
}

function rootOf(node: HTMLElement): ParentNode {
  return node.shadowRoot ?? node;
}

function unmarkOccurrences(node: HTMLElement): void {
  for (const el of rootOf(node).querySelectorAll('[data-lsp-occurrence]')) el.removeAttribute('data-lsp-occurrence');
}

/**
 * Marks the tokens covering `ranges` in a rendered file: head-side rows only
 * (not deleted lines, nor the base column in split view), and every token
 * overlapping a range, since the highlighter's tokens needn't match it exactly.
 */
function markOccurrences(node: HTMLElement, ranges: readonly LspHighlight[]): void {
  const root = rootOf(node);
  for (const range of ranges) {
    for (const row of root.querySelectorAll(`[data-line="${range.line}"]:not([data-line-type="change-deletion"])`)) {
      if (row.closest('[data-deletions]') !== null) continue;
      for (const token of row.querySelectorAll('[data-char]')) {
        const text = token.textContent ?? '';
        const start = Number(token.getAttribute('data-char')) + text.length - text.trimStart().length;
        const end = start + text.trim().length;
        if (start < range.end && end > range.start) token.setAttribute('data-lsp-occurrence', '');
      }
    }
  }
}

/**
 * A token to ask about. `path` is what the server resolves: a diff path, or a
 * file's `ref` when the token is in the peek window's preview (`inPreview`).
 * `version` names the text it was read from (a blob, or the preview's text).
 */
type Target = {
  path: string;
  version: string;
  pos: HeadPosition;
  tokenStart: number;
  element: HTMLElement;
  name: string;
  inPreview: boolean;
};

type HoverCard = { target: Target; rect: DOMRect; hover: LspHover };

const LOADING = { status: 'loading' } as const;

function failed(err: unknown): Load<never> {
  return { status: 'error', message: err instanceof Error ? err.message : String(err) };
}

/**
 * What an entry opens on, once enough is in to tell (null until then): the
 * only implementation when there's one and Settings says to jump to it, else
 * the definition, else the first implementation or use.
 */
function autoSelected(e: NavEntry): NavEntry['selected'] {
  const jump = getImplementationJump();
  if (jump && e.implementations.status === 'loading') return null;
  const implementations = otherImplementations(e);
  const [only] = implementations;
  if (jump && implementations.length === 1 && only !== undefined) return { ref: only.ref, line: only.line };
  if (e.definition.status === 'loading') return null;
  if (e.definition.status === 'ready' && e.definition.value !== null) {
    return { ref: e.definition.value.ref, line: e.definition.value.line };
  }
  if (e.implementations.status === 'loading') return null;
  const first = implementations[0] ?? (e.references.status === 'ready' ? e.references.value?.references[0] : undefined);
  if (first !== undefined) return { ref: first.ref, line: first.line };
  return null;
}

export function useCodeIntel({ hoverSuppressed = false }: { hoverSuppressed?: boolean } = {}): {
  onTokenEnter: (props: TokenProps, event: PointerEvent, context: TokenContext) => void;
  onTokenLeave: (props: TokenProps, event: PointerEvent, context: TokenContext) => void;
  onTokenClick: (props: TokenProps, event: MouseEvent, context: TokenContext) => void;
  onPostRender: (node: HTMLElement, instance: unknown, phase: PostRenderPhase, context: TokenContext) => void;
  overlay: React.ReactNode;
} {
  const { review, fileList, items, codeViewRef, expandFileForNavigation } = useReview();
  const reviewId = review?.id ?? '';
  const blobs = useMemo(() => new Map(fileList.map((f) => [f.path, f.newBlob])), [fileList]);

  const [card, setCard] = useState<HoverCard | null>(null);
  const [nav, setNav] = useState<Nav | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const current = useRef<Target | null>(null);
  const modifierDown = useRef(false);
  const entryIds = useRef(0);
  /** Each file's rendered node in the diff, to mark occurrences in. */
  const containers = useRef(new Map<string, HTMLElement>());
  /** The double-clicked symbol's places in its file, kept marked across re-renders. */
  const occurrences = useRef<{ path: string; ranges: LspHighlight[] } | null>(null);
  const occurrencesRequest = useRef<AbortController | null>(null);
  /** Each file's rendered instance in the diff, to unfold a jump's line in. */
  const instances = useRef(new Map<string, DiffInstance>());
  /** Where in the diff the open peek window was opened from, for the jump history. */
  const peekFrom = useRef<Anchor | null>(null);
  const [jumps, setJumps] = useState<Jumps | null>(null);
  const jumpsRef = useRef(jumps);
  jumpsRef.current = jumps;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  /** Bumped by each jump and each direct lookup, so a slower earlier one gives way. */
  const revealSeq = useRef(0);
  const directSeq = useRef(0);
  const [missing, setMissing] = useState<{ rect: DOMRect; text: string } | null>(null);

  const keyOf = useCallback(
    (t: Target) => `${reviewId}:${t.path}:${t.version}:${t.pos.line}:${t.tokenStart}`,
    [reviewId],
  );

  const setLink = (element: HTMLElement | undefined, on: boolean) => {
    if (on) element?.setAttribute('data-lsp-link', '');
    else element?.removeAttribute('data-lsp-link');
  };

  const cancelHover = useCallback(() => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    inflight.current?.abort();
    inflight.current = null;
  }, []);

  const scheduleClose = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setCard(null), CLOSE_DELAY_MS);
  }, []);

  // Held off while the selection's comment button is up (SelectionComment.tsx),
  // so a card can't open over it; one already open closes.
  const suppressed = useRef(hoverSuppressed);
  suppressed.current = hoverSuppressed;
  useEffect(() => {
    if (!hoverSuppressed) return;
    cancelHover();
    setCard(null);
  }, [hoverSuppressed, cancelHover]);

  const keepOpen = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const diffTarget = useCallback(
    (props: TokenProps, context: TokenContext): Target | null => {
      const path = context.item.id;
      const blob = blobs.get(path);
      if (reviewId === '' || blob === undefined || !SUPPORTED.test(path) || !NAME_LIKE.test(props.tokenText)) return null;
      const pos = headPosition(props);
      if (pos === null) return null;
      const name = props.tokenText.trim();
      return { path, version: blob, pos, tokenStart: props.lineCharStart, element: props.tokenElement, name, inPreview: false };
    },
    [blobs, reviewId],
  );

  const previewTarget = useCallback(
    (props: TokenProps, file: LspFile): Target | null => {
      if (reviewId === '' || !SUPPORTED.test(file.path) || !NAME_LIKE.test(props.tokenText)) return null;
      const pos = headPosition(props);
      if (pos === null) return null;
      return {
        path: file.ref,
        version: `${file.text.length}:${file.truncated}`,
        pos,
        tokenStart: props.lineCharStart,
        element: props.tokenElement,
        name: props.tokenText.trim(),
        inPreview: true,
      };
    },
    [reviewId],
  );

  const enter = useCallback(
    (target: Target | null, event: PointerEvent) => {
      cancelHover();
      current.current = target;
      if (target === null) return;
      setLink(target.element, event.metaKey || event.ctrlKey || modifierDown.current);
      // Hover cards turned off in Settings; ⌘-click still peeks.
      if (!getHoverEnabled() || suppressed.current) return;
      const key = keyOf(target);
      hoverTimer.current = setTimeout(() => {
        hoverTimer.current = null;
        const controller = new AbortController();
        inflight.current = controller;
        cached(hoverCache, key, () =>
          callApi('getHover', {
            params: [reviewId],
            query: { path: target.path, line: target.pos.line, character: target.pos.character },
            signal: controller.signal,
          }).then((r) => r.hover),
        )
          .then((hover) => {
            if (current.current !== target || suppressed.current) return;
            keepOpen();
            if (hover === null) setCard(null);
            else setCard({ target, rect: target.element.getBoundingClientRect(), hover });
          })
          .catch(() => undefined);
      }, getHoverDelay());
    },
    [cancelHover, keepOpen, keyOf, reviewId],
  );

  const leave = useCallback(
    (props: TokenProps) => {
      setLink(props.tokenElement, false);
      if (current.current?.element === props.tokenElement) current.current = null;
      cancelHover();
      scheduleClose();
    },
    [cancelHover, scheduleClose],
  );

  /**
   * Definition and uses of `target`, in the peek window: a new window from the
   * diff, or the next step of the open one's history from inside its preview.
   * `selected`, when given, is what it opens on instead of the usual pick.
   */
  const openPeek = useCallback(
    (target: Target, selected: NavEntry['selected'] = null) => {
      cancelHover();
      setCard(null);
      entryIds.current += 1;
      const id = entryIds.current;
      const entry: NavEntry = {
        id,
        name: target.name,
        definition: LOADING,
        implementations: LOADING,
        references: LOADING,
        selected,
        off: null,
      };
      if (!target.inPreview) peekFrom.current = { path: target.path, side: 'additions', line: target.pos.line };
      setNav((n) =>
        target.inPreview && n !== null
          ? { ...n, entries: [...n.entries.slice(0, n.index + 1), entry], index: n.index + 1 }
          : { rect: target.element.getBoundingClientRect(), origin: target.element, entries: [entry], index: 0 },
      );
      // Each answer lands in the entry; what's shown is picked once enough is in, and then kept.
      const update = (patch: (e: NavEntry) => NavEntry) =>
        setNav((n) => {
          if (n === null) return n;
          return {
            ...n,
            entries: n.entries.map((e) => {
              if (e.id !== id) return e;
              const next = patch(e);
              return { ...next, selected: next.selected ?? autoSelected(next) };
            }),
          };
        });
      const key = keyOf(target);
      const query = { path: target.path, line: target.pos.line, character: target.pos.character };
      definitionOf(reviewId, key, query).then(
        ({ definition, off }) =>
          update((e) => ({ ...e, off: e.off ?? off, definition: { status: 'ready', value: definition } })),
        (err: unknown) => update((e) => ({ ...e, definition: failed(err) })),
      );
      implementationsOf(reviewId, key, query).then(
        ({ implementations, off }) =>
          update((e) => ({ ...e, off: e.off ?? off, implementations: { status: 'ready', value: implementations } })),
        (err: unknown) => update((e) => ({ ...e, implementations: failed(err) })),
      );
      referencesOf(reviewId, key, query).then(
        ({ references, off }) =>
          update((e) => ({ ...e, off: e.off ?? off, references: { status: 'ready', value: references } })),
        (err: unknown) => update((e) => ({ ...e, references: failed(err) })),
      );
    },
    [cancelHover, keyOf, reviewId],
  );

  /**
   * Brings `line` (head side) of the diff's `path` into view and marks it for
   * a moment: the file unfolds if folded, and the unchanged lines around it
   * if it's outside the shown hunks, which first loads the whole file.
   */
  const reveal = useCallback(
    async (path: string, line: number) => {
      const view = codeViewRef.current;
      const item = itemsRef.current.find((i) => i.id === path);
      if (view === null || item === undefined) return;
      revealSeq.current += 1;
      const seq = revealSeq.current;
      const live = () => seq === revealSeq.current;
      // Its real patch replaces the placeholder in place (ReviewContext.tsx).
      await untilReady(() => !live() || item.fileDiff.cacheKey?.endsWith(':loading') !== true);
      if (!live()) return;
      if (item.collapsed === true) {
        expandFileForNavigation(path);
        await nextFrame();
        await nextFrame();
      }
      // Context only unfolds in a mounted file: bring it in first.
      if (!instances.current.has(path)) view.scrollTo({ type: 'item', id: path, align: 'start' });
      await untilReady(() => !live() || instances.current.has(path));
      const instance = () => instances.current.get(path);
      if (!live()) return;
      if (instance()?.isLineRenderable(line) === false) {
        // Unchanged lines need the whole file: a zero-line expansion loads it,
        // and `revealLine` can unfold the line once it's in.
        instance()?.expandHunk(0, 'up', 0);
        await untilReady(() => !live() || instance()?.isLineRenderable(line) === true || instance()?.revealLine(line) === true);
        await untilReady(() => !live() || instance()?.isLineRenderable(line) === true, 1_000);
        // The unfolded rows are laid out on the next render pass.
        await nextFrame();
        await nextFrame();
      }
      if (!live()) return;
      const shown = instance()?.isLineRenderable(line) ?? false;
      view.scrollTo(
        shown
          ? { type: 'line', id: path, lineNumber: line, side: 'additions', align: 'center' }
          : { type: 'item', id: path, align: 'start' },
      );
      // Mark the landing line for a moment with the line selection, unless the
      // reader has one of their own (a comment being drafted) to keep.
      if (!shown || view.getSelectedLines() !== null) return;
      const mark = { id: path, range: { start: line, end: line, side: 'additions' as const } };
      view.setSelectedLines(mark);
      window.setTimeout(() => {
        const current = view.getSelectedLines();
        if (current?.id === mark.id && current.range.start === mark.range.start && current.range.end === mark.range.end) {
          view.clearSelectedLines();
        }
      }, JUMP_HIGHLIGHT_MS);
    },
    [codeViewRef, expandFileForNavigation],
  );

  /** Leaves `from` for `to` in the diff, recorded in the jump history. */
  const go = useCallback(
    (to: Anchor, from: Anchor | null) => {
      setNav(null);
      setCard(null);
      setJumps((j) => {
        const kept = j === null ? [] : j.entries.slice(0, j.index + 1);
        if (from !== null && !sameAnchor(kept.at(-1), from)) kept.push(from);
        if (!sameAnchor(kept.at(-1), to)) kept.push(to);
        const entries = kept.slice(-JUMP_HISTORY_LIMIT);
        return entries.length < 2 ? j : { entries, index: entries.length - 1 };
      });
      void reveal(to.path, to.line);
    },
    [reveal],
  );

  const stepJump = useCallback(
    (delta: 1 | -1) => {
      const j = jumpsRef.current;
      if (j === null) return;
      const index = Math.max(0, Math.min(j.entries.length - 1, j.index + delta));
      const at = j.entries[index];
      if (index === j.index || at === undefined) return;
      setJumps({ ...j, index });
      void reveal(at.path, at.line);
    },
    [reveal],
  );

  const showMissing = useCallback((target: Target, text: string) => {
    setMissing({ rect: target.element.getBoundingClientRect(), text });
  }, []);

  /**
   * ⌘⇧-click: straight to what the peek would open on. In the diff when it's
   * a head-side line of a file this review changes; else, or when there's a
   * real choice to make, the peek opens (or re-targets, from its preview).
   */
  const goDirect = useCallback(
    (target: Target) => {
      cancelHover();
      setCard(null);
      setMissing(null);
      directSeq.current += 1;
      const seq = directSeq.current;
      const element = target.element;
      element.setAttribute('data-lsp-wait', '');
      const key = keyOf(target);
      const query = { path: target.path, line: target.pos.line, character: target.pos.character };
      Promise.all([definitionOf(reviewId, key, query), implementationsOf(reviewId, key, query)])
        .then(([{ definition, off }, { implementations, off: implementationsOff }]) => {
          if (seq !== directSeq.current) return;
          // A switched-off server: the peek says so and links to Settings.
          if ((off ?? implementationsOff) !== null) return openPeek(target);
          const others = (implementations?.references ?? []).filter(
            (i) => i.ref !== definition?.ref || i.line !== definition.line,
          );
          // Clicked on the definition itself: nothing to go to but what's behind it.
          const onItself = definition !== null && definition.ref === target.path && definition.line === target.pos.line;
          const [only] = others;
          const to =
            only !== undefined && others.length === 1 && (getImplementationJump() || definition === null || onItself)
              ? only
              : definition !== null && !onItself
                ? definition
                : null;
          if (to === null) {
            if (definition === null && others.length === 0) showMissing(target, 'No definition found');
            else openPeek(target);
            return;
          }
          const item = itemsRef.current.find((i) => i.id === to.ref);
          if (to.inReview && item !== undefined && item.fileDiff.type !== 'deleted') {
            const from: Anchor | null = target.inPreview
              ? peekFrom.current
              : { path: target.path, side: 'additions', line: target.pos.line };
            go({ path: to.ref, side: 'additions', line: to.line }, from);
          } else {
            openPeek(target, { ref: to.ref, line: to.line });
          }
        })
        .catch((err: unknown) => {
          if (seq === directSeq.current) showMissing(target, `Couldn't look it up: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => element.removeAttribute('data-lsp-wait'));
    },
    [cancelHover, go, keyOf, openPeek, reviewId, showMissing],
  );

  const click = useCallback(
    (target: Target | null, event: MouseEvent) => {
      if (!(IS_MAC ? event.metaKey : event.ctrlKey)) return;
      // A drag that ends on a token is a text selection, not a click on it.
      // (⌘⇧'s mousedown never selects, see below, so whatever is selected is older.)
      if (!event.shiftKey && window.getSelection()?.isCollapsed === false) return;
      if (target === null) return;
      event.preventDefault();
      if (event.shiftKey) goDirect(target);
      else openPeek(target);
    },
    [goDirect, openPeek],
  );

  const onTokenEnter = useCallback(
    (props: TokenProps, event: PointerEvent, context: TokenContext) => enter(diffTarget(props, context), event),
    [diffTarget, enter],
  );
  const clearOccurrences = useCallback(() => {
    occurrencesRequest.current?.abort();
    occurrencesRequest.current = null;
    const shown = occurrences.current;
    if (shown === null) return;
    occurrences.current = null;
    const node = containers.current.get(shown.path);
    if (node !== undefined) unmarkOccurrences(node);
  }, []);

  const showOccurrences = useCallback(
    (target: Target | null) => {
      clearOccurrences();
      if (target === null) return;
      const controller = new AbortController();
      occurrencesRequest.current = controller;
      const key = keyOf(target);
      cached(highlightsCache, key, () =>
        callApi('getHighlights', {
          params: [reviewId],
          query: { path: target.path, line: target.pos.line, character: target.pos.character },
          signal: controller.signal,
        }).then((r) => r.highlights),
      )
        .then((ranges) => {
          // Nothing found may be a server switched off or still starting: asked again next time.
          if (ranges.length === 0) highlightsCache.delete(key);
          if (occurrencesRequest.current !== controller) return;
          occurrencesRequest.current = null;
          if (ranges.length === 0) return;
          occurrences.current = { path: target.path, ranges };
          const node = containers.current.get(target.path);
          if (node !== undefined) markOccurrences(node, ranges);
        })
        .catch(() => undefined);
    },
    [clearOccurrences, keyOf, reviewId],
  );

  const onTokenClick = useCallback(
    (props: TokenProps, event: MouseEvent, context: TokenContext) => {
      const target = diffTarget(props, context);
      if (event.detail === 2 && !(IS_MAC ? event.metaKey : event.ctrlKey)) showOccurrences(target);
      else click(target, event);
    },
    [click, diffTarget, showOccurrences],
  );

  // Rows are rebuilt as the diff scrolls and re-renders: marks follow them.
  const onPostRender = useCallback((node: HTMLElement, instance: unknown, phase: PostRenderPhase, context: TokenContext) => {
    const path = context.item.id;
    if (phase === 'unmount') {
      if (containers.current.get(path) === node) containers.current.delete(path);
      if (instances.current.get(path) === instance) instances.current.delete(path);
      unmarkOccurrences(node);
      return;
    }
    containers.current.set(path, node);
    if (isDiffInstance(instance)) instances.current.set(path, instance);
    const shown = occurrences.current;
    if (shown === null) return;
    unmarkOccurrences(node);
    if (shown.path === path) markOccurrences(node, shown.ranges);
  }, []);

  // A single click anywhere (the first of a new double-click included), or Esc, clears the marks.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.detail < 2) clearOccurrences();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearOccurrences();
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [clearOccurrences]);
  const preview = useMemo(
    () => ({
      onTokenEnter: (props: TokenProps, event: PointerEvent, file: LspFile) => enter(previewTarget(props, file), event),
      onTokenLeave: leave,
      onTokenClick: (props: TokenProps, event: MouseEvent, file: LspFile) => click(previewTarget(props, file), event),
    }),
    [click, enter, leave, previewTarget],
  );

  // The held modifier underlines the token under the pointer, editor-style.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const down = IS_MAC ? e.metaKey : e.ctrlKey;
      if (down === modifierDown.current) return;
      modifierDown.current = down;
      setLink(current.current?.element, down);
    };
    const onBlur = () => {
      modifierDown.current = false;
      setLink(current.current?.element, false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // A scroll moves the token out from under the hover card; the peek window
  // stays put (it is a window of its own) until dismissed.
  useEffect(() => {
    if (card === null) return;
    const onScroll = () => setCard(null);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', onScroll, { capture: true });
  }, [card]);

  useEffect(() => () => cancelHover(), [cancelHover]);

  const origin = nav?.origin;
  useEffect(() => {
    if (origin === undefined) return;
    origin.setAttribute('data-lsp-origin', '');
    return () => origin.removeAttribute('data-lsp-origin');
  }, [origin]);

  // "Go to it in this review": the same jump, from where the peek was opened.
  const jump = useCallback(
    (path: string, line: number) => go({ path, side: 'additions', line }, peekFrom.current),
    [go],
  );

  const select = useCallback(
    (selected: NonNullable<NavEntry['selected']>) =>
      setNav((n) =>
        n === null ? n : { ...n, entries: n.entries.map((e, i) => (i === n.index ? { ...e, selected } : e)) },
      ),
    [],
  );
  const step = useCallback(
    (delta: 1 | -1) =>
      setNav((n) => (n === null ? n : { ...n, index: Math.max(0, Math.min(n.entries.length - 1, n.index + delta)) })),
    [],
  );
  const closeNav = useCallback(() => {
    setNav(null);
    setCard(null);
  }, []);

  // One set of back/forward entries for both histories: the peek's while it's
  // open, the diff's jumps otherwise. Back past a jump history's start ends it.
  useHistorySteps(
    (delta) => (nav !== null ? step(delta) : stepJump(delta)),
    () => (nav !== null ? closeNav() : setJumps(null)),
    nav !== null ? nav.index === 0 : (jumps?.index ?? 0) === 0,
    nav !== null || jumps !== null,
  );

  // A new review starts with no jumps to step through.
  useEffect(() => setJumps(null), [reviewId]);

  // ⌘[ / ⌘] step the diff's jumps; the peek takes them while it's open.
  useEffect(() => {
    if (jumps === null || nav !== null) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(IS_MAC ? e.metaKey : e.ctrlKey) || e.shiftKey || e.altKey || (e.key !== '[' && e.key !== ']')) return;
      if (e.defaultPrevented || isEditableTarget(resolveEventTarget(e))) return;
      e.preventDefault();
      stepJump(e.key === '[' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [jumps, nav, stepJump]);

  // ⌘⇧'s mousedown on a name would extend the text selection to it; it's a jump instead.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || !e.shiftKey || !(IS_MAC ? e.metaKey : e.ctrlKey)) return;
      if (e.composedPath().some((n) => n instanceof Element && n.hasAttribute('data-char'))) e.preventDefault();
    };
    window.addEventListener('mousedown', onMouseDown, { capture: true });
    return () => window.removeEventListener('mousedown', onMouseDown, { capture: true });
  }, []);

  // "No definition found" stays a moment, and goes at once on a scroll or click.
  useEffect(() => {
    if (missing === null) return;
    const dismiss = () => setMissing(null);
    const timer = window.setTimeout(dismiss, MISSING_MS);
    window.addEventListener('scroll', dismiss, { capture: true, passive: true });
    window.addEventListener('pointerdown', dismiss, { capture: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('scroll', dismiss, { capture: true });
      window.removeEventListener('pointerdown', dismiss, { capture: true });
    };
  }, [missing]);

  const overlay = (
    <>
      {nav !== null &&
        createPortal(
          <PeekNavigator
            nav={nav}
            reviewId={reviewId}
            preview={preview}
            onSelect={select}
            onStep={step}
            onJump={jump}
            onClose={closeNav}
          />,
          document.body,
        )}
      {card !== null &&
        createPortal(
          <HoverPopover
            card={card}
            onPointerEnter={keepOpen}
            onPointerLeave={scheduleClose}
            onPeek={() => openPeek(card.target)}
          />,
          document.body,
        )}
      {missing !== null &&
        createPortal(
          <div
            role="status"
            data-code-intel=""
            style={placement(missing.rect, 240, 28)}
            className="pointer-events-none fixed z-[60] max-w-60 truncate rounded-md bg-chrome-bg-raised px-2.5 py-1 text-xs text-chrome-fg-muted shadow-chrome ring-1 ring-chrome-fg/10"
          >
            {missing.text}
          </div>,
          document.body,
        )}
    </>
  );

  return { onTokenEnter, onTokenLeave: leave, onTokenClick, onPostRender, overlay };
}

function HoverPopover({
  card,
  onPointerEnter,
  onPointerLeave,
  onPeek,
}: {
  card: HoverCard;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onPeek: () => void;
}): React.JSX.Element {
  const width = Math.min(560, window.innerWidth - 16);
  return (
    // Not `role="tooltip"`: it holds a button, and a tooltip is read as plain text.
    <div
      role="group"
      aria-label="Symbol info"
      data-code-intel=""
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={{ ...placement(card.rect, width, 260), maxWidth: width }}
      // Above the peek window, whose preview has hover cards of its own.
      className="fixed z-[60] flex flex-col overflow-hidden rounded-md bg-chrome-bg-raised shadow-chrome ring-1 ring-chrome-fg/10"
    >
      <div className="code-intel-hover min-h-0 overflow-auto px-2.5 py-1.5">
        <Markdown>{card.hover.markdown}</Markdown>
      </div>
      <div className="flex h-7 shrink-0 items-center gap-2 border-t px-2.5 text-micro text-chrome-fg-subtle">
        <button
          type="button"
          onClick={onPeek}
          className="-ml-1.5 rounded px-1.5 py-0.5 text-chrome-fg-muted transition-colors hover:bg-chrome-bg-hover hover:text-chrome-fg"
        >
          Definition and uses
        </button>
        <span>{PEEK_KEY}-click · {JUMP_KEY}-click to go</span>
        <span className="ml-auto font-mono">{card.hover.server}</span>
      </div>
    </div>
  );
}
