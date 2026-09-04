import { SAMPLE_RATE, CHANNELS } from '@shared/ipc'
import { floatToPcm16 } from './pcm'

/**
 * Formats offered in the file picker. Chromium decodes whatever its bundled
 * demuxers understand, so this list is a convenience rather than a limit --
 * `audio/*` and `video/*` let anything else through and decoding decides.
 */
export const IMPORT_ACCEPT =
  'audio/*,video/*,.mp4,.m4a,.m4b,.mp3,.wav,.aac,.mov,.webm,.ogg,.oga,.opus,.flac,.aif,.aiff,.3gp'

export class ImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportError'
  }
}

/** ~30 s of 16 kHz mono PCM per chunk: just under a megabyte per round trip. */
const CHUNK_FRAMES = SAMPLE_RATE * 30

/**
 * V8's maximum ArrayBuffer length: exactly 2 GiB - 2 MiB.
 *
 * `decodeAudioData` needs the whole container in one ArrayBuffer, so this is
 * the ceiling on an importable file. It is a V8 build constant, not a property
 * of the machine: measured here it is byte-identical across runs and unchanged
 * with a gigabyte already committed, and it is the same number on a laptop and
 * on a workstation -- more RAM does not raise it. It can only move when the
 * bundled Chromium does, which is why it is written as the expression it is
 * rather than as a rounded-down guess.
 */
const MAX_ARRAY_BUFFER_BYTES = 2 ** 31 - 2 ** 21

/**
 * Above this, a failed read is far more likely to be the allocation than a file
 * that vanished, so the message says so. Chromium reports an over-cap blob read
 * as a NotReadableError worded as a permissions problem, and a near-cap one as
 * a RangeError, so neither error identifies the cause on its own.
 */
const SUSPECT_ALLOCATION_ABOVE = 1024 * 1024 * 1024

export interface DecodedAudio {
  /** 16 kHz mono little-endian Int16, ready to stream to the main process. */
  chunks: ArrayBuffer[]
  durationSec: number
}

/**
 * Decode any file Chromium can read into the exact PCM the recorder produces.
 *
 * `decodeAudioData` resamples its result to the sample rate of the context it
 * is called on, so decoding through a 16 kHz `OfflineAudioContext` avoids ever
 * materialising the file at its native rate: a one-hour 48 kHz stereo lecture
 * is 1.4 GB of Float32 decoded natively and 230 MB decoded at 16 kHz. That
 * resample is a property of the call rather than something it can be asked for,
 * so the result is checked and conformed rather than assumed.
 *
 * Doing this in the renderer is what keeps the app ffmpeg-free: Electron ships
 * the same demuxers Chrome does, so mp4, m4a, mp3, wav, flac, ogg and webm all
 * decode with no bundled binary and no separate install.
 */
export async function decodeToPcm16(file: File): Promise<DecodedAudio> {
  if (file.size === 0) throw new ImportError(`"${file.name}" is empty.`)

  // Checked up front because the platform's own errors misattribute the cause:
  // an over-cap read is reported as a permissions failure.
  if (file.size > MAX_ARRAY_BUFFER_BYTES) throw new ImportError(tooLarge(file))

  let bytes: ArrayBuffer
  try {
    bytes = await file.arrayBuffer()
  } catch (err) {
    // Allocation can still fail below the cap when memory is tight, so the
    // ceiling is handled here too rather than assumed screened out above.
    if (err instanceof RangeError || file.size > SUSPECT_ALLOCATION_ABOVE) {
      throw new ImportError(tooLarge(file))
    }
    throw new ImportError(`"${file.name}" could not be read. It may have moved or been renamed.`)
  }

  const decodeContext = new OfflineAudioContext(CHANNELS, 1, SAMPLE_RATE)
  let buffer: AudioBuffer
  try {
    buffer = await decodeContext.decodeAudioData(bytes)
  } catch {
    throw new ImportError(
      `"${file.name}" could not be decoded. It may have no audio track, or its format may not be supported.`
    )
  }

  if (buffer.length === 0) throw new ImportError(`"${file.name}" contains no audio.`)

  if (buffer.sampleRate !== SAMPLE_RATE || buffer.numberOfChannels !== CHANNELS) {
    buffer = await conform(buffer)
  }

  const samples = buffer.getChannelData(0)
  const chunks: ArrayBuffer[] = []
  for (let offset = 0; offset < samples.length; offset += CHUNK_FRAMES) {
    chunks.push(floatToPcm16(samples.subarray(offset, offset + CHUNK_FRAMES)))
  }

  return { chunks, durationSec: samples.length / SAMPLE_RATE }
}

function tooLarge(file: File): string {
  const gb = (file.size / 1_000_000_000).toFixed(1)
  return `"${file.name}" is ${gb} GB, and a file has to fit in one 2 GB buffer to be decoded. This is a limit of the browser engine rather than of this computer, so a machine with more memory would not help. Converting just its audio to an .m4a keeps the same speech in a fraction of the size — a two-hour lecture is well under 200 MB — and that will import.`
}

/**
 * Downmix to mono and resample to 16 kHz, letting the browser's own resampler
 * do it. Only reached when `decodeAudioData` returns something other than the
 * target format, which on current Chromium means a multi-channel result.
 */
async function conform(buffer: AudioBuffer): Promise<AudioBuffer> {
  const frames = Math.max(1, Math.ceil((buffer.length / buffer.sampleRate) * SAMPLE_RATE))
  const context = new OfflineAudioContext(CHANNELS, frames, SAMPLE_RATE)

  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  source.start()

  return context.startRendering()
}
