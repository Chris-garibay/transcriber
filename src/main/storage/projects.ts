import { promises as fs } from 'fs'
import { join } from 'path'
import type { Project } from '@shared/types'
import { projectsDir, projectDir, safeName, isInside } from './paths'
import { METADATA_FILE } from './metadata'

export const DEFAULT_PROJECT = 'General'

/** Create the data tree and guarantee at least one project exists. */
export async function ensureRoot(): Promise<void> {
  await fs.mkdir(projectsDir(), { recursive: true })
  const existing = await listProjectNames()
  if (existing.length === 0) {
    await fs.mkdir(projectDir(DEFAULT_PROJECT), { recursive: true })
  }
}

async function listProjectNames(): Promise<string[]> {
  try {
    const entries = await fs.readdir(projectsDir(), { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

export async function listProjects(): Promise<Project[]> {
  const names = await listProjectNames()
  return Promise.all(
    names.map(async (name) => ({ name, recordingCount: await countRecordings(name) }))
  )
}

async function countRecordings(project: string): Promise<number> {
  try {
    const entries = await fs.readdir(projectDir(project), { withFileTypes: true })
    const checks = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) =>
          fs
            .access(join(projectDir(project), e.name, METADATA_FILE))
            .then(() => true)
            .catch(() => false)
        )
    )
    return checks.filter(Boolean).length
  } catch {
    return 0
  }
}

export async function createProject(name: string): Promise<string> {
  const safe = safeName(name)
  const dir = projectDir(safe)
  try {
    await fs.mkdir(dir, { recursive: false })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`A project named "${safe}" already exists.`)
    }
    throw err
  }
  return safe
}

export async function renameProject(from: string, to: string): Promise<string> {
  const safeTo = safeName(to)
  const src = projectDir(from)
  const dest = projectDir(safeTo)
  if (src === dest) return safeTo

  try {
    await fs.access(dest)
    throw new Error(`A project named "${safeTo}" already exists.`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  await fs.rename(src, dest)
  return safeTo
}

/**
 * Remove a project and everything in it. Guarded so a malformed name can never
 * resolve to a directory outside the data root.
 */
export async function deleteProject(name: string): Promise<void> {
  const dir = projectDir(name)
  if (!isInside(projectsDir(), dir)) {
    throw new Error('Refusing to delete a directory outside the data root.')
  }
  await fs.rm(dir, { recursive: true, force: true })
  await ensureRoot()
}
