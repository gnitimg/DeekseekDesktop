/**
 * dsh host lifecycle: spawn `dsh web` from the clean dsh source tree at
 * ../deepseek-harness-clean as a Node child on an OS-assigned port, parse the
 * announced URL, and own graceful shutdown. The desktop reuses the entire dsh
 * core (everything-is-a-plugin, DeepSeek model adapter, cache hits) unchanged.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

const URL_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/?\S*)/
const BOOT_TIMEOUT_MS = 120_000
const STOP_TIMEOUT_MS = 10_000

/** Resolve the clean dsh source root (override with DSH_ROOT). */
function resolveDshRoot(): string {
  const override = process.env.DSH_ROOT
  if (override !== undefined && override !== '') return resolve(override)
  const here = dirname(fileURLToPath(import.meta.url)) // out/main
  const desktopRoot = resolve(here, '../..') // desktop package root
  return resolve(desktopRoot, '../deepseek-harness-clean')
}

/** Resolve the dsh home directory (override with DSH_HOME). Defaults to a
 * writable folder inside the desktop package root to avoid EPERM on locked
 * user-profile paths under `C:\Users\<user>\.dsh`. */
function resolveDshHome(): string {
  const override = process.env.DSH_HOME
  if (override !== undefined && override !== '') return resolve(override)
  const here = dirname(fileURLToPath(import.meta.url)) // out/main
  const desktopRoot = resolve(here, '../..') // desktop package root
  return resolve(desktopRoot, '.dsh-home')
}

function resolveDshBin(): string {
  return resolve(resolveDshRoot(), 'apps/cli/lib/bin.js')
}

function resolveNodeExecutable(): string {
  const override = process.env.DSH_DESKTOP_NODE
  if (override !== undefined && override !== '') return override
  return process.platform === 'win32' ? 'node.exe' : 'node'
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
  const binPath = resolveDshBin()
  const nodeExecutable = resolveNodeExecutable()
  const dshRoot = resolveDshRoot()
  const dshHome = resolveDshHome()
  mkdirSync(dshHome, { recursive: true })
  const desktopEnv = readDesktopEnv()
  const child = spawn(nodeExecutable, [binPath, 'web', '--port', '0', '--no-open'], {
    cwd: dshRoot,
    env: { ...process.env, DSH_HOME: dshHome, ...desktopEnv },
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

/** Install a dsh plugin into the web profile by running `dsh plugin --profile web
 * add <spec>` in the clean dsh source tree. Resolves with combined stdout/stderr
 * on success, rejects on non-zero exit. */
export async function installPlugin(spec: string): Promise<string> {
  const binPath = resolveDshBin()
  const nodeExecutable = resolveNodeExecutable()
  const dshRoot = resolveDshRoot()
  const dshHome = resolveDshHome()
  return await new Promise<string>((resolveP, reject) => {
    const child = spawn(nodeExecutable, [binPath, 'plugin', '--profile', 'web', 'add', spec], {
      cwd: dshRoot,
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { output += chunk })
    child.stderr?.on('data', (chunk: string) => { output += chunk })
    child.once('exit', (code) => {
      if (code === 0) resolveP(output)
      else reject(new Error(`dsh plugin add exited with code ${String(code)}\n${output.slice(-2048)}`))
    })
    child.once('error', (error: Error) => reject(new Error(`dsh plugin add failed: ${error.message}`)))
  })
}
