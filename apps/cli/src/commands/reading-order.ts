import { readFileSync } from 'node:fs';
import { AGENT_MODELS, READING_ORDER_RULES, agentModelSchema } from '@joinery/core';
import * as client from '../client.ts';
import { UsageError, flagString } from '../args.ts';
import { printLine, printTable } from '../format.ts';
import { PlanValidationError, parsePlan } from '../plan.ts';
import type { Command } from './types.ts';
import { maybePrintJson, parseCommand, requireFlag, requirePositional, wantsHelp } from './shared.ts';

export const get: Command = {
  path: 'reading-order get',
  summary: 'Show the reading order',
  usage: 'joinery reading-order get <id> [--json]',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(get.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const result = await client.getReadingOrder(id);
    if (maybePrintJson(parsed, result)) return;
    if (result.readingOrder === null) {
      printLine('no reading order yet — run `joinery reading-order generate <id>`');
      return;
    }
    printTable(
      ['#', 'TITLE', 'FILES'],
      result.readingOrder.steps.map((s) => [String(s.idx), s.title, String(s.files.length)]),
    );
    if (result.readingOrder.unassignedPaths.length > 0) {
      printLine(`unassigned: ${result.readingOrder.unassignedPaths.join(', ')}`);
    }
  },
};

export const set: Command = {
  path: 'reading-order set',
  summary: 'Set the reading order from a plan file',
  usage: 'joinery reading-order set <id> --file plan.json [--json]',
  async run(argv) {
    const parsed = parseCommand(argv, [{ name: 'file', type: 'string' }]);
    if (wantsHelp(parsed)) return printLine(set.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const filePath = requireFlag(parsed, 'file');

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new UsageError(`could not read ${filePath}: ${reason}`);
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new UsageError(`${filePath} is not valid JSON: ${reason}`);
    }

    let plan;
    try {
      plan = parsePlan(json);
    } catch (err) {
      if (err instanceof PlanValidationError) {
        throw new UsageError(`${filePath} does not match the reading-order plan shape:\n${err.message}`);
      }
      throw err;
    }

    const result = await client.setReadingOrder(id, plan);
    if (maybePrintJson(parsed, result)) return;
    printLine(`reading order set: ${result.readingOrder.steps.length} steps`);
  },
};

export const generate: Command = {
  path: 'reading-order generate',
  summary: 'Ask an agent to generate the reading order',
  usage: 'joinery reading-order generate <id> [--model <model>] [--json]',
  async run(argv) {
    const parsed = parseCommand(argv, [{ name: 'model', type: 'string' }]);
    if (wantsHelp(parsed)) return printLine(generate.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const rawModel = flagString(parsed.flags, 'model');
    const model = rawModel === undefined ? undefined : agentModelSchema.safeParse(rawModel);
    if (model !== undefined && !model.success) {
      throw new UsageError(`not a model id: "${rawModel}"; use a family (${AGENT_MODELS.map((m) => m.id).join(', ')}) or an exact id`);
    }
    const result = await client.generateReadingOrder(id, model?.data);
    if (maybePrintJson(parsed, result)) return;
    printLine(`started run ${result.run.id} (${result.run.status})`);
  },
};

export const rules: Command = {
  path: 'reading-order rules',
  summary: 'Print the rules for writing a reading order',
  usage: 'joinery reading-order rules',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(rules.usage);
    printLine(READING_ORDER_RULES);
  },
};
