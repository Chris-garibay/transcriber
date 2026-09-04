/**
 * File import. The failure that matters here is a partial or overwritten WAV:
 * an import that half-lands still produces a header matching its truncated
 * payload, so every downstream check passes and the user gets a clean
 * transcript of the first few minutes with nothing to say the rest is missing.
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import assert from 'assert'
import { claimRecordingDir, recordingIdFor } from '../src/main/storage/claim.ts'
import { titleFromFileName } from '../src/main/storage/names.ts'
import { importer } from '../src/main/recorder/import.ts'
import { readMeta } from '../src/main/storage/metadata.ts'
import { readWavInfo } from '../src/main/audio/wav-reader.ts'

let failures = 0
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
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

async function tmpProject(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'import-test-'))
}

/** `seconds` of decoded PCM, in the shape the renderer streams it. */
function pcm(seconds: number): Buffer {
  const frames = Math.floor(SAMPLE_RATE * seconds)
  const buf = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) buf.writeInt16LE(i % 2 === 0 ? 9000 : -9000, i * 2)
  return buf
}

async function exists(path: string): Promise<boolean> {
  return fs
    .access(path)
    .then(() => true)
    .catch(() => false)
}

console.log('\ntitles from file names')

await test('the extension is dropped and underscores relax into spaces', () => {
  assert.strictEqual(titleFromFileName('CS229_lecture-04.mp4'), 'CS229 lecture-04')
  assert.strictEqual(titleFromFileName('standup.mp3'), 'standup')
  assert.strictEqual(titleFromFileName('talk.v2.m4a'), 'talk.v2')
})

await test('a name with no extension is kept whole', () => {
  assert.strictEqual(titleFromFileName('interview'), 'interview')
})

await test('a path cannot escape the data root through a file name', () => {
  const out = titleFromFileName('../../../etc/passwd.mp3')
  assert.ok(!out.includes('/') && !out.includes('\\'), `separator survived: ${out}`)
  assert.ok(!out.includes('..'), `traversal survived: ${out}`)
})

await test('a name that reduces to nothing still yields a title', () => {
  assert.ok(titleFromFileName('.mp4').length > 0)
  assert.ok(titleFromFileName('   ').length > 0)
})

console.log('\nrecording directory claims')

await test('claims run in sequence and never repeat an id', async () => {
  const project = await tmpProject()
  const first = await claimRecordingDir(project)
  const second = await claimRecordingDir(project)

  assert.strictEqual(first.id, recordingIdFor(1))
  assert.strictEqual(second.id, recordingIdFor(2))
  assert.ok(await exists(first.dir))
  assert.ok(await exists(second.dir))
})

await test('concurrent claims are handed different directories', async () => {
  // A microphone recording and a file import starting together both scan for
  // the highest id at the same moment. Before the claim was the mkdir itself,
  // both were handed the same directory and one overwrote the other's audio.
  const project = await tmpProject()
  const claims = await Promise.all(
    Array.from({ length: 12 }, () => claimRecordingDir(project))
  )

  const ids = new Set(claims.map((c) => c.id))
  assert.strictEqual(ids.size, claims.length, `only ${ids.size} distinct ids for ${claims.length} claims`)
})

await test('an existing gap in the numbering is not reused', async () => {
  const project = await tmpProject()
  await fs.mkdir(join(project, recordingIdFor(1)))
  await fs.mkdir(join(project, recordingIdFor(7)))

  const claimed = await claimRecordingDir(project)
  assert.strictEqual(claimed.id, recordingIdFor(8))
})

await test('a stray file that is not a recording directory is ignored', async () => {
  const project = await tmpProject()
  await fs.writeFile(join(project, 'notes.txt'), 'hello')
  const claimed = await claimRecordingDir(project)
  assert.strictEqual(claimed.id, recordingIdFor(1))
})

console.log('\nimport sessions')

await test('an import lands as a valid WAV with matching metadata', async () => {
  const project = await tmpProject()
  const begun = await importer.begin({
    project: 'Lectures',
    projectDir: project,
    fileName: 'CS229_lecture-04.mp4'
  })

  assert.strictEqual(begun.title, 'CS229 lecture-04')
  assert.strictEqual(begun.source, 'import')
  assert.strictEqual(begun.sourceFile, 'CS229_lecture-04.mp4')
  assert.strictEqual(begun.transcriptionStatus, 'saving')

  for (let i = 0; i < 4; i++) await importer.write(pcm(1.5))
  const finished = await importer.finish()

  assert.strictEqual(finished.transcriptionStatus, 'queued')
  assert.ok(Math.abs(finished.duration - 6) < 0.01, `duration was ${finished.duration}`)

  const info = await readWavInfo(join(project, finished.id, 'recording.wav'))
  assert.ok(info, 'the imported WAV did not parse')
  assert.strictEqual(info.sampleRate, SAMPLE_RATE)
  assert.strictEqual(info.channels, 1)
  // Verification compares these two, so a disagreement here would flag every
  // import as a duration mismatch.
  assert.ok(Math.abs(info.duration - finished.duration) < 0.01, `${info.duration} vs ${finished.duration}`)
})

await test('chunks written without awaiting still land in order', async () => {
  // The renderer awaits each chunk, but the WAV writer derives its offset from
  // a running byte count, so overlapping writes would silently overwrite each
  // other rather than append.
  const project = await tmpProject()
  await importer.begin({ project: 'Lectures', projectDir: project, fileName: 'burst.m4a' })

  await Promise.all(Array.from({ length: 20 }, () => importer.write(pcm(0.5))))
  const finished = await importer.finish()

  assert.ok(Math.abs(finished.duration - 10) < 0.01, `duration was ${finished.duration}`)
  const info = await readWavInfo(join(project, finished.id, 'recording.wav'))
  assert.ok(Math.abs(info!.duration - 10) < 0.01, `file reported ${info!.duration}`)
})

await test('a file with no audio is discarded rather than left unqueueable', async () => {
  const project = await tmpProject()
  const begun = await importer.begin({
    project: 'Lectures',
    projectDir: project,
    fileName: 'slides-only.mp4'
  })

  await assert.rejects(() => importer.finish(), /contains no audio/)
  assert.strictEqual(await exists(join(project, begun.id)), false, 'the empty recording was kept')
})

await test('cancelling removes the partial recording entirely', async () => {
  // A truncated import transcribes cleanly as a short file, so there is no
  // downstream check that would catch it. It must not survive.
  const project = await tmpProject()
  const begun = await importer.begin({
    project: 'Lectures',
    projectDir: project,
    fileName: 'interrupted.mp4'
  })
  await importer.write(pcm(3))
  await importer.cancel()

  assert.strictEqual(await exists(join(project, begun.id)), false, 'the partial import was kept')
  assert.strictEqual(importer.active, false)
})

await test('a second import cannot start while one is in flight', async () => {
  const project = await tmpProject()
  await importer.begin({ project: 'Lectures', projectDir: project, fileName: 'first.mp3' })
  await assert.rejects(
    () => importer.begin({ project: 'Lectures', projectDir: project, fileName: 'second.mp3' }),
    /still being imported/
  )
  await importer.cancel()
})

await test('finishing without a session fails rather than inventing one', async () => {
  await assert.rejects(() => importer.finish(), /no import in progress/)
})

await test('metadata is on disk before the first chunk arrives', async () => {
  // A crash one chunk in must leave a recording the app can recognise on the
  // next launch rather than an orphaned directory.
  const project = await tmpProject()
  const begun = await importer.begin({
    project: 'Lectures',
    projectDir: project,
    fileName: 'early-crash.mp4'
  })

  const onDisk = await readMeta(join(project, begun.id))
  assert.ok(onDisk, 'metadata was not written before the audio')
  assert.strictEqual(onDisk.source, 'import')
  assert.strictEqual(onDisk.transcriptionStatus, 'saving')
  await importer.cancel()
})

console.log(failures === 0 ? '\nall passed\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
