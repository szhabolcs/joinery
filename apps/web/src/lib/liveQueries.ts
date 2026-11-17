/**
 * The web app's data cache (TanStack Query) and what keeps it live: a screen
 * watches the topics it shows with `useWatchTopics`, and each `topic.changed`
 * the server publishes invalidates exactly the queries under that topic,
 * which re-read through the same API a fresh load uses. Nothing polls.
 *
 *   home          -> every `['home', ...]` query (repos, me, reviews, pulls)
 *   repo:<id>     -> `['home', 'pulls', id]`
 *   review:<id>   -> every `['review', id, ...]` query
 */
import { QueryClient } from '@tanstack/react-query';
import type { Topic } from '@joinery/core';
import { useEffect } from 'react';
import { eventsClient } from './wsClient.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Live events invalidate what changed; a window coming back after a
      // while re-reads once in case the socket missed something.
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

export const queryKeys = {
  home: ['home'] as const,
  repos: ['home', 'repos'] as const,
  me: ['home', 'me'] as const,
  reviews: ['home', 'reviews'] as const,
  pulls: (repoId: string) => ['home', 'pulls', repoId] as const,
  review: (reviewId: string) => ['review', reviewId] as const,
  reviewPull: (reviewId: string) => ['review', reviewId, 'pull'] as const,
};

function keyFor(topic: string): readonly unknown[] | null {
  if (topic === 'home') return queryKeys.home;
  if (topic.startsWith('repo:')) return queryKeys.pulls(topic.slice('repo:'.length));
  if (topic.startsWith('review:')) return queryKeys.review(topic.slice('review:'.length));
  return null;
}

/** One action often publishes a burst (a thread and its run, ...): coalesce each topic's into one re-read. */
const COALESCE_MS = 150;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

function invalidate(topic: string): void {
  const key = keyFor(topic);
  if (key === null) return;
  const timer = pending.get(topic);
  if (timer !== undefined) clearTimeout(timer);
  pending.set(
    topic,
    setTimeout(() => {
      pending.delete(topic);
      void queryClient.invalidateQueries({ queryKey: key });
    }, COALESCE_MS),
  );
}

let registered = false;

function ensureListeners(): void {
  if (registered) return;
  registered = true;
  eventsClient.onEvent((event) => {
    if (event.type === 'topic.changed') invalidate(event.topic);
  });
  // Events sent while the socket was down are gone: re-read everything shown.
  eventsClient.onReconnect(() => {
    void queryClient.invalidateQueries();
  });
}

/**
 * Topics some screen watched before and none watches now. Their events go
 * unheard (the server only sends watched topics), so the cache can be stale
 * by more than `staleTime` hides: marking every file viewed in a review,
 * then going back to Homebase, would show the review as unfinished.
 */
const lapsed = new Set<string>();
const watchCounts = new Map<string, number>();

/** Watch `topics` while the calling component is mounted, keeping their queries live. */
export function useWatchTopics(topics: readonly Topic[]): void {
  const signature = topics.join('\n');
  useEffect(() => {
    ensureListeners();
    const unwatchers = topics.map((topic) => {
      watchCounts.set(topic, (watchCounts.get(topic) ?? 0) + 1);
      // Watched again after a gap: re-read now what changed in between.
      if (lapsed.delete(topic)) {
        const key = keyFor(topic);
        if (key !== null) void queryClient.invalidateQueries({ queryKey: key });
      }
      const unwatch = eventsClient.watch(topic);
      return () => {
        unwatch();
        const left = (watchCounts.get(topic) ?? 1) - 1;
        if (left > 0) {
          watchCounts.set(topic, left);
        } else {
          watchCounts.delete(topic);
          lapsed.add(topic);
        }
      };
    });
    return () => {
      for (const unwatch of unwatchers) unwatch();
    };
    // `signature` is the topics' identity; the array itself is a new one every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}
