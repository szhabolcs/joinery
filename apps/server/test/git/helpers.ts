/**
 * Shared fixture helpers for the git layer test suite. Not itself a test
 * file (no `.test.ts` suffix), so `bun test` never picks it up directly.
 */
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_OPTIONAL_LOCKS: '0',
};

export type RawGitResult = { stdout: string; stderr: string; exitCode: number };

/** Runs git directly (not through the engine's allowlisted runner) to set up test fixtures. */
export function runGit(cwd: string, args: string[]): RawGitResult {
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

/** Creates a throwaway directory under `Bun.env.TMPDIR`. Caller is responsible for cleanup. */
export async function makeTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tempRoot(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** `git init` plus enough config to make commits deterministic and gpg-free. */
export async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const init = runGit(dir, ['init', '-q', '-b', 'main']);
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr}`);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  runGit(dir, ['config', 'commit.gpgsign', 'false']);
}

/** Writes a file's content, creating parent directories as needed. */
export async function writeRepoFile(repoDir: string, relPath: string, content: string | Uint8Array): Promise<void> {
  const fullPath = join(repoDir, relPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await fsWriteFile(fullPath, content);
}

export function gitAddAll(dir: string): void {
  const result = runGit(dir, ['add', '-A']);
  if (result.exitCode !== 0) throw new Error(`git add failed: ${result.stderr}`);
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

export function hashObject(dir: string, relPath: string): string {
  const result = runGit(dir, ['hash-object', relPath]);
  if (result.exitCode !== 0) throw new Error(`git hash-object failed: ${result.stderr}`);
  return result.stdout.trim();
}
