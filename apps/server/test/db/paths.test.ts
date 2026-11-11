import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDataDirs, ensureToken, readToken, resolveDataPaths } from '../../src/db/paths.ts';

const originalEnv = process.env['JOINERY_DATA_DIR'];

afterEach(() => {
  if (originalEnv === undefined) delete process.env['JOINERY_DATA_DIR'];
  else process.env['JOINERY_DATA_DIR'] = originalEnv;
});

describe('data directory resolution', () => {
  test('honors JOINERY_DATA_DIR and lays out the expected tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joinery-paths-test-'));
    try {
      process.env['JOINERY_DATA_DIR'] = dir;
      const paths = resolveDataPaths();
      expect(paths.root).toBe(dir);
      expect(paths.dbFile).toBe(join(dir, 'state.sqlite'));
      expect(paths.tokenFile).toBe(join(dir, 'token'));
      expect(paths.worktreesDir).toBe(join(dir, 'worktrees'));
      expect(paths.logsDir).toBe(join(dir, 'logs'));

      await ensureDataDirs(paths);
      for (const d of [paths.worktreesDir, paths.logsDir]) {
        const s = await stat(d);
        expect(s.isDirectory()).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('generates a token with mode 0600 and readToken reads it back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joinery-paths-test-'));
    try {
      process.env['JOINERY_DATA_DIR'] = dir;
      const paths = resolveDataPaths();
      await ensureDataDirs(paths);

      const token = await ensureToken(paths);
      expect(token.length).toBeGreaterThan(10);

      const s = await stat(paths.tokenFile);
      // Windows has no POSIX modes; the folder's ACL protects the token there.
      if (process.platform !== 'win32') expect(s.mode & 0o777).toBe(0o600);

      const read = await readToken(paths);
      expect(read).toBe(token);

      // Calling ensureToken again must not rotate the token.
      const again = await ensureToken(paths);
      expect(again).toBe(token);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
