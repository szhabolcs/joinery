/**
 * Read-only git tools (`mcp__joinery__git_log`, `git_show`, `git_blame`):
 * an in-process MCP server of their own for the reading-order agent, and
 * merged into the review tools' server for the thread agent. Neither agent
 * has a shell, so this is how they read history.
 *
 * Strictly read-only by construction: the subcommand is fixed per tool, the
 * arguments are built as an array (no shell), every model-supplied value is
 * validated so it can never be read as an option (git's diff family accepts
 * `--output=<file>`), and paths go after `--`. Everything runs through the
 * `git()` runner and its allowlist, in the run's `cwd`, with capped output.
 */
import { isAbsolute } from 'node:path';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { bytesToText, git } from '../git/run.ts';
import { trimToLines } from './tools.ts';

const MAX_LINES = 400;
const MAX_CHARS = 40_000;

/** A revision expression: no leading `-`, no whitespace or shell-ish characters. */
const refSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_./~^@{}:+-]+$/, 'not a valid revision')
  .refine((s) => !s.startsWith('-'), 'a revision cannot start with "-"');

/** A repo-relative path: not absolute, no `..` segment, no leading `-`. */
const pathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((s) => !s.startsWith('/') && !isAbsolute(s) && !/^[a-zA-Z]:/.test(s) && !s.startsWith('-') && !s.split(/[\\/]/).includes('..'), 'must be a relative path inside the repo');

function textResult(text: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): { content: [{ type: 'text'; text: string }]; isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

export function createGitTools(options: { readonly cwd: string }): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: 'joinery', tools: gitToolDefinitions(options) });
}

/** The tools on their own, for merging into another `joinery` server. */
export function gitToolDefinitions(options: { readonly cwd: string }): SdkMcpToolDefinition<any>[] {
  async function run(args: string[]) {
    const result = await git(args, { cwd: options.cwd, timeoutMs: 20_000 });
    if (result.exitCode !== 0) return errorResult(`git ${args[0] ?? ''} failed: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`);
    let text = trimToLines(bytesToText(result.stdout), MAX_LINES);
    if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n… (truncated at ${String(MAX_CHARS)} characters)`;
    return textResult(text.length > 0 ? text : '(no output)');
  }

  return [
    tool(
      'git_log',
      'Read-only `git log` in the review root: recent commits (hash, author, date, subject), optionally limited to one path or starting from a revision. At most 50 commits.',
      { path: pathSchema.optional(), ref: refSchema.optional(), maxCount: z.number().int().min(1).max(50).default(20) },
      async ({ path, ref, maxCount }) =>
        run([
          'log',
          '--no-color',
          '--no-ext-diff',
          '--format=%h %an %ad %s',
          '--date=short',
          `--max-count=${String(maxCount)}`,
          ...(ref === undefined ? [] : [ref]),
          ...(path === undefined ? [] : ['--', path]),
        ]),
    ),
    tool(
      'git_show',
      'Read-only `git show` in the review root: one commit with its message and patch, optionally limited to one path. Output is trimmed.',
      { ref: refSchema, path: pathSchema.optional() },
      async ({ ref, path }) =>
        run(['show', '--no-color', '--no-ext-diff', '--no-textconv', ref, ...(path === undefined ? [] : ['--', path])]),
    ),
    tool(
      'git_blame',
      'Read-only `git blame` in the review root: who last changed each line of a file, optionally for a line range and a revision. Output is trimmed.',
      {
        path: pathSchema,
        ref: refSchema.optional(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      },
      async ({ path, ref, startLine, endLine }) => {
        if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
          return errorResult('endLine must not be before startLine');
        }
        const range = startLine === undefined && endLine === undefined ? [] : ['-L', `${String(startLine ?? 1)},${endLine === undefined ? '' : String(endLine)}`];
        return run(['blame', '--no-color', ...range, ...(ref === undefined ? [] : [ref]), '--', path]);
      },
    ),
  ];
}
