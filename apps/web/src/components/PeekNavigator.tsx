/**
 * The peek window: a symbol's definition, implementations and uses on the
 * left, the chosen file on the right, IDE-style.
 *
 * - The definition is listed first and shown as soon as it's found;
 *   implementations (the classes behind an interface, the methods behind an
 *   interface method) and uses fill in below when the server has looked them
 *   up, files this review changes first. An interface with just one
 *   implementation opens on that one instead, unless Settings says not to.
 * - Clicking a file shows it at its first use, clicking a use at that line;
 *   ↑/↓ step through the list.
 * - The preview is the whole file, highlighted like the diff, with hover and
 *   ⌘-click of its own: ⌘-clicking a name re-targets the window to it, and
 *   ‹ › (⌘[ ⌘], or a mouse's back/forward buttons) walk back and forth
 *   through those steps. ⌘⇧-click leaves for the diff when the target is in
 *   it, and re-targets the window otherwise.
 * - "Go to it in this review" leaves for the diff when the file is changed.
 *
 * While nothing has been found yet it stays a one-line status, sized to it;
 * when the file's language server is switched off, that line says so and
 * links to Settings, where it's turned on.
 *
 * The window opens by the symbol; its title bar drags it and its edges and
 * corners resize it. The size is remembered for next time, the spot is not.
 */
import { File as CodeFile } from '@pierre/diffs/react';
import type { TokenEventBase } from '@pierre/diffs';
import type { LspDefinition, LspFile, LspLanguage, LspReference, LspReferences } from '@joinery/core';
import { ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../lib/apiClient.ts';
import { goSettings } from '../lib/router.ts';
import { PREFERRED_HIGHLIGHTER } from '../lib/workerPool.tsx';
import { useTheme } from '../state/ThemeContext.tsx';
import { LSP_TITLE } from './settings/LanguageServerPicker.tsx';
import { cached, CODE_INTEL_CSS, IS_MAC, placement } from '../lib/codeIntel.ts';
import { Hint } from './controls.tsx';

const WIDTH = 1_080;
const HEIGHT = 520;
const STATUS_WIDTH = 460;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 240;
const MARGIN = 8;
const SIZE_KEY = 'joinery:peek-size';
/** `MouseEvent.button` of a mouse's side buttons: they navigate, they don't close the window. */
const BACK_BUTTON = 3;
const FORWARD_BUTTON = 4;
const HISTORY_KEY = 'joineryPeek';

type HistorySpot = 'here' | 'ahead' | null;

/**
 * Back and forward, however they come (a mouse's side buttons, whose events
 * the page often never sees; a trackpad swipe; the browser's own buttons),
 * step the peek window, or the diff's jump history when it's closed (see
 * CodeIntel.tsx), instead of leaving the page. While `active`, two entries
 * with the page's own URL sit in the browser history, `here` (where it
 * stays) and `ahead`: going back lands on the page's entry and going forward
 * on `ahead`, either is taken as a step and undone. The hash router never
 * notices, the URL doesn't change. Back past the first step calls `onClose`.
 * When it stops being active the entries are stepped back over (`ahead` is
 * left as a forward entry that goes nowhere). One owner for both histories,
 * so the peek opening over a jump history never stacks a second pair.
 */
export function useHistorySteps(
  onStep: (delta: 1 | -1) => void,
  onClose: () => void,
  atStart: boolean,
  active: boolean,
): void {
  const latest = useRef({ onStep, onClose, atStart });
  latest.current = { onStep, onClose, atStart };
  useEffect(() => {
    if (!active) return;
    const url = location.href;
    /** Where the browser is in our entries, or will be once `pending` own moves land. */
    let at: HistorySpot = null;
    let pending = 0;
    let away = false;
    const go = (delta: number) => {
      pending += 1;
      history.go(delta);
    };
    const onPop = (e: PopStateEvent) => {
      if (location.href !== url) {
        away = true;
        return;
      }
      const state: unknown = e.state;
      at = typeof state === 'object' && state !== null && HISTORY_KEY in state ? (state[HISTORY_KEY] as HistorySpot) : null;
      if (pending > 0) {
        pending -= 1;
        return;
      }
      if (at === 'ahead') {
        latest.current.onStep(1);
        go(-1);
      } else if (at === null) {
        if (latest.current.atStart) latest.current.onClose();
        else latest.current.onStep(-1);
        go(1);
      }
    };
    // A tick later, so a mount that's undone at once (StrictMode) adds nothing.
    const start = setTimeout(() => {
      history.pushState({ [HISTORY_KEY]: 'here' }, '', url);
      history.pushState({ [HISTORY_KEY]: 'ahead' }, '', url);
      at = 'ahead';
      window.addEventListener('popstate', onPop);
      go(-1);
    }, 0);
    return () => {
      clearTimeout(start);
      window.removeEventListener('popstate', onPop);
      if (away || at === null) return;
      // Own moves still on their way all end on `here`.
      const spot = pending > 0 ? 'here' : at;
      history.go(spot === 'ahead' ? -2 : -1);
    };
  }, [active]);
}

type Size = { width: number; height: number };
type Box = Size & { left: number; top: number };
type Edges = { x: -1 | 0 | 1; y: -1 | 0 | 1 };

function storedSize(): Size {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null');
    if (typeof v === 'object' && v !== null && 'width' in v && 'height' in v) {
      const { width, height } = v;
      if (typeof width === 'number' && typeof height === 'number') {
        return { width: Math.max(MIN_WIDTH, width), height: Math.max(MIN_HEIGHT, height) };
      }
    }
  } catch {
    // Best-effort only.
  }
  return { width: WIDTH, height: HEIGHT };
}

function storeSize(size: Size): void {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify({ width: Math.round(size.width), height: Math.round(size.height) }));
  } catch {
    // Best-effort only.
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Where a drag (no edges) or a resize from `edges` takes `start`, kept inside the viewport. */
function dragged(start: Box, edges: Edges | null, dx: number, dy: number): Box {
  const maxRight = window.innerWidth - MARGIN;
  const maxBottom = window.innerHeight - MARGIN;
  if (edges === null) {
    return {
      ...start,
      left: clamp(start.left + dx, MARGIN, Math.max(MARGIN, maxRight - start.width)),
      top: clamp(start.top + dy, MARGIN, Math.max(MARGIN, maxBottom - start.height)),
    };
  }
  let { left, top, width, height } = start;
  const right = start.left + start.width;
  const bottom = start.top + start.height;
  if (edges.x === 1) width = clamp(start.width + dx, MIN_WIDTH, maxRight - left);
  if (edges.x === -1) {
    width = clamp(start.width - dx, MIN_WIDTH, right - MARGIN);
    left = right - width;
  }
  if (edges.y === 1) height = clamp(start.height + dy, MIN_HEIGHT, maxBottom - top);
  if (edges.y === -1) {
    height = clamp(start.height - dy, MIN_HEIGHT, bottom - MARGIN);
    top = bottom - height;
  }
  return { left, top, width, height };
}

const HANDLES: readonly (Edges & { className: string })[] = [
  { x: 0, y: -1, className: 'inset-x-2 -top-1 h-2 cursor-ns-resize' },
  { x: 0, y: 1, className: 'inset-x-2 -bottom-1 h-2 cursor-ns-resize' },
  { x: -1, y: 0, className: 'inset-y-2 -left-1 w-2 cursor-ew-resize' },
  { x: 1, y: 0, className: 'inset-y-2 -right-1 w-2 cursor-ew-resize' },
  { x: -1, y: -1, className: '-left-1 -top-1 size-3 cursor-nwse-resize' },
  { x: 1, y: -1, className: '-right-1 -top-1 size-3 cursor-nesw-resize' },
  { x: -1, y: 1, className: '-bottom-1 -left-1 size-3 cursor-nesw-resize' },
  { x: 1, y: 1, className: '-bottom-1 -right-1 size-3 cursor-nwse-resize' },
];

export type Load<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string };

/** One step of the window's history: a symbol, what was found for it, and what's shown. */
export type NavEntry = {
  readonly id: number;
  readonly name: string;
  definition: Load<LspDefinition | null>;
  implementations: Load<LspReferences | null>;
  references: Load<LspReferences | null>;
  /** The file and line on the right: picked once enough is in (CodeIntel.tsx), then the reader's. */
  selected: { ref: string; line: number } | null;
  /** The language, when its server is switched off in Settings. */
  off: LspLanguage | null;
};

/** `origin` is the token the window was opened from, marked while it's open. */
export type Nav = { rect: DOMRect; origin: HTMLElement; entries: NavEntry[]; index: number };

/**
 * An entry's implementations, the definition itself left out: some servers
 * name a concrete class or function as its own implementation.
 */
export function otherImplementations(entry: NavEntry): LspReference[] {
  const definition = entry.definition.status === 'ready' ? entry.definition.value : null;
  const all = entry.implementations.status === 'ready' ? (entry.implementations.value?.references ?? []) : [];
  return all.filter((i) => i.ref !== definition?.ref || i.line !== definition.line);
}

type PreviewHandlers = {
  onTokenEnter: (props: TokenEventBase, event: PointerEvent, file: LspFile) => void;
  onTokenLeave: (props: TokenEventBase) => void;
  onTokenClick: (props: TokenEventBase, event: MouseEvent, file: LspFile) => void;
};

const fileCache = new Map<string, Promise<LspFile | null>>();

/** The file to preview: the definition's text when that's the one, else fetched once per review. */
function usePreviewFile(reviewId: string, ref: string | null, definition: LspDefinition | null): Load<LspFile | null> | null {
  const inline = ref !== null && definition?.ref === ref ? definition : null;
  const [fetched, setFetched] = useState<{ ref: string; load: Load<LspFile | null> } | null>(null);
  useEffect(() => {
    if (ref === null || inline !== null) return;
    let live = true;
    setFetched({ ref, load: { status: 'loading' } });
    cached(fileCache, `${reviewId}:${ref}`, () => callApi('getLspFile', { params: [reviewId], query: { path: ref } }).then((r) => r.file)).then(
      (file) => live && setFetched({ ref, load: { status: 'ready', value: file } }),
      (err: unknown) =>
        live && setFetched({ ref, load: { status: 'error', message: err instanceof Error ? err.message : String(err) } }),
    );
    return () => {
      live = false;
    };
  }, [reviewId, ref, inline]);
  if (ref === null) return null;
  if (inline !== null) return { status: 'ready', value: inline };
  return fetched?.ref === ref ? fetched.load : { status: 'loading' };
}

type FileGroup = { ref: string; path: string; inReview: boolean; uses: LspReference[] };

function groupByFile(references: readonly LspReference[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const r of references) {
    let group = groups.get(r.ref);
    if (group === undefined) {
      group = { ref: r.ref, path: r.path, inReview: r.inReview, uses: [] };
      groups.set(r.ref, group);
    }
    group.uses.push(r);
  }
  return Array.from(groups.values());
}

function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/');
  return { name: path.slice(slash + 1), dir: slash < 0 ? '' : path.slice(0, slash) };
}

function loadError(load: Load<unknown>): string | null {
  return load.status === 'error' ? load.message : null;
}

export function PeekNavigator({
  nav,
  reviewId,
  preview,
  onSelect,
  onStep,
  onJump,
  onClose,
}: {
  nav: Nav;
  reviewId: string;
  preview: PreviewHandlers;
  onSelect: (selected: { ref: string; line: number }) => void;
  onStep: (delta: 1 | -1) => void;
  onJump: (path: string, line: number) => void;
  onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const entry = nav.entries[nav.index];
  const definition = entry?.definition.status === 'ready' ? entry.definition.value : null;
  const implementations = useMemo(() => (entry === undefined ? [] : otherImplementations(entry)), [entry]);
  // A class's `implements`/`extends` line is a use too: listed once, as the implementation.
  const references = useMemo(() => {
    const all = entry?.references.status === 'ready' ? (entry.references.value?.references ?? []) : [];
    const implemented = new Set(implementations.map((i) => `${i.ref}:${i.line}`));
    return all.filter((r) => !implemented.has(`${r.ref}:${r.line}`));
  }, [entry, implementations]);
  const selected = entry?.selected ?? null;
  const [size, setSize] = useState(storedSize);
  /** Set once the window has been dragged or resized; until then it sits by the symbol. */
  const [box, setBox] = useState<Box | null>(null);

  // Follows the pointer (captured by the grabbed bar or handle) until it's let go.
  const grab = useCallback((e: React.PointerEvent<HTMLElement>, edges: Edges | null) => {
    const el = ref.current;
    if (e.button !== 0 || el === null) return;
    if (edges === null && (e.target as Element).closest('button') !== null) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const start: Box = { left: r.left, top: r.top, width: r.width, height: r.height };
    let last = start;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const onMove = (m: PointerEvent) => {
      last = dragged(start, edges, m.clientX - e.clientX, m.clientY - e.clientY);
      setBox(last);
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      if (edges !== null) {
        setSize({ width: last.width, height: last.height });
        storeSize(last);
      }
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }, []);

  // Everything the list can select, in order, for ↑/↓.
  const stops = useMemo(() => {
    const all: { ref: string; line: number }[] = definition === null ? [] : [{ ref: definition.ref, line: definition.line }];
    return all.concat([...implementations, ...references].map((r) => ({ ref: r.ref, line: r.line })));
  }, [definition, implementations, references]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (e.key === 'Escape') onClose();
      else if (mod && (e.key === '[' || e.key === ']')) onStep(e.key === '[' ? -1 : 1);
      else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && stops.length > 0) {
        const at = stops.findIndex((s) => s.ref === selected?.ref && s.line === selected.line);
        const next = stops[Math.max(0, Math.min(stops.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next !== undefined) onSelect(next);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button === BACK_BUTTON || e.button === FORWARD_BUTTON) return;
      const target = e.target as Element | null;
      if (ref.current?.contains(target) === true || target?.closest?.('[data-code-intel]') != null) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose, onSelect, onStep, selected, stops]);

  if (entry === undefined) return <></>;

  // Nothing to show yet on the first step: a status line, not an empty window.
  const found = definition !== null || implementations.length > 0 || references.length > 0;
  if (!found && nav.entries.length === 1) {
    const error = loadError(entry.definition) ?? loadError(entry.references);
    const status =
      entry.definition.status === 'loading'
        ? 'Finding the definition…'
        : entry.references.status === 'loading'
          ? 'Finding uses…'
          : error !== null
            ? `Couldn't look it up: ${error}`
            : `Nothing found for ${entry.name}`;
    const width = Math.min(STATUS_WIDTH, window.innerWidth - 16);
    return (
      <div
        ref={ref}
        role="dialog"
        aria-label="Definition and uses"
        data-code-intel=""
        style={{ ...placement(nav.rect, width, 40), maxWidth: width }}
        className="fixed z-50 flex h-8 items-center gap-2 overflow-hidden rounded-md bg-chrome-bg-raised pl-3 pr-1 text-xs shadow-chrome ring-1 ring-chrome-fg/10"
      >
        {entry.off !== null ? (
          <>
            <span className="truncate text-chrome-fg-muted">The {LSP_TITLE[entry.off].title} is off</span>
            <button
              type="button"
              onClick={() => {
                onClose();
                goSettings();
              }}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-chrome-fg hover:bg-chrome-bg-hover"
            >
              Turn it on in Settings
              <ArrowRight size={12} strokeWidth={1.75} aria-hidden />
            </button>
          </>
        ) : (
          <span className="truncate text-chrome-fg-muted">{status}</span>
        )}
        <CloseButton onClose={onClose} />
      </div>
    );
  }

  const width = Math.min(size.width, window.innerWidth - 2 * MARGIN);
  const height = Math.min(size.height, window.innerHeight - 2 * MARGIN);
  const groups = groupByFile(references);
  const inReview = groups.filter((g) => g.inReview);
  const elsewhere = groups.filter((g) => !g.inReview);
  const truncated = entry.references.status === 'ready' && entry.references.value?.truncated === true;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Definition and uses"
      data-code-intel=""
      style={box ?? { ...placement(nav.rect, width, height), width, height }}
      className="fixed z-50 rounded-md bg-chrome-bg-raised shadow-chrome ring-1 ring-chrome-fg/10"
    >
      <div className="flex h-full flex-col overflow-hidden rounded-md">
        <div
          onPointerDown={(e) => grab(e, null)}
          className="flex h-8 shrink-0 cursor-move items-center gap-1 border-b pl-1 pr-1 text-xs"
        >
          <Hint label={`Back (${IS_MAC ? '⌘[' : 'Ctrl+['})`}>
            <button
              type="button"
              onClick={() => onStep(-1)}
              disabled={nav.index === 0}
              aria-label="Back"
              className="chrome-icon-btn size-6 shrink-0 text-chrome-fg-subtle disabled:opacity-40"
            >
              <ChevronLeft size={14} strokeWidth={1.75} aria-hidden />
            </button>
          </Hint>
          <Hint label={`Forward (${IS_MAC ? '⌘]' : 'Ctrl+]'})`}>
            <button
              type="button"
              onClick={() => onStep(1)}
              disabled={nav.index === nav.entries.length - 1}
              aria-label="Forward"
              className="chrome-icon-btn size-6 shrink-0 text-chrome-fg-subtle disabled:opacity-40"
            >
              <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
            </button>
          </Hint>
          <span className="ml-1 min-w-0 truncate font-mono text-chrome-fg">{entry.name}</span>
          {implementations.length > 0 && (
            <span className="shrink-0 text-micro text-chrome-fg-subtle">
              {implementations.length === 1 ? '1 implementation' : `${implementations.length} implementations`}
            </span>
          )}
          {entry.references.status === 'ready' && entry.references.value !== null && (
            <span className="shrink-0 text-micro text-chrome-fg-subtle">
              {references.length === 1 ? '1 use' : `${references.length}${truncated ? '+' : ''} uses`}
            </span>
          )}
          <span className="ml-auto" />
          <CloseButton onClose={onClose} />
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="w-64 shrink-0 overflow-y-auto border-r py-1 text-xs">
            <Section title="Definition">
              {entry.definition.status === 'loading' ? (
                <Note>Finding the definition…</Note>
              ) : definition === null ? (
                <Note>{loadError(entry.definition) ?? 'No definition found'}</Note>
              ) : (
                <FileRow
                  path={definition.path}
                  line={definition.line}
                  active={selected?.ref === definition.ref && selected.line === definition.line}
                  onClick={() => onSelect({ ref: definition.ref, line: definition.line })}
                />
              )}
            </Section>
            {implementations.length > 0 && (
              <Section title={`Implementations · ${implementations.length}`}>
                <Groups groups={groupByFile(implementations)} selected={selected} onSelect={onSelect} />
              </Section>
            )}
            {entry.references.status === 'loading' ? (
              <Section title="Uses">
                <Note>Finding uses…</Note>
              </Section>
            ) : references.length === 0 ? (
              <Section title="Uses">
                <Note>{loadError(entry.references) ?? 'No uses found'}</Note>
              </Section>
            ) : (
              <>
                {inReview.length > 0 && (
                  <Section title={`Uses in this review · ${inReview.reduce((n, g) => n + g.uses.length, 0)}`}>
                    <Groups groups={inReview} selected={selected} onSelect={onSelect} />
                  </Section>
                )}
                {elsewhere.length > 0 && (
                  <Section title={`Uses elsewhere · ${elsewhere.reduce((n, g) => n + g.uses.length, 0)}`}>
                    <Groups groups={elsewhere} selected={selected} onSelect={onSelect} />
                  </Section>
                )}
                {truncated && <Note>Only the first {references.length} are listed.</Note>}
              </>
            )}
          </div>
          <Preview
            reviewId={reviewId}
            selected={selected}
            choosing={selected === null && found}
            definition={definition}
            preview={preview}
            onJump={onJump}
          />
        </div>
      </div>
      {HANDLES.map((h) => (
        <div
          key={`${h.x}:${h.y}`}
          aria-hidden
          onPointerDown={(e) => grab(e, h)}
          className={`absolute ${h.className}`}
        />
      ))}
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <Hint label="Close (Esc)">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="chrome-icon-btn ml-auto size-6 shrink-0 text-chrome-fg-subtle"
      >
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </Hint>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="pb-1">
      <div className="px-3 pb-0.5 pt-1.5 text-micro text-chrome-fg-subtle">{title}</div>
      {children}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="px-3 py-0.5 text-chrome-fg-muted">{children}</div>;
}

function FileRow({
  path,
  line,
  active,
  onClick,
}: {
  path: string;
  line?: number;
  active: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const { name, dir } = splitPath(path);
  const rowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <Hint label={path}>
      <button
        ref={rowRef}
        type="button"
        onClick={onClick}
        className={`flex w-full min-w-0 items-baseline gap-1.5 px-3 py-0.5 text-left transition-colors hover:bg-chrome-bg-hover ${active ? 'bg-chrome-bg-hover text-chrome-fg' : 'text-chrome-fg'}`}
      >
        <span className="shrink-0 truncate">{name}</span>
        {line !== undefined && <span className="shrink-0 font-mono text-micro text-chrome-fg-subtle">:{line}</span>}
        <span className="min-w-0 truncate text-micro text-chrome-fg-subtle">{dir}</span>
      </button>
    </Hint>
  );
}

function Groups({
  groups,
  selected,
  onSelect,
}: {
  groups: readonly FileGroup[];
  selected: NavEntry['selected'];
  onSelect: (selected: { ref: string; line: number }) => void;
}): React.JSX.Element {
  return (
    <>
      {groups.map((group) => (
        <div key={group.ref}>
          <FileRow
            path={group.path}
            active={false}
            onClick={() => {
              const first = group.uses[0];
              if (first !== undefined) onSelect({ ref: first.ref, line: first.line });
            }}
          />
          {group.uses.map((use) => (
            <UseRow
              key={`${use.line}:${use.character}`}
              use={use}
              active={selected?.ref === use.ref && selected.line === use.line}
              onClick={() => onSelect({ ref: use.ref, line: use.line })}
            />
          ))}
        </div>
      ))}
    </>
  );
}

function UseRow({ use, active, onClick }: { use: LspReference; active: boolean; onClick: () => void }): React.JSX.Element {
  const rowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <button
      ref={rowRef}
      type="button"
      onClick={onClick}
      className={`flex w-full min-w-0 items-baseline gap-2 py-0.5 pl-5 pr-3 text-left font-mono text-micro transition-colors hover:bg-chrome-bg-hover ${active ? 'bg-chrome-bg-hover text-chrome-fg' : 'text-chrome-fg-muted'}`}
    >
      <span className="w-7 shrink-0 text-right text-chrome-fg-subtle">{use.line}</span>
      <span className="min-w-0 truncate">{use.preview}</span>
    </button>
  );
}

function Preview({
  reviewId,
  selected,
  choosing,
  definition,
  preview,
  onJump,
}: {
  reviewId: string;
  selected: NavEntry['selected'];
  /** Nothing picked yet, while it waits to hear whether to open on an implementation. */
  choosing: boolean;
  definition: LspDefinition | null;
  preview: PreviewHandlers;
  onJump: (path: string, line: number) => void;
}): React.JSX.Element {
  const { chromeMode } = useTheme();
  const load = usePreviewFile(reviewId, selected?.ref ?? null, definition);
  const file = load?.status === 'ready' ? load.value : null;
  const bodyRef = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLElement | null>(null);
  const rendered = useRef<string | null>(null);
  /** The line still to bring into view, and the file it is in. */
  const pending = useRef<{ ref: string; line: number } | null>(null);

  const contents = useMemo(
    () => (file === null ? null : { name: file.path, contents: file.text, cacheKey: `peek:${file.ref}:${file.text.length}` }),
    [file],
  );

  // Brings `pending` a third of the way down, once its file's rows are rendered.
  const reveal = useCallback(() => {
    const want = pending.current;
    const body = bodyRef.current;
    if (want === null || body === null || rendered.current !== want.ref) return;
    const row = host.current?.shadowRoot?.querySelector(`[data-line="${want.line}"]`);
    if (row == null) return;
    pending.current = null;
    body.scrollTop += row.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 3;
  }, []);

  useEffect(() => {
    pending.current = selected;
    reveal();
  }, [selected, file, reveal]);

  const options = useMemo(
    () => ({
      disableFileHeader: true,
      themeType: chromeMode,
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
      overflow: 'scroll' as const,
      unsafeCSS: `:host { --diffs-bg: var(--chrome-bg-raised); }${CODE_INTEL_CSS}`,
      onPostRender: (node: HTMLElement) => {
        host.current = node;
        rendered.current = file?.ref ?? null;
        reveal();
      },
      onTokenEnter: (props: TokenEventBase, event: PointerEvent) => {
        if (file !== null) preview.onTokenEnter(props, event, file);
      },
      onTokenLeave: (props: TokenEventBase) => preview.onTokenLeave(props),
      onTokenClick: (props: TokenEventBase, event: MouseEvent) => {
        if (file !== null) preview.onTokenClick(props, event, file);
      },
    }),
    [chromeMode, file, preview, reveal],
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b pl-3 pr-1 text-xs">
        {file !== null && selected !== null ? (
          <>
            <Hint label={file.path}>
              <span className="min-w-0 truncate font-mono text-chrome-fg">
                {file.path}
                <span className="text-chrome-fg-subtle">:{selected.line}</span>
              </span>
            </Hint>
            {file.external && <span className="shrink-0 text-micro text-chrome-fg-subtle">outside this repo</span>}
            {file.truncated && <span className="shrink-0 text-micro text-chrome-fg-subtle">cut short, very large file</span>}
            {file.inReview && (
              <button
                type="button"
                onClick={() => onJump(file.ref, selected.line)}
                className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-chrome-fg-muted transition-colors hover:bg-chrome-bg-hover hover:text-chrome-fg"
              >
                Go to it in this review
                <ArrowUpRight size={12} strokeWidth={2} aria-hidden />
              </button>
            )}
          </>
        ) : (
          <span className="text-chrome-fg-muted">
            {load === null
              ? choosing
                ? 'Opening…'
                : 'Nothing to show'
              : load.status === 'loading'
                ? 'Opening…'
                : load.status === 'error'
                  ? `Couldn't open it: ${load.message}`
                  : 'This file is gone'}
          </span>
        )}
      </div>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto">
        {contents !== null && selected !== null && (
          <CodeFile
            file={contents}
            selectedLines={{ start: selected.line, end: selected.line }}
            options={options}
            style={
              {
                '--diffs-line-height': '20px',
                '--diffs-font-family': 'var(--chrome-font-mono)',
                '--diffs-font-size': '12px',
              } as React.CSSProperties
            }
          />
        )}
      </div>
    </div>
  );
}
