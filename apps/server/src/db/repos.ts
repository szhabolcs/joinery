/**
 * `repo` — a registered local clone, keyed by its canonical root path.
 */
import { repo } from '@joinery/core/db';
import type { ForgeKind, Repo } from '@joinery/core';
import { repoId } from '@joinery/core';
import { eq } from 'drizzle-orm';
import { detectForge } from '../git/forge/detect.ts';
import type { Db } from './client.ts';

function toRepo(row: typeof repo.$inferSelect): Repo {
  return {
    id: row.id,
    rootPath: row.rootPath,
    remoteHost: row.remoteHost,
    forge: row.forge,
    remoteOwner: row.remoteOwner,
    remoteName: row.remoteName,
    defaultBranch: row.defaultBranch,
    createdAt: row.createdAt,
  };
}

export type UpsertRepoInput = {
  readonly rootPath: string;
  /** Picks the forge (`git/forge`); omitted means unknown. */
  readonly remoteHost?: string | null | undefined;
  /** Detected forge for `remoteHost`; omitted means not detected yet. */
  readonly forge?: ForgeKind | null | undefined;
  readonly remoteOwner: string | null;
  readonly remoteName: string | null;
  readonly defaultBranch: string;
};

/** Add a repo, keyed by its canonical `rootPath`. Re-adding the same path updates it in place. */
export async function upsertRepo(db: Db, input: UpsertRepoInput): Promise<Repo> {
  const id = repoId();
  const rows = await db
    .insert(repo)
    .values({
      id,
      rootPath: input.rootPath,
      remoteHost: input.remoteHost ?? null,
      forge: input.forge ?? null,
      remoteOwner: input.remoteOwner,
      remoteName: input.remoteName,
      defaultBranch: input.defaultBranch,
    })
    .onConflictDoUpdate({
      target: repo.rootPath,
      set: {
        remoteHost: input.remoteHost ?? null,
        // Re-registering a path re-detects (the user may have logged in since).
        forge: input.forge ?? null,
        remoteOwner: input.remoteOwner,
        remoteName: input.remoteName,
        defaultBranch: input.defaultBranch,
      },
    })
    .returning();

  const row = rows[0];
  if (row === undefined) throw new Error('upsertRepo: insert returned no row');
  return toRepo(row);
}

/** Backfills in flight, by repo id, so concurrent loads of one row probe once. */
const forgeBackfills = new Map<string, Promise<Repo>>();
/** When a `'none'` row was last re-checked, by repo id (per process). */
const noneRechecks = new Map<string, number>();
/** A `'none'` verdict on an unfamiliar host is retried at most this often. */
const NONE_RECHECK_MS = 60 * 60_000;

/**
 * Fills in or refreshes the stored forge for a row with a known host; everything
 * else passes through untouched.
 *
 * - A legacy row (null) is detected once and persisted.
 * - A `'none'` row is re-detected at most once an hour per repo per process, so
 *   logging into `glab`/`gt`/`gh` after registering a custom-domain host is picked up
 *   without re-adding the repo. Hosts with a name shortcut in `detectForge` are
 *   never `'none'`, so only truly unknown hosts spawn (cheap, short-timeout)
 *   auth probes. The result is persisted only when it changed.
 */
async function withForge(db: Db, row: Repo): Promise<Repo> {
  if (row.remoteHost === null) return row;
  const recheckNone =
    row.forge === 'none' && Date.now() - (noneRechecks.get(row.id) ?? 0) >= NONE_RECHECK_MS;
  if (row.forge !== null && !recheckNone) return row;
  const pending = forgeBackfills.get(row.id);
  if (pending !== undefined) return pending;
  const host = row.remoteHost;
  const task = (async () => {
    if (recheckNone) noneRechecks.set(row.id, Date.now());
    const forge = await detectForge(host, row.rootPath);
    if (forge === row.forge) return row;
    await db.update(repo).set({ forge }).where(eq(repo.id, row.id));
    return { ...row, forge };
  })().finally(() => forgeBackfills.delete(row.id));
  forgeBackfills.set(row.id, task);
  return task;
}

export async function listRepos(db: Db): Promise<Repo[]> {
  const rows = await db.select().from(repo);
  return Promise.all(rows.map((row) => withForge(db, toRepo(row))));
}

export async function getRepoById(db: Db, id: string): Promise<Repo | null> {
  const rows = await db.select().from(repo).where(eq(repo.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? null : withForge(db, toRepo(row));
}

export async function getRepoByPath(db: Db, rootPath: string): Promise<Repo | null> {
  const rows = await db.select().from(repo).where(eq(repo.rootPath, rootPath)).limit(1);
  const row = rows[0];
  return row === undefined ? null : withForge(db, toRepo(row));
}

/** The remote's default branch moved (renamed `master` → `main`, ...): branch-only reviews diff against the new one. */
export async function setDefaultBranch(db: Db, id: string, defaultBranch: string): Promise<void> {
  await db.update(repo).set({ defaultBranch }).where(eq(repo.id, id));
}

/** Delete a repo row; its reviews and agent worktree rows cascade. Disk and git cleanup is the caller's. */
export async function deleteRepo(db: Db, id: string): Promise<void> {
  await db.delete(repo).where(eq(repo.id, id));
}
