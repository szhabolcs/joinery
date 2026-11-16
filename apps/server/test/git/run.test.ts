import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';
import { assertAllowed, git, GitNotAllowedError, gitOrThrow } from '../../src/git/run.ts';
import { gitCommit, initRepo, makeTempDir, removeTempDir, writeRepoFile } from './helpers.ts';

describe('write allowlist', () => {
  it('rejects git commit', () => {
    expect(() => assertAllowed(['commit', '-m', 'x'], undefined)).toThrow(GitNotAllowedError);
  });

  it('rejects git push', () => {
    expect(() => assertAllowed(['push'], undefined)).toThrow(GitNotAllowedError);
  });

  it('rejects git reset', () => {
    expect(() => assertAllowed(['reset', '--hard'], undefined)).toThrow(GitNotAllowedError);
  });

  it('rejects git checkout', () => {
    expect(() => assertAllowed(['checkout', 'main'], undefined)).toThrow(GitNotAllowedError);
  });

  it('rejects git worktree prune outright', () => {
    expect(() => assertAllowed(['worktree', 'prune'], undefined)).toThrow(GitNotAllowedError);
  });

  it('rejects git worktree remove', () => {
    expect(() => assertAllowed(['worktree', 'remove', '/some/path'], '/data')).toThrow(GitNotAllowedError);
  });

  it('rejects worktree add without --detach', () => {
    expect(() => assertAllowed(['worktree', 'add', '/data/wt', 'HEAD'], '/data')).toThrow(GitNotAllowedError);
  });

  it('rejects worktree add outside the data dir', () => {
    expect(() => assertAllowed(['worktree', 'add', '--detach', '/elsewhere/wt', 'HEAD'], '/data')).toThrow(
      GitNotAllowedError,
    );
  });

  it('allows worktree add --detach under the data dir', () => {
    expect(() => assertAllowed(['worktree', 'add', '--detach', '/data/repo/wt', 'HEAD'], '/data')).not.toThrow();
  });

  it('allows worktree list (read-only)', () => {
    expect(() => assertAllowed(['worktree', 'list', '--porcelain'], undefined)).not.toThrow();
  });

  it('rejects update-ref outside refs/review/*', () => {
    expect(() => assertAllowed(['update-ref', 'refs/heads/main', 'HEAD'], undefined)).toThrow(GitNotAllowedError);
  });

  it('allows update-ref under refs/review/*', () => {
    expect(() => assertAllowed(['update-ref', 'refs/review/abc123', 'HEAD'], undefined)).not.toThrow();
  });

  it('allows a delete update-ref under refs/review/*', () => {
    expect(() => assertAllowed(['update-ref', '-d', 'refs/review/abc123'], undefined)).not.toThrow();
  });

  it('rejects an unknown subcommand entirely', () => {
    expect(() => assertAllowed(['gc'], undefined)).toThrow(GitNotAllowedError);
  });

  it('rejects an empty argument list', () => {
    expect(() => assertAllowed([], undefined)).toThrow(GitNotAllowedError);
  });
});

describe('read-only allowlist, exercised against a real repo', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => removeTempDir(d)));
  });

  it('allows status and rejects commit through git()/gitOrThrow', async () => {
    const dir = await makeTempDir('joinery-run-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'a.txt', 'hi\n');
    gitCommit(dir, 'initial');

    const status = await git(['status', '--porcelain=v2', '--branch', '-z'], { cwd: dir });
    expect(status.exitCode).toBe(0);

    await expect(gitOrThrow(['commit', '-m', 'nope', '--allow-empty'], { cwd: dir })).rejects.toThrow(
      GitNotAllowedError,
    );
  });

  // The shim is a `#!/bin/sh` script on a `:`-separated PATH.
  it.skipIf(process.platform === 'win32')('GIT_OPTIONAL_LOCKS=0 is always set, even when the caller tries to override it', async () => {
    // A shim `git` that just dumps its GIT_OPTIONAL_LOCKS to a file, so we
    // can observe what run.ts actually put in the child's environment
    // rather than trusting real git's behavior with the flag.
    const shimDir = await makeTempDir('joinery-run-shim-');
    dirs.push(shimDir);
    const outFile = join(shimDir, 'out.txt');
    const shimPath = join(shimDir, 'git');
    await writeFile(shimPath, `#!/bin/sh\necho "$GIT_OPTIONAL_LOCKS" > "${outFile}"\nexit 0\n`);
    await chmod(shimPath, 0o755);

    await git(['status'], {
      cwd: shimDir,
      env: { PATH: `${shimDir}:${process.env.PATH ?? ''}`, GIT_OPTIONAL_LOCKS: '1' },
    });

    const written = (await readFile(outFile, 'utf8')).trim();
    expect(written).toBe('0');
  });
});
