/**
 * The "Custom" order of Homebase's Currently reviewing list: review ids,
 * top first, kept in `app_setting` so the web app and the CLI share it.
 *
 * - Only placed reviews are listed. One not in the list (just picked up)
 *   shows on top; one that leaves the list for a while (cleared, or its PR
 *   in a stack that regrouped) keeps its place for when it comes back.
 * - A stack's reviews show together where the first of them is placed.
 * - Archived and deleted reviews are dropped whenever the order is read, so
 *   the list never collects ids nothing can show again.
 */
import { getAppSetting, listReviews, putAppSetting, type Db } from './db/index.ts';

const KEY = 'home.review-order';

/** The saved order, minus reviews that are archived or gone (and saved back without them). */
export async function getReviewOrder(db: Db): Promise<string[]> {
  const stored = await getAppSetting(db, KEY);
  const ids = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
  const kept = await keepLive(db, ids);
  if (kept.length !== ids.length) await putAppSetting(db, KEY, kept);
  return kept;
}

/** Replace the order. Unknown, archived and repeated ids are dropped. */
export async function setReviewOrder(db: Db, ids: readonly string[]): Promise<string[]> {
  const kept = await keepLive(db, [...new Set(ids)]);
  await putAppSetting(db, KEY, kept);
  return kept;
}

/**
 * Put `ids` first, in the given order, ahead of everything else in the
 * saved order (whose relative order is kept): what `joinery reviews order
 * set` does with a partial list.
 */
export async function placeReviewsFirst(db: Db, ids: readonly string[]): Promise<string[]> {
  const current = await getReviewOrder(db);
  const first = new Set(ids);
  return setReviewOrder(db, [...ids, ...current.filter((id) => !first.has(id))]);
}

async function keepLive(db: Db, ids: readonly string[]): Promise<string[]> {
  const live = new Set((await listReviews(db)).filter((r) => r.status !== 'archived').map((r) => r.id));
  return ids.filter((id) => live.has(id));
}
