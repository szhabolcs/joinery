/**
 * Where Joinery's files live, in either of its two shapes:
 *
 * - **dev**: run from a source checkout with `bun`. Resources resolve inside
 *   the repo (`apps/web/dist`, `apps/server/migrations`) and data defaults to
 *   the repo's own `data/`.
 * - **installed**: the compiled `joinery` binary unpacked from a release
 *   tarball. It is recognised by a `release.json` next to the real
 *   (symlink-resolved) executable. The install home looks like:
 *
 * ```
 * ~/.joinery/                    JOINERY_HOME overrides
 *   current/                     replaced wholesale on update (a real dir, so
 *     joinery                    the binary's path, which macOS keys folder
 *     release.json               permissions on, never changes)
 *     web/                       built web app
 *     migrations/                server SQL migrations
 *   data/                        state.sqlite, token, worktrees, logs, cache
 * ~/.local/bin/joinery -> ~/.joinery/current/joinery
 * ~/Library/LaunchAgents/dev.joinery.server.plist   macOS: runs `current/joinery serve`
 * ~/.config/systemd/user/joinery.service             Linux: the same, as a systemd user unit
 * ```
 *
 * `JOINERY_DATA_DIR` still overrides the data directory in both shapes.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_PORT } from '@joinery/core';

/** The GitHub repo releases are published to and checked against. */
export const RELEASE_REPO = 'szhabolcs/joinery';

/** The launchd label of the background server service. */
export const SERVICE_LABEL = 'dev.joinery.server';

/** The systemd user unit of the background server service on Linux. */
export const SYSTEMD_UNIT = 'joinery.service';

/** Set in the service's environment so the server knows it may restart itself through it. */
export const SERVICE_ENV = 'JOINERY_SERVICE';

/** The release asset suffix for this machine, e.g. `darwin-arm64`; null when no build is published for it. */
export function releaseTarget(): string | null {
  const target = `${process.platform}-${process.arch}`;
  return ['darwin-arm64', 'linux-x64', 'linux-arm64'].includes(target) ? target : null;
}

/** The launchd domain target of the current user's GUI session. */
export function launchdTarget(): string {
  return `gui/${process.getuid?.() ?? 501}/${SERVICE_LABEL}`;
}

/** Kill and relaunch the background service: launchd on macOS, systemd on Linux. */
export function serviceRestartCommand(): string[] {
  return process.platform === 'darwin'
    ? ['launchctl', 'kickstart', '-k', launchdTarget()]
    : ['systemctl', '--user', 'restart', SYSTEMD_UNIT];
}

/** Started by the background service (launchd sets `XPC_SERVICE_NAME` to the label; the systemd unit sets `SERVICE_ENV`). */
export function runsAsService(): boolean {
  return process.env['XPC_SERVICE_NAME'] === SERVICE_LABEL || process.env[SERVICE_ENV] === '1';
}

/** The command that opens a URL or file with the desktop's default app. */
export function openCommand(target: string): string[] {
  // Not `cmd /c start`: cmd would parse the target as shell syntax.
  if (process.platform === 'win32') return ['rundll32', 'url.dll,FileProtocolHandler', target];
  return process.platform === 'darwin' ? ['open', target] : ['xdg-open', target];
}

export type RuntimeLayout = {
  readonly mode: 'dev' | 'installed';
  /** Semver without a leading `v`, e.g. `0.1.0`. */
  readonly version: string;
  /** The install home (`~/.joinery`). Set in both modes so `update` can name it. */
  readonly home: string;
  readonly webDistDir: string;
  readonly migrationsDir: string;
  /** Data directory before the `JOINERY_DATA_DIR` override. */
  readonly defaultDataDir: string;
};

/** The repo root by position: three levels up from `apps/server/src`. Last-resort fallback. */
const FALLBACK_REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

/** Walk up from `start` (max 12 levels) looking for `tsconfig.base.json`. */
function walkUpForRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'tsconfig.base.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * The repo root in dev. Inside a dev-compiled binary (`apps/cli` `bun run
 * build`) `import.meta.dirname` is a virtual `/$bunfs` path, so also try the
 * real executable's location and the working directory.
 */
function findRepoRoot(): string {
  const starts: Array<() => string> = [
    () => import.meta.dirname,
    () => dirname(realpathSync(process.execPath)),
    () => process.cwd(),
  ];
  for (const start of starts) {
    try {
      const found = walkUpForRoot(start());
      if (found !== undefined) return found;
    } catch {
      // try the next candidate
    }
  }
  return FALLBACK_REPO_ROOT;
}

function installHome(): string {
  return resolve(process.env['JOINERY_HOME']?.trim() || join(homedir(), '.joinery'));
}

function readVersionOr(file: string, fallback: string): string {
  try {
    return readVersion(file);
  } catch {
    return fallback;
  }
}

function readVersion(file: string): string {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string') throw new Error(`no version in ${file}`);
  return parsed.version;
}

let cached: RuntimeLayout | undefined;

/** Resolve the current layout. Cheap after the first call. */
export function runtimeLayout(): RuntimeLayout {
  if (cached !== undefined) return cached;
  const home = installHome();
  let binDir: string | undefined;
  try {
    binDir = dirname(realpathSync(process.execPath));
  } catch {
    binDir = undefined;
  }
  const releaseFile = binDir === undefined ? undefined : join(binDir, 'release.json');
  if (binDir !== undefined && releaseFile !== undefined && existsSync(releaseFile)) {
    cached = {
      mode: 'installed',
      version: readVersion(releaseFile),
      home,
      webDistDir: join(binDir, 'web'),
      migrationsDir: join(binDir, 'migrations'),
      defaultDataDir: join(home, 'data'),
    };
  } else {
    const REPO_ROOT = findRepoRoot();
    cached = {
      mode: 'dev',
      version: readVersionOr(join(REPO_ROOT, 'package.json'), '0.0.0'),
      home,
      webDistDir: join(REPO_ROOT, 'apps', 'web', 'dist'),
      migrationsDir: join(REPO_ROOT, 'apps', 'server', 'migrations'),
      defaultDataDir: join(REPO_ROOT, 'data'),
    };
  }
  return cached;
}

/** The data directory, honouring `JOINERY_DATA_DIR`. */
export function dataDirRoot(): string {
  return resolve(process.env['JOINERY_DATA_DIR']?.trim() || runtimeLayout().defaultDataDir);
}

/** The data-dir file `scripts/install.sh` persists the chosen port to. */
export function portFile(): string {
  return join(dataDirRoot(), '.port');
}

function parsePort(raw: string, source: string): number {
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) throw new Error(`invalid port "${raw}" in ${source}`);
  return port;
}

/**
 * The port the server listens on and the CLI connects to: `JOINERY_PORT`,
 * then the data dir's `.port` file, then `DEFAULT_PORT`.
 */
export function configuredPort(): number {
  const fromEnv = process.env['JOINERY_PORT']?.trim();
  if (fromEnv) return parsePort(fromEnv, 'JOINERY_PORT');
  const file = portFile();
  if (existsSync(file)) {
    const fromFile = readFileSync(file, 'utf8').trim();
    if (fromFile) return parsePort(fromFile, file);
  }
  return DEFAULT_PORT;
}
