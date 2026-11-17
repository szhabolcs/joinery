/**
 * Homebase's view of GitHub stacked PRs: which stack (if any) a PR is in,
 * and folding a sorted list into units where a stack's members sit
 * together, bottom of the stack first (the order to review them in).
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
 * came first and are ordered bottom to top; a stack with only one member in
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
    unit.items.sort((a, b) => (slotOf(a)?.position ?? 0) - (slotOf(b)?.position ?? 0));
  }
  return units;
}

/**
 * `units` in the reader's own order: keys they placed keep their places;
 * anything new (a review picked up since) goes on top, in the list's sort
 * order, where it's noticed.
 */
export function applyCustomOrder<T>(units: readonly ListUnit<T>[], order: readonly string[]): ListUnit<T>[] {
  const rank = new Map(order.map((key, i) => [key, i] as const));
  const fresh = units.filter((u) => !rank.has(u.key));
  const placed = units.filter((u) => rank.has(u.key)).sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
  return [...fresh, ...placed];
}

/** `keys` with `moved` taken out and put back at `to` (an index into the list without it). */
export function moveKey(keys: readonly string[], moved: string, to: number): string[] {
  const rest = keys.filter((k) => k !== moved);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}
