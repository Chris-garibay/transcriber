import { app } from 'electron'
import { join, sep } from 'path'
import { homedir } from 'os'

/**
 * Root of the user-visible data tree. Deliberately outside userData so the
 * transcripts are easy to find, back up and hand to a coding agent by path.
 */
export function rootDir(): string {
  return join(homedir(), 'Transcriber')
}

export function projectsDir(): string {
  return join(rootDir(), 'Projects')
}

export function projectDir(project: string): string {
  return join(projectsDir(), safeName(project))
}

export function recordingDir(project: string, id: string): string {
  return join(projectDir(project), safeName(id))
}

/** Internal application state the user should never have to look at. */
export function stateDir(): string {
  return join(app.getPath('userData'), 'state')
}

export function modelsDir(): string {
  return join(app.getPath('userData'), 'models')
}

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
    .replace(/[. ]+$/, '') // Windows rejects trailing dots and spaces
    .slice(0, 120)

  if (!cleaned || cleaned === '.' || cleaned === '..') return 'Untitled'
  if (RESERVED.test(cleaned)) return `${cleaned}_`
  return cleaned
}

/** True when `child` is genuinely inside `parent`. Used as a deletion guard. */
export function isInside(parent: string, child: string): boolean {
  const p = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(p)
}
