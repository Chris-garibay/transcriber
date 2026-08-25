const { execFileSync } = require('child_process')
const { join } = require('path')

/**
 * Ad-hoc sign the macOS bundle after packing.
 *
 * electron-builder skips signing entirely when no Developer ID is available,
 * which leaves the app carrying only per-binary linker signatures. codesign
 * reports that bundle as invalid, and macOS responds by moving the app to the
 * Trash on first launch instead of merely warning about an unidentified
 * developer. A proper ad-hoc signature makes the bundle verify cleanly.
 *
 * This is not notarization -- users still clear the quarantine flag once.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )

  console.log(`  • ad-hoc signing  ${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit'
  })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit'
  })
}
