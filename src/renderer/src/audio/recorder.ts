import { SAMPLE_RATE } from '@shared/ipc'
import { floatToPcm16 } from './pcm'

export type MicErrorKind = 'denied' | 'not-found' | 'in-use' | 'unsupported' | 'unknown'

export class MicrophoneError extends Error {
  constructor(
    readonly kind: MicErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'MicrophoneError'
  }
}

/** Turn the browser's opaque getUserMedia rejection into something actionable. */
function toMicError(err: unknown): MicrophoneError {
  const name = (err as { name?: string })?.name ?? ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new MicrophoneError(
        'denied',
        'Microphone access was denied. Grant access in System Settings, then try again.'
      )
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new MicrophoneError('not-found', 'No microphone was found. Connect one and try again.')
    case 'NotReadableError':
    case 'AbortError':
      return new MicrophoneError(
        'in-use',
        'The microphone is unavailable, possibly in use by another application.'
      )
    default:
      return new MicrophoneError('unknown', `Could not start the microphone: ${String(err)}`)
  }
}

/**
 * The worklet runs on the audio thread and posts raw Float32 frames back. It is
 * injected as a blob URL so there is no separate asset to resolve at runtime in
 * both dev and packaged builds.
 */
const WORKLET_SOURCE = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input[0]) {
      // The buffer is reused between calls, so a copy is mandatory.
      this.port.postMessage(new Float32Array(input[0]))
    }
    return true
  }
}
registerProcessor('pcm-tap', PcmTap)
`

export interface CaptureHandle {
  stop: () => Promise<void>
  /** Live input level 0..1, for the meter. */
  level: () => number
}

export interface CaptureOptions {
  deviceId?: string
  onPcm: (chunk: ArrayBuffer) => void
  onError: (err: MicrophoneError) => void
}

/**
 * Open the microphone and stream 16 kHz mono PCM to `onPcm`.
 *
 * The AudioContext is created at the target sample rate so Chromium resamples
 * on the audio thread. That gives whisper.cpp exactly the format it wants with
 * no encoding step, no ffmpeg dependency and no lossy intermediate.
 */
export async function startCapture(options: CaptureOptions): Promise<CaptureHandle> {
  const { deviceId, onPcm, onError } = options

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
  } catch (err) {
    throw toMicError(err)
  }

  const context = new AudioContext({ sampleRate: SAMPLE_RATE })
  const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))

  try {
    await context.audioWorklet.addModule(blobUrl)
  } catch (err) {
    URL.revokeObjectURL(blobUrl)
    stream.getTracks().forEach((t) => t.stop())
    await context.close()
    // addModule reports every failure as an opaque AbortError, and by far the
    // most likely cause is the page CSP refusing the blob: script. Say so,
    // rather than surfacing "The user aborted a request." to the user.
    const name = (err as { name?: string })?.name ?? ''
    throw new MicrophoneError(
      'unsupported',
      name === 'AbortError'
        ? 'The audio processor could not be loaded. This usually means the app\'s content security policy is blocking it; script-src must allow blob:.'
        : `Audio processing is unavailable: ${String(err)}`
    )
  }
  URL.revokeObjectURL(blobUrl)

  const source = context.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(context, 'pcm-tap')

  let currentLevel = 0

  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const samples = event.data

    // Peak level for the meter, computed before the Int16 conversion.
    let peak = 0
    for (let i = 0; i < samples.length; i += 4) {
      const abs = Math.abs(samples[i])
      if (abs > peak) peak = abs
    }
    currentLevel = peak

    onPcm(floatToPcm16(samples))
  }

  // If the device disappears mid-recording, surface it rather than silently
  // capturing nothing for the rest of the session.
  const track = stream.getAudioTracks()[0]
  track?.addEventListener('ended', () => {
    onError(new MicrophoneError('in-use', 'The microphone was disconnected during recording.'))
  })

  source.connect(node)
  // The worklet emits no audio, but Chromium requires a path to the destination
  // for the graph to be pulled.
  node.connect(context.destination)

  // A context can be created in the suspended state, in which case process()
  // is never called and the recording would silently capture nothing.
  if (context.state === 'suspended') await context.resume()

  return {
    level: () => currentLevel,
    stop: async () => {
      node.port.onmessage = null
      try {
        source.disconnect()
        node.disconnect()
      } catch {
        /* already torn down */
      }
      stream.getTracks().forEach((t) => t.stop())
      await context.close()
    }
  }
}

export interface AudioDevice {
  deviceId: string
  label: string
}

/** List input devices. Labels are only populated once permission is granted. */
export async function listInputDevices(): Promise<AudioDevice[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, index) => ({
        deviceId: d.deviceId,
        label: d.label || `Microphone ${index + 1}`
      }))
  } catch {
    return []
  }
}
