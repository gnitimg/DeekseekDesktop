/** Renderer-side destination. */
export type View = 'chat' | 'plugins' | 'automations' | 'settings'

/** A GitHub repository from the dsh-plugin topic search. */
export interface PluginRepo {
  id: number
  name: string
  full_name: string
  html_url: string
  description: string | null
  stargazers_count: number
  updated_at: string
  owner: { login: string; avatar_url: string; html_url: string }
  topics?: string[]
  language: string | null
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

export interface PluginMutationResult {
  output: string
  plugin?: InstalledPlugin
  plugins: InstalledPlugin[]
  dshUrl: string
}

export interface ImageAttachment {
  name: string
  mediaType: string
  data: string
}

export interface ProjectEnvironment {
  path: string
  isGit: boolean
  branch?: string
  branches: string[]
  changes: Array<{ status: string, path: string }>
  worktrees: Array<{ path: string, branch?: string, head?: string }>
}

/** dsh RPC result: ok union (never rejects). */
export interface RpcResultOk<T> { ok: true, value: T }
export interface RpcResultErr { ok: false, error: { code: string, message: string, details?: unknown } }
export type RpcResult<T> = RpcResultOk<T> | RpcResultErr

/** dsh stream frame pushed from main. */
export type StreamFrameType = 'item' | 'error' | 'end'
export interface StreamFrameEvent { streamId: string, type: StreamFrameType, value?: unknown, error?: { code: string, message: string } }

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: {
    efforts: ReadonlyArray<{ id: string; name: string; description?: string }>
    defaultEffort?: string
  }
}

export interface ModelProviderGroup {
  id: string
  name: string
  models: readonly ModelCatalogModel[]
}

export interface ModelCatalog {
  default: ModelSelection
  routableProviders: readonly string[]
  groups: readonly ModelProviderGroup[]
  failures: ReadonlyArray<{ id: string; name: string; message: string }>
}

export interface SessionProjectionBaseline {
  asOfSeq: number
  values: {
    title?: string | null
    modelSelection?: { lastUsed: ModelSelection | null; next: ModelSelection | null }
    [key: string]: unknown
  }
}

/** dsh session API types (desktop-facing subset of session-controller). */
export interface SessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  origin?: 'subagent'
  cwd?: string
  projections?: SessionProjectionBaseline
}

export interface SessionListValue { items: readonly SessionSummary[] }
export interface SessionCreateRequest { workspaceId?: string, cwd?: string, sessionId?: string, agentPreset?: string }
export interface SessionCreateValue { sessionId: string, agentPreset?: string }
export interface SessionPromptRequest {
  requestId: string
  sessionId: string
  mode: 'queue' | 'steer'
  content: ReadonlyArray<{ type: 'text', text: string } | { type: 'image', mediaType: string, data: string, name?: string }>
  clientTimeZone?: string
}
export interface SessionPromptValue { accepted: true }
export interface SessionCancelRequest { sessionId: string }
export interface SessionCancelValue { accepted: true }
export interface SessionSelectModelRequest extends ModelSelection { sessionId: string }
export interface SessionSelectModelValue { selected: ModelSelection }
export interface SessionRenameRequest { sessionId: string, title: string }
export interface SessionRenameValue { title: string, seq: number }

export interface WorkspaceView {
  workspaceId: string
  path: string
  title: string
  sessionIds: readonly string[]
  createdAt: string
  updatedAt: string
}
export interface WorkspaceCreateRequest { path: string }
export interface WorkspaceCreateValue { workspace: WorkspaceView, created: boolean }
export interface WorkspaceRenameRequest { workspaceId: string, title: string }
export interface WorkspaceValue { workspace: WorkspaceView }
export interface WorkspaceDeleteRequest { workspaceId: string }
export interface WorkspaceDeleteValue { deleted: true }
export interface WorkspaceInsertBeforeRequest { workspaceId: string, beforeWorkspaceId?: string }
export interface WorkspaceOrderValue { workspaceIds: readonly string[] }
export interface WorkspaceArchiveSessionRequest { sessionId: string }
export interface WorkspaceArchiveValue { archivedSessionIds: readonly string[] }

/** A follow stream frame: snapshot or event. */
export interface SessionEvent { type: string, seq: number, time: string | number, data: unknown }
export interface SessionFollowSnapshot {
  type: 'snapshot'
  header: unknown
  cursor: unknown
  records: unknown[]
  hasMore: boolean
  projections: SessionProjectionBaseline
}
export interface SessionFollowEvent { type: 'event', event: SessionEvent }
export type SessionFollowFrame = SessionFollowSnapshot | SessionFollowEvent

export interface SessionJob {
  id: string
  kind: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  detail?: string
  startedAt: number
  finishedAt?: number
}

export interface TokenUsageProjection {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface ContextPressureProjection {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}

export interface SessionStatsProjection {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
}

export interface PermissionOption {
  value: string
  name: string
  description?: string
}

export interface PermissionSelectProjection {
  options: readonly PermissionOption[]
  currentValue: string
}

export type ApprovalDecision = 'allowed-once' | 'rejected'

export interface PendingApproval {
  eventId: string
  clientId: string
  sessionId: string
  toolName: string
  callId?: string
  reason?: string
}

export type RemoteEventDownlinkFrame =
  | { type: 'ready', clientId: string, host: { home: string } }
  | { type: 'emit', event: string, args: readonly unknown[] }
  | { type: 'waterfall', event: string, eventId: string, agentId: string, request: Readonly<Record<string, unknown>> }
  | { type: 'cancel', eventId: string }

export interface RemoteEventResult {
  clientId: string
  eventId: string
  outcome:
    | { kind: 'next' }
    | { kind: 'result', value?: unknown }
    | { kind: 'rejected', error: { name: string, message: string, code?: string, details?: unknown } }
}

export interface CommandExecutionValue {
  commandId: string
  result?: { kind: string, text?: string }
}

export interface SessionControlBaseline {
  queues: Readonly<Record<string, readonly unknown[]>>
  jobs: Readonly<Record<string, readonly SessionJob[]>>
  projections: Readonly<Record<string, SessionProjectionBaseline>>
}

export type SessionControlFrame =
  | { type: 'baseline', value: SessionControlBaseline }
  | { type: 'projection', sessionId: string, key: string, value: unknown, seq: number }
  | { type: 'jobs', sessionId: string, jobs: readonly SessionJob[] }
  | { type: 'queue', sessionId: string, items: readonly unknown[] }

export type ScheduleRecord =
  | { id: string, kind: 'after', prompt: string, afterSeconds: number, scheduledAt: string }
  | { id: string, kind: 'at', prompt: string, scheduledAt: string }
  | { id: string, kind: 'every', prompt: string, everySeconds: number, scheduledAt: string }

/** Shape of the preload-exposed desktop bridge. */
export interface DesktopApi {
  dsh: {
    getUrl: () => Promise<string | undefined>
    onHostRestarted: (handler: (url: string) => void) => () => void
    rpc: (method: string, args: unknown) => Promise<RpcResult<unknown>>
    stream: {
      open: (endpoint: string, args: unknown) => Promise<string | undefined>
      cancel: (streamId: string) => Promise<void>
      onFrame: (handler: (frame: StreamFrameEvent) => void) => () => void
    }
  }
  plugins: {
    list: () => Promise<{ items: PluginRepo[]; total_count: number }>
    installed: () => Promise<InstalledPlugin[]>
    install: (spec: string) => Promise<PluginMutationResult>
    setEnabled: (name: string, enabled: boolean) => Promise<PluginMutationResult>
    uninstall: (name: string) => Promise<PluginMutationResult>
  }
  settings: {
    read: () => Promise<Record<string, string>>
    write: (env: Record<string, string>) => Promise<string>
    appearance: (value: 'light' | 'dark' | 'system') => Promise<void>
  }
  project: {
    chooseDirectory: () => Promise<string | undefined>
    environment: (path: string) => Promise<ProjectEnvironment>
    openTerminal: (path: string) => Promise<void>
  }
  attachments: { chooseImages: () => Promise<ImageAttachment[]> }
  models: { fetch: (baseUrl: string, apiKey: string) => Promise<string[]> }
}

declare global {
  interface Window { desktop: DesktopApi }
}
