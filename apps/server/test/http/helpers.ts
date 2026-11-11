/**
 * Shared fixtures for the http test suite: a `createApp()`-assembled Hono
 * app backed by a throwaway git repo + temp sqlite db, plus small request
 * helpers so route tests read as `apiFetch(app, token, 'GET', '/api/...')`.
 */
import { mkdir, mkdtemp, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, runMigrations, upsertRepo, createReview, setCurrentRevision, type Db, type OpenedDb } from '../../src/db/index.ts';
import { EngineRegistry } from '../../src/engine/index.ts';
import { createApp, type CreatedApp } from '../../src/http/app.ts';
import type { Repo, Review } from '@joinery/core';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_OPTIONAL_LOCKS: '0',
};

export const TEST_TOKEN = 'test-token-abc123';

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

export type HttpFixture = {
  readonly repoDir: string;
  readonly dataDir: string;
  readonly db: Db;
  readonly opened: OpenedDb;
  readonly created: CreatedApp;
  readonly registry: EngineRegistry;
  readonly token: string;
  cleanup: () => Promise<void>;
};

/**
 * A repo with `main` (one commit) and `branch` checked out in the same
 * directory (its own commit on top), registered but with no review row yet —
 * mirrors `test/engine/helpers.ts#setupRepo`, wired through `createApp` for
 * `/api/*` testing.
 */
export async function setupHttp(branch = 'feature'): Promise<HttpFixture> {
  const repoDir = await makeTempDir('joinery-http-repo-');
  await initRepo(repoDir);
  await writeRepoFile(repoDir, 'README.md', 'hello\n');
  gitCommit(repoDir, 'initial');
  runGit(repoDir, ['checkout', '-q', '-b', branch]);
  await writeRepoFile(repoDir, 'feature.txt', 'feature content\n');
  gitCommit(repoDir, 'add feature file');

  const dataDir = await makeTempDir('joinery-http-data-');
  const opened = openDb({ file: join(dataDir, 'state.sqlite') });
  await runMigrations(opened.sqlite);

  const registry = new EngineRegistry(opened.db);
  const webDistDir = join(dataDir, 'nonexistent-web-dist');
  const created = createApp({ db: opened.db, registry, token: TEST_TOKEN, webDistDir });

  return {
    repoDir,
    dataDir,
    db: opened.db,
    opened,
    created,
    registry,
    token: TEST_TOKEN,
    cleanup: async () => {
      registry.disposeAll();
      opened.sqlite.close();
      await removeTempDir(repoDir);
      await removeTempDir(dataDir);
    },
  };
}

export async function registerRepo(fixture: HttpFixture): Promise<Repo> {
  return await upsertRepo(fixture.db, {
    rootPath: fixture.repoDir,
    remoteOwner: null,
    remoteName: null,
    defaultBranch: 'main',
  });
}

/** `registerRepo` plus a review attached to `branch`, defaulted to `working` since it's attached. */
export async function setupHttpWithReview(branch = 'feature'): Promise<HttpFixture & { review: Review; repo: Repo }> {
  const fixture = await setupHttp(branch);
  const repo = await registerRepo(fixture);
  const review = await createReview(fixture.db, {
    repoId: repo.id,
    branch,
    pinnedSha: null,
    baseRef: 'main',
  });
  const attached = await setCurrentRevision(fixture.db, review.id, 'working');
  return { ...fixture, review: attached, repo };
}

/** Issues a request against `fixture.created.app.fetch`, with the bearer token attached by default. */
export async function apiFetch(
  fixture: Pick<HttpFixture, 'created' | 'token'>,
  method: string,
  path: string,
  options: { body?: unknown; auth?: 'bearer' | 'query' | 'none' | 'bad'; headers?: Record<string, string> } = {},
): Promise<Response> {
  const { body, auth = 'bearer', headers = {} } = options;
  const url = new URL(path, 'http://localhost');
  const finalHeaders: Record<string, string> = { ...headers };
  if (body !== undefined) finalHeaders['content-type'] = 'application/json';

  if (auth === 'bearer') {
    finalHeaders['authorization'] = `Bearer ${fixture.token}`;
  } else if (auth === 'query') {
    url.searchParams.set('token', fixture.token);
  } else if (auth === 'bad') {
    finalHeaders['authorization'] = 'Bearer wrong-token';
  }

  const request = new Request(url.toString(), {
    method,
    headers: finalHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return await fixture.created.app.fetch(request);
}

export type LiveServer = {
  readonly port: number;
  /** Builds a `ws://127.0.0.1:<port>/api/events` URL. Pass `{ token: null }` to omit the query token entirely. */
  readonly wsUrl: (options?: { token?: string | null }) => string;
  stop: () => void;
};

/**
 * A real `Bun.serve` bound to an ephemeral port (`port: 0`; the port is read
 * back off the returned server, never hardcoded), for tests that need an
 * actual WebSocket upgrade — hono's Bun adapter only populates `c.env.server`
 * for a real `Bun.serve` connection, so `WS /api/events`'s `onMessage`/
 * `onClose` dispatch is unreachable through plain `app.fetch()` (see
 * `ws.test.ts`'s module comment). Never binds the app's real port (7317);
 * always closes the server (via the caller's `stop()` in test teardown).
 */
export function startLiveServer(fixture: Pick<HttpFixture, 'created' | 'token' | 'registry'>): LiveServer {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: fixture.created.app.fetch,
    websocket: fixture.created.websocket,
  });
  // Topic events publish through the server, as in `start.ts`.
  fixture.registry.bus.attach(server);
  const port = server.port;
  if (port === undefined) throw new Error('Bun.serve did not report a port for the ephemeral (port: 0) listener');
  return {
    port,
    wsUrl: (options = {}) => {
      const token = options.token === undefined ? fixture.token : options.token;
      const qs = token === null ? '' : `?token=${encodeURIComponent(token)}`;
      return `ws://127.0.0.1:${String(port)}/api/events${qs}`;
    },
    stop: () => server.stop(true),
  };
}
