/**
 * Pure parsing of whisper.cpp JSON output. Kept free of Electron and fs imports
 * so the transcript shape and confidence maths can be tested directly.
 */

/** One segment of whisper output, with the confidence fields we verify against. */
export interface WhisperSegment {
  start: number
  end: number
  text: string
  /** Mean token logprob for the segment; null when the build reports nothing usable. */
  avgLogprob: number | null
  noSpeechProb: number | null
}

/** whisper.cpp control tokens, which carry no transcript content. */
const CONTROL_TOKEN = /^\[_[A-Z]+_?\d*\]$/

interface RawToken {
  text?: string
  p?: number
  plog?: number
}

interface RawSegment {
  offsets?: { from?: number; to?: number }
  text?: string
  avg_logprob?: number
  no_speech_prob?: number
  tokens?: RawToken[]
}

/**
 * Map whisper.cpp's JSON into our segment shape.
 *
 * Builds differ in what confidence they expose: some emit `avg_logprob` per
 * segment, the current CLI emits only per-token probabilities. We derive the
 * average from tokens when needed and leave it null when neither is present,
 * rather than inventing a value that verification would then trust.
 */
export function parseWhisperJson(parsed: unknown): {
  text: string
  segments: WhisperSegment[]
} {
  const root = parsed as { transcription?: RawSegment[] }
  const rows = Array.isArray(root?.transcription) ? root.transcription : []

  const segments: WhisperSegment[] = rows.map((row) => ({
    start: (row.offsets?.from ?? 0) / 1000,
    end: (row.offsets?.to ?? 0) / 1000,
    text: (row.text ?? '').trim(),
    avgLogprob: segmentLogprob(row),
    noSpeechProb: typeof row.no_speech_prob === 'number' ? row.no_speech_prob : null
  }))

  const text = segments
    .map((s) => s.text)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  return { text, segments }
}

function segmentLogprob(row: RawSegment): number | null {
  if (typeof row.avg_logprob === 'number') return row.avg_logprob
  if (!Array.isArray(row.tokens) || row.tokens.length === 0) return null

  const logs = row.tokens
    // Control tokens such as [_BEG_] and [_TT_168] always report p=1 and would
    // inflate the average, so only content tokens are counted.
    .filter((t) => !CONTROL_TOKEN.test(t.text ?? ''))
    .map((t) =>
      typeof t.plog === 'number'
        ? t.plog
        : typeof t.p === 'number'
          ? Math.log(Math.max(t.p, 1e-9))
          : null
    )
    .filter((v): v is number => v !== null)

  if (logs.length === 0) return null
  return logs.reduce((a, b) => a + b, 0) / logs.length
}
