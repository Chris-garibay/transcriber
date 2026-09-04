import { sep } from 'path'

/**
 * Filename sanitising and containment checks. Kept free of any Electron import
 * so the test suite can exercise it directly -- these are the guards that keep
 * arbitrary user text from escaping, or hiding inside, the data root.
 */

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Drop C0 controls and DEL, which are illegal in filenames on Windows. */
function stripControlChars(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.codePointAt(0) as number
    if (code >= 32 && code !== 127) out += ch
  }
  return out
}

/**
 * Reduce arbitrary user text to a single path segment that is legal on both
 * macOS and Windows. Because every IPC handler routes names through here,
 * path traversal is unreachable by construction rather than by review.
 */
export function safeName(input: string): string {
  const cleaned = stripControlChars(input.normalize('NFC'))
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    // A leading dot makes the directory hidden, and listProjectNames skips
    // dotfiles -- so without this a project could be created on disk and then
    // be invisible and unreachable from the app that created it.
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 120)
    .trim()

  if (!cleaned || cleaned === '.' || cleaned === '..') return 'Untitled'
  if (RESERVED.test(cleaned)) return `${cleaned}_`
  return cleaned
}

/**
 * Derive a recording title from an imported file's name: drop the extension and
 * relax underscores into spaces, so "CS229_lecture-04.mp4" reads as
 * "CS229 lecture-04" in the sidebar.
 *
 * Callers pass `File.name`, which is already a base name, but the leading
 * segment split and `safeName` are kept so that a full path arriving here could
 * never become a directory outside the data root.
 */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName
  const withoutExtension = base.replace(/\.[A-Za-z0-9]{1,5}$/, '')
  const relaxed = withoutExtension.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim()
  return safeName(relaxed || base)
}

/** True when `child` is genuinely inside `parent`. Used as a deletion guard. */
export function isInside(parent: string, child: string): boolean {
  const p = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(p)
}
