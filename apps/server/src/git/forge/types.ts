/**
 * The seam between Joinery and a code host: everything that talks to
 * GitHub, GitLab or Gitea lives behind `Forge`. Every method follows one
 * rule: a missing or unauthenticated host CLI is data ("unavailable", `null`),
 * never a thrown error — callers never wrap these in a try/catch to stay up.
 * Pick an implementation with `forgeFor(repo)`.
 */
import type { ForgeUnavailableReason, Pull, PullDetail, PullState } from '@joinery/core';

export type ForgeOptions = { cwd: string };

/** Matches `Pull` from `@joinery/core` exactly; `reviewId` is always `null` here — the route fills it from the DB. */
export type PullSummary = Pull;

export type ListOpenPullsResult = {
  /**
   * Whether the forge could be asked at all — `false` means "not installed",
   * "not authenticated" or "unsupported remote", which the UI renders as a
   * one-line note, distinct from `true` with an empty `pulls` array ("asked,
   * there just aren't any open PRs").
   */
  available: boolean;
  pulls: PullSummary[];
  /** Why `available` is false, when known; the UI picks its note from it. */
  unavailableReason?: ForgeUnavailableReason;
  /** The origin host `unavailableReason` refers to. */
  unavailableHost?: string | null;
};

/** What `searchPulls` returns: `ListOpenPullsResult`'s availability fields around search hits. */
export type SearchPullsResult = Omit<ListOpenPullsResult, 'pulls'> & { pulls: PullSearchHit[] };

export type ResolvedPr = {
  headRefName: string;
  baseRefName: string;
};

export type MergedPrCommits = { mergeCommit: string; headRefOid: string };

/** One pull hit from `searchPulls`, before the route maps `slug` back to a Joinery repo. */
export type PullSearchHit = {
  /** `owner/name`, lowercased. */
  slug: string;
  number: number;
  title: string;
  state: PullState;
  authorLogin: string | null;
  updatedAt: string;
  updatedAtUnix: number;
};

export interface Forge {
  /** `'none'`: the repo's remote isn't a supported host; every call reports unavailable. */
  readonly kind: 'github' | 'gitlab' | 'gitea' | 'none';
  /** The host CLI the user needs, for error messages. */
  readonly cli: string;
  /** What to tell the user when a pull can't be resolved. */
  readonly setupHint: string;

  /** Where a fetch finds pull `prNumber`'s head (a refspec source), or `null` if the host has none. */
  pullHeadRef(prNumber: number): string | null;
  /** The authenticated user's login, or `null` if unknown. */
  currentLogin(cwd: string): Promise<string | null>;

  /** The open pull for `branch`, or `null` — only open ones, so a reused branch name never binds an old pull. */
  findOpenPrNumberForBranch(branch: string, options: ForgeOptions): Promise<number | null>;
  /** Open, same-repo pulls with CI and `reviewRequested` derived against `login`. */
  listOpenPulls(options: ForgeOptions & { login: string | null }): Promise<ListOpenPullsResult>;
  /** Pulls of any state across `repos` (`slug` = `owner/name`, `cwd` = a clone to run the CLI in). */
  searchPulls(
    query: string,
    repos: readonly { slug: string; cwd: string }[],
  ): Promise<SearchPullsResult>;
  /** A pull number's real head/base branch names. */
  resolvePr(prNumber: number, options: ForgeOptions): Promise<ResolvedPr | null>;
  /** Merge commit and head of a *merged* pull; `null` if not merged or on any failure. */
  viewMergedPrCommits(prNumber: number, options: ForgeOptions): Promise<MergedPrCommits | null>;
  /** One pull in full (description, state, CI, size), any state. */
  viewPull(prNumber: number, options: ForgeOptions): Promise<PullDetail | null>;
}
