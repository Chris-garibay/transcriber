import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * Allocation of recording directories. Kept free of any Electron import so the
 * test suite can exercise the race directly.
 */

const RECORDING_DIR = /^Recording (\d+)$/

/** Sequential, human-friendly directory name: "Recording 007". */
export function recordingIdFor(index: number): string {
  return `Recording ${String(index).padStart(3, '0')}`
}

async function highestUsed(projectDir: string): Promise<number> {
  let highest = 0
  try {
    const entries = await fs.readdir(projectDir, { withFileTypes: true })
    for (const entry of entries) {
      const match = RECORDING_DIR.exec(entry.name)
      if (entry.isDirectory() && match) highest = Math.max(highest, parseInt(match[1], 10))
    }
  } catch {
    /* directory is new */
  }
  return highest
}

export interface ClaimedRecording {
  id: string
  dir: string
}

/**
 * Claim the next free "Recording NNN" directory, creating it exclusively.
 *
 * Reading the highest number and then creating the directory is a check-then-act
 * race, and with two capture paths -- a microphone recording and a file import --
 * it is reachable: both scan, both see the same highest number, and both are
 * handed the same directory, so one silently writes its audio over the other's.
 *
 * `mkdir` without `recursive` fails with EEXIST rather than succeeding on a
 * directory that already exists, which makes the create itself the claim. The
 * scan only picks the starting point.
 */
export async function claimRecordingDir(projectDir: string): Promise<ClaimedRecording> {
  await fs.mkdir(projectDir, { recursive: true })

  let candidate = (await highestUsed(projectDir)) + 1
  const limit = candidate + 1000

  for (; candidate < limit; candidate++) {
    const id = recordingIdFor(candidate)
    const dir = join(projectDir, id)
    try {
      await fs.mkdir(dir)
      return { id, dir }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }

  throw new Error('Could not allocate a new recording directory.')
}
