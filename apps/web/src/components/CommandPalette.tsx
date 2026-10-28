/**
 * `Cmd+K` command palette: a Linear-style, mode-scoped launcher.
 *
 * The default (root) mode lists the commands first, then a small, bounded
 * set of jump targets — open threads, or the reviews on Homebase — rather
 * than dumping every file and thread into one flat list at once. Typing a
 * query adds the reviews and, last, the files; an empty query lists no
 * files at all. Themes aren't listed in root: "Change theme…" opens the `#`
 * mode instead. Three explicit
 * sub-modes are reached by typing a leading character in the search box,
 * exactly like VS Code's palette:
 *
 *   `>`  commands   — actions: generate reading order, switch revision,
 *                     toggle panels, diff style, expand/collapse all
 *   `#`  themes     — all 75 diff themes, never a truncated slice, on
 *                     Dark | Light tabs; `←`/`→` switch the tab *and* the
 *                     chrome mode, so the preview is always on screen, and
 *                     a pick fills that tab's slot
 *   `@`  reviews    — switch to another open review
 *
 * The trigger character lives directly in the (controlled) search string, so
 * "back" is just deleting it: Backspace on `#dra` → `#` → `` walks
 * theme-search → theme-home → root for free, with no separate navigation
 * stack to keep in sync. `Escape` clears the query first and only closes the
 * palette once it's already empty (so a sub-mode collapses back to root
 * before the palette itself closes).
 *
 * A fourth mode, `file`, has no trigger character of its own — it's a
 * dedicated, single-purpose view over the same file list root shows, reached
 * only via `initialMode="file"` (bound to `Cmd+P`; `Cmd+Shift+P` opens
 * `initialMode="command"`, landing straight in `>`). Since it can't be
 * spelled in the search string, it's tracked in a small `forcedMode` piece
 * of state instead, one that a real mode-prefix character always overrides
 * (typing `#`/`>`/`@` while forced into `file` mode switches away from it
 * immediately) and that's cleared whenever the palette closes.
 *
 * A fifth, `generate`, is a nested page: "Generate reading order" opens it
 * (Enter, or `→` while it's highlighted) to pick the model for that one run,
 * and `←`, Backspace on an empty query or Escape goes back to where it was
 * opened from. It's tracked like `file`, through `forcedMode`. "Change
 * theme…" opens `#` the same way.
 *
 * Outside a review (on Homebase) there is no review context: root lists
 * the open reviews in place of files/steps/threads, and the commands are
 * only the ones that don't act on a review.
 *
 * There is deliberately no "ask agent" command here: asking an agent
 * happens from a thread (its composer's `Cmd+Enter` or its Ask agent button).
 */
import { AGENT_MODELS } from '@joinery/core';
import { Command, defaultFilter } from 'cmdk';
import {
  Bot,
  Check,
  ChevronRight,
  Palette,
  CheckCheck,
  Eraser,
  Loader2,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  MessageSquare,
  MessageSquareDashed,
  PanelLeft,
  PanelRight,
  Rows2,
  Search,
  Settings,
  Lighthouse,
  Sun,
  Moon,
  Waypoints,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAgentModel, getGenerationModel, useGenerationModel } from '../lib/agentModel.ts';
import { callApi } from '../lib/apiClient.ts';
import { openOnboarding } from '../lib/onboarding.ts';
import { goReview, goSettings } from '../lib/router.ts';
import { runUiState } from '../lib/runState.ts';
import { listThemeOptions, type ThemeOption } from '../lib/themes.ts';
import { threadSummary } from '../lib/threadSummary.ts';
import { useOptionalReview } from '../state/ReviewContext.tsx';
import { useTheme, type ChromeMode } from '../state/ThemeContext.tsx';
import { Hint } from './controls.tsx';

type Mode = 'root' | 'command' | 'theme' | 'review' | 'file' | 'generate';

/** The two modes reachable directly (without typing a prefix) via `initialMode`. */
type ForcedMode = 'command' | 'file';

function parseSearch(raw: string): { mode: Mode; query: string } {
  if (raw.startsWith('>')) return { mode: 'command', query: raw.slice(1).trimStart() };
  if (raw.startsWith('#')) return { mode: 'theme', query: raw.slice(1).trimStart() };
  if (raw.startsWith('@')) return { mode: 'review', query: raw.slice(1).trimStart() };
  return { mode: 'root', query: raw };
}

/** Mode prefixes, shown as clickable hints under the root-mode search box. */
const MODE_HINTS: [string, string][] = [
  ['>', 'Commands'],
  ['#', 'Themes'],
  ['@', 'Reviews'],
];

const MODE_PLACEHOLDER: Record<Mode, string> = {
  root: 'Search commands, reviews, and files…',
  command: 'Run a command…',
  theme: 'Switch theme…',
  review: 'Switch review…',
  file: 'Jump to a file…',
  generate: 'Pick a model to generate with…',
};

const MODE_LABEL: Record<Mode, string> = {
  root: 'Jump to',
  command: 'Commands',
  theme: 'Themes',
  review: 'Reviews',
  file: 'Files',
  generate: 'Generate with',
};

/** Root-mode groups show at most this many rows until the user actually types a query. */
const ROOT_CAP = 6;

// Deliberately no `transition-colors` (or any other transition/animation) on
// this class: the palette is a keyboard-driven launcher, and hover/arrow-key
// highlight has to land on the row the instant it's selected. An animated
// background lags visibly behind a held-down arrow key and reads as broken.
// Do not re-add a transition here for selected/hover state.
// Selection is a neutral fill, not the accent: the accent is reserved for
// "this is on/active" (the checkmarks, the pressed toggles), while the
// highlighted row is just the cursor. A solid accent bar the full width of
// the palette was the loudest thing on screen for what is only a hover.
const ITEM_CLASS =
  'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-body text-chrome-fg outline-hidden data-[selected=true]:bg-chrome-bg-active [&_svg]:shrink-0 [&_svg]:text-chrome-fg-subtle data-[selected=true]:[&_svg]:text-chrome-fg-muted';

/** `value`s of the commands that open a page of their own, so `→` can tell when one is highlighted. */
const GENERATE_COMMAND_VALUE = 'generate regenerate reading order';
const THEME_COMMAND_VALUE = 'change theme diff syntax colors';

function modelItemValue(id: string): string {
  return `model ${id}`;
}

/** Whether a theme belongs on a tab; one with no declared scheme fits both. */
function fitsScheme(opt: ThemeOption, scheme: ChromeMode): boolean {
  return opt.colorScheme === undefined || opt.colorScheme === scheme;
}

/** Builds the same `Command.Item` `value` string used for a theme option, both to render it and to look it up again from `Command`'s `onValueChange` (see the live-preview effect below). */
function themeItemValue(opt: ThemeOption): string {
  return `theme ${opt.name} ${opt.collection}`;
}

export function CommandPalette({
  open,
  onOpenChange,
  initialMode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the palette directly in a sub-mode, bypassing root. See the file-top doc comment. */
  // Explicitly `| undefined` because the project runs with
  // `exactOptionalPropertyTypes`: callers pass a state variable that is
  // `undefined` for the root view, which an ordinary `?:` would reject.
  initialMode?: ForcedMode | undefined;
}): React.JSX.Element {
  const review = useOptionalReview();
  const { chromeMode, setChromeMode, diffTheme, setDiffTheme } = useTheme();
  const [search, setSearch] = useState('');
  const lastGenerationModel = useGenerationModel();
  const [forcedMode, setForcedMode] = useState<ForcedMode | 'generate' | null>(null);
  // Where the generate page goes back to: the search string it was opened from.
  const generateReturnRef = useRef('');
  const [reviewList, setReviewList] = useState<{ id: string; branch: string | null }[]>([]);
  // The currently-highlighted item's cmdk `value`, kept controlled so theme
  // mode can observe it (see the live-preview effect below) — cmdk only
  // calls `onValueChange` for an *externally controlled* `value`.
  const [highlightedValue, setHighlightedValue] = useState('');

  const parsed = parseSearch(search);
  // A real mode-prefix character in the search string always wins over a
  // forced mode: typing `#`/`>`/`@` while the palette opened straight into
  // `file` (or `command`) mode should switch away from it immediately.
  const mode: Mode = parsed.mode !== 'root' ? parsed.mode : (forcedMode ?? 'root');
  const { query } = parsed;

  useEffect(() => {
    if (!open) return;
    callApi('listReviews')
      .then((res) => setReviewList(res.reviews.map((r) => ({ id: r.id, branch: r.branch }))))
      .catch(() => undefined);
  }, [open]);

  // Defect: search query was never reset on close, so reopening showed
  // stale filtering. Reset back to root with an empty query every time —
  // and adopt `initialMode` (if any) fresh on every open, so a caller that
  // wants the file-jump view doesn't have to fight state left over from the
  // previous time the palette was open.
  useEffect(() => {
    if (open) {
      setForcedMode(initialMode ?? null);
    } else {
      setSearch('');
      setForcedMode(null);
    }
  }, [open, initialMode]);

  // listThemeOptions() was being called on every render — memoize it, and
  // never slice it: all 75 themes stay reachable.
  const themeOptions = useMemo(() => listThemeOptions(), []);
  const colorblindThemes = useMemo(() => themeOptions.filter((o) => o.colorblindSafe), [themeOptions]);
  const otherThemes = useMemo(() => themeOptions.filter((o) => !o.colorblindSafe), [themeOptions]);
  const themeValueMap = useMemo(() => new Map(themeOptions.map((o) => [themeItemValue(o), o])), [themeOptions]);

  const close = () => onOpenChange(false);

  const themeValueOf = (name: string): string => {
    const opt = themeOptions.find((o) => o.name === name);
    return opt === undefined ? '' : themeItemValue(opt);
  };

  // Radix dismisses on Escape from a capture-phase document listener, before
  // the input's own `onKeyDown` sees the key, so stepping back happens here:
  // the generate page goes back to where it was opened, a query is cleared
  // (backing a sub-mode out to root), and only then does the palette close.
  // The backdrop click calls `close()` directly, so it always closes.
  const handleOpenChange = (next: boolean) => {
    if (!next && mode === 'generate') {
      closeGeneratePage();
      return;
    }
    if (!next && search !== '') {
      setSearch('');
      return;
    }
    onOpenChange(next);
  };

  // cmdk's own fuzzy filter (`defaultFilter`, from the `command-score`
  // library), but scored against the query with its mode prefix stripped —
  // so `#dra` filters the theme list by `dra`, not by the literal `#dra`.
  const filter = useCallback((value: string, rawSearch: string): number => {
    const { query: q } = parseSearch(rawSearch);
    if (q === '') return 1;
    return defaultFilter(value, q);
  }, []);

  // Live theme preview: moving the highlighted row in theme mode applies
  // that theme immediately, so scrolling through with the arrow keys
  // previews each one as you go. The tab is the chrome mode itself (`←`/`→`
  // switch both), so whatever is highlighted is on screen. `previewRef`
  // remembers the pair and the chrome mode from *before* theme mode was
  // entered, and whether a theme was committed (Enter/click); backing out
  // (Escape, switching to another mode, closing the palette) without
  // committing restores both.
  const previewRef = useRef<{ entry: { diffTheme: typeof diffTheme; chromeMode: ChromeMode }; committed: boolean } | null>(null);
  const themeTab = chromeMode;

  // Tracks entering/leaving theme mode. Deliberately keyed on `mode` alone —
  // not on `diffTheme`/`chromeMode`, which this effect also reads: `diffTheme`
  // changes continuously as the preview below fires, and this effect must run
  // only on the theme-mode transition itself, not on every preview tick (that
  // would immediately "restore" the very preview it just applied).
  useEffect(() => {
    if (mode === 'theme') {
      if (previewRef.current === null) {
        previewRef.current = { entry: { diffTheme, chromeMode }, committed: false };
        setHighlightedValue(themeValueOf(diffTheme[chromeMode]));
      }
    } else if (previewRef.current !== null) {
      if (!previewRef.current.committed) {
        const { entry } = previewRef.current;
        setDiffTheme(entry.diffTheme);
        if (entry.chromeMode !== chromeMode) setChromeMode(entry.chromeMode);
      }
      previewRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Applies the preview itself. Also deliberately not keyed on `diffTheme`
  // for the same reason as above — applying a preview changes `diffTheme`,
  // which must not re-trigger this effect against the same `highlightedValue`.
  useEffect(() => {
    if (mode !== 'theme' || previewRef.current === null) return;
    const base = previewRef.current.entry.diffTheme;
    const opt = themeValueMap.get(highlightedValue);
    const next = opt !== undefined && fitsScheme(opt, themeTab) ? { ...base, [themeTab]: opt.name } : base;
    if (next.dark !== diffTheme.dark || next.light !== diffTheme.light) setDiffTheme(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedValue, mode, themeTab, themeValueMap]);

  // Switches the tab, which is the chrome mode, and puts the highlight on
  // that tab's pick from before theme mode was entered.
  const switchThemeTab = (tab: ChromeMode) => {
    if (tab === themeTab) return;
    setChromeMode(tab);
    setHighlightedValue(themeValueOf((previewRef.current?.entry.diffTheme ?? diffTheme)[tab]));
  };

  const openGeneratePage = () => {
    generateReturnRef.current = search;
    setSearch('');
    setForcedMode('generate');
    setHighlightedValue(modelItemValue(getGenerationModel() ?? getAgentModel()));
  };

  const closeGeneratePage = () => {
    setForcedMode(initialMode ?? null);
    setSearch(generateReturnRef.current);
    setHighlightedValue(GENERATE_COMMAND_VALUE);
  };

  const openThemeMode = () => setSearch('#');

  const goToFile = (path: string) => {
    if (review === null) return;
    review.setSelectedPath(path);
    review.codeViewRef.current?.scrollTo({ type: 'item', id: path, align: 'start' });
    close();
  };

  const allFiles = review?.fileList ?? [];
  // ⌘P's file mode lists them all; root only offers files once you type.
  const files = mode === 'file' || query !== '' ? allFiles : [];
  const openThreads = (review?.threads ?? []).filter((t) => t.status === 'open');
  const threads = query === '' ? openThreads.slice(0, ROOT_CAP) : openThreads;

  const currentReview = review?.review ?? null;

  const reviewItems = reviewList.map((r) => (
    <Command.Item
      key={r.id}
      value={`review ${r.branch ?? r.id}`}
      onSelect={() => {
        goReview(r.id);
        close();
      }}
      className={ITEM_CLASS}
    >
      <GitBranch size={14} strokeWidth={1.5} aria-hidden />
      <span className="truncate">{r.branch ?? r.id}</span>
      {r.id === currentReview?.id && <Check size={13} strokeWidth={2} className="ml-auto text-chrome-accent!" aria-hidden />}
    </Command.Item>
  ));

  // Opens the generate page to pick the model for this one run. While a run
  // is going, the item stays listed but disabled, so it says why nothing new
  // starts.
  const generating = review !== null && runUiState(review.readingOrderRun).phase === 'pending';
  const generateVerb = review?.readingOrder != null && review.readingOrder.steps.length > 0 ? 'Regenerate' : 'Generate';
  const generateItem = review !== null && currentReview !== null && (
    <Command.Item
      value={GENERATE_COMMAND_VALUE}
      disabled={generating}
      onSelect={openGeneratePage}
      className={`${ITEM_CLASS} data-[disabled=true]:text-chrome-fg-muted`}
    >
      {generating ? (
        <Loader2 size={14} strokeWidth={1.5} className="animate-spin" aria-hidden />
      ) : (
        <Waypoints size={14} strokeWidth={1.5} aria-hidden />
      )}
      {generating ? `${generateVerb.replace(/e$/, '')}ing reading order…` : `${generateVerb} reading order…`}
      {!generating && <ChevronRight size={13} strokeWidth={1.75} className="ml-auto" aria-hidden />}
    </Command.Item>
  );

  // Every command, shared by the `>` view and the typed root view.
  const commandItems = (
    <>
      {generateItem}
      {/* Only revisions that exist for this review right now (e.g. no
        * `working` for a review that isn't checked out, no `pr`
        * without a PR) — the server's `availableRevisions`. */}
      {(review?.reviewState?.availableRevisions ?? []).map((rev) => (
        <Command.Item
          key={rev}
          value={`switch revision ${rev}`}
          onSelect={() => {
            void review?.setRevision(rev);
            close();
          }}
          className={ITEM_CLASS}
        >
          <GitCommitHorizontal size={14} strokeWidth={1.5} aria-hidden />
          Switch to {rev}
          {review?.reviewState?.currentRevision === rev && (
            <Check size={13} strokeWidth={2} className="ml-auto text-chrome-accent!" aria-hidden />
          )}
        </Command.Item>
      ))}
      <Command.Item
        value="open settings preferences"
        onSelect={() => {
          goSettings();
          close();
        }}
        className={ITEM_CLASS}
      >
        <Settings size={14} strokeWidth={1.5} aria-hidden />
        Open settings
      </Command.Item>
      <Command.Item
        value="show onboarding welcome setup"
        onSelect={() => {
          openOnboarding();
          close();
        }}
        className={ITEM_CLASS}
      >
        <Lighthouse size={14} strokeWidth={1.5} aria-hidden />
        Show onboarding
      </Command.Item>
      <Command.Item value={THEME_COMMAND_VALUE} onSelect={openThemeMode} className={ITEM_CLASS}>
        <Palette size={14} strokeWidth={1.5} aria-hidden />
        Change theme…
        <ChevronRight size={13} strokeWidth={1.75} className="ml-auto" aria-hidden />
      </Command.Item>
      {/*
        * Light/dark *chrome* mode, distinct from the `#` theme mode
        * below (which picks the syntax theme used for whichever
        * chrome mode is active). This used to live in a header
        * ThemePicker; with that removed, the palette is the only
        * place it is reachable from, so it belongs in the command
        * list rather than only in the theme sub-mode.
        */}
      <Command.Item
        value="toggle light dark chrome mode appearance"
        onSelect={() => {
          setChromeMode(chromeMode === 'dark' ? 'light' : 'dark');
          close();
        }}
        className={ITEM_CLASS}
      >
        {chromeMode === 'dark' ? (
          <Sun size={14} strokeWidth={1.5} aria-hidden />
        ) : (
          <Moon size={14} strokeWidth={1.5} aria-hidden />
        )}
        Switch to {chromeMode === 'dark' ? 'light' : 'dark'} mode
      </Command.Item>
      {review !== null && (
        <>
          <Command.Item
            value="toggle left panel file tree"
            onSelect={() => {
              review.toggleLeftPanel();
              close();
            }}
            className={ITEM_CLASS}
          >
            <PanelLeft size={14} strokeWidth={1.5} aria-hidden />
            Toggle left panel
          </Command.Item>
          <Command.Item
            value="toggle right panel reading order"
            onSelect={() => {
              review.toggleRightPanel();
              close();
            }}
            className={ITEM_CLASS}
          >
            <PanelRight size={14} strokeWidth={1.5} aria-hidden />
            Toggle right panel
          </Command.Item>
          <Command.Item
            value="toggle threads panel"
            onSelect={() => {
              review.toggleThreadsPanel();
              close();
            }}
            className={ITEM_CLASS}
          >
            <MessageSquare size={14} strokeWidth={1.5} aria-hidden />
            Toggle threads panel
          </Command.Item>
          <Command.Item
            value="diff style unified split toggle"
            onSelect={() => {
              review.setDiffStyle(review.diffStyle === 'split' ? 'unified' : 'split');
              close();
            }}
            className={ITEM_CLASS}
          >
            {review.diffStyle === 'split' ? (
              <Rows2 size={14} strokeWidth={1.5} aria-hidden />
            ) : (
              <Columns2 size={14} strokeWidth={1.5} aria-hidden />
            )}
            Switch to {review.diffStyle === 'split' ? 'unified' : 'split'} diff
          </Command.Item>
          <Command.Item
            value="expand all files"
            onSelect={() => {
              review.expandAllFiles();
              close();
            }}
            className={ITEM_CLASS}
          >
            <ChevronsUpDown size={14} strokeWidth={1.5} aria-hidden />
            Expand all files
          </Command.Item>
          <Command.Item
            value="collapse all files"
            onSelect={() => {
              review.collapseAllFiles();
              close();
            }}
            className={ITEM_CLASS}
          >
            <ChevronsDownUp size={14} strokeWidth={1.5} aria-hidden />
            Collapse all files
          </Command.Item>
        </>
      )}
      {review !== null && (
        <>
          <Command.Item
            value="mark all files viewed"
            onSelect={() => {
              void review.setAllViewed(true);
              close();
            }}
            className={ITEM_CLASS}
          >
            <CheckCheck size={14} strokeWidth={1.5} aria-hidden />
            Mark all files viewed
          </Command.Item>
          <Command.Item
            value="mark all files unviewed"
            onSelect={() => {
              void review.setAllViewed(false);
              close();
            }}
            className={ITEM_CLASS}
          >
            <Eraser size={14} strokeWidth={1.5} aria-hidden />
            Mark all files unviewed
          </Command.Item>
          <Command.Item
            value="resolve all threads"
            onSelect={() => {
              void review.setAllThreadsResolved(true);
              close();
            }}
            className={ITEM_CLASS}
          >
            <MessageSquare size={14} strokeWidth={1.5} aria-hidden />
            Resolve all threads
          </Command.Item>
          <Command.Item
            value="unresolve reopen all threads"
            onSelect={() => {
              void review.setAllThreadsResolved(false);
              close();
            }}
            className={ITEM_CLASS}
          >
            <MessageSquareDashed size={14} strokeWidth={1.5} aria-hidden />
            Unresolve all threads
          </Command.Item>
        </>
      )}
    </>
  );

  // Theme mode: only the current tab's themes, a pick filling that tab's slot.
  const themeTabItems = [...colorblindThemes, ...otherThemes]
    .filter((opt) => fitsScheme(opt, themeTab))
    .map((opt) => (
      <ThemeItem
        key={opt.name}
        opt={opt}
        active={opt.name === (previewRef.current?.entry.diffTheme ?? diffTheme)[themeTab]}
        onSelect={() => {
          const entry = previewRef.current?.entry.diffTheme ?? diffTheme;
          if (previewRef.current !== null) previewRef.current.committed = true;
          setDiffTheme({ ...entry, [themeTab]: opt.name });
          close();
        }}
      />
    ));

  // The generate page: one run of reading-order generation on the picked model.
  const modelItems = AGENT_MODELS.map((m) => (
    <Command.Item
      key={m.id}
      value={modelItemValue(m.id)}
      keywords={[m.label]}
      onSelect={() => {
        void review?.generateReadingOrder(m.id);
        close();
      }}
      className={ITEM_CLASS}
    >
      <Bot size={14} strokeWidth={1.5} aria-hidden />
      {m.label}
      {m.id === lastGenerationModel && <span className="ml-auto text-xs text-chrome-fg-subtle">last used</span>}
    </Command.Item>
  ));

  const fileItems = files.map((f) => (
    <Command.Item key={f.path} value={`file ${f.path}`} onSelect={() => goToFile(f.path)} className={ITEM_CLASS}>
      <FileText size={14} strokeWidth={1.5} aria-hidden />
      <span className="truncate">{f.path}</span>
    </Command.Item>
  ));

  return (
    <Command.Dialog
      open={open}
      onOpenChange={handleOpenChange}
      label="Command palette"
      // Theme mode is a live preview: the palette gets out of the way (docked
      // bottom-right, no dim, no blur) so the chrome and diff it's recolouring
      // are actually visible while you arrow through the list.
      className={
        mode === 'theme'
          ? 'fixed inset-0 z-50 flex items-end justify-end p-4'
          : 'fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[14vh] backdrop-blur-[2px]'
      }
      // cmdk's `Command.Dialog` renders this whole backdrop (Radix Dialog's
      // `Content`, not its `Overlay`) as one full-viewport element, with our
      // actual dialog frame as its one child — so a click that lands on the
      // backdrop itself (not bubbled up from the frame) is, structurally,
      // still "inside" Radix's Content, and Radix's own outside-click
      // dismissal never sees it. Closing on it is on us instead: only fire
      // when the click target *is* this backdrop element, not a descendant.
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      shouldFilter
      filter={filter}
      value={highlightedValue}
      onValueChange={setHighlightedValue}
      loop
    >
      <div
        className={`w-full overflow-hidden rounded-xl bg-chrome-bg-raised shadow-[0_16px_48px_-12px_rgba(0,0,0,0.35),0_0_0_0.5px_light-dark(rgba(20,22,30,0.18),rgba(255,255,255,0.1))] ${
          mode === 'theme' ? 'max-w-sm' : 'max-w-xl'
        }`}
      >
        <div className="flex h-12 items-center gap-2.5 px-3.5">
          {mode === 'root' ? (
            <Search size={15} strokeWidth={1.75} className="shrink-0 text-chrome-fg-subtle" aria-hidden />
          ) : (
            <span className="flex h-5 shrink-0 items-center rounded-md bg-chrome-accent-soft px-1.5 text-xs font-medium text-chrome-accent">
              {MODE_LABEL[mode]}
            </span>
          )}
          <Command.Input
            autoFocus
            value={search}
            onValueChange={setSearch}
            onKeyDown={(e) => {
              const input = e.currentTarget;
              const caretAtEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
              if (mode === 'theme' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                e.preventDefault();
                switchThemeTab(e.key === 'ArrowLeft' ? 'dark' : 'light');
                return;
              }
              if (mode === 'generate') {
                if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && input.value === '') {
                  e.preventDefault();
                  closeGeneratePage();
                }
              } else if (e.key === 'ArrowRight' && caretAtEnd) {
                if (highlightedValue === GENERATE_COMMAND_VALUE && !generating) {
                  e.preventDefault();
                  openGeneratePage();
                } else if (highlightedValue === THEME_COMMAND_VALUE) {
                  e.preventDefault();
                  openThemeMode();
                }
              }
            }}
            placeholder={MODE_PLACEHOLDER[mode]}
            className="w-full bg-transparent text-[14px] text-chrome-fg outline-hidden placeholder:text-chrome-fg-subtle"
          />
        </div>
        {mode === 'theme' && (
          <div role="tablist" aria-label="Theme slot" className="flex items-center gap-1 px-3.5 pb-2">
            {(['dark', 'light'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={themeTab === tab}
                // Keep focus in the input so typing and arrowing carry on.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => switchThemeTab(tab)}
                className={`flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium ${
                  themeTab === tab ? 'bg-chrome-bg-active text-chrome-fg!' : 'text-chrome-fg-muted! hover:text-chrome-fg!'
                }`}
              >
                {tab === 'dark' ? <Moon size={12} strokeWidth={1.75} aria-hidden /> : <Sun size={12} strokeWidth={1.75} aria-hidden />}
                {tab === 'dark' ? 'Dark' : 'Light'}
              </button>
            ))}
            <span className="ml-auto flex items-center gap-1 text-micro text-chrome-fg-subtle">
              <Key>←</Key>
              <Key>→</Key>
              switch light and dark mode
            </span>
          </div>
        )}
        {mode === 'root' && (
          <div className="flex items-center gap-3 px-3.5 pb-2 text-xs text-chrome-fg-subtle">
            {MODE_HINTS.map(([prefix, label]) => (
              <button
                key={prefix}
                type="button"
                // Keep focus in the input so typing carries on in the new mode.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setSearch(prefix)}
                className="flex items-center gap-1.5 hover:text-chrome-fg"
              >
                <Key>{prefix}</Key>
                {label}
              </button>
            ))}
          </div>
        )}
        <Command.List className={`overflow-y-auto border-t border-chrome-border px-1.5 pb-1.5 pt-1 ${mode === 'theme' ? 'max-h-[50vh]' : 'max-h-[420px]'}`}>
          <Command.Empty className="px-3 py-8 text-center text-xs text-chrome-fg-muted">No results.</Command.Empty>

          {mode === 'root' && (
            <>
              {/* Commands first, typed or not; files last, and only once you type. */}
              <Group heading="Commands">{commandItems}</Group>

              {/* Homebase: the reviews are what there is to jump to. */}
              {review === null && reviewList.length > 0 && (
                <Group heading="Reviews">{query === '' ? reviewItems.slice(0, ROOT_CAP) : reviewItems}</Group>
              )}

              {review !== null && query !== '' && reviewList.length > 0 && <Group heading="Reviews">{reviewItems}</Group>}

              {threads.length > 0 && (
                <Group heading="Threads">
                  {threads.map((t) => (
                    <Command.Item
                      key={t.id}
                      value={`thread ${t.path} ${t.comments[0]?.body ?? ''}`}
                      onSelect={() => {
                        if (review === null) return;
                        review.setSelectedPath(t.path);
                        const codeView = review.codeViewRef;
                        void review.showDiff(t.path).then(() =>
                          codeView.current?.scrollTo({
                            type: 'line',
                            id: t.path,
                            lineNumber: t.startLine,
                            side: t.side === 'old' ? 'deletions' : 'additions',
                          }),
                        );
                        // Open (not toggle) — jumping to a thread shouldn't close an already-open panel.
                        review.setActiveThreadId(t.id);
                        review.setThreadsPanelOpen(true);
                        close();
                      }}
                      className={ITEM_CLASS}
                    >
                      <MessageSquare size={14} strokeWidth={1.5} aria-hidden />
                      <span className="truncate">
                        {t.path}:{t.startLine} — {threadSummary(t.comments[0]?.body ?? '') || '(empty)'}
                      </span>
                    </Command.Item>
                  ))}
                </Group>
              )}

              {query !== '' && files.length > 0 && <Group heading="Files">{fileItems}</Group>}
            </>
          )}

          {mode === 'file' && files.length > 0 && <Group heading="Files">{fileItems}</Group>}

          {mode === 'command' && <Group heading="Commands">{commandItems}</Group>}

          {/* No section headings in theme mode: colorblind-safe themes still
              lead the list, but as one run. It stays a `Command.Group` (just
              without a heading): cmdk re-sorts items by moving them within
              their group or the list, and throws on any other wrapper. */}
          {mode === 'theme' && (
            <Command.Group>
              <div className="flex flex-col">{themeTabItems}</div>
            </Command.Group>
          )}

          {mode === 'generate' && <Group heading={`${generateVerb} reading order with`}>{modelItems}</Group>}

          {mode === 'review' && reviewList.length > 0 && <Group heading="Reviews">{reviewItems}</Group>}
        </Command.List>
        <div className="flex h-8 items-center gap-3 border-t border-chrome-border px-3.5 text-micro text-chrome-fg-subtle">
          <span className="flex items-center gap-1">
            <Key>↑</Key>
            <Key>↓</Key>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <Key>↵</Key>
            select
          </span>
          <span className="flex items-center gap-1">
            <Key>esc</Key>
            {mode === 'root' ? 'close' : 'back'}
          </span>
        </div>
      </div>
    </Command.Dialog>
  );
}

/**
 * A group heading, styled on the heading node itself rather than via
 * `className` on `Command.Group` — that prop styles the whole group
 * subtree (cmdk renders it on the group's outer wrapper), which is what let
 * the small/subtle heading styles bleed onto every item beneath it.
 */
function Group({ heading, children }: { heading: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Command.Group
      heading={
        <span className="block px-2.5 pb-1 pt-2.5 text-xs font-medium text-chrome-fg-subtle">
          {heading}
        </span>
      }
    >
      <div className="flex flex-col">{children}</div>
    </Command.Group>
  );
}

function Key({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="flex h-4 min-w-4 items-center justify-center rounded-[3px] bg-chrome-bg-hover px-1 font-sans text-micro text-chrome-fg-muted">
      {children}
    </kbd>
  );
}

function ThemeItem({
  opt,
  active,
  onSelect,
}: {
  opt: ThemeOption;
  active: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <Hint label={opt.name} side="right">
      <Command.Item value={themeItemValue(opt)} onSelect={onSelect} className={ITEM_CLASS}>
        {opt.colorScheme === 'light' ? (
          <Sun size={14} strokeWidth={1.5} aria-hidden />
        ) : (
          <Moon size={14} strokeWidth={1.5} aria-hidden />
        )}
        <span className="truncate">{opt.displayName}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {opt.colorblindSafe && (
            <Hint label="Colorblind-safe">
              <span className="rounded-[3px] bg-chrome-bg-hover px-1 text-micro text-chrome-fg-muted">CB</span>
            </Hint>
          )}
          {active && <Check size={13} strokeWidth={2} className="text-chrome-accent!" aria-hidden />}
        </span>
      </Command.Item>
    </Hint>
  );
}
