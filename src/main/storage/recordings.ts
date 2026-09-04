import { promises as fs } from 'fs'
import { join } from 'path'
import type { RecordingDetail, RecordingMeta, SearchHit } from '@shared/types'
import { projectDir, projectsDir, recordingDir, safeName, isInside } from './paths'
import {
  AUDIO_FILE,
  METADATA_FILE,
  TRANSCRIPT_FILE,
  fileExists,
  newMeta,
  readMeta,
  writeMeta
} from './metadata'
import { claimRecordingDir } from './claim'
import type { ClaimedRecording } from './claim'

export { newMeta }

/** Create and claim the next recording directory inside a project. */
export function claimRecording(project: string): Promise<ClaimedRecording> {
  return claimRecordingDir(projectDir(project))
}

export async function listRecordings(project: string): Promise<RecordingMeta[]> {
  const dir = projectDir(project)
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const metas = await Promise.all(
    entries.filter((e) => e.isDirectory()).map((e) => readMeta(join(dir, e.name)))
  )

  return metas
    .filter((m): m is RecordingMeta => m !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getRecording(
  project: string,
  id: string
): Promise<RecordingDetail | null> {
  const dir = recordingDir(project, id)
  const meta = await readMeta(dir)
  if (!meta) return null

  const transcriptPath = join(dir, TRANSCRIPT_FILE)
  let transcript = ''
  try {
    transcript = await fs.readFile(transcriptPath, 'utf8')
  } catch {
    /* not transcribed yet */
  }

  return {
    ...meta,
    transcript,
    dirPath: dir,
    transcriptPath: meta.transcriptFile ? transcriptPath : null
  }
}

export async function renameRecording(
  project: string,
  id: string,
  title: string
): Promise<RecordingMeta | null> {
  const dir = recordingDir(project, id)
  const meta = await readMeta(dir)
  if (!meta) return null

  // Only the display title changes; the directory name stays stable so any
  // path already copied into a coding agent keeps resolving.
  //
  // safeName never returns an empty string -- it falls back to "Untitled" --
  // so a blank title has to be caught before it, or the recording silently
  // loses its name.
  const trimmed = title.trim()
  const next: RecordingMeta = { ...meta, title: trimmed ? safeName(trimmed) : meta.id }
  await writeMeta(dir, next)
  return next
}

export async function deleteRecording(project: string, id: string): Promise<void> {
  const dir = recordingDir(project, id)
  if (!isInside(projectsDir(), dir)) {
    throw new Error('Refusing to delete a directory outside the data root.')
  }
  await fs.rm(dir, { recursive: true, force: true })
}

export async function saveTranscript(
  project: string,
  id: string,
  text: string
): Promise<RecordingMeta | null> {
  const dir = recordingDir(project, id)
  const meta = await readMeta(dir)
  if (!meta) return null

  await fs.writeFile(join(dir, TRANSCRIPT_FILE), text, 'utf8')
  if (meta.transcriptFile) return meta

  const next: RecordingMeta = { ...meta, transcriptFile: TRANSCRIPT_FILE }
  await writeMeta(dir, next)
  return next
}

/** True when the audio file is still on disk for this recording. */
export async function hasAudio(project: string, id: string): Promise<boolean> {
  return fileExists(join(recordingDir(project, id), AUDIO_FILE))
}

const EXCERPT_RADIUS = 90

/**
 * Substring search across titles and transcript bodies. Scanning the tree is
 * fast enough for a personal archive and keeps the on-disk format free of any
 * index that could fall out of sync with the transcripts themselves.
 */
export async function searchRecordings(query: string): Promise<SearchHit[]> {
  const needle = query.trim().toLowerCase()
  if (!needle) return []

  let projects: import('fs').Dirent[]
  try {
    projects = await fs.readdir(projectsDir(), { withFileTypes: true })
  } catch {
    return []
  }

  const hits: SearchHit[] = []

  for (const project of projects.filter((p) => p.isDirectory())) {
    const metas = await listRecordings(project.name)
    for (const meta of metas) {
      const dir = recordingDir(project.name, meta.id)
      let body = ''
      try {
        body = await fs.readFile(join(dir, TRANSCRIPT_FILE), 'utf8')
      } catch {
        /* no transcript yet */
      }

      const inTitle = meta.title.toLowerCase().includes(needle)
      const index = body.toLowerCase().indexOf(needle)
      if (!inTitle && index === -1) continue

      const excerpt =
        index === -1
          ? body.slice(0, EXCERPT_RADIUS * 2).trim()
          : body
              .slice(Math.max(0, index - EXCERPT_RADIUS), index + needle.length + EXCERPT_RADIUS)
              .trim()

      hits.push({
        id: meta.id,
        project: project.name,
        title: meta.title,
        createdAt: meta.createdAt,
        excerpt: excerpt || '(no transcript text)'
      })
    }
  }

  return hits.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200)
}

export { METADATA_FILE }
