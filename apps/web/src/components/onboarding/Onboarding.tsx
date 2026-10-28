/**
 * The first-visit flow (see lib/onboarding.ts for when it shows): four
 * steps on a page of their own, over everything, each skippable.
 *
 *  - Welcome: three screenshots of what Joinery is for, cycling on a timer.
 *  - Repositories: the add-repo folder picker, with a heads-up about the
 *    macOS folder prompt until Full Disk Access is granted.
 *  - Tooling: the settings page's integrations check in three groups —
 *    basics (git, Claude Code), forges (`gh`, `glab`), each with the fix
 *    when it isn't ready, and language servers, switched on per language
 *    as on the settings page.
 *  - Make it yours: light/dark and the theme, over a mock review window
 *    drawn in the chrome, so a pick visibly re-tints the whole UI.
 */
import { Dialog } from '@base-ui-components/react/dialog';
import { Tabs } from '@base-ui-components/react/tabs';
import type { FullDiskAccess, Integrations } from '@joinery/core';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  FolderGit2,
  FolderPlus,
  Moon,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { callApi } from '../../lib/apiClient.ts';
import { JUMP_KEY, PEEK_KEY } from '../../lib/codeIntel.ts';
import { closeOnboarding, useOnboardingOpen } from '../../lib/onboarding.ts';
import { listThemeOptions } from '../../lib/themes.ts';
import { useHomeData } from '../../state/HomeData.tsx';
import { useTheme } from '../../state/ThemeContext.tsx';
import { repoLabel } from '../Explore.tsx';
import { GitHubMark, GitLabMark, GitMark, LANGUAGE_MARK } from '../brandMarks.tsx';
import { FolderPicker } from '../home/FolderPicker.tsx';
import { Chip, type Tone } from '../home/primitives.tsx';
import { LSP_TITLE, useLanguageServerPicker } from '../settings/LanguageServerPicker.tsx';
import { REASON, hostHint } from '../settings/Settings.tsx';
import { ThemePicker } from '../settings/ThemePicker.tsx';
import { Hint, SEGMENT_CLASS, Segment, Segmented } from '../controls.tsx';
import { MockReview } from './MockReview.tsx';

const STEPS = ['welcome', 'repos', 'tools', 'theme'] as const;
type Step = (typeof STEPS)[number];

const TITLES: Record<Step, string> = {
  welcome: 'Welcome!',
  repos: 'Add your repositories',
  tools: 'Tooling',
  theme: 'Make it yours',
};

/** The header's right-hand slot: a step's controls render there through a portal, so they sit beside the title. */
const ActionsSlot = createContext<HTMLElement | null>(null);

export function Onboarding(): React.JSX.Element | null {
  const open = useOnboardingOpen();
  return open ? <OnboardingFlow /> : null;
}

/** Every step and the footer share one column, so Skip and Next line up under the content. */
const WIDTH = 'w-full max-w-5xl';
/** The footer's buttons, a size up from the toolbar ones. */
const BIG_BTN = 'h-8! px-3.5! text-body!';

function OnboardingFlow(): React.JSX.Element {
  const { chromeMode } = useTheme();
  const [index, setIndex] = useState(0);
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const step: Step = STEPS[index] ?? 'welcome';
  const last = index === STEPS.length - 1;
  const nextRef = useRef<HTMLButtonElement>(null);

  return (
    // A full-window Base UI Dialog: it traps focus, and Escape skips the rest like Skip does.
    // Its popup's `role="dialog"` makes `keymapGuard` suppress the page's shortcuts underneath.
    <Dialog.Root
      open
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) closeOnboarding();
      }}
    >
      <Dialog.Portal>
        <Dialog.Popup
          aria-label="Welcome to Joinery"
          initialFocus={nextRef}
          className="fixed inset-0 z-40 flex flex-col bg-chrome-bg outline-hidden"
        >
          {/* Where Homebase draws it, so it stays put through every step. The -dark file is the one drawn for dark backgrounds. */}
          <header className="shrink-0 px-4 pt-4">
            <img
              src={chromeMode === 'dark' ? '/joinery-wordmark-squircle-dark.svg' : '/joinery-wordmark-squircle-light.svg'}
              alt="Joinery"
              className="h-[30px] w-auto select-none"
            />
          </header>
          {/* A page of its own rather than a card over one: the step fills it, the footer is pinned under it. */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <header className={`mx-auto flex min-h-9 shrink-0 items-center gap-3 px-10 pt-6 ${WIDTH}`}>
              <h2 className="text-2xl font-semibold tracking-tight text-chrome-fg">{TITLES[step]}</h2>
              <div ref={setActions} className="ml-auto flex items-center gap-2" />
            </header>
            <ActionsSlot.Provider value={actions}>
              <div key={step} className={`mx-auto flex min-h-[480px] flex-1 flex-col gap-6 px-10 pt-6 pb-8 ${WIDTH}`}>
                {step === 'welcome' && <WelcomeStep />}
                {step === 'repos' && <ReposStep />}
                {step === 'tools' && <ToolsStep />}
                {step === 'theme' && <ThemeStep />}
              </div>
            </ActionsSlot.Provider>
          </div>
          <div className="shrink-0 border-t border-chrome-border">
            <footer className={`mx-auto grid h-16 grid-cols-[1fr_auto_1fr] items-center px-10 ${WIDTH}`}>
              <div>
                {!last && (
                  <button
                    type="button"
                    onClick={closeOnboarding}
                    className="-ml-2.5 h-8 rounded-md px-2.5 text-body font-medium text-chrome-fg-subtle transition-colors hover:bg-chrome-bg-hover hover:text-chrome-fg"
                  >
                    Skip
                  </button>
                )}
              </div>
              <nav aria-label="Steps" className="flex items-center gap-1.5">
                {STEPS.map((s, i) => (
                  <button
                    key={s}
                    type="button"
                    aria-label={`Step ${String(i + 1)} of ${String(STEPS.length)}`}
                    aria-current={i === index ? 'step' : undefined}
                    onClick={() => setIndex(i)}
                    className={`h-1.5 rounded-full transition-all duration-200 ${
                      i === index ? 'w-4 bg-chrome-fg-muted' : 'w-1.5 bg-chrome-bg-active hover:bg-chrome-border-strong'
                    }`}
                  />
                ))}
              </nav>
              <div className="flex items-center justify-end gap-1.5">
                {index > 0 && (
                  <button type="button" onClick={() => setIndex(index - 1)} className={`chrome-btn ${BIG_BTN}`}>
                    <ArrowLeft size={14} strokeWidth={1.75} aria-hidden />
                    Back
                  </button>
                )}
                <button
                  ref={nextRef}
                  type="button"
                  onClick={() => (last ? closeOnboarding() : setIndex(index + 1))}
                  className={`chrome-btn-primary ${BIG_BTN}`}
                >
                  {last ? 'Get started' : 'Next'}
                  {!last && <ArrowRight size={14} strokeWidth={1.75} aria-hidden />}
                </button>
              </div>
            </footer>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A step's controls, drawn beside the title. */
function StepActions({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const slot = useContext(ActionsSlot);
  return slot !== null ? createPortal(children, slot) : null;
}

/** A server read for a step: null until it answers (or if it fails), re-run by `reload`. */
function useRead<T>(read: () => Promise<T>): { data: T | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    read()
      .then((value) => {
        if (live) setData(value);
      })
      .catch(() => {
        // Nothing to show; the step reads as unknown rather than broken.
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // `read` is a stable module-level call per use site; `tick` re-runs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, reload };
}

// --- Welcome ---

/** How long each screenshot shows before the next. */
const SHOT_MS = 10_000;

/**
 * Screenshots of a seeded demo instance, cropped to the part each one is
 * about, in both modes (`public/onboarding/<name>-<light|dark>.jpg`): the
 * shot matches the app's light/dark. Each sentence of `body` gets its own line.
 */
const SHOTS: { title: string; body: string[]; name: string }[] = [
  {
    title: 'Review code in an order\nthat makes sense',
    body: [
      'Go through the files A to Z, or generate a reading order that walks you through the change step by step.',
      'Focus and Skim badges and short notes tell you where to spend your attention.',
    ],
    name: 'review',
  },
  {
    title: 'Chat about changes locally',
    body: [
      'Comment on any line to ask for a clarification, a quick answer, or a deep dive into other parts of the codebase.',
      'Claude Code replies in the thread, and nothing is sent upstream.',
    ],
    name: 'thread',
  },
  {
    title: 'Keep up with work',
    body: [
      "See every branch and open PR across all your repositories in one dashboard, with what's waiting on you first.",
      'Filters and sorting keep it down to what matters today.',
    ],
    name: 'homebase',
  },
];

function WelcomeStep(): React.JSX.Element {
  const { chromeMode } = useTheme();
  const [shot, setShot] = useState(0);
  const [paused, setPaused] = useState(false);

  return (
    <>
      <div className="-mt-3 flex max-w-2xl shrink-0 flex-col gap-3 text-[15px] leading-relaxed text-chrome-fg-muted">
        <p>Thanks for taking an interest in this project!</p>
        <p>
          This guide helps you set up the few things Joinery needs, so you can get the most out of it.
          <br />
          Or just skip it altogether, have fun!
        </p>
      </div>
      <div className="flex min-h-0 flex-1 gap-10">
        {/* The features as a vertical list: the selected one opens to its description, so uneven texts never leave gaps in a row. */}
        <Tabs.Root value={shot} onValueChange={(i: number) => setShot(i)} orientation="vertical" className="flex w-80 shrink-0">
          <Tabs.List
            activateOnFocus
            aria-label="What Joinery does"
            className="flex w-full flex-col justify-center gap-1"
            // Only reading the list holds the timer; looking at the shot doesn't.
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
          >
            {SHOTS.map((s, i) => {
              const selected = i === shot;
              return (
                <Tabs.Tab
                  key={s.name}
                  value={i}
                  className="flex gap-4 rounded-lg py-3 pr-3 pl-0 text-left text-chrome-fg-muted transition-colors hover:text-chrome-fg data-active:text-chrome-fg"
                >
                  {/* The shot's timer: fills downward, then the next one is selected. */}
                  <span className="block w-0.5 shrink-0 self-stretch overflow-hidden rounded-full bg-chrome-bg-active">
                    {selected && (
                      <span
                        // Keyed on the shot so the bar restarts whenever it changes, even to the same index.
                        key={shot}
                        className="onboarding-progress block h-full w-full rounded-full bg-chrome-accent"
                        style={{ ['--onboarding-shot-ms' as string]: `${String(SHOT_MS)}ms`, animationPlayState: paused ? 'paused' : 'running' }}
                        onAnimationEnd={() => setShot((shot + 1) % SHOTS.length)}
                      />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-[15px] font-medium whitespace-pre-line">{s.title}</span>
                    {/* Opens and closes by tweening `grid-template-rows` between 0fr and 1fr: its natural height, without measuring. */}
                    <span
                      aria-hidden={!selected}
                      className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${
                        selected ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                      }`}
                    >
                      <span className="flex min-h-0 flex-col gap-2 overflow-hidden text-body leading-relaxed text-chrome-fg-muted">
                        {s.body.map((line) => (
                          <span key={line}>{line}</span>
                        ))}
                      </span>
                    </span>
                  </span>
                </Tabs.Tab>
              );
            })}
          </Tabs.List>
        </Tabs.Root>
        {/* No frame of its own: the shots stack in one grid cell and each is sized to fit, so the screenshot's edge is the only edge. */}
        <div className="grid min-h-[220px] min-w-0 flex-1 [grid-template:minmax(0,1fr)/minmax(0,1fr)] place-items-center">
          {SHOTS.map((s, i) => (
            <img
              key={s.name}
              src={`/onboarding/${s.name}-${chromeMode}.jpg`}
              alt={i === shot ? s.title : ''}
              aria-hidden={i !== shot}
              draggable={false}
              className={`max-h-full max-w-full select-none rounded-lg shadow-chrome ring-1 ring-chrome-border transition-opacity duration-500 [grid-area:1/1] ${
                i === shot ? 'opacity-100' : 'opacity-0'
              }`}
            />
          ))}
        </div>
      </div>
    </>
  );
}

// --- Repositories ---

const FORGE_LABEL = { github: 'GitHub', gitlab: 'GitLab', none: 'No forge' } as const;

function ReposStep(): React.JSX.Element {
  const { repos, refresh } = useHomeData();
  const [adding, setAdding] = useState(false);
  const sorted = useMemo(() => [...repos].sort((a, b) => repoLabel(a).localeCompare(repoLabel(b))), [repos]);
  const fda = useRead<FullDiskAccess>(() => callApi('fullDiskAccess'));
  // The browser runs on the server's machine, so its platform is the server's.
  const mac = /Mac/.test(navigator.userAgent);
  const showPrompt = mac && fda.data?.granted !== true;

  return (
    <>
      <StepActions>
        {sorted.length > 0 && (
          <button type="button" onClick={() => setAdding(true)} className="chrome-btn">
            <Plus size={13} strokeWidth={1.75} aria-hidden />
            Add more
          </button>
        )}
      </StepActions>
      {showPrompt && (
        <p className="flex shrink-0 items-center gap-2 rounded-md bg-chrome-bg-hover px-3 py-2 text-xs text-chrome-fg-muted">
          <ShieldCheck size={14} strokeWidth={1.75} className="shrink-0 text-chrome-fg-subtle" aria-hidden />
          <span>
            For repos in Desktop, Documents, Downloads or iCloud Drive, choose <span className="font-medium text-chrome-fg">Allow</span> when macOS
            asks. It remembers a Don't Allow.
          </span>
        </p>
      )}
      {sorted.length === 0 ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex min-h-40 flex-1 flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed border-chrome-border-strong text-chrome-fg-muted transition-colors hover:border-chrome-fg-subtle hover:bg-chrome-bg-hover hover:text-chrome-fg"
        >
          <FolderPlus size={22} strokeWidth={1.5} aria-hidden />
          <span className="text-body font-medium">Choose folders</span>
        </button>
      ) : (
        <ul className="flex min-h-0 flex-col overflow-y-auto rounded-lg border border-chrome-border p-1">
          {sorted.map((r) => (
            <Row
              key={r.id}
              icon={<FolderGit2 />}
              title={repoLabel(r)}
              detail={r.remoteHost !== null ? `${r.rootPath} · ${r.remoteHost}` : r.rootPath}
            >
              <Chip>{r.forge === null ? 'Detecting…' : FORGE_LABEL[r.forge]}</Chip>
            </Row>
          ))}
        </ul>
      )}
      {adding && (
        <FolderPicker
          onAdded={() => {
            setAdding(false);
            void refresh();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </>
  );
}

/** One label/value row, as on the settings page. */
function Row({
  icon,
  title,
  detail,
  children,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  detail?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <li className="flex min-h-11 items-center gap-3 rounded-md px-3 py-2">
      <span className="inline-flex size-4 shrink-0 items-center justify-center text-chrome-fg-subtle [&>svg]:size-4" aria-hidden>
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body text-chrome-fg">{title}</span>
        {detail !== undefined && <span className="truncate text-micro text-chrome-fg-subtle">{detail}</span>}
      </span>
      {children !== undefined && <span className="flex shrink-0 items-center gap-1.5">{children}</span>}
    </li>
  );
}

// --- Tooling ---

/**
 * The tool's state. `fix` is the command or step that makes it ready, shown
 * under the row; `info` (where it was found, who it's signed in to) only
 * shows on hover, since a ready tool needs no reading.
 */
interface ToolStatus {
  tone: Tone;
  label: string;
  fix?: string;
  info?: string;
}

function gitStatus(data: Integrations): ToolStatus {
  return data.git.path !== null
    ? { tone: 'success', label: 'Installed', info: data.git.path }
    : { tone: 'danger', label: 'Not installed', fix: 'xcode-select --install, or your package manager' };
}

function claudeStatus(data: Integrations): ToolStatus {
  if (data.claude.path !== null) return { tone: 'success', label: 'Found', info: data.claude.path };
  if (data.claude.bundled) return { tone: 'success', label: 'Found', info: 'Bundled with the Agent SDK' };
  return { tone: 'warning', label: 'Not found', fix: 'Install it, then run claude once to sign in' };
}

/** A forge's CLI: missing, or the first registered host it can't ask, or fine. Only a host in use makes a missing CLI a problem. */
function forgeStatus(data: Integrations, forge: 'github' | 'gitlab'): ToolStatus {
  const cli = forge === 'github' ? 'gh' : 'glab';
  const path = data.clis.find((c) => c.cli === cli)?.path ?? null;
  const hosts = data.hosts.filter((h) => h.forge === forge);
  if (path === null) return { tone: hosts.length > 0 ? 'danger' : 'neutral', label: 'Not installed', fix: `brew install ${cli}` };
  const failing = hosts.find((h) => h.reason !== null);
  if (failing?.reason != null) {
    const { tone, label } = REASON[failing.reason];
    return { tone, label, fix: hostHint(cli, failing.host, failing.reason) ?? failing.host };
  }
  if (hosts.length > 0) return { tone: 'success', label: 'Signed in', info: hosts.map((h) => h.host).join(', ') };
  return { tone: 'success', label: 'Installed', info: path };
}

interface Tool {
  key: string;
  icon: React.ReactNode;
  title: string;
  why?: string;
  status: (d: Integrations) => ToolStatus;
}

const BASICS: Tool[] = [
  { key: 'git', icon: <GitMark />, title: 'Git', why: 'Reads branches, commits and diffs straight from your clones.', status: gitStatus },
  { key: 'claude', icon: <Bot strokeWidth={1.75} />, title: 'Claude Code', why: 'Answers your threads and writes reading orders.', status: claudeStatus },
];

const FORGES: Tool[] = [
  { key: 'github', icon: <GitHubMark />, title: 'GitHub', why: 'Through the gh CLI', status: (d) => forgeStatus(d, 'github') },
  { key: 'gitlab', icon: <GitLabMark />, title: 'GitLab', why: 'Through the glab CLI', status: (d) => forgeStatus(d, 'gitlab') },
];

function ToolsStep(): React.JSX.Element {
  const { data, loading, reload } = useRead(() => callApi('integrations'));
  const rows = (tools: Tool[]) =>
    tools.map((tool) => <ToolRow key={tool.key} tool={tool} status={data !== null ? tool.status(data) : null} loading={loading} />);

  return (
    <>
      <StepActions>
        <Hint label="Check again">
          <button type="button" onClick={reload} aria-label="Check again" className="chrome-icon-btn">
            <RefreshCw size={14} strokeWidth={1.75} className={loading ? 'animate-spin' : ''} aria-hidden />
          </button>
        </Hint>
      </StepActions>
      <div className={`flex flex-col gap-5 transition-opacity ${loading && data !== null ? 'opacity-60' : ''}`}>
        <ToolGroup title="Basics">{rows(BASICS)}</ToolGroup>
        <ToolGroup title="Forges" about="List your pull requests, merge requests and review requests. Only the forges your repositories use matter.">
          {rows(FORGES)}
        </ToolGroup>
        {data !== null && data.lsp.length > 0 && (
          <ToolGroup title="Language servers" about={`Show types and docs on hover, right in the diff. ${PEEK_KEY}-click a name for its definition and uses, ${JUMP_KEY}-click to go straight to it.`}>
            {data.lsp.map((row) => (
              <LanguageServerTool key={row.language} row={row} onChanged={reload} />
            ))}
          </ToolGroup>
        )}
      </div>
    </>
  );
}

/** A heading, what the group is for (said once rather than on every row), and its rows. */
function ToolGroup({ title, about, children }: { title: string; about?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-1">
      <header className="flex flex-col gap-0.5 px-3">
        <h3 className="text-xs font-medium text-chrome-fg">{title}</h3>
        {about !== undefined && <p className="text-xs text-chrome-fg-muted">{about}</p>}
      </header>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

function ToolIcon({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-chrome-fg-muted [&>svg]:size-5" aria-hidden>
      {children}
    </span>
  );
}

function ToolRow({ tool, status, loading }: { tool: Tool; status: ToolStatus | null; loading: boolean }): React.JSX.Element {
  return (
    <Hint label={status?.info}>
      <li className="flex items-start gap-3.5 rounded-md px-3 py-2.5">
        <ToolIcon>{tool.icon}</ToolIcon>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-body font-medium text-chrome-fg">{tool.title}</span>
          {tool.why !== undefined && <span className="text-xs text-chrome-fg-muted">{tool.why}</span>}
          {status?.fix !== undefined && <code className="mt-1 truncate text-micro text-chrome-fg-subtle">{status.fix}</code>}
        </span>
        <span className="mt-0.5 shrink-0">
          {status !== null ? (
            <Chip tone={status.tone} {...(status.tone === 'success' ? { icon: <Check size={11} strokeWidth={2.5} /> } : {})}>
              {status.label}
            </Chip>
          ) : (
            <Chip>{loading ? 'Checking…' : "Couldn't check"}</Chip>
          )}
        </span>
      </li>
    </Hint>
  );
}

/** A language's hover/peek server, chosen right here (the same picker as Settings). */
function LanguageServerTool({ row, onChanged }: { row: Integrations['lsp'][number]; onChanged: () => void }): React.JSX.Element {
  const { controls, detail, editor } = useLanguageServerPicker(row, onChanged);
  const Mark = LANGUAGE_MARK[row.language];
  return (
    <li className="flex items-start gap-3.5 rounded-md px-3 py-2.5">
      <ToolIcon>
        <Mark />
      </ToolIcon>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body font-medium text-chrome-fg">{LSP_TITLE[row.language].files}</span>
        <span className="truncate text-xs text-chrome-fg-muted">{detail}</span>
        {editor !== null && <span className="mt-1.5">{editor}</span>}
      </span>
      <span className="mt-0.5 flex shrink-0 items-center gap-1.5">{controls}</span>
    </li>
  );
}

// --- Make it yours ---

function ThemeStep(): React.JSX.Element {
  const { chromeMode, setChromeMode, diffTheme, setDiffTheme } = useTheme();
  const options = useMemo(() => listThemeOptions(), []);
  // The theme highlighted in the open picker: previewed on the mock only;
  // the app's theme changes on a pick.
  const [preview, setPreview] = useState<string | null>(null);

  return (
    <>
      <StepActions>
        {/* Same height, border and fill as the picker beside it. */}
        <Segmented
          value={chromeMode}
          onChange={setChromeMode}
          aria-label="Mode"
          className="flex h-8 items-center gap-0.5 rounded-md border border-chrome-border bg-chrome-bg-raised p-[3px]"
        >
          {(['dark', 'light'] as const).map((mode) => {
            const Icon = mode === 'dark' ? Moon : Sun;
            return (
              <Segment key={mode} value={mode} className={`${SEGMENT_CLASS} h-full! gap-1.5 rounded-[4px]!`}>
                <Icon size={13} strokeWidth={1.75} aria-hidden />
                {mode === 'dark' ? 'Dark' : 'Light'}
              </Segment>
            );
          })}
        </Segmented>
        <div className="w-56">
          <ThemePicker
            // Keyed on the mode: the other mode's list is a different set of themes.
            key={chromeMode}
            id="onboarding-theme"
            options={options.filter((o) => o.colorScheme === undefined || o.colorScheme === chromeMode)}
            value={diffTheme[chromeMode]}
            onChange={(name) => setDiffTheme({ ...diffTheme, [chromeMode]: name })}
            onPreview={setPreview}
            onClose={() => setPreview(null)}
          />
        </div>
      </StepActions>
      <MockReview theme={diffTheme[chromeMode]} preview={preview} />
    </>
  );
}
