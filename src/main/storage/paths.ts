import { app } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { safeName, isInside } from './names'

export { safeName, isInside }

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
