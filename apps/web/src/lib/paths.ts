/** Server filesystem paths, which are Windows paths when the server runs on Windows. */
export function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

/** `/a/b` -> `['a', 'b']`, `C:\a\b` -> `['C:', 'a', 'b']`. A backslash is an ordinary character in a POSIX path. */
export function pathSegments(path: string): string[] {
  return path.split(isWindowsPath(path) ? /[\\/]/ : '/').filter((s) => s !== '');
}
