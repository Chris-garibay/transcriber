/**
 * Exercises the real parsing and verification code against real whisper.cpp
 * output. The safety property under test: verification returns `passed` with
 * zero issues ONLY for a transcript that genuinely represents the audio,
 * because that is the sole condition under which audio is deleted.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import assert from 'assert'
import { parseWhisperJson } from '../src/main/transcription/parse.ts'
import { verifyTranscript } from '../src/main/verification/verify.ts'

// Fixtures are real whisper.cpp output committed alongside the tests, so the
// suite runs identically here and in CI.
const FIXTURES = process.env.FIXTURES ?? join(import.meta.dirname, 'fixtures')
const load = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

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

console.log('\nverification')

await test('clean speech passes with zero issues', async () => {
  const { text, segments } = parseWhisperJson(load('good.json'))
  const result = await verifyTranscript({
    audioPath: join(FIXTURES, 'good.wav'),
    transcript: text,
    segments,
    recordedDuration: 11.99
  })
  assert.deepStrictEqual(
    result.issues.map((i) => i.code),
    [],
    `expected no issues, got: ${result.issues.map((i) => i.message).join(' | ')}`
  )
  assert.strictEqual(result.status, 'passed')
})

await test('hallucinated [MUSIC PLAYING] is flagged, so audio is kept', async () => {
  const { text, segments } = parseWhisperJson(load('recording.json'))
  const result = await verifyTranscript({
    audioPath: join(FIXTURES, 'recording.wav'),
    transcript: text,
    segments,
    recordedDuration: 1.76
  })
  assert.strictEqual(result.status, 'issues')
  assert.ok(
    result.issues.some((i) => i.code === 'non_speech_annotation'),
    `expected non_speech_annotation, got: ${result.issues.map((i) => i.code).join(', ')}`
  )
})

await test('empty transcript is flagged', async () => {
  const result = await verifyTranscript({
    audioPath: join(FIXTURES, 'good.wav'),
    transcript: '',
    segments: [],
    recordedDuration: 11.99
  })
  assert.ok(result.issues.some((i) => i.code === 'empty_transcript'))
  assert.notStrictEqual(result.status, 'passed')
})

await test('truncated transcript is flagged as incomplete coverage', async () => {
  const { segments } = parseWhisperJson(load('good.json'))
  // Keep only the opening third of the segments.
  const clipped = segments.slice(0, Math.max(1, Math.floor(segments.length / 3)))
  const text = clipped.map((s) => s.text).join(' ')
  const result = await verifyTranscript({
    audioPath: join(FIXTURES, 'good.wav'),
    transcript: text,
    segments: clipped,
    recordedDuration: 11.99
  })
  assert.ok(
    result.issues.some((i) => i.code === 'incomplete_coverage'),
    `expected incomplete_coverage, got: ${result.issues.map((i) => i.code).join(', ')}`
  )
})

await test('duration mismatch is flagged', async () => {
  const { text, segments } = parseWhisperJson(load('good.json'))
  const result = await verifyTranscript({
    audioPath: join(FIXTURES, 'good.wav'),
    transcript: text,
    segments,
    // Claim we recorded far more than the file contains.
    recordedDuration: 60
  })
  assert.ok(result.issues.some((i) => i.code === 'duration_mismatch'))
})

await test('missing audio file is flagged rather than throwing', async () => {
  const result = await verifyTranscript({
    audioPath: join(FIXTURES, 'does-not-exist.wav'),
    transcript: 'some text here',
    segments: [{ start: 0, end: 5, text: 'some text here', avgLogprob: -0.2, noSpeechProb: null }],
    recordedDuration: 5
  })
  assert.strictEqual(result.status, 'issues')
  assert.ok(result.issues.some((i) => i.code === 'audio_unreadable'))
})

await test('repetition loop is flagged', async () => {
  const phrase = 'and then I went to the store'
  const segments = Array.from({ length: 8 }, (_, i) => ({
    start: i * 1.4,
    end: (i + 1) * 1.4,
    text: phrase,
    avgLogprob: -0.3,
    noSpeechProb: null
  }))
  const result = await verifyTranscript({
    audioPath: join(FIXTURES, 'good.wav'),
    transcript: segments.map((s) => s.text).join(' '),
    segments,
    recordedDuration: 11.99
  })
  assert.ok(
    result.issues.some((i) => i.code === 'repetition_loop'),
    `expected repetition_loop, got: ${result.issues.map((i) => i.code).join(', ')}`
  )
})

console.log(failures === 0 ? '\nall passed\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
