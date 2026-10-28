/**
 * Pieces shared by the diff's code intelligence (components/CodeIntel.tsx)
 * and its peek window (components/PeekNavigator.tsx).
 */

import { useSyncExternalStore } from 'react';

const CACHE_LIMIT = 2_000;

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const PEEK_KEY = IS_MAC ? '⌘' : 'Ctrl';
/** Held with the click that goes straight to the definition, skipping the peek window. */
export const JUMP_KEY = IS_MAC ? '⌘⇧' : 'Ctrl+Shift';

/**
 * Injected into each file's shadow root alongside the card CSS: the token
 * under the pointer reads as a link while the peek modifier is held, the one
 * a peek window was opened from stays marked while it's open, a jump's
 * lookup shows a wait cursor on its token, and a double-clicked symbol's
 * places in its file are tinted.
 */
export const CODE_INTEL_CSS = `
[data-char][data-lsp-link] {
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
[data-char][data-lsp-wait] {
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: wait;
}
[data-char][data-lsp-occurrence] {
  background-color: var(--chrome-accent-soft);
  border-radius: 2px;
}
[data-char][data-lsp-origin] {
  background-color: var(--chrome-accent-soft);
  outline: 1px solid color-mix(in srgb, var(--chrome-accent) 55%, transparent);
  border-radius: 2px;
}
`;

const HOVER_KEY = 'joinery:lsp-hover';
const HOVER_DELAY_KEY = 'joinery:lsp-hover-delay';
const IMPLEMENTATION_JUMP_KEY = 'joinery:lsp-implementation-jump';
export const DEFAULT_HOVER_DELAY_MS = 300;
export const MAX_HOVER_DELAY_MS = 10_000;
const hoverListeners = new Set<() => void>();

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Best-effort only.
  }
  for (const l of hoverListeners) l();
}

function subscribeHover(l: () => void): () => void {
  hoverListeners.add(l);
  return () => {
    hoverListeners.delete(l);
  };
}

let hoverOn = stored(HOVER_KEY) !== 'off';
let implementationJump = stored(IMPLEMENTATION_JUMP_KEY) !== 'off';
let hoverDelay = (() => {
  const n = Number(stored(HOVER_DELAY_KEY) ?? NaN);
  return Number.isInteger(n) && n >= 0 && n <= MAX_HOVER_DELAY_MS ? n : DEFAULT_HOVER_DELAY_MS;
})();

/** Whether resting on a name shows its types and docs (Settings → Language servers); on by default. ⌘-click works either way. */
export function getHoverEnabled(): boolean {
  return hoverOn;
}

export function setHoverEnabled(on: boolean): void {
  hoverOn = on;
  store(HOVER_KEY, on ? 'on' : 'off');
}

export function useHoverEnabled(): boolean {
  return useSyncExternalStore(subscribeHover, getHoverEnabled);
}

/** How long the pointer rests on a name before its hover card is asked for, in ms. */
export function getHoverDelay(): number {
  return hoverDelay;
}

export function setHoverDelay(ms: number): void {
  hoverDelay = Math.min(MAX_HOVER_DELAY_MS, Math.max(0, Math.round(ms)));
  store(HOVER_DELAY_KEY, String(hoverDelay));
}

export function useHoverDelay(): number {
  return useSyncExternalStore(subscribeHover, getHoverDelay);
}

/**
 * Whether the peek window opens on the implementation when there's exactly
 * one (an interface with a single class behind it) rather than on the
 * definition (Settings → Language servers); on by default.
 */
export function getImplementationJump(): boolean {
  return implementationJump;
}

export function setImplementationJump(on: boolean): void {
  implementationJump = on;
  store(IMPLEMENTATION_JUMP_KEY, on ? 'on' : 'off');
}

export function useImplementationJump(): boolean {
  return useSyncExternalStore(subscribeHover, getImplementationJump);
}

/** Shared by every waiter; a request that fails or is aborted is dropped so the next hover asks again. */
export function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const promise = load();
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return promise;
}

/** Below the anchor when it fits, otherwise above; always inside the viewport. */
export function placement(rect: DOMRect, width: number, height: number): React.CSSProperties {
  const margin = 8;
  const left = Math.max(margin, Math.min(rect.left - 12, window.innerWidth - width - margin));
  const below = rect.bottom + 6;
  if (below + height <= window.innerHeight - margin || rect.top - 6 - height < margin) {
    return { left, top: below, maxHeight: Math.max(120, window.innerHeight - below - margin) };
  }
  return { left, bottom: window.innerHeight - rect.top + 6, maxHeight: Math.max(120, rect.top - 6 - margin) };
}
