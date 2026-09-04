import { ipcMain, shell, BrowserWindow, app } from 'electron'
import { join } from 'path'
import { IPC } from '@shared/ipc'
import type {
  ModelId,
  Project,
  RecordingDetail,
  RecordingMeta,
  RecordingState,
  Result,
  SearchHit,
  ModelStatus
} from '@shared/types'
import { rootDir, projectDir, recordingDir } from './storage/paths'
import { TRANSCRIPT_FILE, readMeta } from './storage/metadata'
import {
  createProject,
  deleteProject,
  listProjects,
  renameProject,
  ensureRoot
} from './storage/projects'
import {
  deleteRecording,
  getRecording,
  listRecordings,
  renameRecording,
  saveTranscript,
  searchRecordings
} from './storage/recordings'
import { recorder } from './recorder/session'
import { importer } from './recorder/import'
import { queue } from './transcription/queue'
import { getModelStatus, downloadModel, selectModel } from './transcription/model'

/** Wrap a handler so the renderer always receives a Result rather than a throw. */
function handle<A extends unknown[], R>(
  channel: string,
  fn: (...args: A) => Promise<R> | R
): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...(args as A)) } satisfies Result<R>
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[ipc] ${channel} failed:`, message)
      return { ok: false, error: message } satisfies Result<R>
    }
  })
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function registerIpc(): void {
  // ── Projects ───────────────────────────────────────────────────────────────
  handle<[], Project[]>(IPC.projectsList, () => listProjects())
  handle<[string], string>(IPC.projectsCreate, (name) => createProject(name))
  handle<[string, string], string>(IPC.projectsRename, (from, to) => {
    if (recorder.state.project === from) {
      throw new Error('Stop the current recording before renaming this project.')
    }
    if (importer.isBusy(from)) {
      throw new Error('Wait for the file import to finish before renaming this project.')
    }
    if (queue.isBusy(from)) {
      throw new Error('Wait for transcription to finish before renaming this project.')
    }
    return renameProject(from, to)
  })
  handle<[string], void>(IPC.projectsDelete, async (name) => {
    if (recorder.state.project === name) {
      throw new Error('Stop the current recording before deleting this project.')
    }
    if (importer.isBusy(name)) {
      throw new Error('Wait for the file import to finish before deleting this project.')
    }
    if (queue.isBusy(name)) {
      throw new Error('Wait for transcription to finish before deleting this project.')
    }
    await deleteProject(name)
  })

  // ── Recordings ─────────────────────────────────────────────────────────────
  handle<[string], RecordingMeta[]>(IPC.recordingsList, (project) => listRecordings(project))
  handle<[string, string], RecordingDetail | null>(IPC.recordingsGet, (project, id) =>
    getRecording(project, id)
  )
  handle<[string, string, string], RecordingMeta | null>(IPC.recordingsRename, (project, id, title) =>
    renameRecording(project, id, title)
  )
  handle<[string, string], void>(IPC.recordingsDelete, async (project, id) => {
    if (recorder.state.id === id) {
      throw new Error('Stop the current recording before deleting it.')
    }
    if (importer.isBusy(project, id)) {
      throw new Error('Wait for the file import to finish before deleting this recording.')
    }
    if (queue.isBusy(project, id)) {
      throw new Error('Wait for transcription to finish before deleting this recording.')
    }
    await deleteRecording(project, id)
  })
  handle<[string, string, string], RecordingMeta | null>(
    IPC.recordingsSaveTranscript,
    (project, id, text) => saveTranscript(project, id, text)
  )
  handle<[string], SearchHit[]>(IPC.recordingsSearch, (query) => searchRecordings(query))

  // ── Capture ────────────────────────────────────────────────────────────────
  handle<[string], RecordingMeta>(IPC.recordStart, async (project) => {
    const meta = await recorder.start(project)
    broadcast(IPC.recordState, recorder.state)
    return meta
  })

  // Fire-and-forget: the audio stream must never block on a round trip.
  ipcMain.on(IPC.recordPcm, (_event, chunk: ArrayBuffer) => {
    void recorder.write(Buffer.from(chunk)).catch((err) => {
      console.error('[recorder] write failed:', err)
    })
  })

  handle<[], RecordingState>(IPC.recordPause, () => {
    const state = recorder.pause()
    broadcast(IPC.recordState, state)
    return state
  })
  handle<[], RecordingState>(IPC.recordResume, () => {
    const state = recorder.resume()
    broadcast(IPC.recordState, state)
    return state
  })
  handle<[], RecordingMeta | null>(IPC.recordStop, async () => {
    const meta = await recorder.stop()
    broadcast(IPC.recordState, recorder.state)
    if (meta) queue.enqueue(meta.project, meta.id)
    return meta
  })
  handle<[], void>(IPC.recordCancel, async () => {
    await recorder.cancel()
    broadcast(IPC.recordState, recorder.state)
  })

  // ── File import ────────────────────────────────────────────────────────────
  // The renderer decodes the file and streams the same 16 kHz mono PCM the
  // microphone path produces. Only the file's base name crosses the bridge, so
  // the main process never learns where the user's original file lives.
  handle<[string, string], RecordingMeta>(IPC.importBegin, (project, fileName) =>
    importer.begin({ project, projectDir: projectDir(project), fileName })
  )

  // Awaited, unlike the microphone stream: an import has no realtime deadline,
  // and the round trip paces the renderer so it cannot outrun the disk.
  handle<[ArrayBuffer], void>(IPC.importPcm, (chunk) => importer.write(Buffer.from(chunk)))

  handle<[], RecordingMeta>(IPC.importFinish, async () => {
    const meta = await importer.finish()
    queue.enqueue(meta.project, meta.id)
    return meta
  })

  handle<[], void>(IPC.importCancel, () => importer.cancel())

  // ── Transcription ──────────────────────────────────────────────────────────
  handle<[string, string], void>(IPC.transcriptionRetry, async (project, id) => {
    // Without the audio a re-run can only fail, and failing would move a
    // settled recording out of 'complete' for no gain.
    const meta = await readMeta(recordingDir(project, id))
    if (meta?.audioDeleted) {
      throw new Error('The audio for this recording has been removed, so it cannot be transcribed again.')
    }
    queue.enqueue(project, id)
  })

  handle<[string, string], RecordingMeta | null>(IPC.transcriptionAccept, (project, id) =>
    queue.accept(project, id)
  )

  // ── Models ─────────────────────────────────────────────────────────────────
  handle<[], ModelStatus>(IPC.modelStatus, () => getModelStatus())
  handle<[ModelId], ModelStatus>(IPC.modelSelect, (id) => selectModel(id))
  handle<[ModelId], ModelStatus>(IPC.modelDownload, async (id) => {
    await downloadModel(id, (progress) => broadcast(IPC.modelProgress, progress))
    const status = await selectModel(id)
    // A model arriving may unblock recordings that failed for want of one.
    await queue.resumePending()
    return status
  })

  // ── Shell integration ──────────────────────────────────────────────────────
  handle<[string, string], void>(IPC.shellReveal, async (project, id) => {
    const dir = recordingDir(project, id)
    const transcript = join(dir, TRANSCRIPT_FILE)
    // Prefer highlighting the transcript itself; fall back to the folder.
    try {
      await import('fs/promises').then((fsp) => fsp.access(transcript))
      shell.showItemInFolder(transcript)
    } catch {
      shell.openPath(dir)
    }
  })
  handle<[string, string], void>(IPC.shellOpenTranscript, async (project, id) => {
    const path = join(recordingDir(project, id), TRANSCRIPT_FILE)
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })
  handle<[string | null], void>(IPC.shellOpenProjectDir, async (project) => {
    const path = project ? projectDir(project) : rootDir()
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })
  handle<[], string>(IPC.shellRootDir, () => rootDir())

  // Push queue progress to every window.
  queue.onUpdate((update) => broadcast(IPC.transcriptionUpdate, update))

  void ensureRoot()
  void app.whenReady()
}
