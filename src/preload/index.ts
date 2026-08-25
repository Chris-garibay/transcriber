import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  ModelId,
  ModelProgress,
  ModelStatus,
  Project,
  RecordingDetail,
  RecordingMeta,
  RecordingState,
  Result,
  SearchHit,
  TranscriptionUpdate
} from '@shared/types'

/** Unwrap the main process Result envelope, turning failures into throws. */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as Result<T>
  if (!result.ok) throw new Error(result.error)
  return result.value
}

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  projects: {
    list: () => call<Project[]>(IPC.projectsList),
    create: (name: string) => call<string>(IPC.projectsCreate, name),
    rename: (from: string, to: string) => call<string>(IPC.projectsRename, from, to),
    remove: (name: string) => call<void>(IPC.projectsDelete, name)
  },
  recordings: {
    list: (project: string) => call<RecordingMeta[]>(IPC.recordingsList, project),
    get: (project: string, id: string) =>
      call<RecordingDetail | null>(IPC.recordingsGet, project, id),
    rename: (project: string, id: string, title: string) =>
      call<RecordingMeta | null>(IPC.recordingsRename, project, id, title),
    remove: (project: string, id: string) => call<void>(IPC.recordingsDelete, project, id),
    saveTranscript: (project: string, id: string, text: string) =>
      call<RecordingMeta | null>(IPC.recordingsSaveTranscript, project, id, text),
    search: (query: string) => call<SearchHit[]>(IPC.recordingsSearch, query)
  },
  recorder: {
    start: (project: string) => call<RecordingMeta>(IPC.recordStart, project),
    // Transferred, not copied: the renderer hands off the buffer outright.
    sendPcm: (chunk: ArrayBuffer) => ipcRenderer.send(IPC.recordPcm, chunk),
    pause: () => call<RecordingState>(IPC.recordPause),
    resume: () => call<RecordingState>(IPC.recordResume),
    stop: () => call<RecordingMeta | null>(IPC.recordStop),
    cancel: () => call<void>(IPC.recordCancel),
    onState: (handler: (state: RecordingState) => void) =>
      subscribe<RecordingState>(IPC.recordState, handler)
  },
  transcription: {
    retry: (project: string, id: string) => call<void>(IPC.transcriptionRetry, project, id),
    onUpdate: (handler: (update: TranscriptionUpdate) => void) =>
      subscribe<TranscriptionUpdate>(IPC.transcriptionUpdate, handler)
  },
  models: {
    status: () => call<ModelStatus>(IPC.modelStatus),
    download: (id: ModelId) => call<ModelStatus>(IPC.modelDownload, id),
    select: (id: ModelId) => call<ModelStatus>(IPC.modelSelect, id),
    onProgress: (handler: (progress: ModelProgress) => void) =>
      subscribe<ModelProgress>(IPC.modelProgress, handler)
  },
  shell: {
    reveal: (project: string, id: string) => call<void>(IPC.shellReveal, project, id),
    openTranscript: (project: string, id: string) =>
      call<void>(IPC.shellOpenTranscript, project, id),
    openProjectDir: (project: string | null) => call<void>(IPC.shellOpenProjectDir, project),
    rootDir: () => call<string>(IPC.shellRootDir)
  }
}

export type TranscriberApi = typeof api

contextBridge.exposeInMainWorld('api', Object.freeze(api))
