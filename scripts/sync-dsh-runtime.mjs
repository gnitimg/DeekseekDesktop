import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { constants, createBrotliCompress } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')
const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : undefined

if (platform === undefined || (platform === 'win' && process.arch !== 'x64')) {
  throw new Error(`Unsupported DSH desktop runtime target: ${process.platform}-${process.arch}`)
}

const executable = `deepseek-harness-sdk-runtime-${platform}-${process.arch}${platform === 'win' ? '.exe' : ''}`
const sidecars = platform === 'win'
  ? [`deepseek-harness-sdk-runtime-${platform}-${process.arch}-rg.exe`]
  : platform === 'macos'
    ? [`${executable}-rg`, `${executable}-spawn-helper`]
    : [`${executable}-rg`]

const sibling = resolve(desktopRoot, '../deepseek-harness-clean')
const sourceDirectories = [
  process.env.DSH_RUNTIME_SOURCE,
  resolve(sibling, 'dist-exe'),
  resolve(sibling, 'python/sdk-runtime/src/deepseek_harness_runtime/runtime'),
].filter((value) => typeof value === 'string' && value.trim() !== '').map((value) => resolve(value))

const destinationDir = resolve(desktopRoot, 'resources/dsh-runtime')
const manifestPath = resolve(destinationDir, 'manifest.json')
mkdirSync(destinationDir, { recursive: true })

const source = sourceDirectories.map((directory) => resolve(directory, executable)).find(existsSync)
if (source === undefined) {
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const complete = manifest.files?.every((file) => existsSync(resolve(destinationDir, file.compressed))) === true
    if (manifest.executable === executable && complete) {
      console.log(`runtime:sync reusing embedded ${executable}`)
      process.exit(0)
    }
  }
  throw new Error([
    `Missing complete DSH runtime: ${executable}`,
    'Build it from the DSH source with:',
    '  pnpm exec tsx scripts/build-exe-for-python-sdk.ts --skip-build',
    'or point DSH_RUNTIME_SOURCE at a release runtime directory.',
  ].join('\n'))
}

function hashFile(path) {
  const hash = createHash('sha256')
  const bytes = readFileSync(path)
  hash.update(bytes)
  return hash.digest('hex')
}

async function compressFile(from, name) {
  const compressed = `${name}.br`
  const destination = resolve(destinationDir, compressed)
  const temporary = `${destination}.${process.pid}.tmp`
  await pipeline(
    createReadStream(from),
    createBrotliCompress({
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 9,
        [constants.BROTLI_PARAM_SIZE_HINT]: statSync(from).size,
      },
    }),
    createWriteStream(temporary),
  )
  rmSync(destination, { force: true })
  copyFileSync(temporary, destination)
  rmSync(temporary, { force: true })
  const size = statSync(from).size
  const compressedSize = statSync(destination).size
  console.log(`runtime:sync ${basename(from)} ${(size / 1024 / 1024).toFixed(1)} MB -> ${(compressedSize / 1024 / 1024).toFixed(1)} MB`)
  return { name, compressed, size, sha256: hashFile(from) }
}

const sourceDir = dirname(source)
const files = []
for (const filename of [executable, ...sidecars]) {
  const from = resolve(sourceDir, filename)
  if (!existsSync(from)) throw new Error(`DSH runtime sidecar is missing: ${from}`)
  files.push(await compressFile(from, filename))
  rmSync(resolve(destinationDir, filename), { force: true })
}

writeFileSync(manifestPath, `${JSON.stringify({ version: 1, executable, files }, null, 2)}\n`, 'utf8')
const license = resolve(sibling, 'LICENSE')
if (existsSync(license)) copyFileSync(license, resolve(destinationDir, 'DSH-LICENSE.txt'))
