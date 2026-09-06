/**
 * dsh host lifecycle: spawn the bundled, full DSH runtime on an OS-assigned
 * port, parse the announced URL, and own graceful shutdown. Development builds
 * may fall back to a sibling source checkout; packaged builds never require it.
 */
import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { basename, delimiter, dirname, resolve, sep } from 'node:path'
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress } from 'node:zlib'

const URL_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/?\S*)/
const BOOT_TIMEOUT_MS = 120_000
const STOP_TIMEOUT_MS = 10_000

function resolveDesktopRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '../..')
}

/** Resolve a development-only DSH source checkout (override with DSH_ROOT). */
function resolveDshRoot(): string {
  const override = process.env.DSH_ROOT
  if (override !== undefined && override !== '') return resolve(override)
  return resolve(resolveDesktopRoot(), '../deepseek-harness-clean')
}

/** Resolve the dsh home directory (override with DSH_HOME). Defaults to a
 * writable app data for packaged builds. Development keeps the repository-local
 * home so existing sessions are not displaced. */
function resolveDshHome(): string {
  const override = process.env.DSH_HOME
  if (override !== undefined && override !== '') return resolve(override)
  if (app.isPackaged) return resolve(app.getPath('userData'), 'dsh')
  return resolve(resolveDesktopRoot(), '.dsh-home')
}

function resolveNodeExecutable(): string {
  const override = process.env.DSH_DESKTOP_NODE
  if (override !== undefined && override !== '') return override
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

interface DshLaunch {
  command: string
  prefix: string[]
  cwd: string
}

interface BundledRuntimeFile {
  name: string
  compressed: string
  size: number
  sha256: string
}

interface BundledRuntimeManifest {
  version: 1
  executable: string
  files: BundledRuntimeFile[]
}

function runtimeFilename(): string | undefined {
  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : undefined
  if (platform === undefined || (platform === 'win' && process.arch !== 'x64')) return undefined
  return `deepseek-harness-sdk-runtime-${platform}-${process.arch}${platform === 'win' ? '.exe' : ''}`
}

function readRuntimeManifest(runtimeDir: string): BundledRuntimeManifest | undefined {
  const path = resolve(runtimeDir, 'manifest.json')
  if (!existsSync(path)) return undefined
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<BundledRuntimeManifest>
  if (value.version !== 1 || typeof value.executable !== 'string' || !Array.isArray(value.files)) {
    throw new Error('内置 DSH 运行时 manifest 无效，请重新安装 DeepSeek Desktop。')
  }
  for (const file of value.files) {
    if (
      typeof file.name !== 'string' || basename(file.name) !== file.name ||
      typeof file.compressed !== 'string' || basename(file.compressed) !== file.compressed ||
      typeof file.size !== 'number' || file.size <= 0 ||
      typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256)
    ) throw new Error('内置 DSH 运行时 manifest 包含无效文件记录。')
  }
  return value as BundledRuntimeManifest
}

async function sha256File(path: string): Promise<string> {
  return await new Promise<string>((resolveP, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(path)
    input.on('data', (chunk: string | Buffer) => { hash.update(chunk) })
    input.once('error', reject)
    input.once('end', () => resolveP(hash.digest('hex')))
  })
}

async function materializeRuntimeFile(runtimeDir: string, targetDir: string, file: BundledRuntimeFile): Promise<string> {
  const compressed = resolve(runtimeDir, file.compressed)
  if (!existsSync(compressed)) throw new Error(`安装包缺少内置 DSH 资源：${file.compressed}`)
  const destination = resolve(targetDir, file.name)
  const marker = `${destination}.sha256`
  if (
    existsSync(destination) && statSync(destination).size === file.size &&
    existsSync(marker) && readFileSync(marker, 'utf8').trim() === file.sha256
  ) return destination

  mkdirSync(targetDir, { recursive: true })
  const temporary = `${destination}.${process.pid}.tmp`
  rmSync(temporary, { force: true })
  try {
    await pipeline(createReadStream(compressed), createBrotliDecompress(), createWriteStream(temporary))
    if (statSync(temporary).size !== file.size || await sha256File(temporary) !== file.sha256) {
      throw new Error(`内置 DSH 资源校验失败：${file.name}`)
    }
    rmSync(destination, { force: true })
    renameSync(temporary, destination)
    if (process.platform !== 'win32') chmodSync(destination, 0o755)
    writeFileSync(marker, `${file.sha256}\n`, 'utf8')
    return destination
  } finally {
    rmSync(temporary, { force: true })
  }
}

async function materializeBundledRuntime(runtimeDir: string, filename: string, dshHome: string): Promise<string | undefined> {
  const manifest = readRuntimeManifest(runtimeDir)
  if (manifest === undefined) return undefined
  if (manifest.executable !== filename) throw new Error(`内置 DSH 运行时与当前平台不匹配：${manifest.executable}`)
  const executable = manifest.files.find((file) => file.name === filename)
  if (executable === undefined) throw new Error(`内置 DSH 运行时缺少可执行文件记录：${filename}`)
  const targetDir = resolve(dshHome, 'desktop-runtime', executable.sha256.slice(0, 16))
  for (const file of manifest.files) await materializeRuntimeFile(runtimeDir, targetDir, file)
  return resolve(targetDir, filename)
}

/** Prefer the release-shaped DSH executable that carries the complete web
 * profile. DSH_RUNTIME_EXECUTABLE is useful for testing unreleased runtimes. */
async function resolveDshLaunch(dshHome: string): Promise<DshLaunch> {
  const explicitRuntime = process.env.DSH_RUNTIME_EXECUTABLE?.trim()
  if (explicitRuntime !== undefined && explicitRuntime !== '') {
    const command = resolve(explicitRuntime)
    if (!existsSync(command)) throw new Error(`DSH_RUNTIME_EXECUTABLE 不存在：${command}`)
    return { command, prefix: [], cwd: resolveDesktopRoot() }
  }

  // Development should reflect changes in the adjacent DSH checkout
  // immediately. Release builds still take the self-contained runtime below
  // and never require that checkout on an end user's machine.
  if (!app.isPackaged) {
    const root = resolveDshRoot()
    const bin = resolve(root, 'apps/cli/lib/bin.js')
    if (existsSync(bin)) return { command: resolveNodeExecutable(), prefix: [bin], cwd: root }
  }

  const filename = runtimeFilename()
  if (filename !== undefined) {
    const runtimeDir = app.isPackaged
      ? resolve(process.resourcesPath, 'dsh-runtime')
      : resolve(resolveDesktopRoot(), 'resources/dsh-runtime')
    const command = resolve(runtimeDir, filename)
    if (existsSync(command)) return { command, prefix: [], cwd: resolveDesktopRoot() }
    const materialized = await materializeBundledRuntime(runtimeDir, filename, dshHome)
    if (materialized !== undefined) return { command: materialized, prefix: [], cwd: resolveDesktopRoot() }
  }

  if (app.isPackaged) {
    throw new Error('安装包缺少内置 DSH 运行时，请重新安装完整的 DeepSeek Desktop。')
  }
  throw new Error('未找到内置 DSH 运行时；开发模式请运行 pnpm runtime:sync，或构建相邻的 deepseek-harness-clean。')
}

/** DSH delegates external plugin installation to pnpm. Ship pnpm with the
 * desktop app and expose a tiny private shim on PATH so users do not install it. */
function ensureBundledPnpmOnPath(dshHome: string): string {
  const pnpmScript = app.isPackaged
    ? resolve(process.resourcesPath, 'app.asar', 'node_modules/pnpm/bin/pnpm.cjs')
    : resolve(resolveDesktopRoot(), 'node_modules/pnpm/bin/pnpm.cjs')
  if (!existsSync(pnpmScript)) return process.env.PATH ?? ''
  const binDir = resolve(dshHome, 'desktop-bin')
  mkdirSync(binDir, { recursive: true })
  if (process.platform === 'win32') {
    const shim = resolve(binDir, 'pnpm.cmd')
    const contents = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${pnpmScript}" %*\r\n`
    writeFileSync(shim, contents, 'utf8')
  } else {
    const shim = resolve(binDir, 'pnpm')
    const contents = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${pnpmScript}" "$@"\n`
    writeFileSync(shim, contents, { encoding: 'utf8', mode: 0o755 })
  }
  return `${binDir}${delimiter}${process.env.PATH ?? ''}`
}

const DESKTOP_ENV_FILE = 'desktop.env'

/** Read the desktop-owned env overrides (DEEPSEEK_API_KEY, etc.) from
 * `<dsh-home>/desktop.env`. Missing file → empty record. */
export function readDesktopEnv(): Record<string, string> {
  const file = resolve(resolveDshHome(), DESKTOP_ENV_FILE)
  if (!existsSync(file)) return {}
  const result: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    result[key] = value
  }
  return result
}

/** Write env overrides to `<dsh-home>/desktop.env`. */
export function writeDesktopEnv(env: Record<string, string>): void {
  const dir = resolveDshHome()
  mkdirSync(dir, { recursive: true })
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v.includes(' ') ? `"${v}"` : v}`)
  writeFileSync(resolve(dir, DESKTOP_ENV_FILE), `${lines.join('\n')}\n`, 'utf8')
}

export interface DshHostHandle {
  port: number
  url: string
  child: ChildProcess
  stop: () => Promise<void>
}

export async function startDshHost(): Promise<DshHostHandle> {
  const dshHome = resolveDshHome()
  mkdirSync(dshHome, { recursive: true })
  const launch = await resolveDshLaunch(dshHome)
  const desktopEnv = readDesktopEnv()
  const child = spawn(launch.command, [...launch.prefix, 'web', '--port', '0', '--no-open'], {
    cwd: launch.cwd,
    env: { ...process.env, PATH: ensureBundledPnpmOnPath(dshHome), DSH_HOME: dshHome, ...desktopEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const url = await new Promise<string>((resolveP, reject) => {
    const timer = setTimeout(() => reject(new Error(`dsh web did not announce a URL within ${String(BOOT_TIMEOUT_MS)} ms`)), BOOT_TIMEOUT_MS)
    let stderrTail = ''
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer)
      reject(new Error(`dsh web exited before announcing (code=${String(code)} signal=${String(signal)})${stderrTail === '' ? '' : `\n${stderrTail.slice(-2048)}`}`))
    }
    child.once('exit', onExit)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      const match = URL_LINE.exec(chunk)
      if (match !== null) {
        clearTimeout(timer)
        child.off('exit', onExit)
        resolveP(match[1])
      }
    })
    child.stderr?.on('data', (chunk: string) => { stderrTail = `${stderrTail}${chunk}`.slice(-4096) })
    child.once('error', (error: Error) => { clearTimeout(timer); reject(new Error(`dsh web spawn failed: ${error.message}`)) })
  })

  const portMatch = /:(\d+)/.exec(url)
  const port = portMatch !== null ? Number(portMatch[1]) : 0
  return { port, url, child, stop: () => stopChild(child) }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveP) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS)
    child.once('exit', () => { clearTimeout(timer); resolveP() })
    child.kill('SIGTERM')
  })
}

interface WebProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[], patchReload?: string } }
}

interface InstalledPackageManifest {
  name?: string
  version?: string
  description?: string
  repository?: string | { url?: string }
  dsh?: { bundle?: { patch?: string } }
}

export interface InstalledPlugin {
  name: string
  version: string
  description?: string
  spec: string
  repository?: string
  compatible: boolean
  enabled: boolean
}

export interface PluginMutation {
  output: string
  plugin?: InstalledPlugin
  plugins: InstalledPlugin[]
}

const WEB_PROFILE = 'web'

function webProfileDir(): string {
  return resolve(resolveDshHome(), 'profiles', WEB_PROFILE)
}

function webProfileManifestPath(): string {
  return resolve(webProfileDir(), 'package.json')
}

function readWebProfileManifest(): WebProfileManifest | undefined {
  const path = webProfileManifestPath()
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WebProfileManifest
  } catch (error) {
    throw new Error('DSH web profile 配置无效：' + String(error))
  }
}

function writeWebProfileManifest(manifest: WebProfileManifest): void {
  writeFileSync(webProfileManifestPath(), JSON.stringify(manifest, undefined, 2) + '\n', 'utf8')
}

function githubRepositorySlug(value: unknown): string | undefined {
  const candidate = typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null && typeof (value as { url?: unknown }).url === 'string'
      ? (value as { url: string }).url
      : undefined
  if (candidate === undefined) return undefined
  const cleaned = candidate.trim().replace(/^git\+/u, '').replace(/\.git(?:#.*)?$/u, '')
  const shorthand = /^github:(?<slug>[^#]+)(?:#.*)?$/u.exec(cleaned)?.groups?.slug
  if (shorthand !== undefined) return shorthand.toLowerCase()
  const match = /github\.com[/:](?<owner>[^/#:]+)\/(?<repo>[^/#]+)$/iu.exec(cleaned)
  return match?.groups === undefined ? undefined : (match.groups.owner + '/' + match.groups.repo).toLowerCase()
}

function installedPackageDir(profileDir: string, name: string): string {
  return resolve(profileDir, 'node_modules', ...name.split('/'))
}

function installedPackageManifest(packageDir: string): InstalledPackageManifest | undefined {
  const path = resolve(packageDir, 'package.json')
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as InstalledPackageManifest
  } catch {
    return undefined
  }
}

function hasLoadableBundlePatch(packageDir: string, patch: unknown): boolean {
  if (typeof patch !== 'string' || patch.trim() === '' || !existsSync(packageDir)) return false
  try {
    const packageRoot = realpathSync(packageDir)
    const patchPath = resolve(packageRoot, patch)
    if (!patchPath.startsWith(packageRoot + sep)) return false
    if (!existsSync(patchPath)) return false
    const realPatchPath = realpathSync(patchPath)
    return realPatchPath.startsWith(packageRoot + sep) && statSync(realPatchPath).isFile()
  } catch {
    return false
  }
}

export function listInstalledPlugins(): InstalledPlugin[] {
  const profile = readWebProfileManifest()
  if (profile === undefined) return []
  const profileDir = webProfileDir()
  const enabled = new Set(profile.dsh?.profile?.bundles ?? [])
  return Object.entries(profile.dependencies ?? {})
    .map(([name, spec]) => {
      const packageDir = installedPackageDir(profileDir, name)
      const manifest = installedPackageManifest(packageDir)
      const description = typeof manifest?.description === 'string' ? manifest.description : undefined
      const repository = githubRepositorySlug(manifest?.repository) ?? githubRepositorySlug(spec)
      return {
        name,
        version: typeof manifest?.version === 'string' ? manifest.version : spec,
        ...(description === undefined ? {} : { description }),
        spec,
        ...(repository === undefined ? {} : { repository }),
        compatible: hasLoadableBundlePatch(packageDir, manifest?.dsh?.bundle?.patch),
        enabled: enabled.has(name),
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

function assertInstalledPackageName(name: string): void {
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/iu.test(name)) {
    throw new Error('无效的插件包名：' + name)
  }
}

function setProfileBundleEnabled(name: string, enabled: boolean): void {
  assertInstalledPackageName(name)
  const profile = readWebProfileManifest()
  if (profile === undefined || !Object.hasOwn(profile.dependencies ?? {}, name)) {
    throw new Error('插件未安装：' + name)
  }
  const installed = listInstalledPlugins().find((plugin) => plugin.name === name)
  if (installed?.compatible !== true) throw new Error('该包不是可加载的 DSH bundle：' + name)
  const bundles = [...profile.dsh?.profile?.bundles ?? []]
  const index = bundles.indexOf(name)
  if (enabled && index < 0) bundles.push(name)
  if (!enabled && index >= 0) bundles.splice(index, 1)
  profile.dsh = {
    ...profile.dsh,
    profile: {
      ...profile.dsh?.profile,
      bundles,
      patchReload: profile.dsh?.profile?.patchReload ?? 'live',
    },
  }
  writeWebProfileManifest(profile)
}

async function runPluginCommand(args: readonly string[]): Promise<string> {
  const dshHome = resolveDshHome()
  mkdirSync(dshHome, { recursive: true })
  const launch = await resolveDshLaunch(dshHome)
  return await new Promise<string>((resolveP, reject) => {
    const child = spawn(launch.command, [...launch.prefix, 'plugin', '--profile', WEB_PROFILE, ...args], {
      cwd: launch.cwd,
      env: { ...process.env, PATH: ensureBundledPnpmOnPath(dshHome), DSH_HOME: dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { output += chunk })
    child.stderr?.on('data', (chunk: string) => { output += chunk })
    child.once('exit', (code) => {
      if (code === 0) resolveP(output)
      else reject(new Error('dsh plugin exited with code ' + String(code) + '\n' + output.slice(-2048)))
    })
    child.once('error', (error: Error) => reject(new Error('dsh plugin failed: ' + error.message)))
  })
}

/** Install a dsh plugin into the web profile by running `dsh plugin --profile web
 * add <spec>` in the clean dsh source tree. Resolves with combined stdout/stderr
 * on success, rejects on non-zero exit. */
export async function installPlugin(spec: string): Promise<PluginMutation> {
  const before = new Set(listInstalledPlugins().map((plugin) => plugin.name))
  const output = await runPluginCommand(['add', spec])
  const installed = listInstalledPlugins()
  const repository = spec.toLowerCase()
  const plugin = installed.find((item) => item.repository === repository)
    ?? installed.find((item) => !before.has(item.name))
  if (plugin === undefined) {
    throw new Error('安装命令完成，但未能在 web profile 中识别插件依赖。')
  }
  if (!plugin.compatible) {
    await runPluginCommand(['remove', plugin.name]).catch(() => {})
    throw new Error('已拒绝 ' + plugin.name + '：该包没有有效的 dsh.bundle.patch 文件，不能作为 DSH 插件加载。')
  }
  if (!plugin.enabled) setProfileBundleEnabled(plugin.name, true)
  const plugins = listInstalledPlugins()
  return {
    output,
    plugin: plugins.find((item) => item.name === plugin.name),
    plugins,
  }
}

export async function setPluginEnabled(name: string, enabled: boolean): Promise<PluginMutation> {
  setProfileBundleEnabled(name, enabled)
  const plugins = listInstalledPlugins()
  return {
    output: enabled ? '插件已启用' : '插件已停用',
    plugin: plugins.find((plugin) => plugin.name === name),
    plugins,
  }
}

export async function uninstallPlugin(name: string): Promise<PluginMutation> {
  assertInstalledPackageName(name)
  if (!listInstalledPlugins().some((plugin) => plugin.name === name)) {
    throw new Error('插件未安装：' + name)
  }
  const output = await runPluginCommand(['remove', name])
  return { output, plugins: listInstalledPlugins() }
}
