/**
 * Directory listing for the web folder picker. Names and paths of
 * directories only — never file names or contents.
 */
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { DirEntry } from '@joinery/core';
import { badRequest, pathError } from '../http/errors.ts';

export interface DirListing {
  path: string;
  parent: string | null;
  isRepo: boolean;
  entries: DirEntry[];
}

/** `.git` is a directory in a clone, a file in a worktree or submodule. */
async function hasGit(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * The owning repo's name when `dir` is a linked worktree: its `.git` file reads
 * `gitdir: <common dir>/worktrees/<name>`, and the common dir is `<repo>/.git`
 * (or `<repo>.git` when bare). Submodules point into `/modules/` instead.
 */
async function worktreeOf(dir: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(join(dir, '.git'), 'utf8');
  } catch {
    return undefined; // no `.git`, or a directory (a regular clone)
  }
  const gitdir = /^gitdir:\s*(.+)$/m.exec(content)?.[1]?.trim();
  if (gitdir === undefined || basename(dirname(gitdir)) !== 'worktrees') return undefined;
  const common = dirname(dirname(gitdir));
  return basename(common) === '.git' ? basename(dirname(common)) : basename(common).replace(/\.git$/, '');
}

/**
 * Folders macOS guards behind a per-app privacy prompt: the home's Desktop,
 * Documents and Downloads, iCloud Drive, and mounted volumes (the boot
 * volume's `/Volumes` entry is a symlink to `/` and isn't guarded).
 */
function isMacPrivacyGuarded(full: string, isSymlink: boolean): boolean {
  if (process.platform !== 'darwin') return false;
  if (dirname(full) === '/Volumes') return !isSymlink;
  const home = homedir();
  return ['Desktop', 'Documents', 'Downloads', 'Library/Mobile Documents'].some((d) => full === join(home, d));
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function listDirs(rawPath: string | undefined, hidden: boolean): Promise<DirListing> {
  let wanted = rawPath === undefined || rawPath === '' ? homedir() : rawPath;
  if (wanted === '~' || wanted.startsWith('~/') || wanted.startsWith('~\\')) wanted = join(homedir(), wanted.slice(1));
  // A bare drive (`D:`) means that drive's current directory to Windows; the picker means its root.
  if (process.platform === 'win32' && /^[a-zA-Z]:$/.test(wanted)) wanted = `${wanted}\\`;
  if (!isAbsolute(wanted)) throw badRequest(`path must be absolute, got: ${wanted}`);

  let path: string;
  try {
    path = await realpath(wanted);
  } catch (err) {
    throw pathError(err, wanted);
  }
  if (!(await isDir(path))) throw badRequest(`not a directory: ${wanted}`);

  let children;
  try {
    children = await readdir(path, { withFileTypes: true });
  } catch (err) {
    throw pathError(err, path);
  }

  const entries = (
    await Promise.all(
      children.map(async (child): Promise<DirEntry | null> => {
        if (!hidden && child.name.startsWith('.')) return null;
        const full = join(path, child.name);
        if (!child.isDirectory() && !(child.isSymbolicLink() && (await isDir(full)))) return null;
        // Don't probe guarded folders for `.git`: that alone pops the macOS prompt.
        if (isMacPrivacyGuarded(full, child.isSymbolicLink())) {
          return { name: child.name, path: full, isRepo: false, macPrivacyPrompt: true };
        }
        if (!(await hasGit(full))) return { name: child.name, path: full, isRepo: false };
        const owner = await worktreeOf(full);
        return { name: child.name, path: full, isRepo: true, ...(owner === undefined ? {} : { worktreeOf: owner }) };
      }),
    )
  ).filter((e): e is DirEntry => e !== null);
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, isRepo: await hasGit(path), entries };
}
