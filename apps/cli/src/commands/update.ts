/**
 * `joinery update`: replace `~/.joinery/current` with a newer release and
 * restart the service.
 *
 * Layout and steps mirror scripts/install.sh. `current` is a real directory,
 * not a symlink into per-version dirs: macOS keys folder permissions on the
 * binary's real path, so it has to stay put across updates. The tarball is
 * extracted into a temp sibling dir, then swapped in by two renames.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { RELEASE_REPO, releaseTarget, runtimeLayout, serviceRestartCommand } from '@joinery/server/runtime';
import { UsageError, flagBoolean, flagString } from '../args.ts';
import { printLine } from '../format.ts';
import { parseCommand, wantsHelp } from './shared.ts';
import { serviceFile } from './service.ts';
import type { Command } from './types.ts';

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function assetName(version: string): string {
  const target = releaseTarget();
  if (target === null) throw new Error(`no release is published for ${process.platform}-${process.arch}`);
  return `joinery-${version}-${target}.tar.gz`;
}

function assetUrl(version: string, suffix = ''): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${assetName(version)}${suffix}`;
}

async function latestVersion(): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'joinery-cli' },
  });
  if (!res.ok) throw new Error(`could not look up the latest release (HTTP ${res.status})`);
  const body = (await res.json()) as { tag_name?: unknown };
  if (typeof body.tag_name !== 'string') throw new Error('latest release has no tag_name');
  return body.tag_name.replace(/^v/, '');
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { 'user-agent': 'joinery-cli' } });
  if (!res.ok) throw new Error(`download failed: ${url} (HTTP ${res.status})`);
  await Bun.write(dest, res);
}

async function sha256(file: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}

async function run(cmd: readonly string[]): Promise<number> {
  const proc = Bun.spawn([...cmd], { stdout: 'ignore', stderr: 'inherit' });
  return proc.exited;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new UsageError('refusing to update without confirmation on a non-interactive terminal; pass --yes');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/**
 * Move `staging` into `current`. The old `current` (a dir, or a symlink from
 * older installs) is renamed aside first, since a dir can't be renamed over
 * either, then removed; the running binary keeps its inode until it exits.
 */
async function replaceCurrent(home: string, staging: string): Promise<void> {
  const current = join(home, 'current');
  const old = join(home, `.current-old-${process.pid}`);
  let hadCurrent = true;
  await rename(current, old).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
    hadCurrent = false;
  });
  try {
    await rename(staging, current);
  } catch (err) {
    if (hadCurrent) await rename(old, current);
    throw err;
  }
  await rm(old, { recursive: true, force: true });
}

export const update: Command = {
  path: 'update',
  summary: 'Update Joinery to the latest release and restart the service',
  usage: 'joinery update [--yes] [--from <tarball>] [--version <x.y.z>]',
  async run(argv) {
    const parsed = parseCommand(argv, [
      { name: 'yes', type: 'boolean' },
      { name: 'from', type: 'string' },
      { name: 'version', type: 'string' },
    ]);
    if (wantsHelp(parsed)) return printLine(update.usage);
    if (process.platform === 'win32') {
      throw new Error('there are no Windows releases to update to; run `git pull` in your checkout instead');
    }

    const layout = runtimeLayout();
    if (layout.mode !== 'installed') {
      process.stderr.write('this is a source checkout — use git pull\n');
      process.exit(1);
    }
    const yes = flagBoolean(parsed.flags, 'yes');
    const from = flagString(parsed.flags, 'from');
    const requested = flagString(parsed.flags, 'version')?.replace(/^v/, '');
    if (requested !== undefined && !SEMVER.test(requested)) {
      throw new UsageError(`invalid --version "${requested}"`);
    }

    const work = await mkdtemp(join(tmpdir(), 'joinery-update-'));
    try {
      let tarball: string;
      let version = requested;
      if (from !== undefined) {
        tarball = resolve(from);
        if (!existsSync(tarball)) throw new UsageError(`no such file: ${tarball}`);
      } else {
        version ??= await latestVersion();
        if (!SEMVER.test(version)) throw new Error(`unexpected release version "${version}"`);
        if (version === layout.version) {
          printLine(`already up to date (${layout.version})`);
          return;
        }
        tarball = join(work, assetName(version));
      }

      printLine(`current   ${layout.version}`);
      printLine(`target    ${from !== undefined ? `${from} (local tarball)` : version}`);
      printLine(`install   ${join(layout.home, 'current')}`);
      if (existsSync(serviceFile())) printLine('then restart the background service');
      if (!yes && !(await confirm('Continue?'))) {
        printLine('cancelled');
        return;
      }

      if (from === undefined && version !== undefined) {
        printLine(`downloading ${assetName(version)}`);
        await download(assetUrl(version), tarball);
        const sumFile = join(work, 'tarball.sha256');
        await download(assetUrl(version, '.sha256'), sumFile);
        const expected = (await readFile(sumFile, 'utf8')).trim().split(/\s+/)[0]?.toLowerCase();
        const actual = await sha256(tarball);
        if (expected !== actual) throw new Error(`sha256 mismatch: expected ${expected}, got ${actual}`);
      }

      // Extract into a temp sibling of `current` so the swap is two renames.
      const staging = await mkdtemp(join(layout.home, '.staging-'));
      try {
        if ((await run(['tar', '-xzf', tarball, '-C', staging])) !== 0) throw new Error('tar extraction failed');
        const manifest = JSON.parse(await readFile(join(staging, 'release.json'), 'utf8')) as { version?: unknown };
        if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
          throw new Error('tarball has no valid release.json');
        }
        if (version !== undefined && manifest.version !== version) {
          throw new Error(`tarball is version ${manifest.version}, expected ${version}`);
        }
        version = manifest.version;
        await replaceCurrent(layout.home, staging);
      } catch (err) {
        await rm(staging, { recursive: true, force: true });
        throw err;
      }
      printLine(`updated ${layout.version} -> ${version}`);

      if (existsSync(serviceFile())) {
        printLine('restarting service');
        if ((await run(serviceRestartCommand())) !== 0) {
          printLine('could not restart the service; run `joinery service install`');
        }
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
};
