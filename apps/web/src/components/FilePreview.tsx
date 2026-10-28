/**
 * A changed file rendered rather than diffed: an image's two sides next to
 * each other, or a markdown file's rendered text. It sits inside the file's
 * `CodeView` card as a file-level annotation (see lib/preview.ts), and like
 * any annotation it only mounts once the card scrolls into view, so nothing
 * loads for files the reader never reaches. View-only: comments stay on the
 * diff.
 */
import type { FileEntry } from '@joinery/core';
import { useEffect, useState } from 'react';
import {
  blobSize,
  blobText,
  blobUrl,
  formatBytes,
  hasSide,
  LARGE_PREVIEW_BYTES,
  previewKindOf,
  type BlobRequest,
} from '../lib/preview.ts';
import { useReview } from '../state/ReviewContext.tsx';
import { Markdown } from './Markdown.tsx';

export function FilePreview({ entry }: { entry: FileEntry }): React.JSX.Element | null {
  const { review, reviewState } = useReview();
  if (review === null) return null;
  const base = { reviewId: review.id, entry, revision: reviewState?.currentRevision };
  return (
    <div className="w-full font-sans">
      {previewKindOf(entry.path) === 'markdown' ? (
        <MarkdownPreview request={{ ...base, side: entry.status === 'deleted' ? 'old' : 'new' }} />
      ) : (
        <ImagePreview base={base} entry={entry} />
      )}
    </div>
  );
}

/** Settles a promise into state, dropping a result that arrives after `key` moved on. */
function useLoaded<T>(key: string | null, load: () => Promise<T>): { value: T } | 'loading' | 'error' {
  const [state, setState] = useState<{ key: string; result: { value: T } | 'error' } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    load().then(
      (value) => !cancelled && setState({ key, result: { value } }),
      () => !cancelled && setState({ key, result: 'error' }),
    );
    return () => {
      cancelled = true;
    };
    // `load` is a fresh closure every render; `key` names what it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state === null || state.key !== key ? 'loading' : state.result;
}

function MarkdownPreview({ request }: { request: BlobRequest }): React.JSX.Element {
  const blob = request.side === 'old' ? request.entry.oldBlob : request.entry.newBlob;
  const text = useLoaded(blob, () => blobText(request));
  if (text === 'loading') return <p className="px-6 py-4 text-body text-chrome-fg-muted">Loading preview…</p>;
  if (text === 'error') return <p className="px-6 py-4 text-body text-chrome-fg-muted">Couldn't load this file.</p>;
  return (
    <div className="max-w-[860px] px-6 py-4">
      <Markdown className="markdown-preview">{text.value}</Markdown>
    </div>
  );
}

function ImagePreview({ base, entry }: { base: Omit<BlobRequest, 'side'>; entry: FileEntry }): React.JSX.Element {
  const sides = (['old', 'new'] as const).filter((side) => hasSide(entry, side));
  return (
    <div className={`grid gap-3 p-3 ${sides.length === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
      {sides.map((side) => (
        <ImageSide
          key={`${side}:${side === 'old' ? entry.oldBlob : entry.newBlob}`}
          request={{ ...base, side }}
          label={sides.length === 2 ? (side === 'old' ? 'Before' : 'After') : side === 'old' ? 'Deleted' : 'Added'}
        />
      ))}
    </div>
  );
}

function ImageSide({ request, label }: { request: BlobRequest; label: string }): React.JSX.Element {
  const blob = request.side === 'old' ? request.entry.oldBlob : request.entry.newBlob;
  const size = useLoaded(blob, () => blobSize(request));
  const [allowLarge, setAllowLarge] = useState(false);
  const large = typeof size === 'object' && size.value > LARGE_PREVIEW_BYTES;
  const url = useLoaded(typeof size === 'object' && (!large || allowLarge) ? blob : null, () => blobUrl(request));
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  // The bytes arrived but aren't an image the browser can draw.
  const [undecodable, setUndecodable] = useState(false);

  const details = [
    dimensions !== null && dimensions.width > 0 ? `${String(dimensions.width)} × ${String(dimensions.height)}` : null,
    typeof size === 'object' ? formatBytes(size.value) : null,
  ].filter((part) => part !== null);

  let body: React.ReactNode;
  if (size === 'error' || url === 'error' || undecodable) {
    body = <span className="text-body text-chrome-fg-muted">Couldn't load this image.</span>;
  } else if (large && !allowLarge) {
    body = (
      <button
        type="button"
        onClick={() => setAllowLarge(true)}
        className="rounded-md bg-chrome-bg-raised px-3 py-1.5 text-xs font-medium text-chrome-fg shadow-chrome ring-1 ring-chrome-fg/10 transition-colors hover:bg-chrome-bg-hover"
      >
        Load preview
      </button>
    );
  } else if (typeof url === 'object') {
    body = (
      <img
        src={url.value}
        alt={`${request.entry.path}, ${label.toLowerCase()}`}
        onLoad={(e) => setDimensions({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
        onError={() => setUndecodable(true)}
        className="block max-h-full max-w-full object-contain"
      />
    );
  } else {
    body = <span className="text-body text-chrome-fg-muted">Loading…</span>;
  }

  return (
    // A fixed stage, so the card is its final height before the image
    // decodes and `CodeView` never has to re-measure it.
    <figure className="flex min-w-0 flex-col gap-1.5">
      <figcaption className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-chrome-fg-muted">{label}</span>
        <span className="truncate text-micro text-chrome-fg-subtle tabular-nums">{details.join(' · ')}</span>
      </figcaption>
      <div className="preview-checkerboard flex h-80 items-center justify-center overflow-hidden rounded-md border border-chrome-border p-2">
        {body}
      </div>
    </figure>
  );
}
