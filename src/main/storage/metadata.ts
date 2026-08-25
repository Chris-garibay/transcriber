import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import type { RecordingMeta, VerificationResult } from '@shared/types'

export const METADATA_FILE = 'metadata.json'
export const TRANSCRIPT_FILE = 'transcript.txt'
export const AUDIO_FILE = 'recording.wav'
export const RAW_RESULT_FILE = 'whisper.json'

export function emptyVerification(): VerificationResult {
  return { status: 'pending', issues: [], checkedAt: null }
}

/**
 * Write JSON durably: serialise to a sibling temp file, fsync it, then rename.
 * Rename is atomic within a directory on both APFS and NTFS, so a crash leaves
 * either the old file or the new one -- never a truncated one. The audio
 * cleanup step depends on this guarantee.
 */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  const body = JSON.stringify(data, null, 2)

  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(body, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }

  await fs.rename(tmp, filePath)
  await syncDir(dirname(filePath))
}

/**
 * fsync the directory so the rename itself is durable, not just the file
 * contents. Without this a power loss can undo the rename on some filesystems.
 * Directory fsync is not supported on Windows, where the rename is already
 * ordered, so failures here are non-fatal.
 */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const handle = await fs.open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    /* best effort */
  }
}

export async function readMeta(dir: string): Promise<RecordingMeta | null> {
  try {
    const raw = await fs.readFile(join(dir, METADATA_FILE), 'utf8')
    const parsed = JSON.parse(raw) as RecordingMeta
    if (!parsed || typeof parsed.id !== 'string') return null
    if (!parsed.verification) parsed.verification = emptyVerification()
    return parsed
  } catch {
    return null
  }
}

export async function writeMeta(dir: string, meta: RecordingMeta): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await writeJsonAtomic(join(dir, METADATA_FILE), meta)
}

/**
 * Read-modify-write a metadata file. Callers must always go through this rather
 * than holding a stale object, so that concurrent queue and UI updates cannot
 * clobber each other's fields.
 */
export async function updateMeta(
  dir: string,
  mutate: (meta: RecordingMeta) => RecordingMeta
): Promise<RecordingMeta | null> {
  const current = await readMeta(dir)
  if (!current) return null
  const next = mutate({ ...current })
  await writeMeta(dir, next)
  return next
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

export async function fileSize(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).size
  } catch {
    return 0
  }
}
