import { z } from 'zod';
import { revisionSchema } from './files.ts';

/**
 * One file's patch, fetched on demand rather than shipped with the file list —
 * a full 200-file patch is 2.5 MB and the list is a few KB.
 *
 * Cached client-side by `(oldBlob, newBlob)`, which is immutable, so the cache
 * never expires.
 */
export const filePatchSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  oldBlob: z.string(),
  newBlob: z.string(),
  binary: z.boolean(),
  /** Unified diff text, context-trimmed. Empty for binary files. */
  patch: z.string(),
  oldMode: z.string().nullable(),
  newMode: z.string().nullable(),
});
export type FilePatch = z.infer<typeof filePatchSchema>;

/**
 * Both sides of a file, for `loadDiffFiles` when the user expands unchanged
 * context. `cacheKey` is each side's blob SHA so the expansion reuses the
 * highlight cache instead of re-tokenizing.
 */
export const fileContentsSchema = z.object({
  path: z.string(),
  /** Null when the side does not exist (an add has no old side). */
  oldContents: z.string().nullable(),
  newContents: z.string().nullable(),
  oldBlob: z.string(),
  newBlob: z.string(),
});
export type FileContents = z.infer<typeof fileContentsSchema>;

export const diffQuerySchema = z.object({
  path: z.string().min(1),
  rev: revisionSchema.optional(),
});
export type DiffQuery = z.infer<typeof diffQuerySchema>;

export const blobSideSchema = z.enum(['old', 'new']);
export type BlobSide = z.infer<typeof blobSideSchema>;

/** One side of one changed file, as raw bytes: what image previews load. */
export const blobQuerySchema = z.object({
  path: z.string().min(1),
  side: blobSideSchema,
  rev: revisionSchema.optional(),
});
export type BlobQuery = z.infer<typeof blobQuerySchema>;
