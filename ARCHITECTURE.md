# Joinery architecture

Joinery is a local-first code review app. A Bun server does everything
expensive: git, worktrees, Agent SDK runs, language servers and SQLite. A
browser app talks to it over HTTP and a WebSocket. This file lists the rules
the code depends on. The code itself is the reference for everything else.

```
apps/server    Bun + Hono + bun:sqlite: git, engine, agent runs, LSP, event bus
apps/web       Vite + React 19 + Tailwind v4 + Base UI, @pierre/diffs and @pierre/trees
apps/cli       `joinery`, a thin client over the HTTP API (`--json` everywhere), ships SKILL.md
packages/core  zod schemas shared by all three
```

- The server listens on `127.0.0.1:7317` only. It uses a bearer token in `data/token` (mode 0600).
- All state lives in `data/` inside the app, or `JOINERY_DATA_DIR`, never in dot-folders. `data/` is gitignored; never `git add -f` it.
- Agents reach the app through the CLI, the HTTP API and `SKILL.md`. There is no MCP server for outside agents.
- macOS and linux only for now.

## Reviews

- **A review is `(repo, branch)`**, not a PR and not a directory.
  - A PR attaches to an existing review later as metadata, and adds the `pr` revision.
  - A review of detached work starts as `(repo, sha)` and adopts a branch when one points into its history.
- **Revisions:**
  - `working`: the live tree, including untracked files. It exists only while the branch is checked out somewhere.
  - `head`: the branch's committed tip.
  - `pr`: the PR's head.
  - Each one diffs against `merge-base(origin/<baseRef>, rev)`.
  - Comparisons are always three-dot. Two-dot shows your own commits as deletions.
- **Where code comes from:**
  - If the branch is checked out (in any worktree, wherever it lives), we attach to that directory in place.
  - Otherwise everything renders from the object store (`diff`, `cat-file --batch`, `grep` on a SHA). We never create a checkout just to look at code.
  - `refs/review/<id>` pins the reviewed commit so it survives GC.
- **Our checkouts are caches, never state:**
  - Agent runs with no attached root get a detached worktree under `data/worktrees/`, keyed by `(repo, sha)`. They are swept after an hour unused, or as soon as the branch gets a newer commit.
  - Language servers get detached checkouts under `data/worktrees/lsp/`.
  - Deleting any of them costs one rebuild.
- **A review never holds a branch.** Every worktree we create is `--detach`, so nothing Joinery does can block you or an agent from checking out a branch.
- **Never touch worktrees we didn't create:**
  - No `git worktree prune`, which is global and destroys moved worktrees.
  - No repair, move or remove on someone else's worktree.
  - Cleanup of our own is scoped: delete the directory, then delete exactly our `$GIT_COMMON_DIR/worktrees/<name>` entry.
- **Paths are compared as realpaths.** Git reports `/private/tmp`, not `/tmp`.
- Worktrees are found with `git worktree list --porcelain`, never by scanning the disk.

## The engine (`apps/server/src/engine`)

- **The sorted file list is the state:**
  - Each entry is `{ path, status, old_blob, new_blob }`, plus the base and head SHAs.
  - Change detection compares the new list with the old one; the set difference is the delta.
  - There is no digest, no snapshot protocol and no cache invalidation.
  - Pierre's `cacheKey` is the blob SHA, so new content always gets a new key. Do not write invalidation code.
- **Detectors and ticks:**
  - There are two recursive watches (the attached root and `$GIT_COMMON_DIR`) plus one remote poll per repo (`repoPoller.ts`).
  - Event payloads are ignored. Any signal just schedules a debounced tick (150 ms trailing, 1 s ceiling).
  - A tick is root resolution, then `git status --porcelain=v2 --branch`, then one `hash-object` over the dirty paths. It stops early if the list is unchanged.
  - The remote poll also fetches the default branch; otherwise the base silently drifts as main moves.
- **Revisions and mid-operation states:**
  - All three revisions are kept warm, and each detector rebuilds only the revisions it can affect. Switching revision is a cache read.
  - During a rebase, merge, cherry-pick or bisect, the engine holds the last good list and shows a chip instead of flapping.
- **One writer:**
  - Base and head are decided only in `engine/reviewState.ts` and stored in `review_state` and `repo_state`.
  - Homebase and the API only read them.
  - Every write bumps a version and publishes `topic.changed` after commit.
- **Serialization:** there is one actor per review and ticks run one at a time.
- **Read-only observer:**
  - Every git call sets `GIT_OPTIONAL_LOCKS=0`, so we never take `index.lock`. Don't drop it to make `status` faster.
  - Our only writes are `worktree add --detach` under `data/worktrees`, `checkout --detach` inside our own checkouts, `update-ref refs/review/*`, and scoped removal of our own registry entries.
  - Every other git call goes through the read-only allowlist in `git/run.ts`.
- **Never automatic:**
  - Never switch revision automatically. Remote movement shows a chip.
  - Never auto-scroll. Updates restore a `(path, side, line)` anchor, not a pixel offset.
  - A scroll the reader starts (⌘⇧-click to a definition, stepping its jump history) isn't automatic. Jumps keep the same kind of anchor.
  - Never resolve, delete or hide a thread.
  - Refresh is staged ("N files updated · Refresh"), never applied under the cursor.
- **Remote ahead (`0 N`) and diverged states get a loud banner.** Reviewing stale code is the worst failure.
- **Transport (`WS /api/events`):**
  - Clients `watch` topics: `home`, `repo:<id>` and `review:<id>`.
  - `topic.changed` carries only a version; the client refetches through the normal API.
  - A review topic also streams file lists (tagged by revision), `root.rebound`, `thread.*` and `run.*`.
  - The browser never polls. Reconnecting just asks for the list again.
- **Forges:** everything host-specific sits behind one `Forge` seam (`git/forge/`, picked by `forgeFor(repo)`). Nothing outside that module calls `gh`/`glab` or hard-codes `refs/pull/`.

## Threads, viewed state, reading order

- **Comments are local only.** SQLite is the only record, and nothing is posted to GitHub.
  - So threads can sit on any line, including uncommitted code, and they survive rebases.
  - `joinery threads --markdown` is the way to share a review.
- **Thread anchors:**
  - An anchor is `(path, side, line range, blob SHA, hash of ±3 context lines)`.
  - When the blob changes, the thread relocates by context hash. If that fails, it is marked `outdated` and kept. A thread is never deleted because the code moved.
  - Re-anchoring writes back only for the review's persisted revision. Other revisions project positions at read time (`GET /threads?rev=`).
- **Viewed state:** `file_viewed` is keyed by `(review, path, blob_sha)`, so a changed file un-views itself.
- **Renames:** a rename rewrites `thread.path` and `file_viewed.path` in the same transaction.
- **Reading order:**
  - Agent-generated, one per review. Regenerating replaces it.
  - There is no step-level progress; progress is per-file viewed checks.
  - The file tree is static (changed files only) and never reorders to follow the reading order.

## Agents (`apps/server/src/agent`)

- **Runs:**
  - Each run is one `query()`. The request returns at once with a `running` run.
  - Progress goes out as `run.started`, `run.activity` and `run.ended`.
  - A run's messages are stored in `agent_event` for inspection (`joinery run <id>`).
  - A server restart marks in-flight runs `error`.
  - Concurrency is unlimited, and nothing triggers an agent automatically.
- **The agent is read-only and has no shell:**
  - `disallowedTools` includes `Write`, `Edit`, `NotebookEdit` and `Bash`.
  - `canUseTool` allows only `Read`/`Grep`/`Glob` inside the run's `cwd`, plus the in-process `joinery` tools (`tools.ts`, thin wrappers over the HTTP routes, scoped to the run's review) and the read-only git tools (`gitTools.ts`).
  - Everything else, including tools the SDK adds later, is denied.
- **Settings:**
  - `settingSources: []`, so the reviewed repo's `.claude` settings can't grant tools.
  - `cwd` is the attached root, or else a cached agent worktree.

## Rendering (`apps/web`)

- **Diff view:**
  - There is one Pierre `CodeView` per review, never one `FileDiff` per file.
  - Items keep a stable identity. A content change mutates the item in place and bumps `version`.
  - Never call `parsePatchFiles` during render.
- **Highlighting and themes:**
  - `cacheKey` is the blob SHA everywhere.
  - Highlighting runs in a worker pool, and the pool owns the diff theme (`setRenderOptions`).
  - All 75 themes load lazily.
- **Data loading:**
  - The file list ships first, and per-file patches load on demand.
  - Blob reads are always batched into one `cat-file --batch`.
- **Large files:**
  - Binary files are stubs.
  - Files over 2,000 lines or 500 KB, and generated or vendored files, start collapsed.
  - Submodules are ignored.
- **Budget:** on a 300-file review, the file list renders in under 200 ms and the first visible file is highlighted in under 500 ms. Anything that makes either number worse is a regression.
- **UI conventions:** see `CLAUDE.md`.
