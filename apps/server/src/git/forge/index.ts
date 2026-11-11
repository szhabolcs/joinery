/** Public surface of the forge layer: the `Forge` seam and the per-repo picker. */
import type { ForgeKind, Repo } from '@joinery/core';
import { isGiteaHost } from './detect.ts';
import { giteaForge } from './gitea.ts';
import { githubForge } from './github.ts';
import { gitlabForge } from './gitlab.ts';
import { noForge } from './none.ts';
import type { Forge } from './types.ts';

const FORGES: Record<ForgeKind, Forge> = { github: githubForge, gitlab: gitlabForge, gitea: giteaForge, none: noForge };

export { detectForge, isGiteaHost } from './detect.ts';
export type {
  Forge,
  ForgeOptions,
  ListOpenPullsResult,
  MergedPrCommits,
  PullSearchHit,
  PullSummary,
  ResolvedPr,
  SearchPullsResult,
} from './types.ts';

/**
 * The forge for `repo`: its stored `forge` (detected at registration) when
 * set, else the origin host's name — `github.com` is GitHub; `gitlab.com` and
 * any host with "gitlab" in its name is GitLab; `gitea.com`, `codeberg.org` and
 * any host with "gitea" or "forgejo" in its name is Gitea; any other host is the
 * unsupported forge. A row from before hosts were stored (`remoteHost` null)
 * with an owner/name is treated as GitHub. No remote at all, or no repo
 * (`undefined`), is the unsupported forge too.
 */
export function forgeFor(
  repo: Pick<Repo, 'forge' | 'remoteHost' | 'remoteOwner' | 'remoteName'> | undefined,
): Forge {
  if (repo === undefined || repo.remoteOwner === null || repo.remoteName === null) return noForge;
  if (repo.forge !== null) return FORGES[repo.forge];
  if (repo.remoteHost === null || repo.remoteHost === 'github.com') return githubForge;
  if (repo.remoteHost.includes('gitlab')) return gitlabForge;
  return isGiteaHost(repo.remoteHost) ? giteaForge : noForge;
}
