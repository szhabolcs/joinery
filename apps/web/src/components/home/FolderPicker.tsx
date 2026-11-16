/**
 * FolderPicker — browse the server's filesystem to register repositories.
 *
 * Built like the command palette (same frame, header, groups, footer): one
 * directory at a time (via `listDirs`), the input filters it, ↵ goes into a
 * folder, ⌘↵ ticks a repo. Ticks survive navigation, so repos from different
 * places can be added in one go, and a "master folder" is bulk-added with
 * "Select all". Repos that are already registered show up ticked and locked.
 */
import { Checkbox } from '@base-ui-components/react/checkbox';
import { Dialog } from '@base-ui-components/react/dialog';
import { Command } from 'cmdk';
import { Check, CornerLeftUp, Folder, FolderGit2, FolderOpen, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Repo } from '@joinery/core';
import { ApiError } from '../../lib/apiClient.ts';
import { useHomeData, type AddReposResult, type ListDirsResult } from '../../state/HomeData.tsx';
import { Hint } from '../controls.tsx';
import { isWindowsPath, pathSegments } from '../../lib/paths.ts';

interface Props {
  /** Called once everything requested was added. */
  onAdded(repos: Repo[]): void;
  onCancel(): void;
}

/** Same row as the command palette's items. */
const ITEM_CLASS =
  'group flex min-h-8 items-center gap-2.5 rounded-md px-2.5 text-body text-chrome-fg outline-hidden data-[selected=true]:bg-chrome-bg-active [&_svg]:shrink-0 [&_svg]:text-chrome-fg-subtle data-[selected=true]:[&_svg]:text-chrome-fg-muted';

/** cmdk item value for the "add the folder you're in" row; can't collide with a name (no `/` in names). */
const ADD_CURRENT = '/add-current';

/** `/a/b` -> `[{ name: 'a', path: '/a' }, { name: 'b', path: '/a/b' }]`; `C:\a` -> `[{ name: 'C:', path: 'C:\' }, { name: 'a', path: 'C:\a' }]`. */
function crumbsOf(path: string): { name: string; path: string }[] {
  const parts = pathSegments(path);
  if (!isWindowsPath(path)) return parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}` }));
  const prefix = path.startsWith('\\\\') ? '\\\\' : '';
  return parts.map((name, i) => ({
    name,
    path: `${prefix}${parts.slice(0, i + 1).join('\\')}${i === 0 && prefix === '' ? '\\' : ''}`,
  }));
}

function baseName(path: string): string {
  return pathSegments(path).at(-1) ?? path;
}

export function FolderPicker({ onAdded, onCancel }: Props): React.JSX.Element {
  const { listDirs, addRepos, repos: registered } = useHomeData();
  // Both sides are realpaths: `rootPath` is canonicalized at registration, listings under a realpath'd dir.
  const addedPaths = new Set(registered.map((r) => r.rootPath));
  const [listing, setListing] = useState<ListDirsResult | null>(null);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; hint?: string | undefined } | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AddReposResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A query that starts like a path is a "go to" (↵), not a filter.
  const isPathQuery = query.startsWith('/') || query.startsWith('~') || /^([a-zA-Z]:|\\\\)/.test(query);

  async function go(path?: string): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const next = await listDirs(path);
      setListing(next);
      setQuery('');
      setHighlighted(next.isRepo && !addedPaths.has(next.path) ? ADD_CURRENT : (next.entries[0]?.name ?? ''));
    } catch (err) {
      setError(err instanceof ApiError ? { message: err.message, hint: err.hint } : { message: 'Failed to list folder.' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void go();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- first load only
  }, []);

  async function add(paths: string[]): Promise<void> {
    setBusy(true);
    setResult(null);
    try {
      const res = await addRepos(paths);
      if (res.failed.length === 0) onAdded(res.added);
      else {
        setResult(res);
        // Keep only the failures ticked, so a retry doesn't re-add the rest.
        setSelected(new Set(res.failed.map((f) => f.path)));
      }
    } finally {
      setBusy(false);
    }
  }

  const toggle = (path: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const repos = listing?.entries.filter((e) => e.isRepo) ?? [];
  const folders = listing?.entries.filter((e) => !e.isRepo) ?? [];
  const selectableRepos = repos.filter((e) => !addedPaths.has(e.path));
  const allReposSelected = selectableRepos.length > 0 && selectableRepos.every((e) => selected.has(e.path));
  const setAllRepos = (on: boolean): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const e of selectableRepos) {
        if (on) next.add(e.path);
        else next.delete(e.path);
      }
      return next;
    });

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape' && query !== '') {
      // First Escape clears the query, like the palette; the second reaches the dialog and closes it.
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
    } else if (e.key === 'Backspace' && query === '' && listing?.parent != null) {
      e.preventDefault();
      void go(listing.parent);
    } else if (e.key === 'Enter' && isPathQuery) {
      // `preventDefault` also keeps cmdk from selecting the highlighted row.
      e.preventDefault();
      void go(query.trim());
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const entry = repos.find((r) => r.name === highlighted);
      if (entry !== undefined) {
        if (!addedPaths.has(entry.path)) toggle(entry.path);
      } else if (selected.size > 0 && !busy) void add([...selected]);
    }
  }

  const repoItem = (entry: ListDirsResult['entries'][number]): React.JSX.Element => {
    const added = addedPaths.has(entry.path);
    const ticked = added || selected.has(entry.path);
    // The checkbox sits over the row's left edge as its sibling, not inside the option:
    // an interactive control nested in an option is invisible to assistive tech.
    // cmdk unmounts a filtered-out item, so the row hides with it.
    return (
      <div key={entry.path} className="relative [&:not(:has([cmdk-item]))]:hidden">
        <Command.Item value={entry.name} onSelect={() => void go(entry.path)} className={ITEM_CLASS}>
          <span className="size-4 shrink-0" aria-hidden />
          <FolderGit2 size={14} strokeWidth={1.5} aria-hidden />
          <EntryName entry={entry} className="text-chrome-fg" />
          <ChevronHint />
        </Command.Item>
        <Hint label={added ? 'Already added' : undefined}>
          <Checkbox.Root
            checked={ticked}
            disabled={added}
            onCheckedChange={() => toggle(entry.path)}
            aria-label={added ? `${entry.name} is already added` : `Select ${entry.name}`}
            // Keep focus in the input, so typing and ↵ keep working.
            onMouseDown={(e) => e.preventDefault()}
            className="absolute top-1/2 left-2.5 flex size-4 -translate-y-1/2 items-center justify-center rounded-[4px] border border-chrome-border-strong transition-colors hover:border-chrome-fg-subtle data-checked:border-chrome-accent data-checked:bg-chrome-accent data-disabled:opacity-50"
          >
            <Checkbox.Indicator>
              <Check size={11} strokeWidth={2.5} className="text-chrome-accent-fg" aria-hidden />
            </Checkbox.Indicator>
          </Checkbox.Root>
        </Hint>
      </div>
    );
  };

  return (
    // Same backdrop and frame as the command palette. The popup's `role="dialog"` makes `keymapGuard` suppress global shortcuts.
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Popup
          aria-label="Add repositories"
          initialFocus={inputRef}
          // Keys stay in here; Escape goes on to the dialog, which closes.
          onKeyDown={(e) => {
            if (e.key !== 'Escape') e.stopPropagation();
          }}
          className="fixed left-1/2 top-[14vh] z-50 flex max-h-[min(560px,76vh)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl bg-chrome-bg-raised shadow-[0_16px_48px_-12px_rgba(0,0,0,0.35),0_0_0_0.5px_light-dark(rgba(20,22,30,0.18),rgba(255,255,255,0.1))] outline-hidden"
        >
          <Command
            label="Add repositories"
            shouldFilter={!isPathQuery}
            value={highlighted}
            onValueChange={setHighlighted}
            loop
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="flex h-12 shrink-0 items-center gap-2.5 px-3.5">
              <span className="flex h-5 shrink-0 items-center rounded-md bg-chrome-accent-soft px-1.5 text-xs font-medium text-chrome-accent">
                Add repo
              </span>
              <Command.Input
                ref={inputRef}
                value={query}
                onValueChange={setQuery}
                onKeyDown={onInputKeyDown}
                placeholder="Filter folders, or type a path…"
                spellCheck={false}
                autoComplete="off"
                className="w-full bg-transparent text-[14px] text-chrome-fg outline-hidden placeholder:text-chrome-fg-subtle"
              />
            </div>

            {listing !== null && (
              <nav aria-label="Path" className="flex min-w-0 shrink-0 items-center gap-0.5 px-3.5 pb-2 text-xs text-chrome-fg-subtle">
                <Hint label="Up one folder (⌫)">
                  <button
                    type="button"
                    aria-label="Up one folder"
                    disabled={loading || listing.parent === null}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void go(listing.parent ?? undefined)}
                    className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-[4px] hover:bg-chrome-bg-hover hover:text-chrome-fg disabled:opacity-40"
                  >
                    <CornerLeftUp size={13} strokeWidth={1.75} aria-hidden />
                  </button>
                </Hint>
                <div className="flex min-w-0 items-center gap-0.5 overflow-hidden whitespace-nowrap [direction:rtl]">
                  {/* rtl keeps the tail of a long path visible; the inner span restores reading order. */}
                  <span className="flex items-center gap-0.5 [direction:ltr]">
                    {!isWindowsPath(listing.path) && <Crumb label="/" onClick={() => void go('/')} />}
                    {crumbsOf(listing.path).map((c, i, all) => (
                      <span key={c.path} className="flex items-center gap-0.5">
                        {i > 0 && <span aria-hidden>/</span>}
                        <Crumb label={c.name} current={i === all.length - 1} onClick={() => void go(c.path)} />
                      </span>
                    ))}
                  </span>
                </div>
              </nav>
            )}

            <Command.List
              // Scrollable containers take focus on click in Chromium, which would strand
              // the keyboard (⌫, ↵, filtering) outside the input; hand it straight back.
              onFocus={(e) => {
                if (e.target === e.currentTarget) inputRef.current?.focus();
              }}
              className={`min-h-0 flex-1 overflow-y-auto border-t border-chrome-border px-1.5 pt-1 pb-1.5 transition-opacity ${
                loading && listing !== null ? 'opacity-50' : ''
              }`}
            >
              {listing === null ? (
                <div className="px-3 py-8 text-center text-xs text-chrome-fg-muted">{loading ? 'Loading…' : 'Nothing to show.'}</div>
              ) : (
                <>
                  <Command.Empty className="px-3 py-8 text-center text-xs text-chrome-fg-muted">
                    {isPathQuery ? 'Press ↵ to go to this path.' : query !== '' ? 'No matching folders.' : 'No subfolders.'}
                  </Command.Empty>

                  {listing.isRepo && (
                    <Group heading="This folder">
                      {addedPaths.has(listing.path) ? (
                        <Command.Item value={ADD_CURRENT} disabled className={ITEM_CLASS}>
                          <Check size={14} strokeWidth={1.5} aria-hidden />
                          <span className="truncate text-chrome-fg-muted">
                            <span className="font-medium">{baseName(listing.path)}</span> is already added
                          </span>
                        </Command.Item>
                      ) : (
                        <Command.Item
                          value={ADD_CURRENT}
                          keywords={['add', baseName(listing.path)]}
                          disabled={busy}
                          onSelect={() => void add([listing.path])}
                          className={ITEM_CLASS}
                        >
                          <Plus size={14} strokeWidth={1.5} aria-hidden />
                          <span className="truncate">
                            Add <span className="font-medium">{baseName(listing.path)}</span>
                          </span>
                        </Command.Item>
                      )}
                    </Group>
                  )}

                  {repos.length > 0 && (
                    <Group
                      heading={`Repositories · ${String(repos.length)}`}
                      action={
                        selectableRepos.length > 0 && (
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => setAllRepos(!allReposSelected)}
                            className="font-normal hover:text-chrome-fg"
                          >
                            {allReposSelected ? 'Select none' : 'Select all'}
                          </button>
                        )
                      }
                    >
                      {repos.map(repoItem)}
                    </Group>
                  )}

                  {folders.length > 0 && (
                    <Group heading="Folders">
                      {folders.map((entry) => (
                        <Command.Item key={entry.path} value={entry.name} onSelect={() => void go(entry.path)} className={ITEM_CLASS}>
                          {/* Spacer the width of a checkbox, so names line up with the repos above. */}
                          <span className="size-4 shrink-0" aria-hidden />
                          <Folder size={14} strokeWidth={1.5} aria-hidden />
                          <EntryName entry={entry} className="text-chrome-fg-muted group-data-[selected=true]:text-chrome-fg" />
                          <ChevronHint />
                        </Command.Item>
                      ))}
                    </Group>
                  )}
                </>
              )}
            </Command.List>

            {(error !== null || result !== null) && (
              <div className="flex shrink-0 flex-col gap-0.5 border-t border-chrome-border bg-chrome-danger-bg px-3.5 py-2 text-xs text-chrome-danger">
                {error !== null && (
                  <>
                    <p>{error.message}</p>
                    {error.hint !== undefined && <p>{error.hint}</p>}
                  </>
                )}
                {result !== null && (
                  <>
                    <p className="font-medium">
                      {result.added.length > 0 ? `Added ${String(result.added.length)}, ` : ''}
                      {String(result.failed.length)} failed — still ticked to retry:
                    </p>
                    {result.failed.map((f) => (
                      <div key={f.path}>
                        <Hint label={`${f.path}\n${f.message}`}>
                          <p className="truncate">
                            <span className="font-mono">{baseName(f.path)}</span> — {f.message}
                          </p>
                        </Hint>
                        {f.hint !== undefined && <p>{f.hint}</p>}
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}

            <div className="flex h-10 shrink-0 items-center gap-3 border-t border-chrome-border pr-2 pl-3.5 text-micro text-chrome-fg-subtle">
              <span className="flex items-center gap-1">
                <Key>↵</Key>
                open
              </span>
              <span className="flex items-center gap-1">
                <Key>⌘</Key>
                <Key>↵</Key>
                select
              </span>
              <span className="flex items-center gap-1">
                <Key>⌫</Key>
                up
              </span>
              <span className="flex items-center gap-1">
                <Key>esc</Key>
                close
              </span>
              <button
                type="button"
                disabled={busy || selected.size === 0}
                onClick={() => void add([...selected])}
                className="chrome-btn-primary ml-auto disabled:opacity-40"
              >
                <FolderOpen size={13} strokeWidth={1.75} aria-hidden />
                {busy ? 'Adding…' : selected.size === 0 ? 'Add selected' : `Add ${String(selected.size)} ${selected.size === 1 ? 'repo' : 'repos'}`}
              </button>
            </div>
          </Command>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Group({
  heading,
  action,
  children,
}: {
  heading: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Command.Group
      heading={
        <span className="flex items-center justify-between px-2.5 pt-2.5 pb-1 text-xs font-medium text-chrome-fg-subtle">
          {heading}
          {action}
        </span>
      }
    >
      {children}
    </Command.Group>
  );
}

/** The row's name, with notes under it: the worktree's repo, and whether macOS will prompt before opening it. */
function EntryName({ entry, className }: { entry: ListDirsResult['entries'][number]; className: string }): React.JSX.Element {
  const notes = [
    entry.worktreeOf !== undefined && `Worktree of ${entry.worktreeOf}`,
    entry.macPrivacyPrompt === true && 'macOS will ask to allow access',
  ].filter((n) => n !== false);
  if (notes.length === 0) return <span className={`truncate ${className}`}>{entry.name}</span>;
  return (
    <span className="flex min-w-0 flex-col py-1 leading-tight">
      <span className={`truncate ${className}`}>{entry.name}</span>
      <span className="truncate text-micro text-chrome-fg-subtle">{notes.join(' · ')}</span>
    </span>
  );
}

function Crumb({ label, current = false, onClick }: { label: string; current?: boolean; onClick(): void }): React.JSX.Element {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`rounded-[3px] px-0.5 hover:text-chrome-fg ${current ? 'font-medium text-chrome-fg-muted' : ''}`}
    >
      {label}
    </button>
  );
}

/** "Go in" affordance, only on the highlighted row. */
function ChevronHint(): React.JSX.Element {
  return (
    <span className="ml-auto hidden items-center gap-1 text-micro text-chrome-fg-subtle group-data-[selected=true]:flex">
      open
      <Key>↵</Key>
    </span>
  );
}

function Key({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="flex h-4 min-w-4 items-center justify-center rounded-[3px] bg-chrome-bg-hover px-1 font-sans text-micro text-chrome-fg-muted">
      {children}
    </kbd>
  );
}
