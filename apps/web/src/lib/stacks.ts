/**
 * Homebase's view of GitHub stacked PRs: which stack (if any) a PR is in,
 * and folding a sorted list into units where a stack's members sit
 * together, top of the stack first (as GitHub draws it).
 *
 * A unit takes the place of its first member in the sorted list, so a stack
 * moves up or down with its lightest (or most recent) PR, and the list's
 * order still reads the way its sort says.
 */
import type { PullStack } from '@joinery/core';

/** Where a PR sits in its stack, 1-based from the bottom. */
export interface StackSlot {
  stack: PullStack;
  repoId: string;
  position: number;
  size: number;
}

export type StackIndex = ReadonlyMap<string, StackSlot>;

const slotKey = (repoId: string, prNumber: number): string => `${repoId}:${String(prNumber)}`;

export function indexStacks(stacksByRepo: ReadonlyMap<string, readonly PullStack[]>): StackIndex {
  const index = new Map<string, StackSlot>();
  for (const [repoId, stacks] of stacksByRepo) {
    for (const stack of stacks) {
      stack.pulls.forEach((member, i) => {
        index.set(slotKey(repoId, member.number), { stack, repoId, position: i + 1, size: stack.pulls.length });
      });
    }
  }
  return index;
}

export function stackSlotOf(index: StackIndex, repoId: string, prNumber: number | null): StackSlot | null {
  return prNumber === null ? null : (index.get(slotKey(repoId, prNumber)) ?? null);
}

/** One row of a list: a lone item, or two or more members of one stack. */
export interface ListUnit<T> {
  /** Stable across sorts: `stack:<repo>:<number>` for a stack, else the item's own key. */
  key: string;
  /** Set when the unit groups a stack's members. */
  stack: StackSlot | null;
  items: T[];
}

/**
 * Fold `sorted` into units. Members of one stack join the unit of whichever
 * came first and are ordered top to bottom; a stack with only one member in
 * the list stays a lone item (its card still says where it sits).
 */
export function groupByStack<T>(
  sorted: readonly T[],
  slotOf: (item: T) => StackSlot | null,
  keyOf: (item: T) => string,
): ListUnit<T>[] {
  const counts = new Map<string, number>();
  const stackKey = (slot: StackSlot) => `stack:${slot.repoId}:${String(slot.stack.number)}`;
  for (const item of sorted) {
    const slot = slotOf(item);
    if (slot !== null) counts.set(stackKey(slot), (counts.get(stackKey(slot)) ?? 0) + 1);
  }

  const units: ListUnit<T>[] = [];
  const byStack = new Map<string, ListUnit<T>>();
  for (const item of sorted) {
    const slot = slotOf(item);
    const key = slot === null ? null : stackKey(slot);
    if (slot === null || key === null || (counts.get(key) ?? 0) < 2) {
      units.push({ key: keyOf(item), stack: null, items: [item] });
      continue;
    }
    const existing = byStack.get(key);
    if (existing !== undefined) {
      existing.items.push(item);
      continue;
    }
    const unit: ListUnit<T> = { key, stack: slot, items: [item] };
    byStack.set(key, unit);
    units.push(unit);
  }
  for (const unit of byStack.values()) {
    // Top of the stack first, as GitHub draws it.
    unit.items.sort((a, b) => (slotOf(b)?.position ?? 0) - (slotOf(a)?.position ?? 0));
  }
  return units;
}

/**
 * `units` in the reader's own order. `order` is review ids, top first; a
 * unit sits where its highest-placed review is, so a stack that forms
 * takes the place its first member already had. Units with no placed
 * review (one just picked up) go on top, in the list's sort order.
 */
export function applyCustomOrder<T>(
  units: readonly ListUnit<T>[],
  order: readonly string[],
  idOf: (item: T) => string,
): ListUnit<T>[] {
  const rank = new Map(order.map((id, i) => [id, i] as const));
  const rankOf = (unit: ListUnit<T>): number =>
    Math.min(...unit.items.map((item) => rank.get(idOf(item)) ?? Number.POSITIVE_INFINITY));
  const fresh = units.filter((u) => rankOf(u) === Number.POSITIVE_INFINITY);
  const placed = units.filter((u) => rankOf(u) !== Number.POSITIVE_INFINITY).sort((a, b) => rankOf(a) - rankOf(b));
  return [...fresh, ...placed];
}

/**
 * The saved order after dropping the unit `moved` before or after `target`
 * (both in `shown`, the units as displayed). Only the moved reviews change
 * places: reviews not on screen right now keep theirs, so one that comes
 * back later lands where it was. Unplaced units on screen (shown on top)
 * are placed where they are first, so nothing jumps.
 */
export function moveInOrder<T>(
  shown: readonly ListUnit<T>[],
  order: readonly string[],
  idOf: (item: T) => string,
  moved: string,
  target: string,
  side: 'before' | 'after',
): string[] {
  const placed = new Set(order);
  const idsOf = (key: string): string[] => shown.find((u) => u.key === key)?.items.map(idOf) ?? [];
  const unplaced = shown.flatMap((u) => u.items.map(idOf)).filter((id) => !placed.has(id));
  const movedIds = new Set(idsOf(moved));
  const base = [...unplaced, ...order].filter((id) => !movedIds.has(id));
  // The target shows where its first placed review is; anchor there, and
  // for "after" skip only the target's own reviews that follow it directly.
  const targetIds = new Set(idsOf(target));
  let index = base.findIndex((id) => targetIds.has(id));
  if (index === -1) return [...base, ...movedIds];
  if (side === 'after') {
    while (index < base.length && targetIds.has(base[index] ?? '')) index++;
  }
  return [...base.slice(0, index), ...movedIds, ...base.slice(index)];
}
