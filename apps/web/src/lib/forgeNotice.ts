import type { ForgeKind, ForgeUnavailableReason } from '@joinery/core';

/** The host CLI each forge is asked through. */
export const FORGE_CLI = { github: 'gh', gitlab: 'glab', gitea: 'gt' } as const;

/** Why a repo's forge couldn't be asked, with the host and (when known) the forge it refers to. */
export type ForgeNotice = { reason: ForgeUnavailableReason; host: string | null; forge: ForgeKind | null };

/**
 * The one-line note for a forge that couldn't be asked: `list` for the open
 * pull list, `search` for the Explore search. `null` when the reason doesn't
 * call for a specific note (unsupported host, or none), so the caller keeps
 * its generic message.
 */
export function forgeNoticeText(notice: ForgeNotice | null | undefined, task: 'list' | 'search'): string | null {
  if (notice === null || notice === undefined) return null;
  const cli = notice.forge === null || notice.forge === 'none' ? null : FORGE_CLI[notice.forge];
  const noun = notice.forge === 'gitlab' ? 'merge requests' : 'pull requests';
  const what = task === 'search' ? `search ${noun}` : `see open ${noun}`;
  switch (notice.reason) {
    case 'unreachable':
      return `Can't reach ${notice.host ?? 'the git host'}`;
    case 'not-authenticated':
      return `Sign in to ${cli ?? 'gh, glab or gt'} to ${what}`;
    case 'missing-cli':
      return `Install ${cli ?? 'gh, glab or gt'} to ${what}`;
    case 'unsupported-host':
      return null;
  }
}

/** The first note among `notices` that has specific text, else `null`. */
export function firstForgeNotice(
  notices: readonly (ForgeNotice | null | undefined)[],
  task: 'list' | 'search',
): string | null {
  for (const n of notices) {
    const text = forgeNoticeText(n, task);
    if (text !== null) return text;
  }
  return null;
}

/** Every distinct specific note among `notices`, at most two, joined for one muted line; `null` when none. */
export function forgeNoticeLine(
  notices: readonly (ForgeNotice | null | undefined)[],
  task: 'list' | 'search',
): string | null {
  const texts = new Set<string>();
  for (const n of notices) {
    const text = forgeNoticeText(n, task);
    if (text !== null) texts.add(text);
  }
  return texts.size === 0 ? null : [...texts].slice(0, 2).join(' · ');
}
