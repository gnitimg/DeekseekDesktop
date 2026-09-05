/** Typed renderer client for the dsh Host's Remote protocol. */
import type {
  ModelCatalog, RpcResult, SessionCancelRequest, SessionCancelValue, SessionCreateRequest,
  SessionCreateValue, SessionFollowFrame, SessionListValue, SessionPromptRequest,
  SessionPromptValue, SessionSelectModelRequest, SessionSelectModelValue, SessionControlFrame,
  SessionRenameRequest, SessionRenameValue, StreamFrameEvent, WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue, WorkspaceCreateRequest, WorkspaceCreateValue, WorkspaceDeleteRequest,
  WorkspaceDeleteValue, WorkspaceInsertBeforeRequest, WorkspaceOrderValue, WorkspaceRenameRequest,
  WorkspaceValue,
} from './types'

type FrameHandler = (frame: SessionFollowFrame) => void
type ControlHandler = (frame: SessionControlFrame) => void
interface StreamRegistration {
  item: (value: unknown) => void
  error?: (error: { code: string, message: string }) => void
  end?: () => void
}

const frameHandlers = new Map<string, StreamRegistration>()
const pendingFrames = new Map<string, StreamFrameEvent[]>()
let frameListenerInstalled = false

function dispatchFrame(registration: StreamRegistration, frame: StreamFrameEvent): void {
  if (frame.type === 'item') registration.item(frame.value)
  else if (frame.type === 'error') registration.error?.(frame.error ?? { code: 'stream/error', message: 'stream failed' })
  else registration.end?.()
}

function registerStream(streamId: string, registration: StreamRegistration): void {
  frameHandlers.set(streamId, registration)
  const pending = pendingFrames.get(streamId)
  pendingFrames.delete(streamId)
  pending?.forEach((frame) => dispatchFrame(registration, frame))
}

function ensureFrameListener(): void {
  if (frameListenerInstalled) return
  frameListenerInstalled = true
  window.desktop.dsh.stream.onFrame((frame: StreamFrameEvent) => {
    const registration = frameHandlers.get(frame.streamId)
    if (registration === undefined) {
      pendingFrames.set(frame.streamId, [...pendingFrames.get(frame.streamId) ?? [], frame])
      return
    }
    dispatchFrame(registration, frame)
    if (frame.type === 'error' || frame.type === 'end') frameHandlers.delete(frame.streamId)
  })
}

async function openRemoteStream<T>(
  endpoint: string,
  args: unknown,
  item: (value: T) => void,
  error?: (error: { code: string, message: string }) => void,
): Promise<() => void> {
  ensureFrameListener()
  const streamId = await window.desktop.dsh.stream.open(endpoint, args)
  if (streamId === undefined) throw new Error(`failed to open ${endpoint} stream`)
  registerStream(streamId, { item: (value) => item(value as T), ...(error === undefined ? {} : { error }) })
  return () => {
    frameHandlers.delete(streamId)
    pendingFrames.delete(streamId)
    void window.desktop.dsh.stream.cancel(streamId)
  }
}

async function rpc<T>(method: string, args: unknown): Promise<T> {
  const result = await window.desktop.dsh.rpc(method, args) as RpcResult<T>
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

export const dsh = {
  listSessions: (): Promise<SessionListValue> => rpc<SessionListValue>('session/list', { _request: {} }),
  createSession: (request: SessionCreateRequest): Promise<SessionCreateValue> =>
    rpc<SessionCreateValue>('session/create', { request }),
  prompt: (request: SessionPromptRequest): Promise<SessionPromptValue> =>
    rpc<SessionPromptValue>('session/prompt', { request }),
  cancel: (request: SessionCancelRequest): Promise<SessionCancelValue> =>
    rpc<SessionCancelValue>('session/cancel', { request }),
  modelCatalog: (): Promise<ModelCatalog> => rpc<ModelCatalog>('session/modelCatalog', {}),
  selectModel: (request: SessionSelectModelRequest): Promise<SessionSelectModelValue> =>
    rpc<SessionSelectModelValue>('session/selectModel', { request }),
  renameSession: (request: SessionRenameRequest): Promise<SessionRenameValue> =>
    rpc<SessionRenameValue>('session/rename', { request }),
  createWorkspace: (request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> =>
    rpc<WorkspaceCreateValue>('workspace/create', { request }),
  renameWorkspace: (request: WorkspaceRenameRequest): Promise<WorkspaceValue> =>
    rpc<WorkspaceValue>('workspace/rename', { request }),
  deleteWorkspace: (request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> =>
    rpc<WorkspaceDeleteValue>('workspace/delete', { request }),
  moveWorkspace: (request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> =>
    rpc<WorkspaceOrderValue>('workspace/insertBefore', { request }),
  archiveSession: (request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> =>
    rpc<WorkspaceArchiveValue>('workspace/archiveSession', { request }),
  updateDeepSeekModels: (models: unknown[]): Promise<unknown> =>
    rpc<unknown>('settings/update', { ns: 'llm-deepseek', patch: { models }, expectedRevision: undefined }),

  /** Open a session/follow stream. Returns a cancel function. */
  follow: async (sessionId: string, handler: FrameHandler): Promise<() => void> => {
    return await openRemoteStream<SessionFollowFrame>('session/follow', {
      request: { address: { kind: 'session', sessionId } },
    }, handler, (error) => handler({
      type: 'event',
      event: { type: 'stream/error', seq: -1, time: new Date().toISOString(), data: { error } },
    }))
  },
  control: async (handler: ControlHandler, onError: (message: string) => void): Promise<() => void> =>
    await openRemoteStream<SessionControlFrame>('session/control', {}, handler, (error) => onError(`${error.code}: ${error.message}`)),
}
