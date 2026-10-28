/**
 * The keymap, declared as chords against a single modifier map so
 * a later Ctrl/Alt reading (Windows) costs one table swap, not a
 * rewrite. `tinykeys`'s own `$mod` already abstracts Cmd/Ctrl; `MOD.opt` is
 * the one platform-specific piece left for us to swap.
 */
import { tinykeys } from 'tinykeys';
import { useEffect, useRef } from 'react';
import { shouldIgnoreGlobalShortcut } from './keymapGuard.ts';

const MOD = {
  primary: '$mod', // Cmd on macOS, Ctrl elsewhere — tinykeys resolves this.
  opt: 'Alt', // Opt on macOS, Alt on Windows/Linux.
} as const;

export interface KeymapActions {
  nextHunk?: () => void;
  prevHunk?: () => void;
  nextStep?: () => void;
  prevStep?: () => void;
  nextThread?: () => void;
  prevThread?: () => void;
  commentOnSelection?: () => void;
  resolveThread?: () => void;
  toggleLeftPanel?: () => void;
  toggleRightPanel?: () => void;
  toggleThreadsPanel?: () => void;
  toggleComments?: () => void;
  toggleUnifiedSplit?: () => void;
  expandHunk?: () => void;
  expandWholeFile?: () => void;
  toggleFocusedFileCollapsed?: () => void;
  setRevisionWorking?: () => void;
  setRevisionHead?: () => void;
  setRevisionPr?: () => void;
  goHomebase?: () => void;
  openPalette?: () => void;
  /** `Cmd+P`: opens the command palette straight into its file-jump view. */
  openPaletteFiles?: () => void;
  /** `Cmd+Shift+P`: opens the command palette straight into its `>` commands view. */
  openPaletteCommands?: () => void;
  showHelp?: () => void;
}

/**
 * Static chord table: `tinykeys` binds once (see below) and each handler
 * reads the *current* action through the latest-actions ref, so this table
 * never needs to change shape across renders.
 *
 * Bug 1 fix (keymap audit, 2026-09-11): `tinykeys` matches a bound key
 * against `event.key` OR `event.code` — see `matchKeybindingPress` in
 * `node_modules/tinykeys/dist/tinykeys.mjs`:
 * `key.toUpperCase() !== event.key.toUpperCase() && key !== event.code`.
 * On macOS, holding Option remaps `event.key` (Option+B → "∫", not "b"),
 * and a plain letter like `"b"` doesn't equal `event.code` ("KeyB") either,
 * so a bound chord that combines `Alt` with a *character* key can never
 * match on a Mac. Every other chord in this table either has no `Alt`
 * modifier or (like this one) has been switched to bind the physical key
 * code instead. Audited: `${MOD.primary}+${MOD.opt}+KeyB` is the only
 * `Alt`+letter chord in this file.
 */
function buildKeymap(actionsRef: { current: KeymapActions }): Record<string, (e: KeyboardEvent) => void> {
  const bind = <K extends keyof KeymapActions>(chord: string, key: K): Record<string, (e: KeyboardEvent) => void> => {
    return {
      [chord]: (e: KeyboardEvent) => {
        const fn = actionsRef.current[key];
        if (fn === undefined) return;
        e.preventDefault();
        fn();
      },
    };
  };

  return {
    ...bind('j', 'nextHunk'),
    ...bind('k', 'prevHunk'),
    ...bind('n', 'nextStep'),
    ...bind('p', 'prevStep'),
    ...bind(']', 'nextThread'),
    ...bind('[', 'prevThread'),
    ...bind('c', 'commentOnSelection'),
    // Submitting a comment is not a global binding: the composer's own
    // textarea handles `$mod+Enter` (see CommentComposer.tsx), and plain
    // `Enter` there inserts a newline.
    ...bind('r', 'resolveThread'),
    ...bind(`${MOD.primary}+b`, 'toggleLeftPanel'),
    // Bug 1 fix: bind the physical key code (`KeyB`), not the character
    // (`b`) — see the doc comment above.
    ...bind(`${MOD.primary}+${MOD.opt}+KeyB`, 'toggleRightPanel'),
    ...bind('t', 'toggleThreadsPanel'),
    // Not in the key table: `c` starts a comment, so `Shift+c` hides/shows them.
    ...bind('Shift+c', 'toggleComments'),
    ...bind('u', 'toggleUnifiedSplit'),
    ...bind('e', 'expandHunk'),
    ...bind('Shift+e', 'expandWholeFile'),
    // Not in the key table (no key was assigned to per-file
    // collapse/expand there); `z` is free and mirrors vim's fold mnemonic.
    ...bind('z', 'toggleFocusedFileCollapsed'),
    ...bind('1', 'setRevisionWorking'),
    ...bind('2', 'setRevisionHead'),
    ...bind('3', 'setRevisionPr'),
    ...bind('g h', 'goHomebase'),
    ...bind(`${MOD.primary}+k`, 'openPalette'),
    // Plain `p` is already bound to `prevStep` above — these are both
    // `$mod` chords, so neither collides with it.
    //
    // Shift chords need the modifier spelled exactly `Shift` (capital S):
    // `matchKeybindingPress` requires every held modifier to appear in the
    // chord's own modifier list, checked via `event.getModifierState(mod)`,
    // and that DOM API is case-sensitive — `getModifierState('shift')`
    // silently returns `false`. Unlike the Alt+letter bug above, this one
    // isn't about `event.key` getting remapped (Shift doesn't do that, it's
    // Option/Alt), so binding the plain letter `p` here is fine; matching
    // is case-insensitive between the chord's key and `event.key`.
    ...bind(`${MOD.primary}+p`, 'openPaletteFiles'),
    ...bind(`${MOD.primary}+Shift+p`, 'openPaletteCommands'),
    // `?` is Shift+/ on most layouts, and tinykeys rejects a press that holds
    // a modifier the chord doesn't list — so a bare `'?'` never matched.
    // `[Shift]` marks Shift as allowed-but-not-required.
    ...bind('[Shift]+?', 'showHelp'),
  };
}

/** One row of the shortcut-help dialog (`?`). */
export interface ShortcutHelpRow {
  /** Chords as bound above (tinykeys syntax); alternatives render side by side. */
  chords: readonly string[];
  label: string;
}

export interface ShortcutHelpGroup {
  title: string;
  rows: readonly ShortcutHelpRow[];
}

/**
 * What the `?` dialog lists, grouped for reading. Chords are spelled exactly
 * as in `buildKeymap` above (same `MOD` map), so `formatChord` renders them
 * with the platform's real modifier names. Keep the two in step when adding
 * a binding.
 */
export const SHORTCUT_HELP: readonly ShortcutHelpGroup[] = [
  {
    title: 'Navigate',
    rows: [
      { chords: ['j', 'k'], label: 'Next / previous hunk' },
      { chords: ['n', 'p'], label: 'Next / previous reading-order step' },
      { chords: [']', '['], label: 'Next / previous open thread' },
      { chords: [`${MOD.primary}+Click`], label: 'Definition and uses of a name' },
      { chords: [`${MOD.primary}+Shift+Click`], label: 'Go straight to its definition' },
      { chords: [`${MOD.primary}+[`, `${MOD.primary}+]`], label: 'Back / forward through jumps' },
      { chords: ['g h'], label: 'Go to Homebase' },
    ],
  },
  {
    title: 'Comment',
    rows: [
      { chords: ['c'], label: 'Comment on selected lines' },
      { chords: [`${MOD.primary}+Enter`], label: 'Submit comment (in the composer)' },
      { chords: ['r'], label: 'Resolve current thread' },
      { chords: ['Shift+c'], label: 'Show / hide comments' },
    ],
  },
  {
    title: 'Diff',
    rows: [
      { chords: ['e'], label: 'Expand context around the current hunk' },
      { chords: ['Shift+e'], label: 'Expand the whole file' },
      { chords: ['z'], label: 'Collapse / expand the focused file' },
      { chords: ['u'], label: 'Unified / split' },
      { chords: ['1', '2', '3'], label: 'Revision: working / head / pr' },
    ],
  },
  {
    title: 'Panels',
    rows: [
      { chords: [`${MOD.primary}+b`], label: 'Toggle file tree' },
      { chords: [`${MOD.primary}+${MOD.opt}+KeyB`], label: 'Toggle reading order' },
      { chords: ['t'], label: 'Toggle threads panel' },
    ],
  },
  {
    title: 'Palette',
    rows: [
      { chords: [`${MOD.primary}+k`], label: 'Command palette' },
      { chords: [`${MOD.primary}+p`], label: 'Jump to file' },
      { chords: [`${MOD.primary}+Shift+p`], label: 'Commands' },
      { chords: ['?'], label: 'This help' },
    ],
  },
];

/**
 * Same platform test `tinykeys` uses to resolve `$mod` (Meta on Apple
 * platforms, Control elsewhere), so what we display is what it binds.
 */
function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

const KEY_LABELS: Record<string, string> = {
  Enter: '↵',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
};

/**
 * Renders a tinykeys chord for display, as a list of keycaps per step of a
 * sequence: `$mod+Shift+p` → `[['⌘', '⇧', 'P']]` on a Mac and
 * `[['Ctrl', 'Shift', 'P']]` elsewhere; `g h` → `[['G'], ['H']]`.
 */
export function formatChord(chord: string, apple: boolean = isApplePlatform()): string[][] {
  const modLabel: Record<string, string> = apple
    ? { $mod: '⌘', Meta: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧' }
    : { $mod: 'Ctrl', Meta: 'Meta', Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
  return chord.split(' ').map((press) => {
    // `+` is the separator; a chord never binds the literal `+` key here.
    const parts = press.split('+');
    const key = parts.pop() ?? '';
    const keyLabel = KEY_LABELS[key] ?? (/^Key[A-Z]$/.test(key) ? key.slice(3) : key.length === 1 ? key.toUpperCase() : key);
    return [...parts.map((m) => modLabel[m] ?? m), keyLabel];
  });
}

/**
 * Global keymap for the review window. `Cmd+W/T/N/Q` are
 * deliberately absent — a browser tab can never yield them, so nothing is
 * bound there.
 *
 * Bug 3 fix (keymap audit, 2026-09-11): `actions` is a fresh object literal
 * from the caller on every render. Previously the effect depended on
 * `[actions]`, so `tinykeys` tore down and rebound its listener on every
 * single render. Instead, the latest `actions` is kept in a ref (updated
 * after every render) and `tinykeys` is subscribed exactly once — handlers
 * read through the ref, so they always see the current actions without
 * needing to resubscribe.
 *
 * Bug 2 fix: single-key (unmodified) chords are suppressed while the event
 * target is a text field / contenteditable / open dialog, via the `ignore`
 * option — see `./keymapGuard.ts`. `$mod` chords keep working there.
 */
export function useGlobalKeymap(actions: KeymapActions): void {
  const actionsRef = useRef(actions);

  useEffect(() => {
    actionsRef.current = actions;
  });

  useEffect(() => {
    const unsubscribe = tinykeys(window, buildKeymap(actionsRef), {
      ignore: shouldIgnoreGlobalShortcut,
    });
    return unsubscribe;
  }, []);
}
