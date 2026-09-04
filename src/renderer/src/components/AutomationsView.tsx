import { useEffect, useMemo, useState } from 'react'
import { dsh } from '../dsh-client'
import { useApp, type DesktopSession } from '../store'
import type { ScheduleRecord } from '../types'
import { Icon } from './Icon'

type ScheduleKind = 'after' | 'at' | 'every'

const templates = [
  { icon: 'activity' as const, title: '回归守望', body: '每天提醒 Agent 运行测试，并整理最小复现。', prompt: '运行项目回归测试；若失败，整理最小复现与建议修复。', kind: 'every' as const, minutes: 86_400 / 60 },
  { icon: 'archive' as const, title: '发布简报', body: '每周汇总变更、CI 状态与待处理风险。', prompt: '汇总本周变更、CI 状态与仍需处理的风险，生成发布简报。', kind: 'every' as const, minutes: 7 * 86_400 / 60 },
  { icon: 'sparkles' as const, title: '插件巡检', body: '稍后检查插件更新和潜在兼容性变化。', prompt: '检查已安装插件的更新与兼容性变化，并列出建议操作。', kind: 'after' as const, minutes: 60 },
]

interface AutomationItem { session: DesktopSession, record: ScheduleRecord }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isScheduleRecord(value: unknown): value is ScheduleRecord {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.prompt !== 'string'
    || typeof value.scheduledAt !== 'string') return false
  if (value.kind === 'at') return true
  if (value.kind === 'after') return typeof value.afterSeconds === 'number'
  return value.kind === 'every' && typeof value.everySeconds === 'number'
}

function localTarget(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).format(date)
}

function frequency(record: ScheduleRecord): string {
  if (record.kind === 'at') return '单次 · 指定时间'
  if (record.kind === 'after') return `单次 · ${formatDuration(record.afterSeconds)} 后`
  return `每 ${formatDuration(record.everySeconds)}`
}

function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${String(seconds / 86_400)} 天`
  if (seconds % 3_600 === 0) return `${String(seconds / 3_600)} 小时`
  if (seconds % 60 === 0) return `${String(seconds / 60)} 分钟`
  return `${String(seconds)} 秒`
}

export function AutomationsView(): React.ReactElement {
  const sessions = useApp((state) => state.sessions)
  const projectionBaselines = useApp((state) => state.projectionBaselines)
  const controlError = useApp((state) => state.controlError)
  const patchSession = useApp((state) => state.patchSession)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [kind, setKind] = useState<ScheduleKind>('after')
  const [sessionId, setSessionId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [minutes, setMinutes] = useState(30)
  const [target, setTarget] = useState(localTarget)
  const [submitting, setSubmitting] = useState(false)
  const [busyId, setBusyId] = useState<string | undefined>()
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | undefined>()
  const [feedback, setFeedback] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()

  const automations = useMemo<AutomationItem[]>(() => sessions.flatMap((session) => {
    const projected = projectionBaselines[session.id]?.values.schedule
    if (!Array.isArray(projected)) return []
    return projected.filter(isScheduleRecord).map((record) => ({ session, record }))
  }).sort((left, right) => Date.parse(left.record.scheduledAt) - Date.parse(right.record.scheduledAt)), [projectionBaselines, sessions])

  useEffect(() => {
    if (sessionId === '' && sessions[0] !== undefined) setSessionId(sessions[0].id)
  }, [sessionId, sessions])

  useEffect(() => {
    if (!dialogOpen) return
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') setDialogOpen(false) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [dialogOpen])

  function openComposer(template?: typeof templates[number]): void {
    setError(undefined)
    setFeedback(undefined)
    if (template !== undefined) {
      setPrompt(template.prompt)
      setKind(template.kind)
      setMinutes(template.minutes)
    }
    setDialogOpen(true)
  }

  async function createAutomation(): Promise<void> {
    const text = prompt.trim()
    if (sessionId === '' || text === '') {
      setError('请选择会话并填写任务内容。')
      return
    }
    let selector: Record<string, unknown>
    if (kind === 'at') {
      const [date, time] = target.split('T')
      if (date === undefined || time === undefined || new Date(target).getTime() <= Date.now()) {
        setError('请选择一个未来时间。')
        return
      }
      selector = { at: { date, time: `${time}:00`, time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone } }
    } else {
      const seconds = Math.round(minutes * 60)
      if (!Number.isSafeInteger(seconds) || seconds <= 0 || (kind === 'every' && seconds < 300)) {
        setError(kind === 'every' ? '循环间隔至少为 5 分钟。' : '延迟时间必须大于 0。')
        return
      }
      selector = kind === 'every' ? { every_seconds: seconds } : { after_seconds: seconds }
    }
    const args = { prompt: text, ...selector }
    setSubmitting(true)
    setError(undefined)
    try {
      await dsh.prompt({
        requestId: crypto.randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{
          type: 'text',
          text: `请立即调用 schedule_create 工具，不要只解释。使用以下精确 JSON 参数：\n${JSON.stringify(args)}\n工具成功后只用一句中文确认。`,
        }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      patchSession(sessionId, { running: true, blank: false, updatedAt: Date.now() })
      setDialogOpen(false)
      setPrompt('')
      setFeedback('创建指令已交给 Agent，执行成功后会自动出现在这里。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSubmitting(false)
    }
  }

  async function deleteAutomation(item: AutomationItem): Promise<void> {
    const key = `${item.session.id}:${item.record.id}`
    if (confirmDeleteId !== key) {
      setConfirmDeleteId(key)
      return
    }
    setBusyId(key)
    setError(undefined)
    try {
      await dsh.prompt({
        requestId: crypto.randomUUID(),
        sessionId: item.session.id,
        mode: 'queue',
        content: [{
          type: 'text',
          text: `请立即调用 schedule_delete 工具删除计划，不要只解释。精确参数：${JSON.stringify({ id: item.record.id })}。完成后只用一句中文确认。`,
        }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      patchSession(item.session.id, { running: true, updatedAt: Date.now() })
      setFeedback('删除指令已提交；Agent 完成后目录会实时更新。')
      setConfirmDeleteId(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyId(undefined)
    }
  }

  return (
    <div className="surface-view automation-view">
      <header className="surface-header titlebar-drag">
        <div className="surface-heading">
          <span className="eyebrow">HARNESS SCHEDULE</span>
          <h1>自动化 <span className="market-count">{automations.length}</span></h1>
        </div>
        <button className="button button-primary titlebar-no-drag" disabled={sessions.length === 0} onClick={() => openComposer()} type="button">
          <Icon name="plus" size={16} />新建自动化
        </button>
      </header>
      <div className="automation-canvas">
        {(controlError !== undefined || error !== undefined) && <div className="notice notice-error automation-notice"><span><Icon name="activity" size={16} /></span><p>{error ?? controlError}</p></div>}
        {feedback !== undefined && <div className="notice automation-notice"><span><Icon name="check" size={16} /></span><p>{feedback}</p><button onClick={() => setFeedback(undefined)} type="button"><Icon name="close" size={14} /></button></div>}
        {automations.length === 0 ? (
          <>
            <h2 className="automation-section-title">常用模板</h2>
            <div className="automation-grid">
              {templates.map((item) => (
                <button className="automation-card" key={item.title} onClick={() => openComposer(item)} type="button">
                  <span className="automation-icon"><Icon name={item.icon} /></span><h3>{item.title}</h3><p>{item.body}</p><span className="automation-state">使用模板 <Icon name="arrow-up" size={11} /></span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="automation-catalog">
            <div className="automation-catalog-heading"><div><h2>计划任务</h2></div></div>
            <div className="automation-list">
              {automations.map((item) => {
                const key = `${item.session.id}:${item.record.id}`
                const overdue = Date.parse(item.record.scheduledAt) <= Date.now()
                return (
                  <article className={`automation-row ${overdue ? 'is-overdue' : ''}`} key={key}>
                    <div className="automation-time"><span>{formatDate(item.record.scheduledAt)}</span><small>{overdue ? '等待会话恢复' : frequency(item.record)}</small></div>
                    <div className="automation-row-copy"><strong>{item.record.prompt}</strong><span><Icon name="folder" size={13} />{item.session.title}<code>{item.record.id}</code></span></div>
                    <span className="automation-live-state"><i />{overdue ? '逾期' : '已计划'}</span>
                    <button className={`automation-delete ${confirmDeleteId === key ? 'is-confirming' : ''}`} disabled={busyId !== undefined} onClick={() => void deleteAutomation(item)} type="button">
                      {busyId === key ? '提交中…' : confirmDeleteId === key ? '确认删除' : '删除'}
                    </button>
                  </article>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {dialogOpen && (
        <div className="automation-dialog-backdrop" onPointerDown={() => setDialogOpen(false)}>
          <section aria-labelledby="automation-dialog-title" aria-modal="true" className="automation-dialog" onPointerDown={(event) => event.stopPropagation()} role="dialog">
            <div className="automation-dialog-head"><div><span className="eyebrow">SCHEDULE_CREATE</span><h2 id="automation-dialog-title">新建自动化</h2></div><button aria-label="关闭" onClick={() => setDialogOpen(false)} type="button"><Icon name="close" /></button></div>
            <label className="automation-field"><span>运行会话</span><select onChange={(event) => setSessionId(event.target.value)} value={sessionId}>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}</select><small>提醒只会在这个会话存活时按时派发。</small></label>
            <label className="automation-field"><span>任务内容</span><textarea autoFocus onChange={(event) => setPrompt(event.target.value)} placeholder="例如：检查主分支的构建状态并汇总失败原因" rows={4} value={prompt} /></label>
            <div className="automation-field"><span>触发方式</span><div className="schedule-kind-switch">{(['after', 'at', 'every'] as const).map((value) => <button className={kind === value ? 'is-active' : ''} key={value} onClick={() => setKind(value)} type="button">{value === 'after' ? '稍后一次' : value === 'at' ? '指定时间' : '循环执行'}</button>)}</div></div>
            {kind === 'at' ? <label className="automation-field"><span>执行时间</span><input min={localTarget()} onChange={(event) => setTarget(event.target.value)} type="datetime-local" value={target} /></label> : <label className="automation-field"><span>{kind === 'every' ? '循环间隔' : '等待时长'}（分钟）</span><input min={kind === 'every' ? 5 : 1} onChange={(event) => setMinutes(Number(event.target.value))} type="number" value={minutes} /></label>}
            {error !== undefined && <p className="automation-form-error">{error}</p>}
            <div className="automation-dialog-actions"><button className="button" onClick={() => setDialogOpen(false)} type="button">取消</button><button className="button button-primary" disabled={submitting || sessions.length === 0} onClick={() => void createAutomation()} type="button">{submitting ? '正在提交…' : '交给 Agent 创建'}</button></div>
          </section>
        </div>
      )}
    </div>
  )
}
