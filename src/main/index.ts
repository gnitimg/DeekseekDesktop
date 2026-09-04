/**
 * Electron main entry: boots the dsh web host, opens the desktop window, and
 * serves IPC for the renderer (dsh URL + plugin marketplace GitHub API).
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { basename, extname } from 'node:path'
import { readFileSync } from 'node:fs'
import { existsSync, statSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { startDshHost, type DshHostHandle, installPlugin, readDesktopEnv, writeDesktopEnv } from './dsh-host'
import { createDshApiProxy, type DshApiProxy } from './dsh-client'

const here = dirname(fileURLToPath(import.meta.url))

let host: DshHostHandle | undefined
let proxy: DshApiProxy | undefined
let mainWindow: BrowserWindow | undefined
let isQuitting = false

function syncWindowChrome(): void {
  const dark = nativeTheme.shouldUseDarkColors
  mainWindow?.setBackgroundColor(dark ? '#1c1d1b' : '#fbfaf8')
  mainWindow?.setTitleBarOverlay({
    color: dark ? '#1c1d1b' : '#fbfaf8',
    symbolColor: dark ? '#e9e8e2' : '#292b29',
    height: 48,
  })
}

/** Fetch the live plugin list from GitHub topic dsh-plugin (server-side, no CORS). */
async function fetchPlugins(): Promise<unknown> {
  const url = 'https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars&order=desc&per_page=100'
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'deepseek-desktop' } })
  if (!response.ok) throw new Error(`GitHub API ${String(response.status)} ${response.statusText}`)
  return response.json()
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveP, reject) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 8_000 }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolveP(stdout.trim())
    })
  })
}

async function readProjectEnvironment(path: string): Promise<unknown> {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error('项目目录不存在或不可读取')
  try {
    const [branch, branchOutput, porcelain] = await Promise.all([
      runGit(path, ['branch', '--show-current']),
      runGit(path, ['branch', '--format=%(refname:short)']),
      runGit(path, ['status', '--short', '--untracked-files=normal']),
    ])
    const changes = porcelain === '' ? [] : porcelain.split(/\r?\n/).map((line) => ({
      status: line.slice(0, 2).trim() || '?',
      path: line.slice(3).trim(),
    }))
    const branches = branchOutput === '' ? [] : branchOutput.split(/\r?\n/).filter(Boolean)
    return { path, isGit: true, branch: branch || 'HEAD', branches, changes }
  } catch {
    return { path, isGit: false, branches: [], changes: [] }
  }
}

function openProjectTerminal(path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error('项目目录不存在或不可读取')
  const child = spawn('powershell.exe', ['-NoExit', '-Command', 'Set-Location -LiteralPath $args[0]', path], {
    cwd: path,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: 'DeepSeek Desktop',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f7f7f4',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f7f7f4',
      symbolColor: '#292b29',
      height: 48,
    },
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  syncWindowChrome()
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://127.0.0.1:') || target.startsWith('https://127.0.0.1:')) return { action: 'allow' }
    void shell.openExternal(target)
    return { action: 'deny' }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl !== undefined) void mainWindow.loadURL(rendererUrl)
  else void mainWindow.loadFile(join(here, '../renderer/index.html'))
}

async function bootstrap(): Promise<void> {
  try {
    host = await startDshHost()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('DeepSeek Desktop', `Failed to start the dsh host.\n\n${message}\n\nBuild dsh first: in deepseek-harness-clean run "pnpm install && pnpm run build".`)
    app.quit()
    return
  }

  host.child.on('exit', (code, signal) => {
    if (isQuitting) return
    dialog.showErrorBox('DeepSeek Desktop', `The dsh host exited unexpectedly (code=${String(code)} signal=${String(signal)}). The application will close.`)
    void shutdown()
  })

  try {
    proxy = await createDshApiProxy(host.url, (frame) => { mainWindow?.webContents.send('dsh:stream:frame', frame) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('DeepSeek Desktop', `Failed to authenticate with the dsh host.\n\n${message}`)
    void shutdown()
    return
  }

  ipcMain.handle('dsh:url', () => host?.url)
  ipcMain.handle('dsh:rpc', (_event, method: string, args: unknown) => proxy?.rpc(method, args))
  ipcMain.handle('dsh:stream:open', (_event, endpoint: string, args: unknown) => proxy?.openStream(endpoint, args))
  ipcMain.handle('dsh:stream:cancel', (_event, streamId: string) => { proxy?.cancelStream(streamId) })
  ipcMain.handle('plugins:list', () => fetchPlugins())
  ipcMain.handle('plugins:install', (_event, spec: string) => installPlugin(spec))
  ipcMain.handle('settings:read', () => readDesktopEnv())
  ipcMain.handle('settings:write', (_event, env: Record<string, string>) => { writeDesktopEnv(env) })
  ipcMain.handle('settings:appearance', (_event, appearance: string) => {
    if (appearance !== 'light' && appearance !== 'dark' && appearance !== 'system') return
    nativeTheme.themeSource = appearance
    syncWindowChrome()
  })
  ipcMain.handle('project:choose-directory', async () => {
    if (mainWindow === undefined) return undefined
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择项目文件夹',
      buttonLabel: '在 DeepSeek 中打开',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? undefined : result.filePaths[0]
  })
  ipcMain.handle('project:environment', (_event, path: string) => readProjectEnvironment(path))
  ipcMain.handle('project:open-terminal', (_event, path: string) => { openProjectTerminal(path) })
  ipcMain.handle('attachments:choose-images', async () => {
    if (mainWindow === undefined) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '添加图片上下文',
      buttonLabel: '添加到任务',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled) return []
    return result.filePaths.slice(0, 20).map((path) => {
      const data = readFileSync(path)
      if (data.byteLength > 5 * 1024 * 1024) throw new Error(`${basename(path)} 超过 5 MB 附件限制`)
      const extension = extname(path).toLowerCase()
      const mediaType = extension === '.png' ? 'image/png'
        : extension === '.webp' ? 'image/webp'
          : extension === '.gif' ? 'image/gif' : 'image/jpeg'
      return { name: basename(path), mediaType, data: data.toString('base64') }
    })
  })

  createWindow()
}

async function shutdown(): Promise<void> {
  if (isQuitting) return
  isQuitting = true
  proxy?.dispose()
  await host?.stop().catch(() => {})
  app.quit()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.on('window-all-closed', () => { void shutdown() })
  app.on('before-quit', () => { isQuitting = true })
  void app.whenReady().then(() => {
    nativeTheme.on('updated', syncWindowChrome)
    return bootstrap()
  })
}
