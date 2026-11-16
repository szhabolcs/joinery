/** Which forge an origin host is, decided once at registration and stored on the repo. */
import { localToken } from './cli.ts';
import type { ForgeKind } from '@joinery/core';

/** Hosts known to be Gitea (or API-compatible Forgejo) by name alone: `gitea.com`, `codeberg.org`, or "gitea"/"forgejo" in the name. */
export function isGiteaHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'codeberg.org' || h.includes('gitea') || h.includes('forgejo');
}

/**
 * `github.com` is GitHub; `gitlab.com` and any host with "gitlab" in its name
 * is GitLab; `isGiteaHost` is Gitea. Any other host (self-hosted GitHub
 * Enterprise, a custom GitLab or Gitea domain) is decided from local CLI login
 * state, never the network (the host may be behind a VPN that's off): a `glab`
 * token for the host means GitLab, else a `gt` account means Gitea, else a
 * `gh` token means GitHub, else `'none'`. Never throws; a missing CLI just
 * has no login.
 */
export async function detectForge(host: string, cwd: string): Promise<ForgeKind> {
  const h = host.toLowerCase();
  if (h === 'github.com') return 'github';
  if (h === 'gitlab.com' || h.includes('gitlab')) return 'gitlab';
  if (isGiteaHost(h)) return 'gitea';
  if (await localToken('glab', h, cwd)) return 'gitlab';
  if (await localToken('gt', h, cwd)) return 'gitea';
  if (await localToken('gh', h, cwd)) return 'github';
  return 'none';
}
