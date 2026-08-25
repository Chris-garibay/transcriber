#!/usr/bin/env node
/**
 * Put a working whisper.cpp CLI in resources/bin/<platform>-<arch>/.
 *
 * Windows: upstream publishes a prebuilt x64 archive, so download it.
 * macOS:   upstream ships no CLI build (only an xcframework), so compile from
 *          source with Metal enabled. Requires cmake and the Xcode command
 *          line tools, both of which a Mac dev machine normally has.
 *
 * Binaries are vendored into the repo rather than built during `npm install`
 * so that installing dependencies stays fast and toolchain-free.
 */
import { createWriteStream, promises as fs } from 'fs'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { spawn } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'https://github.com/ggml-org/whisper.cpp'
const TAG = process.env.WHISPER_VERSION ?? 'v1.7.6'

// TARGET_ARCH lets CI cross-build (an Apple Silicon runner producing the Intel
// binary), since GitHub retired its Intel macOS runners.
// Use || rather than ??: a matrix key that is absent arrives as an empty
// string, which ?? would happily accept and turn into a "darwin-" path.
const targetArch = process.env.TARGET_ARCH || process.arch

if (!['x64', 'arm64'].includes(targetArch)) {
  console.error(`Unsupported TARGET_ARCH "${targetArch}". Expected x64 or arm64.`)
  process.exit(1)
}
const platformKey = `${process.platform}-${targetArch}`
const exeName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
const destDir = join(root, 'resources', 'bin', platformKey)
const destExe = join(destDir, exeName)

function sh(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))
    )
  })
}

async function exists(path) {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/** Copy the CLI plus any shared libraries it links against. */
async function install(fromDir, binaryName) {
  await fs.mkdir(destDir, { recursive: true })
  await fs.copyFile(join(fromDir, binaryName), destExe)
  if (process.platform !== 'win32') await fs.chmod(destExe, 0o755)

  for (const file of await fs.readdir(fromDir)) {
    if (/\.(dylib|so(\.\d+)*|dll)$/.test(file)) {
      await fs.copyFile(join(fromDir, file), join(destDir, file))
    }
  }
}

async function buildFromSource() {
  const workDir = join(tmpdir(), 'whisper-cpp-build')
  await fs.rm(workDir, { recursive: true, force: true })

  console.log(`Cloning whisper.cpp ${TAG}…`)
  await sh('git', ['clone', '--depth', '1', '--branch', TAG, REPO, workDir])

  console.log('Building (this takes a couple of minutes)…')
  // Static libraries plus an embedded Metal shader produce a single relocatable
  // executable, which is what makes the binary safe to copy into the app bundle.
  const flags = [
    '-B', 'build',
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DWHISPER_BUILD_EXAMPLES=ON',
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_SERVER=OFF',
    '-DGGML_METAL_EMBED_LIBRARY=ON'
  ]

  if (targetArch !== process.arch) {
    // Cross-compiling: name the target explicitly and turn off -march=native,
    // which would otherwise emit instructions for the build host.
    flags.push(`-DCMAKE_OSX_ARCHITECTURES=${targetArch === 'x64' ? 'x86_64' : 'arm64'}`)
    flags.push('-DGGML_NATIVE=OFF')
    console.log(`Cross-compiling for ${targetArch} on ${process.arch}`)
  }

  await sh('cmake', flags, { cwd: workDir })
  await sh('cmake', ['--build', 'build', '--config', 'Release', '-j'], { cwd: workDir })

  // The CLI lands in build/bin; shared ggml libraries sit alongside it.
  const binDir = join(workDir, 'build', 'bin')
  if (!(await exists(join(binDir, 'whisper-cli')))) {
    throw new Error(`Build finished but whisper-cli was not found in ${binDir}`)
  }

  await install(binDir, 'whisper-cli')
  await fs.rm(workDir, { recursive: true, force: true })
}

async function downloadPrebuilt(assetName) {
  const url = `${REPO}/releases/download/${TAG}/${assetName}`
  console.log(`Downloading ${url}`)

  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`)

  const archive = join(tmpdir(), assetName)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive))

  const extractDir = join(tmpdir(), `whisper-extract-${Date.now()}`)
  await fs.mkdir(extractDir, { recursive: true })
  await sh('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -Path "${archive}" -DestinationPath "${extractDir}" -Force`
  ])

  const found = await locate(extractDir, exeName)
  if (!found) throw new Error(`${exeName} was not found inside ${assetName}`)

  await install(dirname(found), exeName)
  await fs.rm(archive, { force: true })
  await fs.rm(extractDir, { recursive: true, force: true })
}

async function locate(dir, name) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await locate(path, name)
      if (nested) return nested
    } else if (entry.name === name) {
      return path
    }
  }
  return null
}

async function main() {
  if (await exists(destExe)) {
    console.log(`whisper-cli already present at ${destExe}`)
    return
  }

  if (process.platform === 'win32' && process.arch === 'x64') {
    await downloadPrebuilt('whisper-bin-x64.zip')
  } else if (process.platform === 'darwin' && (targetArch === 'arm64' || targetArch === 'x64')) {
    await buildFromSource()
  } else {
    throw new Error(`Unsupported platform: ${platformKey}. Only macOS and Windows are supported.`)
  }

  console.log(`Installed whisper-cli to ${destExe}`)
}

main().catch((err) => {
  console.error(`\n${err.message}\n`)
  console.error('To install manually:')
  console.error(`  git clone ${REPO} && cd whisper.cpp`)
  console.error('  cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j --config Release')
  console.error(`  cp build/bin/whisper-cli ${destExe}`)
  process.exit(1)
})
