import type { RecordingMeta } from '@shared/types'

const LABELS: Record<RecordingMeta['transcriptionStatus'], { text: string; cls: string }> = {
  recording: { text: 'Recording', cls: 'working' },
  saving: { text: 'Saving', cls: 'working' },
  queued: { text: 'Waiting', cls: 'working' },
  transcribing: { text: 'Transcribing', cls: 'working' },
  verifying: { text: 'Verifying', cls: 'working' },
  complete: { text: 'Complete', cls: 'complete' },
  needs_review: { text: 'Needs review', cls: 'review' },
  failed: { text: 'Failed', cls: 'failed' }
}

export function StatusBadge({ status }: { status: RecordingMeta['transcriptionStatus'] }) {
  const { text, cls } = LABELS[status]
  return <span className={`badge ${cls}`}>{text}</span>
}

/** Compact dot used in the sidebar where a full badge would be too noisy. */
export function StatusDot({ status }: { status: RecordingMeta['transcriptionStatus'] }) {
  const colour =
    status === 'complete'
      ? 'var(--ok)'
      : status === 'needs_review'
        ? 'var(--warn)'
        : status === 'failed'
          ? 'var(--danger)'
          : 'var(--accent)'
  const spinning = ['queued', 'transcribing', 'verifying', 'saving', 'recording'].includes(status)
  return (
    <span
      title={LABELS[status].text}
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: colour,
        flexShrink: 0,
        animation: spinning ? 'pulse 1.4s ease-in-out infinite' : undefined
      }}
    />
  )
}
