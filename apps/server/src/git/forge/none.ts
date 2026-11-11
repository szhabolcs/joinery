/** The `Forge` for a remote Joinery has no host integration for (or no remote): everything is unavailable. */
import type { Forge } from './types.ts';

export const noForge: Forge = {
  kind: 'none',
  cli: 'forge CLI',
  setupHint: "This repo's origin is not on a supported host (GitHub, GitLab or Gitea).",
  pullHeadRef: () => null,
  currentLogin: async () => null,
  findOpenPrNumberForBranch: async () => null,
  listOpenPulls: async () => ({ available: false, pulls: [], unavailableReason: 'unsupported-host' }),
  searchPulls: async () => ({ available: false, pulls: [], unavailableReason: 'unsupported-host' }),
  resolvePr: async () => null,
  viewMergedPrCommits: async () => null,
  viewPull: async () => null,
};
