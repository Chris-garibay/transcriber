/**
 * Guards around user-supplied names. Every project and recording name routes
 * through safeName, so this is the boundary that keeps arbitrary text from
 * escaping the data root -- or from hiding inside it.
 */
import assert from 'assert'
import { safeName, isInside } from '../src/main/storage/names.ts'

let failures = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures++
    console.log(`  FAIL ${name}`)
    console.log(`       ${(err as Error).message}`)
  }
}

console.log('\nname sanitising')

test('path separators cannot survive into a name', () => {
  const out = safeName('../../../etc/pwned')
  assert.ok(!out.includes('/') && !out.includes('\\'), `separator survived: ${out}`)
})

test('a leading dot is stripped so the directory cannot hide', () => {
  // listProjectNames skips anything starting with ".", so a name that keeps
  // its leading dot creates a project the app can never show or delete.
  assert.strictEqual(safeName('.hidden project'), 'hidden project')
  assert.strictEqual(safeName('...leading'), 'leading')
  assert.strictEqual(safeName('..'), 'Untitled')
  assert.strictEqual(safeName('.'), 'Untitled')
  assert.strictEqual(safeName('...'), 'Untitled')
})

test('a dot inside or a normal name is left alone', () => {
  assert.strictEqual(safeName('lecture.notes'), 'lecture.notes')
  assert.strictEqual(safeName('CS 320'), 'CS 320')
})

test('Windows-illegal characters are replaced', () => {
  assert.strictEqual(safeName('a<b>c:d"e|f?g*h'), 'a-b-c-d-e-f-g-h')
})

test('control characters are dropped', () => {
  assert.strictEqual(safeName('cleanname'), 'cleanname')
  assert.strictEqual(safeName('delete'), 'delete')
})

test('Windows reserved device names are suffixed', () => {
  assert.strictEqual(safeName('con'), 'con_')
  assert.strictEqual(safeName('LPT1'), 'LPT1_')
  assert.strictEqual(safeName('console'), 'console')
})

test('trailing dots and spaces are trimmed', () => {
  assert.strictEqual(safeName('trailing...'), 'trailing')
  assert.strictEqual(safeName('  spaced  '), 'spaced')
})

test('empty and whitespace-only input falls back to Untitled', () => {
  assert.strictEqual(safeName(''), 'Untitled')
  assert.strictEqual(safeName('   '), 'Untitled')
})

test('names are capped at 120 characters', () => {
  assert.strictEqual(safeName('x'.repeat(500)).length, 120)
})

test('a name capped mid-space does not keep a trailing space', () => {
  const out = safeName('y'.repeat(119) + '   tail')
  assert.strictEqual(out, out.trim(), `trailing whitespace survived: ${JSON.stringify(out)}`)
})

console.log('\ncontainment')

test('isInside accepts a real child and rejects a sibling', () => {
  assert.strictEqual(isInside('/a/b', '/a/b/c'), true)
  assert.strictEqual(isInside('/a/b', '/a/bc'), false)
  assert.strictEqual(isInside('/a/b', '/a'), false)
  assert.strictEqual(isInside('/a/b', '/a/b'), false)
})

console.log(failures === 0 ? '\nall passed\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
