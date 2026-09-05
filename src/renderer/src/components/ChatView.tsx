import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  reasoning?: string
  streaming?: boolean
  optimistic?: boolean
  failed?: boolean
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

interface AssistantContentParts {
  text: string
  reasoning: string
}

function assistantContent(value: unknown): AssistantContentParts {
  if (typeof value === 'string') return { text: value, reasoning: '' }
  if (Array.isArray(value)) {
    return value.reduce<AssistantContentParts>((parts, item) => {
      const next = assistantContent(item)
      return {
        text: [parts.text, next.text].filter(Boolean).join('\n\n'),
        reasoning: [parts.reasoning, next.reasoning].filter(Boolean).join('\n\n'),
      }
    }, { text: '', reasoning: '' })
  }
  const object = asObject(value)
  if (object === undefined) return { text: '', reasoning: '' }
  const type = typeof object.type === 'string' ? object.type : ''
  if (typeof object.text === 'string') {
    if (type === 'reasoning' || type === 'thinking') return { text: '', reasoning: object.text }
    if (type === '' || type === 'text' || type === 'output_text') return { text: object.text, reasoning: '' }
  }
  if (typeof object.content === 'string' || Array.isArray(object.content)) return assistantContent(object.content)
  return { text: '', reasoning: '' }
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

function finishLastAssistant(messages: Message[], text?: string, reasoning?: string): Message[] {
  const last = messages.at(-1)
  if (last?.role !== 'assistant') {
    if ((text === undefined || text === '') && (reasoning === undefined || reasoning === '')) return messages
    return [...messages, {
      id: newId(),
      role: 'assistant',
      text: text ?? '',
      ...(reasoning === undefined || reasoning === '' ? {} : { reasoning }),
    }]
  }
  return [...messages.slice(0, -1), {
    ...last,
    text: text === undefined || text === '' ? last.text : text,
    ...(reasoning === undefined || reasoning === '' ? {} : { reasoning }),
    streaming: false,
  }]
}

function turnFailureText(event: SessionEvent): string | undefined {
  if (event.type !== 'turn/end') return undefined
  const reason = asObject(asObject(event.data)?.reason)
  if (reason?.kind !== 'error') return undefined
  const error = asObject(reason.error)
  const message = typeof error?.message === 'string' && error.message.trim() !== ''
    ? error.message.trim()
    : '模型请求失败'
  const code = typeof error?.code === 'string' && !message.includes(error.code)
    ? `（${error.code}）`
    : ''
  const status = typeof error?.status === 'number' ? error.status : undefined
  const hint = status === 400 ? '。请检查 Base URL 与所选模型是否匹配。' : ''
  return `请求失败：${message}${code}${hint}`
}

function failLastAssistant(messages: Message[], event: SessionEvent, text: string): Message[] {
  const last = messages.at(-1)
  const failure: Message = {
    id: `failure-${String(event.seq)}`,
    role: 'assistant',
    text,
    streaming: false,
    failed: true,
  }
  if (last?.role !== 'assistant') return [...messages, failure]
  if (last.text === '') return [...messages.slice(0, -1), { ...last, text, streaming: false, failed: true }]
  return [...finishLastAssistant(messages), failure]
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
    if ((chunk?.type !== 'text-delta' && chunk?.type !== 'reasoning-delta') || typeof chunk.text !== 'string') return messages
    const isReasoning = chunk.type === 'reasoning-delta'
    const last = messages.at(-1)
    if (last?.role === 'assistant' && last.streaming === true) {
      return [...messages.slice(0, -1), {
        ...last,
        text: isReasoning ? last.text : last.text + chunk.text,
        ...(isReasoning ? { reasoning: (last.reasoning ?? '') + chunk.text } : {}),
      }]
    }
    return [...messages, {
      id: `assistant-${event.seq}`,
      role: 'assistant',
      text: isReasoning ? '' : chunk.text,
      ...(isReasoning ? { reasoning: chunk.text } : {}),
      streaming: true,
    }]
  }
  if (event.type === 'assistant/message') {
    const message = asObject(data?.message)
    const content = assistantContent(message?.content)
    return finishLastAssistant(messages, content.text, content.reasoning)
  }
  if (event.type === 'assistant/text') {
    const text = contentText(event.data)
    const last = messages.at(-1)
    if (last?.role === 'assistant' && last.streaming === true) {
      return [...messages.slice(0, -1), { ...last, text: last.text + text }]
    }
    return text === '' ? messages : [...messages, { id: `assistant-${event.seq}`, role: 'assistant', text, streaming: true }]
  }
  if (event.type === 'turn/end') {
    const failure = turnFailureText(event)
    return failure === undefined ? finishLastAssistant(messages) : failLastAssistant(messages, event, failure)
  }
  if (event.type === 'turn/cancel') return finishLastAssistant(messages)
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

function comparableModelId(value: string): string {
  return (value.split('/').at(-1) ?? value).toLowerCase().replace(/[^a-z0-9]+/gu, '')
}

function matchingModelId(ids: readonly string[], selected: string): string | undefined {
  return ids.find((id) => id === selected)
    ?? ids.find((id) => comparableModelId(id) === comparableModelId(selected))
}

const modelProviderNames: Readonly<Record<string, string>> = {
  qwen: 'Qwen',
  'deepseek-ai': 'DeepSeek',
  baai: 'BAAI',
  'zai-org': 'Z.ai',
  xingchenagi: 'XingChen AGI',
  thudm: 'THUDM',
  moonshotai: 'Moonshot AI',
  funaudiollm: 'FunAudioLLM',
  inclusionai: 'Inclusion AI',
  'wan-ai': 'Wan AI',
  'tongyi-mai': 'Tongyi MAI',
  minimaxai: 'MiniMax',
  tencent: 'Tencent',
  'stepfun-ai': 'StepFun',
  paddlepaddle: 'PaddlePaddle',
  'bytedance-seed': 'ByteDance Seed',
  'nex-agi': 'Nex AGI',
  'meituan-longcat': 'Meituan LongCat',
  'kwai-kolors': 'Kwai Kolors',
  baidu: 'Baidu',
  fnlp: 'FNLP',
}
const modelRoutePrefixes: ReadonlySet<string> = new Set(['pro', 'lora', 'free'])

function modelProviderName(modelId: string, fallback: string): string {
  const segments = modelId.split('/').filter(Boolean)
  if (segments.length < 2) return fallback
  const first = segments[0]
  const namespace = first !== undefined && modelRoutePrefixes.has(first.toLowerCase())
    ? segments[1]
    : first
  if (namespace === undefined) return fallback
  return modelProviderNames[namespace.toLowerCase()] ?? namespace
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

interface SessionMetricFold {
  stats: SessionStatsProjection
  tokenUsage: TokenUsageProjection
  lastTurn?: number
  openStep?: { turn: number, step: number, startTime: number, firstTokenTime?: number }
  pendingCalls: Record<string, number>
  lastUsage?: { turn: number, step: number, buckets: TokenUsageProjection }
}

function emptySessionMetricFold(): SessionMetricFold {
  return {
    stats: { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    pendingCalls: {},
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function eventTime(value: SessionEvent['time']): number | undefined {
  const parsed = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function usageBuckets(value: unknown): TokenUsageProjection | undefined {
  const usage = asObject(value)
  const inputTokens = finiteNumber(usage?.inputTokens)
  const outputTokens = finiteNumber(usage?.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined || inputTokens < 0 || outputTokens < 0) return undefined
  return {
    uncachedInputTokens: inputTokens,
    outputTokens,
    cacheReadTokens: Math.max(0, finiteNumber(usage?.cacheReadTokens) ?? 0),
    cacheWriteTokens: Math.max(0, finiteNumber(usage?.cacheWriteTokens) ?? 0),
  }
}

function foldSessionMetric(state: SessionMetricFold, event: SessionEvent): SessionMetricFold {
  const data = asObject(event.data)
  const turn = finiteNumber(data?.turn)
  const step = finiteNumber(data?.step)
  const time = eventTime(event.time)
  const chunk = asObject(data?.chunk)
  let next = state

  if (event.type === 'llm/retry-started' && turn !== undefined && step !== undefined
    && state.lastUsage?.turn === turn && state.lastUsage.step === step) {
    next = { ...state, lastUsage: undefined }
  }

  const usage = event.type === 'assistant/chunk' && chunk?.type === 'usage'
    ? usageBuckets(chunk.usage)
    : event.type === 'assistant/message' ? usageBuckets(data?.usage) : undefined
  if (usage !== undefined && turn !== undefined && step !== undefined) {
    const previous = next.lastUsage?.turn === turn && next.lastUsage.step === step
      ? next.lastUsage.buckets
      : undefined
    next = {
      ...next,
      tokenUsage: {
        uncachedInputTokens: next.tokenUsage.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + usage.uncachedInputTokens,
        outputTokens: next.tokenUsage.outputTokens - (previous?.outputTokens ?? 0) + usage.outputTokens,
        cacheReadTokens: next.tokenUsage.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + usage.cacheReadTokens,
        cacheWriteTokens: next.tokenUsage.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + usage.cacheWriteTokens,
      },
      lastUsage: { turn, step, buckets: usage },
    }
  }

  if (event.type === 'step/start' && turn !== undefined && step !== undefined && time !== undefined) {
    return { ...next, openStep: { turn, step, startTime: time } }
  }
  if (event.type === 'assistant/chunk') {
    const open = next.openStep
    const isToken = (chunk?.type === 'reasoning-delta' || chunk?.type === 'text-delta')
      && typeof chunk.text === 'string' && chunk.text !== ''
    if (open === undefined || open.firstTokenTime !== undefined || !isToken || time === undefined
      || turn !== open.turn || step !== open.step) return next
    return { ...next, openStep: { ...open, firstTokenTime: time } }
  }
  if (event.type === 'assistant/message') {
    const open = next.openStep
    if (open === undefined || time === undefined || turn !== open.turn || step !== open.step) return next
    const stats = { ...next.stats, llmMs: next.stats.llmMs + Math.max(0, time - open.startTime) }
    if (open.firstTokenTime !== undefined) {
      stats.ttftMs += Math.max(0, open.firstTokenTime - open.startTime)
      stats.ttftSteps += 1
      const outputTokens = finiteNumber(asObject(data?.usage)?.outputTokens)
      if (outputTokens !== undefined && outputTokens >= 0) {
        stats.decodeMs += Math.max(0, time - open.firstTokenTime)
        stats.decodeTokens += outputTokens
      }
    }
    return { ...next, stats, openStep: undefined }
  }
  if (event.type === 'tool/call' && typeof data?.callId === 'string' && time !== undefined) {
    return { ...next, pendingCalls: { ...next.pendingCalls, [data.callId]: time } }
  }
  if (event.type === 'tool/result' && time !== undefined) {
    const callId = asObject(asObject(data?.message)?.source)?.callId
    if (typeof callId !== 'string' || !Object.hasOwn(next.pendingCalls, callId)) return next
    const dispatched = next.pendingCalls[callId]
    if (dispatched === undefined) return next
    const pendingCalls = Object.fromEntries(Object.entries(next.pendingCalls).filter(([id]) => id !== callId))
    return {
      ...next,
      stats: { ...next.stats, toolMs: next.stats.toolMs + Math.max(0, time - dispatched) },
      pendingCalls,
    }
  }
  if (event.type === 'step/end' && turn !== undefined) {
    return {
      ...next,
      stats: {
        ...next.stats,
        turns: next.lastTurn === turn ? next.stats.turns : next.stats.turns + 1,
        steps: next.stats.steps + 1,
      },
      lastTurn: turn,
      openStep: undefined,
    }
  }
  if (event.type === 'turn/end' && Object.keys(next.pendingCalls).length > 0) {
    return { ...next, pendingCalls: {} }
  }
  return next
}

function metricsFrom(records: unknown[]): SessionMetricFold {
  return records.reduce<SessionMetricFold>((state, record) => {
    const event = eventFromRecord(record)
    return event === undefined ? state : foldSessionMetric(state, event)
  }, emptySessionMetricFold())
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

function metricDuration(ms: number): string {
  const safeMs = Math.max(0, ms)
  if (safeMs < 60_000) return `${String(Math.round(safeMs / 100) / 10)}秒`
  const seconds = Math.round(safeMs / 1_000)
  return `${String(Math.floor(seconds / 60))}分${String(seconds % 60)}秒`
}

function averageFirstTokenDuration(ms: number): string {
  return `${String(Math.round(Math.max(0, ms) / 100) / 10)}秒`
}

function compactTokenCount(tokens: number): string {
  const safeTokens = Math.max(0, tokens)
  if (safeTokens >= 1_000_000) return `${String(Math.round(safeTokens / 100_000) / 10)}M tok`
  if (safeTokens >= 1_000) return `${String(Math.round(safeTokens / 100) / 10)}K tok`
  return `${String(Math.round(safeTokens))} tok`
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
  const [metricFoldsBySession, setMetricFoldsBySession] = useState<Record<string, SessionMetricFold>>({})
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [copiedMessageId, setCopiedMessageId] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [catalog, setCatalog] = useState<ModelCatalog | undefined>()
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<string | undefined>()
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
  const fallbackMetrics = activeSessionId === undefined ? undefined : metricFoldsBySession[activeSessionId]
  const projectionValues = activeSessionId === undefined ? undefined : projectionBaselines[activeSessionId]?.values
  const tokenUsage = tokenUsageOf(projectionValues?.tokenUsage) ?? fallbackMetrics?.tokenUsage
  const stats = statsOf(projectionValues?.sessionStats) ?? fallbackMetrics?.stats
  const pressure = pressureOf(projectionValues?.contextPressure)
  const activeJobs = activeSessionId === undefined ? [] : controlJobs[activeSessionId] ?? []
  const billedInput = tokenUsage === undefined ? 0 : tokenUsage.uncachedInputTokens + tokenUsage.cacheReadTokens + tokenUsage.cacheWriteTokens
  const cacheHit = tokenUsage === undefined || billedInput === 0 ? undefined : Math.round(tokenUsage.cacheReadTokens / billedInput * 1_000) / 10
  const contextUsed = pressure?.projectedTokens ?? pressure?.pressureTokens
  const contextPercent = contextUsed === undefined || pressure?.contextWindow === undefined || pressure.contextWindow <= 0
    ? undefined
    : Math.min(100, Math.round(contextUsed / pressure.contextWindow * 100))
  const averageFirstToken = stats === undefined || stats.ttftSteps <= 0
    ? undefined
    : stats.ttftMs / stats.ttftSteps
  const decodeRate = stats === undefined || stats.decodeMs <= 0
    ? undefined
    : Math.round(stats.decodeTokens / stats.decodeMs * 1_000)
  const runtimeSummary = [
    `${String(stats?.turns ?? 0)} 轮 · ${String(stats?.steps ?? 0)} 步`,
    `LLM ${stats === undefined ? '—' : metricDuration(stats.llmMs)} · 工具调用 ${stats === undefined ? '—' : metricDuration(stats.toolMs)}`,
    `首 token 平均 ${averageFirstToken === undefined ? '—' : averageFirstTokenDuration(averageFirstToken)} · ${decodeRate === undefined ? '— tok/s' : `${String(decodeRate)} tok/s`}`,
    `缓存命中 ${cacheHit === undefined ? '—' : `${String(cacheHit)}%`}`,
    `输入 ${tokenUsage === undefined ? '— tok' : compactTokenCount(billedInput)} · 输出 ${tokenUsage === undefined ? '— tok' : compactTokenCount(tokenUsage.outputTokens)}`,
  ]
  const environmentPath = activeSession?.cwd ?? workspaceRoot
  const sourceItems = useMemo(() => {
    const names = [
      ...attachments.map((item) => item.name),
      ...messages.flatMap((message) => message.attachments?.map((item) => item.name) ?? []),
    ]
    return [...new Set(names)]
  }, [attachments, messages])
  const projectPaths = useMemo(() => [...new Set(sessions.flatMap((session) => session.cwd === undefined ? [] : [session.cwd]))], [sessions])

  const loadModelCatalog = useCallback(async (refreshRemote = false): Promise<void> => {
    if (dshUrl === undefined) return
    setCatalogLoading(true)
    setCatalogError(undefined)
    try {
      let remoteIds: string[] | undefined
      if (refreshRemote) {
        const env = await window.desktop.settings.read()
        const apiKey = env.DEEPSEEK_API_KEY?.trim()
        const baseUrl = env.DEEPSEEK_BASE_URL?.trim()
        if (apiKey !== undefined && apiKey !== '' && baseUrl !== undefined && baseUrl !== '') {
          remoteIds = await window.desktop.models.fetch(baseUrl, apiKey)
          if (remoteIds.length === 0) throw new Error('当前 Base URL 没有返回可用模型')
          await dsh.updateDeepSeekModels(remoteIds.map((id) => ({
            id,
            name: id,
            contextWindow: 64000,
            maxTokens: 8192,
            inputModalities: ['text'],
          })))
        }
      }
      let nextCatalog = await dsh.modelCatalog()
      if (remoteIds !== undefined) {
        const appState = useApp.getState()
        const sessionId = appState.activeSessionId
        const activeSelection = appState.sessions.find((session) => session.id === sessionId)?.selectedModel
        const current = activeSelection ?? nextCatalog.default
        const matched = current.provider === 'deepseek-official'
          ? matchingModelId(remoteIds, current.model)
          : undefined
        if (sessionId !== undefined && matched !== undefined && matched !== current.model) {
          const accepted = await dsh.selectModel({
            sessionId,
            provider: current.provider,
            model: matched,
          })
          appState.patchSession(sessionId, { selectedModel: accepted.selected })
          nextCatalog = await dsh.modelCatalog()
        }
      }
      setCatalog(nextCatalog)
    } catch (reason) {
      setCatalogError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCatalogLoading(false)
    }
  }, [dshUrl])

  useEffect(() => { void loadModelCatalog() }, [loadModelCatalog])

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
        setMetricFoldsBySession((current) => ({ ...current, [activeSessionId]: metricsFrom(frame.records) }))
        setTraceBySession((current) => ({ ...current, [activeSessionId]: traceFromRecords(frame.records) }))
        return
      }
      const event = (frame as SessionFollowEvent).event
      setMetricFoldsBySession((current) => ({
        ...current,
        [activeSessionId]: foldSessionMetric(current[activeSessionId] ?? emptySessionMetricFold(), event),
      }))
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
      .catch(() => { if (!disposed) setEnvironment({ path: environmentPath, isGit: false, branches: [], changes: [], worktrees: [] }) })
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
      provider: modelProviderName(model.id, group.name),
    }))
  )) ?? [], [catalog])
  const selectedModelLabel = availableModels.find((model) => model.value === modelValue)?.label ?? selectedModel?.model ?? '加载模型…'
  const lastUserMessageId = [...messages].reverse().find((message) => message.role === 'user')?.id

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

  async function cancel(): Promise<boolean> {
    if (activeSessionId === undefined || isCancelling) return false
    setIsCancelling(true)
    setError(undefined)
    try {
      await dsh.cancel({ sessionId: activeSessionId })
      setIsStreaming(false)
      patchSession(activeSessionId, { running: false, updatedAt: Date.now() })
      setMessagesBySession((current) => {
        const items = finishLastAssistant(current[activeSessionId] ?? [])
        const last = items.at(-1)
        return {
          ...current,
          [activeSessionId]: last?.role === 'assistant' && last.text === '' ? items.slice(0, -1) : items,
        }
      })
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      setIsCancelling(false)
    }
  }

  async function editMessage(message: Message): Promise<void> {
    if (message.text === '') return
    if (isStreaming) await cancel()
    setInput(message.text)
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (textarea === null) return
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
    })
  }

  async function copyMessage(message: Message): Promise<void> {
    if (message.text === '') return
    try {
      await navigator.clipboard.writeText(message.text)
      setCopiedMessageId(message.id)
      window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? undefined : current), 1_500)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
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
                    <div>
                      <div className="message-user-heading">
                        <div className="message-meta"><span>你</span>{message.optimistic === true && <small>发送中</small>}</div>
                        <div className="message-actions">
                          <button aria-label="复制消息" disabled={message.text === ''} onClick={() => void copyMessage(message)} title="复制" type="button"><Icon name={copiedMessageId === message.id ? 'check' : 'copy'} size={13} /></button>
                          <button aria-label="修改并重新发送" disabled={message.text === ''} onClick={() => void editMessage(message)} title="修改并重新发送" type="button"><Icon name="edit" size={13} /></button>
                          {isStreaming && message.id === lastUserMessageId && <button aria-label="强制停止当前任务" className="is-danger" disabled={isCancelling} onClick={() => void cancel()} title="强制停止" type="button"><span className="stop-glyph" /></button>}
                        </div>
                      </div>
                      {message.attachments !== undefined && <div className="message-attachments">{message.attachments.map((item, index) => <span key={`${item.name}-${String(index)}`}><Icon name="paperclip" size={12} />{item.name}</span>)}</div>}
                      {message.text !== '' && <p>{message.text}</p>}
                    </div>
                  </article>
                ) : (
                  <article className={`message-assistant ${message.failed === true ? 'is-failed' : ''}`} key={message.id}>
                    <div className="assistant-rail"><BrandMark size={24} /></div>
                    <div className="assistant-content">
                      <div className="message-meta">
                        <span>DeepSeek</span>
                        {message.streaming === true && <small className="working-label"><i />正在工作</small>}
                      </div>
                      {message.reasoning !== undefined && message.reasoning !== '' && (
                        <details className="reasoning-disclosure">
                          <summary><span>思考中</span><span aria-hidden="true" className="reasoning-caret">&gt;</span></summary>
                          <div className="reasoning-body">{message.reasoning}</div>
                        </details>
                      )}
                      {message.text === '' && message.streaming === true
                        ? message.reasoning === undefined || message.reasoning === '' ? <div className="agent-thinking"><span aria-label="正在思考" className="agent-cursor" /></div> : null
                        : <p>{message.text}{message.streaming === true && <span aria-label="正在生成" className="agent-cursor" />}</p>}
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
                    <button aria-expanded={composerMenu === 'model'} aria-haspopup="listbox" className={`composer-model-button ${composerMenu === 'model' ? 'is-open' : ''}`} disabled={selectingModel || activeSessionId === undefined} onClick={() => { const opening = composerMenu !== 'model'; setComposerMenu(opening ? 'model' : undefined); if (opening) void loadModelCatalog(true) }} type="button"><span>{selectedModelLabel}</span><Icon className="composer-chevron" name="chevron-down" size={13} /></button>
                      <div aria-hidden={composerMenu !== 'model'} className={`composer-popover composer-model-popover ${composerMenu === 'model' ? 'is-open' : ''}`} role="listbox">
                        {catalogLoading && <div className="composer-popover-state"><span className="mini-spinner" />正在读取模型目录…</div>}
                        {!catalogLoading && catalogError !== undefined && <div className="composer-popover-state is-error"><span>{catalogError}</span><button onClick={() => void loadModelCatalog(true)} type="button">重试</button></div>}
                        {!catalogLoading && catalogError === undefined && availableModels.length > 0 && <>
                          <span className="composer-popover-label">当前 Base URL · {availableModels.length} 个模型</span>
                          <div className="composer-model-list">
                            {availableModels.map((model) => <button aria-selected={model.value === modelValue} className={model.value === modelValue ? 'is-selected' : ''} key={model.value} onClick={() => { setComposerMenu(undefined); void selectModel(model.value) }} role="option" type="button"><span><strong>{model.label}</strong><small>{model.provider}</small></span>{model.value === modelValue && <Icon name="check" size={14} />}</button>)}
                          </div>
                        </>}
                        {!catalogLoading && catalogError === undefined && availableModels.length === 0 && <div className="composer-popover-state"><span>还没有可用模型</span><button onClick={() => { localStorage.setItem('deepseek-desktop:settings-tab', 'models'); setComposerMenu(undefined); setView('settings') }} type="button">配置模型</button></div>}
                      </div>
                  </div>
                  {isStreaming ? (
                    <button aria-label="强制停止当前任务" className="send-button stop-button" disabled={isCancelling} onClick={() => void cancel()} title={isCancelling ? '正在停止…' : '强制停止'} type="button"><span /></button>
                  ) : (
                    <button aria-label="发送" className="send-button" disabled={(input.trim() === '' && attachments.length === 0) || !ready} onClick={() => void send()} type="button">
                      <Icon name="arrow-up" size={17} strokeWidth={2} />
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div aria-label="会话运行统计" className="composer-footnote">
              {runtimeSummary.map((item) => <span key={item}>{item}</span>)}
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
