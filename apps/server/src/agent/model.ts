/**
 * Which Claude models the pickers offer, asked of the local Claude Code
 * rather than written down here, so a new model shows up without a Joinery
 * release.
 *
 * - The list is Claude Code's own (`supportedModels()`), kept to its family
 *   aliases (`opus`, `fable`, ...): an alias is always that family's newest
 *   model, so a remembered pick follows new releases by itself.
 * - It comes from the user's `claude` on PATH when there is one (the newest
 *   Claude Code on the machine), else the SDK's bundled one.
 * - Stored like `me` (`storedCache.ts`): instant after the first ask, and
 *   re-asked in the background every few hours.
 * - A run is started on the exact model an alias stands for today
 *   (`resolveAgentModel`), so the bundled Claude Code in dev runs the same
 *   model the picker named, even where its own alias table is older.
 */
import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_MODELS, DEFAULT_AGENT_MODEL, type AgentModel, type AgentModelOption } from '@joinery/core';
import { claudeExecutableOption, findClaudeExecutable } from './claudeExecutable.ts';
import { createStoredCache, type StoredCacheDeps } from '../storedCache.ts';

/**
 * The Claude model used for thread replies when the request names none.
 * Replies normally carry the model picked in the composer; this is
 * the fallback, and matches the picker's default.
 */
export const AGENT_MODEL_ID: AgentModel = DEFAULT_AGENT_MODEL;

/** Picker order: most capable first. Families not listed here go after, in Claude Code's order. */
const FAMILY_ORDER = ['fable', 'opus', 'sonnet', 'haiku'];
const LIST_TIMEOUT_MS = 20_000;

const modelsCache = createStoredCache<AgentModelOption[]>({
  namespace: 'agent-models',
  version: 1,
  staleAfterMs: 6 * 60 * 60_000,
  // A failed ask (no login, no network) never replaces a list that worked.
  keepPrevious: (next, previous) => next.length === 0 && previous.length > 0,
});

/** The last list this process saw, for `resolveAgentModel`. */
let lastKnown: readonly AgentModelOption[] = [];

/** The pickers' models; the static aliases when Claude Code can't be asked. */
export async function listAgentModels(deps: StoredCacheDeps): Promise<AgentModelOption[]> {
  const models = await modelsCache.get(deps, 'all', askClaudeCode);
  if (models.length === 0) return [...AGENT_MODELS];
  lastKnown = models;
  return models;
}

/** The exact model to run for `model`: what its alias resolves to today, or `model` itself. */
export function resolveAgentModel(model: AgentModel): AgentModel {
  return lastKnown.find((m) => m.id === model)?.resolved ?? model;
}

/** Claude Code's model rows, as picker entries. Empty on any failure. */
async function askClaudeCode(): Promise<AgentModelOption[]> {
  const path = findClaudeExecutable();
  let executable: { pathToClaudeCodeExecutable?: string };
  try {
    executable = path === null ? claudeExecutableOption() : { pathToClaudeCodeExecutable: path };
  } catch {
    return [];
  }
  // A prompt that never sends a message: the CLI starts and answers control
  // requests, but no turn (and no API call) ever runs.
  let release = (): void => {};
  const idle = (async function* (): AsyncGenerator<never> {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  })();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), LIST_TIMEOUT_MS);
  const session = query({
    prompt: idle,
    options: { ...executable, abortController, settingSources: [], persistSession: false },
  });
  try {
    return toOptions(await session.supportedModels());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    release();
    session.close();
  }
}

/** Keep the family aliases (not `default`, not pinned ids), labelled with the version they stand for. */
function toOptions(rows: readonly ModelInfo[]): AgentModelOption[] {
  const options = rows
    .filter((row) => /^[a-z]+$/u.test(row.value) && row.value !== 'default')
    .map((row): AgentModelOption => ({ id: row.value, label: labelOf(row), resolved: row.resolvedModel ?? null }));
  const rank = (id: string): number => {
    const i = FAMILY_ORDER.indexOf(id);
    return i === -1 ? FAMILY_ORDER.length : i;
  };
  return options.map((o, i) => ({ o, i })).sort((a, b) => rank(a.o.id) - rank(b.o.id) || a.i - b.i).map(({ o }) => o);
}

/**
 * "Opus 5.5". Newer Claude Code puts the version in `displayName`; older
 * releases name only the family there and lead the description with it
 * ("Opus 5 · Best for everyday, complex tasks").
 */
function labelOf(row: ModelInfo): string {
  if (/\d/u.test(row.displayName)) return row.displayName;
  const lead = row.description.split(' · ')[0]?.trim() ?? '';
  return /\d/u.test(lead) && lead.length <= 24 ? lead : row.displayName;
}
