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

export function TrajectoryStrip({ blocks }: { blocks: TraceBlock[] }): React.ReactElement {
  const [selected, setSelected] = useState<TraceBlock | undefined>()
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (selected === undefined) return
    const dismiss = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) !== true) setSelected(undefined)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [selected])

  useEffect(() => {
    if (selected !== undefined && !blocks.some((block) => block.id === selected.id)) setSelected(undefined)
  }, [blocks, selected])

  return (
    <div className={`trajectory-strip ${selected === undefined ? '' : 'is-expanded'}`} ref={rootRef}>
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
            onClick={() => setSelected((current) => current?.id === block.id ? undefined : block)}
            title={block.label}
            type="button"
          />
        ))}
      </div>
      {blocks.length > 0 && <span className="trajectory-count">{blocks.length} 项</span>}
      {selected !== undefined && (
        <div className="trajectory-popover">
          <div className="trajectory-popover-head">
            <span className={`trace-type trace-${selected.kind}`}>{selected.kind === 'input' ? 'INPUT' : selected.kind === 'model' ? 'MODEL' : 'TOOL'}</span>
            <div><strong>{selected.label}</strong><small>{selected.eventType}</small></div>
            <button aria-label="关闭轨迹详情" onClick={() => setSelected(undefined)} type="button"><Icon name="close" size={15} /></button>
          </div>
          <div className="trajectory-meta">
            <span>SEQ <b>{selected.seq}</b></span>
            <span>TIME <b>{timeLabel(selected.time)}</b></span>
          </div>
          <pre>{selected.detail}</pre>
        </div>
      )}
    </div>
  )
}
