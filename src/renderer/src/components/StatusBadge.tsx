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

export function StatusBadge({
  status,
  progress
}: {
  status: RecordingMeta['transcriptionStatus']
  /** 0..1 while transcribing; shown so a long recording does not look frozen. */
  progress?: number | null
}) {
  const { text, cls } = LABELS[status]
  const percent =
    status === 'transcribing' && typeof progress === 'number'
      ? ` ${Math.round(progress * 100)}%`
      : ''
  return <span className={`badge ${cls}`}>{text}{percent}</span>
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
