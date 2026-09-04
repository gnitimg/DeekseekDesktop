import { useEffect } from 'react'
import { AutomationsView } from './components/AutomationsView'
import { ChatView } from './components/ChatView'
import { PluginMarket } from './components/PluginMarket'
import { SettingsView } from './components/SettingsView'
import { Sidebar } from './components/Sidebar'
import { dsh } from './dsh-client'
import { useApp, type DesktopSession } from './store'
import type { ModelSelection, SessionControlFrame, SessionSummary } from './types'

function pathName(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)
}

function toDesktopSession(summary: SessionSummary): DesktopSession {
  const projectedTitle = summary.projections?.values.title
  const selectedModel = summary.projections?.values.modelSelection?.next
    ?? summary.projections?.values.modelSelection?.lastUsed
    ?? undefined
  return {
    id: summary.sessionId,
    title: typeof projectedTitle === 'string' && projectedTitle.trim() !== ''
      ? projectedTitle
      : summary.blank ? '新任务' : pathName(summary.cwd) ?? '未命名任务',
    updatedAt: summary.updatedAt,
    running: summary.running,
    blank: summary.blank,
    ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
    ...(summary.parentSessionId === undefined ? {} : { parentId: summary.parentSessionId }),
    ...(selectedModel === undefined ? {} : { selectedModel }),
  }
}

function projectedModel(value: unknown): ModelSelection | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const projection = value as { next?: unknown, lastUsed?: unknown }
  const candidate = projection.next ?? projection.lastUsed
  if (candidate === null || typeof candidate !== 'object') return undefined
  const model = candidate as Partial<ModelSelection>
  return typeof model.provider === 'string' && typeof model.model === 'string'
    ? { provider: model.provider, model: model.model, ...(typeof model.reasoningEffort === 'string' ? { reasoningEffort: model.reasoningEffort } : {}) }
    : undefined
}

export function App(): React.ReactElement {
  const view = useApp((state) => state.view)
  const replaceSessions = useApp((state) => state.replaceSessions)
  const addSession = useApp((state) => state.addSession)
  const setConnection = useApp((state) => state.setConnection)
  const sidebarCollapsed = useApp((state) => state.sidebarCollapsed)
  const patchSession = useApp((state) => state.patchSession)
  const setControlBaseline = useApp((state) => state.setControlBaseline)
  const updateProjection = useApp((state) => state.updateProjection)
  const setControlJobs = useApp((state) => state.setControlJobs)
  const setControlError = useApp((state) => state.setControlError)
  const appearance = useApp((state) => state.appearance)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyAppearance = (): void => {
      document.documentElement.dataset.theme = appearance === 'system'
        ? media.matches ? 'dark' : 'light'
        : appearance
    }
    applyAppearance()
    void window.desktop.settings.appearance(appearance)
    if (appearance !== 'system') return
    media.addEventListener('change', applyAppearance)
    return () => media.removeEventListener('change', applyAppearance)
  }, [appearance])

  useEffect(() => {
    let disposed = false
    let cancelControl: (() => void) | undefined
    void (async () => {
      try {
        const url = await window.desktop.dsh.getUrl()
        if (url === undefined) throw new Error('DSH Host 尚未就绪')
        if (disposed) return
        setConnection(url)
        void dsh.control((frame: SessionControlFrame) => {
          if (disposed) return
          if (frame.type === 'baseline') {
            setControlBaseline(frame.value.projections, frame.value.jobs)
            return
          }
          if (frame.type === 'projection') {
            updateProjection(frame.sessionId, frame.key, frame.value, frame.seq)
            if (frame.key === 'title' && typeof frame.value === 'string') {
              patchSession(frame.sessionId, { title: frame.value })
            } else if (frame.key === 'modelSelection') {
              const selectedModel = projectedModel(frame.value)
              if (selectedModel !== undefined) patchSession(frame.sessionId, { selectedModel })
            }
            return
          }
          if (frame.type === 'jobs') setControlJobs(frame.sessionId, frame.jobs)
        }, (message) => {
          if (!disposed) setControlError(message)
        }).then((cancel) => {
          if (disposed) cancel()
          else cancelControl = cancel
        }).catch((error: unknown) => {
          if (!disposed) setControlError(error instanceof Error ? error.message : String(error))
        })
        const listed = await dsh.listSessions()
        if (disposed) return
        const sessions = listed.items
          .filter((item) => item.origin !== 'subagent')
          .map(toDesktopSession)
        if (sessions.length > 0) {
          replaceSessions(sessions)
          return
        }
        const created = await dsh.createSession({})
        if (disposed) return
        addSession({
          id: created.sessionId,
          title: '新任务',
          updatedAt: Date.now(),
          running: false,
          blank: true,
        })
      } catch (error) {
        if (disposed) return
        setConnection(undefined, error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      disposed = true
      cancelControl?.()
    }
  }, [addSession, patchSession, replaceSessions, setConnection, setControlBaseline, setControlError, setControlJobs, updateProjection])

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`}>
      <Sidebar />
      <main className="workspace-stage">
        {view === 'chat' && <ChatView />}
        {view === 'plugins' && <PluginMarket />}
        {view === 'automations' && <AutomationsView />}
        {view === 'settings' && <SettingsView />}
      </main>
    </div>
  )
}
