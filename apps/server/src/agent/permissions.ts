/**
 * Read-only, path-fenced enforcement for embedded agent runs. This is
 * non-negotiable, since these agents run against the user's real repo.
 *
 * The embedded agent (reading order, thread reply) gets **no shell at all**:
 *  - `disallowedTools` (set by each run's caller) includes `'Bash'` alongside
 *    the file-mutation tools, removing it outright.
 *  - `makeAgentCanUseTool({ cwd })` is the `canUseTool` callback: it
 *    auto-approves `Read`/`Grep`/`Glob` only when the path they'd touch
 *    resolves under the run's `cwd` (the attached root or agent worktree —
 *    see `worktree.ts`) and any Glob/Grep pattern stays relative to it,
 *    allows the `mcp__joinery__*` tools (the in-process app tools from
 *    `tools.ts`) the run kind may use, and denies everything else — an allowlist,
 *    not a blocklist, so a new tool the SDK adds tomorrow is denied by
 *    default.
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

const DENY = (message: string): PermissionResult => ({ behavior: 'deny', message });
const ALLOW = (input: Record<string, unknown>): PermissionResult => ({ behavior: 'allow', updatedInput: input });

/**
 * Resolve `candidate` (as `Read`/`Grep`/`Glob` would see it — absolute or
 * relative to `cwd`) to a real path, and check it under `cwd`'s real path.
 * Both sides go through `realpath` so a symlink inside `cwd` can't point
 * the agent outside it. `candidate` itself may not exist yet (`Glob`'s
 * `path` is often a directory that may or may not be there, and a `Read`
 * on a not-yet-existing file should still be fenced, not crash) — in that
 * case fall back to lexical resolution of `candidate` against the real
 * `cwd`, which still catches `../` escapes.
 */
async function isUnderCwd(candidate: string, cwd: string): Promise<boolean> {
  const realCwd = await realpath(cwd);
  const absolute = isAbsolute(candidate) ? candidate : join(cwd, candidate);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    real = resolve(absolute);
  }
  return real === realCwd || real.startsWith(realCwd.endsWith(sep) ? realCwd : `${realCwd}${sep}`);
}

/** An absolute pattern (`/…`, `~…`, `C:\\…`) or one with a `..` segment. */
function escapesBase(pattern: string): boolean {
  if (isAbsolute(pattern) || pattern.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(pattern)) return true;
  return pattern.split(/[\\/]/).includes('..');
}

export type MakeAgentCanUseToolOptions = {
  /** The run's cwd (attached root or agent worktree — `worktree.ts`). */
  readonly cwd: string;
  /**
   * The `joinery` tools this run kind may call, by bare name (`reply`,
   * `git_log`); all of them when absent. Every kind is *offered* the same
   * tools so their prompts share a cached prefix (`reviewContext.ts`), so
   * this is where a kind's narrower set is enforced.
   */
  readonly joineryTools?: ReadonlySet<string>;
};

/**
 * Builds the `canUseTool` callback for an embedded agent run.
 * `Read`/`Grep`/`Glob` are allowed only when the path they'd touch resolves
 * under `cwd`; an `mcp__joinery__*` tool (the in-process app tools, already
 * scoped to the run's review server side) is allowed when it is one of
 * `joineryTools`; everything else — including `Bash` and any future SDK
 * tool — is denied by default.
 */
export function makeAgentCanUseTool(options: MakeAgentCanUseToolOptions): CanUseTool {
  return async (toolName, input) => {
    if (toolName.startsWith('mcp__joinery__')) {
      const name = toolName.slice('mcp__joinery__'.length);
      return options.joineryTools === undefined || options.joineryTools.has(name)
        ? ALLOW(input)
        : DENY(`tool "${name}" is not part of this run's task`);
    }
    if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
      // Glob's `pattern` and Grep's `glob` are matched relative to `path`,
      // but an absolute or `..`-climbing pattern would reach past it — the
      // path check below alone doesn't see those.
      const pattern = toolName === 'Glob' ? input['pattern'] : toolName === 'Grep' ? input['glob'] : undefined;
      if (typeof pattern === 'string' && escapesBase(pattern)) {
        return DENY(`pattern "${pattern}" must be relative to this run's directory, without ".." (${options.cwd})`);
      }
      const raw = toolName === 'Read' ? input['file_path'] : input['path'];
      const candidate = typeof raw === 'string' ? raw : options.cwd;
      const allowed = await isUnderCwd(candidate, options.cwd);
      return allowed
        ? ALLOW(input)
        : DENY(`"${candidate}" is outside this run's directory (${options.cwd})`);
    }
    return DENY(`tool "${toolName}" is not permitted for this agent run (no shell)`);
  };
}
