/**
 * Homebase — first pass at "an actual homebase", on real data.
 *
 * Two questions, two places: *what am I reviewing* (the page, centre) and
 * *what could I pick up next* (the queue, right). Both are ordered by an
 * effort score so the lightest thing is always at the top, and both wear
 * the same score glyph so the two columns read as one system.
 *
 * Behind the panels sits a backdrop — solid, a glow rising from the
 * bottom, or a painting — chosen from the corner switcher and remembered,
 * so the screen has a mood rather than a flat grey. A painting (or a
 * glow's gradient, `GlowScene`) fills the whole window behind the page
 * (`HomeBackdrop`), going soft and dark toward the bottom, and the panels
 * turn to frosted glass over it. The greeting sits where the picture starts
 * to blur, the two columns below it, and Explore (the finder over every
 * branch and pull request) below those, a scroll away.
 *
 * Everything here comes from `useHomeData()`.
 */
import { Menu } from '@base-ui-components/react/menu';
import { firstForgeNotice, forgeNoticeLine } from '../lib/forgeNotice.ts';
import { AGENT_MODELS, type AgentModel, type Pull, type Repo, type Review, type ReviewSummary } from '@joinery/core';
import {
  Archive,
  Check,
  Clock,
  GitPullRequest,
  Loader2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Settings as SettingsIcon,
  Waypoints,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useGenerationModel } from '../lib/agentModel.ts';
import { effortOf } from '../lib/effort.ts';
import { useGlobalKeymap } from '../lib/keymap.ts';
import { maybeStartOnboarding } from '../lib/onboarding.ts';
import { backdropProps, coverGlow, coverPainting, useBackdrop, useBackdropStyle } from '../lib/covers.ts';
import { useHeroTones } from '../lib/heroTone.ts';
import { personFrom } from '../lib/people.ts';
import { pullUrl } from '../lib/pullUrl.ts';
import { relativeTime } from '../lib/relativeTime.ts';
import { useStoredState } from '../lib/storedState.ts';
import { goReview, goSettings } from '../lib/router.ts';
import { useHomeData, type HomeReview } from '../state/HomeData.tsx';
import { useTheme } from '../state/ThemeContext.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { Hint, MENU_POPUP_CLASS, POPUP_ITEM_CLASS, Segment, Segmented } from './controls.tsx';
import { BackdropPicker } from './home/BackdropPicker.tsx';
import { HeroBand, HomeBackdrop } from './home/HomeBackdrop.tsx';
import { Panel } from './home/Panel.tsx';
import { Avatar, Chip, CiIcon, DiffStat, EffortMeter, ProgressBar } from './home/primitives.tsx';
import { QueueFilterMenu, QueueSortMenu, type QueueSort } from './home/QueueMenus.tsx';
import { ExploreSection } from './Explore.tsx';
import { UpdateButton, useVersion, VersionText } from './home/VersionBadge.tsx';
import { FolderPicker } from './home/FolderPicker.tsx';

type Order = 'effort' | 'recent';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const HERO_HEIGHT = 'clamp(220px, 50vh, 500px)';
/** Roughly how far the panels' top sits below the top padding (the greeting's two lines and the gap under them): where the full-window blur is complete. */
const PANELS_BELOW_GREETING = 96;
/** The full-window layout's equivalent: lower, so more of the picture shows sharp above the greeting before the blur takes over. */
const WINDOW_HERO_HEIGHT = 'clamp(260px, 56vh, 660px)';
/** Space above Explore: this much normally, shrinking toward the minimum so its header still peeks in when the panels end on screen. */
const EXPLORE_GAP_MAX = 72;
const EXPLORE_GAP_MIN = 24;
/** How much of Explore must show at the fold to read as "more below": its header and a sliver of body. */
const EXPLORE_PEEK = 48;
/**
 * How long the first load gets before a skeleton shows. A warm server
 * answers well inside it, and then the page appears once, fully laid out,
 * instead of flashing a skeleton, a nameless greeting, and the real thing
 * in quick succession.
 */
const SKELETON_DELAY_MS = 300;
/** Glows the text in the page colour so it reads over the painting. */
const GLOW_BG = '0 0 18px var(--chrome-bg-sunken), 0 0 6px var(--chrome-bg-sunken)';
/**
 * Over a full-window backdrop the greeting sits on the picture itself, so
 * it's coloured the way the wordmark is: from the tone of the picture
 * behind it (`heroTones.center`), light on dark and dark on light, with no
 * glow.
 */
const GREETING_ON = {
  dark: { date: { color: 'rgba(255,255,255,0.75)' }, title: { color: '#fff' } },
  light: { date: { color: 'rgba(0,0,0,0.65)' }, title: { color: '#111' } },
} as const;

const DATE = new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long' });

/** `remoteName` when known, else the last path segment of `rootPath`. */
function repoDisplayName(repo: Repo): string {
  if (repo.remoteName !== null) return repo.remoteName;
  const segments = repo.rootPath.split('/').filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? repo.rootPath;
}

function reviewTitle(review: Review, summary: ReviewSummary): string {
  return summary.title ?? review.branch ?? (review.pinnedSha !== null ? review.pinnedSha.slice(0, 10) : 'detached');
}

function reviewLastActivityAt(hr: HomeReview): number {
  return hr.summary.lastActivityAt ?? hr.summary.headCommittedAt ?? hr.review.createdAt;
}

export function Homebase(): React.JSX.Element {
  const {
    repos,
    reviews,
    pullsByRepo,
    pullsAvailable,
    pullsNotice,
    me,
    loading,
    refreshing,
    error,
    lastLoadedAt,
    refresh,
    openPull,
    archiveReview,
    generateReadingOrder,
  } = useHomeData();
  // First load done (or failed): the page can show for real.
  const ready = lastLoadedAt !== null || error !== null;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setSlow(true), SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, [ready]);
  // A first visit to an empty Joinery gets the onboarding flow (lib/onboarding.ts).
  const loaded = lastLoadedAt !== null;
  useEffect(() => {
    if (loaded) maybeStartOnboarding(repos.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on the first load
  }, [loaded]);
  const [order, setOrder] = useState<Order>('effort');
  const [onlyRequested, setOnlyRequested] = useStoredState(ONLY_REQUESTED_KEY, false);
  const [queueSort, setQueueSort] = useStoredState<QueueSort>(QUEUE_SORT_KEY, 'effort');
  const [hiddenRepoIds, setHiddenRepoIds] = useStoredState<readonly string[]>(QUEUE_HIDDEN_REPOS_KEY, []);
  const version = useVersion();
  const { chromeMode } = useTheme();
  const [openingKeys, setOpeningKeys] = useState<ReadonlySet<string>>(new Set());
  const [backdrop, setBackdrop] = useBackdrop();
  const [backdropStyle, setBackdropStyle] = useBackdropStyle();
  const scrollRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const [exploreGap, setExploreGap] = useState(EXPLORE_GAP_MAX);
  // Cmd+K / Cmd+Shift+P, as on the review page; without a review the palette
  // offers the reviews, themes and light/dark (see CommandPalette.tsx).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [addingRepo, setAddingRepo] = useState(false);
  const [paletteMode, setPaletteMode] = useState<'command' | undefined>(undefined);
  useGlobalKeymap({
    openPalette: () => {
      setPaletteMode(undefined);
      setPaletteOpen(true);
    },
    openPaletteCommands: () => {
      setPaletteMode('command');
      setPaletteOpen(true);
    },
  });

  // The sticky top bar only gets its backdrop once the page has moved under it.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const onScroll = () => setScrolled(scroller.scrollTop > 8);
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);

  // When the panels end inside the first screen, pull Explore up just enough
  // that its header shows at the fold — a cue that the page scrolls. Past
  // the fold there's nothing to do: cut-off cards already say so.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const top = topRef.current;
    if (scroller === null || top === null) return;
    const measure = () => {
      const topBottom = top.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + scroller.scrollTop;
      if (topBottom >= scroller.clientHeight) {
        setExploreGap(EXPLORE_GAP_MAX);
        return;
      }
      const room = scroller.clientHeight - topBottom - EXPLORE_PEEK;
      setExploreGap(Math.min(EXPLORE_GAP_MAX, Math.max(EXPLORE_GAP_MIN, room)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    ro.observe(top);
    return () => ro.disconnect();
  }, []);
  const painting = coverPainting(backdrop);
  const glow = coverGlow(backdrop);
  const hasHero = painting !== null || glow !== null;
  const fullWindow = hasHero && backdropStyle === 'window';
  // What's behind the wordmark: the hero's corner at the top, the page once the bar's backdrop has faded in.
  const heroTones = useHeroTones(painting, glow);
  // In the window style the picture is always behind the bar, scrolled or not.
  const overHero = hasHero && (fullWindow || !scrolled);
  const behindLogo = overHero ? (heroTones.left ?? chromeMode) : chromeMode;
  // The buttons only need recolouring over the hero; elsewhere the chrome colours already fit.
  const behindButtons = overHero ? (heroTones.right ?? undefined) : undefined;

  const greetingOn = fullWindow ? GREETING_ON[heroTones.center ?? chromeMode] : null;
  // Over a painting not sampled yet, the greeting waits for its colour rather than showing in a guessed one and switching.
  const greetingWaits = fullWindow && heroTones.pending;

  const youName = me?.name ?? me?.login ?? null;

  const reviewing = useMemo(() => reviews.filter((r) => r.bucket === 'attention'), [reviews]);
  const done = useMemo(() => reviews.filter((r) => r.bucket === 'done').sort((a, b) => reviewLastActivityAt(b) - reviewLastActivityAt(a)), [reviews]);

  const list = useMemo(() => {
    return [...reviewing].sort((a, b) =>
      order === 'effort' ? effortOf(a.summary).score - effortOf(b.summary).score : reviewLastActivityAt(b) - reviewLastActivityAt(a),
    );
  }, [order, reviewing]);

  // The queue: every open PR across every repo that has no review yet
  // (or only an unstarted draft one). Archived reviews stay out for good.
  // Lightest first by default — so "I have twenty minutes" has an obvious
  // answer — or by last update, either way.
  const queue = useMemo(
    () =>
      Array.from(pullsByRepo.entries())
        .flatMap(([repoId, pulls]) =>
          pulls
            .filter((p) => p.reviewId === null || p.reviewStatus === 'draft')
            .map((p) => ({ repoId, pull: p })),
        )
        .sort((a, b) => {
          if (queueSort === 'newest') return b.pull.updatedAtUnix - a.pull.updatedAtUnix;
          if (queueSort === 'oldest') return a.pull.updatedAtUnix - b.pull.updatedAtUnix;
          return (
            effortOf({ filesTotal: a.pull.changedFiles, additions: a.pull.additions, deletions: a.pull.deletions }).score -
            effortOf({ filesTotal: b.pull.changedFiles, additions: b.pull.additions, deletions: b.pull.deletions }).score
          );
        }),
    [pullsByRepo, queueSort],
  );

  const queueRepoName = (repoId: string): string => {
    const repo = repos.find((r) => r.id === repoId);
    return repo !== undefined ? repoDisplayName(repo) : repoId;
  };
  // Only repos with something in the queue are worth filtering by.
  const queueRepos = Array.from(new Set(queue.map((q) => q.repoId)), (id) => ({ id, name: queueRepoName(id) })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const hiddenRepos = new Set(hiddenRepoIds);
  const queueFiltered = onlyRequested || queueRepos.some((r) => hiddenRepos.has(r.id));
  const shownQueue = queue.filter((q) => (!onlyRequested || q.pull.reviewRequested) && !hiddenRepos.has(q.repoId));

  const handleOpenPull = (repoId: string, pull: Pull) => {
    const key = `${repoId}:${String(pull.number)}`;
    setOpeningKeys((s) => new Set(s).add(key));
    void openPull(repoId, pull).finally(() => {
      setOpeningKeys((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    });
  };

  const handleArchiveAll = () => {
    void (async () => {
      for (const r of done) {
        await archiveReview(r.review.id);
      }
    })();
  };

  const showSkeleton = !ready || (loading && reviews.length === 0);
  // Until the first load lands or runs long, everything below the hero is
  // laid out (so the Explore gap is measured) but transparent; then it all
  // fades in at once.
  const hidden = !ready && !slow;
  const showNoRepos = !showSkeleton && repos.length === 0;
  const topPad = hasHero ? `calc(${fullWindow ? WINDOW_HERO_HEIGHT : HERO_HEIGHT} - 84px)` : '2.5rem';
  const noPullsAvailable = repos.length > 0 && repos.every((r) => pullsAvailable.get(r.id) === false);
  const noPullsNotice = noPullsAvailable ? firstForgeNotice(repos.map((r) => pullsNotice.get(r.id)), 'list') : null;
  // Some repos answered, others couldn't be asked: show what there is, plus a quiet note.
  const partialNotice = noPullsAvailable ? null : forgeNoticeLine(repos.map((r) => pullsNotice.get(r.id)), 'list');
  const showQueue = showSkeleton || noPullsAvailable || queue.length > 0;

  return (
    <div className="home-shell h-full" {...backdropProps(backdrop)} data-backdrop-style={hasHero ? backdropStyle : undefined}>
      {/* The picture sits outside the scroller, so the page slides over it while it stays put. */}
      {fullWindow && <HomeBackdrop backdrop={backdrop} painting={painting} glow={glow} softBy={`calc(${topPad} + ${String(PANELS_BELOW_GREETING)}px)`} />}
      <div ref={scrollRef} className="relative h-full overflow-y-auto">
        {/* Sticky top bar. Zero-height so it takes no room in the flow; its
            contents hang below it. Over the hero it's bare; once the page
            scrolls under it, a backdrop fades in so the panels pass behind
            a solid edge rather than under floating buttons. */}
        <div className="sticky top-0 z-30 h-0">
          <div
            className={`pointer-events-none absolute inset-x-0 top-0 h-32 transition-opacity duration-300 ${scrolled && !fullWindow ? 'opacity-100' : 'opacity-0'}`}
            style={{ background: TOPBAR_FADE }}
            aria-hidden
          />
          {/* Left: the Joinery wordmark, 16px in from the top and the left alike (onboarding draws it in the same spot). The -dark file is the one drawn for dark backgrounds. */}
          <img
            src={behindLogo === 'dark' ? '/joinery-wordmark-squircle-dark.svg' : '/joinery-wordmark-squircle-light.svg'}
            alt="Joinery"
            className="pointer-events-none absolute top-4 left-4 h-[30px] w-auto select-none"
          />
          {/* Right: an update (when there is one), the backdrop switcher, settings, then refresh; centred on the wordmark's line (16 + 30/2 − 36/2). */}
          <div className="home-topbar-right absolute top-[13px] right-4 flex h-9 items-center gap-1" data-tone={behindButtons}>
            <UpdateButton {...version} />
            <BackdropPicker value={backdrop} onChange={setBackdrop} layout={backdropStyle} onLayoutChange={setBackdropStyle} />
            <Hint label="Settings">
              <button type="button" aria-label="Settings" onClick={goSettings} className="chrome-icon-btn">
                <SettingsIcon size={16} strokeWidth={1.75} aria-hidden />
              </button>
            </Hint>
            <Hint label="Refresh">
              <button
                type="button"
                aria-label="Refresh"
                onClick={() => void refresh({ force: true })}
                className="chrome-icon-btn"
              >
                <RefreshCw size={16} strokeWidth={1.75} className={refreshing || loading ? 'animate-spin' : ''} aria-hidden />
              </button>
            </Hint>
          </div>
        </div>
        {hasHero && !fullWindow && <HeroBand backdrop={backdrop} painting={painting} glow={glow} mode={chromeMode} height={HERO_HEIGHT} />}

        <div
          className={`relative mx-auto flex max-w-6xl flex-col gap-6 px-2 pb-10 transition-opacity duration-150 ${hidden ? 'opacity-0' : 'opacity-100'}`}
          style={{ paddingTop: topPad }}
          aria-busy={!ready}
        >
          <div ref={topRef} className="flex flex-col gap-6">
            {/* mb-6 on top of the gap lets the panels start just past the hero's edge, not on it. */}
            <header className="mb-6 flex flex-col items-center gap-1">
              <p className={`text-xs text-chrome-fg-muted transition-opacity duration-150 ${greetingWaits ? 'opacity-0' : ''}`} style={greetingOn?.date ?? { textShadow: GLOW_BG }}>
                {DATE.format(new Date())}
              </p>
              {/* Held invisible (keeping its line) while the skeleton shows, so it doesn't appear, then grow a name. */}
              <h1
                className={`text-center text-2xl font-semibold tracking-tight text-chrome-fg transition-opacity duration-150 ${ready ? '' : 'invisible opacity-0'} ${greetingWaits ? 'opacity-0' : ''}`}
                style={greetingOn?.title ?? { textShadow: GLOW_BG }}
              >
                {greeting()}
                {youName !== null ? `, ${youName}` : ''}
              </h1>
            </header>

            {error !== null && (
              <div className="flex items-center justify-center gap-2 text-xs text-chrome-danger">
                <span>{error}</span>
                <button type="button" onClick={() => void refresh({ force: true })} className="chrome-btn">
                  Retry
                </button>
              </div>
            )}

            {/* Both columns share one height: the row's, set by the reviews (with a floor that grows with the screen); the queue scrolls inside it. */}
            {/* Without the queue pane the cards would stretch across the whole column, so the row narrows to roughly the width they have beside it, and Explore narrows with it. */}
            <div className={`flex min-h-[max(18rem,50dvh)] w-full items-stretch gap-3 ${showQueue ? '' : 'mx-auto max-w-4xl'}`}>
              <main className="flex min-w-0 flex-1 flex-col gap-3">
                {showSkeleton ? (
                  // The real panel, so the swap to cards only changes what's inside it.
                  <Panel icon={<GitPullRequest aria-hidden />} title="Currently reviewing" className="flex-1" bodyClassName="px-2 pb-2">
                    <div className="flex flex-col gap-2">
                      <SkeletonBlocks />
                    </div>
                  </Panel>
                ) : showNoRepos ? (
                  <Panel title="Currently reviewing" className="flex-1">
                    <div className="flex flex-col items-center gap-3 py-16 text-center">
                      <p className="text-xs text-chrome-fg-muted">Nothing here just yet!</p>
                      <button type="button" onClick={() => setAddingRepo(true)} className="chrome-btn">
                        Add your first repo
                      </button>
                    </div>
                  </Panel>
                ) : (
                  <Panel
                    icon={<GitPullRequest aria-hidden />}
                    title="Currently reviewing"
                    count={list.length}
                    className="flex-1"
                    bodyClassName="flex flex-col px-0 pb-0"
                    actions={
                      // Ordering one (or no) review changes nothing, so the tabs only show when there's something to reorder.
                      list.length > 1 ? (
                        <Segmented value={order} onChange={setOrder} aria-label="Order">
                          <Segment value="effort">Lightest first</Segment>
                          <Segment value="recent">Recent</Segment>
                        </Segmented>
                      ) : undefined
                    }
                  >
                    {/* One table: in-progress rows, then the cleared ones under their own subheader. */}
                    {reviewing.length === 0 ? (
                      <p className="mx-2 mb-2 rounded-lg border border-dashed border-chrome-border px-4 py-6 text-center text-xs text-chrome-fg-muted">
                        Nothing in review — pick something up from the queue
                      </p>
                    ) : (
                      <ul className="divide-y divide-chrome-border">
                        {list.map((r) => (
                          <ReviewCard
                            key={r.review.id}
                            review={r}
                            onGenerateReadingOrder={generateReadingOrder}
                            onArchive={archiveReview}
                          />
                        ))}
                      </ul>
                    )}
                    {done.length > 0 && (
                      <>
                        {/* `mt-auto` pins Cleared to the bottom of the card, below any empty space. */}
                        <div className="mt-auto flex h-8 shrink-0 items-center gap-2 border-t border-chrome-border bg-chrome-bg-hover/40 pl-4 pr-1.5">
                          <Check size={12} strokeWidth={2} className="text-chrome-fg-subtle" aria-hidden />
                          <h3 className="text-micro font-medium text-chrome-fg-muted">Cleared</h3>
                          <span className="text-micro tabular-nums text-chrome-fg-subtle">{done.length}</span>
                          <button type="button" onClick={handleArchiveAll} className="chrome-btn ml-auto h-6 bg-transparent px-1.5">
                            <Archive size={13} strokeWidth={1.75} aria-hidden />
                            Archive all
                          </button>
                        </div>
                        <ul className="divide-y divide-chrome-border">
                          {done.map((r) => (
                            <DoneRow key={r.review.id} review={r} onArchive={archiveReview} />
                          ))}
                        </ul>
                      </>
                    )}
                  </Panel>
                )}
              </main>

              {/* No queue, no pane: Currently reviewing takes the full width. The forge CLI hint still shows. */}
              {showQueue && (
                // The absolute box takes the row's height without adding to it, so a long queue scrolls instead of stretching the row.
                <div className="relative w-96 shrink-0">
                  <Panel
                    icon={<Clock aria-hidden />}
                    title="Up for review"
                    count={shownQueue.length}
                    actions={
                      <>
                        <QueueFilterMenu
                          onlyRequested={onlyRequested}
                          onOnlyRequestedChange={setOnlyRequested}
                          repos={queueRepos}
                          hiddenRepoIds={hiddenRepos}
                          onRepoToggle={(repoId, shown) =>
                            setHiddenRepoIds((ids) => (shown ? ids.filter((id) => id !== repoId) : [...ids, repoId]))
                          }
                        />
                        <QueueSortMenu sort={queueSort} onSortChange={setQueueSort} />
                      </>
                    }
                    className="absolute! inset-0"
                    bodyClassName="flex flex-col px-0 pb-0"
                  >
                    {showSkeleton ? (
                      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pt-1 pb-2">
                        <SkeletonBlocks height={92} />
                      </div>
                    ) : noPullsAvailable ? (
                      <div className="px-2 pt-1 pb-2">
                        <p className="rounded-lg border border-dashed border-chrome-border px-4 py-6 text-center text-xs text-chrome-fg-muted">
                          {noPullsNotice ?? (
                            <>
                              Install and sign in to <code>gh</code>, <code>glab</code> or <code>gt</code> to see open pull requests here.
                            </>
                          )}
                        </p>
                      </div>
                    ) : shownQueue.length === 0 ? (
                      <div className="px-2 pt-1 pb-2">
                        <p className="rounded-lg border border-dashed border-chrome-border px-4 py-6 text-center text-xs text-chrome-fg-muted">
                          {queueFiltered ? 'Nothing matches these filters' : "Nobody's asked for your review right now"}
                        </p>
                      </div>
                    ) : (
                      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pt-1 pb-2">
                        {shownQueue.map(({ repoId, pull }) => {
                          const key = `${repoId}:${String(pull.number)}`;
                          return (
                            <QueueRow
                              key={key}
                              repoName={queueRepoName(repoId)}
                              repoId={repoId}
                              pull={pull}
                              opening={openingKeys.has(key)}
                              onOpen={handleOpenPull}
                            />
                          );
                        })}
                      </ul>
                    )}
                    {!showSkeleton && partialNotice !== null && (
                      <p className="px-4 pb-3 text-xs text-chrome-fg-muted">{partialNotice}</p>
                    )}
                  </Panel>
                </div>
              )}
            </div>
          </div>

          {!showSkeleton && (
            // A chapter break, not just a gap: what's in hand above, everything else below.
            // The column's own gap-6 (24px) counts toward the space above.
            <div className={`w-full ${showQueue ? '' : 'mx-auto max-w-4xl'}`} style={{ paddingTop: exploreGap - EXPLORE_GAP_MIN }}>
              <ExploreSection />
            </div>
          )}

          {/* The page's foot: just the version; updating lives top-right. */}
          <div className="flex justify-center pt-4">
            <VersionText info={version.info} />
          </div>
        </div>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} initialMode={paletteMode} />
      {addingRepo && <FolderPicker onAdded={() => setAddingRepo(false)} onCancel={() => setAddingRepo(false)} />}
    </div>
  );
}

function SkeletonBlocks({ height = 96 }: { height?: number }): React.JSX.Element {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} className="home-card animate-pulse" style={{ height }} />
      ))}
    </>
  );
}

/** The sticky top bar's backdrop: a see-through veil behind the buttons, then an eased fade so there's no visible edge. */
const TOPBAR_FADE = `linear-gradient(to bottom, ${[
  [0.7, 0],
  [0.66, 22],
  [0.55, 40],
  [0.38, 56],
  [0.22, 70],
  [0.1, 84],
  [0.03, 93],
  [0, 100],
]
  .map(([a, at]) => `color-mix(in srgb, var(--chrome-bg-sunken) ${String((a ?? 0) * 100)}%, transparent) ${String(at)}%`)
  .join(', ')})`;

const ONLY_REQUESTED_KEY = 'joinery.queue.only-requested';
const QUEUE_SORT_KEY = 'joinery.queue.sort';
const QUEUE_HIDDEN_REPOS_KEY = 'joinery.queue.hidden-repos';

function ReviewCard({
  review: hr,
  onGenerateReadingOrder,
  onArchive,
}: {
  review: HomeReview;
  onGenerateReadingOrder: (id: string, model: AgentModel) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
}): React.JSX.Element {
  const { review, summary, repo } = hr;
  const title = reviewTitle(review, summary);
  const author = personFrom(summary.authorName);
  const effort = effortOf(summary);
  const prHref = review.prNumber === null ? null : pullUrl(repo, review.prNumber);
  return (
    // The whole card opens the review via an underlay button, so the real
    // controls inside it (the PR link, the options menu) aren't nested in a
    // button. Content ignores the pointer except those controls.
    <li className="group relative transition-colors hover:bg-chrome-bg-hover">
      <button type="button" onClick={() => goReview(review.id)} aria-label={`Open ${title}`} className="absolute inset-0" />
      <div className="pointer-events-none relative flex items-stretch gap-4 px-4 py-3">
        <Avatar person={author} size={32} />

        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* After the title: PR number, CI, then state (draft / branch gone). */}
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-body font-medium text-chrome-fg">{title}</span>
            {review.prNumber !== null &&
              (prHref !== null ? (
                <Hint label="Open pull request in a new tab">
                  <a
                    href={prHref}
                    target="_blank"
                    rel="noreferrer"
                    className="pointer-events-auto flex shrink-0 items-center gap-0.5 text-micro tabular-nums text-chrome-fg-subtle hover:text-chrome-fg hover:underline"
                  >
                    <GitPullRequest size={11} strokeWidth={2} aria-hidden />
                    {review.prNumber}
                  </a>
                </Hint>
              ) : (
                <span className="flex shrink-0 items-center gap-0.5 text-micro tabular-nums text-chrome-fg-subtle">
                  <GitPullRequest size={11} strokeWidth={2} aria-hidden />
                  {review.prNumber}
                </span>
              ))}
            <CiIcon ci={summary.ci} size={12} />
            {summary.draft && <Chip>draft</Chip>}
            {review.status === 'orphaned' && <Chip>branch gone</Chip>}
          </span>
          {/* Repo, then base ← branch: set apart by space rather than a dot. */}
          <span className="flex min-w-0 items-center gap-3 text-micro text-chrome-fg-subtle">
            <span className="shrink-0">{repoDisplayName(repo)}</span>
            <span className="truncate">
              {review.baseRef} ← {review.branch ?? 'detached'}
            </span>
          </span>
        </span>

        {/* Right column, three aligned lines: time to review, progress, diff size · files viewed. */}
        <span className="flex w-48 shrink-0 flex-col justify-between gap-1.5 text-micro">
          <span className="flex items-center justify-end">
            <EffortMeter level={effort.level} label={effort.label} minutes={effort.minutes} />
            {/* Options, after the time: zero-width until the row is hovered (or it's focused / open),
                then it slides open and pushes the time left; it slides back on the way out. */}
            <span className="-my-0.5 flex w-0 shrink-0 justify-end overflow-hidden opacity-0 transition-[width,opacity] duration-150 group-hover:w-[26px] group-hover:opacity-100 focus-within:w-[26px] focus-within:opacity-100 has-[[aria-expanded=true]]:w-[26px] has-[[aria-expanded=true]]:opacity-100">
              <ReviewOptions
                generating={summary.agentRunning}
                hasReadingOrder={summary.hasReadingOrder}
                onGenerateReadingOrder={(model) => void onGenerateReadingOrder(review.id, model)}
                onArchive={() => void onArchive(review.id)}
              />
            </span>
          </span>
          {summary.filesTotal !== null && <ProgressBar value={summary.viewedFiles} total={summary.filesTotal} />}
          <span className="flex items-end justify-between leading-none">
            {summary.filesTotal === null ? (
              <span className="text-chrome-fg-subtle">—</span>
            ) : (
              <DiffStat additions={summary.additions ?? 0} deletions={summary.deletions ?? 0} blocks={false} />
            )}
            <span className="tabular-nums whitespace-nowrap text-chrome-fg-subtle">
              <span className="font-medium text-chrome-fg-muted">{summary.viewedFiles}</span> of {summary.filesTotal ?? '—'} files
            </span>
          </span>
        </span>

      </div>
    </li>
  );
}

/**
 * The chevron menu at a review row's top right: (re)generate the reading
 * order, picking the model from a submenu, or archive.
 */
function ReviewOptions({
  generating,
  hasReadingOrder,
  onGenerateReadingOrder,
  onArchive,
}: {
  generating: boolean;
  hasReadingOrder: boolean;
  onGenerateReadingOrder: (model: AgentModel) => void;
  onArchive: () => void;
}): React.JSX.Element {
  const lastGenerationModel = useGenerationModel();
  const disabledItem = `${POPUP_ITEM_CLASS} data-disabled:text-chrome-fg-muted`;

  return (
    <Menu.Root modal={false}>
      <Hint label="Options">
        <Menu.Trigger
          aria-label="Review options"
          className="chrome-icon-btn pointer-events-auto size-5! rounded-[5px]! aria-expanded:bg-chrome-bg-active"
        >
          <ChevronDown size={13} strokeWidth={2} aria-hidden />
        </Menu.Trigger>
      </Hint>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} collisionPadding={8} className="z-50">
          <Menu.Popup className={`${MENU_POPUP_CLASS} min-w-48`}>
            <Menu.SubmenuRoot>
              <Menu.SubmenuTrigger disabled={generating} className={`${disabledItem} data-popup-open:bg-chrome-bg-hover`}>
                {generating ? (
                  <Loader2 size={13} strokeWidth={1.75} className="animate-spin text-chrome-accent" aria-hidden />
                ) : (
                  <Waypoints size={13} strokeWidth={1.75} aria-hidden />
                )}
                <span className="flex-1">
                  {generating ? 'Generating reading order…' : hasReadingOrder ? 'Regenerate reading order' : 'Generate reading order'}
                </span>
                {!generating && <ChevronRight size={12} strokeWidth={2} className="text-chrome-fg-subtle" aria-hidden />}
              </Menu.SubmenuTrigger>
              <Menu.Portal>
                <Menu.Positioner sideOffset={8} alignOffset={-4} collisionPadding={8} className="z-50">
                  <Menu.Popup className={`${MENU_POPUP_CLASS} min-w-36`}>
                    {AGENT_MODELS.map((m) => (
                      <Menu.Item key={m.id} onClick={() => onGenerateReadingOrder(m.id)} className={POPUP_ITEM_CLASS}>
                        <span className="flex-1">{m.label}</span>
                        {m.id === lastGenerationModel && <span className="text-chrome-fg-subtle">last used</span>}
                      </Menu.Item>
                    ))}
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.SubmenuRoot>
            <Menu.Separator className="my-1 h-px bg-chrome-border" />
            <Menu.Item onClick={onArchive} className={POPUP_ITEM_CLASS}>
              <Archive size={13} strokeWidth={1.75} aria-hidden />
              Archive
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function DoneRow({ review: hr, onArchive }: { review: HomeReview; onArchive: (id: string) => Promise<void> }): React.JSX.Element {
  const { review, summary, repo } = hr;
  const title = reviewTitle(review, summary);
  const author = personFrom(summary.authorName);
  return (
    <li className="group flex items-center transition-colors hover:bg-chrome-bg-hover">
      <button type="button" onClick={() => goReview(review.id)} className="flex min-w-0 flex-1 items-center gap-4 px-4 py-2.5 text-left">
        <span className="flex w-8 shrink-0 justify-center">
          <Avatar person={author} size={24} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-body text-chrome-fg-muted group-hover:text-chrome-fg">{title}</span>
            {review.prNumber !== null && <span className="shrink-0 text-micro tabular-nums text-chrome-fg-subtle">#{review.prNumber}</span>}
          </span>
          <span className="truncate text-micro text-chrome-fg-subtle">
            {repoDisplayName(repo)} · {summary.resolvedThreads} resolved · {summary.filesTotal ?? summary.viewedFiles} files viewed ·{' '}
            {relativeTime(summary.lastActivityAt ?? summary.headCommittedAt ?? review.createdAt)}
          </span>
        </span>
      </button>
      <Hint label="Archive">
        <button
          type="button"
          aria-label="Archive review"
          onClick={(e) => {
            e.stopPropagation();
            void onArchive(review.id);
          }}
          className="chrome-icon-btn mr-2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Archive size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </Hint>
    </li>
  );
}

function QueueRow({
  repoId,
  repoName,
  pull: p,
  opening,
  onOpen,
}: {
  repoId: string;
  repoName: string;
  pull: Pull;
  opening: boolean;
  onOpen: (repoId: string, pull: Pull) => void;
}): React.JSX.Element {
  const effort = effortOf({ filesTotal: p.changedFiles, additions: p.additions, deletions: p.deletions });
  const author = personFrom(p.authorLogin);
  const flags: React.ReactNode[] = [];
  if (p.isDraft) flags.push(<Chip key="draft">draft</Chip>);
  if (p.reviewRequested) flags.push(<Chip key="req" tone="accent">Review requested</Chip>);
  if (p.reviewStatus === 'draft') flags.push(<Chip key="opened">opened</Chip>);
  return (
    <li>
      {/* Three fixed columns — avatar, text, effort — so every row lines
          up: title on the first line, facts on the second, flags (if any)
          on a third. Nothing floats to the right except the effort. */}
      <button
        type="button"
        disabled={opening}
        aria-busy={opening}
        onClick={() => onOpen(repoId, p)}
        className="group flex w-full items-start gap-3 rounded-md px-3 py-3.5 text-left transition-colors hover:bg-chrome-bg-hover disabled:opacity-60"
      >
        <Avatar person={author} size={24} />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="line-clamp-2 text-body font-medium leading-snug text-chrome-fg">{p.title}</span>
          <span className="flex items-center gap-1.5 text-micro text-chrome-fg-subtle">
            <CiIcon ci={p.ci} size={11} />
            <span className="truncate">
              {repoName} #{p.number}
            </span>
          </span>
          {flags.length > 0 && <span className="flex items-center gap-1">{flags}</span>}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
          <EffortMeter level={effort.level} label={effort.label} minutes={effort.minutes} />
          <span className="text-micro tabular-nums text-chrome-fg-subtle">{relativeTime(p.updatedAtUnix)}</span>
        </span>
      </button>
    </li>
  );
}
