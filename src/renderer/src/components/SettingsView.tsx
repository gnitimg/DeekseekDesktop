import { useEffect, useState } from 'react'
import { useApp } from '../store'
import { BrandMark, Icon } from './Icon'

type SettingsTab = 'general' | 'models' | 'plugins' | 'presets'

const tabs = [
  { id: 'general' as const, label: '通用设置', icon: 'settings' as const },
  { id: 'models' as const, label: '模型', icon: 'cache' as const },
  { id: 'plugins' as const, label: '插件', icon: 'grid' as const },
  { id: 'presets' as const, label: 'Agent 预设', icon: 'sparkles' as const },
]

const presets = [
  { id: 'standard', name: '标准模式', description: '完整编码 Agent，支持文件编辑、Shell、搜索、Skills、计划、目标与子代理。' },
  { id: 'code', name: 'PTC 模式', description: '通过 Code Mode SDK 组织多步骤操作，适合复杂工具编排。' },
  { id: 'minimal', name: '极简模式', description: '仅加载持久化、bash 与文本编辑器，启动更快、上下文更轻。' },
  { id: 'cordis', name: '创造模式', description: '用于创建自定义 Agent preset，并检查插件与运行时配置。' },
]

export function SettingsView(): React.ReactElement {
  const setView = useApp((state) => state.setView)
  const agentPreset = useApp((state) => state.agentPreset)
  const setAgentPreset = useApp((state) => state.setAgentPreset)
  const appearance = useApp((state) => state.appearance)
  const setAppearance = useApp((state) => state.setAppearance)
  const [tab, setTab] = useState<SettingsTab>('general')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    void window.desktop.settings.read()
      .then((env) => {
        setApiKey(env.DEEPSEEK_API_KEY ?? '')
        setBaseUrl(env.DEEPSEEK_BASE_URL ?? '')
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false))
  }, [])

  async function save(): Promise<void> {
    setSaving(true)
    setError(undefined)
    const env: Record<string, string> = {}
    if (apiKey.trim() !== '') env.DEEPSEEK_API_KEY = apiKey.trim()
    if (baseUrl.trim() !== '') env.DEEPSEEK_BASE_URL = baseUrl.trim()
    try {
      await window.desktop.settings.write(env)
      setSaved(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="surface-view settings-view">
      <section className="settings-window">
        <header className="settings-window-header titlebar-drag">
          <h1>设置</h1>
          <button aria-label="关闭设置" className="icon-button subtle titlebar-no-drag" onClick={() => setView('chat')} type="button"><Icon name="close" size={17} /></button>
        </header>
        <div className="settings-layout">
        <aside className="settings-nav">
          {tabs.map((item) => (
            <button className={tab === item.id ? 'is-active' : ''} key={item.id} onClick={() => setTab(item.id)} type="button">
              <Icon name={item.icon} size={17} />
              <span>{item.label}</span>
            </button>
          ))}
        </aside>

        <div className="settings-detail">
          {error !== undefined && <div className="notice notice-error"><span><Icon name="activity" size={16} /></span><p>{error}</p></div>}
          {tab === 'general' && (
            <SettingsPane eyebrow="GENERAL" title="通用设置" description="这些选项将用于之后创建的新会话，运行中的会话保持启动时的配置。">
              <div className="preference-list">
                <PreferenceRow title="Agent 预设" description="新任务默认加载的插件组合">
                  <button onClick={() => setTab('presets')} type="button">{presets.find((preset) => preset.id === agentPreset)?.name}<Icon name="chevron-right" size={14} /></button>
                </PreferenceRow>
                <PreferenceRow title="权限" description="工作目录内可读写，其他操作按需确认">
                  <span className="preference-pill">Workspace Write</span>
                </PreferenceRow>
                <PreferenceRow title="语言" description="界面与新任务默认交互语言">
                  <span className="preference-pill">中文</span>
                </PreferenceRow>
              </div>
              <div className="appearance-block">
                <span className="settings-subheading">外观</span>
                <div className="appearance-options">
                  <button className={appearance === 'light' ? 'is-selected' : ''} onClick={() => setAppearance('light')} type="button">
                    <span className="appearance-preview preview-light" /><strong>浅色</strong>
                  </button>
                  <button className={appearance === 'dark' ? 'is-selected' : ''} onClick={() => setAppearance('dark')} type="button">
                    <span className="appearance-preview preview-dark" /><strong>深色</strong>
                  </button>
                  <button className={appearance === 'system' ? 'is-selected' : ''} onClick={() => setAppearance('system')} type="button">
                    <span className="appearance-preview preview-system" /><strong>跟随系统</strong>
                  </button>
                </div>
              </div>
              <div className="preference-list">
                <PreferenceRow title="繁忙时 Enter 键行为" description="智能体运行期间，直接发送一条跟进指令">
                  <span className="preference-pill">插话发送</span>
                </PreferenceRow>
              </div>
            </SettingsPane>
          )}

          {tab === 'models' && (
            <SettingsPane eyebrow="MODEL PROVIDERS" title="模型" description="配置 DeepSeek 提供方。凭证保存在桌面应用自己的 dsh home 中。">
              <div className="settings-card provider-card">
                <div className="provider-heading">
                  <span className="provider-mark"><BrandMark size={34} /></span>
                  <div><strong>DeepSeek Official</strong><small>主模型路由 · 缓存优化</small></div>
                  <span className={`status-badge ${apiKey === '' ? 'is-muted' : ''}`}><i />{apiKey === '' ? '待配置' : '已配置'}</span>
                </div>
                <label className="field">
                  <span>API Key</span>
                  <input disabled={loading} onChange={(event) => { setApiKey(event.target.value); setSaved(false) }} placeholder="sk-…" type="password" value={apiKey} />
                </label>
                <label className="field">
                  <span>Base URL <small>可选</small></span>
                  <input disabled={loading} onChange={(event) => { setBaseUrl(event.target.value); setSaved(false) }} placeholder="https://api.deepseek.com" type="url" value={baseUrl} />
                </label>
                <div className="settings-card-actions">
                  {saved && <span className="saved-message"><Icon name="check" size={14} />已保存，重启后生效</span>}
                  <button className="button button-primary" disabled={loading || saving} onClick={() => void save()} type="button">{saving ? '保存中…' : '保存配置'}</button>
                </div>
              </div>
              <div className="provider-add-row">
                <button type="button"><Icon name="plus" size={16} />添加兼容提供方</button>
                <button type="button"><Icon name="plus" size={16} />添加自定义提供方</button>
              </div>
            </SettingsPane>
          )}

          {tab === 'plugins' && (
            <SettingsPane eyebrow="PLUGIN RUNTIME" title="插件" description="配置核心插件能力，并从社区目录安装新的 Harness 组件。">
              <div className="plugin-config-list">
                <PluginConfigRow icon="terminal" title="终端" description="限制 Agent 运行的每一条命令。" />
                <PluginConfigRow icon="activity" title="Agent 循环" description="控制模型、工具与后续步骤的派发。" />
                <PluginConfigRow icon="search" title="网页搜索" description="由 DeepSeek 搜索提供方处理联网检索。" />
                <PluginConfigRow icon="cache" title="缓存路由" description="稳定提示词前缀并保持高缓存命中。" />
              </div>
              <div className="settings-callout">
                <div><Icon name="grid" /><span><strong>社区插件市场</strong><small>发现并安装带有 dsh-plugin topic 的仓库。</small></span></div>
                <button className="button" onClick={() => setView('plugins')} type="button">打开市场<Icon name="chevron-right" size={14} /></button>
              </div>
            </SettingsPane>
          )}

          {tab === 'presets' && (
            <SettingsPane eyebrow="AGENT PRESETS" title="Agent 预设" description="预设定义一个会话运行的插件组合、工具、提示词与能力。">
              <span className="settings-subheading">内置</span>
              <div className="preset-grid">
                {presets.map((preset) => (
                  <button className={agentPreset === preset.id ? 'is-selected' : ''} key={preset.id} onClick={() => setAgentPreset(preset.id)} type="button">
                    <div className="preset-heading"><strong>{preset.name}</strong><span>内置</span>{agentPreset === preset.id && <small>当前使用</small>}</div>
                    <p>{preset.description}</p>
                    <code>{preset.id}</code>
                    <div className="preset-footer"><Icon name="layers" size={15} /><Icon name="command" size={15} /></div>
                  </button>
                ))}
              </div>
              <span className="settings-subheading custom-heading">自定义</span>
              <button className="create-preset" type="button"><Icon name="plus" size={17} />用「创造模式」创建自定义预设</button>
            </SettingsPane>
          )}
        </div>
        </div>
      </section>
    </div>
  )
}

function SettingsPane({ eyebrow, title, description, children }: {
  eyebrow: string
  title: string
  description: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className="settings-pane">
      <div className="settings-section-copy"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div>
      {children}
    </section>
  )
}

function PreferenceRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }): React.ReactElement {
  return <div className="preference-row"><div><strong>{title}</strong><small>{description}</small></div>{children}</div>
}

function PluginConfigRow({ icon, title, description }: { icon: 'terminal' | 'activity' | 'search' | 'cache'; title: string; description: string }): React.ReactElement {
  return (
    <button className="plugin-config-row" type="button">
      <span><Icon name={icon} size={17} /></span>
      <div><strong>{title}</strong><small>{description}</small></div>
      <span className="enabled-dot" />
      <Icon name="chevron-down" size={15} />
    </button>
  )
}
