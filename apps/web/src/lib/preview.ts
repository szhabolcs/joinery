/**
 * Rendered previews in the diff view: images side by side, markdown
 * rendered, SVG either way.
 *
 * A preview is not a second view beside `CodeView`; it stays one of its
 * items, so the one-`CodeView` rule, item identity and virtualization all
 * hold. The item's `fileDiff` becomes a one-line stub (`previewFileDiff`) and
 * its only annotation is a file-level one (`lineNumber: 0`) that
 * ReviewCodeView renders as the preview. `PREVIEW_CSS` hides the stub's line,
 * so the card shows the header and the preview alone, and Pierre measures the
 * annotation like any comment thread. Comments stay on the diff: a previewed
 * item carries no thread annotations.
 *
 * Image bytes are cached by blob SHA, like patches, so they never expire.
 */
import type { FileDiffMetadata } from '@pierre/diffs';
import { api, NULL_BLOB, type BlobSide, type FileEntry, type Revision } from '@joinery/core';
import { ApiError, callApi, getAuthToken } from './apiClient.ts';
import { blobPairKey } from './diffLoader.ts';

export type PreviewKind = 'image' | 'svg' | 'markdown';
export type FileView = 'diff' | 'preview';

const IMAGE_EXTENSIONS = new Set(['apng', 'avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'webp']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown']);

export function previewKindOf(path: string): PreviewKind | null {
  const ext = /\.([^./]+)$/u.exec(path)?.[1]?.toLowerCase() ?? '';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === 'svg') return 'svg';
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  return null;
}

/**
 * The view a file shows with no choice made: images (SVG included) preview,
 * markdown shows its diff. A raster image has nothing else to show (its diff
 * is a binary stub), so it can't be switched.
 */
export function defaultView(kind: PreviewKind): FileView {
  return kind === 'markdown' ? 'diff' : 'preview';
}

export function canSwitchView(kind: PreviewKind): boolean {
  return kind !== 'image';
}

/** Images this large wait for a click instead of loading as they scroll in. */
export const LARGE_PREVIEW_BYTES = 10 * 1024 * 1024;

/** The id `ThreadAnnotationMeta.threadId` carries on a preview annotation. */
export const PREVIEW_ANNOTATION_ID = '__preview__';

/** A previewed item's `cacheKey`: its blob pair, marked so it never matches a real patch. */
export function previewKey(entry: Pick<FileEntry, 'oldBlob' | 'newBlob'>): string {
  return `${blobPairKey(entry)}:preview`;
}

export function isPreviewDiff(fileDiff: FileDiffMetadata): boolean {
  return fileDiff.cacheKey?.endsWith(':preview') === true;
}

/**
 * The side a file-level annotation must sit on to render: Pierre only shows
 * the deletions column of a deleted file.
 */
export function previewSide(entry: FileEntry): 'additions' | 'deletions' {
  return entry.status === 'deleted' ? 'deletions' : 'additions';
}

/**
 * A one-hunk, one-blank-line diff. Pierre renders no code area (and so no
 * file-level annotation) for a diff without hunks, so the preview needs a
 * line to sit above; `PREVIEW_CSS` hides it. Not partial, so there is no
 * context to expand.
 */
export function previewFileDiff(entry: FileEntry): FileDiffMetadata {
  return {
    name: entry.path,
    ...(entry.oldPath !== null ? { prevName: entry.oldPath } : {}),
    type:
      entry.status === 'added'
        ? 'new'
        : entry.status === 'deleted'
          ? 'deleted'
          : entry.status === 'renamed'
            ? 'rename-changed'
            : 'change',
    hunks: [
      {
        collapsedBefore: 0,
        splitLineCount: 1,
        splitLineStart: 0,
        unifiedLineCount: 1,
        unifiedLineStart: 0,
        additionCount: 1,
        additionStart: 1,
        additionLines: 0,
        deletionCount: 1,
        deletionStart: 1,
        deletionLines: 0,
        deletionLineIndex: 0,
        additionLineIndex: 0,
        hunkContent: [{ type: 'context', lines: 1, additionLineIndex: 0, deletionLineIndex: 0 }],
        hunkSpecs: '@@ -1 +1 @@\n',
        noEOFCRAdditions: false,
        noEOFCRDeletions: false,
      },
    ],
    splitLineCount: 1,
    unifiedLineCount: 1,
    isPartial: false,
    deletionLines: ['\n'],
    additionLines: ['\n'],
    deletionCharacterCount: 1,
    additionCharacterCount: 1,
    cacheKey: previewKey(entry),
  };
}

/*
 * Injected into every item's shadow root, but only matches a code group that
 * holds a file-level annotation, which only previews use (a thread sits on a
 * line, never line 0). It hides the stub line and its gutter, and in split
 * view drops the empty deletions column so the preview spans the card.
 */
const PREVIEW_SLOTS = 'slot[name="annotation-additions-0"], slot[name="annotation-deletions-0"]';
export const PREVIEW_CSS = `
pre:has(${PREVIEW_SLOTS}) {
  grid-template-columns: 1fr;
}
pre:has(slot[name="annotation-additions-0"]) [data-deletions] {
  display: none;
}
[data-code]:has(${PREVIEW_SLOTS}) {
  & [data-gutter],
  & [data-line],
  & [data-no-newline] {
    display: none;
  }
  & [data-content] {
    grid-column: 1 / -1;
  }
}
`;

/** Each review's per-file view choices, for this browser session. */
function viewStorageKey(reviewId: string): string {
  return `joinery:file-view:${reviewId}`;
}

export function readStoredViews(reviewId: string): Map<string, FileView> {
  try {
    const raw = window.sessionStorage.getItem(viewStorageKey(reviewId));
    if (raw === null) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return new Map();
    return new Map(
      Object.entries(parsed).filter((e): e is [string, FileView] => e[1] === 'diff' || e[1] === 'preview'),
    );
  } catch {
    return new Map();
  }
}

export function persistViews(reviewId: string, views: ReadonlyMap<string, FileView>): void {
  try {
    window.sessionStorage.setItem(viewStorageKey(reviewId), JSON.stringify(Object.fromEntries(views)));
  } catch {
    // Best-effort only — private/locked-down storage just won't persist.
  }
}

export type BlobRequest = {
  reviewId: string;
  entry: FileEntry;
  side: BlobSide;
  revision: Revision | undefined;
};

function blobOf({ entry, side }: Pick<BlobRequest, 'entry' | 'side'>): string {
  return side === 'old' ? entry.oldBlob : entry.newBlob;
}

export function hasSide(entry: FileEntry, side: BlobSide): boolean {
  return blobOf({ entry, side }) !== NULL_BLOB;
}

const sizeCache = new Map<string, Promise<number>>();
const urlCache = new Map<string, Promise<string>>();

function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const promise = load();
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  return promise;
}

/**
 * `getBlob`, which answers with bytes rather than JSON, so it can't go
 * through `callApi`. `HEAD` asks for the size alone; `blob` is empty then.
 */
async function fetchBlob(
  { reviewId, entry, side, revision }: BlobRequest,
  method: 'GET' | 'HEAD',
): Promise<{ blob: Blob; size: number }> {
  const query = new URLSearchParams({ path: entry.path, side });
  if (revision !== undefined) query.set('rev', revision);
  const token = getAuthToken();
  let res: Response;
  try {
    res = await fetch(`${api.getBlob.path(reviewId)}?${query.toString()}`, {
      method,
      headers: token !== null ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch (err) {
    throw new ApiError(err instanceof Error ? err.message : 'Network request failed', 0, 'network_error');
  }
  if (!res.ok) throw new ApiError(`Request failed: ${String(res.status)}`, res.status);
  const blob = method === 'HEAD' ? new Blob() : await res.blob();
  return { blob, size: Number(res.headers.get('X-Blob-Size') ?? blob.size) };
}

/** One side's size in bytes, asked before loading it (`HEAD`). */
export function blobSize(request: BlobRequest): Promise<number> {
  return cached(sizeCache, blobOf(request), async () => {
    const { size } = await fetchBlob(request, 'HEAD');
    return size;
  });
}

/** One side as an object URL for `<img>`. Never revoked: it is the cache. */
export function blobUrl(request: BlobRequest): Promise<string> {
  return cached(urlCache, blobOf(request), async () => {
    const { blob } = await fetchBlob(request, 'GET');
    return URL.createObjectURL(blob);
  });
}

const textCache = new Map<string, Promise<string>>();

/** One side as text, for a markdown preview. */
export function blobText(request: BlobRequest): Promise<string> {
  return cached(textCache, blobOf(request), async () => {
    const { contents } = await callApi('getContents', {
      params: [request.reviewId],
      query: { path: request.entry.path, ...(request.revision !== undefined ? { rev: request.revision } : {}) },
    });
    return (request.side === 'old' ? contents.oldContents : contents.newContents) ?? '';
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'GB'}`;
}
