/**
 * Settings (`#/settings`), reached from the gear on Homebase or "Open
 * settings" in ⌘K. One column of panels:
 *
 *  - Appearance: the dark and the light diff theme, picked separately,
 *    each over a sample drawn in it (the same two slots ⌘K's `#` tabs fill).
 *  - Repositories: what's registered, its forge, and removing one.
 *  - Integrations, in groups with their marks: the basics (are `git` and
 *    `claude` there), forges (can each host be asked) and language servers
 *    (each language's switch for hover/peek in diffs).
 *  - Full Disk Access: the macOS grant for the installed server.
 *  - Data: where it lives and how big, clearing the caches, and the
 *    archived reviews, which nothing else lists, to reopen or delete.
 *
 * Everything server-side is read when the page opens; the language server
 * choices are the only stored server settings.
 */
import type { DataUsage, FullDiskAccess, Integrations, Repo, Review, ReviewSummary } from '@joinery/core';
import { NumberField } from '@base-ui-components/react/number-field';
import {
  Archive,
  ArrowLeft,
  Bot,
  Check,
  Database,
  FolderGit2,
  Layers,
  Moon,
  MousePointer2,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sun,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, callApi } from '../../lib/apiClient.ts';
import {
  MAX_HOVER_DELAY_MS,
  JUMP_KEY,
  PEEK_KEY,
  setHoverDelay,
  setHoverEnabled,
  setImplementationJump,
  useHoverDelay,
  useHoverEnabled,
  useImplementationJump,
} from '../../lib/codeIntel.ts';
import { useGlobalKeymap } from '../../lib/keymap.ts';
import { relativeTime } from '../../lib/relativeTime.ts';
import { goHomebase, goReview } from '../../lib/router.ts';
import { listThemeOptions } from '../../lib/themes.ts';
import { useHomeData } from '../../state/HomeData.tsx';
import { useTheme, type ChromeMode } from '../../state/ThemeContext.tsx';
import { CommandPalette } from '../CommandPalette.tsx';
import { ConfirmDelete } from '../ConfirmDelete.tsx';
import { ChromeSwitch, Hint } from '../controls.tsx';
import { repoLabel } from '../Explore.tsx';
import { GitHubMark, GitLabMark, GitMark, LANGUAGE_MARK } from '../brandMarks.tsx';
import { FolderPicker } from '../home/FolderPicker.tsx';
import { Panel } from '../home/Panel.tsx';
import { Chip, type Tone } from '../home/primitives.tsx';
import { LSP_TITLE, useLanguageServerPicker } from './LanguageServerPicker.tsx';
import { ThemePicker } from './ThemePicker.tsx';
import { ThemeSample } from './ThemeSample.tsx';

/** How long to wait for the server to come back after a restart before giving up. */
const RESTART_TIMEOUT_MS = 60_000;
const RESTART_POLL_MS = 1_000;

/** Panels clip by default; these let a row's confirm popover hang past the panel's edge. */
const OVERFLOW = 'overflow-visible!';

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.hint !== undefined ? `${err.message}. ${err.hint}` : err.message;
  return fallback;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit] ?? 'GB'}`;
}

/** A server read that the page shows as loading, failed, or loaded, and can re-run. */
function useLoad<T>(load: () => Promise<T>): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    load()
      .then((value) => {
        if (!live) return;
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (live) setError(errorText(err, 'Could not load.'));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // `load` is a stable module-level call per use site; `tick` re-runs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export function Settings(): React.JSX.Element {
  useEffect(() => {
    document.title = 'Settings · Joinery';
    return () => {
      document.title = 'Joinery';
    };
  }, []);
  // ⌘K / ⌘⇧P, as on Homebase.
  const [paletteOpen, setPaletteOpen] = useState(false);
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

  return (
    <div className="home-shell h-full">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 pt-6 pb-16">
          <header className="flex items-center gap-2">
            <Hint label="Back to Homebase">
              <button type="button" onClick={goHomebase} aria-label="Back to Homebase" className="chrome-icon-btn">
                <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
              </button>
            </Hint>
            <h1 className="text-lg font-semibold tracking-tight text-chrome-fg">Settings</h1>
          </header>
          <AppearancePanel />
          <ReposPanel />
          <IntegrationsPanel />
          <FullDiskAccessPanel />
          <DataPanel />
        </div>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} initialMode={paletteMode} />
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="px-3 py-5 text-center text-xs text-chrome-fg-muted">{children}</p>;
}

function ErrorLine({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="px-3 py-2 text-xs text-chrome-danger">{children}</p>;
}

/** One label/value row inside a panel. */
function Row({
  icon,
  title,
  detail,
  children,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  detail?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <li className="flex min-h-11 items-center gap-3 rounded-md px-3 py-2">
      {icon !== undefined && (
        <span className="inline-flex size-4 shrink-0 items-center justify-center text-chrome-fg-subtle [&>svg]:size-4" aria-hidden>
          {icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body text-chrome-fg">{title}</span>
        {detail !== undefined && <span className="truncate text-micro text-chrome-fg-subtle">{detail}</span>}
      </span>
      {children !== undefined && <span className="flex shrink-0 items-center gap-1.5">{children}</span>}
    </li>
  );
}

// --- Appearance ---

function AppearancePanel(): React.JSX.Element {
  const { chromeMode, diffTheme, setDiffTheme } = useTheme();
  const options = useMemo(() => listThemeOptions(), []);
  return (
    <Panel icon={<Palette />} title="Appearance" className={OVERFLOW} bodyClassName={`px-3 pb-3 ${OVERFLOW}`}>
      <div className="grid gap-3 sm:grid-cols-2">
        {(['dark', 'light'] as const).map((slot) => (
          <ThemeColumn
            key={slot}
            slot={slot}
            inUse={slot === chromeMode}
            value={diffTheme[slot]}
            options={options.filter((o) => o.colorScheme === undefined || o.colorScheme === slot)}
            onChange={(name) => setDiffTheme({ ...diffTheme, [slot]: name })}
          />
        ))}
      </div>
    </Panel>
  );
}

function ThemeColumn({
  slot,
  inUse,
  value,
  options,
  onChange,
}: {
  slot: ChromeMode;
  inUse: boolean;
  value: string;
  options: ReturnType<typeof listThemeOptions>;
  onChange: (name: string) => void;
}): React.JSX.Element {
  const id = `theme-${slot}`;
  // The theme highlighted in the open picker: previewed in the sample only;
  // the app's theme changes on a pick.
  const [preview, setPreview] = useState<string | null>(null);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {/* Fixed height, so the "in use" chip doesn't push one column's sample below the other's. */}
      <div className="flex h-5 items-center gap-1.5">
        {slot === 'dark' ? <Moon size={13} strokeWidth={1.75} className="text-chrome-fg-subtle" aria-hidden /> : <Sun size={13} strokeWidth={1.75} className="text-chrome-fg-subtle" aria-hidden />}
        <label htmlFor={id} className="text-xs font-medium text-chrome-fg">
          {slot === 'dark' ? 'Dark' : 'Light'}
        </label>
        {inUse && <Chip tone="accent">in use</Chip>}
      </div>
      <ThemeSample name={preview ?? value} />
      <ThemePicker
        id={id}
        options={options}
        value={value}
        onChange={onChange}
        onPreview={setPreview}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}

// --- Repositories ---

const FORGE_LABEL: Record<NonNullable<Repo['forge']>, string> = { github: 'GitHub', gitlab: 'GitLab', none: 'No forge' };

function ReposPanel(): React.JSX.Element {
  const { repos, loading, refresh } = useHomeData();
  const [adding, setAdding] = useState(false);
  const sorted = useMemo(() => [...repos].sort((a, b) => repoLabel(a).localeCompare(repoLabel(b))), [repos]);

  const remove = async (repo: Repo) => {
    try {
      await callApi('deleteRepo', { params: [repo.id] });
    } catch (err) {
      throw new Error(errorText(err, 'Could not remove the repository.'));
    } finally {
      void refresh();
    }
  };

  return (
    <Panel
      icon={<FolderGit2 />}
      title="Repositories"
      className={OVERFLOW}
      bodyClassName={`px-1 pb-1.5 ${OVERFLOW}`}
      count={repos.length}
      actions={
        <button type="button" onClick={() => setAdding(true)} className="chrome-btn">
          <Plus size={13} strokeWidth={1.75} aria-hidden />
          Add
        </button>
      }
    >
      {adding && (
        <FolderPicker
          onAdded={() => {
            setAdding(false);
            void refresh();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {loading && repos.length === 0 ? (
        <Empty>Loading…</Empty>
      ) : sorted.length === 0 ? (
        <Empty>No repositories yet.</Empty>
      ) : (
        <ul className="flex flex-col">
          {sorted.map((r) => (
            <Row
              key={r.id}
              icon={<FolderGit2 />}
              title={repoLabel(r)}
              detail={r.remoteHost !== null ? `${r.rootPath} · ${r.remoteHost}` : r.rootPath}
            >
              <Chip>{r.forge === null ? 'Detecting…' : FORGE_LABEL[r.forge]}</Chip>
              <ConfirmDelete
                prompt={`Remove ${repoLabel(r)}? Its reviews, threads and reading orders are deleted. The clone itself is left alone.`}
                onConfirm={() => remove(r)}
                confirmLabel="Remove"
                triggerLabel={`Remove ${repoLabel(r)}`}
                triggerClassName="chrome-icon-btn"
              >
                <Trash2 size={14} strokeWidth={1.75} aria-hidden />
              </ConfirmDelete>
            </Row>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// --- Integrations ---

export const REASON: Record<NonNullable<Integrations['hosts'][number]['reason']>, { label: string; tone: Tone }> = {
  'missing-cli': { label: 'Not installed', tone: 'danger' },
  'not-authenticated': { label: 'Not signed in', tone: 'warning' },
  unreachable: { label: "Can't reach host", tone: 'warning' },
};

export function hostHint(cli: 'gh' | 'glab', host: string, reason: Integrations['hosts'][number]['reason']): string | undefined {
  if (reason === 'missing-cli') return cli === 'gh' ? 'brew install gh' : 'brew install glab';
  if (reason === 'not-authenticated') return `${cli} auth login --hostname ${host}`;
  if (reason === 'unreachable') return 'Signed in, but the host did not answer. A VPN?';
  return undefined;
}

/**
 * One language's hover/peek server, chosen with the picker
 * (LanguageServerPicker.tsx); the custom path form opens under the row.
 */
function LanguageServerRow({ row, onChanged }: { row: Integrations['lsp'][number]; onChanged: () => void }): React.JSX.Element {
  const { controls, detail, editor } = useLanguageServerPicker(row, onChanged);
  const Mark = LANGUAGE_MARK[row.language];
  return (
    <li className="flex flex-col gap-2 rounded-md px-3 py-2">
      <span className="flex min-h-7 items-center gap-3">
        <span className="inline-flex size-4 shrink-0 items-center justify-center text-chrome-fg-subtle [&>svg]:size-4" aria-hidden>
          <Mark />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-body text-chrome-fg">{LSP_TITLE[row.language].files}</span>
          <span className="truncate text-micro text-chrome-fg-subtle">{detail}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">{controls}</span>
      </span>
      {editor !== null && <span className="pl-7">{editor}</span>}
    </li>
  );
}

/**
 * The switch for hover cards, and while on, how long the pointer rests
 * before one shows; peeking with the modifier-click is always on.
 */
function HoverCardsRow(): React.JSX.Element {
  const on = useHoverEnabled();
  const delay = useHoverDelay();
  return (
    <Row icon={<MousePointer2 strokeWidth={1.75} />} title="Show types on hover" detail={`Signature and docs when the pointer rests on a name; ${PEEK_KEY}-click and ${JUMP_KEY}-click work either way`}>
      {on && (
        // A valid number is saved as it's typed; an empty or half-typed field snaps back to the saved delay on blur.
        <NumberField.Root
          value={delay}
          onValueChange={(ms) => {
            if (ms !== null) setHoverDelay(ms);
          }}
          min={0}
          max={MAX_HOVER_DELAY_MS}
          step={50}
          format={{ useGrouping: false }}
        >
          <NumberField.Group className="flex h-7 items-center gap-1 rounded-md border border-chrome-border bg-chrome-bg-raised pr-2 text-xs text-chrome-fg-subtle transition-colors hover:border-chrome-border-strong focus-within:border-chrome-accent">
            <Hint label="How long the pointer rests on a name before the card shows">
              <NumberField.Input
                aria-label="Hover delay in milliseconds"
                className="w-14 bg-transparent pl-2 text-right tabular-nums text-chrome-fg outline-hidden"
              />
            </Hint>
            ms
          </NumberField.Group>
        </NumberField.Root>
      )}
      <ChromeSwitch checked={on} onCheckedChange={setHoverEnabled} label="Show types on hover" />
    </Row>
  );
}

/** The switch for opening the peek window on an interface's only implementation instead of the interface. */
function ImplementationJumpRow(): React.JSX.Element {
  const on = useImplementationJump();
  return (
    <Row
      icon={<Layers strokeWidth={1.75} />}
      title="Open the only implementation"
      detail={`When a ${PEEK_KEY}- or ${JUMP_KEY}-clicked interface has just one implementation, go to that first`}
    >
      <ChromeSwitch checked={on} onCheckedChange={setImplementationJump} label="Open the only implementation" />
    </Row>
  );
}

/** A group of integrations: a heading, what they're for (once, not per row), and the rows. */
function IntegrationGroup({
  title,
  about,
  first = false,
  children,
}: {
  title: string;
  about?: string;
  first?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={first ? '' : 'mt-1.5 border-t border-chrome-border pt-2'}>
      <header className="flex flex-col gap-0.5 px-3 pb-0.5">
        <h3 className="text-xs font-medium text-chrome-fg">{title}</h3>
        {about !== undefined && <p className="text-micro text-chrome-fg-subtle">{about}</p>}
      </header>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

const CLI_MARK: Record<Integrations['clis'][number]['cli'], React.ReactNode> = { gh: <GitHubMark />, glab: <GitLabMark /> };

function IntegrationsPanel(): React.JSX.Element {
  const { data, error, loading, reload } = useLoad(() => callApi('integrations'));
  return (
    <Panel
      icon={<Plug />}
      title="Integrations"
      className={OVERFLOW}
      bodyClassName={`px-1 pb-1.5 ${OVERFLOW}`}
      actions={
        <Hint label="Check again">
          <button type="button" onClick={reload} aria-label="Check again" className="chrome-icon-btn">
            <RefreshCw size={14} strokeWidth={1.75} className={loading ? 'animate-spin' : ''} aria-hidden />
          </button>
        </Hint>
      }
    >
      {error !== null && <ErrorLine>{error}</ErrorLine>}
      {data === null ? (
        error === null && <Empty>Checking…</Empty>
      ) : (
        <div className={`transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <IntegrationGroup title="Basics" first>
            <Row icon={<GitMark />} title={<code>git</code>} detail={data.git.path ?? 'Joinery reads every repository through it'}>
              {data.git.path !== null ? <Chip tone="success" icon={<Check size={11} strokeWidth={2.5} />}>Installed</Chip> : <Chip tone="danger">Not installed</Chip>}
            </Row>
            <Row
              icon={<Bot strokeWidth={1.75} />}
              title="Claude Code"
              detail={
                data.claude.path !== null
                  ? data.claude.path
                  : data.claude.bundled
                    ? 'Not on PATH'
                    : 'Install it and run `claude` once to sign in; agent replies need it'
              }
            >
              {data.claude.path !== null || data.claude.bundled ? <Chip tone="success" icon={<Check size={11} strokeWidth={2.5} />}>Found</Chip> : <Chip tone="danger">Not found</Chip>}
            </Row>
          </IntegrationGroup>
          <IntegrationGroup title="Forges" about="Pull requests and merge requests come in through gh and glab, signed in to each host your repositories use.">
            {data.clis.map((c) => (
              <Row key={c.cli} icon={CLI_MARK[c.cli]} title={<code>{c.cli}</code>} detail={c.path ?? (c.cli === 'gh' ? 'Needed for GitHub' : 'Needed for GitLab')}>
                {c.path !== null ? <Chip tone="success" icon={<Check size={11} strokeWidth={2.5} />}>Installed</Chip> : <Chip>Not installed</Chip>}
              </Row>
            ))}
            {data.hosts.map((h) => (
              <Row
                key={h.host}
                icon={CLI_MARK[h.cli]}
                title={h.host}
                detail={hostHint(h.cli, h.host, h.reason) ?? `${h.cli} · ${String(h.repos)} ${h.repos === 1 ? 'repository' : 'repositories'}`}
              >
                {h.reason === null ? (
                  <Chip tone="success" icon={<Check size={11} strokeWidth={2.5} />}>Signed in</Chip>
                ) : (
                  <Chip tone={REASON[h.reason].tone}>{REASON[h.reason].label}</Chip>
                )}
              </Row>
            ))}
          </IntegrationGroup>
          {data.lsp.length > 0 && (
            <IntegrationGroup title="Language servers" about="Types and docs on hover, and jumps to definitions and uses, right in the diff.">
              {data.lsp.map((l) => (
                <LanguageServerRow key={l.language} row={l} onChanged={reload} />
              ))}
              <HoverCardsRow />
              <ImplementationJumpRow />
            </IntegrationGroup>
          )}
        </div>
      )}
    </Panel>
  );
}

// --- Full Disk Access ---

/** Polls until the server answers again after a restart; resolves false on timeout. */
async function waitForServer(): Promise<boolean> {
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  // Give the old process a moment to go away, so the first answer isn't its.
  await new Promise((r) => setTimeout(r, RESTART_POLL_MS * 2));
  while (Date.now() < deadline) {
    try {
      await callApi('version');
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, RESTART_POLL_MS));
    }
  }
  return false;
}

function FullDiskAccessPanel(): React.JSX.Element {
  const { data, error, loading, reload } = useLoad(() => callApi('fullDiskAccess'));
  const [busy, setBusy] = useState<'open' | 'restart' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const openSettings = async () => {
    setBusy('open');
    setActionError(null);
    try {
      await callApi('openFullDiskAccess');
    } catch (err) {
      setActionError(errorText(err, 'Could not open System Settings.'));
    } finally {
      setBusy(null);
    }
  };

  const restart = async () => {
    setBusy('restart');
    setActionError(null);
    try {
      await callApi('restartServer');
      if (!(await waitForServer())) setActionError('The server did not come back. Check `joinery service status`.');
      reload();
    } catch (err) {
      setActionError(errorText(err, 'Could not restart the server.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      icon={<ShieldCheck />}
      title="Full Disk Access"
      className={OVERFLOW}
      actions={
        data?.applies === true && (
          <Hint label="Check again">
            <button type="button" onClick={reload} aria-label="Check again" className="chrome-icon-btn">
              <RefreshCw size={14} strokeWidth={1.75} className={loading ? 'animate-spin' : ''} aria-hidden />
            </button>
          </Hint>
        )
      }
      bodyClassName={`px-3 pb-3 ${OVERFLOW}`}
    >
      {error !== null && <ErrorLine>{error}</ErrorLine>}
      {data === null ? (
        error === null && <Empty>Checking…</Empty>
      ) : !data.applies ? (
        <p className="text-xs text-chrome-fg-muted">
          Only the installed app on macOS needs this. In a source checkout the server runs with your terminal's permissions, so grant Full Disk Access to the terminal instead.
        </p>
      ) : (
        <FullDiskAccessBody data={data} busy={busy} onOpen={() => void openSettings()} onRestart={() => void restart()} />
      )}
      {actionError !== null && <p className="pt-2 text-xs text-chrome-danger">{actionError}</p>}
    </Panel>
  );
}

function FullDiskAccessBody({
  data,
  busy,
  onOpen,
  onRestart,
}: {
  data: FullDiskAccess;
  busy: 'open' | 'restart' | null;
  onOpen: () => void;
  onRestart: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {data.granted === true ? (
          <Chip tone="success" icon={<Check size={11} strokeWidth={2.5} />}>Granted</Chip>
        ) : (
          <Chip tone="warning">Not granted</Chip>
        )}
        <span className="text-xs text-chrome-fg-muted">
          {data.granted === true
            ? 'Folders like Desktop, Documents and iCloud Drive open without a prompt.'
            : 'macOS asks before Joinery may open Desktop, Documents, Downloads, iCloud Drive or external drives, and remembers a "Don\'t Allow".'}
        </span>
      </div>
      {data.granted !== true && (
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-xs text-chrome-fg-muted">
          <li>Open System Settings: it lands on Full Disk Access, with the Joinery binary shown in Finder.</li>
          <li>Drag the binary into the list (or click + and pick it), and turn its switch on.</li>
          <li>Restart the server so the grant applies.</li>
        </ol>
      )}
      {data.binary !== null && (
        <Hint label={data.binary}>
          <p className="truncate font-mono text-micro text-chrome-fg-subtle">{data.binary}</p>
        </Hint>
      )}
      <div className="flex items-center gap-1.5">
        {data.granted !== true && (
          <button type="button" onClick={onOpen} disabled={busy !== null} className="chrome-btn-primary">
            Open System Settings
          </button>
        )}
        {data.canRestart ? (
          <button type="button" onClick={onRestart} disabled={busy !== null} className="chrome-btn">
            <RefreshCw size={13} strokeWidth={1.75} className={busy === 'restart' ? 'animate-spin' : ''} aria-hidden />
            {busy === 'restart' ? 'Restarting…' : 'Restart server'}
          </button>
        ) : (
          data.granted !== true && <span className="text-micro text-chrome-fg-subtle">Then restart `joinery serve`.</span>
        )}
      </div>
    </div>
  );
}

// --- Data ---

type ClearAction = 'clearWorktrees' | 'clearReviewWorktrees' | 'clearSessions' | 'clearCachedAnswers';

const CLEARED: Record<ClearAction, (n: number) => string> = {
  clearWorktrees: (n) => `Removed ${String(n)} ${n === 1 ? 'worktree' : 'worktrees'}.`,
  clearReviewWorktrees: (n) => `Removed ${String(n)} ${n === 1 ? 'worktree' : 'worktrees'}.`,
  clearSessions: (n) => `Deleted ${String(n)} agent ${n === 1 ? 'session' : 'sessions'}.`,
  clearCachedAnswers: (n) => `Cleared ${String(n)} cached ${n === 1 ? 'answer' : 'answers'}.`,
};

function DataPanel(): React.JSX.Element {
  const usage = useLoad(() => callApi('dataUsage'));
  const archived = useLoad(() => callApi('listReviews', { query: { status: 'archived' } }));
  const { repos, unarchiveReview } = useHomeData();
  const [clearResult, setClearResult] = useState<string | null>(null);

  const clear = async (what: ClearAction) => {
    setClearResult(null);
    try {
      const { removed } = await callApi(what);
      setClearResult(CLEARED[what](removed));
    } catch (err) {
      throw new Error(errorText(err, 'Could not clear it.'));
    } finally {
      usage.reload();
    }
  };

  return (
    <Panel icon={<Database />} title="Data" className={OVERFLOW} bodyClassName={`px-1 pb-2 ${OVERFLOW}`}>
      {usage.error !== null && <ErrorLine>{usage.error}</ErrorLine>}
      {usage.data === null ? (
        usage.error === null && <Empty>Measuring…</Empty>
      ) : (
        <UsageTree usage={usage.data} onClear={clear} />
      )}
      {clearResult !== null && <p className="px-3 pb-2 text-xs text-chrome-fg-muted">{clearResult}</p>}

      <div className="border-t border-chrome-border pt-2">
        <div className="flex items-center gap-2 px-3 pb-1">
          <Archive size={13} strokeWidth={1.75} className="text-chrome-fg-subtle" aria-hidden />
          <h3 className="text-xs font-medium text-chrome-fg">Archived reviews</h3>
          {archived.data !== null && (
            <span className="rounded-sm bg-chrome-bg-hover px-1 text-micro font-medium tabular-nums text-chrome-fg-muted">{archived.data.reviews.length}</span>
          )}
        </div>
        {archived.error !== null && <ErrorLine>{archived.error}</ErrorLine>}
        {archived.data === null ? (
          archived.error === null && <Empty>Loading…</Empty>
        ) : archived.data.reviews.length === 0 ? (
          <Empty>Nothing archived.</Empty>
        ) : (
          <ArchivedList
            reviews={archived.data.reviews}
            summaries={archived.data.summaries}
            repos={repos}
            onReopen={async (id) => {
              await unarchiveReview(id);
              archived.reload();
            }}
            onDelete={async (id) => {
              try {
                await callApi('deleteReview', { params: [id] });
              } catch (err) {
                throw new Error(errorText(err, 'Could not delete the review.'));
              }
              archived.reload();
              usage.reload();
            }}
          />
        )}
      </div>
    </Panel>
  );
}

/**
 * The data folder like macOS's storage bar: one bar split into what takes
 * the space, then the same parts as a list with matching colour dots. The
 * parts add up to the whole, so "Database" is the database without the PR
 * caches it holds, which sit indented under it. Only the caches can be
 * cleared, from their rows. Every part gets a real hue: grey and green both
 * read as free space.
 */
function UsageTree({
  usage,
  onClear,
}: {
  usage: DataUsage;
  onClear: (what: ClearAction) => Promise<void>;
}): React.JSX.Element {
  const total = usage.databaseBytes + usage.worktrees.bytes + usage.sessions.bytes;
  const parts = [
    {
      key: 'database',
      title: 'Database',
      detail: 'Reviews, threads, reading orders, viewed checks',
      bytes: Math.max(0, usage.databaseBytes - usage.cachedAnswers.bytes),
      color: 'bg-chrome-accent',
      nested: false,
      action: null,
    },
    {
      key: 'caches',
      title: 'PR caches',
      detail: `${String(usage.cachedAnswers.count)} PR lists, PR details and review stats · inside the database, refetched when needed`,
      bytes: usage.cachedAnswers.bytes,
      color: 'bg-chrome-warning',
      nested: true,
      action: (
        <ConfirmDelete
          prompt="Clear the PR caches? They're refetched when next needed."
          onConfirm={() => onClear('clearCachedAnswers')}
          confirmLabel="Clear"
          triggerLabel="Clear PR caches"
          triggerClassName="chrome-icon-btn"
        >
          <Trash2 size={14} strokeWidth={1.75} aria-hidden />
        </ConfirmDelete>
      ),
    },
    {
      key: 'worktrees',
      title: 'Agent worktrees',
      detail: `${String(usage.worktrees.count)} ${usage.worktrees.count === 1 ? 'checkout' : 'checkouts'} for agent runs · rebuilt when needed`,
      bytes: Math.max(0, usage.worktrees.bytes - usage.reviewWorktrees.bytes),
      color: 'bg-sky-500',
      nested: false,
      action: (
        <ConfirmDelete
          prompt="Remove the agent worktrees? The next agent run rebuilds the one it needs."
          onConfirm={() => onClear('clearWorktrees')}
          confirmLabel="Remove"
          triggerLabel="Remove agent worktrees"
          triggerClassName="chrome-icon-btn"
        >
          <Trash2 size={14} strokeWidth={1.75} aria-hidden />
        </ConfirmDelete>
      ),
    },
    {
      key: 'reviewWorktrees',
      title: 'Review worktrees',
      detail: `${String(usage.reviewWorktrees.count)} ${usage.reviewWorktrees.count === 1 ? 'checkout' : 'checkouts'} for code hover and peek · rebuilt when needed`,
      bytes: usage.reviewWorktrees.bytes,
      color: 'bg-violet-500',
      nested: false,
      action: (
        <ConfirmDelete
          prompt="Remove the review worktrees? The next hover rebuilds the one it needs."
          onConfirm={() => onClear('clearReviewWorktrees')}
          confirmLabel="Remove"
          triggerLabel="Remove review worktrees"
          triggerClassName="chrome-icon-btn"
        >
          <Trash2 size={14} strokeWidth={1.75} aria-hidden />
        </ConfirmDelete>
      ),
    },
    {
      key: 'sessions',
      title: 'Agent sessions',
      detail: `${String(usage.sessions.count)} ${usage.sessions.count === 1 ? 'conversation' : 'conversations'} agent follow-ups resume · started fresh when gone`,
      bytes: usage.sessions.bytes,
      color: 'bg-rose-500',
      nested: false,
      action: (
        <ConfirmDelete
          prompt="Delete the agent sessions? A thread's next agent reply starts a fresh one."
          onConfirm={() => onClear('clearSessions')}
          confirmLabel="Delete"
          triggerLabel="Delete agent sessions"
          triggerClassName="chrome-icon-btn"
        >
          <Trash2 size={14} strokeWidth={1.75} aria-hidden />
        </ConfirmDelete>
      ),
    },
  ];
  const shown = parts.filter((p) => p.bytes > 0);

  return (
    <div className="flex flex-col gap-3 px-3 pt-1 pb-2">
      <div className="flex items-baseline gap-3">
        <span className="flex min-w-0 flex-col">
          <span className="text-body text-chrome-fg">Data folder</span>
          <Hint label={usage.root}>
            <span className="truncate text-micro text-chrome-fg-subtle">{usage.root}</span>
          </Hint>
        </span>
        <span className="ml-auto shrink-0 text-xs tabular-nums text-chrome-fg-muted">{formatBytes(total)}</span>
      </div>

      {/* Segments grow by size; a tiny one keeps a few pixels so it's still there to see. */}
      <div className="flex h-5 gap-px overflow-hidden rounded-md bg-chrome-bg-hover" role="img" aria-label="Data folder usage">
        {shown.map((p) => (
          <Hint key={p.key} label={`${p.title}: ${formatBytes(p.bytes)}`}>
            <span className={`h-full ${p.color}`} style={{ flexGrow: p.bytes, flexBasis: 0, minWidth: 4 }} />
          </Hint>
        ))}
      </div>

      <ul className="flex flex-col">
        {parts.map((p) => (
          <li key={p.key} className={`flex min-h-11 items-center gap-3 py-1.5 ${p.nested ? 'pl-5' : ''}`}>
            <span className={`size-2.5 shrink-0 rounded-full ${p.color}`} aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-baseline gap-2">
                <span className="truncate text-body text-chrome-fg">{p.title}</span>
                <span className="ml-auto shrink-0 text-xs tabular-nums text-chrome-fg-muted">{formatBytes(p.bytes)}</span>
              </span>
              <span className="truncate text-micro text-chrome-fg-subtle">{p.detail}</span>
            </span>
            {/* Same width with or without a button, so the sizes line up. */}
            <span className="flex w-7 shrink-0 justify-center">{p.action}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ArchivedList({
  reviews,
  summaries,
  repos,
  onReopen,
  onDelete,
}: {
  reviews: Review[];
  summaries: ReviewSummary[];
  repos: Repo[];
  onReopen: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}): React.JSX.Element {
  const [reopening, setReopening] = useState<string | null>(null);
  const summaryById = useMemo(() => new Map(summaries.map((s) => [s.reviewId, s])), [summaries]);
  const repoById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);
  const lastActivity = (r: Review) => summaryById.get(r.id)?.lastActivityAt ?? r.createdAt;
  const sorted = [...reviews].sort((a, b) => lastActivity(b) - lastActivity(a));

  return (
    <ul className="flex flex-col">
      {sorted.map((r) => {
        const s = summaryById.get(r.id);
        const repo = repoById.get(r.repoId);
        const threads = (s?.openThreads ?? 0) + (s?.resolvedThreads ?? 0);
        const name = s?.title ?? r.branch ?? r.pinnedSha?.slice(0, 7) ?? r.id;
        const where = [
          repo !== undefined ? repoLabel(repo) : null,
          r.prNumber !== null ? `#${String(r.prNumber)}` : null,
          r.branch,
          `${String(threads)} ${threads === 1 ? 'thread' : 'threads'}`,
          `active ${relativeTime(lastActivity(r))}`,
        ].filter((x): x is string => x !== null);
        return (
          <Row key={r.id} title={<button type="button" onClick={() => goReview(r.id)} className="truncate text-left hover:underline">{name}</button>} detail={where.join(' · ')}>
            <button
              type="button"
              disabled={reopening !== null}
              onClick={() => {
                setReopening(r.id);
                void onReopen(r.id).finally(() => setReopening(null));
              }}
              className="chrome-btn"
            >
              {reopening === r.id ? 'Reopening…' : 'Reopen'}
            </button>
            <ConfirmDelete
              prompt="Delete this review for good? Its threads, reading order and viewed checks go with it."
              onConfirm={() => onDelete(r.id)}
              triggerLabel="Delete review"
              triggerClassName="chrome-icon-btn"
            >
              <Trash2 size={14} strokeWidth={1.75} aria-hidden />
            </ConfirmDelete>
          </Row>
        );
      })}
    </ul>
  );
}
