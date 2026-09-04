/**
 * The audio deletion guard. Every case here is a way the app could destroy the
 * only copy of a recording, so each one asserts that it does not.
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import assert from 'assert'
import type { RecordingMeta, VerificationIssue } from '../src/shared/types.ts'
import {
  deleteAudioIfVerified,
  deleteAudioOnAcceptance,
  reconcile
} from '../src/main/cleanup/audio-cleanup.ts'

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

interface Fixture {
  status?: RecordingMeta['transcriptionStatus']
  verification?: RecordingMeta['verification']['status']
  issues?: VerificationIssue[]
  transcript?: string | null
  audio?: boolean
  audioDeleted?: boolean
}

/** Build a recording directory on disk in a given state. */
async function makeRecording(options: Fixture = {}): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'transcriber-test-'))
  const {
    status = 'complete',
    verification = 'passed',
    issues = [],
    transcript = 'Hello, this is the transcript body.',
    audio = true,
    audioDeleted = false
  } = options

  if (audio) await fs.writeFile(join(dir, 'recording.wav'), Buffer.alloc(4096))
  if (transcript !== null) await fs.writeFile(join(dir, 'transcript.txt'), transcript, 'utf8')

  const meta: RecordingMeta = {
    id: 'Recording 001',
    title: 'Recording 001',
    project: 'Test',
    createdAt: new Date().toISOString(),
    duration: 12,
    audioFile: audio ? 'recording.wav' : null,
    transcriptFile: transcript !== null ? 'transcript.txt' : null,
    transcriptionStatus: status,
    verification: {
      status: verification,
      issues,
      checkedAt: new Date().toISOString(),
      acceptedAt: verification === 'accepted' ? new Date().toISOString() : null
    },
    audioDeleted,
    error: null,
    model: null,
    schema: 1
  }
  await fs.writeFile(join(dir, 'metadata.json'), JSON.stringify(meta, null, 2), 'utf8')
  return dir
}

const audioExists = async (dir: string): Promise<boolean> =>
  fs.access(join(dir, 'recording.wav')).then(() => true).catch(() => false)

console.log('\naudio cleanup')

await test('deletes audio when verified with zero issues', async () => {
  const dir = await makeRecording()
  const outcome = await deleteAudioIfVerified(dir)
  assert.strictEqual(outcome.deleted, true, outcome.reason)
  assert.strictEqual(await audioExists(dir), false)

  const meta = JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8')) as RecordingMeta
  assert.strictEqual(meta.audioDeleted, true)
  assert.strictEqual(meta.audioFile, null)
})

await test('KEEPS audio when verification reports any issue', async () => {
  const dir = await makeRecording({
    status: 'needs_review',
    verification: 'issues',
    issues: [{ code: 'low_confidence', severity: 'warning', message: 'low confidence' }]
  })
  const outcome = await deleteAudioIfVerified(dir)
  assert.strictEqual(outcome.deleted, false)
  assert.strictEqual(await audioExists(dir), true)
})

await test('KEEPS audio when a passing status still carries issues', async () => {
  // Defends against a caller writing an inconsistent verification result.
  const dir = await makeRecording({
    verification: 'passed',
    issues: [{ code: 'suspicious_gap', severity: 'error', message: 'gap' }]
  })
  const outcome = await deleteAudioIfVerified(dir)
  assert.strictEqual(outcome.deleted, false)
  assert.strictEqual(await audioExists(dir), true)
})

await test('KEEPS audio when verification never ran', async () => {
  const dir = await makeRecording({ status: 'transcribing', verification: 'pending' })
  assert.strictEqual((await deleteAudioIfVerified(dir)).deleted, false)
  assert.strictEqual(await audioExists(dir), true)
})

await test('KEEPS audio when the transcript file is missing on disk', async () => {
  // Metadata claims success but the transcript never landed.
  const dir = await makeRecording({ transcript: null })
  await fs.writeFile(
    join(dir, 'metadata.json'),
    JSON.stringify(
      { ...JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8')), transcriptFile: 'transcript.txt' },
      null,
      2
    )
  )
  const outcome = await deleteAudioIfVerified(dir)
  assert.strictEqual(outcome.deleted, false)
  assert.strictEqual(await audioExists(dir), true)
})

await test('KEEPS audio when the transcript file is empty', async () => {
  const dir = await makeRecording({ transcript: '' })
  const outcome = await deleteAudioIfVerified(dir)
  assert.strictEqual(outcome.deleted, false)
  assert.strictEqual(await audioExists(dir), true)
})

await test('KEEPS audio when the recording is not marked complete', async () => {
  const dir = await makeRecording({ status: 'verifying' })
  assert.strictEqual((await deleteAudioIfVerified(dir)).deleted, false)
  assert.strictEqual(await audioExists(dir), true)
})

await test('KEEPS audio when metadata is unreadable', async () => {
  const dir = await makeRecording()
  await fs.writeFile(join(dir, 'metadata.json'), '{ this is not json', 'utf8')
  const outcome = await deleteAudioIfVerified(dir)
  assert.strictEqual(outcome.deleted, false)
  assert.strictEqual(await audioExists(dir), true)
})

await test('is idempotent -- a second call does not error', async () => {
  const dir = await makeRecording()
  assert.strictEqual((await deleteAudioIfVerified(dir)).deleted, true)
  assert.strictEqual((await deleteAudioIfVerified(dir)).deleted, false)
})

console.log('\nuser acceptance')

const ISSUES: VerificationIssue[] = [
  { code: 'low_confidence', severity: 'warning', message: 'low confidence' },
  { code: 'suspicious_gap', severity: 'error', message: 'a gap' }
]

await test('deletes audio once the user has accepted the issues', async () => {
  const dir = await makeRecording({ verification: 'accepted', issues: ISSUES })
  const outcome = await deleteAudioOnAcceptance(dir)
  assert.strictEqual(outcome.deleted, true, outcome.reason)
  assert.strictEqual(await audioExists(dir), false)

  const meta = JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8')) as RecordingMeta
  assert.strictEqual(meta.audioDeleted, true)
  assert.strictEqual(meta.audioFile, null)
  // The issues are a record of what was found and must survive the acceptance.
  assert.strictEqual(meta.verification.issues.length, 2, 'issues were erased')
  assert.strictEqual(meta.verification.status, 'accepted')
})

await test('acceptance does NOT waive the transcript requirement', async () => {
  // The whole point of deleting audio is that the transcript replaces it. With
  // no transcript there is nothing to keep, and no acceptance can authorise it.
  const dir = await makeRecording({ verification: 'accepted', issues: ISSUES, transcript: null })
  const outcome = await deleteAudioOnAcceptance(dir)
  assert.strictEqual(outcome.deleted, false)
  assert.strictEqual(await audioExists(dir), true)
})

await test('acceptance does NOT waive an empty transcript either', async () => {
  const dir = await makeRecording({ verification: 'accepted', issues: ISSUES, transcript: '' })
  const outcome = await deleteAudioOnAcceptance(dir)
  assert.strictEqual(outcome.deleted, false)
  assert.strictEqual(await audioExists(dir), true)
})

await test('KEEPS audio when the acceptance is not on disk', async () => {
  // The caller cannot assert an acceptance; it is read back from metadata, so a
  // recording still marked as having issues is refused however it was invoked.
  const dir = await makeRecording({ status: 'needs_review', verification: 'issues', issues: ISSUES })
  const outcome = await deleteAudioOnAcceptance(dir)
  assert.strictEqual(outcome.deleted, false)
  assert.strictEqual(await audioExists(dir), true)
})

await test('KEEPS audio when an accepted recording is not yet complete', async () => {
  const dir = await makeRecording({
    status: 'needs_review',
    verification: 'accepted',
    issues: ISSUES
  })
  const outcome = await deleteAudioOnAcceptance(dir)
  assert.strictEqual(outcome.deleted, false)
  assert.strictEqual(await audioExists(dir), true)
})

await test('the automatic path still refuses an accepted recording', async () => {
  // Acceptance must not become a second way into the zero-issue path: only the
  // user-initiated call may act on it.
  const dir = await makeRecording({ verification: 'accepted', issues: ISSUES })
  const outcome = await deleteAudioIfVerified(dir)
  assert.strictEqual(outcome.deleted, false, 'accepted recording was auto-deleted')
  assert.strictEqual(await audioExists(dir), true)
})

await test('acceptance keeps the engine output that explains the issues', async () => {
  const dir = await makeRecording({ verification: 'accepted', issues: ISSUES })
  await fs.writeFile(join(dir, 'whisper.json'), '{"segments":[]}', 'utf8')
  await deleteAudioOnAcceptance(dir)
  const kept = await fs
    .access(join(dir, 'whisper.json'))
    .then(() => true)
    .catch(() => false)
  assert.strictEqual(kept, true, 'raw output was dropped despite unresolved issues')
})

await test('accepting twice is idempotent', async () => {
  const dir = await makeRecording({ verification: 'accepted', issues: ISSUES })
  assert.strictEqual((await deleteAudioOnAcceptance(dir)).deleted, true)
  assert.strictEqual((await deleteAudioOnAcceptance(dir)).deleted, false)
  assert.strictEqual(await audioExists(dir), false)
})

console.log('\ncrash reconciliation')

await test('marks audioDeleted when audio vanished after a crash', async () => {
  // Simulates dying between unlink and the final metadata write.
  const dir = await makeRecording({ audio: false, audioDeleted: false })
  const meta = await reconcile(dir)
  assert.strictEqual(meta?.audioDeleted, true)
  assert.strictEqual(meta?.audioFile, null)
})

await test('clears audioDeleted when the audio is actually present', async () => {
  const dir = await makeRecording({ audio: true, audioDeleted: true })
  const meta = await reconcile(dir)
  assert.strictEqual(meta?.audioDeleted, false)
  assert.strictEqual(meta?.audioFile, 'recording.wav')
})

await test('reconcile never deletes audio', async () => {
  const dir = await makeRecording({ status: 'complete', verification: 'passed' })
  await reconcile(dir)
  assert.strictEqual(await audioExists(dir), true)
})

console.log(failures === 0 ? '\nall passed\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
