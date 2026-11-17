import { revisionSchema } from '@joinery/core';
import * as client from '../client.ts';
import { UsageError, flagBoolean } from '../args.ts';
import { printLine, printTable } from '../format.ts';
import type { Command } from './types.ts';
import { maybePrintJson, parseCommand, requireFlag, requirePositional, wantsHelp } from './shared.ts';

export const list: Command = {
  path: 'list',
  summary: 'List reviews',
  usage: 'joinery list [--json]',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(list.usage);
    const result = await client.listReviews();
    if (maybePrintJson(parsed, result)) return;
    if (result.reviews.length === 0) {
      printLine('no reviews yet — run `joinery create --branch <name>`');
      return;
    }
    printTable(
      ['ID', 'BRANCH', 'STATUS', 'REVISION'],
      result.reviews.map((r) => [r.id, r.branch ?? '(detached)', r.status, r.currentRevision ?? '(default)']),
    );
  },
};

export const create: Command = {
  path: 'create',
  summary: 'Create a review for a branch',
  usage: 'joinery create --branch <name> [--base <ref>] [--json]',
  async run(argv) {
    const parsed = parseCommand(argv, [
      { name: 'branch', type: 'string' },
      { name: 'base', type: 'string' },
    ]);
    if (wantsHelp(parsed)) return printLine(create.usage);
    const branch = requireFlag(parsed, 'branch');
    const base = parsed.flags['base'];
    const result = await client.createReview({
      repoPath: process.cwd(),
      branch,
      ...(typeof base === 'string' ? { base } : {}),
    });
    if (maybePrintJson(parsed, result)) return;
    printLine(`created review ${result.review.id} for branch ${branch}`);
  },
};

export const show: Command = {
  path: 'show',
  summary: 'Show a review',
  usage: 'joinery show <id> [--json]',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(show.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const result = await client.getReview(id);
    if (maybePrintJson(parsed, result)) return;
    printLine(`review    ${result.review.id}`);
    printLine(`repo      ${result.repo.rootPath}`);
    printLine(`branch    ${result.review.branch ?? '(detached)'}`);
    printLine(`status    ${result.review.status}`);
    printLine(`revision  ${result.state.currentRevision} (available: ${result.state.availableRevisions.join(', ')})`);
  },
};

export const files: Command = {
  path: 'files',
  summary: 'List changed files for a review',
  usage: 'joinery files <id> [--json]',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(files.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const result = await client.getFiles(id);
    if (maybePrintJson(parsed, result)) return;
    if (result.list.files.length === 0) {
      printLine('no changed files');
      return;
    }
    printTable(
      ['STATUS', 'PATH', '+/-'],
      result.list.files.map((f) => [
        f.status,
        f.path,
        f.binary ? 'binary' : `+${f.additions ?? 0}/-${f.deletions ?? 0}`,
      ]),
    );
  },
};

export const diff: Command = {
  path: 'diff',
  summary: 'Show the patch for one file',
  usage: 'joinery diff <id> <path> [--rev working|head|pr] [--json]',
  async run(argv) {
    const parsed = parseCommand(argv, [{ name: 'rev', type: 'string' }]);
    if (wantsHelp(parsed)) return printLine(diff.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const path = requirePositional(parsed.positionals, 1, 'path');
    const revRaw = parsed.flags['rev'];
    const rev = typeof revRaw === 'string' ? revisionSchema.parse(revRaw) : undefined;
    const result = await client.getDiff(id, { path, ...(rev !== undefined ? { rev } : {}) });
    if (maybePrintJson(parsed, result)) return;
    process.stdout.write(result.patch.patch);
    if (!result.patch.patch.endsWith('\n')) process.stdout.write('\n');
  },
};

export const revision: Command = {
  path: 'revision',
  summary: 'Switch the review revision',
  usage: 'joinery revision <id> <working|head|pr> [--json]',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(revision.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const revRaw = requirePositional(parsed.positionals, 1, 'working|head|pr');
    const parsedRev = revisionSchema.safeParse(revRaw);
    if (!parsedRev.success) {
      throw new UsageError(`invalid revision "${revRaw}" — expected working, head, or pr`);
    }
    const result = await client.setRevision(id, { revision: parsedRev.data });
    if (maybePrintJson(parsed, result)) return;
    printLine(`revision set to ${result.state.currentRevision}`);
  },
};

export const viewed: Command = {
  path: 'viewed',
  summary: 'Mark a file viewed',
  usage: 'joinery viewed <id> <path> [--json]',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(viewed.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const path = requirePositional(parsed.positionals, 1, 'path');
    const result = await client.markViewed(id, path);
    if (maybePrintJson(parsed, result)) return;
    printLine(`marked ${path} viewed`);
  },
};

export const order: Command = {
  path: 'order',
  summary: "Show or set Homebase's custom order of reviews",
  usage: 'joinery order [<id>...] [--replace] [--json]',
  async run(argv) {
    const parsed = parseCommand(argv, [{ name: 'replace', type: 'boolean' }]);
    if (wantsHelp(parsed)) return printLine(order.usage);
    const ids = parsed.positionals;
    if (ids.length === 0 && flagBoolean(parsed.flags, 'replace')) {
      throw new UsageError('--replace needs the review ids, in order');
    }
    // No ids: show it. Ids: put them on top in that order, or make them the whole order (--replace).
    const result =
      ids.length === 0
        ? await client.getReviewOrder()
        : await client.setReviewOrder({ reviewIds: [...ids], mode: flagBoolean(parsed.flags, 'replace') ? 'replace' : 'first' });
    if (maybePrintJson(parsed, result)) return;
    const unknown = ids.filter((id) => !result.reviewIds.includes(id));
    if (unknown.length > 0) printLine(`skipped (no such review, or archived): ${unknown.join(', ')}`);
    if (result.reviewIds.length === 0) {
      printLine('no custom order yet — Homebase shows reviews lightest first until one is set');
      return;
    }
    const branches = new Map((await client.listReviews()).reviews.map((r) => [r.id, r.branch ?? '(detached)'] as const));
    printTable(
      ['#', 'ID', 'BRANCH'],
      result.reviewIds.map((id, i) => [String(i + 1), id, branches.get(id) ?? '']),
    );
  },
};
