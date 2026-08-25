import { promises as fs, createWriteStream } from 'fs'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import type { ModelId, ModelInfo, ModelStatus, ModelProgress } from '@shared/types'
import { modelsDir, stateDir } from '../storage/paths'
import { writeJsonAtomic } from '../storage/metadata'
import { whisperBinaryAvailable } from './whisper'

const BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

interface ModelSpec {
  id: ModelId
  label: string
  file: string
  sizeMB: number
}

/**
 * English-only quantised models: the best size/accuracy trade for dictation on
 * a laptop. `small` is the default -- noticeably better than `base` on
 * technical vocabulary, still comfortably faster than real time.
 */
export const MODELS: ModelSpec[] = [
  { id: 'tiny', label: 'Tiny (fastest, least accurate)', file: 'ggml-tiny.en.bin', sizeMB: 78 },
  { id: 'base', label: 'Base (fast)', file: 'ggml-base.en.bin', sizeMB: 148 },
  { id: 'small', label: 'Small (recommended)', file: 'ggml-small.en.bin', sizeMB: 488 },
  { id: 'medium', label: 'Medium (most accurate, slowest)', file: 'ggml-medium.en.bin', sizeMB: 1530 }
]

const SETTINGS_FILE = (): string => join(stateDir(), 'settings.json')

interface Settings {
  activeModel: ModelId
}

async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await fs.readFile(SETTINGS_FILE(), 'utf8')) as Settings
  } catch {
    return { activeModel: 'small' }
  }
}

async function writeSettings(settings: Settings): Promise<void> {
  await fs.mkdir(stateDir(), { recursive: true })
  await writeJsonAtomic(SETTINGS_FILE(), settings)
}

export function modelPath(id: ModelId): string {
  const spec = MODELS.find((m) => m.id === id) ?? MODELS[2]
  return join(modelsDir(), spec.file)
}

async function isInstalled(id: ModelId): Promise<boolean> {
  const spec = MODELS.find((m) => m.id === id)
  if (!spec) return false
  try {
    const stat = await fs.stat(modelPath(id))
    // Guard against a partial download being mistaken for a usable model.
    return stat.size > spec.sizeMB * 1024 * 1024 * 0.9
  } catch {
    return false
  }
}

export async function getModelStatus(): Promise<ModelStatus> {
  const settings = await readSettings()
  const models: ModelInfo[] = await Promise.all(
    MODELS.map(async (spec) => ({
      id: spec.id,
      label: spec.label,
      sizeMB: spec.sizeMB,
      installed: await isInstalled(spec.id)
    }))
  )

  const active = models.find((m) => m.id === settings.activeModel && m.installed)
  const binaryMissing = !(await whisperBinaryAvailable())

  return {
    ready: !binaryMissing && Boolean(active),
    active: active ? active.id : null,
    models,
    binaryMissing
  }
}

export async function selectModel(id: ModelId): Promise<ModelStatus> {
  await writeSettings({ activeModel: id })
  return getModelStatus()
}

/** Resolve the model file to transcribe with, or null when none is ready. */
export async function activeModelPath(): Promise<string | null> {
  const status = await getModelStatus()
  return status.active ? modelPath(status.active) : null
}

/**
 * Download a model to a temp file and rename into place only on success, so an
 * interrupted download can never be picked up as a usable model.
 */
export async function downloadModel(
  id: ModelId,
  onProgress: (progress: ModelProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const spec = MODELS.find((m) => m.id === id)
  if (!spec) throw new Error(`Unknown model "${id}".`)

  await fs.mkdir(modelsDir(), { recursive: true })
  const target = modelPath(id)
  const tmp = `${target}.partial`

  const response = await fetch(`${BASE_URL}/${spec.file}`, { signal })
  if (!response.ok || !response.body) {
    throw new Error(`Model download failed (HTTP ${response.status}).`)
  }

  const totalBytes = Number(response.headers.get('content-length')) || spec.sizeMB * 1024 * 1024
  let receivedBytes = 0
  let lastReport = 0

  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  source.on('data', (chunk: Buffer) => {
    receivedBytes += chunk.length
    // Throttle progress events so IPC is not flooded on a fast connection.
    const now = Date.now()
    if (now - lastReport > 200) {
      lastReport = now
      onProgress({ id, receivedBytes, totalBytes, done: false })
    }
  })

  try {
    await pipeline(source, createWriteStream(tmp))
    await fs.rename(tmp, target)
    onProgress({ id, receivedBytes, totalBytes, done: true })
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}
