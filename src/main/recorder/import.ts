import { promises as fs } from 'fs'
import { join } from 'path'
import type { RecordingMeta } from '@shared/types'
import { AUDIO_FILE, newMeta, readMeta, writeMeta } from '../storage/metadata'
import { claimRecordingDir } from '../storage/claim'
import { titleFromFileName } from '../storage/names'
import { WavWriter } from '../audio/wav-writer'

interface ActiveImport {
  project: string
  id: string
  dir: string
  writer: WavWriter
  fileName: string
}

export interface BeginImport {
  project: string
  /** Resolved by the caller, so this module stays free of Electron imports. */
  projectDir: string
  /** Base name of the chosen file, for the title and for display. */
  fileName: string
}

/**
 * Owns the single in-progress file import.
 *
 * The renderer decodes the chosen file to 16 kHz mono PCM and streams it here,
 * so the audio lands on disk in exactly the format a microphone capture
 * produces and every downstream stage -- queue, verification, cleanup -- runs
 * unchanged against it.
 *
 * The user's original file is never opened by this process and its path never
 * crosses the bridge; only the base name arrives, for the title. That keeps the
 * import strictly additive: nothing this app does can touch the source file,
 * including the cleanup step that deletes derived audio after verification.
 */
class Importer {
  private session: ActiveImport | null = null

  get active(): boolean {
    return this.session !== null
  }

  /**
   * True when a recording -- or, with no id, any recording in the project -- is
   * being written by an import right now. Callers use this to refuse edits that
   * would move or remove a directory being written into.
   */
  isBusy(project: string, id?: string): boolean {
    if (!this.session) return false
    return this.session.project === project && (id === undefined || this.session.id === id)
  }

  async begin(options: BeginImport): Promise<RecordingMeta> {
    if (this.session) throw new Error('Another file is still being imported.')

    const { id, dir } = await claimRecordingDir(options.projectDir)

    const meta: RecordingMeta = {
      ...newMeta(options.project, id),
      title: titleFromFileName(options.fileName),
      // 'saving' rather than 'recording': nothing is being captured live, and
      // the two states recover differently if the app dies mid-import.
      transcriptionStatus: 'saving',
      source: 'import',
      sourceFile: options.fileName
    }
    // Written before the first sample so a crash one chunk in still leaves a
    // recording the app knows how to recognise and recover.
    await writeMeta(dir, meta)

    const writer = await WavWriter.create(join(dir, AUDIO_FILE))
    this.session = { project: options.project, id, dir, writer, fileName: options.fileName }
    return meta
  }

  /** Append decoded PCM. Silently ignored once the session has ended. */
  async write(chunk: Buffer): Promise<void> {
    if (!this.session) return
    await this.session.writer.append(chunk)
  }

  /** Finalise the WAV and return the metadata ready to be queued. */
  async finish(): Promise<RecordingMeta> {
    const session = this.session
    if (!session) throw new Error('There is no import in progress.')
    this.session = null

    const bytes = await session.writer.close()

    // A video with no audio track, or one that decoded to nothing, would
    // otherwise land as an empty recording that can never be transcribed.
    if (bytes === 0) {
      await fs.rm(session.dir, { recursive: true, force: true })
      throw new Error(`"${session.fileName}" contains no audio.`)
    }

    const current = await readMeta(session.dir)
    const meta: RecordingMeta = {
      ...(current ?? newMeta(session.project, session.id)),
      duration: session.writer.duration,
      transcriptionStatus: 'queued'
    }
    await writeMeta(session.dir, meta)
    return meta
  }

  /**
   * Abandon the import and remove its directory entirely.
   *
   * A partially written import is worse than no import at all: its header
   * matches its truncated payload, so nothing downstream can tell it apart from
   * a short file, and it would transcribe cleanly as the first few minutes of
   * the lecture. The source file is untouched, so discarding is always safe.
   */
  async cancel(): Promise<void> {
    const session = this.session
    if (!session) return
    this.session = null

    await session.writer.close()
    await fs.rm(session.dir, { recursive: true, force: true })
  }
}

export const importer = new Importer()
