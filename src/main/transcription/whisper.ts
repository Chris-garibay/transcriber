import { spawn } from 'child_process'
import { promises as fs, existsSync } from 'fs'
import { join, dirname } from 'path'
import { cpus } from 'os'
import { parseWhisperJson } from './parse'
import type { WhisperSegment } from './parse'
import { app } from 'electron'

export type { WhisperSegment }

export interface WhisperResult {
  text: string
  segments: WhisperSegment[]
  /** Raw parsed JSON, persisted alongside the transcript for debugging. */
  raw: unknown
}

export class WhisperError extends Error {
  constructor(
    message: string,
    readonly stderr: string = ''
  ) {
    super(message)
    this.name = 'WhisperError'
  }
}

/**
 * Locate the bundled whisper.cpp CLI. In development it comes from the repo's
 * resources directory; once packaged, electron-builder places it beside the
 * app under Resources. Keeping this the only platform switch means the rest of
 * the transcription code is OS-agnostic.
 */
export function whisperBinaryPath(): string {
  const platformDir = `${process.platform}-${process.arch}`
  const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'

  if (app.isPackaged) return join(process.resourcesPath, 'bin', platformDir, exe)

  // In development app.getAppPath() varies with how Electron was launched, so
  // check the plausible roots rather than reporting the engine as missing.
  const roots = [app.getAppPath(), join(app.getAppPath(), '..'), process.cwd()]
  for (const root of roots) {
    const candidate = join(root, 'resources', 'bin', platformDir, exe)
    if (existsSync(candidate)) return candidate
  }
  return join(app.getAppPath(), 'resources', 'bin', platformDir, exe)
}

export async function whisperBinaryAvailable(): Promise<boolean> {
  try {
    await fs.access(whisperBinaryPath(), fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface TranscribeOptions {
  audioPath: string
  modelPath: string
  /** Called with 0..1 progress as whisper reports it. */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/**
 * Run whisper.cpp over a WAV file and return the transcript with per-segment
 * confidence. Runs as a child process rather than a native addon so that a
 * crash inside the model cannot take down the main process while audio is
 * still only on disk.
 */
export async function transcribe(options: TranscribeOptions): Promise<WhisperResult> {
  const { audioPath, modelPath, onProgress, signal } = options
  const bin = whisperBinaryPath()

  // whisper-cli appends .json to --output-file, so point it straight at the
  // name we want rather than letting it derive one from the audio file.
  const outBase = join(dirname(audioPath), 'whisper')
  const jsonPath = `${outBase}.json`
  await fs.rm(jsonPath, { force: true })

  const args = [
    '-m', modelPath,
    '-f', audioPath,
    '--output-json-full',
    '--output-file', outBase,
    '--print-progress',
    '--no-prints',
    '--threads', String(Math.max(2, Math.min(8, (cpus().length || 4) - 1)))
  ]

  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      cwd: dirname(audioPath)
    })

    let errOut = ''
    let settled = false

    const onAbort = (): void => {
      if (!settled) child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      errOut += text
      // Progress lines look like: "whisper_print_progress_callback: progress =  42%"
      const match = /progress\s*=\s*(\d+)%/.exec(text)
      if (match && onProgress) onProgress(Math.min(1, parseInt(match[1], 10) / 100))
      if (errOut.length > 64_000) errOut = errOut.slice(-32_000)
    })

    child.on('error', (err) => {
      settled = true
      signal?.removeEventListener('abort', onAbort)
      reject(new WhisperError(`Could not start the transcription engine: ${err.message}`))
    })

    child.on('close', (code, sig) => {
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new WhisperError('Transcription cancelled.', errOut))
      if (code === 0) return resolve(errOut)
      reject(
        new WhisperError(
          `Transcription engine exited with ${sig ? `signal ${sig}` : `code ${code}`}.`,
          errOut
        )
      )
    })
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(jsonPath, 'utf8'))
  } catch {
    throw new WhisperError('Transcription produced no readable output.', stderr)
  }

  return { ...parseWhisperJson(parsed), raw: parsed }
}
