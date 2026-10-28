/**
 * The HTTP contract, imported by the server, the web app, and the CLI.
 *
 * Each entry carries its method, a path builder, and zod schemas for body and
 * response — so renaming a route or changing a payload is a compile error in
 * three packages rather than a runtime 404.
 */
import { z } from 'zod';
import {
  blobQuerySchema,
  fileContentsSchema,
  filePatchSchema,
} from './domain/diff.ts';
import { fileListSchema, revisionSchema, reviewStateSchema } from './domain/files.ts';
import {
  installableServerSchema,
  lspChoiceSchema,
  lspDefinitionSchema,
  lspFileQuerySchema,
  lspFileSchema,
  lspHighlightSchema,
  lspHoverSchema,
  lspLanguageSchema,
  lspPositionQuerySchema,
  lspReferencesSchema,
  lspServerIdSchema,
} from './domain/lsp.ts';
import {
  agentRunSchema,
  branchSchema,
  branchSortSchema,
  forgeUnavailableReasonSchema,
  meSchema,
  pullDetailSchema,
  pullSchema,
  pullSearchResultSchema,
  readingOrderPlanSchema,
  readingOrderSchema,
  reactionKindSchema,
  repoSchema,
  reviewSchema,
  reviewStatusSchema,
  reviewSummarySchema,
  threadSchema,
} from './domain/review.ts';

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.enum([
      'not_found',
      'bad_request',
      'conflict',
      'unauthorized',
      'git_error',
      'internal',
    ]),
    message: z.string(),
    /** Actionable next step, e.g. the exact `git worktree repair` command. */
    hint: z.string().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

// --- request bodies ---

export const addRepoBodySchema = z.object({ path: z.string().min(1) });
/**
 * A branch, base, or sha handed to git/`gh` as a bare argument. Git refnames
 * can't start with `-`, so one that does is only ever an option smuggled in
 * (e.g. a "branch" of `--output=...`).
 */
const gitRevSchema = z
  .string()
  .min(1)
  .refine((s) => !s.startsWith('-'), { message: 'must not start with "-"' });
export const createReviewBodySchema = z.object({
  repoId: z.string().optional(),
  repoPath: z.string().optional(),
  branch: gitRevSchema.optional(),
  sha: gitRevSchema.optional(),
  base: gitRevSchema.optional(),
  prNumber: z.number().int().positive().optional(),
  /**
   * Status for a review this call creates. An existing review at the same
   * identity is returned as-is, whatever its status. The web UI opens as
   * `draft` (look first, "Start review" later); the CLI defaults to `open`.
   */
  status: z.enum(['draft', 'open']).default('open'),
});
export const setRevisionBodySchema = z.object({ revision: revisionSchema });
export const markViewedBodySchema = z.object({
  path: z.string().min(1),
  /** Omitted means "the current blob for that path". */
  blobSha: z.string().optional(),
  viewed: z.boolean().default(true),
});
export const setAllViewedBodySchema = z.object({ viewed: z.boolean().default(true) });
export const resolveAllThreadsBodySchema = z.object({ resolved: z.boolean().default(true) });
/** The models a thread reply can run on, in picker order. Ids are exact; never add a date suffix. */
export const AGENT_MODELS = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
] as const;
export const agentModelSchema = z.enum(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
export type AgentModel = z.infer<typeof agentModelSchema>;
export const DEFAULT_AGENT_MODEL: AgentModel = 'claude-haiku-5-5';

export const createThreadBodySchema = z.object({
  path: z.string().min(1),
  side: z.enum(['old', 'new']),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  body: z.string().min(1),
  author: z.enum(['user', 'agent']).default('user'),
  /** Post the comment, then immediately ask an agent to reply (Cmd+Enter). */
  askAgent: z.boolean().default(false),
  /** The model for that reply; the server default when absent. */
  model: agentModelSchema.optional(),
});
export const replyBodySchema = z.object({
  body: z.string().min(1),
  author: z.enum(['user', 'agent']).default('user'),
  agentRunId: z.string().optional(),
  askAgent: z.boolean().default(false),
  model: agentModelSchema.optional(),
});
export const generateReadingOrderBodySchema = z.object({ model: agentModelSchema.optional() });
export const askAgentBodySchema = z.object({ model: agentModelSchema.optional() });
export const setReactionBodySchema = z.object({
  kind: reactionKindSchema,
  actor: z.enum(['user', 'agent']).default('user'),
  /** False removes the reaction. */
  on: z.boolean().default(true),
});
export const setReviewStatusBodySchema = z.object({ status: reviewStatusSchema });

// A monorepo can have thousands of remote branches — `filter` and `limit`
// keep the response bounded rather than dumping the whole ref namespace.
/**
 * Explore's branch filters. All are applied server-side before `limit`, so
 * they look through every branch, not just the most recent page.
 *
 * - `mine`: the tip commit's author is the repo's `git config user.name`.
 * - `unmerged`: has commits the default branch doesn't (the default branch
 *   itself always stays).
 * - `where`: `local` has a local branch; `origin` exists only on origin.
 * - `since`: committed within the last that many days.
 * - `review`: `unreviewed` has no review or only an unstarted draft;
 *   `reviewing` has one open (or orphaned).
 */
export const listBranchesQuerySchema = z.object({
  filter: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  sort: branchSortSchema.optional(),
  mine: z.enum(['true', 'false']).optional(),
  unmerged: z.enum(['true', 'false']).optional(),
  where: z.enum(['local', 'origin']).optional(),
  since: z.coerce.number().int().positive().optional(),
  review: z.enum(['unreviewed', 'reviewing']).optional(),
});
export const listDirsQuerySchema = z.object({
  /** Absolute (or `~`-prefixed) directory to list; defaults to the server user's home. */
  path: z.string().optional(),
  /** Include dot-directories. */
  hidden: z.enum(['1', 'true']).optional(),
});
export const dirEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isRepo: z.boolean(),
  /** For a linked git worktree: the name of the repo it belongs to. */
  worktreeOf: z.string().optional(),
  /** macOS (server host) asks the user before Joinery may open this folder. */
  macPrivacyPrompt: z.boolean().optional(),
});
export type DirEntry = z.infer<typeof dirEntrySchema>;
export const listReviewsQuerySchema = z.object({
  /** Omitted means every status — archived reviews included. */
  status: reviewStatusSchema.optional(),
  /** `'true'` bypasses the server's short-lived `gh` cache for PR titles, CI, and diff sizes. */
  refresh: z.enum(['true', 'false']).optional(),
});
export const versionQuerySchema = z.object({
  /** `'true'` forces a fresh GitHub release check instead of the 10-minute cache. */
  refresh: z.enum(['true', 'false']).optional(),
});
export const versionInfoSchema = z.object({
  current: z.string(),
  /** Newest published release, or null when it couldn't be determined. */
  latest: z.string().nullable(),
  updateAvailable: z.boolean(),
  mode: z.enum(['dev', 'installed']),
  /** An update has been started and the server is about to restart. */
  updating: z.boolean(),
});
export type VersionInfo = z.infer<typeof versionInfoSchema>;
/**
 * The settings page's health check. `git` is the `git` on PATH, which
 * everything needs. `claude` is the executable thread
 * replies run (`bundled` in a source checkout, where the Agent SDK uses its
 * own). `clis` says whether `gh`/`glab` are on PATH; `hosts` is one row per
 * forge host the registered repos point at, with why its CLI can't be asked
 * (`reason`), or null when it can.
 */
export const integrationsSchema = z.object({
  git: z.object({ path: z.string().nullable() }),
  claude: z.object({ path: z.string().nullable(), bundled: z.boolean() }),
  clis: z.array(z.object({ cli: z.enum(['gh', 'glab']), path: z.string().nullable() })),
  hosts: z.array(
    z.object({
      host: z.string(),
      forge: z.enum(['github', 'gitlab']),
      cli: z.enum(['gh', 'glab']),
      repos: z.number().int().nonnegative(),
      reason: forgeUnavailableReasonSchema.exclude(['unsupported-host']).nullable(),
    }),
  ),
  /**
   * Per language: the choice made in Settings and the server it comes to
   * (null `server` when off, or not installed yet); the default server when
   * this platform has a build of it (`installable`, else null), and Joinery's
   * copy of it, if installed (or being installed); and why the choice can't
   * be honoured, if it can't.
   */
  lsp: z.array(
    z.object({
      language: lspLanguageSchema,
      choice: lspChoiceSchema,
      server: lspServerIdSchema.nullable(),
      path: z.string().nullable(),
      installable: installableServerSchema.nullable(),
      managed: z.object({ version: z.string() }).nullable(),
      installing: z.boolean(),
      problem: z.string().nullable(),
    }),
  ),
});
export type Integrations = z.infer<typeof integrationsSchema>;
/**
 * macOS Full Disk Access for the installed server binary. `granted` is null
 * where it doesn't apply: off macOS, or in a source checkout, where the
 * grant belongs to whatever terminal started the server.
 */
export const fullDiskAccessSchema = z.object({
  applies: z.boolean(),
  granted: z.boolean().nullable(),
  /** The binary to add to the list; null unless installed. */
  binary: z.string().nullable(),
  /** The server runs as the LaunchAgent, so it can restart itself to pick up a new grant. */
  canRestart: z.boolean(),
});
export type FullDiskAccess = z.infer<typeof fullDiskAccessSchema>;
export const dataUsageSchema = z.object({
  /** The data directory. */
  root: z.string(),
  databaseBytes: z.number().int().nonnegative(),
  /** Checkouts made for agent runs; rebuilt on the next run that needs one. Bytes include `reviewWorktrees`, which share the folder. */
  worktrees: z.object({ count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }),
  /** Checkouts language servers read reviews from; made again on the next hover. */
  reviewWorktrees: z.object({ count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }),
  /** Last known PR lists, PR details, review stats and your forge user; refetched on demand. */
  cachedAnswers: z.object({ count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }),
});
export type DataUsage = z.infer<typeof dataUsageSchema>;
export const listPullsQuerySchema = z.object({
  /** `'true'` bypasses the server's short-lived `gh` cache. */
  refresh: z.enum(['true', 'false']).optional(),
});
export const searchPullsQuerySchema = z.object({
  /** Free text, or a PR number (`1234` / `#1234`). */
  q: z.string().min(1),
  /** Comma-separated repo ids; default is every registered repo. */
  repos: z.string().optional(),
});

// --- responses ---

export const reviewDetailSchema = z.object({
  review: reviewSchema,
  repo: repoSchema,
  state: reviewStateSchema,
  /** A reading-order run still in progress, so a reload keeps showing it. */
  readingOrderRun: agentRunSchema.nullable(),
});
export type ReviewDetail = z.infer<typeof reviewDetailSchema>;

const noContent = z.object({ ok: z.literal(true) });

/**
 * `P` is a type parameter rather than a fixed `(...args: never[]) => string` so
 * each route keeps its own path signature: `getReview.path` is `(id: string)`,
 * and calling it with the wrong number or type of segments is a compile error
 * in the client rather than a cast at the call site.
 */
type PathFn = (...args: never[]) => string;

type RouteDef<
  P extends PathFn,
  B extends z.ZodTypeAny | undefined,
  Q extends z.ZodTypeAny | undefined,
  R extends z.ZodTypeAny,
> = {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: P;
  readonly body: B;
  /** Query-string schema, so `?rev=` and `?unresolved=` are typed too. */
  readonly query: Q;
  readonly response: R;
};

const def = <
  P extends PathFn,
  B extends z.ZodTypeAny | undefined,
  Q extends z.ZodTypeAny | undefined,
  R extends z.ZodTypeAny,
>(
  d: RouteDef<P, B, Q, R>,
): RouteDef<P, B, Q, R> => d;

export const api = {
  listRepos: def({
    method: 'GET',
    path: () => '/api/repos',
    body: undefined,
    query: undefined,
    response: z.object({ repos: z.array(repoSchema) }),
  }),
  addRepo: def({
    method: 'POST',
    path: () => '/api/repos',
    body: addRepoBodySchema,
    query: undefined,
    response: z.object({ repo: repoSchema }),
  }),
  /**
   * Unregister a repo: its reviews (threads, reading orders, viewed checks
   * included) are deleted, its agent worktrees removed, and the refs Joinery
   * wrote under `refs/review/` dropped. The clone itself is left alone.
   */
  deleteRepo: def({
    method: 'DELETE',
    path: (id: string) => `/api/repos/${encodeURIComponent(id)}`,
    body: undefined,
    query: undefined,
    response: noContent,
  }),
  integrations: def({
    method: 'GET',
    path: () => '/api/settings/integrations',
    body: undefined,
    query: undefined,
    response: integrationsSchema,
  }),
  fullDiskAccess: def({
    method: 'GET',
    path: () => '/api/settings/full-disk-access',
    body: undefined,
    query: undefined,
    response: fullDiskAccessSchema,
  }),
  /** Open System Settings at Full Disk Access and reveal the binary in Finder (installed builds on macOS). */
  openFullDiskAccess: def({
    method: 'POST',
    path: () => '/api/settings/full-disk-access/open',
    body: undefined,
    query: undefined,
    response: noContent,
  }),
  /** Restart the LaunchAgent, e.g. so a new Full Disk Access grant applies. The server answers, then goes away. */
  installLanguageServer: def({
    method: 'POST',
    path: (server: string) => `/api/settings/lsp/${encodeURIComponent(server)}/install`,
    body: undefined,
    query: undefined,
    response: z.object({ server: installableServerSchema, version: z.string(), path: z.string() }),
  }),
  setLanguageServerChoice: def({
    method: 'PUT',
    path: (language: string) => `/api/settings/lsp/choice/${encodeURIComponent(language)}`,
    body: lspChoiceSchema,
    query: undefined,
    response: z.object({ ok: z.literal(true) }),
  }),
  restartServer: def({
    method: 'POST',
    path: () => '/api/settings/restart',
    body: undefined,
    query: undefined,
    response: z.object({ started: z.literal(true) }),
  }),
  dataUsage: def({
    method: 'GET',
    path: () => '/api/settings/data',
    body: undefined,
    query: undefined,
    response: dataUsageSchema,
  }),
  /** Remove every agent worktree. Refused while an agent run is going. */
  clearWorktrees: def({
    method: 'POST',
    path: () => '/api/settings/worktrees/clear',
    body: undefined,
    query: undefined,
    response: z.object({ removed: z.number().int() }),
  }),
  /** Remove every review worktree (language-server checkout); later hovers make new ones. */
  clearReviewWorktrees: def({
    method: 'POST',
    path: () => '/api/settings/review-worktrees/clear',
    body: undefined,
    query: undefined,
    response: z.object({ removed: z.number().int() }),
  }),
  /** Delete every cached answer (PR lists, PR details, review stats, your forge user). */
  clearCachedAnswers: def({
    method: 'POST',
    path: () => '/api/settings/cached-answers/clear',
    body: undefined,
    query: undefined,
    response: z.object({ removed: z.number().int() }),
  }),
  listDirs: def({
    method: 'GET',
    path: () => '/api/fs/dirs',
    body: undefined,
    query: listDirsQuerySchema,
    response: z.object({
      /** Canonical absolute path of the directory that was listed. */
      path: z.string(),
      parent: z.string().nullable(),
      /** The listed directory itself has a `.git`. */
      isRepo: z.boolean(),
      entries: z.array(dirEntrySchema),
    }),
  }),
  listBranches: def({
    method: 'GET',
    path: (repoId: string) => `/api/repos/${encodeURIComponent(repoId)}/branches`,
    body: undefined,
    query: listBranchesQuerySchema,
    response: z.object({ branches: z.array(branchSchema) }),
  }),
  listPulls: def({
    method: 'GET',
    path: (repoId: string) => `/api/repos/${encodeURIComponent(repoId)}/pulls`,
    body: undefined,
    query: listPullsQuerySchema,
    response: z.object({
      available: z.boolean(),
      pulls: z.array(pullSchema),
      unavailableReason: forgeUnavailableReasonSchema.optional(),
      unavailableHost: z.string().nullable().optional(),
    }),
  }),
  /** Search PRs of any state across repos via `gh`; `available` is false when `gh` can't be asked. */
  searchPulls: def({
    method: 'GET',
    path: () => '/api/pulls/search',
    body: undefined,
    query: searchPullsQuerySchema,
    response: z.object({
      available: z.boolean(),
      pulls: z.array(pullSearchResultSchema),
      unavailableReason: forgeUnavailableReasonSchema.optional(),
      unavailableHost: z.string().nullable().optional(),
    }),
  }),
  me: def({
    method: 'GET',
    path: () => '/api/me',
    body: undefined,
    query: undefined,
    response: meSchema,
  }),
  version: def({
    method: 'GET',
    path: () => '/api/version',
    body: undefined,
    query: versionQuerySchema,
    response: versionInfoSchema,
  }),
  startUpdate: def({
    method: 'POST',
    path: () => '/api/update',
    body: undefined,
    query: undefined,
    response: z.object({ started: z.literal(true) }),
  }),
  listReviews: def({
    method: 'GET',
    path: () => '/api/reviews',
    body: undefined,
    query: listReviewsQuerySchema,
    response: z.object({ reviews: z.array(reviewSchema), summaries: z.array(reviewSummarySchema) }),
  }),
  createReview: def({
    method: 'POST',
    path: () => '/api/reviews',
    body: createReviewBodySchema,
    query: undefined,
    response: reviewDetailSchema,
  }),
  getReview: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}`,
    body: undefined,
    query: undefined,
    response: reviewDetailSchema,
  }),
  /** Delete a review for good: threads, comments, reading order, viewed checks, and its `refs/review/` refs. */
  deleteReview: def({
    method: 'DELETE',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}`,
    body: undefined,
    query: undefined,
    response: noContent,
  }),
  getFiles: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/files`,
    body: undefined,
    /** Omitted means the review's current revision. */
    query: z.object({ rev: revisionSchema.optional() }),
    response: z.object({
      list: fileListSchema,
      viewed: z.array(z.object({ path: z.string(), blobSha: z.string() })),
    }),
  }),
  getDiff: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/diff`,
    body: undefined,
    query: z.object({ path: z.string().min(1), rev: revisionSchema.optional() }),
    response: z.object({ patch: filePatchSchema }),
  }),
  getContents: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/contents`,
    body: undefined,
    query: z.object({ path: z.string().min(1), rev: revisionSchema.optional() }),
    response: z.object({ contents: fileContentsSchema }),
  }),
  /**
   * Raw bytes of one side of a changed file, not JSON: the web app reads it
   * with `fetchBlob` (apps/web/src/lib/preview.ts), not `callApi`. `HEAD` answers
   * with the size alone. The ETag is the blob SHA.
   */
  getBlob: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/blob`,
    body: undefined,
    query: blobQuerySchema,
    response: z.instanceof(Blob),
  }),
  getHover: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/lsp/hover`,
    body: undefined,
    query: lspPositionQuerySchema,
    response: z.object({ hover: lspHoverSchema.nullable() }),
  }),
  getDefinition: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/lsp/definition`,
    body: undefined,
    query: lspPositionQuerySchema,
    response: z.object({ definition: lspDefinitionSchema.nullable(), off: lspLanguageSchema.nullable() }),
  }),
  getReferences: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/lsp/references`,
    body: undefined,
    query: lspPositionQuerySchema,
    response: z.object({ references: lspReferencesSchema.nullable(), off: lspLanguageSchema.nullable() }),
  }),
  getImplementations: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/lsp/implementations`,
    body: undefined,
    query: lspPositionQuerySchema,
    response: z.object({ implementations: lspReferencesSchema.nullable(), off: lspLanguageSchema.nullable() }),
  }),
  getHighlights: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/lsp/highlights`,
    body: undefined,
    query: lspPositionQuerySchema,
    response: z.object({ highlights: z.array(lspHighlightSchema) }),
  }),
  getLspFile: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/lsp/file`,
    body: undefined,
    query: lspFileQuerySchema,
    response: z.object({ file: lspFileSchema.nullable() }),
  }),
  getReadingOrder: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/reading-order`,
    body: undefined,
    query: undefined,
    response: z.object({ readingOrder: readingOrderSchema.nullable() }),
  }),
  setReadingOrder: def({
    method: 'PUT',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/reading-order`,
    body: readingOrderPlanSchema,
    query: undefined,
    response: z.object({ readingOrder: readingOrderSchema }),
  }),
  generateReadingOrder: def({
    method: 'POST',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/reading-order/generate`,
    body: generateReadingOrderBodySchema,
    query: undefined,
    response: z.object({ run: agentRunSchema }),
  }),
  listThreads: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/threads`,
    body: undefined,
    /**
     * `rev` scopes the returned line positions to a revision other than the
     * review's persisted current one — projected at read time, never
     * persisted. Omitted means the
     * persisted revision's stored positions, as before.
     */
    query: z.object({ status: z.enum(['open', 'resolved']).optional(), rev: revisionSchema.optional() }),
    response: z.object({ threads: z.array(threadSchema) }),
  }),
  createThread: def({
    method: 'POST',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/threads`,
    body: createThreadBodySchema,
    query: undefined,
    response: z.object({ thread: threadSchema, run: agentRunSchema.nullable() }),
  }),
  getThread: def({
    method: 'GET',
    path: (id: string) => `/api/threads/${encodeURIComponent(id)}`,
    body: undefined,
    query: undefined,
    response: z.object({ thread: threadSchema }),
  }),
  reply: def({
    method: 'POST',
    path: (id: string) => `/api/threads/${encodeURIComponent(id)}/replies`,
    body: replyBodySchema,
    query: undefined,
    response: z.object({ thread: threadSchema, run: agentRunSchema.nullable() }),
  }),
  resolveThread: def({
    method: 'POST',
    path: (id: string) => `/api/threads/${encodeURIComponent(id)}/resolve`,
    body: z.object({ resolved: z.boolean().default(true) }),
    query: undefined,
    response: z.object({ thread: threadSchema }),
  }),
  /** Delete a thread and all its comments; also arrives as `thread.deleted`. */
  deleteThread: def({
    method: 'DELETE',
    path: (id: string) => `/api/threads/${encodeURIComponent(id)}`,
    body: undefined,
    query: undefined,
    response: noContent,
  }),
  /**
   * Delete one comment. Deleting a thread's last comment deletes the thread:
   * `thread` is then null (and `thread.deleted` is sent instead of `thread.updated`).
   */
  deleteComment: def({
    method: 'DELETE',
    path: (id: string) => `/api/comments/${encodeURIComponent(id)}`,
    body: undefined,
    query: undefined,
    response: z.object({ threadId: z.string(), thread: threadSchema.nullable() }),
  }),
  /**
   * The explicit "Ask agent" trigger for a thread that already carries the
   * question. `createThread`/`reply` with `askAgent: true` are sugar for the
   * same run.
   */
  askAgent: def({
    method: 'POST',
    path: (id: string) => `/api/threads/${encodeURIComponent(id)}/ask`,
    body: askAgentBodySchema,
    query: undefined,
    response: z.object({ run: agentRunSchema }),
  }),
  setReaction: def({
    method: 'POST',
    path: (id: string) => `/api/comments/${encodeURIComponent(id)}/reactions`,
    body: setReactionBodySchema,
    query: undefined,
    response: z.object({ thread: threadSchema }),
  }),
  /** Reach a comment's thread (and review) from its id alone, for the `react` tool's ownership check. */
  getComment: def({
    method: 'GET',
    path: (id: string) => `/api/comments/${encodeURIComponent(id)}`,
    body: undefined,
    query: undefined,
    response: z.object({ threadId: z.string(), reviewId: z.string() }),
  }),
  setRevision: def({
    method: 'POST',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/revision`,
    body: setRevisionBodySchema,
    query: undefined,
    // `list` rides along with the switch response — the target revision's
    // snapshot is already warm (kept fresh in the background), so this is a
    // cache read, not a second round trip via GET /files.
    response: z.object({ state: reviewStateSchema, list: fileListSchema }),
  }),
  setReviewStatus: def({
    method: 'POST',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/status`,
    body: setReviewStatusBodySchema,
    query: undefined,
    response: z.object({ review: reviewSchema }),
  }),
  markViewed: def({
    method: 'POST',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/viewed`,
    body: markViewedBodySchema,
    query: undefined,
    response: noContent,
  }),
  /** Mark (or clear) every file of the review's current revision as viewed, in one call. */
  setAllViewed: def({
    method: 'POST',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/viewed/all`,
    body: setAllViewedBodySchema,
    query: undefined,
    response: noContent,
  }),
  /** Resolve (or reopen) every thread of the review; each change also arrives as `thread.updated`. */
  resolveAllThreads: def({
    method: 'POST',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/threads/resolve-all`,
    body: resolveAllThreadsBodySchema,
    query: undefined,
    response: z.object({ threads: z.array(threadSchema) }),
  }),
  /**
   * The review's PR in full, for the summary card. `pull` is null when the
   * review has no PR or `gh` can't say; `refresh` skips the short cache.
   */
  getReviewPull: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/pull`,
    body: undefined,
    query: z.object({ refresh: z.enum(['true', 'false']).optional() }),
    response: z.object({ pull: pullDetailSchema.nullable() }),
  }),
  cancelRun: def({
    method: 'POST',
    path: (id: string) => `/api/runs/${encodeURIComponent(id)}/cancel`,
    body: undefined,
    query: undefined,
    response: z.object({ run: agentRunSchema }),
  }),
  getRun: def({
    method: 'GET',
    path: (id: string) => `/api/runs/${encodeURIComponent(id)}`,
    body: undefined,
    query: undefined,
    response: z.object({
      run: agentRunSchema,
      events: z.array(
        z.object({ seq: z.number().int(), type: z.string(), payload: z.unknown() }),
      ),
    }),
  }),
} as const;

export type Api = typeof api;
export type ApiOperation = keyof Api;

export type BodyOf<K extends ApiOperation> = Api[K]['body'] extends z.ZodTypeAny
  ? z.input<Api[K]['body']>
  : never;
export type QueryOf<K extends ApiOperation> = Api[K]['query'] extends z.ZodTypeAny
  ? z.input<Api[K]['query']>
  : never;
export type PathArgsOf<K extends ApiOperation> = Parameters<Api[K]['path']>;
export type ResponseOf<K extends ApiOperation> = z.output<Api[K]['response']>;

export const DEFAULT_PORT = 7317;
export const DEFAULT_HOST = '127.0.0.1';
