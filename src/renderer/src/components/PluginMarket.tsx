import { useEffect, useMemo, useRef, useState } from 'react'
import type { PluginRepo } from '../types'
import { Icon } from './Icon'

type Status = 'loading' | 'ready' | 'error'
type InstallState = 'idle' | 'installing' | 'installed' | 'failed'
type SortMode = 'stars' | 'name'

interface MarketOption {
  value: string
  label: string
}

interface MarketSelectProps {
  ariaLabel: string
  icon: 'activity' | 'layers'
  onChange: (value: string) => void
  options: MarketOption[]
  value: string
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function MarketSelect({ ariaLabel, icon, onChange, options, value }: MarketSelectProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className={`market-select ${open ? 'is-open' : ''}`} ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="market-select-trigger"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <Icon name={icon} size={14} />
        <span>{selected?.label}</span>
        <Icon className="market-select-chevron" name="chevron-down" size={13} />
      </button>
      <div aria-hidden={!open} aria-label={ariaLabel} className={`market-select-menu ${open ? 'is-open' : ''}`} role="listbox">
          {options.map((option) => (
            <button
              aria-selected={option.value === value}
              className={`market-select-option ${option.value === value ? 'is-selected' : ''}`}
              key={option.value}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
              role="option"
              type="button"
            >
              <span>{option.label}</span>
              {option.value === value && <Icon name="check" size={14} />}
            </button>
          ))}
      </div>
    </div>
  )
}

export function PluginMarket(): React.ReactElement {
  const [plugins, setPlugins] = useState<PluginRepo[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('stars')
  const [topic, setTopic] = useState('all')
  const [installStates, setInstallStates] = useState<Map<number, InstallState>>(new Map())
  const [installMessage, setInstallMessage] = useState<Map<number, string>>(new Map())

  const load = (): void => {
    setStatus('loading')
    setError('')
    void window.desktop.plugins
      .list()
      .then((data) => {
        setPlugins(data.items)
        setTotal(data.total_count)
        setStatus('ready')
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
        setStatus('error')
      })
  }

  useEffect(load, [])

  async function install(plugin: PluginRepo): Promise<void> {
    setInstallStates((previous) => new Map(previous).set(plugin.id, 'installing'))
    setInstallMessage((previous) => new Map(previous).set(plugin.id, ''))
    try {
      const output = await window.desktop.plugins.install(plugin.full_name)
      setInstallStates((previous) => new Map(previous).set(plugin.id, 'installed'))
      setInstallMessage((previous) => new Map(previous).set(plugin.id, output.trim().slice(-200)))
    } catch (reason) {
      setInstallStates((previous) => new Map(previous).set(plugin.id, 'failed'))
      setInstallMessage((previous) => new Map(previous).set(plugin.id, reason instanceof Error ? reason.message : String(reason)))
    }
  }

  const topics = useMemo(() => {
    const counts = new Map<string, number>()
    for (const plugin of plugins) {
      for (const item of plugin.topics ?? []) {
        if (item === 'dsh-plugin') continue
        counts.set(item, (counts.get(item) ?? 0) + 1)
      }
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 16)
  }, [plugins])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    const matches = plugins.filter((plugin) => {
      const matchesTopic = topic === 'all' || plugin.topics?.includes(topic) === true
      if (!matchesTopic) return false
      if (normalized === '') return true
      return plugin.name.toLocaleLowerCase().includes(normalized)
        || plugin.owner.login.toLocaleLowerCase().includes(normalized)
        || plugin.description?.toLocaleLowerCase().includes(normalized) === true
        || plugin.topics?.some((item) => item.toLocaleLowerCase().includes(normalized)) === true
    })
    return matches.sort((left, right) => sortMode === 'stars'
      ? right.stargazers_count - left.stargazers_count
      : left.name.localeCompare(right.name))
  }, [plugins, query, sortMode, topic])

  return (
    <div className="surface-view plugin-view">
      <header className="surface-header titlebar-drag">
        <div className="surface-heading">
          <span className="eyebrow">EVERYTHING IS A PLUGIN</span>
          <h1>插件市场</h1>
        </div>
        <div className="header-actions titlebar-no-drag">
          <span className="market-count">{compactNumber(total)} 个社区插件</span>
          <button aria-label="刷新插件" className="icon-button" onClick={load} type="button"><Icon name="refresh" size={16} /></button>
        </div>
      </header>

      <div className="plugin-canvas">
        <div className="market-toolbar">
          <div className="market-search">
            <Icon name="search" size={17} />
            <input onChange={(event) => setQuery(event.target.value)} placeholder="搜索插件、作者或能力…" value={query} />
            {query !== '' && <button aria-label="清除搜索" onClick={() => setQuery('')} type="button"><Icon name="close" size={14} /></button>}
          </div>
          <div className="market-controls">
            <MarketSelect
              ariaLabel="插件排序方式"
              icon="activity"
              onChange={(value) => setSortMode(value as SortMode)}
              options={[{ value: 'stars', label: '按 Star 数' }, { value: 'name', label: '按名称' }]}
              value={sortMode}
            />
            <MarketSelect
              ariaLabel="按标签筛选插件"
              icon="layers"
              onChange={setTopic}
              options={[{ value: 'all', label: '全部标签' }, ...topics.map(([item, count]) => ({ value: item, label: `${item} (${count})` }))]}
              value={topic}
            />
          </div>
        </div>

        {status === 'loading' && (
          <div className="plugin-grid">
            {Array.from({ length: 6 }, (_, index) => <div className="plugin-skeleton" key={index}><span /><span /><span /></div>)}
          </div>
        )}
        {status === 'error' && (
          <div className="market-empty">
            <span className="market-empty-icon"><Icon name="activity" /></span>
            <h3>无法载入社区目录</h3>
            <p>{error}</p>
            <button className="button" onClick={load} type="button"><Icon name="refresh" size={15} />重试</button>
          </div>
        )}
        {status === 'ready' && filtered.length === 0 && (
          <div className="market-empty"><span className="market-empty-icon"><Icon name="search" /></span><h3>没有找到匹配插件</h3><p>试试更短的关键词。</p></div>
        )}
        {status === 'ready' && filtered.length > 0 && (
          <div className="plugin-grid">
            {filtered.map((plugin) => {
              const installState = installStates.get(plugin.id) ?? 'idle'
              const message = installMessage.get(plugin.id) ?? ''
              return (
                <article className="plugin-card" key={plugin.id}>
                  <div className="plugin-card-top">
                    <img alt="" loading="lazy" src={plugin.owner.avatar_url} />
                    <div className="plugin-identity">
                      <a href={plugin.html_url} rel="noreferrer" target="_blank">{plugin.name}<Icon name="external" size={13} /></a>
                      <span>by {plugin.owner.login}</span>
                    </div>
                    <span className="plugin-stars">★ {compactNumber(plugin.stargazers_count)}</span>
                  </div>
                  <p className="plugin-description">{plugin.description ?? '这个插件还没有提供描述。'}</p>
                  <div className="plugin-tags">
                    {(plugin.topics ?? []).filter((topic) => topic !== 'dsh-plugin').slice(0, 3).map((topic) => <span key={topic}>{topic}</span>)}
                  </div>
                  {message !== '' && (
                    <div className={`install-message ${installState === 'failed' ? 'is-error' : ''}`}>
                      {installState === 'installed' && <Icon name="check" size={13} />}
                      <span>{message}</span>
                    </div>
                  )}
                  <div className="plugin-card-footer">
                    <span>{plugin.language ?? '多语言'}</span>
                    <button
                      className={`install-button is-${installState}`}
                      disabled={installState === 'installing' || installState === 'installed'}
                      onClick={() => void install(plugin)}
                      type="button"
                    >
                      {installState === 'installing' && <span className="mini-spinner" />}
                      {installState === 'installed' && <Icon name="check" size={14} />}
                      {installState === 'installing' ? '安装中' : installState === 'installed' ? '已安装' : installState === 'failed' ? '重试' : '安装'}
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
