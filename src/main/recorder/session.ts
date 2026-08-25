import { promises as fs } from 'fs'
import { join } from 'path'
import type { RecordingMeta, RecordingState } from '@shared/types'
import { recordingDir } from '../storage/paths'
import { AUDIO_FILE, writeMeta, readMeta } from '../storage/metadata'
import { nextRecordingId, newMeta } from '../storage/recordings'
import { WavWriter } from '../audio/wav-writer'

interface ActiveSession {
  project: string
  id: string
  dir: string
  writer: WavWriter
  paused: boolean
  startedAt: number
}

/**
 * Owns the single in-progress recording. Audio arrives from the renderer as
 * 16-bit PCM and is appended straight to disk, so the only copy of the audio
 * is durable within one flush interval of being spoken.
 */
class Recorder {
  private session: ActiveSession | null = null

  get state(): RecordingState {
    if (!this.session) {
      return { active: false, paused: false, id: null, project: null, elapsed: 0 }
    }
    return {
      active: true,
      paused: this.session.paused,
      id: this.session.id,
      project: this.session.project,
      elapsed: this.session.writer.duration
    }
  }

  get active(): boolean {
    return this.session !== null
  }

  async start(project: string): Promise<RecordingMeta> {
    if (this.session) throw new Error('A recording is already in progress.')

    const id = await nextRecordingId(project)
    const dir = recordingDir(project, id)
    await fs.mkdir(dir, { recursive: true })

    const meta = newMeta(project, id)
    // Metadata is written before the first sample so that a crash one second
    // in still leaves a recording the app knows how to recover.
    await writeMeta(dir, meta)

    const writer = await WavWriter.create(join(dir, AUDIO_FILE))
    this.session = { project, id, dir, writer, paused: false, startedAt: Date.now() }
    return meta
  }

  /** Append PCM from the renderer. Silently ignored while paused or stopped. */
  async write(chunk: Buffer): Promise<void> {
    if (!this.session || this.session.paused) return
    await this.session.writer.append(chunk)
  }

  pause(): RecordingState {
    if (this.session) {
      this.session.paused = true
      void this.session.writer.flush()
    }
    return this.state
  }

  resume(): RecordingState {
    if (this.session) this.session.paused = false
    return this.state
  }

  /** Finalise the WAV and return the metadata ready to be queued. */
  async stop(): Promise<RecordingMeta | null> {
    const session = this.session
    if (!session) return null
    this.session = null

    await session.writer.close()
    const duration = session.writer.duration

    const current = await readMeta(session.dir)
    const meta: RecordingMeta = {
      ...(current ?? newMeta(session.project, session.id)),
      duration,
      transcriptionStatus: 'queued'
    }
    await writeMeta(session.dir, meta)
    return meta
  }

  /** Abandon the recording and remove its directory entirely. */
  async cancel(): Promise<void> {
    const session = this.session
    if (!session) return
    this.session = null

    await session.writer.close()
    await fs.rm(session.dir, { recursive: true, force: true })
  }
}

export const recorder = new Recorder()
