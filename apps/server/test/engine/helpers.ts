/** Shared fixtures for the engine test suite: throwaway git repos + a temp sqlite db. */
import { mkdir, mkdtemp, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openDb,
  runMigrations,
  upsertRepo,
  createReview,
  setCurrentRevision,
  type Db,
  type OpenedDb,
} from '../../src/db/index.ts';
import type { Repo, Review } from '@joinery/core';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_OPTIONAL_LOCKS: '0',
};

export function runGit(cwd: string, args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync(['git', ...args], { cwd, env: ENV });
  return {
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
    exitCode: proc.exitCode,
  };
}

function tempRoot(): string {
  return Bun.env.TMPDIR ?? tmpdir();
}

export async function makeTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tempRoot(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch((err: NodeJS.ErrnoException) => {
    // Windows won't delete a database a not-yet-collected prepared statement holds open.
    if (process.platform !== 'win32' || err.code !== 'EBUSY') throw err;
  });
}

export async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const init = runGit(dir, ['init', '-q', '-b', 'main']);
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr}`);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  runGit(dir, ['config', 'commit.gpgsign', 'false']);
}

export async function writeRepoFile(repoDir: string, relPath: string, content: string): Promise<void> {
  const fullPath = join(repoDir, relPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await fsWriteFile(fullPath, content);
}

export function gitCommit(dir: string, message: string): string {
  const add = runGit(dir, ['add', '-A']);
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr}`);
  const commit = runGit(dir, ['commit', '-q', '-m', message, '--allow-empty']);
  if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
  return headSha(dir);
}

export function headSha(dir: string): string {
  const result = runGit(dir, ['rev-parse', 'HEAD']);
  if (result.exitCode !== 0) throw new Error(`git rev-parse failed: ${result.stderr}`);
  return result.stdout.trim();
}

export type TestFixture = {
  readonly repoDir: string;
  readonly dataDir: string;
  readonly db: Db;
  readonly opened: OpenedDb;
  readonly repo: Repo;
  cleanup: () => Promise<void>;
};

/**
 * A repo with a `main` branch (one commit) and `branch` checked out in the
 * same directory (its own commit on top), registered but with no review row
 * yet — for tests that want to create reviews themselves (e.g. adoption).
 */
export async function setupRepo(branch = 'feature'): Promise<TestFixture> {
  const repoDir = await makeTempDir('joinery-engine-repo-');
  await initRepo(repoDir);
  await writeRepoFile(repoDir, 'README.md', 'hello\n');
  gitCommit(repoDir, 'initial');
  runGit(repoDir, ['checkout', '-q', '-b', branch]);
  await writeRepoFile(repoDir, 'feature.txt', 'feature content\n');
  gitCommit(repoDir, 'add feature file');

  const dataDir = await makeTempDir('joinery-engine-data-');
  const opened = openDb({ file: join(dataDir, 'state.sqlite') });
  await runMigrations(opened.sqlite);

  const repo = await upsertRepo(opened.db, {
    rootPath: repoDir,
    remoteOwner: null,
    remoteName: null,
    defaultBranch: 'main',
  });

  return {
    repoDir,
    dataDir,
    db: opened.db,
    opened,
    repo,
    cleanup: async () => {
      opened.sqlite.close();
      await removeTempDir(repoDir);
      await removeTempDir(dataDir);
    },
  };
}

/** `setupRepo` plus a review attached to `branch`, defaulted to `working` since it's attached. */
export async function setupRepoAndReview(branch = 'feature'): Promise<TestFixture & { review: Review }> {
  const ctx = await setupRepo(branch);
  const review = await createReview(ctx.db, {
    repoId: ctx.repo.id,
    branch,
    pinnedSha: null,
    baseRef: 'main',
  });
  const attached = await setCurrentRevision(ctx.db, review.id, 'working');
  return { ...ctx, review: attached };
}
