import { promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import { SAMPLE_RATE, CHANNELS } from '@shared/ipc'

const HEADER_BYTES = 44
const BITS_PER_SAMPLE = 16
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8

/** Build a canonical 44-byte PCM WAV header for a given payload length. */
export function wavHeader(dataBytes: number): Buffer {
  const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE
  const header = Buffer.alloc(HEADER_BYTES)

  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // PCM fmt chunk size
  header.writeUInt16LE(1, 20) // audio format: PCM
  header.writeUInt16LE(CHANNELS, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32) // block align
  header.writeUInt16LE(BITS_PER_SAMPLE, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)

  return header
}

/**
 * Streaming 16-bit PCM WAV writer.
 *
 * Audio is appended as it arrives and the length fields in the header are
 * rewritten periodically. If the app dies mid-recording the file on disk is
 * already a valid WAV covering everything flushed so far, and `repair()` can
 * fix the header from the true file size for anything written after the last
 * flush. This is what makes "never lose the only copy of the audio" hold.
 */
export class WavWriter {
  private handle: FileHandle | null = null
  private dataBytes = 0
  private sinceFlush = 0
  private closed = false
  private tail: Promise<unknown> = Promise.resolve()

  private constructor(
    handle: FileHandle,
    readonly path: string
  ) {
    this.handle = handle
  }

  static async create(path: string): Promise<WavWriter> {
    const handle = await fs.open(path, 'w')
    await handle.write(wavHeader(0), 0, HEADER_BYTES, 0)
    await handle.sync()
    return new WavWriter(handle, path)
  }

  /** Seconds of audio written so far. */
  get duration(): number {
    return this.dataBytes / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)
  }

  get bytesWritten(): number {
    return this.dataBytes
  }

  /**
   * Serialise every operation against the shared file handle.
   *
   * `appendNow` derives its write offset from `dataBytes`, so two appends that
   * overlap both read the same offset and the second silently overwrites the
   * first. Overlap is the normal case rather than a rare one: microphone PCM
   * arrives as fire-and-forget IPC that never awaits the previous write, and a
   * file import streams its chunks back to back. Chaining is enough here
   * because there is exactly one writer per file.
   */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task)
    // Absorb failures into the chain so one bad write cannot wedge the rest of
    // the recording, while still rejecting the caller that caused it.
    this.tail = next.catch(() => undefined)
    return next
  }

  /** Append interleaved little-endian Int16 samples. */
  append(chunk: Buffer): Promise<void> {
    return this.run(() => this.appendNow(chunk))
  }

  /** Rewrite the header for the current length and force it to disk. */
  flush(): Promise<void> {
    return this.run(() => this.flushNow())
  }

  async close(): Promise<number> {
    return this.run(async () => {
      if (this.closed || !this.handle) return this.dataBytes
      await this.flushNow()
      await this.handle.close()
      this.handle = null
      this.closed = true
      return this.dataBytes
    })
  }

  private async appendNow(chunk: Buffer): Promise<void> {
    if (this.closed || !this.handle) return
    if (chunk.length === 0) return

    await this.handle.write(chunk, 0, chunk.length, HEADER_BYTES + this.dataBytes)
    this.dataBytes += chunk.length
    this.sinceFlush += chunk.length

    // Roughly every 2 seconds of audio, make what we have on disk valid. This
    // calls the unserialised form deliberately: it is already inside the chain,
    // and going through flush() would wait on a link that cannot complete.
    if (this.sinceFlush >= SAMPLE_RATE * BYTES_PER_SAMPLE * 2) {
      await this.flushNow()
    }
  }

  private async flushNow(): Promise<void> {
    if (this.closed || !this.handle) return
    await this.handle.write(wavHeader(this.dataBytes), 0, HEADER_BYTES, 0)
    await this.handle.sync()
    this.sinceFlush = 0
  }
}

/**
 * Recompute a WAV header from the actual file size. Used on startup for any
 * recording that was interrupted, where the header may under-report by up to
 * one flush interval. Returns the recovered duration in seconds.
 */
export async function repairWav(path: string): Promise<number> {
  const stat = await fs.stat(path)
  const dataBytes = Math.max(0, stat.size - HEADER_BYTES)
  if (dataBytes === 0) return 0

  // Trim any partial frame so the payload is a whole number of samples.
  const aligned = dataBytes - (dataBytes % (CHANNELS * BYTES_PER_SAMPLE))

  const handle = await fs.open(path, 'r+')
  try {
    await handle.write(wavHeader(aligned), 0, HEADER_BYTES, 0)
    if (aligned !== dataBytes) await handle.truncate(HEADER_BYTES + aligned)
    await handle.sync()
  } finally {
    await handle.close()
  }

  return aligned / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)
}
