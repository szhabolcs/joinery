#!/usr/bin/env bun
import { ApiError } from './client.ts';
import { UsageError } from './args.ts';
import { printLine } from './format.ts';
import * as repos from './commands/repos.ts';
import * as reviews from './commands/reviews.ts';
import * as readingOrder from './commands/reading-order.ts';
import * as threads from './commands/threads.ts';
import * as runCmd from './commands/run.ts';
import * as serveCmd from './commands/serve.ts';
import * as updateCmd from './commands/update.ts';
import * as serviceCmd from './commands/service.ts';
import * as openCmd from './commands/open.ts';
import * as permissionsCmd from './commands/permissions.ts';
import type { Command } from './commands/types.ts';
import { runtimeLayout } from '@joinery/server/runtime';

const VERSION = runtimeLayout().version;

const groups: Readonly<Record<string, Readonly<Record<string, Command>>>> = {
  repos: { list: repos.reposList, add: repos.reposAdd },
  'reading-order': { get: readingOrder.get, set: readingOrder.set, generate: readingOrder.generate, rules: readingOrder.rules },
};

const leaves: Readonly<Record<string, Command>> = {
  list: reviews.list,
  create: reviews.create,
  show: reviews.show,
  files: reviews.files,
  diff: reviews.diff,
  threads: threads.threads,
  thread: threads.thread,
  reply: threads.reply,
  resolve: threads.resolve,
  react: threads.react,
  comment: threads.comment,
  'delete-thread': threads.deleteThread,
  'delete-comment': threads.deleteComment,
  revision: reviews.revision,
  viewed: reviews.viewed,
  order: reviews.order,
  run: runCmd.run,
  serve: serveCmd.serve,
  update: updateCmd.update,
  service: serviceCmd.service,
  open: openCmd.open,
  permissions: permissionsCmd.permissions,
};

function allCommands(): Command[] {
  const out: Command[] = [];
  for (const group of Object.values(groups)) out.push(...Object.values(group));
  out.push(...Object.values(leaves));
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function printHelp(): void {
  printLine('joinery — local-first code review CLI');
  printLine('');
  printLine('usage: joinery <command> [args] [--json]');
  printLine('');
  for (const command of allCommands()) {
    printLine(`  ${command.usage}`);
    printLine(`      ${command.summary}`);
  }
  printLine('');
  printLine('global: --json (machine-readable output), --help, --version');
}

function printGroupHelp(name: string, group: Readonly<Record<string, Command>>): void {
  printLine(`usage: joinery ${name} <${Object.keys(group).join('|')}> ...`);
  for (const command of Object.values(group)) {
    printLine(`  ${command.usage}`);
    printLine(`      ${command.summary}`);
  }
}

async function dispatch(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return 0;
  }
  if (argv[0] === '--version') {
    printLine(VERSION);
    return 0;
  }

  const first = argv[0] as string;
  const group = groups[first];
  if (group !== undefined) {
    const second = argv[1];
    if (second === undefined || second === '--help' || second === '-h') {
      printGroupHelp(first, group);
      return second === undefined ? 2 : 0;
    }
    const command = group[second];
    if (command === undefined) {
      printLine(`unknown subcommand "${first} ${second}"`);
      printGroupHelp(first, group);
      return 2;
    }
    await command.run(argv.slice(2));
    return 0;
  }

  const leaf = leaves[first];
  if (leaf !== undefined) {
    await leaf.run(argv.slice(1));
    return 0;
  }

  printLine(`unknown command "${first}"`);
  printHelp();
  return 2;
}

async function main(): Promise<number> {
  try {
    return await dispatch(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    if (err instanceof ApiError) {
      process.stderr.write(`error: ${err.message}\n`);
      if (err.hint !== undefined) process.stderr.write(`hint: ${err.hint}\n`);
      return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
}

const exitCode = await main();
process.exit(exitCode);
