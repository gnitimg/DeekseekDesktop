import { useEffect, useRef, useState } from 'react'
import type { SessionEvent } from '../types'
import { Icon } from './Icon'

export type TraceKind = 'input' | 'model' | 'tool'

export interface TraceBlock {
  id: string
  kind: TraceKind
  label: string
  eventType: string
  seq: number
  time: string | number
  detail: string
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(' ')
  const object = objectOf(value)
  if (object === undefined) return ''
  if (typeof object.text === 'string') return object.text
  return textOf(object.content)
}

function clipped(value: string, length = 68): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= length ? normalized : `${normalized.slice(0, length)}…`
}

function safeDetail(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2)
    if (serialized === undefined) return '无附加数据'
    return serialized.length > 2200 ? `${serialized.slice(0, 2200)}\n…` : serialized
  } catch {
    return String(value)
  }
}

export function traceFromEvent(event: SessionEvent): TraceBlock | undefined {
  const data = objectOf(event.data)
  let kind: TraceKind | undefined
  let label = ''
  if (event.type === 'user/message') {
    const source = objectOf(data?.source)
    if (source?.kind !== 'user') return undefined
    kind = 'input'
    label = clipped(textOf(data?.content)) || '用户输入'
  } else if (event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'chunkrow/tool-call-chunks') {
    kind = 'tool'
    const tool = objectOf(data?.tool)
    const name = data?.name ?? tool?.name
    label = typeof name === 'string' ? name : event.type === 'tool/result' ? '工具结果' : '工具调用'
  } else if (
    event.type === 'step/start'
    || event.type === 'assistant/message'
    || event.type === 'llm/retry'
    || event.type === 'llm/retry-started'
  ) {
    kind = 'model'
    const message = objectOf(data?.message)
    label = clipped(textOf(message?.content)) || (event.type.startsWith('llm/retry') ? '模型重试' : '模型推理')
  }
  if (kind === undefined) return undefined
  return {
    id: `${event.type}-${event.seq}`,
    kind,
    label,
    eventType: event.type,
    seq: event.seq,
    time: event.time,
    detail: safeDetail(event.data),
  }
}

export function traceFromRecords(records: unknown[]): TraceBlock[] {
  const result: TraceBlock[] = []
  for (const record of records) {
    const object = objectOf(record)
    const candidate = objectOf(object?.event) ?? object
    if (candidate === undefined || typeof candidate.type !== 'string' || typeof candidate.seq !== 'number') continue
    const block = traceFromEvent({
      type: candidate.type,
      seq: candidate.seq,
      time: typeof candidate.time === 'string' || typeof candidate.time === 'number' ? candidate.time : 0,
      data: candidate.data,
    })
    if (block !== undefined) result.push(block)
  }
  return result
}

function timeLabel(value: string | number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString('zh-CN', { hour12: false })
}

function traceTypeLabel(kind: TraceKind): string {
  if (kind === 'input') return '输入'
  if (kind === 'model') return '模型'
  return '工具'
}

function activityPreview(block: TraceBlock): string {
  if (block.kind !== 'tool' && block.label !== '') return clipped(block.label, 180)
  return clipped(block.detail, 180)
}

export function TrajectoryStrip({ blocks }: { blocks: TraceBlock[] }): React.ReactElement {
  const [selected, setSelected] = useState<TraceBlock | undefined>()
  const [activityOpen, setActivityOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!activityOpen) return
    const dismiss = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) !== true) {
        setActivityOpen(false)
        setSelected(undefined)
      }
    }
    const dismissWithKeyboard = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setActivityOpen(false)
      setSelected(undefined)
    }
    document.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', dismissWithKeyboard)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', dismissWithKeyboard)
    }
  }, [activityOpen])

  useEffect(() => {
    if (selected !== undefined && !blocks.some((block) => block.id === selected.id)) setSelected(undefined)
  }, [blocks, selected])

  useEffect(() => {
    if (!activityOpen) return
    requestAnimationFrame(() => {
      const scroll = scrollRef.current
      if (scroll !== null) scroll.scrollTop = scroll.scrollHeight
    })
  }, [activityOpen])

  return (
    <div className={`trajectory-strip ${activityOpen ? 'is-expanded' : ''}`} ref={rootRef}>
      <div className="trajectory-label">
        <Icon name="activity" size={13} />
        <span>轨迹</span>
      </div>
      <div className="trajectory-track">
        {blocks.map((block) => (
          <button
            aria-label={`查看 ${block.label} 事件`}
            className={`trace-block trace-${block.kind} ${selected?.id === block.id ? 'is-selected' : ''}`}
            key={block.id}
            onClick={() => {
              setActivityOpen(true)
              setSelected((current) => current?.id === block.id ? undefined : block)
            }}
            title={block.label}
            type="button"
          />
        ))}
      </div>
      {blocks.length > 0 && (
        <button
          aria-expanded={activityOpen}
          aria-haspopup="dialog"
          className={`trajectory-count ${activityOpen ? 'is-open' : ''}`}
          onClick={() => {
            setActivityOpen((current) => {
              if (current) setSelected(undefined)
              return !current
            })
          }}
          type="button"
        >
          <span className="trajectory-count-value">{blocks.length} 项</span>
          <span className="trajectory-count-action">{activityOpen ? '收起详情' : '展开详情'}</span>
        </button>
      )}
      {activityOpen && (
        <div aria-label="活动详情" className="trajectory-activity-panel" role="dialog">
          <div className="trajectory-activity-head">
            <div>
              <strong>活动详情</strong>
              <small>{blocks.length} 条会话事件</small>
            </div>
            <div className="trajectory-legend" aria-label="事件类型">
              <span><i className="trace-input" />输入</span>
              <span><i className="trace-model" />模型</span>
              <span><i className="trace-tool" />工具</span>
            </div>
            <button aria-label="关闭活动详情" onClick={() => { setActivityOpen(false); setSelected(undefined) }} type="button"><Icon name="close" size={14} /></button>
          </div>
          <div className="trajectory-activity-scroll" ref={scrollRef}>
            {blocks.map((block) => (
              <div className={`trajectory-activity-event ${selected?.id === block.id ? 'is-selected' : ''}`} key={block.id}>
                <button aria-expanded={selected?.id === block.id} onClick={() => setSelected((current) => current?.id === block.id ? undefined : block)} type="button">
                  <span className={`trajectory-event-type trace-${block.kind}`}>{traceTypeLabel(block.kind)}</span>
                  <span className="trajectory-event-copy">
                    <strong>{block.label}</strong>
                    <small>{activityPreview(block)}</small>
                  </span>
                  <span className="trajectory-event-meta">
                    <time>{timeLabel(block.time)}</time>
                    <small>{block.eventType} · #{block.seq}</small>
                  </span>
                  <Icon className="trajectory-event-chevron" name="chevron-down" size={12} />
                </button>
                {selected?.id === block.id && <pre>{block.detail}</pre>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
