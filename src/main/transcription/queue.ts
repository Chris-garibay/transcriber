import { promises as fs } from 'fs'
import { join } from 'path'
import type { RecordingMeta, TranscriptionStatus, TranscriptionUpdate } from '@shared/types'
import { recordingDir, projectsDir } from '../storage/paths'
import { TRANSCRIPT_FILE, readMeta, updateMeta } from '../storage/metadata'
import { listProjects } from '../storage/projects'
import { listRecordings } from '../storage/recordings'
import { transcribe, WhisperError } from './whisper'
import { activeModelPath, getModelStatus } from './model'
import { verifyTranscript, failedVerification } from '../verification/verify'
import { repairWav } from '../audio/wav-writer'
import { deleteAudioIfVerified, reconcile } from '../cleanup/audio-cleanup'

type Listener = (update: TranscriptionUpdate) => void

interface Job {
  project: string
  id: string
}

/**
 * A single-worker FIFO queue.
 *
 * There is no separate persisted queue file: the transcription status written
 * into each recording's metadata IS the queue. On startup we scan for anything
 * left in a non-terminal state and re-enqueue it, which makes an unclean
 * shutdown recover for free and removes any chance of the queue and the
 * recordings disagreeing about what still needs doing.
 */
class TranscriptionQueue {
  private pending: Job[] = []
  private running = false
  private current: { job: Job; controller: AbortController } | null = null
  private listeners = new Set<Listener>()

  onUpdate(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(meta: RecordingMeta): void {
    const update: TranscriptionUpdate = {
      id: meta.id,
      project: meta.project,
      status: meta.transcriptionStatus,
      verification: meta.verification,
      audioDeleted: meta.audioDeleted,
      error: meta.error ?? null,
      progress: null
    }
    for (const listener of this.listeners) listener(update)
  }

  /**
   * Progress is display-only, so it is pushed straight to the renderer without
   * touching metadata.json -- a long recording reports progress dozens of
   * times and none of it is worth a disk write.
   */
  private emitProgress(meta: RecordingMeta, fraction: number): void {
    const update: TranscriptionUpdate = {
      id: meta.id,
      project: meta.project,
      status: 'transcribing',
      verification: meta.verification,
      audioDeleted: meta.audioDeleted,
      error: null,
      progress: fraction
    }
    for (const listener of this.listeners) listener(update)
  }

  enqueue(project: string, id: string): void {
    const already =
      this.current?.job.id === id && this.current.job.project === project
    if (already) return
    if (this.pending.some((j) => j.id === id && j.project === project)) return

    this.pending.push({ project, id })
    void this.drain()
  }

  /**
   * True when a recording -- or, with no id, any recording in the project -- is
   * queued or being transcribed right now.
   *
   * Callers use this to refuse edits that would move or remove a directory the
   * queue is actively writing into. Renaming a project mid-transcription used
   * to strand the recording in 'transcribing' until the next launch, because
   * the job holds the project name as a plain string and its status write
   * landed at the old path.
   */
  isBusy(project: string, id?: string): boolean {
    const match = (job: Job): boolean =>
      job.project === project && (id === undefined || job.id === id)
    if (this.current && match(this.current.job)) return true
    return this.pending.some(match)
  }

  /** Cancel an in-flight job; the audio is untouched and the job re-queues. */
  cancelCurrent(): void {
    this.current?.controller.abort()
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true

    try {
      while (this.pending.length > 0) {
        const job = this.pending.shift() as Job
        await this.run(job)
      }
    } finally {
      this.running = false
      this.current = null
    }
  }

  private async setStatus(
    job: Job,
    status: TranscriptionStatus,
    patch: Partial<RecordingMeta> = {}
  ): Promise<RecordingMeta | null> {
    const meta = await updateMeta(recordingDir(job.project, job.id), (m) => ({
      ...m,
      ...patch,
      transcriptionStatus: status
    }))
    if (meta) this.emit(meta)
    return meta
  }

  private async run(job: Job): Promise<void> {
    const dir = recordingDir(job.project, job.id)
    const meta = await readMeta(dir)
    if (!meta) return

    const audioPath = join(dir, meta.audioFile ?? 'recording.wav')
    try {
      await fs.access(audioPath)
    } catch {
      await this.setStatus(job, 'failed', {
        error: 'The audio file is missing, so this recording cannot be transcribed.'
      })
      return
    }

    const modelFile = await activeModelPath()
    if (!modelFile) {
      const status = await getModelStatus()
      await this.setStatus(job, 'failed', {
        error: status.binaryMissing
          ? 'The transcription engine is not installed for this platform.'
          : 'No transcription model is installed yet. Download one to continue.'
      })
      return
    }

    const controller = new AbortController()
    this.current = { job, controller }

    await this.setStatus(job, 'transcribing', { error: null })

    try {
      let lastPercent = -1
      const result = await transcribe({
        audioPath,
        modelPath: modelFile,
        signal: controller.signal,
        onProgress: (fraction) => {
          const percent = Math.round(fraction * 100)
          if (percent === lastPercent) return
          lastPercent = percent
          this.emitProgress(meta, percent / 100)
        }
      })

      // Persist the transcript BEFORE verification, so a crash during
      // verification still leaves the user with their text.
      await fs.writeFile(join(dir, TRANSCRIPT_FILE), result.text, 'utf8')

      await this.setStatus(job, 'verifying', { transcriptFile: TRANSCRIPT_FILE })

      const verification = await verifyTranscript({
        audioPath,
        transcript: result.text,
        segments: result.segments,
        recordedDuration: meta.duration
      })

      const passed = verification.status === 'passed' && verification.issues.length === 0

      // Commit the verification verdict to disk first. Cleanup re-reads this
      // from disk, so the deletion decision is made against durable state.
      const committed = await this.setStatus(job, passed ? 'complete' : 'needs_review', {
        verification,
        model: modelFile
      })

      if (passed && committed) {
        const outcome = await deleteAudioIfVerified(dir)
        if (outcome.deleted) {
          const after = await reconcile(dir)
          if (after) this.emit(after)
        }
      }
    } catch (err) {
      const cancelled = controller.signal.aborted
      const message =
        err instanceof WhisperError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Transcription failed for an unknown reason.'

      // Audio is deliberately left in place on every failure path.
      await this.setStatus(job, cancelled ? 'queued' : 'failed', {
        error: cancelled ? null : message,
        verification: cancelled ? meta.verification : failedVerification(message)
      })
    } finally {
      this.current = null
    }
  }

  /**
   * Re-enqueue everything left mid-flight by a previous run, and repair any
   * metadata that disagrees with the filesystem.
   */
  async resumePending(): Promise<void> {
    const projects = await listProjects()

    for (const project of projects) {
      const metas = await listRecordings(project.name)
      for (const meta of metas) {
        const dir = recordingDir(project.name, meta.id)
        const repaired = (await reconcile(dir)) ?? meta

        // 'recording' means the app died mid-capture: the WAV is whatever was
        // flushed, which is still worth transcribing.
        const resumable: TranscriptionStatus[] = [
          'recording',
          'saving',
          'queued',
          'transcribing',
          'verifying'
        ]
        if (!resumable.includes(repaired.transcriptionStatus)) continue

        if (repaired.audioDeleted) {
          await this.setStatus({ project: project.name, id: meta.id }, 'needs_review', {
            error: 'Interrupted before transcription finished and the audio is no longer available.'
          })
          continue
        }

        const patch: Partial<RecordingMeta> = {}

        // A recording interrupted mid-capture has a header that under-reports by
        // up to one flush interval. Rebuild it from the real file size so the
        // last couple of seconds are transcribed rather than silently dropped.
        if (repaired.transcriptionStatus === 'recording' || repaired.transcriptionStatus === 'saving') {
          try {
            const duration = await repairWav(join(dir, repaired.audioFile ?? 'recording.wav'))
            patch.duration = duration
          } catch (err) {
            console.error(`[queue] could not repair ${meta.id}:`, err)
          }
        }

        await this.setStatus({ project: project.name, id: meta.id }, 'queued', patch)
        this.enqueue(project.name, meta.id)
      }
    }
  }
}

export const queue = new TranscriptionQueue()
export { projectsDir }
