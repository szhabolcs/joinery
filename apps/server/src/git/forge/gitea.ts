/**
 * The Gitea `Forge`: pull request discovery via the `gt` CLI (gitea.com/gitea/cli).
 * Same rule as the other forges: a missing or unauthenticated `gt` is data
 * ("unavailable", `null`), never a thrown error.
 *
 * Everything is a `gt api` GET under `/api/v1`, with the instance passed as
 * `--host` and the repo spelled out (`repos/<owner>/<name>/…`), both taken from
 * the clone's origin. `gt`'s own repo discovery isn't used: it can't place an
 * SSH remote on a custom port (`ssh://git@host:2222/…`) without extra config.
 * Forgejo serves the same API, so a Forgejo instance `gt` is logged into works too.
 */
import { z } from 'zod';
import type { CiStatus, PullDetail, PullState } from '@joinery/core';
import { remoteIdentity } from '../repo.ts';
import { cliUnavailable, giteaInstanceUrl, originHost, runCli, unavailableFields } from './cli.ts';
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

/** `gt api <path>` against the instance of `cwd`'s origin: stdout on exit 0, `null` on anything else (see `runCli`). */
async function runApi(path: string, cwd: string): Promise<string | null> {
  const host = await originHost(cwd);
  const hostArgs = host === null ? [] : ['--host', await giteaInstanceUrl(host, cwd)];
  return runCli('gt', ['api', ...hostArgs, '--no-input', path], cwd);
}

/** cwd -> `owner/name` of its origin, so each call costs no extra `git config`. */
const slugByCwd = new Map<string, Promise<string | null>>();

function slugOf(cwd: string): Promise<string | null> {
  let slug = slugByCwd.get(cwd);
  if (slug === undefined) {
    slug = remoteIdentity({ cwd })
      .then(({ owner, name }) => (owner === null || name === null ? null : `${owner}/${name}`))
      .catch(() => null);
    slugByCwd.set(cwd, slug);
  }
  return slug;
}

/** `repos/<owner>/<name>/<path>`, each segment encoded. */
function repoPath(slug: string, path: string): string {
  return `repos/${slug.split('/').map(encodeURIComponent).join('/')}/${path}`;
}

/** `gt api` GET of a path under `cwd`'s own repository. */
async function runRepoApi(path: string, cwd: string): Promise<string | null> {
  const slug = await slugOf(cwd);
  return slug === null ? null : runApi(repoPath(slug, path), cwd);
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
 * Map Gitea's combined commit status onto `CiStatus`. A commit with no
 * statuses reports `pending` with `total_count: 0`, which is no signal
 * (`null`), like a pull with no checks; so is a state this code doesn't
 * know. `warning` doesn't block a merge, so it counts as passing.
 */
export function deriveCiStatus(state: string | null | undefined, totalCount: number): CiStatus | null {
  if (totalCount === 0) return null;
  switch (state) {
    case 'success':
    case 'warning':
      return 'passing';
    case 'failure':
    case 'error':
      return 'failing';
    case 'pending':
      return 'pending';
    default:
      return null;
  }
}

/** Gitea's default work-in-progress title prefixes, for instances too old to report `draft`. */
const WIP_TITLE = /^\s*(?:\[wip\]|wip:)/iu;

function isDraftPull(draft: boolean | undefined, title: string): boolean {
  return draft ?? WIP_TITLE.test(title);
}

/** Gitea's pull states are 'open' | 'closed'; a merged pull is closed with `merged: true`. */
function pullStateOf(state: string, merged: boolean, draft: boolean): PullState {
  return merged ? 'merged' : state === 'closed' ? 'closed' : draft ? 'draft' : 'open';
}

const userSchema = z.object({ login: z.string() }).nullable().default(null);

const pullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().default(''),
  state: z.string(),
  draft: z.boolean().optional(),
  merged: z.boolean().default(false),
  merge_commit_sha: z.string().nullable().default(null),
  user: userSchema,
  updated_at: z.string(),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
    repo_id: z.number().nullable().optional(),
  }),
  base: z.object({
    ref: z.string(),
    repo_id: z.number().nullable().optional(),
  }),
  requested_reviewers: z.array(userSchema).nullable().catch([]).default([]),
  // Only the single-pull endpoint fills these; the list reports null.
  additions: z.number().int().nonnegative().nullable().default(null),
  deletions: z.number().int().nonnegative().nullable().default(null),
  changed_files: z.number().int().nonnegative().nullable().default(null),
  html_url: z.string().optional(),
});
type GiteaPull = z.infer<typeof pullSchema>;

function parsePull(stdout: string | null): GiteaPull | null {
  if (stdout === null) return null;
  const parsed = pullSchema.safeParse(parseJson(stdout));
  return parsed.success ? parsed.data : null;
}

function parsePulls(stdout: string): GiteaPull[] | null {
  const raw = parseJson(stdout);
  if (!Array.isArray(raw)) return null;
  // One odd item must not cost the whole list.
  return raw.flatMap((item) => {
    const parsed = pullSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Pulls from forks have another head repository; out of scope, as for GitHub. Unknown ids keep the pull. */
function isSameRepo(p: GiteaPull): boolean {
  return p.head.repo_id == null || p.base.repo_id == null || p.head.repo_id === p.base.repo_id;
}

const combinedStatusSchema = z.object({ state: z.string().nullable().default(null), total_count: z.number().default(0) });

/** The CI roll-up of commit `sha`; `null` when it has no statuses or the call fails. */
async function ciOf(sha: string, cwd: string): Promise<CiStatus | null> {
  const stdout = await runRepoApi(`commits/${encodeURIComponent(sha)}/status`, cwd);
  if (stdout === null) return null;
  const parsed = combinedStatusSchema.safeParse(parseJson(stdout));
  return parsed.success ? deriveCiStatus(parsed.data.state, parsed.data.total_count) : null;
}

/** Gitea caps a page at its `MAX_RESPONSE_ITEMS`, 50 by default. */
const PAGE_LIMIT = 50;
/** How far `findOpenPrNumberForBranch` pages through open pulls, most recently updated first. */
const FIND_MAX_PAGES = 4;

async function findOpenPrNumberForBranch(branch: string, options: ForgeOptions): Promise<number | null> {
  for (let page = 1; page <= FIND_MAX_PAGES; page++) {
    const stdout = await runRepoApi(
      `pulls?state=open&sort=recentupdate&limit=${String(PAGE_LIMIT)}&page=${String(page)}`,
      options.cwd,
    );
    if (stdout === null) return null;
    const pulls = parsePulls(stdout);
    if (pulls === null) return null;
    const match = pulls.find((p) => p.head.ref === branch && isSameRepo(p));
    if (match !== undefined) return match.number;
    if (pulls.length < PAGE_LIMIT) return null;
  }
  return null;
}

type Size = { additions: number | null; deletions: number | null; changedFiles: number | null };

/**
 * Line and file counts by `<instance>/<repo>#<number>@<head sha>`: the list
 * endpoint has none, and they only change with the head, so each pull costs
 * one detail call per new head rather than one per poll.
 */
const sizes = new Map<string, Size>();
const SIZE_CACHE_MAX = 1_000;

async function sizeOf(p: GiteaPull, cwd: string): Promise<Size> {
  const key = `${(await originHost(cwd)) ?? ''}/${(await slugOf(cwd)) ?? ''}#${String(p.number)}@${p.head.sha}`;
  const cached = sizes.get(key);
  if (cached !== undefined) return cached;
  const detail = parsePull(await runRepoApi(`pulls/${String(p.number)}`, cwd));
  const size = { additions: detail?.additions ?? null, deletions: detail?.deletions ?? null, changedFiles: detail?.changed_files ?? null };
  // A failed call isn't remembered, so the next poll asks again.
  if (detail !== null) {
    if (sizes.size >= SIZE_CACHE_MAX) sizes.clear();
    sizes.set(key, size);
  }
  return size;
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
 * Open, same-repo pulls, most recently updated first. The list endpoint has
 * neither CI nor sizes, so each pull also gets its head's combined status
 * and, once per head, a detail call for its size (bounded concurrency); a
 * failed call leaves that field `null`.
 */
async function listOpenPulls(options: ForgeOptions & { login: string | null }): Promise<ListOpenPullsResult> {
  const stdout = await runRepoApi(`pulls?state=open&sort=recentupdate&limit=${String(PAGE_LIMIT)}`, options.cwd);
  if (stdout === null) {
    return { available: false, pulls: [], ...unavailableFields(await cliUnavailable('gt', options.cwd)) };
  }
  const parsed = parsePulls(stdout);
  if (parsed === null) return { available: true, pulls: [] };

  const { login } = options;
  const items = parsed.filter(isSameRepo);
  const extras = await mapLimit(items, DETAIL_CONCURRENCY, async (p) => {
    const [ci, size] = await Promise.all([ciOf(p.head.sha, options.cwd), sizeOf(p, options.cwd)]);
    return { ci, size };
  });
  const pulls: PullSummary[] = items.map((p, i) => {
    // Login not known yet: any requested reviewer counts, as on GitHub.
    const reviewers = (p.requested_reviewers ?? []).flatMap((r) => (r === null ? [] : [r.login]));
    const extra = extras[i];
    return {
      number: p.number,
      title: p.title,
      headRefName: p.head.ref,
      baseRefName: p.base.ref,
      authorLogin: p.user?.login ?? null,
      updatedAt: p.updated_at,
      updatedAtUnix: unixOf(p.updated_at),
      isDraft: isDraftPull(p.draft, p.title),
      additions: extra?.size.additions ?? null,
      deletions: extra?.size.deletions ?? null,
      changedFiles: extra?.size.changedFiles ?? null,
      ci: extra?.ci ?? null,
      headSha: p.head.sha,
      reviewRequested: login === null ? reviewers.length > 0 : reviewers.includes(login),
      reviewId: null,
      reviewStatus: null,
    };
  });
  return { available: true, pulls };
}

async function resolvePr(prNumber: number, options: ForgeOptions): Promise<ResolvedPr | null> {
  const p = parsePull(await runRepoApi(`pulls/${String(prNumber)}`, options.cwd));
  return p === null ? null : { headRefName: p.head.ref, baseRefName: p.base.ref };
}

async function viewMergedPrCommits(prNumber: number, options: ForgeOptions): Promise<MergedPrCommits | null> {
  const p = parsePull(await runRepoApi(`pulls/${String(prNumber)}`, options.cwd));
  if (p === null || !p.merged || p.merge_commit_sha === null) return null;
  return { mergeCommit: p.merge_commit_sha, headRefOid: p.head.sha };
}

/** One pull in full; CI is its head's combined status and stays `null` if that call fails. */
async function viewPull(prNumber: number, options: ForgeOptions): Promise<PullDetail | null> {
  const p = parsePull(await runRepoApi(`pulls/${String(prNumber)}`, options.cwd));
  if (p === null) return null;
  const ci = await ciOf(p.head.sha, options.cwd);
  return {
    number: p.number,
    title: p.title,
    body: p.body ?? '',
    state: pullStateOf(p.state, p.merged, isDraftPull(p.draft, p.title)),
    authorLogin: p.user?.login ?? null,
    baseRefName: p.base.ref,
    ci,
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changed_files,
    url: p.html_url ?? null,
  };
}

/** A hit from the issue search (`type=pulls`): an issue whose `pull_request` says merged/draft. */
const issueHitSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  user: userSchema,
  updated_at: z.string(),
  pull_request: z
    .object({ merged: z.boolean().default(false), draft: z.boolean().optional() })
    .nullable()
    .default(null),
});

function toSearchHit(raw: unknown, slug: string): PullSearchHit | null {
  const issue = issueHitSchema.safeParse(raw);
  if (issue.success) {
    const p = issue.data;
    return {
      slug: slug.toLowerCase(),
      number: p.number,
      title: p.title,
      state: pullStateOf(p.state, p.pull_request?.merged ?? false, isDraftPull(p.pull_request?.draft, p.title)),
      authorLogin: p.user?.login ?? null,
      updatedAt: p.updated_at,
      updatedAtUnix: unixOf(p.updated_at),
    };
  }
  return null;
}

/** A pull fetched by number, as a search hit. */
function pullToSearchHit(p: GiteaPull, slug: string): PullSearchHit {
  return {
    slug: slug.toLowerCase(),
    number: p.number,
    title: p.title,
    state: pullStateOf(p.state, p.merged, isDraftPull(p.draft, p.title)),
    authorLogin: p.user?.login ?? null,
    updatedAt: p.updated_at,
    updatedAtUnix: unixOf(p.updated_at),
  };
}

const SEARCH_LIMIT = 50;

/**
 * Search pulls of any state across `repos`, one request per repo in parallel.
 * A number query fetches that pull; anything else is the issue search
 * (`type=pulls`, title and body). `available: false` means `gt` can't be asked at all.
 */
async function searchPulls(
  query: string,
  repos: readonly { slug: string; cwd: string }[],
): Promise<SearchPullsResult> {
  const first = repos[0];
  if (first === undefined) return { available: true, pulls: [] };

  const numberMatch = /^#?(\d+)$/u.exec(query);
  const path = numberMatch !== null
    ? `pulls/${numberMatch[1] ?? ''}`
    : `issues?type=pulls&state=all&limit=${String(SEARCH_LIMIT)}&q=${encodeURIComponent(query)}`;
  const outputs = await Promise.all(repos.map((r) => runApi(repoPath(r.slug, path), r.cwd)));

  const pulls: PullSearchHit[] = [];
  outputs.forEach((stdout, i) => {
    const repo = repos[i];
    if (stdout === null || repo === undefined) return;
    if (numberMatch !== null) {
      const p = parsePull(stdout);
      if (p !== null) pulls.push(pullToSearchHit(p, repo.slug));
      return;
    }
    const raw = parseJson(stdout);
    for (const item of Array.isArray(raw) ? raw : []) {
      const hit = toSearchHit(item, repo.slug);
      if (hit !== null) pulls.push(hit);
    }
  });
  pulls.sort((a, b) => b.updatedAtUnix - a.updatedAtUnix);
  // Every repo failing is "not found" when `gt` works, "unavailable" when it doesn't.
  if (pulls.length === 0 && outputs.every((o) => o === null)) {
    const unavailable = await cliUnavailable('gt', first.cwd);
    return { available: unavailable === null, pulls, ...unavailableFields(unavailable) };
  }
  return { available: true, pulls: pulls.slice(0, SEARCH_LIMIT) };
}

async function currentLogin(cwd: string): Promise<string | null> {
  const stdout = await runApi('user', cwd);
  if (stdout === null) return null;
  const parsed = z.object({ login: z.string() }).safeParse(parseJson(stdout));
  return parsed.success && parsed.data.login !== '' ? parsed.data.login : null;
}

export const giteaForge: Forge = {
  kind: 'gitea',
  cli: 'gt',
  setupHint: 'Check that `gt` is installed, authenticated (`gt auth login`), and the pull request exists in this repo.',
  // Gitea keeps every pull's head here, open or not, even after its branch is deleted.
  pullHeadRef: (prNumber) => `refs/pull/${String(prNumber)}/head`,
  currentLogin,
  findOpenPrNumberForBranch,
  listOpenPulls,
  searchPulls,
  resolvePr,
  viewMergedPrCommits,
  viewPull,
};
