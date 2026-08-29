/**
 * Exercises the child-process half of transcription against stand-in CLIs.
 *
 * The property under test: a chatty engine must never be able to wedge the
 * app. whisper-cli writes every transcript line to stdout, and an unread
 * stdout pipe holds only ~16 KB before the writer blocks forever -- which is
 * why hour-long recordings sat in 'transcribing' indefinitely while shorter
 * ones finished fine.
 */
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import assert from 'assert'
import { runWhisperCli, WhisperError } from '../src/main/transcription/run-cli.ts'

const dir = mkdtempSync(join(tmpdir(), 'run-cli-'))

/** Writes a fake CLI to disk and returns the args that invoke it via node. */
function fakeCli(name: string, body: string): string[] {
  const path = join(dir, `${name}.cjs`)
  writeFileSync(path, body)
  return [path]
}

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

console.log('\nwhisper child process')

// 4 MB is far past any pipe buffer on macOS (16-64 KB) or Windows, so this
// hangs forever if stdout is ever piped without being drained.
await test('a CLI that floods stdout still completes', async () => {
  const args = fakeCli(
    'flood',
    `const line = 'x'.repeat(200) + '\\n'
     for (let i = 0; i < 20000; i++) process.stdout.write(line)
     process.stderr.write('progress =  100%\\n')`
  )
  const stderr = await runWhisperCli({ bin: process.execPath, args, cwd: dir })
  assert.match(stderr, /progress/)
})

await test('progress is reported from stderr', async () => {
  const args = fakeCli(
    'progress',
    `process.stderr.write('progress =  25%\\n')
     process.stderr.write('progress =  100%\\n')`
  )
  const seen: number[] = []
  await runWhisperCli({
    bin: process.execPath,
    args,
    cwd: dir,
    onProgress: (f) => seen.push(f)
  })
  assert.deepStrictEqual(seen, [0.25, 1])
})

await test('a non-zero exit is reported as a WhisperError', async () => {
  const args = fakeCli('boom', `process.stderr.write('bad model\\n'); process.exit(3)`)
  await assert.rejects(
    runWhisperCli({ bin: process.execPath, args, cwd: dir }),
    (err: unknown) =>
      err instanceof WhisperError && /exited with code 3/.test(err.message) === true
  )
})

await test('a silent hang is killed rather than waited on forever', async () => {
  const args = fakeCli('hang', `setInterval(() => {}, 1000)`)
  const started = Date.now()
  await assert.rejects(
    runWhisperCli({ bin: process.execPath, args, cwd: dir, stallTimeoutMs: 400 }),
    (err: unknown) => err instanceof WhisperError && /stopped responding/.test(err.message)
  )
  assert.ok(Date.now() - started < 10_000, 'should have given up quickly')
})

await test('the stall timer resets while the engine is still talking', async () => {
  const args = fakeCli(
    'slow',
    `let n = 0
     const t = setInterval(() => {
       process.stderr.write('progress =  ' + (++n * 10) + '%\\n')
       if (n === 8) { clearInterval(t); process.exit(0) }
     }, 100)`
  )
  // Each tick is well inside the timeout, but the whole run is well past it.
  await runWhisperCli({ bin: process.execPath, args, cwd: dir, stallTimeoutMs: 400 })
})

await test('aborting cancels the run and reports it as cancelled', async () => {
  const args = fakeCli('long', `setInterval(() => process.stderr.write('progress =  1%\\n'), 50)`)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 200)
  await assert.rejects(
    runWhisperCli({ bin: process.execPath, args, cwd: dir, signal: controller.signal }),
    (err: unknown) => err instanceof WhisperError && /cancelled/.test(err.message)
  )
})

console.log(failures === 0 ? '\nall passed\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
