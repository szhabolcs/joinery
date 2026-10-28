/**
 * Per-file patch and both-sides file contents: the `FilePatch` and
 * `FileContents` types from `@joinery/core`. Patches are fetched per file on
 * demand, never shipped whole ("Never ship the whole patch" — a full 200-file
 * patch is 2.5 MB, the file list is a few KB). Context is trimmed by scoping
 * the diff to `-U<contextLines>` up front rather than fetching full unified
 * context and trimming client-side twice.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { NULL_BLOB, type FileContents, type FilePatch, type Revision } from '@joinery/core';
import type { CatFile } from './catfile.ts';
import { git, gitOrThrow, type GitCallOptions } from './run.ts';

const decoder = new TextDecoder(); // lossy on invalid UTF-8, matching a best-effort text render

export type FilePatchEntryInput = {
  path: string;
  oldPath: string | null;
  oldBlob: string;
  newBlob: string;
  binary: boolean;
};

export type GetFilePatchParams = {
  cwd: string;
  revision: Revision;
  baseSha: string;
  /** Required for `head`/`pr`; ignored for `working`, which diffs against the live tree. */
  targetSha?: string;
  entry: FilePatchEntryInput;
  /** Unified context lines. Defaults to git's own default of 3. */
  contextLines?: number;
};

/**
 * Fetch one file's patch. `entry` carries the blobs and binary flag already
 * known from the file list, so this never re-derives them from patch text —
 * it only asks git to render the diff for that one path.
 */
export async function getFilePatch(params: GetFilePatchParams): Promise<FilePatch> {
  const { entry } = params;
  const target = params.revision === 'working' ? undefined : params.targetSha;
  if (params.revision !== 'working' && target === undefined) {
    throw new Error(`getFilePatch: revision "${params.revision}" requires targetSha`);
  }

  // Pinned against user config that would change the text we parse/ship:
  // `diff.external`, `color.diff=always`, `diff.noprefix`/`mnemonicPrefix`.
  const args = [
    'diff',
    '--no-ext-diff',
    '--no-color',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '-M',
    `-U${String(params.contextLines ?? 3)}`,
    params.baseSha,
  ];
  if (target !== undefined) args.push(target);
  args.push('--');
  if (entry.oldPath !== null && entry.oldPath !== entry.path) args.push(entry.oldPath);
  args.push(entry.path);

  const result = await gitOrThrow(args, { cwd: params.cwd });
  let patchText = entry.binary ? '' : decoder.decode(result.stdout);

  // An untracked file (working revision, never added) is invisible to
  // `git diff <base>`, which only sees the index and tracked tree, so it comes
  // back empty. `--no-index` against /dev/null renders it as the add it is.
  // That mode exits 1 when the sides differ, so this uses the non-throwing runner.
  if (params.revision === 'working' && !entry.binary && patchText === '' && entry.oldBlob === NULL_BLOB) {
    const untracked = await git(
      ['diff', '--no-index', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', `-U${String(params.contextLines ?? 3)}`, '--', '/dev/null', entry.path],
      { cwd: params.cwd },
    );
    if (untracked.exitCode === 1) patchText = decoder.decode(untracked.stdout);
  }

  const oldModeMatch = /^old mode (\d+)/mu.exec(patchText);
  const newModeMatch = /^new mode (\d+)/mu.exec(patchText);
  const newFileModeMatch = /^new file mode (\d+)/mu.exec(patchText);
  const deletedFileModeMatch = /^deleted file mode (\d+)/mu.exec(patchText);

  return {
    path: entry.path,
    oldPath: entry.oldPath,
    oldBlob: entry.oldBlob,
    newBlob: entry.newBlob,
    binary: entry.binary,
    patch: patchText,
    oldMode: oldModeMatch?.[1] ?? deletedFileModeMatch?.[1] ?? null,
    newMode: newModeMatch?.[1] ?? newFileModeMatch?.[1] ?? null,
  };
}

async function readWorkingFileText(cwd: string, path: string): Promise<string | null> {
  try {
    const buf = await readFile(join(cwd, path));
    return decoder.decode(buf);
  } catch {
    return null;
  }
}

export type GetFileContentsParams = {
  /** The attached worktree root; only read from for a `working` revision's new side. */
  cwd: string;
  revision: Revision;
  path: string;
  oldBlob: string;
  newBlob: string;
  /** The repo's long-lived `cat-file --batch` handle. */
  catFile: CatFile;
};

/**
 * Both sides of a file for `loadDiffFiles` when a user expands unchanged
 * context. Committed sides always come from `cat-file --batch`; a
 * `working` revision's new side is read straight off the attached worktree,
 * because `hash-object` (used to compute that blob's SHA in `filelist.ts`)
 * never writes the object, so `cat-file` cannot read it back.
 */
export async function getFileContents(params: GetFileContentsParams): Promise<FileContents> {
  const oldContents =
    params.oldBlob === NULL_BLOB ? null : decodeBlobOrNull(await params.catFile.readBlob(params.oldBlob));

  let newContents: string | null;
  if (params.newBlob === NULL_BLOB) {
    newContents = null;
  } else if (params.revision === 'working') {
    newContents = await readWorkingFileText(params.cwd, params.path);
  } else {
    newContents = decodeBlobOrNull(await params.catFile.readBlob(params.newBlob));
  }

  return {
    path: params.path,
    oldContents,
    newContents,
    oldBlob: params.oldBlob,
    newBlob: params.newBlob,
  };
}

export type BlobSideParams = {
  /** The attached worktree root; only read from for a `working` revision's new side. */
  cwd: string;
  revision: Revision;
  /** The side's own path (the old path of a rename for the old side). */
  path: string;
  side: 'old' | 'new';
  /** The side's blob SHA; never `NULL_BLOB` (that side doesn't exist). */
  blob: string;
  catFile: CatFile;
};

/**
 * Whether this side lives on disk rather than in the object store: a
 * `working` revision's new side, whose SHA came from `hash-object` without
 * `-w` (see `getFileContents`).
 */
function onDisk(params: BlobSideParams): boolean {
  return params.revision === 'working' && params.side === 'new';
}

/** One side's raw bytes, for image previews. Null when it can't be read. */
export async function readBlobSide(params: BlobSideParams): Promise<Uint8Array | null> {
  if (!onDisk(params)) return params.catFile.readBlob(params.blob);
  try {
    return new Uint8Array(await readFile(join(params.cwd, params.path)));
  } catch {
    return null;
  }
}

/**
 * One side's size in bytes without reading it, so a preview can ask before
 * loading a large image. Null when it can't be read.
 */
export async function blobSideSize(params: BlobSideParams): Promise<number | null> {
  if (onDisk(params)) {
    try {
      return (await stat(join(params.cwd, params.path))).size;
    } catch {
      return null;
    }
  }
  const result = await git(['cat-file', '-s', params.blob], { cwd: params.cwd });
  if (result.exitCode !== 0) return null;
  const size = Number(decoder.decode(result.stdout).trim());
  return Number.isInteger(size) ? size : null;
}

function decodeBlobOrNull(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : decoder.decode(bytes);
}

// Re-exported so callers building a `GetFilePatchParams`/`GetFileContentsParams`
// don't need a separate import just for the cwd/dataDir shape.
export type { GitCallOptions };
