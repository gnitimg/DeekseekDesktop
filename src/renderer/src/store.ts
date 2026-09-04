import { create } from 'zustand'
import type { ModelSelection, SessionJob, SessionProjectionBaseline, View } from './types'

const PINNED_SESSIONS_KEY = 'deepseek-desktop.pinned-sessions.v1'
const ARCHIVED_SESSIONS_KEY = 'deepseek-desktop.archived-sessions.v1'
const APPEARANCE_KEY = 'deepseek-desktop.appearance.v1'
export const PROJECT_PREFERENCES_KEY = 'deepseek-desktop.project-preferences.v1'

export type Appearance = 'light' | 'dark' | 'system'

function readAppearance(): Appearance {
  const value = localStorage.getItem(APPEARANCE_KEY)
  return value === 'dark' || value === 'system' ? value : 'light'
}

function readStoredIds(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function writeStoredIds(key: string, ids: readonly string[]): void {
  localStorage.setItem(key, JSON.stringify(ids))
}

function readHiddenProjectPaths(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(PROJECT_PREFERENCES_KEY) ?? '{}') as { hidden?: unknown }
    return new Set(Array.isArray(value.hidden) ? value.hidden.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

export interface DesktopSession {
  id: string
  title: string
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  parentId?: string
  selectedModel?: ModelSelection
}

interface AppState {
  view: View
  setView: (view: View) => void
  sessions: DesktopSession[]
  activeSessionId: string | undefined
  replaceSessions: (sessions: DesktopSession[]) => void
  addSession: (session: DesktopSession) => void
  patchSession: (id: string, patch: Partial<DesktopSession>) => void
  removeSession: (id: string) => void
  clearProjectSelection: (path: string) => void
  pinnedSessionIds: string[]
  toggleSessionPin: (id: string) => void
  archivedSessionIds: string[]
  archiveSessionLocally: (id: string) => void
  selectSession: (id: string) => void
  workspaceRoot: string | undefined
  setWorkspaceRoot: (path: string | undefined) => void
  dshUrl: string | undefined
  connectionError: string | undefined
  setConnection: (url: string | undefined, error?: string) => void
  connectionRevision: number
  reconnectDsh: (url: string) => void
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  inspectorOpen: boolean
  toggleInspector: () => void
  agentPreset: string
  setAgentPreset: (preset: string) => void
  appearance: Appearance
  setAppearance: (appearance: Appearance) => void
  projectionBaselines: Record<string, SessionProjectionBaseline>
  controlJobs: Record<string, readonly SessionJob[]>
  controlError: string | undefined
  setControlBaseline: (
    projections: Readonly<Record<string, SessionProjectionBaseline>>,
    jobs: Readonly<Record<string, readonly SessionJob[]>>,
  ) => void
  updateProjection: (sessionId: string, key: string, value: unknown, seq: number) => void
  setControlJobs: (sessionId: string, jobs: readonly SessionJob[]) => void
  setControlError: (error: string | undefined) => void
}

export const useApp = create<AppState>((set) => ({
  view: 'chat',
  setView: (view) => set({ view }),
  sessions: [],
  activeSessionId: undefined,
  replaceSessions: (incoming) => set((state) => {
    const sessions = incoming.filter((session) => !state.archivedSessionIds.includes(session.id))
    const hiddenProjects = readHiddenProjectPaths()
    const selectable = sessions.filter((session) => session.cwd === undefined || !hiddenProjects.has(session.cwd))
    const activeStillExists = selectable.some((session) => session.id === state.activeSessionId)
    const activeSessionId = activeStillExists ? state.activeSessionId : selectable[0]?.id
    const active = sessions.find((session) => session.id === activeSessionId)
    return {
      sessions,
      activeSessionId,
      workspaceRoot: active?.cwd,
    }
  }),
  addSession: (session) => set((state) => ({
    sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)],
    activeSessionId: session.id,
    workspaceRoot: session.cwd,
    view: 'chat',
  })),
  patchSession: (id, patch) => set((state) => ({
    sessions: state.sessions.map((session) => session.id === id ? { ...session, ...patch } : session),
  })),
  removeSession: (id) => set((state) => {
    const sessions = state.sessions.filter((session) => session.id !== id)
    const activeSessionId = state.activeSessionId === id ? sessions[0]?.id : state.activeSessionId
    const active = sessions.find((session) => session.id === activeSessionId)
    return {
      sessions,
      activeSessionId,
      workspaceRoot: active?.cwd,
    }
  }),
  clearProjectSelection: (path) => set((state) => {
    const active = state.sessions.find((session) => session.id === state.activeSessionId)
    return active?.cwd === path ? { activeSessionId: undefined, workspaceRoot: undefined } : {}
  }),
  pinnedSessionIds: readStoredIds(PINNED_SESSIONS_KEY),
  toggleSessionPin: (id) => set((state) => {
    const pinnedSessionIds = state.pinnedSessionIds.includes(id)
      ? state.pinnedSessionIds.filter((item) => item !== id)
      : [...state.pinnedSessionIds, id]
    writeStoredIds(PINNED_SESSIONS_KEY, pinnedSessionIds)
    return { pinnedSessionIds }
  }),
  archivedSessionIds: readStoredIds(ARCHIVED_SESSIONS_KEY),
  archiveSessionLocally: (id) => set((state) => {
    const archivedSessionIds = [...new Set([...state.archivedSessionIds, id])]
    writeStoredIds(ARCHIVED_SESSIONS_KEY, archivedSessionIds)
    const sessions = state.sessions.filter((session) => session.id !== id)
    const activeSessionId = state.activeSessionId === id ? sessions[0]?.id : state.activeSessionId
    const active = sessions.find((session) => session.id === activeSessionId)
    return { archivedSessionIds, sessions, activeSessionId, workspaceRoot: active?.cwd }
  }),
  selectSession: (id) => set((state) => {
    const session = state.sessions.find((item) => item.id === id)
    return { activeSessionId: id, workspaceRoot: session?.cwd, view: 'chat' }
  }),
  workspaceRoot: undefined,
  setWorkspaceRoot: (workspaceRoot) => set({ workspaceRoot }),
  dshUrl: undefined,
  connectionError: undefined,
  setConnection: (dshUrl, connectionError) => set({ dshUrl, connectionError }),
  connectionRevision: 0,
  reconnectDsh: (dshUrl) => set((state) => ({ dshUrl, connectionError: undefined, connectionRevision: state.connectionRevision + 1 })),
  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  inspectorOpen: false,
  toggleInspector: () => set((state) => ({ inspectorOpen: !state.inspectorOpen })),
  agentPreset: 'standard',
  setAgentPreset: (agentPreset) => set({ agentPreset }),
  appearance: readAppearance(),
  setAppearance: (appearance) => {
    localStorage.setItem(APPEARANCE_KEY, appearance)
    set({ appearance })
  },
  projectionBaselines: {},
  controlJobs: {},
  controlError: undefined,
  setControlBaseline: (projectionBaselines, controlJobs) => set({
    projectionBaselines: { ...projectionBaselines },
    controlJobs: { ...controlJobs },
    controlError: undefined,
  }),
  updateProjection: (sessionId, key, value, seq) => set((state) => {
    const current = state.projectionBaselines[sessionId]
    if (current !== undefined && current.asOfSeq > seq) return state
    return {
      projectionBaselines: {
        ...state.projectionBaselines,
        [sessionId]: {
          asOfSeq: Math.max(current?.asOfSeq ?? -1, seq),
          values: { ...current?.values, [key]: value },
        },
      },
    }
  }),
  setControlJobs: (sessionId, jobs) => set((state) => ({
    controlJobs: { ...state.controlJobs, [sessionId]: jobs },
  })),
  setControlError: (controlError) => set({ controlError }),
}))
