import { spawn } from 'child_process'

/**
 * The child-process half of transcription, kept free of any Electron import so
 * that it can be exercised directly by the test suite. Path resolution and
 * argument construction live in whisper.ts.
 */

/**
 * How long the engine may produce no stderr output at all before we treat the
 * run as hung. Progress lines arrive every few percent, so any real run beats
 * this by orders of magnitude.
 */
export const STALL_TIMEOUT_MS = 10 * 60_000

export class WhisperError extends Error {
  constructor(
    message: string,
    readonly stderr: string = ''
  ) {
    super(message)
    this.name = 'WhisperError'
  }
}

export interface RunCliOptions {
  bin: string
  args: string[]
  cwd: string
  /** Called with 0..1 progress as the engine reports it. */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  /** Overridable only so tests do not have to wait ten minutes. */
  stallTimeoutMs?: number
}

/**
 * Run the whisper CLI to completion and resolve with its stderr.
 *
 * stdout is discarded at the OS level rather than piped. whisper-cli streams
 * every transcript line to stdout, and an unread pipe holds only ~16 KB before
 * the writer blocks on write() forever -- roughly fifteen minutes of speech.
 * That is exactly how an hour-long recording used to sit in 'transcribing'
 * indefinitely. The transcript we actually consume is read back from the JSON
 * file the CLI writes, so there is nothing on stdout worth the deadlock.
 */
export function runWhisperCli(options: RunCliOptions): Promise<string> {
  const { bin, args, cwd, onProgress, signal } = options
  const stallTimeoutMs = options.stallTimeoutMs ?? STALL_TIMEOUT_MS

  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      cwd,
      stdio: ['ignore', 'ignore', 'pipe']
    })

    let errOut = ''
    let settled = false
    let stalled = false
    let stallTimer: NodeJS.Timeout | null = null

    function onAbort(): void {
      if (!settled) child.kill('SIGKILL')
    }

    const finish = (): void => {
      settled = true
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = null
      signal?.removeEventListener('abort', onAbort)
    }

    // Belt and braces: if the engine ever goes quiet for this long it is wedged
    // rather than working, so fail loudly instead of sitting in 'transcribing'
    // forever. Audio is kept on every failure path, so a retry is always safe.
    const armStallTimer = (): void => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        if (settled) return
        stalled = true
        child.kill('SIGKILL')
      }, stallTimeoutMs)
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      errOut += text
      armStallTimer()
      // Progress lines look like: "whisper_print_progress_callback: progress =  42%"
      const match = /progress\s*=\s*(\d+)%/.exec(text)
      if (match && onProgress) onProgress(Math.min(1, parseInt(match[1], 10) / 100))
      if (errOut.length > 64_000) errOut = errOut.slice(-32_000)
    })

    child.on('error', (err) => {
      finish()
      reject(new WhisperError(`Could not start the transcription engine: ${err.message}`))
    })

    child.on('close', (code, sig) => {
      finish()
      if (signal?.aborted) return reject(new WhisperError('Transcription cancelled.', errOut))
      if (stalled) {
        return reject(
          new WhisperError(
            'The transcription engine stopped responding and was stopped. ' +
              'The audio has been kept so this can be retried.',
            errOut
          )
        )
      }
      if (code === 0) return resolve(errOut)
      reject(
        new WhisperError(
          `Transcription engine exited with ${sig ? `signal ${sig}` : `code ${code}`}.`,
          errOut
        )
      )
    })

    armStallTimer()
  })
}
