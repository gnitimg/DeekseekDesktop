import { useEffect, useMemo, useRef, useState } from 'react'
import type { InstalledPlugin, PluginMutationResult, PluginRepo } from '../types'
import { Icon } from './Icon'

type Status = 'loading' | 'ready' | 'error'
type InstallState = 'idle' | 'installing' | 'installed' | 'failed'
type SortMode = 'stars' | 'name'
type PluginAction = 'enabling' | 'disabling' | 'removing'

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

function matchingInstalledPlugin(plugin: PluginRepo, installed: readonly InstalledPlugin[]): InstalledPlugin | undefined {
  const repository = plugin.full_name.toLowerCase()
  const repositoryName = plugin.name.toLowerCase()
  return installed.find((item) => item.repository === repository)
    ?? installed.find((item) => item.name.toLowerCase() === repositoryName)
    ?? installed.find((item) => item.spec.toLowerCase().includes(repository))
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
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>([])
  const [installedStatus, setInstalledStatus] = useState<Status>('loading')
  const [installedError, setInstalledError] = useState('')
  const [pluginAction, setPluginAction] = useState<{ name: string; action: PluginAction } | undefined>()
  const [pendingRemoval, setPendingRemoval] = useState<string | undefined>()
  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('stars')
  const [topic, setTopic] = useState('all')
  const [installStates, setInstallStates] = useState<Map<number, InstallState>>(new Map())
  const [installMessage, setInstallMessage] = useState<Map<number, string>>(new Map())

  const loadMarket = (): void => {
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

  const loadInstalled = (): void => {
    setInstalledStatus('loading')
    setInstalledError('')
    void window.desktop.plugins
      .installed()
      .then((items) => {
        setInstalledPlugins(items)
        setInstalledStatus('ready')
      })
      .catch((reason: unknown) => {
        setInstalledError(reason instanceof Error ? reason.message : String(reason))
        setInstalledStatus('error')
      })
  }

  const load = (): void => {
    loadMarket()
    loadInstalled()
  }

  useEffect(load, [])

  function synchronizeMutation(result: PluginMutationResult): void {
    setInstalledPlugins(result.plugins)
    setInstalledStatus('ready')
  }

  async function install(plugin: PluginRepo): Promise<void> {
    setInstallStates((previous) => new Map(previous).set(plugin.id, 'installing'))
    setInstallMessage((previous) => new Map(previous).set(plugin.id, ''))
    setInstalledError('')
    try {
      const result = await window.desktop.plugins.install(plugin.full_name)
      synchronizeMutation(result)
      setInstallStates((previous) => new Map(previous).set(plugin.id, 'installed'))
      setInstallMessage((previous) => new Map(previous).set(plugin.id, '已安装并重新加载 DSH，新的能力现在可以使用。'))
    } catch (reason) {
      setInstallStates((previous) => new Map(previous).set(plugin.id, 'failed'))
      setInstallMessage((previous) => new Map(previous).set(plugin.id, reason instanceof Error ? reason.message : String(reason)))
    }
  }

  async function changeEnabled(plugin: InstalledPlugin): Promise<void> {
    const enabled = !plugin.enabled
    setPluginAction({ name: plugin.name, action: enabled ? 'enabling' : 'disabling' })
    setInstalledError('')
    try {
      synchronizeMutation(await window.desktop.plugins.setEnabled(plugin.name, enabled))
    } catch (reason) {
      setInstalledError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPluginAction(undefined)
    }
  }

  async function removeInstalled(plugin: InstalledPlugin): Promise<void> {
    setPluginAction({ name: plugin.name, action: 'removing' })
    setInstalledError('')
    try {
      synchronizeMutation(await window.desktop.plugins.uninstall(plugin.name))
      setPendingRemoval(undefined)
      setInstallStates((previous) => {
        const next = new Map(previous)
        const marketPlugin = plugins.find((item) => matchingInstalledPlugin(item, [plugin]) !== undefined)
        if (marketPlugin !== undefined) next.delete(marketPlugin.id)
        return next
      })
    } catch (reason) {
      setInstalledError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPluginAction(undefined)
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

  const installationInProgress = [...installStates.values()].some((state) => state === 'installing')

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
        <section className="installed-plugin-section">
          <header className="installed-plugin-header">
            <div>
              <span className="eyebrow">WEB PROFILE</span>
              <h2>已安装插件</h2>
              <p>这些插件保存在 DSH web profile 中。启停或卸载后会自动重新加载运行时。</p>
            </div>
            <div>
              <span>{installedPlugins.length} 个</span>
              <button aria-label="刷新已安装插件" className={installedStatus === 'loading' ? 'icon-button is-loading' : 'icon-button'} disabled={installedStatus === 'loading' || pluginAction !== undefined} onClick={loadInstalled} type="button"><Icon name="refresh" size={16} /></button>
            </div>
          </header>

          {installedStatus === 'loading' && (
            <div className="installed-plugin-state"><span className="mini-spinner" />正在读取 web profile…</div>
          )}
          {installedStatus === 'ready' && installedPlugins.length === 0 && (
            <div className="installed-plugin-state is-empty"><span><Icon name="grid" size={18} /></span><div><strong>还没有安装插件</strong><small>从下方社区目录安装兼容的 DSH bundle。</small></div></div>
          )}
          {installedStatus === 'ready' && installedPlugins.length > 0 && (
            <div className="installed-plugin-list">
              {installedPlugins.map((plugin) => {
                const activeAction = pluginAction?.name === plugin.name ? pluginAction.action : undefined
                const confirmingRemoval = pendingRemoval === plugin.name
                return (
                  <div className="installed-plugin-row" key={plugin.name}>
                    <span className="installed-plugin-mark">{plugin.name.replace(/^@/u, '').slice(0, 1).toUpperCase()}</span>
                    <div className="installed-plugin-copy">
                      <div><strong>{plugin.name}</strong><code>{plugin.version}</code></div>
                      <small>{plugin.description ?? plugin.spec}</small>
                    </div>
                    <span className={plugin.compatible ? plugin.enabled ? 'installed-plugin-status is-enabled' : 'installed-plugin-status is-disabled' : 'installed-plugin-status is-incompatible'}>
                      {!plugin.compatible ? '不兼容' : plugin.enabled ? '已启用' : '已停用'}
                    </span>
                    {confirmingRemoval
                      ? <div className="plugin-remove-confirm">
                        <span>确认卸载？</span>
                        <button disabled={activeAction !== undefined} onClick={() => setPendingRemoval(undefined)} type="button">取消</button>
                        <button className="is-danger" disabled={activeAction !== undefined} onClick={() => void removeInstalled(plugin)} type="button">{activeAction === 'removing' ? '卸载中…' : '卸载'}</button>
                      </div>
                      : <div className="installed-plugin-actions">
                        <button className="plugin-enable-action" disabled={!plugin.compatible || pluginAction !== undefined} onClick={() => void changeEnabled(plugin)} type="button">
                          {activeAction === 'enabling' ? '启用中…' : activeAction === 'disabling' ? '停用中…' : plugin.enabled ? '停用' : '启用'}
                        </button>
                        <button aria-label={'卸载 ' + plugin.name} className="icon-button subtle" disabled={pluginAction !== undefined} onClick={() => setPendingRemoval(plugin.name)} type="button"><Icon name="trash" size={15} /></button>
                      </div>}
                  </div>
                )
              })}
            </div>
          )}
          {installedError !== '' && <div className="installed-plugin-error" role="alert"><Icon name="activity" size={15} /><span>{installedError}</span></div>}
        </section>

        <div className="market-directory-heading">
          <div><span className="eyebrow">COMMUNITY DIRECTORY</span><h2>发现插件</h2></div>
          <p>仅兼容并声明 DSH bundle 的仓库会被激活。</p>
        </div>
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
              const installedPlugin = matchingInstalledPlugin(plugin, installedPlugins)
              const effectiveInstallState: InstallState = installedPlugin === undefined ? installState : 'installed'
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
                    <div className={`install-message ${effectiveInstallState === 'failed' ? 'is-error' : ''}`}>
                      {effectiveInstallState === 'installed' && <Icon name="check" size={13} />}
                      <span>{message}</span>
                    </div>
                  )}
                  <div className="plugin-card-footer">
                    <span>{plugin.language ?? '多语言'}</span>
                    <button
                      className={`install-button is-${effectiveInstallState}`}
                      disabled={installationInProgress || pluginAction !== undefined || effectiveInstallState === 'installed'}
                      onClick={() => void install(plugin)}
                      type="button"
                    >
                      {effectiveInstallState === 'installing' && <span className="mini-spinner" />}
                      {effectiveInstallState === 'installed' && <Icon name="check" size={14} />}
                      {effectiveInstallState === 'installing' ? '安装中' : installedPlugin !== undefined ? installedPlugin.enabled ? '已启用' : '已安装' : effectiveInstallState === 'failed' ? '重试' : '安装'}
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
