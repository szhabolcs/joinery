/**
 * The GitLab `Forge`: merge request discovery via the `glab` CLI. Same rule as
 * the GitHub forge: a missing or unauthenticated `glab` is data ("unavailable",
 * `null`), never a thrown error.
 *
 * Everything goes through `glab api projects/:fullpath/merge_requests…` run
 * inside the repo clone: glab fills `:fullpath` with the URL-encoded project
 * path (nested groups included) and picks the host from the clone's remote, so
 * self-hosted instances need no extra flag as long as `glab` is logged into them.
 */
import { z } from 'zod';
import type { CiStatus, PullDetail, PullState } from '@joinery/core';
import { cliUnavailable, runCli, unavailableFields } from './cli.ts';
import type {
  Forge,
  ForgeOptions,
  ListOpenPullsResult,
  MergedPrCommits,
  PullSearchHit,
  PullSummary,
  ResolvedPr,
  SearchPullsResult,
} from './types.ts';

/** Run `glab` (see `runCli`): stdout on exit 0, `null` on anything else, including a host known to lack `glab`. */
function runGlab(args: readonly string[], cwd: string): Promise<string | null> {
  return runCli('glab', args, cwd);
}

/** `glab api` GET of a path under the current clone's project (`projects/:fullpath/…`). */
function runProjectApi(path: string, cwd: string): Promise<string | null> {
  return runGlab(['api', `projects/:fullpath/${path}`], cwd);
}

/** `glab api` GET of a path under an explicit `owner/name` (possibly nested) project. */
function runSlugApi(slug: string, path: string, cwd: string): Promise<string | null> {
  return runGlab(['api', `projects/${encodeURIComponent(slug)}/${path}`], cwd);
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function unixOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/**
 * Map a pipeline status onto `CiStatus`. `skipped`, `manual` and unknown
 * statuses carry no signal (`null`), like a pull with no checks.
 */
export function deriveCiStatus(status: string | null | undefined): CiStatus | null {
  switch (status) {
    case 'success':
      return 'passing';
    case 'failed':
    case 'canceled':
    case 'canceling':
      return 'failing';
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'running':
    case 'scheduled':
      return 'pending';
    default:
      return null;
  }
}

/** GitLab's merge request states: 'opened' | 'closed' | 'locked' | 'merged'. */
function pullStateOf(state: string, draft: boolean): PullState {
  return state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : draft ? 'draft' : 'open';
}

const pipelineSchema = z.object({ status: z.string() }).nullable().default(null);
const userSchema = z.object({ username: z.string() }).nullable().default(null);

async function findOpenPrNumberForBranch(branch: string, options: ForgeOptions): Promise<number | null> {
  const stdout = await runProjectApi(
    `merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&order_by=updated_at&per_page=1`,
    options.cwd,
  );
  if (stdout === null) return null;
  const parsed = z.array(z.object({ iid: z.number().int().positive() })).safeParse(parseJson(stdout));
  return parsed.success ? (parsed.data[0]?.iid ?? null) : null;
}

const pullListItemSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  source_project_id: z.number().optional(),
  target_project_id: z.number().optional(),
  author: userSchema,
  updated_at: z.string(),
  draft: z.boolean().default(false),
  reviewers: z.array(userSchema).catch([]).default([]),
  head_pipeline: pipelineSchema,
  sha: z.string().nullable().optional(),
});

// GitLab's list endpoint caps pages at 100; one page is enough for a review queue.
const OPEN_PULLS_LIMIT = 100;

/** The slice of `merge_requests/:iid` the list endpoint lacks: the pipeline and the file count. */
const pullDetailSchema = z.object({
  head_pipeline: pipelineSchema,
  // A string, and "1000+" past the cap.
  changes_count: z.string().nullable().default(null),
});

/** Parse GitLab's `changes_count` ("12", "1000+"); `null` when absent. */
function changedFilesOf(count: string | null): number | null {
  const n = Number.parseInt(count ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

/** Detail calls per list refresh run this many at a time. */
const DETAIL_CONCURRENCY = 4;

/** `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Open, same-project MRs. The list endpoint carries no line counts and
 * usually no pipeline, so each MR gets one `merge_requests/:iid` detail call
 * (bounded concurrency) for `ci` and `changedFiles`; a failed detail call
 * leaves those as the list gave them. `additions`/`deletions` stay `null` —
 * they would cost a paginated diff fetch per MR.
 */
async function listOpenPulls(options: ForgeOptions & { login: string | null }): Promise<ListOpenPullsResult> {
  const stdout = await runProjectApi(
    `merge_requests?state=opened&order_by=updated_at&per_page=${String(OPEN_PULLS_LIMIT)}`,
    options.cwd,
  );
  if (stdout === null) {
    return { available: false, pulls: [], ...unavailableFields(await cliUnavailable('glab', options.cwd)) };
  }

  const parsed = z.array(pullListItemSchema).safeParse(parseJson(stdout));
  if (!parsed.success) return { available: true, pulls: [] };

  const { login } = options;
  const items = parsed.data
    // MRs from forks have a different source project; out of scope, as for GitHub.
    .filter((p) => p.source_project_id === undefined || p.source_project_id === p.target_project_id);
  const details = await mapLimit(items, DETAIL_CONCURRENCY, async (p) => {
    const detail = await runProjectApi(`merge_requests/${String(p.iid)}`, options.cwd);
    const d = detail === null ? null : pullDetailSchema.safeParse(parseJson(detail));
    return d?.success === true ? d.data : null;
  });
  const pulls: PullSummary[] = items.map((p, i) => {
    // Login not known yet: any requested reviewer counts, as on GitHub.
    const reviewers = p.reviewers.flatMap((r) => (r === null ? [] : [r.username]));
    const detail = details[i] ?? null;
    return {
      number: p.iid,
      title: p.title,
      headRefName: p.source_branch,
      baseRefName: p.target_branch,
      authorLogin: p.author?.username ?? null,
      updatedAt: p.updated_at,
      updatedAtUnix: unixOf(p.updated_at),
      isDraft: p.draft,
      additions: null,
      deletions: null,
      changedFiles: detail === null ? null : changedFilesOf(detail.changes_count),
      ci: deriveCiStatus((detail?.head_pipeline ?? p.head_pipeline)?.status),
      headSha: p.sha ?? null,
      reviewRequested: login === null ? reviewers.length > 0 : reviewers.includes(login),
      reviewId: null,
      reviewStatus: null,
    };
  });
  return { available: true, pulls };
}

const pullRefsSchema = z.object({ source_branch: z.string(), target_branch: z.string() });

async function resolvePr(prNumber: number, options: ForgeOptions): Promise<ResolvedPr | null> {
  const stdout = await runProjectApi(`merge_requests/${String(prNumber)}`, options.cwd);
  if (stdout === null) return null;
  const parsed = pullRefsSchema.safeParse(parseJson(stdout));
  return parsed.success
    ? { headRefName: parsed.data.source_branch, baseRefName: parsed.data.target_branch }
    : null;
}

const mergedPrSchema = z.object({
  state: z.string(),
  merge_commit_sha: z.string().nullable().default(null),
  // A squash or fast-forward merge has no merge commit, only the squash commit.
  squash_commit_sha: z.string().nullable().default(null),
  sha: z.string(),
});

async function viewMergedPrCommits(prNumber: number, options: ForgeOptions): Promise<MergedPrCommits | null> {
  const stdout = await runProjectApi(`merge_requests/${String(prNumber)}`, options.cwd);
  if (stdout === null) return null;
  const parsed = mergedPrSchema.safeParse(parseJson(stdout));
  if (!parsed.success || parsed.data.state !== 'merged') return null;
  const mergeCommit = parsed.data.merge_commit_sha ?? parsed.data.squash_commit_sha;
  return mergeCommit === null ? null : { mergeCommit, headRefOid: parsed.data.sha };
}

const pullViewSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable().default(''),
  state: z.string(),
  draft: z.boolean().default(false),
  author: userSchema,
  target_branch: z.string(),
  head_pipeline: pipelineSchema,
  // A string, and "1000+" past the cap.
  changes_count: z.string().nullable().default(null),
  web_url: z.string().optional(),
});

const diffsPageSchema = z.array(
  z.object({
    diff: z.string().default(''),
    collapsed: z.boolean().default(false),
    too_large: z.boolean().default(false),
  }),
);
const DIFFS_PER_PAGE = 100;
/** Past this many pages (500 files) the totals would be partial, so they're left unknown. */
const DIFFS_MAX_PAGES = 5;

/**
 * Added/removed line totals from `merge_requests/:iid/diffs`. GitLab's per-file
 * `diff` text starts at the first hunk (no `---`/`+++` headers), so every
 * `+`/`-` line is a real change. `null` when any page fails, the page cap is
 * hit, or any file came back `collapsed`/`too_large` (its `diff` is empty, so the
 * total would silently undercount) — a missing size must never fail the whole `viewPull`.
 */
async function diffLineCounts(prNumber: number, cwd: string): Promise<{ additions: number; deletions: number } | null> {
  let additions = 0;
  let deletions = 0;
  for (let page = 1; page <= DIFFS_MAX_PAGES; page++) {
    const stdout = await runProjectApi(
      `merge_requests/${String(prNumber)}/diffs?per_page=${String(DIFFS_PER_PAGE)}&page=${String(page)}`,
      cwd,
    );
    if (stdout === null) return null;
    const parsed = diffsPageSchema.safeParse(parseJson(stdout));
    if (!parsed.success) return null;
    for (const file of parsed.data) {
      if (file.too_large || file.collapsed) return null;
      for (const line of file.diff.split('\n')) {
        if (line.startsWith('+')) additions++;
        else if (line.startsWith('-')) deletions++;
      }
    }
    if (parsed.data.length < DIFFS_PER_PAGE) return { additions, deletions };
  }
  return null;
}

/** One MR in full; line counts come from a separate diffs fetch and stay `null` if it fails. */
async function viewPull(prNumber: number, options: ForgeOptions): Promise<PullDetail | null> {
  const [stdout, counts] = await Promise.all([
    runProjectApi(`merge_requests/${String(prNumber)}`, options.cwd),
    diffLineCounts(prNumber, options.cwd),
  ]);
  if (stdout === null) return null;
  const parsed = pullViewSchema.safeParse(parseJson(stdout));
  if (!parsed.success) return null;
  const p = parsed.data;
  return {
    number: p.iid,
    title: p.title,
    body: p.description ?? '',
    state: pullStateOf(p.state, p.draft),
    authorLogin: p.author?.username ?? null,
    baseRefName: p.target_branch,
    ci: deriveCiStatus(p.head_pipeline?.status),
    additions: counts?.additions ?? null,
    deletions: counts?.deletions ?? null,
    changedFiles: changedFilesOf(p.changes_count),
    url: p.web_url ?? null,
  };
}

const searchHitSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean().default(false),
  author: userSchema,
  updated_at: z.string(),
});

function toSearchHit(raw: unknown, slug: string): PullSearchHit | null {
  const parsed = searchHitSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  return {
    slug: slug.toLowerCase(),
    number: p.iid,
    title: p.title,
    state: pullStateOf(p.state, p.draft),
    authorLogin: p.author?.username ?? null,
    updatedAt: p.updated_at,
    updatedAtUnix: unixOf(p.updated_at),
  };
}

const SEARCH_LIMIT = 50;

/**
 * Search MRs of any state across `repos`, one request per project in parallel.
 * A number query fetches that iid; anything else is a `search=` over title and
 * description. `available: false` means `glab` can't be asked at all.
 */
async function searchPulls(
  query: string,
  repos: readonly { slug: string; cwd: string }[],
): Promise<SearchPullsResult> {
  const first = repos[0];
  if (first === undefined) return { available: true, pulls: [] };

  const numberMatch = /^#?(\d+)$/.exec(query);
  const path = numberMatch !== null
    ? `merge_requests/${numberMatch[1] ?? ''}`
    : `merge_requests?state=all&order_by=updated_at&per_page=${String(SEARCH_LIMIT)}&search=${encodeURIComponent(query)}`;
  const outputs = await Promise.all(repos.map((r) => runSlugApi(r.slug, path, r.cwd)));

  const pulls: PullSearchHit[] = [];
  outputs.forEach((stdout, i) => {
    const repo = repos[i];
    if (stdout === null || repo === undefined) return;
    const raw = parseJson(stdout);
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      const hit = toSearchHit(item, repo.slug);
      if (hit !== null) pulls.push(hit);
    }
  });
  pulls.sort((a, b) => b.updatedAtUnix - a.updatedAtUnix);
  // Every project failing is "not found" when `glab` works, "unavailable" when it doesn't.
  if (pulls.length === 0 && outputs.every((o) => o === null)) {
    const unavailable = await cliUnavailable('glab', first.cwd);
    return { available: unavailable === null, pulls, ...unavailableFields(unavailable) };
  }
  return { available: true, pulls: pulls.slice(0, SEARCH_LIMIT) };
}

async function currentLogin(cwd: string): Promise<string | null> {
  const stdout = await runGlab(['api', 'user'], cwd);
  if (stdout === null) return null;
  const parsed = z.object({ username: z.string() }).safeParse(parseJson(stdout));
  return parsed.success && parsed.data.username !== '' ? parsed.data.username : null;
}

export const gitlabForge: Forge = {
  kind: 'gitlab',
  cli: 'glab',
  setupHint: 'Check that `glab` is installed, authenticated (`glab auth login`), and the MR exists in this repo.',
  // GitLab keeps every MR's head here, open or not, even after its branch is deleted.
  pullHeadRef: (prNumber) => `refs/merge-requests/${String(prNumber)}/head`,
  currentLogin,
  findOpenPrNumberForBranch,
  listOpenPulls,
  searchPulls,
  resolvePr,
  viewMergedPrCommits,
  viewPull,
  // No stacked-PR feature on this host.
  listStacks: async () => null,
};
