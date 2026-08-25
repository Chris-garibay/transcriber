import { promises as fs } from 'fs'
import { CHANNELS } from '@shared/ipc'

export interface WavInfo {
  sampleRate: number
  channels: number
  bitsPerSample: number
  dataOffset: number
  dataBytes: number
  duration: number
}

/**
 * Parse enough of a WAV header to validate it and locate the PCM payload.
 * Returns null when the file is missing, truncated or not PCM WAV -- which
 * verification treats as an unreadable-audio issue rather than a crash.
 */
export async function readWavInfo(path: string): Promise<WavInfo | null> {
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(path, 'r')
  } catch {
    return null
  }

  try {
    const stat = await handle.stat()
    const head = Buffer.alloc(Math.min(4096, stat.size))
    if (head.length < 44) return null
    await handle.read(head, 0, head.length, 0)

    if (head.toString('ascii', 0, 4) !== 'RIFF') return null
    if (head.toString('ascii', 8, 12) !== 'WAVE') return null

    let sampleRate = 0
    let channels = 0
    let bitsPerSample = 0
    let dataOffset = 0
    let declaredDataBytes = 0

    // Walk the chunk list rather than assuming the canonical 44-byte layout.
    let pos = 12
    while (pos + 8 <= head.length) {
      const id = head.toString('ascii', pos, pos + 4)
      const size = head.readUInt32LE(pos + 4)

      if (id === 'fmt ' && pos + 24 <= head.length) {
        channels = head.readUInt16LE(pos + 10)
        sampleRate = head.readUInt32LE(pos + 12)
        bitsPerSample = head.readUInt16LE(pos + 22)
      } else if (id === 'data') {
        dataOffset = pos + 8
        declaredDataBytes = size
        break
      }
      pos += 8 + size + (size % 2)
    }

    if (!sampleRate || !channels || !bitsPerSample || !dataOffset) return null

    // Trust the file size over the header: an interrupted write can leave the
    // declared length stale, and the real bytes are what we can verify against.
    const actual = Math.max(0, stat.size - dataOffset)
    const dataBytes = declaredDataBytes > 0 ? Math.min(declaredDataBytes, actual) : actual
    const bytesPerFrame = channels * (bitsPerSample / 8)

    return {
      sampleRate,
      channels,
      bitsPerSample,
      dataOffset,
      dataBytes,
      duration: bytesPerFrame > 0 ? dataBytes / (sampleRate * bytesPerFrame) : 0
    }
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

/**
 * Mean absolute amplitude (0..1) over a time window, used to decide whether a
 * gap in the transcript sits over silence (fine) or over audible speech that
 * the model dropped (an issue worth keeping the audio for).
 */
export async function windowEnergy(
  path: string,
  info: WavInfo,
  startSec: number,
  endSec: number
): Promise<number> {
  if (info.bitsPerSample !== 16) return 0

  const bytesPerFrame = info.channels * 2
  const clampSec = (s: number): number => Math.max(0, Math.min(info.duration, s))
  const from = info.dataOffset + Math.floor(clampSec(startSec) * info.sampleRate) * bytesPerFrame
  const to = info.dataOffset + Math.floor(clampSec(endSec) * info.sampleRate) * bytesPerFrame

  const length = to - from
  if (length < bytesPerFrame) return 0

  // Cap the read so a long gap in a multi-hour file stays cheap.
  const readLength = Math.min(length, info.sampleRate * bytesPerFrame * 30)

  const handle = await fs.open(path, 'r')
  try {
    const buf = Buffer.alloc(readLength - (readLength % bytesPerFrame))
    await handle.read(buf, 0, buf.length, from)

    let sum = 0
    let count = 0
    // Sample every 8th frame; energy is a coarse signal and this keeps it fast.
    const step = bytesPerFrame * 8
    for (let i = 0; i + 1 < buf.length; i += step) {
      sum += Math.abs(buf.readInt16LE(i))
      count++
    }
    return count > 0 ? sum / count / 32768 : 0
  } catch {
    return 0
  } finally {
    await handle.close()
  }
}

export { CHANNELS }
