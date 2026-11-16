import type { Repo } from '@joinery/core';

/**
 * A PR's page on the forge, from the repo's parsed remote. GitLab repos (the
 * stored forge, else a host with "gitlab" in it) get merge-request paths and
 * Gitea repos `/pulls/`; anything else is treated as GitHub. Null when the
 * repo has no recognised remote.
 */
export function pullUrl(repo: Repo, number: number): string | null {
  const { remoteHost: host, remoteOwner: owner, remoteName: name } = repo;
  if (host === null || owner === null || name === null) return null;
  const base = `https://${host}/${owner}/${name}`;
  if (repo.forge === 'gitea') return `${base}/pulls/${String(number)}`;
  const gitlab = repo.forge === null ? host.includes('gitlab') : repo.forge === 'gitlab';
  return gitlab ? `${base}/-/merge_requests/${String(number)}` : `${base}/pull/${String(number)}`;
}
