import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const electronDirectory = dirname(require.resolve('electron/package.json'))
const pathFile = join(electronDirectory, 'path.txt')
const installScript = join(electronDirectory, 'install.js')
const fallbackMirror = 'https://npmmirror.com/mirrors/electron/'

function hasElectronBinary() {
  if (!existsSync(pathFile)) return false

  const executable = readFileSync(pathFile, 'utf8').trim()
  return executable.length > 0 && existsSync(join(electronDirectory, 'dist', executable))
}

function installElectron(extraEnvironment = {}) {
  return (
    spawnSync(process.execPath, [installScript], {
      stdio: 'inherit',
      env: { ...process.env, ...extraEnvironment }
    }).status === 0 && hasElectronBinary()
  )
}

if (!hasElectronBinary()) {
  const registry = process.env.npm_config_registry ?? ''
  const hasConfiguredMirror = Boolean(
    process.env.ELECTRON_MIRROR ||
      process.env.NPM_CONFIG_ELECTRON_MIRROR ||
      process.env.npm_config_electron_mirror
  )
  const prefersNpmMirror = registry.includes('npmmirror.com') && !hasConfiguredMirror
  const firstEnvironment = prefersNpmMirror ? { ELECTRON_MIRROR: fallbackMirror } : {}

  console.log('Electron binary is missing; downloading it now...')
  let installed = installElectron(firstEnvironment)

  if (!installed && !prefersNpmMirror && !hasConfiguredMirror) {
    console.warn('The default Electron download failed; retrying with npmmirror...')
    installed = installElectron({ ELECTRON_MIRROR: fallbackMirror })
  }

  if (!installed) {
    console.error(
      'Unable to install the Electron binary. Check your network or set ELECTRON_MIRROR to an accessible mirror.'
    )
    process.exit(1)
  }
}
