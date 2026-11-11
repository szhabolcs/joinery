/**
 * Shared plumbing for the host CLIs (`gh`, `glab`, `gt`): spawn with a timeout, and a
 * short-lived negative availability cache. Same rule as the `Forge` seam: a
 * missing or unauthenticated CLI is data (`null`), never a thrown error.
 *
 * The cache is keyed by `<cli>@<host of the cwd's origin>`. A host is marked
 * unavailable only when the CLI can't be spawned (ENOENT) or `<cli> auth
 * status` fails — a plain failed call (404 for an unknown PR number, a rate
 * limit) never poisons it. The verdict carries a reason (see `diagnose`). While marked, calls short-circuit to `null` for
 * `AVAILABILITY_TTL_MS`.
 */
import type { ForgeUnavailableReason } from '@joinery/core';
import { z } from 'zod';
import { remoteHost } from '../repo.ts';

export type ForgeCli = 'gh' | 'glab' | 'gt';

/** A host CLI call is a network round trip; one that hangs must not hold its caller (or its cache key) forever. */
const CLI_TIMEOUT_MS = 30_000;
/** `auth status` is local-ish and gates everything else, so it gets a shorter leash. */
const PROBE_TIMEOUT_MS = 10_000;
/** How long a "missing or unauthenticated" verdict (and a positive auth check) is trusted. */
const AVAILABILITY_TTL_MS = 2 * 60_000;

type SpawnResult = { stdout: string; exitCode: number } | null;

/**
 * Spawn `cli`; `null` when it can't be started (not installed). Prompts are
 * disabled and stdin ignored; stderr is drained so a chatty failure can't fill
 * its pipe and stall the process; killed after `timeoutMs`.
 */
export async function spawnCli(
  cli: ForgeCli,
  args: readonly string[],
  cwd: string,
  timeoutMs: number = CLI_TIMEOUT_MS,
): Promise<SpawnResult> {
  let proc;
  try {
    proc = Bun.spawn([cli, ...args], {
      cwd,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_PROMPT: '1', GITEA_CLI_NO_UPDATE_NOTIFIER: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
    });
  } catch {
    return null;
  }
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, exitCode };
}

/** Why a host can't be asked; `null` in the cache means the last check passed. */
export type CliUnavailableReason = Exclude<ForgeUnavailableReason, 'unsupported-host'>;
/** Where a forge call failed to reach: the reason, and the origin host it refers to. */
export type CliUnavailable = { reason: CliUnavailableReason; host: string | null };

/** `reason` is the last verdict for a `cli@host` (`null` = available), `at` when it was reached. */
const availability = new Map<string, { reason: CliUnavailableReason | null; at: number }>();
/** cwd -> origin host, so the cache key costs one `git config` per clone, not per call. */
const hostByCwd = new Map<string, Promise<string | null>>();

/** The lowercased host of `cwd`'s origin, cached per clone; `null` when there is none. */
export function originHost(cwd: string): Promise<string | null> {
  let host = hostByCwd.get(cwd);
  if (host === undefined) {
    host = remoteHost({ cwd }).catch(() => null);
    hostByCwd.set(cwd, host);
  }
  return host;
}

function fresh(entry: { at: number } | undefined): boolean {
  return entry !== undefined && Date.now() - entry.at < AVAILABILITY_TTL_MS;
}

const gtAccountsSchema = z.array(z.object({ host: z.string(), credential_available: z.boolean() }));

/**
 * `gt`'s stored accounts whose instance URL is on `host`, from local config
 * only (`gt auth status --json` without `--verify` makes no request). `null`
 * when `gt` can't be spawned; empty when it fails or its output isn't understood.
 */
async function gtAccounts(host: string | null, cwd: string): Promise<z.infer<typeof gtAccountsSchema> | null> {
  const result = await spawnCli('gt', ['auth', 'status', '--json', 'host,credential_available'], cwd, PROBE_TIMEOUT_MS);
  if (result === null) return null;
  if (result.exitCode !== 0) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  const parsed = gtAccountsSchema.safeParse(raw);
  if (!parsed.success) return [];
  return host === null ? parsed.data : parsed.data.filter((a) => urlHost(a.host) === host);
}

function urlHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Instance URLs by origin host, so `--host` costs one local `gt auth status` per host per TTL. */
const giteaUrls = new Map<string, { url: string; at: number }>();

/**
 * The Gitea instance URL `gt` knows for `host` (`https://git.example.com`, or
 * with a base path), else `https://<host>`. Passed as `gt --host`, so the
 * instance never depends on `gt` matching the clone's remote, which it can't
 * for an SSH remote on a custom port without `gt config set ssh_host`.
 */
export async function giteaInstanceUrl(host: string, cwd: string): Promise<string> {
  const cached = giteaUrls.get(host);
  if (cached !== undefined && fresh(cached)) return cached.url;
  const accounts = await gtAccounts(host, cwd);
  const url = (accounts?.[0]?.host ?? `https://${host}`).replace(/\/+$/u, '');
  giteaUrls.set(host, { url, at: Date.now() });
  return url;
}

/**
 * Whether `cli` holds a login for `host`, read from local config only (no
 * network): `glab config get token`, `gh auth token`, `gt auth status --json`
 * (an account that signs with an SSH key has no token, so `gt` reports
 * whether a credential is stored). `null` when the CLI can't be spawned. A
 * token itself is discarded after the emptiness check.
 */
export async function localToken(cli: ForgeCli, host: string | null, cwd: string): Promise<boolean | null> {
  if (cli === 'gt') {
    const accounts = await gtAccounts(host, cwd);
    return accounts === null ? null : accounts.some((a) => a.credential_available);
  }
  const hostArgs = host === null ? [] : [cli === 'glab' ? '--host' : '--hostname', host];
  const args = cli === 'glab' ? ['config', 'get', 'token', ...hostArgs] : ['auth', 'token', ...hostArgs];
  const result = await spawnCli(cli, args, cwd, PROBE_TIMEOUT_MS);
  if (result === null) return null;
  return result.exitCode === 0 && result.stdout.trim() !== '';
}

/** `<cli> auth status`, hostname-scoped when the origin host is known. Hits the network. */
export async function probeAuth(cli: ForgeCli, host: string | null, cwd: string): Promise<boolean> {
  if (cli === 'gt') {
    const hostArgs = host === null ? [] : ['--host', await giteaInstanceUrl(host, cwd)];
    return (await spawnCli('gt', ['auth', 'status', '--verify', ...hostArgs], cwd, PROBE_TIMEOUT_MS))?.exitCode === 0;
  }
  const args = host === null ? ['auth', 'status'] : ['auth', 'status', '--hostname', host];
  return (await spawnCli(cli, args, cwd, PROBE_TIMEOUT_MS))?.exitCode === 0;
}

/**
 * Why `cli` can't be asked about `host`, or `null` when it can. A passing
 * `auth status` settles it; a failing one is told apart locally: no CLI is
 * `missing-cli`, no stored login is `not-authenticated`, and a stored login
 * with a failing check means the host itself can't be reached.
 */
export async function diagnose(cli: ForgeCli, host: string | null, cwd: string): Promise<CliUnavailableReason | null> {
  if (await probeAuth(cli, host, cwd)) return null;
  const token = await localToken(cli, host, cwd);
  if (token === null) return 'missing-cli';
  return token ? 'unreachable' : 'not-authenticated';
}

/** Probes in flight by `cli@host`, so a burst of parallel failures on a cold cache spawns one `auth status`. */
const probes = new Map<string, Promise<CliUnavailableReason | null>>();

/** Diagnose, record the verdict in the cache, and share the in-flight probe with concurrent callers. */
function probeAndCache(
  key: string,
  cli: ForgeCli,
  host: string | null,
  cwd: string,
): Promise<CliUnavailableReason | null> {
  let probe = probes.get(key);
  if (probe === undefined) {
    probe = diagnose(cli, host, cwd)
      .then((reason) => {
        availability.set(key, { reason, at: Date.now() });
        return reason;
      })
      .finally(() => probes.delete(key));
    probes.set(key, probe);
  }
  return probe;
}

/**
 * Why `cli` can't be asked for `cwd`'s origin host (`null` when it can),
 * cached for `AVAILABILITY_TTL_MS` either way so a VPN coming back recovers
 * on its own.
 */
export async function cliUnavailable(cli: ForgeCli, cwd: string): Promise<CliUnavailable | null> {
  const host = await originHost(cwd);
  const key = `${cli}@${host ?? ''}`;
  const cached = availability.get(key);
  const reason = cached !== undefined && fresh(cached) ? cached.reason : await probeAndCache(key, cli, host, cwd);
  return reason === null ? null : { reason, host };
}

/**
 * Run `cli`, returning stdout on exit 0 and `null` on anything else — not
 * installed, unauthenticated, a wrong remote, rate limited, or timed out.
 * Short-circuits to `null` while the host is known to be unavailable; a failed
 * call then checks `auth status` (cached) to decide whether to start doing so.
 */
export async function runCli(cli: ForgeCli, args: readonly string[], cwd: string): Promise<string | null> {
  const host = await originHost(cwd);
  const key = `${cli}@${host ?? ''}`;
  const cached = availability.get(key);
  if (cached !== undefined && cached.reason !== null && fresh(cached)) return null;

  const result = await spawnCli(cli, args, cwd);
  if (result === null) {
    availability.set(key, { reason: 'missing-cli', at: Date.now() });
    return null;
  }
  if (result.exitCode === 0) return result.stdout;
  // Only a failed `auth status` marks the host unavailable; the failure itself stays a plain `null`.
  if (!(cached !== undefined && cached.reason === null && fresh(cached))) {
    await probeAndCache(key, cli, host, cwd);
  }
  return null;
}

/** The result fields that carry an unavailability verdict (spread into an `available: false` result). */
export function unavailableFields(u: CliUnavailable | null): {
  unavailableReason?: ForgeUnavailableReason;
  unavailableHost?: string | null;
} {
  return u === null ? {} : { unavailableReason: u.reason, unavailableHost: u.host };
}
