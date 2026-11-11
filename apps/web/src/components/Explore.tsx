/**
 * Explore — a finder over real repositories, the last section of Homebase
 * (scroll down, or `goExplore()` to jump there).
 *
 * One search field, the repositories as pills (or All of them), then the
 * branches, local and remote. Open pull requests already live in Homebase's
 * "Up for review", so pull requests only show up here once you type: the
 * cached open ones that match, whatever their review status, then whatever the
 * forge search finds beyond them, closed and merged too. A branch whose PR
 * is listed is left out, the PR row standing for it. Reviews in progress
 * show up too, with a "reviewing" chip, and open where they left off. The
 * Branches heading has filter and sort menus (`home/BranchMenus.tsx`),
 * remembered in localStorage and applied by the server. Rows use the same
 * shape as Homebase's queue so the two screens rhyme without Explore growing
 * a personality of its own.
 *
 * Data comes from `useHomeData()` (repos, open pulls) plus direct, debounced
 * calls per repo/query: `listBranches` (branches aren't part of the shared
 * snapshot since there can be thousands of them per repo) and `searchPulls`
 * (closed and merged PRs, and open ones beyond the cached 200).
 */
import { Cloud, FolderGit2, GitBranch, HardDrive, Layers, Plus, Search, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { compareBranches, type Branch, type BranchSort, type Pull, type PullSearchResult, type PullState, type Repo, type ReviewStatus } from '@joinery/core';
import { ApiError, callApi } from '../lib/apiClient.ts';
import { firstForgeNotice, forgeNoticeLine, forgeNoticeText, type ForgeNotice } from '../lib/forgeNotice.ts';
import { effortOf } from '../lib/effort.ts';
import { personFrom, type Person } from '../lib/people.ts';
import { relativeTime } from '../lib/relativeTime.ts';
import { useStoredState } from '../lib/storedState.ts';
import { EXPLORE_ID } from '../lib/router.ts';
import { useHomeData } from '../state/HomeData.tsx';
import {
  BranchFilterMenu,
  BranchSortMenu,
  branchFiltersActive,
  NO_BRANCH_FILTERS,
  RECENT_DAYS,
  type BranchFilters,
} from './home/BranchMenus.tsx';
import { Hint, Segment, Segmented } from './controls.tsx';
import { FolderPicker } from './home/FolderPicker.tsx';
import { Panel } from './home/Panel.tsx';
import { Avatar, Chip, CiIcon, EffortMeter, SectionHeading, type Tone } from './home/primitives.tsx';

const BRANCH_DEBOUNCE_MS = 200;
const BRANCH_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_CHARS = 2;
/** The repo pill that stands for every repository at once. */
const ALL_REPOS = '*';
const BRANCH_FILTERS_KEY = 'joinery.explore.branch-filters';
const BRANCH_SORT_KEY = 'joinery.explore.branch-sort';
const REPO_KEY = 'joinery.explore.repo';

/** The `listBranches` query for a filter set and sort (the defaults are left off). */
function branchQuery(filters: BranchFilters, sort: BranchSort) {
  return {
    ...(sort === 'recent' ? {} : { sort }),
    ...(filters.mine ? { mine: 'true' as const } : {}),
    ...(filters.unmerged ? { unmerged: 'true' as const } : {}),
    ...(filters.where === 'any' ? {} : { where: filters.where }),
    ...(filters.recent ? { since: RECENT_DAYS } : {}),
    ...(filters.review === 'any' ? {} : { review: filters.review }),
  };
}

type Row =
  | { kind: 'pull'; repoId: string; pull: Pull }
  | { kind: 'found'; repoId: string; found: PullSearchResult }
  | { kind: 'branch'; repoId: string; branch: Branch };
type RepoPull = { repoId: string; pull: Pull };
type RepoBranch = { repoId: string; branch: Branch };

function pullKey(repoId: string, n: number): string {
  return `pull-${repoId}-${String(n)}`;
}
function branchKey(repoId: string, name: string): string {
  return `branch-${repoId}-${name}`;
}
function rowKeyOf(row: Row): string {
  if (row.kind === 'pull') return pullKey(row.repoId, row.pull.number);
  if (row.kind === 'found') return pullKey(row.repoId, row.found.number);
  return branchKey(row.repoId, row.branch.name);
}

const STATE_TONE: Record<PullState, Tone> = { open: 'success', draft: 'neutral', merged: 'accent', closed: 'danger' };

/** A PR number typed as `1234` or `#1234`; one digit is enough to search for it. */
function isNumberQuery(needle: string): boolean {
  return /^#?\d+$/.test(needle);
}

/** A pull/branch whose review is `open` or `orphaned`: in progress, so it gets a "reviewing" chip. */
function isReviewing(status: ReviewStatus | null): boolean {
  return status === 'open' || status === 'orphaned';
}

/** A repo's short name: its remote's, else its folder's. */
export function repoLabel(r: Repo): string {
  if (r.remoteName !== null) return r.remoteName;
  const trimmed = r.rootPath.replace(/\/+$/, '');
  const segments = trimmed.split('/');
  return segments[segments.length - 1] || r.rootPath;
}

export function ExploreSection(): React.JSX.Element {
  const { repos, pullsByRepo, pullsAvailable, pullsNotice, loading, error, openPull, openPullNumber, openBranch } = useHomeData();

  const [repoId, setRepoIdState] = useStoredState<string>(REPO_KEY, ALL_REPOS);
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();

  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const [addingRepo, setAddingRepo] = useState(false);
  const [storedFilters, setBranchFilters] = useStoredState<BranchFilters>(BRANCH_FILTERS_KEY, NO_BRANCH_FILTERS);
  // Older stored shapes get the defaults for anything they lack.
  const branchFilters: BranchFilters = { ...NO_BRANCH_FILTERS, ...storedFilters };
  const [branchSort, setBranchSort] = useStoredState<BranchSort>(BRANCH_SORT_KEY, 'recent');
  const branchQueryKey = JSON.stringify(branchQuery(branchFilters, branchSort));

  // Branches are tagged with the scope + query they were fetched for, so a
  // switch keeps the old list on screen (dimmed) until the new one lands
  // instead of collapsing to empty and back — the page doesn't jump.
  const [branchState, setBranchState] = useState<{ key: string; branches: RepoBranch[]; truncated: boolean }>({
    key: '',
    branches: [],
    truncated: false,
  });
  const [searchState, setSearchState] = useState<{ key: string; pulls: PullSearchResult[]; available: boolean; notice: ForgeNotice | null }>({
    key: '',
    pulls: [],
    available: true,
    notice: null,
  });
  const branchReqIdRef = useRef(0);
  const branchAbortRef = useRef<AbortController | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const noRepos = !loading && repos.length === 0;

  // Fall back to All if the picked repo goes away.
  useEffect(() => {
    if (repos.length === 0) return;
    setRepoIdState((prev) => (prev === ALL_REPOS || repos.some((r) => r.id === prev) ? prev : ALL_REPOS));
  }, [repos]);

  const all = repoId === ALL_REPOS;
  const repo = all ? undefined : repos.find((r) => r.id === repoId);
  const repoById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);
  // The repos in scope, as a string so a refreshed-but-equal `repos` doesn't refetch.
  const scopeKey = all ? repos.map((r) => r.id).join('\n') : repoId;
  const scopeIds = useMemo(() => (scopeKey === '' ? [] : scopeKey.split('\n')), [scopeKey]);
  const fetchKey = `${scopeKey}\0${needle}`;
  // Branches also refetch when their filters or sort change.
  const branchFetchKey = `${fetchKey}\0${branchQueryKey}`;
  const branchesStale = branchState.key !== branchFetchKey;

  // Open PRs matching the query. With no query there's nothing to list:
  // the open ones are Homebase's "Up for review".
  const pulls = useMemo<RepoPull[]>(() => {
    if (needle === '') return [];
    return scopeIds
      .flatMap((id) => (pullsByRepo.get(id) ?? []).map((pull) => ({ repoId: id, pull })))
      .filter(
        ({ pull: p }) =>
          p.title.toLowerCase().includes(needle) ||
          p.headRefName.toLowerCase().includes(needle) ||
          `#${String(p.number)}`.includes(needle),
      )
      .sort((a, b) => b.pull.updatedAtUnix - a.pull.updatedAtUnix);
  }, [pullsByRepo, scopeIds, needle]);

  // Debounced, abortable branch fetch. Stale responses are dropped via a
  // request counter as well as the abort, in case a server races past it.
  useEffect(() => {
    if (scopeIds.length === 0) {
      setBranchState({ key: branchFetchKey, branches: [], truncated: false });
      return;
    }
    const filterQuery = JSON.parse(branchQueryKey) as ReturnType<typeof branchQuery>;
    const timer = setTimeout(() => {
      branchAbortRef.current?.abort();
      const controller = new AbortController();
      branchAbortRef.current = controller;
      const reqId = ++branchReqIdRef.current;
      void (async () => {
        try {
          const results = await Promise.all(
            scopeIds.map(async (id) => {
              const res = await callApi('listBranches', {
                params: [id],
                query: { limit: BRANCH_LIMIT, ...filterQuery, ...(needle !== '' ? { filter: needle } : {}) },
                signal: controller.signal,
              });
              return { id, branches: res.branches };
            }),
          );
          if (reqId !== branchReqIdRef.current) return;
          const compare = compareBranches(filterQuery.sort ?? 'recent');
          setBranchState({
            key: branchFetchKey,
            // Each repo's page is already in this order; merging keeps it across repos.
            branches: results
              .flatMap(({ id, branches }) => branches.map((branch) => ({ repoId: id, branch })))
              .sort((a, b) => compare(a.branch, b.branch)),
            truncated: results.some((r) => r.branches.length === BRANCH_LIMIT),
          });
        } catch (err) {
          if (reqId !== branchReqIdRef.current) return;
          if (err instanceof ApiError) setOpenError(err.message);
        }
      })();
    }, BRANCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [scopeIds, needle, branchFetchKey, branchQueryKey]);

  useEffect(() => () => branchAbortRef.current?.abort(), []);

  // Debounced PR search for what the cached open list can't answer. Each
  // change of query/scope aborts the request still running for the last one.
  const searchable = scopeIds.length > 0 && (isNumberQuery(needle) || needle.length >= SEARCH_MIN_CHARS);
  const searching = searchable && searchState.key !== fetchKey;
  useEffect(() => {
    if (!searchable) {
      setSearchState((prev) => (prev.pulls.length === 0 && prev.key === '' ? prev : { key: '', pulls: [], available: true, notice: null }));
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await callApi('searchPulls', {
            query: { q: needle, repos: scopeIds.join(',') },
            signal: controller.signal,
          });
          const { unavailableReason, unavailableHost } = res;
          const notice: ForgeNotice | null =
            unavailableReason === undefined
              ? null
              : {
                  reason: unavailableReason,
                  host: unavailableHost ?? null,
                  forge: repos.find((r) => r.remoteHost === unavailableHost)?.forge ?? null,
                };
          setSearchState({ key: fetchKey, pulls: res.pulls, available: res.available, notice });
        } catch {
          // Aborted by a newer query, or the search failed; either way the local matches stand.
          if (!controller.signal.aborted) setSearchState({ key: fetchKey, pulls: [], available: true, notice: null });
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchable, needle, scopeIds, fetchKey]);

  // Search hits not already listed above: the open PRs we already hold are
  // the cached matches, so they're dropped here.
  const found = useMemo(() => {
    if (!searchable || searchState.key !== fetchKey) return [];
    const known = new Set(
      Array.from(pullsByRepo.entries()).flatMap(([id, ps]) => ps.map((p) => pullKey(id, p.number))),
    );
    return searchState.pulls.filter((f) => !known.has(pullKey(f.repoId, f.number)));
  }, [searchable, searchState, fetchKey, pullsByRepo]);

  // A PR's branch is left out only while that PR's row is listed above.
  const branches = useMemo(() => {
    const heads = new Set(pulls.map(({ repoId: id, pull: p }) => `${id}\0${p.headRefName}`));
    return branchState.branches.filter(({ repoId: id, branch: b }) => !heads.has(`${id}\0${b.name}`));
  }, [branchState, pulls]);

  const rows = useMemo<Row[]>(
    () => [
      ...pulls.map(({ repoId: id, pull }): Row => ({ kind: 'pull', repoId: id, pull })),
      ...found.map((f): Row => ({ kind: 'found', repoId: f.repoId, found: f })),
      ...branches.map(({ repoId: id, branch }): Row => ({ kind: 'branch', repoId: id, branch })),
    ],
    [pulls, found, branches],
  );

  // Reset the highlight whenever the query or the selected repo changes.
  useEffect(() => {
    setHighlighted(null);
  }, [needle, repoId]);

  useEffect(() => {
    if (highlighted === null) return;
    const row = rows[highlighted];
    if (row === undefined) return;
    rowRefs.current.get(rowKeyOf(row))?.scrollIntoView({ block: 'nearest' });
  }, [highlighted, rows]);

  function setRowRef(key: string, el: HTMLLIElement | null): void {
    if (el === null) rowRefs.current.delete(key);
    else rowRefs.current.set(key, el);
  }

  async function openRow(row: Row): Promise<void> {
    const key = rowKeyOf(row);
    setBusyKey(key);
    setOpenError(null);
    try {
      if (row.kind === 'pull') {
        await openPull(row.repoId, row.pull);
      } else if (row.kind === 'found') {
        await openPullNumber(row.repoId, row.found.number);
      } else {
        await openBranch(row.repoId, row.branch);
      }
    } catch (err) {
      setOpenError(err instanceof ApiError ? err.message : 'Failed to open.');
    } finally {
      setBusyKey(null);
    }
  }

  function handleNavKey(e: { key: string; preventDefault: () => void }): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (rows.length === 0) return;
      e.preventDefault();
      setHighlighted((prev) => {
        if (prev === null) return e.key === 'ArrowDown' ? 0 : rows.length - 1;
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        return (prev + delta + rows.length) % rows.length;
      });
    } else if (e.key === 'Enter') {
      const idx = highlighted ?? (needle !== '' ? 0 : null);
      if (idx === null) return;
      const row = rows[idx];
      if (row === undefined) return;
      e.preventDefault();
      void openRow(row);
    } else if (e.key === 'Escape') {
      if (q !== '') setQ('');
    }
  }

  const handleNavKeyRef = useRef(handleNavKey);
  handleNavKeyRef.current = handleNavKey;

  // A single listener on the island's DOM node catches bubbled keydowns from
  // anywhere inside it — the search field, but also a row button once it has
  // focus after a click — so arrow-key navigation keeps working either way.
  // The search field's own `onKeyDown` (below) already handles its keys, so
  // it's excluded here to avoid double-processing.
  useEffect(() => {
    const main = mainRef.current;
    if (main === null) return;
    const listener = (e: KeyboardEvent): void => {
      if (e.target === searchInputRef.current) return;
      handleNavKeyRef.current(e);
    };
    main.addEventListener('keydown', listener);
    return () => main.removeEventListener('keydown', listener);
  }, []);

  const pullsUnavailable = scopeIds.length > 0 && scopeIds.every((id) => pullsAvailable.get(id) === false);
  const pullsNoticeText = pullsUnavailable ? firstForgeNotice(scopeIds.map((id) => pullsNotice.get(id)), 'list') : null;
  const partialNoticeText = pullsUnavailable ? null : forgeNoticeLine(scopeIds.map((id) => pullsNotice.get(id)), 'list');
  const repoNameOf = (id: string): string | undefined => {
    if (!all) return undefined;
    const r = repoById.get(id);
    return r !== undefined ? repoLabel(r) : undefined;
  };

  function handleAdded(added: Repo[]): void {
    if (added[0] !== undefined) setRepoIdState(added[0].id);
    setAddingRepo(false);
  }
  const displayError = openError ?? error;

  return (
    <Panel
      icon={<Sparkles aria-hidden />}
      title="Explore"
      // A screen tall, less the sticky top bar and the page's foot (version and
      // margins), so scrolled to the bottom the whole panel is in view below the
      // bar; the lists scroll inside it, so switching repos never resizes the page.
      className="h-[calc(100dvh-10rem)] scroll-mt-16"
      bodyClassName="flex flex-col px-0 pb-0"
    >
      {/* `id` on a wrapper rather than the panel so `goExplore()` can find it. */}
      <div ref={mainRef} id={EXPLORE_ID} className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col gap-7 px-4 pt-2">
              {!noRepos && (
                <>
                  {/* The search field is the hero of this page: big, borderless
                      inside, one focus ring. Everything below filters as you type. */}
                  <label className="home-card flex h-11 items-center gap-3 px-3.5 shadow-none! focus-within:border-chrome-accent">
                    <Search size={16} strokeWidth={1.75} className="shrink-0 text-chrome-fg-subtle" aria-hidden />
                    <input
                      ref={searchInputRef}
                      disabled={loading}
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      onKeyDown={handleNavKey}
                      placeholder={`Search a branch, a PR title, or #number ${all ? 'across all repos' : `in ${repo !== undefined ? repoLabel(repo) : 'this repo'}`}`}
                      spellCheck={false}
                      autoComplete="off"
                      aria-label="Search branches and pull requests"
                      className="h-full min-w-0 flex-1 bg-transparent text-body text-chrome-fg outline-hidden placeholder:text-chrome-fg-subtle disabled:opacity-60"
                    />
                  </label>
                  {displayError !== null && <p className="text-xs text-chrome-danger">{displayError}</p>}
                </>
              )}

              <div className="flex flex-wrap items-center gap-1.5">
                <Segmented
                  // With a single repo, "All" is hidden and that repo reads as picked.
                  value={all && repos.length === 1 ? (repos[0]?.id ?? ALL_REPOS) : repoId}
                  onChange={setRepoIdState}
                  aria-label="Repository"
                  className="contents"
                >
                  {repos.length > 1 && (
                    <RepoPill value={ALL_REPOS} icon={<Layers size={13} strokeWidth={1.75} aria-hidden />} label="All" />
                  )}
                  {repos.map((r) => (
                    <RepoPill
                      key={r.id}
                      value={r.id}
                      icon={<FolderGit2 size={13} strokeWidth={1.75} aria-hidden />}
                      label={repoLabel(r)}
                      title={r.rootPath}
                    />
                  ))}
                </Segmented>
                <button
                  type="button"
                  onClick={() => setAddingRepo(true)}
                  className="flex h-7 items-center gap-1.5 rounded-full border border-dashed border-chrome-border-strong px-3 text-xs font-medium text-chrome-fg-muted! transition-colors hover:border-chrome-fg-subtle hover:text-chrome-fg!"
                >
                  <Plus size={13} strokeWidth={1.75} aria-hidden />
                  Add repository
                </button>
              </div>
              {addingRepo && <FolderPicker onAdded={handleAdded} onCancel={() => setAddingRepo(false)} />}

              {noRepos ? (
                <Empty>Register a repository to start.</Empty>
              ) : (
                <div className="-mx-4 flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-4 pb-6">
                  {needle !== '' && (
                    <section className="flex flex-col gap-2">
                      <SectionHeading title="Pull requests" count={pulls.length} />
                      {loading ? (
                        <Empty>Loading…</Empty>
                      ) : pullsUnavailable ? (
                        <Empty>{pullsNoticeText ?? 'Install and sign in to `gh`, `glab` or `gt` to list pull requests.'}</Empty>
                      ) : pulls.length === 0 ? (
                        <Empty>{`No open pull requests match "${q.trim()}".`}</Empty>
                      ) : (
                        <ul role="listbox" aria-label="Pull requests" className="-mx-2.5 flex flex-col">
                          {pulls.map(({ repoId: id, pull: p }) => {
                            const key = pullKey(id, p.number);
                            const idx = rows.findIndex((r) => rowKeyOf(r) === key);
                            return (
                              <PullRow
                                key={key}
                                pull={p}
                                repoName={repoNameOf(id)}
                                highlighted={idx === highlighted}
                                busy={busyKey === key}
                                registerRef={(el) => setRowRef(key, el)}
                                onOpen={() => void openRow({ kind: 'pull', repoId: id, pull: p })}
                              />
                            );
                          })}
                        </ul>
                      )}
                      {!loading && partialNoticeText !== null && <p className="px-0.5 text-xs text-chrome-fg-muted">{partialNoticeText}</p>}
                    </section>
                  )}

                  {searchable && (found.length > 0 || searching || !searchState.available) && (
                    <section className="flex flex-col gap-2">
                      <SectionHeading title="More pull requests" count={found.length} />
                      {found.length === 0 ? (
                        <Empty>{searching ? 'Searching…' : forgeNoticeText(searchState.notice, 'search') ?? 'Install and sign in to `gh`, `glab` or `gt` to search pull requests.'}</Empty>
                      ) : (
                        <ul
                          role="listbox"
                          aria-label="More pull requests"
                          aria-busy={searching}
                          className="-mx-2.5 flex flex-col"
                        >
                          {found.map((f) => {
                            const key = pullKey(f.repoId, f.number);
                            const idx = rows.findIndex((r) => rowKeyOf(r) === key);
                            return (
                              <FoundRow
                                key={key}
                                found={f}
                                repoName={repoNameOf(f.repoId)}
                                highlighted={idx === highlighted}
                                busy={busyKey === key}
                                registerRef={(el) => setRowRef(key, el)}
                                onOpen={() => void openRow({ kind: 'found', repoId: f.repoId, found: f })}
                              />
                            );
                          })}
                        </ul>
                      )}
                    </section>
                  )}

                  <section className="flex flex-col gap-2">
                    {/* Pinned while the list scrolls under it; the panel's own background keeps rows from showing through. */}
                    <div className="sticky top-0 z-10 -mx-4 bg-chrome-bg px-4 py-1.5">
                      <SectionHeading
                        title="Branches"
                        count={branches.length}
                        action={
                          <div className="flex items-center gap-0.5">
                            <BranchFilterMenu filters={branchFilters} onChange={setBranchFilters} />
                            <BranchSortMenu sort={branchSort} onChange={setBranchSort} />
                          </div>
                        }
                      />
                    </div>
                    {loading || (branchesStale && branches.length === 0) ? (
                      <Empty>Loading…</Empty>
                    ) : branches.length === 0 ? (
                      <Empty>
                        {needle !== ''
                          ? `No branches match "${q.trim()}"${branchFiltersActive(branchFilters) ? ' with these filters' : ''}.`
                          : branchFiltersActive(branchFilters)
                            ? 'No branches match these filters.'
                            : 'No branches.'}
                      </Empty>
                    ) : (
                      <ul
                        role="listbox"
                        aria-label="Branches"
                        aria-busy={branchesStale}
                        className={`-mx-2.5 flex flex-col transition-opacity ${branchesStale ? 'opacity-50' : ''}`}
                      >
                        {branches.map(({ repoId: id, branch: b }) => {
                          const key = branchKey(id, b.name);
                          const idx = rows.findIndex((r) => rowKeyOf(r) === key);
                          return (
                            <BranchRow
                              key={key}
                              branch={b}
                              repoName={repoNameOf(id)}
                              isDefault={b.name === repoById.get(id)?.defaultBranch}
                              highlighted={idx === highlighted}
                              busy={busyKey === key}
                              registerRef={(el) => setRowRef(key, el)}
                              onOpen={() => void openRow({ kind: 'branch', repoId: id, branch: b })}
                            />
                          );
                        })}
                      </ul>
                    )}
                  </section>
                </div>
              )}
            </div>
      </div>
    </Panel>
  );
}

function RepoPill({
  value,
  icon,
  label,
  title,
}: {
  value: string;
  icon: React.ReactNode;
  label: string;
  title?: string;
}): React.JSX.Element {
  return (
    <Segment
      value={value}
      title={title}
      // Text colours carry `!`: the unlayered global `button { color: inherit }`
      // in styles/index.css otherwise beats layered Tailwind utilities.
      className="flex h-7 items-center gap-1.5 rounded-full border border-transparent bg-chrome-bg-hover px-3 text-xs font-medium text-chrome-fg-muted! transition-colors not-data-pressed:hover:bg-chrome-bg-active not-data-pressed:hover:text-chrome-fg! data-pressed:border-chrome-accent data-pressed:bg-chrome-accent-soft data-pressed:text-chrome-accent!"
    >
      {icon}
      {label}
    </Segment>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="rounded-lg border border-dashed border-chrome-border px-4 py-6 text-center text-xs text-chrome-fg-muted">{children}</p>
  );
}

function PullRow({
  pull: p,
  repoName,
  highlighted,
  busy,
  registerRef,
  onOpen,
}: {
  pull: Pull;
  repoName: string | undefined;
  highlighted: boolean;
  busy: boolean;
  registerRef: (el: HTMLLIElement | null) => void;
  onOpen: () => void;
}): React.JSX.Element {
  const author: Person = personFrom(p.authorLogin);
  const effort = effortOf({ filesTotal: p.changedFiles, additions: p.additions, deletions: p.deletions });
  return (
    <li ref={registerRef} role="option" aria-selected={highlighted}>
      <button
        type="button"
        aria-busy={busy}
        disabled={busy}
        onClick={onOpen}
        className={`group flex w-full items-start gap-2.5 rounded-md px-2.5 py-2.5 text-left transition-colors hover:bg-chrome-bg-hover disabled:cursor-wait ${highlighted ? 'bg-chrome-bg-hover' : ''}`}
      >
        <Avatar person={author} size={24} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-body font-medium text-chrome-fg">{p.title}</span>
            {p.isDraft && <Chip>draft</Chip>}
            {p.reviewRequested && <Chip tone="accent">Review requested</Chip>}
            {isReviewing(p.reviewStatus) && <Chip tone="accent">reviewing</Chip>}
            {p.reviewStatus === 'draft' && <Chip>opened</Chip>}
            {p.reviewStatus === 'archived' && <Chip>archived</Chip>}
          </span>
          <span className="flex items-center gap-1.5 text-micro text-chrome-fg-subtle">
            <CiIcon ci={p.ci} size={11} />
            <span className="truncate">
              {repoName !== undefined && `${repoName} `}#{p.number} · {p.headRefName} → {p.baseRefName}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
          <EffortMeter level={effort.level} label={effort.label} minutes={effort.minutes} />
          <span className="text-micro tabular-nums text-chrome-fg-subtle">{relativeTime(p.updatedAtUnix)}</span>
        </span>
      </button>
    </li>
  );
}

function FoundRow({
  found: f,
  repoName,
  highlighted,
  busy,
  registerRef,
  onOpen,
}: {
  found: PullSearchResult;
  repoName: string | undefined;
  highlighted: boolean;
  busy: boolean;
  registerRef: (el: HTMLLIElement | null) => void;
  onOpen: () => void;
}): React.JSX.Element {
  const author: Person = personFrom(f.authorLogin);
  return (
    <li ref={registerRef} role="option" aria-selected={highlighted}>
      <button
        type="button"
        aria-busy={busy}
        disabled={busy}
        onClick={onOpen}
        className={`group flex w-full items-start gap-2.5 rounded-md px-2.5 py-2.5 text-left transition-colors hover:bg-chrome-bg-hover disabled:cursor-wait ${highlighted ? 'bg-chrome-bg-hover' : ''}`}
      >
        <Avatar person={author} size={24} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-body font-medium text-chrome-fg">{f.title}</span>
            <Chip tone={STATE_TONE[f.state]}>{f.state}</Chip>
          </span>
          <span className="truncate text-micro text-chrome-fg-subtle">
            {repoName !== undefined && `${repoName} `}#{f.number}
          </span>
        </span>
        <span className="shrink-0 pt-0.5 text-micro tabular-nums text-chrome-fg-subtle">{relativeTime(f.updatedAtUnix)}</span>
      </button>
    </li>
  );
}

function BranchRow({
  branch: b,
  repoName,
  isDefault,
  highlighted,
  busy,
  registerRef,
  onOpen,
}: {
  branch: Branch;
  repoName: string | undefined;
  isDefault: boolean;
  highlighted: boolean;
  busy: boolean;
  registerRef: (el: HTMLLIElement | null) => void;
  onOpen: () => void;
}): React.JSX.Element {
  const author: Person = personFrom(b.authorName);
  return (
    <li ref={registerRef} role="option" aria-selected={highlighted}>
      <button
        type="button"
        aria-busy={busy}
        disabled={busy}
        onClick={onOpen}
        className={`group flex w-full items-start gap-2.5 rounded-md px-2.5 py-2.5 text-left transition-colors hover:bg-chrome-bg-hover disabled:cursor-wait ${highlighted ? 'bg-chrome-bg-hover' : ''}`}
      >
        <Avatar person={author} size={24} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-xs font-medium text-chrome-fg">{b.name}</span>
            {isDefault && <Chip>default</Chip>}
            {isReviewing(b.reviewStatus) && <Chip tone="accent">reviewing</Chip>}
            {b.reviewStatus === 'draft' && <Chip>opened</Chip>}
            {b.reviewStatus === 'archived' && <Chip>archived</Chip>}
          </span>
          <span className="flex items-center gap-1.5 text-micro text-chrome-fg-subtle">
            <GitBranch size={11} strokeWidth={2} className="shrink-0" aria-hidden />
            <span className="truncate">
              {repoName !== undefined && `${repoName} · `}
              {b.subject ?? ''}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
          <Hint label={b.hasLocalRef && b.hasRemoteRef ? 'Local and on origin' : b.hasLocalRef ? 'Local only' : 'Only on origin'}>
            <span
              className="flex items-center gap-1 text-micro text-chrome-fg-muted"
            >
              {b.hasLocalRef && <HardDrive size={11} strokeWidth={2} aria-label="local" />}
              {b.hasRemoteRef && <Cloud size={11} strokeWidth={2} aria-label="origin" />}
              {!isDefault && b.ahead !== null && b.behind !== null && (b.ahead > 0 || b.behind > 0) && (
                <span className="tabular-nums">
                  ↑{b.ahead} ↓{b.behind}
                </span>
              )}
            </span>
          </Hint>
          <span className="text-micro tabular-nums text-chrome-fg-subtle">{relativeTime(b.committerDate)}</span>
        </span>
      </button>
    </li>
  );
}
