/**
 * The single `git()` runner every invocation in this package goes through.
 *
 * Two rules, both non-negotiable:
 *
 * 1. `GIT_OPTIONAL_LOCKS=0` on every call, always, no escape hatch. A
 *    read-only observer must never take `index.lock` and never make the
 *    user's or an agent's git command wait. This has a measured cost (status
 *    goes 82 ms → 581 ms after a mass mtime change, settling around 250 ms)
 *    and that is the correct trade — do not "fix" it by dropping the flag.
 * 2. A read-only subcommand allowlist, plus a narrow write allowlist:
 *    - `worktree add --detach <sha> <path>`, with `<path>` required to
 *      resolve under the configured data directory.
 *    - `update-ref refs/review/<id> ...` (including `-d` deletes), with the
 *      ref required to start with `refs/review/`.
 *    - `checkout --detach --force <sha>`, only with `cwd` under the data
 *      directory: it moves a worktree of ours (the language servers'
 *      checkouts, `lsp/checkouts.ts`) to another commit, never a branch and
 *      never the user's own checkout.
 *    Anything else throws before a process is ever spawned.
 *
 * Scoped worktree *registry-entry* deletion (`rm -rf` the directory under
 * `data/worktrees`, then delete exactly `$GIT_COMMON_DIR/worktrees/<our-name>`)
 * is a filesystem operation,
 * not a git subcommand — there is no `git worktree prune <path>`, and
 * manual `rm -rf` is the prescribed approach precisely because it must work
 * even when the directory is already gone or `git worktree remove` would
 * refuse. That cleanup therefore lives in `worktree.ts` using `node:fs`
 * directly, not through this allowlist.
 */

import { resolve, sep } from 'node:path';

export type GitResult = {
  stdout: Uint8Array;
  stderr: string;
  exitCode: number;
};

export class GitError extends Error {
  readonly subcommand: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderrText: string;

  constructor(subcommand: string, args: readonly string[], exitCode: number, stderrText: string) {
    super(`git ${args.join(' ')} exited ${exitCode}: ${stderrText.trim() || '(no stderr)'}`);
    this.name = 'GitError';
    this.subcommand = subcommand;
    this.args = args;
    this.exitCode = exitCode;
    this.stderrText = stderrText;
  }
}

/** Thrown when an invocation is not on either allowlist. Never caught and retried. */
export class GitNotAllowedError extends Error {
  constructor(args: readonly string[], reason: string) {
    super(`git invocation not allowed: ${reason} (args: ${args.join(' ')})`);
    this.name = 'GitNotAllowedError';
  }
}

const READ_ONLY_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'rev-list',
  'rev-parse',
  'merge-base',
  'cat-file',
  'hash-object',
  'ls-files',
  'check-attr',
  'config',
  'symbolic-ref',
  'branch',
  'remote',
  'show',
  'blame',
  'grep',
  // Added for the engine's remote poll: always called
  // with `--no-write-fetch-head` and never writes the working tree, index,
  // or any ref outside `refs/remotes/*` / the explicit refspec given.
  'fetch',
  // Added for branch discovery: reads refs and
  // their metadata, writes nothing — strictly read-only, like `branch`
  // above, just with a machine-readable format and no ref-listing limits.
  'for-each-ref',
  // The repo poll asks the remote which branch is its default (`--symref
  // origin HEAD`): a network read, writes nothing.
  'ls-remote',
]);

export type GitCallOptions = {
  cwd: string;
  /**
   * Required for write calls: the data directory writes are scoped under.
   * Ignored for read-only calls.
   */
  dataDir?: string;
  /** Extra environment variables, merged over the inherited environment. */
  env?: Record<string, string>;
  /** Data written to the process's stdin, e.g. for `hash-object --stdin-paths`. */
  stdin?: string;
  /** Kill the process after this long (it then reports a non-zero exit). For network calls (`fetch`). */
  timeoutMs?: number;
};

/**
 * Validate an invocation against the allowlists. Throws `GitNotAllowedError`
 * if it matches neither. Exported so `catfile.ts` — which spawns its own
 * long-lived process rather than going through `run()` — can reuse the same
 * check for `cat-file --batch`.
 */
export function assertAllowed(args: readonly string[], dataDir: string | undefined, cwd?: string): void {
  const sub = args[0];
  if (sub === undefined) {
    throw new GitNotAllowedError(args, 'empty argument list');
  }

  if (READ_ONLY_SUBCOMMANDS.has(sub)) {
    return;
  }

  if (sub === 'worktree') {
    const action = args[1];
    if (action === 'list') {
      return; // `git worktree list --porcelain` — read-only.
    }
    if (action === 'add') {
      validateWorktreeAdd(args, dataDir);
      return;
    }
    throw new GitNotAllowedError(args, `worktree subaction "${String(action)}" is not allowed`);
  }

  if (sub === 'update-ref') {
    validateUpdateRef(args);
    return;
  }

  if (sub === 'checkout') {
    validateCheckout(args, dataDir, cwd);
    return;
  }

  throw new GitNotAllowedError(args, `subcommand "${sub}" is not on the read or write allowlist`);
}

function validateWorktreeAdd(args: readonly string[], dataDir: string | undefined): void {
  if (dataDir === undefined) {
    throw new GitNotAllowedError(args, 'worktree add requires dataDir to be set for scoping');
  }
  if (!args.includes('--detach')) {
    throw new GitNotAllowedError(args, 'worktree add must be --detach (a review never holds a branch)');
  }
  // Expected shape: worktree add --detach [--force] <path> <sha>  (git
  // accepts either order for the trailing operands, but we always call it as
  // path then sha). `--force` only re-adds a path of ours whose directory was
  // deleted while git's registry entry stayed behind.
  const rest = args.slice(2).filter((a) => a !== '--detach' && a !== '--force');
  const path = rest[0];
  if (path === undefined || path.startsWith('-')) {
    throw new GitNotAllowedError(args, 'worktree add missing target path');
  }
  // Resolved, so `<dataDir>/../elsewhere` can't pass the prefix check.
  const resolvedDataDir = `${resolve(dataDir)}${sep}`;
  const resolvedPath = `${resolve(path)}${sep}`;
  if (!resolvedPath.startsWith(resolvedDataDir)) {
    throw new GitNotAllowedError(args, `worktree add target must be under data dir ${dataDir}`);
  }
}

function validateCheckout(args: readonly string[], dataDir: string | undefined, cwd: string | undefined): void {
  // Exactly: checkout --detach --force <full sha>. No paths, no branches.
  if (args.length !== 4 || args[1] !== '--detach' || args[2] !== '--force' || !/^[0-9a-f]{40,64}$/u.test(args[3] ?? '')) {
    throw new GitNotAllowedError(args, 'checkout is only allowed as `checkout --detach --force <sha>`');
  }
  if (dataDir === undefined || cwd === undefined || !`${resolve(cwd)}${sep}`.startsWith(`${resolve(dataDir)}${sep}`)) {
    throw new GitNotAllowedError(args, 'checkout is only allowed in a worktree under the data dir');
  }
}

function validateUpdateRef(args: readonly string[]): void {
  // Accept: update-ref [-d] refs/review/<...> [<sha>]
  const rest = args.slice(1);
  const isDelete = rest[0] === '-d';
  const ref = isDelete ? rest[1] : rest[0];
  if (ref === undefined || !ref.startsWith('refs/review/')) {
    throw new GitNotAllowedError(args, 'update-ref is only allowed for refs/review/*');
  }
}

/**
 * Run git, returning the result regardless of exit code. Callers that treat
 * a non-zero exit as expected (e.g. `merge-base` finding nothing) should use
 * this; everyone else should use `gitOrThrow`.
 *
 * A spawn failure (most often: `cwd` no longer exists because the repo or
 * worktree was deleted) is reported as exit code -1 rather than thrown, so
 * it degrades exactly like any other failed git call.
 */
export async function git(args: readonly string[], options: GitCallOptions): Promise<GitResult> {
  assertAllowed(args, options.dataDir, options.cwd);

  let proc;
  try {
    proc = Bun.spawn(['git', ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        GIT_OPTIONAL_LOCKS: '0',
        // Nobody can answer a credential prompt; fail instead of waiting.
        GIT_TERMINAL_PROMPT: '0',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
  } catch (err) {
    return { stdout: new Uint8Array(0), stderr: err instanceof Error ? err.message : String(err), exitCode: -1 };
  }

  // Always close stdin, even when there's nothing to write: any subcommand
  // that unexpectedly tries to read from it gets EOF immediately rather than
  // hanging, and the ones we actually feed (hash-object --stdin-paths) get
  // their input.
  if (options.stdin !== undefined) {
    proc.stdin.write(options.stdin);
  }
  proc.stdin.end();

  const [stdoutBuffer, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout: new Uint8Array(stdoutBuffer), stderr, exitCode };
}

/** Like `git`, but throws a typed `GitError` on non-zero exit. */
export async function gitOrThrow(args: readonly string[], options: GitCallOptions): Promise<GitResult> {
  const result = await git(args, options);
  if (result.exitCode !== 0) {
    throw new GitError(args[0] ?? '(none)', args, result.exitCode, result.stderr);
  }
  return result;
}

const decoder = new TextDecoder();

export function bytesToText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
