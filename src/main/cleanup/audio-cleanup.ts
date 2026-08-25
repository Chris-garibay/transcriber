import { promises as fs } from 'fs'
import { join } from 'path'
import type { RecordingMeta } from '@shared/types'
import { AUDIO_FILE, RAW_RESULT_FILE, TRANSCRIPT_FILE, readMeta, writeMeta } from '../storage/metadata'

export interface CleanupOutcome {
  deleted: boolean
  reason: string
}

/**
 * The ONLY place in the application that removes a recording's audio.
 *
 * Every precondition is re-read from disk immediately before the unlink rather
 * than trusted from an in-memory object, so a stale caller cannot talk this
 * function into deleting something. Deletion is never reachable from an error
 * path: callers invoke it only after verification returns cleanly, and it
 * independently re-checks that result anyway.
 *
 * Crash safety comes from the write ordering:
 *   1. persist the passing verification result and audioDeleted:false, fsynced
 *   2. unlink the audio
 *   3. persist audioDeleted:true
 * A crash before (2) leaves audio present and metadata honest. A crash between
 * (2) and (3) leaves metadata claiming audio exists when it does not, which
 * `reconcile()` corrects on next launch. At no point can metadata claim a
 * transcript is verified while the audio is gone and the transcript is not.
 */
export async function deleteAudioIfVerified(dir: string): Promise<CleanupOutcome> {
  const meta = await readMeta(dir)

  if (!meta) return { deleted: false, reason: 'Metadata could not be read.' }
  if (meta.audioDeleted) return { deleted: false, reason: 'Audio was already removed.' }

  // Precondition 1: verification passed with literally zero issues.
  if (meta.verification.status !== 'passed') {
    return { deleted: false, reason: `Verification status is "${meta.verification.status}".` }
  }
  if (meta.verification.issues.length > 0) {
    return { deleted: false, reason: `Verification reported ${meta.verification.issues.length} issue(s).` }
  }
  if (meta.transcriptionStatus !== 'complete') {
    return { deleted: false, reason: `Recording is in state "${meta.transcriptionStatus}".` }
  }

  // Precondition 2: the transcript exists on disk and has real content.
  // This is checked against the filesystem, not against metadata, because
  // metadata is what we are trying to corroborate.
  const transcriptPath = join(dir, TRANSCRIPT_FILE)
  let transcriptBytes = 0
  try {
    transcriptBytes = (await fs.stat(transcriptPath)).size
  } catch {
    return { deleted: false, reason: 'Transcript file is missing on disk.' }
  }
  if (transcriptBytes === 0) {
    return { deleted: false, reason: 'Transcript file is empty on disk.' }
  }

  const audioPath = join(dir, AUDIO_FILE)
  try {
    await fs.access(audioPath)
  } catch {
    // Audio is already gone; just make the metadata agree.
    await writeMeta(dir, { ...meta, audioDeleted: true, audioFile: null })
    return { deleted: false, reason: 'Audio file was not present.' }
  }

  // Step 1: durably record our intent before touching the audio.
  await writeMeta(dir, { ...meta, audioDeleted: false })

  // Step 2: remove the audio.
  await fs.rm(audioPath, { force: true })

  // Step 3: record that it is gone.
  await writeMeta(dir, { ...meta, audioDeleted: true, audioFile: null })

  // The raw engine output only exists to explain a verification result. With
  // zero issues there is nothing to explain, so the recording settles to just
  // the transcript and its metadata. It is kept whenever review is needed.
  await fs.rm(join(dir, RAW_RESULT_FILE), { force: true })

  return { deleted: true, reason: 'Verified with zero issues.' }
}

/**
 * Bring metadata back in line with the filesystem after an unclean shutdown.
 * Only ever moves metadata towards the truth on disk -- it never deletes audio.
 */
export async function reconcile(dir: string): Promise<RecordingMeta | null> {
  const meta = await readMeta(dir)
  if (!meta) return null

  const audioPresent = await exists(join(dir, AUDIO_FILE))
  const transcriptPresent = await exists(join(dir, TRANSCRIPT_FILE))

  const next: RecordingMeta = { ...meta }
  let changed = false

  if (!audioPresent && !meta.audioDeleted) {
    // Crashed between unlink and the final metadata write, or the user removed
    // the file by hand. Either way the audio is genuinely gone.
    next.audioDeleted = true
    next.audioFile = null
    changed = true
  }

  if (audioPresent && meta.audioDeleted) {
    next.audioDeleted = false
    next.audioFile = AUDIO_FILE
    changed = true
  }

  if (transcriptPresent && !meta.transcriptFile) {
    next.transcriptFile = TRANSCRIPT_FILE
    changed = true
  }

  if (changed) {
    await writeMeta(dir, next)
    return next
  }
  return meta
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}
