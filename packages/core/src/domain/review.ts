import { z } from 'zod';
import { revisionSchema } from './files.ts';

export const forgeKindSchema = z.enum(['github', 'gitlab', 'gitea', 'none']);
export type ForgeKind = z.infer<typeof forgeKindSchema>;

/**
 * Why a forge couldn't be asked: its CLI isn't installed, has no local login
 * for the host, is logged in but the host can't be reached (VPN, DNS,
 * timeout), or the repo's remote isn't a supported host at all.
 */
export const forgeUnavailableReasonSchema = z.enum([
  'missing-cli',
  'not-authenticated',
  'unreachable',
  'unsupported-host',
]);
export type ForgeUnavailableReason = z.infer<typeof forgeUnavailableReasonSchema>;

export const repoSchema = z.object({
  id: z.string(),
  rootPath: z.string(),
  remoteHost: z.string().nullable(),
  /** Detected at registration (or lazily for older rows); null means undetected, so callers fall back to the host name. */
  forge: forgeKindSchema.nullable(),
  remoteOwner: z.string().nullable(),
  remoteName: z.string().nullable(),
  defaultBranch: z.string(),
  createdAt: z.number().int(),
});
export type Repo = z.infer<typeof repoSchema>;

/**
 * `draft`: opened from the UI to look at, not yet claimed as a review —
 * Homebase ignores it until "Start review" moves it to `open`. The CLI and
 * agents create reviews as `open` directly.
 */
export const reviewStatusSchema = z.enum(['draft', 'open', 'orphaned', 'archived']);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const reviewSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  /** Null until a detached `(repo, sha)` review adopts a branch. */
  branch: z.string().nullable(),
  pinnedSha: z.string().nullable(),
  baseRef: z.string(),
  prNumber: z.number().int().positive().nullable(),
  /** Null means no explicit choice yet, so the default applies (working when attached, else head). */
  currentRevision: revisionSchema.nullable(),
  lastSeenPrSha: z.string().nullable(),
  status: reviewStatusSchema,
  createdAt: z.number().int(),
});
export type Review = z.infer<typeof reviewSchema>;

/** CI roll-up for a PR head, derived server-side from `gh`'s `statusCheckRollup`. */
export const ciStatusSchema = z.enum(['passing', 'failing', 'pending']);
export type CiStatus = z.infer<typeof ciStatusSchema>;

/**
 * Homebase row roll-up: what a dashboard shows for a hundred reviews
 * without waking a hundred engines. DB aggregates plus one cached
 * `git diff base...head` per review and the PR row from the `gh` cache.
 * Ships alongside `Review` in `GET /api/reviews` rather than inside it,
 * since it's derived state, not the row's identity.
 */
export const reviewSummarySchema = z.object({
  reviewId: z.string(),
  openThreads: z.number().int().nonnegative(),
  resolvedThreads: z.number().int().nonnegative(),
  /**
   * Files whose *current* blob is marked viewed. When `filesTotal` is null
   * (head unresolvable) this falls back to distinct viewed paths.
   */
  viewedFiles: z.number().int().nonnegative(),
  /** False until a reading order has been generated. */
  hasReadingOrder: z.boolean(),
  agentRunning: z.boolean(),
  /** Unix seconds of the newest thread, comment, viewed check, or reading order; null when untouched. */
  lastActivityAt: z.number().int().nullable(),

  /** PR title when a PR is known, else the branch name (the tip commit's subject for a detached review). */
  title: z.string().nullable(),
  /** PR author login when a PR is known, else the tip commit's author name. */
  authorName: z.string().nullable(),
  /** From `git diff -M base...head` for the review's `head`; null when head can't be resolved. */
  filesTotal: z.number().int().nonnegative().nullable(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  headSha: z.string().nullable(),
  /** Committer date of `head`, unix seconds. */
  headCommittedAt: z.number().int().nullable(),
  /** From the PR when one is known, and only while the PR's head is the review's head (CI ran on what's shown). */
  ci: ciStatusSchema.nullable(),
  draft: z.boolean(),
  /** Agent comments created after the review was last opened (never opened → all of them). */
  unreadAgentReplies: z.number().int().nonnegative(),
  /** Homebase files it under "done" (Cleared): its PR is merged or closed, or every file is viewed at its current blob with no open threads. */
  done: z.boolean(),
});
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

/** `GET /api/me`: who the local user is, from `git config user.name` and `gh api user`. */
export const meSchema = z.object({
  name: z.string().nullable(),
  login: z.string().nullable(),
});
export type Me = z.infer<typeof meSchema>;

// --- branch and PR discovery ("open any branch or PR") ---

export const branchSchema = z.object({
  /** Short name, e.g. "feat/x" — no `refs/heads/` or `origin/` prefix. */
  name: z.string(),
  hasLocalRef: z.boolean(),
  hasRemoteRef: z.boolean(),
  tipSha: z.string(),
  /** Committer date, unix seconds, of whichever ref (local/remote) is newer. */
  committerDate: z.number().int(),
  subject: z.string().nullable(),
  authorName: z.string().nullable(),
  /** An existing review at `(repo, name)`, so the UI can land on it instead of creating a second one. */
  reviewId: z.string().nullable(),
  /** That review's status; null when `reviewId` is null. */
  reviewStatus: reviewStatusSchema.nullable(),
  /** Commits ahead of / behind the repo's default branch; null when git can't say (older git, no default ref). */
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
});
export type Branch = z.infer<typeof branchSchema>;

export const branchSortSchema = z.enum(['recent', 'name', 'ahead', 'behind']);
export type BranchSort = z.infer<typeof branchSortSchema>;

type SortableBranch = Pick<Branch, 'name' | 'committerDate' | 'ahead' | 'behind'>;

/** Newest first, then by name, so equal keys keep a stable order. */
function byRecent(a: SortableBranch, b: SortableBranch): number {
  return b.committerDate - a.committerDate || a.name.localeCompare(b.name);
}

/** Descending by a count; unknown counts (older git) sort last. */
function byCount(key: 'ahead' | 'behind'): (a: SortableBranch, b: SortableBranch) => number {
  return (a, b) => (b[key] ?? -1) - (a[key] ?? -1) || byRecent(a, b);
}

const BRANCH_COMPARE: Record<BranchSort, (a: SortableBranch, b: SortableBranch) => number> = {
  recent: byRecent,
  name: (a, b) => a.name.localeCompare(b.name),
  ahead: byCount('ahead'),
  behind: byCount('behind'),
};

/** The branch list's order for a sort, shared by the server (per repo) and Explore (merging repos). */
export function compareBranches(sort: BranchSort): (a: SortableBranch, b: SortableBranch) => number {
  return BRANCH_COMPARE[sort];
}

export const pullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  authorLogin: z.string().nullable(),
  /** ISO 8601, as `gh` reports it. */
  updatedAt: z.string(),
  /** The same instant as unix seconds, for sorting and relative times. */
  updatedAtUnix: z.number().int(),
  isDraft: z.boolean(),
  /** Null when `gh` didn't report them. */
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  changedFiles: z.number().int().nonnegative().nullable(),
  /** Roll-up of `statusCheckRollup`; null when the PR has no checks. */
  ci: ciStatusSchema.nullable(),
  /** The PR's head commit as the forge reports it (what `ci` ran on); null when not reported. */
  headSha: z.string().nullable(),
  /** True when the local `gh` login is a requested reviewer (or, login unknown, when anyone is). */
  reviewRequested: z.boolean(),
  /** An existing review at `(repo, headRefName)`; filled by the server from the DB. */
  reviewId: z.string().nullable(),
  /** That review's status; null when `reviewId` is null. */
  reviewStatus: reviewStatusSchema.nullable(),
});
export type Pull = z.infer<typeof pullSchema>;

export const pullStateSchema = z.enum(['open', 'draft', 'merged', 'closed']);
export type PullState = z.infer<typeof pullStateSchema>;

/** One hit of a cross-repo PR search: any state, so no head/base (`createReview` resolves them from the number). */
export const pullSearchResultSchema = z.object({
  repoId: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  state: pullStateSchema,
  authorLogin: z.string().nullable(),
  /** ISO 8601, as `gh` reports it. */
  updatedAt: z.string(),
  updatedAtUnix: z.number().int(),
});
export type PullSearchResult = z.infer<typeof pullSearchResultSchema>;

/** One PR in full, for the review's summary card: what `gh pr view` adds to a `Pull`. */
export const pullDetailSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  /** The PR description, markdown; empty when there is none. */
  body: z.string(),
  state: pullStateSchema,
  authorLogin: z.string().nullable(),
  baseRefName: z.string(),
  /** Roll-up of `statusCheckRollup`; null when the PR has no checks. */
  ci: ciStatusSchema.nullable(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  changedFiles: z.number().int().nonnegative().nullable(),
  /** The PR's page on the forge; null when the forge didn't report one. */
  url: z.string().nullable(),
});
export type PullDetail = z.infer<typeof pullDetailSchema>;

// --- reading order ---

export const stepFileSchema = z.object({
  path: z.string(),
  note: z.string().nullable(),
});
export type StepFile = z.infer<typeof stepFileSchema>;

export const stepAttentionSchema = z.enum(['focus', 'skim']);
export type StepAttention = z.infer<typeof stepAttentionSchema>;

export const stepSchema = z.object({
  id: z.string(),
  idx: z.number().int().nonnegative(),
  title: z.string(),
  guidance: z.string(),
  attention: stepAttentionSchema.nullable(),
  files: z.array(stepFileSchema),
});
export type Step = z.infer<typeof stepSchema>;

export const readingOrderSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  agentRunId: z.string().nullable(),
  createdAt: z.number().int(),
  steps: z.array(stepSchema),
  /**
   * Files present in the review but belonging to no step — they appeared after
   * the order was generated. Surfaced as a bucket with an offer to regenerate,
   * never silently folded in.
   */
  unassignedPaths: z.array(z.string()),
});
export type ReadingOrder = z.infer<typeof readingOrderSchema>;

/**
 * How to write a reading order. The prompt for the embedded agent includes
 * this verbatim, and `joinery reading-order rules` prints it for external agents.
 */
export const READING_ORDER_RULES = [
  "A guided path through the change for a reviewer switching into it, who may not know this part of the codebase. It explains; it does not evaluate. The reviewer forms their own opinion, so never tell them what to check, verify or watch out for, and never judge whether the code is correct. Steps render top to bottom and files within a step render in listed order; that order is the reading order.",
  '',
  '- Steps: 1 for a trivial change, usually 2 to 6, at most 8. Group by what the files do for the change, one behaviour per step, not by directory or layer: a type and its users, a feature and its wiring. All the tests go together in one step. A mechanical sweep (a rename across many files, a lockfile, generated code) is one `skim` step however many files it touches. A one-file step is only for a file that is a part of the change on its own. A file changed for two reasons goes in the step for its main change, with a note on the other.',
  '- Order: open with the heart of the change, the `focus` step. Then the rest in build order so understanding accumulates: definitions and contracts before the code that uses them, callers after. Then mechanical `skim` steps, and the tests step last. Do not sort alphabetically. Typical shapes: for a feature, storage, entry point, logic, callers; for a refactor, the new abstraction first, then each call site.',
  '- Title: what the group of files does for the change, in sentence case and under 60 characters ("Read path, where parity breaks").',
  '- Guidance: markdown, 1 to 2 sentences on what this group of files does and how it fits the rest of the change. Give the context a newcomer needs: where something is called from, what an existing type or module is for, why the change touches this file. Name the concrete function, field, route, or number.',
  '- Attention: `focus` marks the heart of the change, the main change everything else exists to support: usually one step, at most two. `skim` marks mechanical changes (renames, wiring, generated code, lockfiles, tests that mirror code). Null is a normal read.',
  '- File note: optional one-sentence markdown note on a file, with context the guidance does not cover; null when the guidance already covers it.',
].join('\n');

/** The shape an agent writes via `joinery reading-order set --file plan.json`. Writing rules: `READING_ORDER_RULES`. */
export const readingOrderPlanSchema = z.object({
  steps: z
    .array(
      z.object({
        title: z.string().min(1),
        guidance: z.string().default(''),
        attention: stepAttentionSchema.nullable().default(null),
        files: z
          .array(
            z.object({
              path: z.string().min(1).describe('Exactly as given in the changed-file list.'),
              note: z.string().nullable().default(null),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});
export type ReadingOrderPlan = z.infer<typeof readingOrderPlanSchema>;

// --- threads ---

export const threadSideSchema = z.enum(['old', 'new']);
export type ThreadSide = z.infer<typeof threadSideSchema>;

/**
 * Six fixed kinds, set by the user (UI), the embedded agent (tool), or an
 * external agent (CLI). Display glyphs and titles live in the web
 * (`lib/reactions.ts`) — the contract only names the kinds.
 */
export const reactionKindSchema = z.enum([
  'thumbs_up',
  'thumbs_down',
  'eyes',
  'check',
  'question',
  'tada',
]);
export type ReactionKind = z.infer<typeof reactionKindSchema>;

/** One kind on one comment, with everyone who set it (`user` first). */
export const reactionSchema = z.object({
  kind: reactionKindSchema,
  actors: z.array(z.enum(['user', 'agent'])),
});
export type Reaction = z.infer<typeof reactionSchema>;

export const commentSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  author: z.enum(['user', 'agent']),
  body: z.string(),
  agentRunId: z.string().nullable(),
  createdAt: z.number().int(),
  /** Empty when the comment has no reactions. */
  reactions: z.array(reactionSchema),
});
export type Comment = z.infer<typeof commentSchema>;

export const threadSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  path: z.string(),
  side: threadSideSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  anchorBlobSha: z.string(),
  anchorContextHash: z.string(),
  anchorContext: z.string(),
  status: z.enum(['open', 'resolved']),
  outdated: z.boolean(),
  changedSinceComment: z.boolean(),
  createdAt: z.number().int(),
  comments: z.array(commentSchema),
});
export type Thread = z.infer<typeof threadSchema>;

// --- agent runs ---

export const runKindSchema = z.enum(['reading_order', 'thread_reply']);
export type RunKind = z.infer<typeof runKindSchema>;

export const runStatusSchema = z.enum(['pending', 'running', 'done', 'error', 'cancelled']);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const agentRunSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  threadId: z.string().nullable(),
  kind: runKindSchema,
  status: runStatusSchema,
  sessionId: z.string().nullable(),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;
