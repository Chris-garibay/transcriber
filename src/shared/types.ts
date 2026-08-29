/**
 * Types shared by the main process, preload and renderer.
 * This file must stay free of any Node or DOM imports.
 */

/** Lifecycle of a recording, as persisted in metadata.json. */
export type TranscriptionStatus =
  | 'recording'   // audio is still being captured
  | 'saving'      // capture stopped, WAV being finalised
  | 'queued'      // waiting for a transcription slot
  | 'transcribing'
  | 'verifying'
  | 'complete'    // verified with zero issues; audio deleted
  | 'needs_review'// transcript exists but verification found issues; audio kept
  | 'failed'      // transcription could not produce a transcript; audio kept

export type VerificationStatus = 'pending' | 'passed' | 'issues' | 'error'

/** A single problem found during verification. Presence of ANY issue keeps the audio. */
export interface VerificationIssue {
  code:
    | 'process_error'
    | 'output_unreadable'
    | 'empty_transcript'
    | 'audio_unreadable'
    | 'duration_mismatch'
    | 'incomplete_coverage'
    | 'suspicious_gap'
    | 'low_confidence'
    | 'no_speech_conflict'
    | 'repetition_loop'
    | 'non_speech_annotation'
  severity: 'error' | 'warning'
  message: string
  /** Offset in seconds into the recording, when the issue is localised. */
  at?: number
}

export interface VerificationResult {
  status: VerificationStatus
  issues: VerificationIssue[]
  checkedAt: string | null
  /** Diagnostics surfaced in the UI; never used to gate deletion on its own. */
  stats?: {
    durationSec: number
    coveredSec: number
    coverageRatio: number
    segmentCount: number
    charCount: number
    meanLogprob: number | null
    lowConfidenceRatio: number | null
  }
}

export interface RecordingMeta {
  /** Directory name under the project; stable identifier. */
  id: string
  title: string
  project: string
  createdAt: string
  /** Seconds of captured audio, excluding paused time. */
  duration: number
  audioFile: string | null
  transcriptFile: string | null
  transcriptionStatus: TranscriptionStatus
  verification: VerificationResult
  audioDeleted: boolean
  /** Populated when transcription fails, for display and retry context. */
  error?: string | null
  model?: string | null
  /** Schema version, so future migrations can be detected. */
  schema: 1
}

/** A recording plus its transcript body, for the detail pane. */
export interface RecordingDetail extends RecordingMeta {
  transcript: string
  /** Absolute path to the recording directory, for copy-path and reveal. */
  dirPath: string
  transcriptPath: string | null
}

export interface Project {
  name: string
  recordingCount: number
}

export interface SearchHit {
  id: string
  project: string
  title: string
  createdAt: string
  /** Text around the first match, for display in results. */
  excerpt: string
}

/** Pushed to the renderer whenever a recording changes state. */
export interface TranscriptionUpdate {
  id: string
  project: string
  status: TranscriptionStatus
  verification: VerificationResult
  audioDeleted: boolean
  error?: string | null
  /**
   * 0..1 while the engine is transcribing, null at every other point. Purely
   * for display; it is never persisted, so it resets on restart.
   */
  progress?: number | null
}

export type ModelId = 'tiny' | 'base' | 'small' | 'medium'

export interface ModelInfo {
  id: ModelId
  label: string
  sizeMB: number
  installed: boolean
}

export interface ModelStatus {
  ready: boolean
  active: ModelId | null
  models: ModelInfo[]
  /** True when the whisper binary itself is missing for this platform. */
  binaryMissing: boolean
}

export interface ModelProgress {
  id: ModelId
  receivedBytes: number
  totalBytes: number
  done: boolean
  error?: string
}

export interface RecordingState {
  active: boolean
  paused: boolean
  id: string | null
  project: string | null
  /** Seconds of audio actually written, excluding paused time. */
  elapsed: number
}

/** Uniform result wrapper so the renderer never has to catch IPC rejections. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }
