import { useEffect, useState } from 'react'
import type { ModelId, ModelProgress, ModelStatus } from '@shared/types'
import { formatBytes } from './format'

/**
 * First-run setup. The app is unusable without a model, so this is surfaced as
 * a blocking notice rather than buried in settings.
 */
export function ModelGate({
  status,
  onChange
}: {
  status: ModelStatus
  onChange: (next: ModelStatus) => void
}) {
  const [progress, setProgress] = useState<ModelProgress | null>(null)
  const [busy, setBusy] = useState<ModelId | null>(null)
  const [error, setError] = useState('')

  useEffect(() => window.api.models.onProgress(setProgress), [])

  async function download(id: ModelId): Promise<void> {
    setBusy(id)
    setError('')
    try {
      onChange(await window.api.models.download(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  if (status.binaryMissing) {
    return (
      <div className="notice error">
        <h4>Transcription engine not installed</h4>
        The whisper.cpp binary for {navigator.userAgent.includes('Mac') ? 'macOS' : 'Windows'} is
        missing. Run <code>npm run fetch:whisper</code> in the project directory to download it,
        then restart the app. Recording still works and your audio is kept safely until an engine
        is available.
      </div>
    )
  }

  if (status.ready) return null

  return (
    <div className="notice info">
      <h4>Choose a transcription model</h4>
      Everything runs on this computer. Download a model once and the app works offline from then
      on.
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {status.models.map((model) => (
          <div key={model.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ flex: 1 }}>
              {model.label} <span style={{ color: 'var(--text-faint)' }}>· {model.sizeMB} MB</span>
            </span>
            {model.installed ? (
              <button onClick={() => void window.api.models.select(model.id).then(onChange)}>
                Use this
              </button>
            ) : (
              <button
                className={model.id === 'small' ? 'primary' : ''}
                disabled={busy !== null}
                onClick={() => void download(model.id)}
              >
                {busy === model.id ? 'Downloading…' : 'Download'}
              </button>
            )}
          </div>
        ))}
      </div>

      {progress && !progress.done && (
        <>
          <div className="progress">
            <div
              className="progress-fill"
              style={{ width: `${(progress.receivedBytes / progress.totalBytes) * 100}%` }}
            />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 4 }}>
            {formatBytes(progress.receivedBytes)} of {formatBytes(progress.totalBytes)}
          </div>
        </>
      )}

      {error && <div style={{ color: 'var(--danger)', marginTop: 8 }}>{error}</div>}
    </div>
  )
}
