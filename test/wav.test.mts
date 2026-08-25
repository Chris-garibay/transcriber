/**
 * The WAV writer holds the only copy of a recording while it is being made, so
 * these tests focus on the crash cases: a file that is still open, and a file
 * whose header under-reports what was actually written.
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import assert from 'assert'
import { WavWriter, repairWav, wavHeader } from '../src/main/audio/wav-writer.ts'
import { readWavInfo } from '../src/main/audio/wav-reader.ts'

let failures = 0
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures++
    console.log(`  FAIL ${name}`)
    console.log(`       ${(err as Error).message}`)
  }
}

const SAMPLE_RATE = 16000
async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'wav-test-'))
  return join(dir, 'recording.wav')
}

/** `seconds` worth of a full-scale square wave, as little-endian Int16. */
function tone(seconds: number): Buffer {
  const frames = Math.floor(SAMPLE_RATE * seconds)
  const buf = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) buf.writeInt16LE(i % 2 === 0 ? 12000 : -12000, i * 2)
  return buf
}

console.log('\nwav writer')

await test('writes a WAV the reader can parse', async () => {
  const path = await tmpFile()
  const writer = await WavWriter.create(path)
  await writer.append(tone(1))
  await writer.close()

  const info = await readWavInfo(path)
  assert.ok(info, 'header did not parse')
  assert.strictEqual(info.sampleRate, 16000)
  assert.strictEqual(info.channels, 1)
  assert.strictEqual(info.bitsPerSample, 16)
  assert.ok(Math.abs(info.duration - 1) < 0.01, `duration was ${info.duration}`)
})

await test('duration tracks appended audio across many chunks', async () => {
  const path = await tmpFile()
  const writer = await WavWriter.create(path)
  for (let i = 0; i < 10; i++) await writer.append(tone(0.5))
  assert.ok(Math.abs(writer.duration - 5) < 0.01, `writer reported ${writer.duration}`)
  await writer.close()
  const info = await readWavInfo(path)
  assert.ok(Math.abs(info.duration - 5) < 0.01, `file reported ${info.duration}`)
})

await test('file is already valid mid-recording, before close', async () => {
  // Simulates the app being killed while recording: whatever has been flushed
  // must already be a readable WAV.
  const path = await tmpFile()
  const writer = await WavWriter.create(path)
  for (let i = 0; i < 6; i++) await writer.append(tone(0.5)) // crosses the 2s flush
  const info = await readWavInfo(path)
  assert.ok(info, 'partially written file did not parse')
  assert.ok(info.duration >= 2, `expected at least one flush, got ${info.duration}`)
  await writer.close()
})

await test('repairWav recovers audio written after the last flush', async () => {
  const path = await tmpFile()
  const writer = await WavWriter.create(path)
  await writer.append(tone(3))
  await writer.flush()
  // Append past the flush, then abandon the handle without closing.
  await fs.appendFile(path, tone(2))

  const before = await readWavInfo(path)
  const recovered = await repairWav(path)
  const after = await readWavInfo(path)

  assert.ok(Math.abs(recovered - 5) < 0.01, `repair reported ${recovered}`)
  assert.ok(Math.abs(after.duration - 5) < 0.01, `after repair: ${after.duration}`)
  assert.ok(after.duration > before.duration, 'repair did not recover anything')
  await writer.close()
})

await test('repairWav trims a torn final frame', async () => {
  const path = await tmpFile()
  const writer = await WavWriter.create(path)
  await writer.append(tone(1))
  await writer.close()
  // A power loss can leave half a sample on disk.
  await fs.appendFile(path, Buffer.from([0x42]))

  const recovered = await repairWav(path)
  const info = await readWavInfo(path)
  assert.ok(info, 'torn file did not parse after repair')
  assert.strictEqual(info.dataBytes % 2, 0, 'payload is not a whole number of samples')
  assert.ok(Math.abs(recovered - 1) < 0.01, `repair reported ${recovered}`)
})

await test('an empty recording produces a valid zero-length WAV', async () => {
  const path = await tmpFile()
  const writer = await WavWriter.create(path)
  await writer.close()
  const info = await readWavInfo(path)
  assert.ok(info, 'empty file did not parse')
  assert.strictEqual(info.dataBytes, 0)
  assert.strictEqual(info.duration, 0)
})

await test('header declares the correct byte rate and block align', async () => {
  const header = wavHeader(32000)
  assert.strictEqual(header.toString('ascii', 0, 4), 'RIFF')
  assert.strictEqual(header.toString('ascii', 8, 12), 'WAVE')
  assert.strictEqual(header.readUInt16LE(20), 1, 'not PCM')
  assert.strictEqual(header.readUInt32LE(24), 16000, 'sample rate')
  assert.strictEqual(header.readUInt32LE(28), 32000, 'byte rate')
  assert.strictEqual(header.readUInt16LE(32), 2, 'block align')
  assert.strictEqual(header.readUInt32LE(40), 32000, 'data size')
  assert.strictEqual(header.readUInt32LE(4), 32036, 'riff size')
})

await test('non-WAV input is rejected rather than misread', async () => {
  const path = await tmpFile()
  await fs.writeFile(path, Buffer.from('this is definitely not a wav file at all'))
  assert.strictEqual(await readWavInfo(path), null)
})

console.log(failures === 0 ? '\nall passed\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
