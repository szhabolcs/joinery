/**
 * Remembered model picks, kept across reloads.
 *
 * - The Ask pick: one choice shared by every "Ask" button (composer and
 *   thread card), so picking Opus once means the next Ask uses Opus too.
 * - The generation pick: the model the last reading order was generated
 *   with, shared by the reading-order pane's "Generate with" button and the
 *   command palette's generate page. Null until a first generation.
 */
import {
  AGENT_MODELS,
  agentModelSchema,
  DEFAULT_AGENT_MODEL,
  findAgentModel,
  type AgentModel,
  type AgentModelOption,
} from '@joinery/core';
import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { callApi } from './apiClient.ts';

function modelStore<T extends AgentModel | null>(key: string, fallback: T) {
  const listeners = new Set<() => void>();

  let current: AgentModel | T = fallback;
  try {
    const parsed = agentModelSchema.safeParse(localStorage.getItem(key));
    // A pick stored as an exact id (`claude-opus-5-5`) becomes its family's alias.
    if (parsed.success) current = findAgentModel(AGENT_MODELS, parsed.data)?.id ?? parsed.data;
  } catch {
    // No storage: start from the fallback.
  }

  const get = (): AgentModel | T => current;

  const set = (model: AgentModel): void => {
    current = model;
    try {
      localStorage.setItem(key, model);
    } catch {
      // Best-effort only.
    }
    for (const l of listeners) l();
  };

  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };

  const use = (): AgentModel | T => useSyncExternalStore(subscribe, get);

  return { get, set, use };
}

const askModel = modelStore('joinery:agent-model', DEFAULT_AGENT_MODEL);

/** The current Ask pick, for request bodies built outside React. */
export const getAgentModel: () => AgentModel = askModel.get;
export const setAgentModel: (model: AgentModel) => void = askModel.set;
export const useAgentModel: () => AgentModel = askModel.use;

const generationModel = modelStore('joinery:generation-model', null);

/** The model the last reading order was generated with; null before the first. */
export const getGenerationModel: () => AgentModel | null = generationModel.get;
export const setGenerationModel: (model: AgentModel) => void = generationModel.set;
export const useGenerationModel: () => AgentModel | null = generationModel.use;

/**
 * The pickers' models, as the server's Claude Code reports them (newest
 * first, by family). The static aliases until that answer is in.
 */
export function useAgentModels(): readonly AgentModelOption[] {
  const query = useQuery({
    queryKey: ['models'],
    queryFn: async () => (await callApi('listAgentModels')).models,
    staleTime: 60 * 60_000,
  });
  return query.data ?? AGENT_MODELS;
}

/** The picker label for `model`: its version when known ("Opus 5.5"), else the id. */
export function agentModelLabel(models: readonly AgentModelOption[], model: AgentModel): string {
  return findAgentModel(models, model)?.label ?? model;
}
