/** Shared test setup: a temp `JOINERY_DATA_DIR` per test file, migrated fresh. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db, type OpenedDb } from '../../src/db/client.ts';
import { runMigrations } from '../../src/db/migrate.ts';

export type TestDb = {
  readonly db: Db;
  readonly dir: string;
  close: () => Promise<void>;
};

export async function setupTestDb(): Promise<TestDb> {
  const dir = await mkdtemp(join(tmpdir(), 'joinery-db-test-'));
  const opened: OpenedDb = openDb({ file: join(dir, 'state.sqlite') });
  await runMigrations(opened.sqlite);

  return {
    db: opened.db,
    dir,
    close: async () => {
      opened.sqlite.close();
      await rm(dir, { recursive: true, force: true }).catch((err: NodeJS.ErrnoException) => {
        // Windows won't delete a database a not-yet-collected prepared statement holds open.
        if (process.platform !== 'win32' || err.code !== 'EBUSY') throw err;
      });
    },
  };
}
