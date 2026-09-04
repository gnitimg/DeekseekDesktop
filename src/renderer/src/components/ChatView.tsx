import { useEffect, useMemo, useRef, useState } from 'react'
import { dsh } from '../dsh-client'
import { useApp } from '../store'
import type {
  ContextPressureProjection, ImageAttachment, ModelCatalog, ModelSelection, SessionEvent, SessionFollowEvent,
  SessionFollowFrame, SessionStatsProjection, TokenUsageProjection, ProjectEnvironment,
} from '../types'
import { BrandMark, Icon } from './Icon'
import {
  TrajectoryStrip, traceFromEvent, traceFromRecords, type TraceBlock,
} from './TrajectoryStrip'

interface Message {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  optimistic?: boolean
  attachments?: Array<Pick<ImageAttachment, 'name' | 'mediaType'>>
}

const suggestions = [
  { icon: 'sparkles' as const, label: '梳理项目', prompt: '请分析当前项目结构，并给出最值得优先推进的三项工作。' },
  { icon: 'activity' as const, label: '检查改动', prompt: '请检查当前代码的最近改动，找出潜在问题并提出修复建议。' },
  { icon: 'shield' as const, label: '质量检查', prompt: '请运行适合本项目的类型检查和测试，并修复发现的问题。' },
]

const newId = (): string => Math.random().toString(36).slice(2, 10)

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n')
  const object = asObject(value)
  if (object === undefined) return ''
  if (typeof object.text === 'string') return object.text
  if (typeof object.content === 'string' || Array.isArray(object.content)) return contentText(object.content)
  return ''
}

function attachmentMeta(value: unknown): Array<Pick<ImageAttachment, 'name' | 'mediaType'>> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    const object = asObject(item)
    if (object?.type !== 'image') return []
    return [{
      name: typeof object.name === 'string' ? object.name : `图片 ${String(index + 1)}`,
      mediaType: typeof object.mediaType === 'string' ? object.mediaType : 'image',
    }]
  })
}

function eventFromRecord(record: unknown): SessionEvent | undefined {
  const object = asObject(record)
  if (object === undefined) return undefined
  const candidate = asObject(object.event) ?? object
  if (typeof candidate.type !== 'string' || typeof candidate.seq !== 'number') return undefined
  return {
    type: candidate.type,
    seq: candidate.seq,
    time: typeof candidate.time === 'number' || typeof candidate.time === 'string' ? candidate.time : 0,
    data: candidate.data,
  }
}

function finishLastAssistant(messages: Message[], text?: string): Message[] {
  const last = messages.at(-1)
  if (last?.role !== 'assistant') {
    return text === undefined || text === '' ? messages : [...messages, { id: newId(), role: 'assistant', text }]
  }
  return [...messages.slice(0, -1), {
    ...last,
    text: text === undefined || text === '' ? last.text : text,
    streaming: false,
  }]
}

function applyEvent(messages: Message[], event: SessionEvent): Message[] {
  const data = asObject(event.data)
  if (event.type === 'user/message') {
    const source = asObject(data?.source)
    if (source?.kind !== 'user') return messages
    const text = contentText(data?.content)
    const attachments = attachmentMeta(data?.content)
    if (text === '' && attachments.length === 0) return messages
    const lastUser = [...messages].reverse().find((message) => message.role === 'user')
    if (lastUser?.optimistic === true && lastUser.text === text) {
      return messages.map((message) => message.id === lastUser.id ? { ...message, optimistic: false } : message)
    }
    return [...messages, { id: `user-${event.seq}`, role: 'user', text, ...(attachments.length === 0 ? {} : { attachments }) }]
  }
  if (event.type === 'assistant/chunk') {
    const chunk = asObject(data?.chunk)
    if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return messages
    const last = messages.at(-1)
    if (last?.role === 'assistant' && last.streaming === true) {
      return [...messages.slice(0, -1), { ...last, text: last.text + chunk.text }]
    }
    return [...messages, { id: `assistant-${event.seq}`, role: 'assistant', text: chunk.text, streaming: true }]
  }
  if (event.type === 'assistant/message') {
    const message = asObject(data?.message)
    return finishLastAssistant(messages, contentText(message?.content))
  }
  if (event.type === 'assistant/text') {
    const text = contentText(event.data)
    const last = messages.at(-1)
    if (last?.role === 'assistant' && last.streaming === true) {
      return [...messages.slice(0, -1), { ...last, text: last.text + text }]
    }
    return text === '' ? messages : [...messages, { id: `assistant-${event.seq}`, role: 'assistant', text, streaming: true }]
  }
  if (event.type === 'turn/end' || event.type === 'turn/cancel') return finishLastAssistant(messages)
  return messages
}

function historyFrom(records: unknown[]): Message[] {
  const messages = records.reduce<Message[]>((current, record) => {
    const event = eventFromRecord(record)
    return event === undefined ? current : applyEvent(current, event)
  }, [])
  return messages.map((message) => ({ ...message, streaming: false, optimistic: false }))
}

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 6) return '夜深了，也可以慢慢来'
  if (hour < 11) return '早上好，准备构建什么？'
  if (hour < 14) return '中午好，从一个想法开始'
  if (hour < 19) return '下午好，继续把事情做成'
  return '晚上好，准备构建什么？'
}

function pathName(path: string | undefined): string {
  if (path === undefined) return '选择项目'
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? path
}

function tokenUsageOf(value: unknown): TokenUsageProjection | undefined {
  const item = asObject(value)
  if (item === undefined) return undefined
  const keys = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const
  if (!keys.every((key) => typeof item[key] === 'number')) return undefined
  return Object.fromEntries(keys.map((key) => [key, item[key]])) as unknown as TokenUsageProjection
}

function statsOf(value: unknown): SessionStatsProjection | undefined {
  const item = asObject(value)
  if (item === undefined) return undefined
  const keys = ['turns', 'steps', 'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens'] as const
  if (!keys.every((key) => typeof item[key] === 'number')) return undefined
  return Object.fromEntries(keys.map((key) => [key, item[key]])) as unknown as SessionStatsProjection
}

function pressureOf(value: unknown): ContextPressureProjection | undefined {
  const item = asObject(value)
  if (item === undefined) return undefined
  const pressureTokens = typeof item.pressureTokens === 'number' ? item.pressureTokens : undefined
  const projectedTokens = typeof item.projectedTokens === 'number' ? item.projectedTokens : undefined
  const contextWindow = typeof item.contextWindow === 'number' ? item.contextWindow : undefined
  return pressureTokens === undefined && projectedTokens === undefined && contextWindow === undefined
    ? undefined
    : { ...(pressureTokens === undefined ? {} : { pressureTokens }), ...(projectedTokens === undefined ? {} : { projectedTokens }), ...(contextWindow === undefined ? {} : { contextWindow }) }
}

function compactDuration(ms: number): string {
  if (ms < 1_000) return `${String(Math.round(ms))}ms`
  if (ms < 60_000) return `${String(Math.round(ms / 100) / 10)}s`
  const seconds = Math.round(ms / 1_000)
  return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`
}

export function ChatView(): React.ReactElement {
  const dshUrl = useApp((state) => state.dshUrl)
  const connectionError = useApp((state) => state.connectionError)
  const sessions = useApp((state) => state.sessions)
  const activeSessionId = useApp((state) => state.activeSessionId)
  const patchSession = useApp((state) => state.patchSession)
  const addSession = useApp((state) => state.addSession)
  const selectSession = useApp((state) => state.selectSession)
  const setView = useApp((state) => state.setView)
  const agentPreset = useApp((state) => state.agentPreset)
  const setAgentPreset = useApp((state) => state.setAgentPreset)
  const pinnedSessionIds = useApp((state) => state.pinnedSessionIds)
  const toggleSessionPin = useApp((state) => state.toggleSessionPin)
  const archiveSessionLocally = useApp((state) => state.archiveSessionLocally)
  const workspaceRoot = useApp((state) => state.workspaceRoot)
  const setWorkspaceRoot = useApp((state) => state.setWorkspaceRoot)
  const inspectorOpen = useApp((state) => state.inspectorOpen)
  const toggleInspector = useApp((state) => state.toggleInspector)
  const projectionBaselines = useApp((state) => state.projectionBaselines)
  const controlJobs = useApp((state) => state.controlJobs)
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const [messagesBySession, setMessagesBySession] = useState<Record<string, Message[]>>({})
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [catalog, setCatalog] = useState<ModelCatalog | undefined>()
  const [selectingModel, setSelectingModel] = useState(false)
  const [traceBySession, setTraceBySession] = useState<Record<string, TraceBlock[]>>({})
  const [attachments, setAttachments] = useState<ImageAttachment[]>([])
  const [taskMenuOpen, setTaskMenuOpen] = useState(false)
  const [taskRenaming, setTaskRenaming] = useState(false)
  const [taskRenameDraft, setTaskRenameDraft] = useState('')
  const [taskArchiveConfirm, setTaskArchiveConfirm] = useState(false)
  const [environment, setEnvironment] = useState<ProjectEnvironment | undefined>()
  const [environmentLoading, setEnvironmentLoading] = useState(false)
  const [composerMenu, setComposerMenu] = useState<'project' | 'worktree' | 'mode' | 'model' | undefined>()
  const cancelFollowRef = useRef<(() => void) | undefined>(undefined)
  const endRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const taskMenuRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const messages = activeSessionId === undefined ? [] : messagesBySession[activeSessionId] ?? []
  const projectionValues = activeSessionId === undefined ? undefined : projectionBaselines[activeSessionId]?.values
  const tokenUsage = tokenUsageOf(projectionValues?.tokenUsage)
  const stats = statsOf(projectionValues?.sessionStats)
  const pressure = pressureOf(projectionValues?.contextPressure)
  const activeJobs = activeSessionId === undefined ? [] : controlJobs[activeSessionId] ?? []
  const billedInput = tokenUsage === undefined ? 0 : tokenUsage.uncachedInputTokens + tokenUsage.cacheReadTokens + tokenUsage.cacheWriteTokens
  const cacheHit = tokenUsage === undefined || billedInput === 0 ? undefined : Math.round(tokenUsage.cacheReadTokens / billedInput * 1_000) / 10
  const contextUsed = pressure?.projectedTokens ?? pressure?.pressureTokens
  const contextPercent = contextUsed === undefined || pressure?.contextWindow === undefined || pressure.contextWindow <= 0
    ? undefined
    : Math.min(100, Math.round(contextUsed / pressure.contextWindow * 100))
  const environmentPath = activeSession?.cwd ?? workspaceRoot
  const sourceItems = useMemo(() => {
    const names = [
      ...attachments.map((item) => item.name),
      ...messages.flatMap((message) => message.attachments?.map((item) => item.name) ?? []),
    ]
    return [...new Set(names)]
  }, [attachments, messages])
  const projectPaths = useMemo(() => [...new Set(sessions.flatMap((session) => session.cwd === undefined ? [] : [session.cwd]))], [sessions])

  useEffect(() => {
    if (dshUrl === undefined) return
    let disposed = false
    void dsh.modelCatalog()
      .then((value) => { if (!disposed) setCatalog(value) })
      .catch(() => {})
    return () => { disposed = true }
  }, [dshUrl])

  useEffect(() => {
    cancelFollowRef.current?.()
    cancelFollowRef.current = undefined
    setError(undefined)
    setIsStreaming(activeSession?.running ?? false)
    if (activeSessionId === undefined || dshUrl === undefined) return
    let disposed = false
    void dsh.follow(activeSessionId, (frame: SessionFollowFrame) => {
      if (disposed) return
      if (frame.type === 'snapshot') {
        setMessagesBySession((current) => ({ ...current, [activeSessionId]: historyFrom(frame.records) }))
        setTraceBySession((current) => ({ ...current, [activeSessionId]: traceFromRecords(frame.records) }))
        return
      }
      const event = (frame as SessionFollowEvent).event
      const trace = traceFromEvent(event)
      if (trace !== undefined) {
        setTraceBySession((current) => {
          const existing = current[activeSessionId] ?? []
          return existing.some((item) => item.id === trace.id)
            ? current
            : { ...current, [activeSessionId]: [...existing, trace] }
        })
      }
      if (event.type === 'stream/error') {
        setError(contentText(event.data) || '会话流连接中断')
        setIsStreaming(false)
        patchSession(activeSessionId, { running: false })
        return
      }
      if (event.type === 'turn/start') {
        setIsStreaming(true)
        patchSession(activeSessionId, { running: true })
      }
      if (event.type === 'turn/end' || event.type === 'turn/cancel') {
        setIsStreaming(false)
        patchSession(activeSessionId, { running: false, updatedAt: Date.now(), blank: false })
      }
      if (event.type === 'session/title') {
        const title = asObject(event.data)?.title
        if (typeof title === 'string') patchSession(activeSessionId, { title })
      }
      setMessagesBySession((current) => ({
        ...current,
        [activeSessionId]: applyEvent(current[activeSessionId] ?? [], event),
      }))
    }).then((cancel) => {
      if (disposed) void cancel()
      else {
        cancelFollowRef.current = cancel
      }
    }).catch((reason: unknown) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => {
      disposed = true
      cancelFollowRef.current?.()
      cancelFollowRef.current = undefined
    }
  }, [activeSessionId, dshUrl, patchSession])

  useEffect(() => { setAttachments([]) }, [activeSessionId])

  useEffect(() => {
    setTaskMenuOpen(false)
    setTaskRenaming(false)
    setTaskArchiveConfirm(false)
  }, [activeSessionId])

  useEffect(() => {
    if (!taskMenuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && taskMenuRef.current?.contains(event.target) === true) return
      setTaskMenuOpen(false)
      setTaskRenaming(false)
      setTaskArchiveConfirm(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setTaskMenuOpen(false)
        setTaskRenaming(false)
        setTaskArchiveConfirm(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [taskMenuOpen])

  useEffect(() => {
    if ((!inspectorOpen && composerMenu !== 'worktree') || environmentPath === undefined) {
      setEnvironment(undefined)
      setEnvironmentLoading(false)
      return
    }
    let disposed = false
    setEnvironmentLoading(true)
    void window.desktop.project.environment(environmentPath)
      .then((value) => { if (!disposed) setEnvironment(value) })
      .catch(() => { if (!disposed) setEnvironment({ path: environmentPath, isGit: false, branches: [], changes: [] }) })
      .finally(() => { if (!disposed) setEnvironmentLoading(false) })
    return () => { disposed = true }
  }, [composerMenu, environmentPath, inspectorOpen])

  useEffect(() => {
    if (composerMenu === undefined) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && composerRef.current?.contains(event.target) === true) return
      setComposerMenu(undefined)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setComposerMenu(undefined)
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [composerMenu])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: messages.some((message) => message.streaming) ? 'auto' : 'smooth' })
  }, [messages])

  const selectedModel = activeSession?.selectedModel ?? catalog?.default
  const modelValue = selectedModel === undefined ? '' : `${selectedModel.provider}::${selectedModel.model}`

  const availableModels = useMemo(() => catalog?.groups.flatMap((group) => (
    group.models.map((model) => ({
      value: `${group.id}::${model.id}`,
      label: model.name,
      provider: group.name,
    }))
  )) ?? [], [catalog])
  const selectedModelLabel = availableModels.find((model) => model.value === modelValue)?.label ?? selectedModel?.model ?? '加载模型…'

  async function switchProject(path: string): Promise<void> {
    const reusable = sessions.find((session) => session.cwd === path && session.blank && !session.running)
    setWorkspaceRoot(path)
    setComposerMenu(undefined)
    if (reusable !== undefined) {
      selectSession(reusable.id)
      return
    }
    if (dshUrl === undefined) return
    const created = await dsh.createSession({ cwd: path, agentPreset })
    addSession({ id: created.sessionId, title: '新任务', updatedAt: Date.now(), running: false, blank: true, cwd: path })
  }

  async function chooseProject(): Promise<void> {
    const selected = await window.desktop.project.chooseDirectory()
    if (selected !== undefined) await switchProject(selected)
  }

  async function openTerminal(): Promise<void> {
    if (environmentPath === undefined) {
      setError('请先选择一个项目目录')
      return
    }
    try {
      await window.desktop.project.openTerminal(environmentPath)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  async function chooseImages(): Promise<void> {
    setError(undefined)
    try {
      const selected = await window.desktop.attachments.chooseImages()
      if (selected.length > 0) setAttachments((current) => [...current, ...selected].slice(0, 20))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  async function selectModel(value: string): Promise<void> {
    if (activeSessionId === undefined || value === '') return
    const separator = value.indexOf('::')
    if (separator < 0) return
    const selection: ModelSelection = {
      provider: value.slice(0, separator),
      model: value.slice(separator + 2),
    }
    setSelectingModel(true)
    setError(undefined)
    try {
      const accepted = await dsh.selectModel({ sessionId: activeSessionId, ...selection })
      patchSession(activeSessionId, { selectedModel: accepted.selected })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSelectingModel(false)
    }
  }

  async function send(textOverride?: string): Promise<void> {
    const text = (textOverride ?? input).trim()
    if ((text === '' && attachments.length === 0) || activeSessionId === undefined || dshUrl === undefined || isStreaming) return
    const requestId = newId()
    const outgoingAttachments = attachments
    setInput('')
    setAttachments([])
    if (textareaRef.current !== null) textareaRef.current.style.height = 'auto'
    setError(undefined)
    setMessagesBySession((current) => ({
      ...current,
      [activeSessionId]: [
        ...(current[activeSessionId] ?? []),
        { id: requestId, role: 'user', text, optimistic: true, ...(outgoingAttachments.length === 0 ? {} : { attachments: outgoingAttachments.map(({ name, mediaType }) => ({ name, mediaType })) }) },
        { id: `reply-${requestId}`, role: 'assistant', text: '', streaming: true },
      ],
    }))
    setIsStreaming(true)
    patchSession(activeSessionId, {
      running: true,
      blank: false,
      updatedAt: Date.now(),
      ...(activeSession?.blank === true ? { title: (text || `${String(outgoingAttachments.length)} 张图片`).slice(0, 28) } : {}),
    })
    try {
      await dsh.prompt({
        requestId,
        sessionId: activeSessionId,
        mode: 'queue',
        content: [
          ...(text === '' ? [] : [{ type: 'text' as const, text }]),
          ...outgoingAttachments.map(({ name, mediaType, data }) => ({ type: 'image' as const, name, mediaType, data })),
        ],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setAttachments(outgoingAttachments)
      setIsStreaming(false)
      patchSession(activeSessionId, { running: false })
      setMessagesBySession((current) => ({
        ...current,
        [activeSessionId]: (current[activeSessionId] ?? []).filter((message) => message.id !== `reply-${requestId}`),
      }))
    }
  }

  async function cancel(): Promise<void> {
    if (activeSessionId === undefined) return
    try {
      await dsh.cancel({ sessionId: activeSessionId })
    } catch {
      // The follow stream remains the source of truth if cancellation races completion.
    }
  }

  async function renameActiveTask(): Promise<void> {
    if (activeSession === undefined) return
    const title = taskRenameDraft.trim()
    if (title === '') return
    setError(undefined)
    try {
      const result = await dsh.renameSession({ sessionId: activeSession.id, title })
      patchSession(activeSession.id, { title: result.title, updatedAt: Date.now() })
      setTaskMenuOpen(false)
      setTaskRenaming(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  async function archiveActiveTask(): Promise<void> {
    if (activeSession === undefined) return
    if (!taskArchiveConfirm) {
      setTaskArchiveConfirm(true)
      return
    }
    setError(undefined)
    try {
      await dsh.archiveSession({ sessionId: activeSession.id })
      archiveSessionLocally(activeSession.id)
      setTaskMenuOpen(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  async function createParallelTask(): Promise<void> {
    if (dshUrl === undefined) return
    setError(undefined)
    try {
      const created = await dsh.createSession({
        ...(environmentPath === undefined ? {} : { cwd: environmentPath }),
        agentPreset,
      })
      addSession({
        id: created.sessionId,
        title: '新任务',
        updatedAt: Date.now(),
        running: false,
        blank: true,
        ...(environmentPath === undefined ? {} : { cwd: environmentPath }),
      })
      setTaskMenuOpen(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  async function copyTaskId(): Promise<void> {
    if (activeSession === undefined) return
    try {
      await navigator.clipboard.writeText(activeSession.id)
      setTaskMenuOpen(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const ready = dshUrl !== undefined && activeSessionId !== undefined

  return (
    <div className="surface-view chat-view">
      <header className="surface-header chat-header titlebar-drag">
        <div className="chat-title">
          <button className="mobile-sidebar-trigger titlebar-no-drag" type="button">
            <Icon name="menu" size={17} />
          </button>
          <Icon className="chat-title-folder" name="folder" size={16} />
          <h1>{activeSession?.title ?? 'DeepSeek Harness'}</h1>
          <span className="chat-project-name">{pathName(activeSession?.cwd ?? workspaceRoot)}</span>
          <div className="chat-task-menu titlebar-no-drag" ref={taskMenuRef}>
            <button aria-expanded={taskMenuOpen} aria-haspopup="menu" aria-label="任务菜单" className="chat-header-more" disabled={activeSession === undefined} onClick={() => { setTaskMenuOpen((open) => !open); setTaskRenaming(false); setTaskArchiveConfirm(false) }} type="button">
              <Icon name="more" size={16} />
            </button>
            {taskMenuOpen && activeSession !== undefined && (
              <div className="project-menu task-header-menu" role="menu">
                {taskRenaming ? (
                  <form className="project-rename-form" onSubmit={(event) => { event.preventDefault(); void renameActiveTask() }}>
                    <label htmlFor="active-task-name">任务名称</label>
                    <div>
                      <input autoFocus id="active-task-name" onChange={(event) => setTaskRenameDraft(event.target.value)} value={taskRenameDraft} />
                      <button aria-label="保存名称" disabled={taskRenameDraft.trim() === ''} type="submit"><Icon name="check" size={14} /></button>
                      <button aria-label="取消重命名" onClick={() => setTaskRenaming(false)} type="button"><Icon name="close" size={14} /></button>
                    </div>
                  </form>
                ) : (
                  <>
                    <button onClick={() => { toggleSessionPin(activeSession.id); setTaskMenuOpen(false) }} role="menuitem" type="button"><Icon name="pin" size={15} /><span>{pinnedSessionIds.includes(activeSession.id) ? '取消置顶' : '置顶'}</span></button>
                    <button onClick={() => { setTaskRenameDraft(activeSession.title); setTaskRenaming(true); setTaskArchiveConfirm(false) }} role="menuitem" type="button"><Icon name="edit" size={15} /><span>重命名</span></button>
                    <button className="project-menu-danger" onClick={() => void archiveActiveTask()} role="menuitem" type="button"><Icon name="archive" size={15} /><span>{taskArchiveConfirm ? '再次点击确认归档' : '归档任务'}</span></button>
                    <div className="project-menu-divider" />
                    <button onClick={() => void copyTaskId()} role="menuitem" type="button"><Icon name="copy" size={15} /><span>复制任务 ID</span></button>
                    <div className="project-menu-divider" />
                    <button onClick={() => void createParallelTask()} role="menuitem" type="button"><Icon name="plus" size={15} /><span>新建并行任务</span></button>
                    <button onClick={() => { setView('automations'); setTaskMenuOpen(false) }} role="menuitem" type="button"><Icon name="clock" size={15} /><span>创建自动化任务…</span></button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="header-actions titlebar-no-drag">
          <button aria-label="在项目目录打开终端" className="icon-button" disabled={environmentPath === undefined} onClick={() => void openTerminal()} type="button"><Icon name="terminal" size={16} /></button>
          <button aria-label="切换运行面板" className={`icon-button ${inspectorOpen ? 'is-active' : ''}`} onClick={toggleInspector} type="button">
            <Icon name="panel" size={16} />
          </button>
        </div>
      </header>

      <TrajectoryStrip blocks={activeSessionId === undefined ? [] : traceBySession[activeSessionId] ?? []} />

      <div className={`chat-workbench ${inspectorOpen ? 'has-inspector' : ''}`}>
        <section className="conversation-shell">
          <div className="message-scroller">
            {error !== undefined && (
              <div className="notice notice-error">
                <span><Icon name="activity" size={16} /></span>
                <p>{error}</p>
                <button aria-label="关闭错误" onClick={() => setError(undefined)} type="button"><Icon name="close" size={14} /></button>
              </div>
            )}
            {connectionError !== undefined && error === undefined && (
              <div className="notice notice-error"><span><Icon name="activity" size={16} /></span><p>{connectionError}</p></div>
            )}

            {messages.length === 0 ? (
              <div className="empty-hero">
                <div className="hero-symbol" aria-hidden="true">
                  <span className="hero-halo" />
                  <BrandMark size={42} muted />
                </div>
                <h2>{greeting()}</h2>
                <div className="suggestion-row">
                  {suggestions.map((suggestion) => (
                    <button disabled={!ready} key={suggestion.label} onClick={() => void send(suggestion.prompt)} type="button">
                      <Icon name={suggestion.icon} size={15} />
                      <span>{suggestion.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="message-list">
                {messages.map((message) => message.role === 'user' ? (
                  <article className="message-user" key={message.id}>
                    <div><div className="message-meta"><span>你</span>{message.optimistic === true && <small>发送中</small>}</div>{message.attachments !== undefined && <div className="message-attachments">{message.attachments.map((item, index) => <span key={`${item.name}-${String(index)}`}><Icon name="paperclip" size={12} />{item.name}</span>)}</div>}{message.text !== '' && <p>{message.text}</p>}</div>
                  </article>
                ) : (
                  <article className="message-assistant" key={message.id}>
                    <div className="assistant-rail"><BrandMark size={24} /></div>
                    <div className="assistant-content">
                      <div className="message-meta">
                        <span>DeepSeek</span>
                        {message.streaming === true && <small className="working-label"><i />正在工作</small>}
                      </div>
                      {message.text === '' && message.streaming === true
                        ? <div className="thinking-lines"><i /><i /><i /></div>
                        : <p>{message.text}</p>}
                    </div>
                  </article>
                ))}
                <div ref={endRef} />
              </div>
            )}
          </div>

          <div className="composer-dock">
            <div className={`composer ${isStreaming ? 'is-streaming' : ''}`} ref={composerRef}>
              <div className="composer-context">
                <div className="composer-menu-anchor">
                  <button className={composerMenu === 'project' ? 'is-open' : ''} onClick={() => setComposerMenu((current) => current === 'project' ? undefined : 'project')} title={workspaceRoot} type="button">
                    <Icon name="folder" size={15} />
                    <span>{pathName(environmentPath)}</span>
                    <Icon className="composer-chevron" name="chevron-down" size={13} />
                  </button>
                    <div aria-hidden={composerMenu !== 'project'} className={`composer-popover composer-project-popover ${composerMenu === 'project' ? 'is-open' : ''}`}>
                      <span className="composer-popover-label">项目</span>
                      {projectPaths.map((path) => <button className={path === environmentPath ? 'is-selected' : ''} key={path} onClick={() => void switchProject(path)} type="button"><Icon name="folder" size={14} /><span>{pathName(path)}</span>{path === environmentPath && <Icon name="check" size={14} />}</button>)}
                      <div className="composer-popover-divider" />
                      <button onClick={() => void chooseProject()} type="button"><Icon name="plus" size={14} /><span>打开其他项目…</span></button>
                    </div>
                </div>
                <span className="context-divider" />
                <div className="composer-menu-anchor">
                  <button className={composerMenu === 'worktree' ? 'is-open' : ''} onClick={() => setComposerMenu((current) => current === 'worktree' ? undefined : 'worktree')} type="button">
                    <Icon name="branch" size={15} />
                    <span>working tree</span>
                    <Icon className="composer-chevron" name="chevron-down" size={13} />
                  </button>
                    <div aria-hidden={composerMenu !== 'worktree'} className={`composer-popover composer-worktree-popover ${composerMenu === 'worktree' ? 'is-open' : ''}`}>
                      <span className="composer-popover-label">工作树</span>
                      <div className="composer-info-row"><Icon name="check" size={14} /><span><strong>当前工作树</strong><small>{environmentPath ?? '未绑定目录'}</small></span></div>
                      {environment?.isGit === true && <><div className="composer-popover-divider" /><span className="composer-popover-label">分支</span>{environment.branches.slice(0, 8).map((branch) => <div className={`composer-info-row ${branch === environment.branch ? 'is-current' : ''}`} key={branch}><Icon name="branch" size={14} /><span><strong>{branch}</strong><small>{branch === environment.branch ? '当前分支' : '可用于新工作树'}</small></span></div>)}</>}
                    </div>
                </div>
              </div>
              {attachments.length > 0 && <div className="attachment-tray">{attachments.map((item, index) => <div className="attachment-chip" key={`${item.name}-${String(index)}`}><img alt="" src={`data:${item.mediaType};base64,${item.data}`} /><span><strong>{item.name}</strong><small>{item.mediaType}</small></span><button aria-label={`移除 ${item.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} type="button"><Icon name="close" size={12} /></button></div>)}</div>}
              <textarea
                disabled={!ready}
                onChange={(event) => setInput(event.target.value)}
                onInput={(event) => {
                  const target = event.currentTarget
                  target.style.height = 'auto'
                  target.style.height = `${Math.min(target.scrollHeight, 180)}px`
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void send()
                  }
                }}
                placeholder={ready ? '向 DeepSeek 提问，使用 @ 添加上下文，使用 / 选择能力' : '正在准备…'}
                ref={textareaRef}
                rows={1}
                value={input}
              />
              <div className="composer-toolbar">
                <div className="composer-tools">
                  <button aria-label="添加图片上下文" className="composer-icon-button" onClick={() => void chooseImages()} type="button"><Icon name="plus" size={17} /></button>
                  <div className="composer-menu-anchor">
                    <button className={`mode-button ${composerMenu === 'mode' ? 'is-open' : ''}`} onClick={() => setComposerMenu((current) => current === 'mode' ? undefined : 'mode')} type="button"><Icon name="shield" size={16} /><span>{agentPreset === 'standard' ? '自动编排' : agentPreset}</span><Icon className="composer-chevron" name="chevron-down" size={13} /></button>
                      <div aria-hidden={composerMenu !== 'mode'} className={`composer-popover composer-mode-popover ${composerMenu === 'mode' ? 'is-open' : ''}`}>
                        <span className="composer-popover-label">Agent 预设</span>
                        {[['standard', '自动编排', '完整工具与计划能力'], ['minimal', '极简模式', '更轻的上下文'], ['code', 'PTC 模式', '程序化工具编排'], ['cordis', '创造模式', '插件与预设开发']].map(([id, label, detail]) => <button className={agentPreset === id ? 'is-selected' : ''} key={id} onClick={() => { setAgentPreset(id); setComposerMenu(undefined) }} type="button"><Icon name="shield" size={14} /><span><strong>{label}</strong><small>{detail}</small></span>{agentPreset === id && <Icon name="check" size={14} />}</button>)}
                      </div>
                  </div>
                </div>
                <div className="composer-submit">
                  <div className="composer-menu-anchor model-menu-anchor">
                    <button aria-expanded={composerMenu === 'model'} aria-haspopup="listbox" className={`composer-model-button ${composerMenu === 'model' ? 'is-open' : ''}`} disabled={selectingModel || availableModels.length === 0 || activeSessionId === undefined} onClick={() => setComposerMenu((current) => current === 'model' ? undefined : 'model')} type="button"><span>{selectedModelLabel}</span><Icon className="composer-chevron" name="chevron-down" size={13} /></button>
                      <div aria-hidden={composerMenu !== 'model'} className={`composer-popover composer-model-popover ${composerMenu === 'model' ? 'is-open' : ''}`} role="listbox">
                        {catalog?.groups.map((group) => <div className="composer-model-group" key={group.id}><span className="composer-popover-label">{group.name}</span>{group.models.map((model) => { const value = `${group.id}::${model.id}`; return <button aria-selected={value === modelValue} className={value === modelValue ? 'is-selected' : ''} key={model.id} onClick={() => { setComposerMenu(undefined); void selectModel(value) }} role="option" type="button"><span><strong>{model.name}</strong>{model.description !== undefined && <small>{model.description}</small>}</span>{value === modelValue && <Icon name="check" size={14} />}</button> })}</div>)}
                      </div>
                  </div>
                  {isStreaming ? (
                    <button aria-label="停止生成" className="send-button stop-button" onClick={() => void cancel()} type="button"><span /></button>
                  ) : (
                    <button aria-label="发送" className="send-button" disabled={(input.trim() === '' && attachments.length === 0) || !ready} onClick={() => void send()} type="button">
                      <Icon name="arrow-up" size={17} strokeWidth={2} />
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="composer-footnote">
              <span><Icon name="cache" size={13} />{cacheHit === undefined ? '上下文缓存路由已启用' : `缓存命中 ${String(cacheHit)}%`}</span>
            </div>
          </div>
        </section>

        {inspectorOpen && (
          <aside className="inspector-panel environment-panel">
            <div className="inspector-heading">
              <div><span className="eyebrow">LOCAL WORKSPACE</span><h2>环境信息</h2></div>
              <button aria-label="关闭面板" className="icon-button subtle" onClick={toggleInspector} type="button"><Icon name="close" size={15} /></button>
            </div>
            <div className="inspector-section">
              <div className="environment-overview">
                <div><Icon name="edit" size={16} /><span><strong>变更</strong><small>{environmentLoading ? '读取中' : `${String(environment?.changes.length ?? 0)} 项`}</small></span></div>
                <div><Icon name="terminal" size={16} /><span><strong>本地</strong><small>{pathName(environmentPath)}</small></span></div>
                <div><Icon name="branch" size={16} /><span><strong>{environment?.isGit === true ? environment.branch ?? 'HEAD' : '非 Git 项目'}</strong><small>{environmentPath ?? '未绑定目录'}</small></span></div>
              </div>
            </div>
            <div className="inspector-section">
              <span className="section-label">变更内容</span>
              <div className="environment-change-list">
                {environmentLoading ? <span className="environment-muted">正在读取工作区…</span> : environment?.changes.length === 0 || environment === undefined ? <span className="environment-muted">工作区没有未提交变更</span> : environment.changes.slice(0, 8).map((change) => <div key={`${change.status}-${change.path}`}><code>{change.status}</code><span>{change.path}</span></div>)}
              </div>
            </div>
            <div className="inspector-section">
              <span className="section-label">后台进程</span>
              <div className="environment-process-list">
                {activeJobs.length === 0 ? <span className="environment-muted">当前没有后台进程</span> : activeJobs.slice(0, 6).map((job) => <div key={job.id}><Icon name="terminal" size={14} /><span>{job.label}</span><small>{job.status === 'running' ? '运行中' : job.status}</small></div>)}
              </div>
            </div>
            <div className="inspector-section">
              <span className="section-label">来源</span>
              <div className="environment-source-list">
                {sourceItems.length === 0 ? <span className="environment-muted">当前任务没有附件来源</span> : sourceItems.slice(0, 8).map((name) => <div key={name}><Icon name="paperclip" size={14} /><span>{name}</span></div>)}
              </div>
            </div>
            <div className="environment-metrics"><span>{stats?.turns ?? 0} 轮</span><span>{stats?.steps ?? 0} 步</span><span>{stats === undefined ? '—' : compactDuration(stats.llmMs)} LLM</span><span>{cacheHit === undefined ? '缓存等待样本' : `缓存 ${String(cacheHit)}%`}</span>{contextPercent !== undefined && <span>上下文 {contextPercent}%</span>}</div>
          </aside>
        )}
      </div>
    </div>
  )
}
