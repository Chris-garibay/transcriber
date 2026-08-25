import type { VerificationIssue, VerificationResult } from '@shared/types'
import type { WhisperSegment } from '../transcription/parse'
import { readWavInfo, windowEnergy } from '../audio/wav-reader'

/**
 * Thresholds are deliberately conservative: every one of these is a reason to
 * KEEP the audio, and keeping audio unnecessarily costs disk, while deleting
 * it wrongly costs the recording. When in doubt we flag.
 */
const THRESHOLDS = {
  /** Below this many characters a transcript is treated as effectively empty. */
  minChars: 10,
  /** Transcript must cover at least this fraction of the audio's duration. */
  minCoverage: 0.9,
  /** Header duration and recorded duration may differ by at most this much. */
  durationToleranceSec: 2,
  /** An unexplained gap longer than this is examined for audio energy. */
  gapSec: 15,
  /** Mean absolute amplitude above which a gap counts as containing speech. */
  gapEnergy: 0.02,
  /** Segment mean logprob below this counts as low confidence. */
  lowLogprob: -1.0,
  /** Fraction of low-confidence segments that trips the check. */
  lowConfidenceRatio: 0.25,
  /** Whole-transcript mean logprob below this trips the check on its own. */
  meanLogprobFloor: -1.2,
  /** no_speech_prob above this on a segment that still produced text. */
  noSpeechConflict: 0.6,
  /** A phrase repeated this many times consecutively indicates a decode loop. */
  repetitionRuns: 5,
  /** Fraction of the transcript that may be non-speech annotation before we flag it. */
  annotationRatio: 0.5
}

export interface VerifyInput {
  audioPath: string
  transcript: string
  segments: WhisperSegment[]
  /** Duration we believe we recorded, from the capture session. */
  recordedDuration: number
}

/**
 * Inspect a finished transcript for anything that suggests it is incomplete or
 * wrong. Returns `passed` with an empty issue list only when every check is
 * clean -- that is the sole condition under which the audio may be deleted.
 */
export async function verifyTranscript(input: VerifyInput): Promise<VerificationResult> {
  const { audioPath, transcript, segments, recordedDuration } = input
  const issues: VerificationIssue[] = []

  const info = await readWavInfo(audioPath)

  if (!info) {
    return {
      status: 'issues',
      checkedAt: new Date().toISOString(),
      issues: [
        {
          code: 'audio_unreadable',
          severity: 'error',
          message: 'The audio file could not be read, so the transcript cannot be verified.'
        }
      ]
    }
  }

  const duration = info.duration
  const charCount = transcript.trim().length
  const spoken = segments.filter((s) => s.text.length > 0)
  const coveredSec = spoken.length > 0 ? Math.max(...spoken.map((s) => s.end)) : 0
  const coverageRatio = duration > 0 ? Math.min(1, coveredSec / duration) : 0

  // 1. Empty or near-empty output.
  if (charCount < THRESHOLDS.minChars || spoken.length === 0) {
    issues.push({
      code: 'empty_transcript',
      severity: 'error',
      message:
        charCount === 0
          ? 'No speech was transcribed from this recording.'
          : `The transcript contains only ${charCount} characters, which is too little to trust.`
    })
  }

  // 2. The audio on disk is not the length we thought we recorded.
  if (
    recordedDuration > 0 &&
    Math.abs(duration - recordedDuration) > THRESHOLDS.durationToleranceSec
  ) {
    issues.push({
      code: 'duration_mismatch',
      severity: 'error',
      message: `The audio file is ${duration.toFixed(1)}s but ${recordedDuration.toFixed(1)}s was recorded, so part of the audio may be missing.`
    })
  }

  // 3. Transcript stops well before the audio does.
  if (spoken.length > 0 && duration > 5 && coverageRatio < THRESHOLDS.minCoverage) {
    issues.push({
      code: 'incomplete_coverage',
      severity: 'error',
      message: `The transcript covers only ${Math.round(coverageRatio * 100)}% of the recording and may be cut short.`,
      at: coveredSec
    })
  }

  // 4. Long gaps that actually contain audible sound. Silence is normal;
  //    dropped speech is not, so the WAV itself decides.
  let previousEnd = 0
  for (const segment of spoken) {
    const gap = segment.start - previousEnd
    if (gap > THRESHOLDS.gapSec) {
      const energy = await windowEnergy(audioPath, info, previousEnd, segment.start)
      if (energy > THRESHOLDS.gapEnergy) {
        issues.push({
          code: 'suspicious_gap',
          severity: 'error',
          message: `${Math.round(gap)}s of audible sound between ${fmt(previousEnd)} and ${fmt(segment.start)} produced no transcript.`,
          at: previousEnd
        })
      }
    }
    previousEnd = Math.max(previousEnd, segment.end)
  }

  // 5. Confidence, when the engine reports it.
  const logprobs = spoken
    .map((s) => s.avgLogprob)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))

  let meanLogprob: number | null = null
  let lowConfidenceRatio: number | null = null

  if (logprobs.length > 0) {
    meanLogprob = logprobs.reduce((a, b) => a + b, 0) / logprobs.length
    const lowCount = logprobs.filter((v) => v < THRESHOLDS.lowLogprob).length
    lowConfidenceRatio = lowCount / logprobs.length

    if (meanLogprob < THRESHOLDS.meanLogprobFloor) {
      issues.push({
        code: 'low_confidence',
        severity: 'warning',
        message: `Overall transcription confidence is low (mean log-probability ${meanLogprob.toFixed(2)}).`
      })
    } else if (lowConfidenceRatio > THRESHOLDS.lowConfidenceRatio) {
      issues.push({
        code: 'low_confidence',
        severity: 'warning',
        message: `${Math.round(lowConfidenceRatio * 100)}% of segments were transcribed with low confidence.`
      })
    }
  }

  // 6. Model emitted text for a stretch it also judged to be non-speech.
  const conflicted = spoken.filter(
    (s) => s.noSpeechProb !== null && s.noSpeechProb > THRESHOLDS.noSpeechConflict
  )
  if (conflicted.length > 0) {
    issues.push({
      code: 'no_speech_conflict',
      severity: 'warning',
      message: `${conflicted.length} segment${conflicted.length === 1 ? ' was' : 's were'} transcribed from audio the model judged to contain no speech.`,
      at: conflicted[0].start
    })
  }

  // 7. Decode loops -- Whisper's characteristic failure on silence or noise.
  const loop = findRepetitionLoop(spoken)
  if (loop) {
    issues.push({
      code: 'repetition_loop',
      severity: 'error',
      message: `The phrase "${truncate(loop.phrase, 40)}" repeats ${loop.count} times in a row, which usually means the model got stuck.`,
      at: loop.at
    })
  }

  // 8. Non-speech annotations. Whisper emits "[MUSIC PLAYING]", "[BLANK_AUDIO]"
  //    and similar when it hears no usable speech, and -- importantly -- it
  //    reports high token confidence while doing so, so the confidence checks
  //    above cannot catch this. When such annotations dominate the transcript,
  //    there is effectively no real content and the audio must be kept.
  const annotationChars = countAnnotationChars(transcript)
  if (charCount > 0 && annotationChars / charCount > THRESHOLDS.annotationRatio) {
    issues.push({
      code: 'non_speech_annotation',
      severity: 'error',
      message:
        annotationChars === charCount
          ? 'The transcript contains only non-speech annotations, so no speech was recognised.'
          : `${Math.round((annotationChars / charCount) * 100)}% of the transcript is non-speech annotation rather than spoken words.`
    })
  }

  return {
    status: issues.length === 0 ? 'passed' : 'issues',
    issues,
    checkedAt: new Date().toISOString(),
    stats: {
      durationSec: round(duration),
      coveredSec: round(coveredSec),
      coverageRatio: round(coverageRatio),
      segmentCount: spoken.length,
      charCount,
      meanLogprob: meanLogprob === null ? null : round(meanLogprob),
      lowConfidenceRatio: lowConfidenceRatio === null ? null : round(lowConfidenceRatio)
    }
  }
}

/**
 * Total characters inside bracketed non-speech markers such as [MUSIC PLAYING],
 * (silence) or [BLANK_AUDIO].
 */
function countAnnotationChars(transcript: string): number {
  let total = 0
  for (const match of transcript.matchAll(/[[(][^\])]*[\])]/g)) {
    total += match[0].length
  }
  return total
}

/** Detect a run of consecutive segments whose normalised text is identical. */
function findRepetitionLoop(
  segments: WhisperSegment[]
): { phrase: string; count: number; at: number } | null {
  let runStart = 0
  let runCount = 1

  for (let i = 1; i <= segments.length; i++) {
    const previous = normalise(segments[i - 1].text)
    const current = i < segments.length ? normalise(segments[i].text) : null

    if (current !== null && current === previous && current.length > 0) {
      runCount++
      continue
    }

    if (runCount >= THRESHOLDS.repetitionRuns && previous.length > 0) {
      return {
        phrase: segments[runStart].text,
        count: runCount,
        at: segments[runStart].start
      }
    }
    runStart = i
    runCount = 1
  }

  return null
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Verification outcome for a run that failed before producing a transcript. */
export function failedVerification(message: string): VerificationResult {
  return {
    status: 'error',
    checkedAt: new Date().toISOString(),
    issues: [{ code: 'process_error', severity: 'error', message }]
  }
}
