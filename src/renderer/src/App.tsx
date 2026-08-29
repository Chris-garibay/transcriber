import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ModelStatus,
  Project,
  RecordingDetail,
  RecordingMeta,
  SearchHit
} from '@shared/types'
import { startCapture, listInputDevices, MicrophoneError } from './audio/recorder'
import type { AudioDevice, CaptureHandle } from './audio/recorder'
import { StatusBadge, StatusDot } from './components/StatusBadge'
import { ModelGate } from './components/ModelGate'
import { usePrompt } from './components/PromptDialog'
import { formatDate, formatDuration } from './components/format'

const ACTIVE_STATES: RecordingMeta['transcriptionStatus'][] = [
  'queued',
  'transcribing',
  'verifying',
  'saving'
]

export default function App(): JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProject, setActiveProject] = useState<string | null>(null)
  const [recordings, setRecordings] = useState<RecordingMeta[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RecordingDetail | null>(null)
  // Transient transcription progress, keyed "project/id". Never persisted.
  const [progress, setProgress] = useState<Record<string, number | null>>({})

  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null)
  const [devices, setDevices] = useState<AudioDevice[]>([])
  const [deviceId, setDeviceId] = useState<string>('')

  const [isRecording, setIsRecording] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [recError, setRecError] = useState('')

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [toast, setToast] = useState('')
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)

  const captureRef = useRef<CaptureHandle | null>(null)
  const recordingIdRef = useRef<string | null>(null)

  const notify = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 2200)
  }, [])

  const { ask, dialog: promptDialog } = usePrompt()

  /**
   * Run an action that talks to the main process and surface any failure.
   * These used to be bare `void api.x()` calls, so a rejected handler became an
   * unhandled rejection and the user saw nothing at all.
   */
  const attempt = useCallback(
    async (action: () => Promise<unknown>, fallback: string): Promise<void> => {
      try {
        await action()
      } catch (err) {
        notify(err instanceof Error ? err.message : fallback)
      }
    },
    [notify]
  )

  // ── Loading ──────────────────────────────────────────────────────────────
  const loadProjects = useCallback(async () => {
    const list = await window.api.projects.list()
    setProjects(list)
    setActiveProject((current) => current ?? list[0]?.name ?? null)
  }, [])

  const loadRecordings = useCallback(async (project: string) => {
    setRecordings(await window.api.recordings.list(project))
  }, [])

  useEffect(() => {
    void loadProjects()
    void window.api.models.status().then(setModelStatus)
    void listInputDevices().then(setDevices)
  }, [loadProjects])

  useEffect(() => {
    if (activeProject) void loadRecordings(activeProject)
  }, [activeProject, loadRecordings])

  // Load the selected recording's transcript.
  useEffect(() => {
    if (!activeProject || !selectedId) {
      setDetail(null)
      setDraft('')
      return
    }
    let cancelled = false
    void window.api.recordings.get(activeProject, selectedId).then((found) => {
      if (cancelled) return
      setDetail(found)
      setDraft(found?.transcript ?? '')
      setDirty(false)
    })
    return () => {
      cancelled = true
    }
  }, [activeProject, selectedId])

  // ── Live updates from the transcription queue ────────────────────────────
  useEffect(
    () =>
      window.api.transcription.onUpdate((update) => {
        setProgress((current) => ({
          ...current,
          [`${update.project}/${update.id}`]: update.progress ?? null
        }))

        setRecordings((current) =>
          current.map((rec) =>
            rec.id === update.id && rec.project === update.project
              ? {
                  ...rec,
                  transcriptionStatus: update.status,
                  verification: update.verification,
                  audioDeleted: update.audioDeleted,
                  error: update.error
                }
              : rec
          )
        )

        // Refresh the open transcript once its text lands.
        setSelectedId((current) => {
          if (current === update.id && !['queued', 'transcribing'].includes(update.status)) {
            void window.api.recordings.get(update.project, update.id).then((found) => {
              setDetail(found)
              setDirty((wasDirty) => {
                if (!wasDirty) setDraft(found?.transcript ?? '')
                return wasDirty
              })
            })
          }
          return current
        })
      }),
    []
  )

  // ── Recording ────────────────────────────────────────────────────────────
  const stopRecording = useCallback(async () => {
    if (!captureRef.current) return
    await captureRef.current.stop()
    captureRef.current = null

    const meta = await window.api.recorder.stop()
    setIsRecording(false)
    setIsPaused(false)
    setElapsed(0)
    setLevel(0)
    recordingIdRef.current = null

    if (meta && activeProject) {
      await loadRecordings(activeProject)
      setSelectedId(meta.id)
    }
  }, [activeProject, loadRecordings])

  async function startRecording(): Promise<void> {
    if (!activeProject || isRecording) return
    setRecError('')

    let meta: RecordingMeta
    try {
      meta = await window.api.recorder.start(activeProject)
    } catch (err) {
      setRecError(err instanceof Error ? err.message : String(err))
      return
    }

    recordingIdRef.current = meta.id
    setIsRecording(true)
    setSelectedId(meta.id)
    await loadRecordings(activeProject)

    try {
      captureRef.current = await startCapture({
        deviceId: deviceId || undefined,
        onPcm: (chunk) => window.api.recorder.sendPcm(chunk),
        onError: (err) => {
          setRecError(err.message)
          void stopRecording()
        }
      })
      // Labels only become readable after permission is granted.
      void listInputDevices().then(setDevices)
    } catch (err) {
      // Capture never started, so discard the empty recording directory.
      await window.api.recorder.cancel()
      setIsRecording(false)
      recordingIdRef.current = null
      setSelectedId(null)
      await loadRecordings(activeProject)
      setRecError(err instanceof MicrophoneError ? err.message : String(err))
    }
  }

  // Drive the timer and level meter from the capture handle.
  useEffect(() => {
    if (!isRecording) return
    const interval = window.setInterval(() => {
      if (!isPaused) setElapsed((seconds) => seconds + 0.1)
      setLevel(captureRef.current?.level() ?? 0)
    }, 100)
    return () => window.clearInterval(interval)
  }, [isRecording, isPaused])

  async function togglePause(): Promise<void> {
    if (isPaused) {
      await window.api.recorder.resume()
      setIsPaused(false)
    } else {
      await window.api.recorder.pause()
      setIsPaused(true)
    }
  }

  // ── Search ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }
    const timer = window.setTimeout(() => {
      void window.api.recordings.search(query).then(setResults)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [query])

  // ── Actions ──────────────────────────────────────────────────────────────
  async function createProject(): Promise<void> {
    const name = await ask({ message: 'Project name', confirmLabel: 'Create' })
    if (!name?.trim()) return
    try {
      const created = await window.api.projects.create(name)
      await loadProjects()
      setActiveProject(created)
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    }
  }

  async function renameProjectAction(name: string): Promise<void> {
    const next = await ask({ message: 'Rename project', initial: name, confirmLabel: 'Rename' })
    if (!next?.trim() || next === name) return
    try {
      const renamed = await window.api.projects.rename(name, next)
      await loadProjects()
      setActiveProject(renamed)
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    }
  }

  async function deleteProjectAction(name: string): Promise<void> {
    if (!window.confirm(`Delete "${name}" and every recording inside it? This cannot be undone.`))
      return
    try {
      await window.api.projects.remove(name)
      setActiveProject(null)
      setSelectedId(null)
      await loadProjects()
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    }
  }

  async function renameRecordingAction(): Promise<void> {
    if (!detail || !activeProject) return
    const next = await ask({
      message: 'Rename recording',
      initial: detail.title,
      confirmLabel: 'Rename'
    })
    if (!next?.trim()) return
    const renamed = await window.api.recordings.rename(activeProject, detail.id, next)
    await loadRecordings(activeProject)
    setDetail({ ...detail, title: renamed?.title ?? next })
  }

  async function deleteRecordingAction(): Promise<void> {
    if (!detail || !activeProject) return
    if (!window.confirm(`Delete "${detail.title}"? This cannot be undone.`)) return
    try {
      await window.api.recordings.remove(activeProject, detail.id)
      setSelectedId(null)
      await loadRecordings(activeProject)
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    }
  }

  async function saveDraft(): Promise<void> {
    if (!detail || !activeProject) return
    await window.api.recordings.saveTranscript(activeProject, detail.id, draft)
    setDirty(false)
    notify('Transcript saved')
  }

  async function copy(text: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      notify(label)
    } catch {
      notify('Could not write to the clipboard.')
    }
  }

  const selectedRecording = useMemo(
    () => recordings.find((r) => r.id === selectedId) ?? null,
    [recordings, selectedId]
  )

  const busyCount = recordings.filter((r) =>
    ACTIVE_STATES.includes(r.transcriptionStatus)
  ).length

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <input
            placeholder="Search transcripts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="sidebar-scroll">
          {query.trim() ? (
            <>
              <div className="section-label">
                {results.length} result{results.length === 1 ? '' : 's'}
              </div>
              {results.map((hit) => (
                <div
                  key={`${hit.project}/${hit.id}`}
                  className="search-result"
                  onClick={() => {
                    setActiveProject(hit.project)
                    setSelectedId(hit.id)
                    setQuery('')
                  }}
                >
                  <div className="title">{hit.title}</div>
                  <div className="where">{hit.project}</div>
                  <div className="excerpt">{hit.excerpt}</div>
                </div>
              ))}
            </>
          ) : (
            <>
              <div className="section-label">Projects</div>
              {projects.map((project) => {
                const isActive = project.name === activeProject
                return (
                  <div key={project.name}>
                    <div
                      className={`project-row ${isActive ? 'active' : ''}`}
                      onClick={() => setActiveProject(project.name)}
                      onDoubleClick={() => void renameProjectAction(project.name)}
                      title="Double-click to rename"
                    >
                      <span className="chevron">{isActive ? '▾' : '▸'}</span>
                      <span className="name">{project.name}</span>
                      <span className="count">{project.recordingCount}</span>
                    </div>

                    {isActive &&
                      recordings.map((rec) => (
                        <div
                          key={rec.id}
                          className={`recording-row ${rec.id === selectedId ? 'active' : ''}`}
                          onClick={() => setSelectedId(rec.id)}
                        >
                          <StatusDot status={rec.transcriptionStatus} />
                          <span className="title">{rec.title}</span>
                        </div>
                      ))}

                    {isActive && recordings.length === 0 && (
                      <div style={{ padding: '4px 24px', color: 'var(--text-faint)', fontSize: 12 }}>
                        No recordings yet
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>

        <div className="sidebar-foot">
          <button onClick={() => void createProject()}>+ Project</button>
          <button
            onClick={() =>
              void attempt(
                () => window.api.shell.openProjectDir(activeProject),
                'Could not open the folder.'
              )
            }
          >
            Open folder
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="main-head">
          <h1>{activeProject ?? 'Transcriber'}</h1>
          {busyCount > 0 && <span className="badge working">{busyCount} in queue</span>}
          {activeProject && (
            <button className="ghost danger" onClick={() => void deleteProjectAction(activeProject)}>
              Delete project
            </button>
          )}
        </div>

        <div className="main-body">
          {modelStatus && <ModelGate status={modelStatus} onChange={setModelStatus} />}

          <div className="recorder">
            {isRecording && !isPaused && <span className="rec-dot" />}
            <span className={`timer ${isRecording ? '' : 'idle'}`}>{formatDuration(elapsed)}</span>

            <div className="meter">
              <div className="meter-fill" style={{ width: `${Math.min(100, level * 140)}%` }} />
            </div>

            <div className="controls">
              {!isRecording ? (
                <button
                  className="primary"
                  disabled={!activeProject}
                  onClick={() => void startRecording()}
                >
                  ● Record
                </button>
              ) : (
                <>
                  <button onClick={() => void togglePause()}>
                    {isPaused ? '▶ Resume' : '❚❚ Pause'}
                  </button>
                  <button className="primary" onClick={() => void stopRecording()}>
                    ■ Stop
                  </button>
                </>
              )}
            </div>

            {!isRecording && devices.length > 1 && (
              <select
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                style={{
                  background: 'var(--bg-raised)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  padding: '6px 8px',
                  maxWidth: 190
                }}
              >
                <option value="">Default microphone</option>
                {devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            )}
          </div>

          {recError && <div className="notice error">{recError}</div>}

          {detail ? (
            <Detail
              detail={detail}
              meta={selectedRecording}
              progress={progress[`${detail.project}/${detail.id}`] ?? null}
              draft={draft}
              dirty={dirty}
              onDraft={(text) => {
                setDraft(text)
                setDirty(true)
              }}
              onSave={saveDraft}
              onCopy={copy}
              onRename={renameRecordingAction}
              onDelete={deleteRecordingAction}
              onRetry={async () => {
                if (!activeProject) return
                await attempt(async () => {
                  await window.api.transcription.retry(activeProject, detail.id)
                  notify('Re-queued for transcription')
                }, 'Could not re-queue this recording.')
              }}
              onReveal={() =>
                attempt(
                  () => window.api.shell.reveal(detail.project, detail.id),
                  'Could not reveal this recording.'
                )
              }
              onOpenInEditor={() =>
                attempt(
                  () => window.api.shell.openTranscript(detail.project, detail.id),
                  'Could not open the transcript.'
                )
              }
            />
          ) : (
            <div className="empty">
              {activeProject
                ? 'Press Record to capture a thought, then paste the transcript wherever you need it.'
                : 'Create a project to get started.'}
            </div>
          )}
        </div>
      </main>

      {promptDialog}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

// ── Detail pane ────────────────────────────────────────────────────────────

function Detail({
  detail,
  meta,
  progress,
  draft,
  dirty,
  onDraft,
  onSave,
  onCopy,
  onRename,
  onDelete,
  onRetry,
  onReveal,
  onOpenInEditor
}: {
  detail: RecordingDetail
  meta: RecordingMeta | null
  progress: number | null
  draft: string
  dirty: boolean
  onDraft: (text: string) => void
  onSave: () => Promise<void>
  onCopy: (text: string, label: string) => Promise<void>
  onRename: () => Promise<void>
  onDelete: () => Promise<void>
  onRetry: () => Promise<void>
  onReveal: () => Promise<void>
  onOpenInEditor: () => Promise<void>
}): JSX.Element {
  const status = meta?.transcriptionStatus ?? detail.transcriptionStatus
  const verification = meta?.verification ?? detail.verification
  const audioDeleted = meta?.audioDeleted ?? detail.audioDeleted
  const error = meta?.error ?? detail.error
  const working = ['queued', 'transcribing', 'verifying', 'saving', 'recording'].includes(status)

  const metadataBlock = [
    `Title: ${detail.title}`,
    `Project: ${detail.project}`,
    `Recorded: ${formatDate(detail.createdAt)}`,
    `Duration: ${formatDuration(detail.duration)}`,
    `Path: ${detail.transcriptPath ?? detail.dirPath}`,
    '',
    draft
  ].join('\n')

  return (
    <>
      <div className="detail-head">
        <h2>{detail.title}</h2>
        <StatusBadge status={status} progress={progress} />
      </div>
      <div className="detail-meta">
        {formatDate(detail.createdAt)} · {formatDuration(detail.duration)}
        {audioDeleted ? ' · audio removed after verification' : ' · audio retained'}
      </div>

      {status === 'failed' && (
        <div className="notice error">
          <h4>Transcription failed</h4>
          {error ?? 'The transcription engine did not produce a transcript.'}
          <div style={{ marginTop: 6, color: 'var(--text-dim)' }}>
            The original audio has been kept so this can be retried.
          </div>
          <div className="row">
            <button onClick={() => void onRetry()}>Retry transcription</button>
          </div>
        </div>
      )}

      {status === 'needs_review' && verification.issues.length > 0 && (
        <div className="notice warn">
          <h4>
            Needs review — {verification.issues.length} issue
            {verification.issues.length === 1 ? '' : 's'} found
          </h4>
          <ul>
            {verification.issues.map((issue, index) => (
              <li key={index}>{issue.message}</li>
            ))}
          </ul>
          <div style={{ marginTop: 8, color: 'var(--text-dim)' }}>
            The audio has been kept so you can retranscribe or listen back.
          </div>
          <div className="row">
            <button onClick={() => void onRetry()}>Retranscribe</button>
          </div>
        </div>
      )}

      {working && (
        <div className="notice info">
          {status === 'queued' && 'Waiting for a transcription slot…'}
          {status === 'transcribing' &&
            (typeof progress === 'number'
              ? `Transcribing locally on this computer — ${Math.round(progress * 100)}% of ${formatDuration(detail.duration)}…`
              : 'Transcribing locally on this computer…')}
          {status === 'verifying' && 'Verifying the transcript…'}
          {status === 'recording' && 'Recording in progress.'}
          {status === 'saving' && 'Saving audio…'}
        </div>
      )}

      <textarea
        className="transcript"
        value={draft}
        placeholder={working ? 'Transcript will appear here.' : 'No transcript text.'}
        onChange={(e) => onDraft(e.target.value)}
      />

      <div className="actions">
        <button className="primary" onClick={() => void onCopy(draft, 'Transcript copied')}>
          Copy
        </button>
        <button onClick={() => void onCopy(metadataBlock, 'Transcript + metadata copied')}>
          Copy with metadata
        </button>
        <button
          onClick={() =>
            void onCopy(detail.transcriptPath ?? detail.dirPath, 'Path copied')
          }
        >
          Copy path
        </button>
        <button onClick={() => void onReveal()}>
          Reveal in {navigator.userAgent.includes('Mac') ? 'Finder' : 'Explorer'}
        </button>
        <button disabled={!detail.transcriptFile} onClick={() => void onOpenInEditor()}>
          Open in editor
        </button>
        <button onClick={() => void onRename()}>Rename</button>
        <button className="danger" onClick={() => void onDelete()}>
          Delete
        </button>
        {dirty && (
          <button className="primary" onClick={() => void onSave()}>
            Save edits
          </button>
        )}
      </div>

      {detail.transcriptPath && (
        <div className="path-hint">
          Read:{'\n'}
          {detail.transcriptPath}
        </div>
      )}
    </>
  )
}
