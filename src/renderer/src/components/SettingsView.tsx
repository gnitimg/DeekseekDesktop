import { useCallback, useEffect, useState } from 'react'
import { dsh } from '../dsh-client'
import { useApp } from '../store'
import type { ProjectEnvironment } from '../types'
import { BrandMark, Icon } from './Icon'

type SettingsTab =
  | 'general' | 'appearance' | 'models' | 'presets'
  | 'plugins' | 'connections'
  | 'hooks' | 'git' | 'environment' | 'worktrees' | 'shortcuts'

const tabGroups = [
  {
    label: '基础',
    items: [
      { id: 'general', label: '通用设置', icon: 'settings' },
      { id: 'appearance', label: '外观', icon: 'monitor' },
      { id: 'models', label: '模型', icon: 'cache' },
      { id: 'presets', label: 'Agent 预设', icon: 'sparkles' },
    ],
  },
  {
    label: '集成',
    items: [
      { id: 'plugins', label: '插件', icon: 'grid' },
      { id: 'connections', label: '连接', icon: 'link' },
    ],
  },
  {
    label: '编码',
    items: [
      { id: 'hooks', label: '钩子', icon: 'command' },
      { id: 'git', label: 'Git', icon: 'branch' },
      { id: 'environment', label: '环境', icon: 'terminal' },
      { id: 'worktrees', label: 'Worktrees', icon: 'layers' },
      { id: 'shortcuts', label: '键盘快捷键', icon: 'keyboard' },
    ],
  },
] as const

const presets = [
  { id: 'standard', name: '标准模式', description: '完整编码 Agent，支持文件编辑、Shell、搜索、Skills、计划、目标与子代理。' },
  { id: 'code', name: 'PTC 模式', description: '通过 Code Mode SDK 组织多步骤操作，适合复杂工具编排。' },
  { id: 'minimal', name: '极简模式', description: '仅加载持久化、bash 与文本编辑器，启动更快、上下文更轻。' },
  { id: 'cordis', name: '创造模式', description: '用于创建自定义 Agent preset，并检查插件与运行时配置。' },
]

interface SshProfile {
  id: string
  name: string
  host: string
  user: string
  port: string
  identityFile: string
}

const SSH_PROFILES_KEY = 'deepseek-desktop:ssh-profiles'
const SETTINGS_TAB_KEY = 'deepseek-desktop:settings-tab'
const settingsTabIds: readonly SettingsTab[] = [
  'general', 'appearance', 'models', 'presets',
  'plugins', 'connections',
  'hooks', 'git', 'environment', 'worktrees', 'shortcuts',
]

function initialSettingsTab(): SettingsTab {
  const requested = localStorage.getItem(SETTINGS_TAB_KEY)
  localStorage.removeItem(SETTINGS_TAB_KEY)
  return settingsTabIds.some((id) => id === requested)
    ? requested as SettingsTab
    : 'general'
}

function readSshProfiles(): SshProfile[] {
  try {
    const value = JSON.parse(localStorage.getItem(SSH_PROFILES_KEY) ?? '[]') as unknown
    if (!Array.isArray(value)) return []
    return value.filter((item): item is SshProfile => {
      if (typeof item !== 'object' || item === null) return false
      const record = item as Record<string, unknown>
      return ['id', 'name', 'host', 'user', 'port', 'identityFile'].every((key) => typeof record[key] === 'string')
    })
  } catch {
    return []
  }
}

const emptySshDraft: Omit<SshProfile, 'id'> = { name: '', host: '', user: '', port: '22', identityFile: '' }

interface ViewTransitionHandle { ready: Promise<void> }

function resolvedAppearance(value: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  return value === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    : value
}

export function SettingsView(): React.ReactElement {
  const setView = useApp((state) => state.setView)
  const workspaceRoot = useApp((state) => state.workspaceRoot)
  const agentPreset = useApp((state) => state.agentPreset)
  const setAgentPreset = useApp((state) => state.setAgentPreset)
  const appearance = useApp((state) => state.appearance)
  const setAppearance = useApp((state) => state.setAppearance)
  const reconnectDsh = useApp((state) => state.reconnectDsh)
  const [tab, setTab] = useState<SettingsTab>(initialSettingsTab)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [desktopEnv, setDesktopEnv] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [fetchMessage, setFetchMessage] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [environment, setEnvironment] = useState<ProjectEnvironment | undefined>()
  const [environmentLoading, setEnvironmentLoading] = useState(false)
  const [sshProfiles, setSshProfiles] = useState<SshProfile[]>(readSshProfiles)
  const [sshDraft, setSshDraft] = useState(emptySshDraft)

  function changeAppearance(value: 'light' | 'dark' | 'system'): void {
    if (value === appearance) return
    const startViewTransition = (document as Document & {
      startViewTransition?: (callback: () => void) => ViewTransitionHandle
    }).startViewTransition
    if (startViewTransition === undefined || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setAppearance(value)
      return
    }
    const transition = startViewTransition.call(document, () => {
      document.documentElement.dataset.theme = resolvedAppearance(value)
      setAppearance(value)
    })
    void transition.ready.then(() => {
      const radius = Math.hypot(window.innerWidth, window.innerHeight)
      document.documentElement.animate(
        { clipPath: ['circle(0px at 0 0)', `circle(${String(radius)}px at 0 0)`] },
        { duration: 680, easing: 'cubic-bezier(.2,.78,.22,1)', pseudoElement: '::view-transition-new(root)' } as KeyframeAnimationOptions,
      )
    }).catch(() => {})
  }

  useEffect(() => {
    void window.desktop.settings.read()
      .then((env) => {
        setDesktopEnv(env)
        setApiKey(env.DEEPSEEK_API_KEY ?? '')
        setBaseUrl(env.DEEPSEEK_BASE_URL ?? '')
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false))
  }, [])

  const refreshEnvironment = useCallback(async (): Promise<void> => {
    if (workspaceRoot === undefined) {
      setEnvironment(undefined)
      return
    }
    setEnvironmentLoading(true)
    try {
      setEnvironment(await window.desktop.project.environment(workspaceRoot))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setEnvironmentLoading(false)
    }
  }, [workspaceRoot])

  useEffect(() => {
    if (tab === 'git' || tab === 'environment' || tab === 'worktrees') void refreshEnvironment()
  }, [tab, refreshEnvironment])

  async function save(): Promise<void> {
    setSaving(true)
    setError(undefined)
    const env: Record<string, string> = { ...desktopEnv }
    delete env.DEEPSEEK_API_KEY
    delete env.DEEPSEEK_BASE_URL
    if (apiKey.trim() !== '') env.DEEPSEEK_API_KEY = apiKey.trim()
    if (baseUrl.trim() !== '') env.DEEPSEEK_BASE_URL = baseUrl.trim()
    try {
      const url = await window.desktop.settings.write(env)
      setDesktopEnv(env)
      reconnectDsh(url)
      setSaved(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  async function fetchModels(): Promise<void> {
    if (apiKey.trim() === '' || baseUrl.trim() === '') {
      setError('请先填写 API Key 与 Base URL')
      return
    }
    setFetching(true)
    setError(undefined)
    setFetchMessage(undefined)
    try {
      const ids = await window.desktop.models.fetch(baseUrl.trim(), apiKey.trim())
      if (ids.length === 0) {
        setError('该 URL 未返回任何模型')
        return
      }
      const models = ids.map((id) => ({ id, name: id, contextWindow: 64000, maxTokens: 8192, inputModalities: ['text'] }))
      await dsh.updateDeepSeekModels(models)
      setFetchMessage(`已加载 ${String(ids.length)} 个模型，回到对话即可在下拉选择`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setFetching(false)
    }
  }

  function saveSshProfile(event: React.FormEvent): void {
    event.preventDefault()
    if (sshDraft.host.trim() === '' || sshDraft.user.trim() === '') {
      setError('SSH 连接需要填写主机与用户名')
      return
    }
    const profile: SshProfile = {
      ...sshDraft,
      id: globalThis.crypto.randomUUID(),
      name: sshDraft.name.trim() || sshDraft.host.trim(),
      host: sshDraft.host.trim(),
      user: sshDraft.user.trim(),
      port: sshDraft.port.trim() || '22',
      identityFile: sshDraft.identityFile.trim(),
    }
    const next = [...sshProfiles, profile]
    setSshProfiles(next)
    localStorage.setItem(SSH_PROFILES_KEY, JSON.stringify(next))
    setSshDraft(emptySshDraft)
    setError(undefined)
  }

  function removeSshProfile(id: string): void {
    const next = sshProfiles.filter((profile) => profile.id !== id)
    setSshProfiles(next)
    localStorage.setItem(SSH_PROFILES_KEY, JSON.stringify(next))
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
            {tabGroups.map((group) => (
              <div className="settings-nav-section" key={group.label}>
                <span>{group.label}</span>
                {group.items.map((item) => (
                  <button className={tab === item.id ? 'is-active' : ''} key={item.id} onClick={() => setTab(item.id)} type="button">
                    <Icon name={item.icon} size={17} />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </aside>

          <div className="settings-detail">
            {error !== undefined && <div className="notice notice-error"><span><Icon name="activity" size={16} /></span><p>{error}</p><button aria-label="关闭错误" onClick={() => setError(undefined)} type="button"><Icon name="close" size={14} /></button></div>}

            {tab === 'general' && (
              <SettingsPane eyebrow="GENERAL" title="通用设置" description="这些选项用于之后创建的新任务。">
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
                  <PreferenceRow title="繁忙时 Enter 键行为" description="智能体运行期间发送一条跟进指令">
                    <span className="preference-pill">插话发送</span>
                  </PreferenceRow>
                </div>
              </SettingsPane>
            )}

            {tab === 'appearance' && (
              <SettingsPane eyebrow="APPEARANCE" title="外观" description="选择应用主题。切换会从左上角平滑覆盖整个窗口。">
                <div className="appearance-options settings-appearance-grid">
                  <button className={appearance === 'system' ? 'is-selected' : ''} onClick={() => changeAppearance('system')} type="button">
                    <span className="appearance-preview preview-system" /><strong>系统</strong>
                  </button>
                  <button className={appearance === 'light' ? 'is-selected' : ''} onClick={() => changeAppearance('light')} type="button">
                    <span className="appearance-preview preview-light" /><strong>浅色</strong>
                  </button>
                  <button className={appearance === 'dark' ? 'is-selected' : ''} onClick={() => changeAppearance('dark')} type="button">
                    <span className="appearance-preview preview-dark" /><strong>深色</strong>
                  </button>
                </div>
              </SettingsPane>
            )}

            {tab === 'models' && (
              <SettingsPane eyebrow="MODEL PROVIDERS" title="模型" description="配置 DeepSeek 提供方。凭证保存在桌面应用的数据目录中。">
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
                    {saved && <span className="saved-message"><Icon name="check" size={14} />已保存并应用</span>}
                    {fetchMessage !== undefined && <span className="saved-message"><Icon name="check" size={14} />{fetchMessage}</span>}
                    <button className="button" disabled={fetching || apiKey.trim() === '' || baseUrl.trim() === ''} onClick={() => void fetchModels()} type="button">{fetching ? '拉取中…' : '拉取可用模型'}</button>
                    <button className="button button-primary" disabled={loading || saving} onClick={() => void save()} type="button">{saving ? '保存中…' : '保存配置'}</button>
                  </div>
                </div>
              </SettingsPane>
            )}

            {tab === 'plugins' && (
              <SettingsPane eyebrow="PLUGIN RUNTIME" title="插件" description="配置核心能力或从社区目录安装新的 Harness 组件。">
                <div className="plugin-config-list">
                  <PluginConfigRow icon="terminal" title="终端" description="限制 Agent 运行的每一条命令。" />
                  <PluginConfigRow icon="activity" title="Agent 循环" description="控制模型、工具与后续步骤的派发。" />
                  <PluginConfigRow icon="search" title="网页搜索" description="由 DeepSeek 搜索提供方处理联网检索。" />
                  <PluginConfigRow icon="cache" title="缓存路由" description="稳定提示词前缀并保持高缓存命中。" />
                </div>
                <div className="settings-callout">
                  <div><Icon name="grid" /><span><strong>社区插件市场</strong><small>浏览、筛选和安装社区插件。</small></span></div>
                  <button className="button" onClick={() => setView('plugins')} type="button">打开市场<Icon name="chevron-right" size={14} /></button>
                </div>
              </SettingsPane>
            )}

            {tab === 'presets' && (
              <SettingsPane eyebrow="AGENT PRESETS" title="Agent 预设" description="选择任务使用的插件组合、工具与运行方式。">
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
              </SettingsPane>
            )}

            {tab === 'connections' && (
              <SettingsPane eyebrow="CONNECTIONS" title="连接" description="管理远程开发连接。当前支持保存 SSH 连接定义。">
                {sshProfiles.length > 0 && <div className="settings-record-list ssh-profile-list">
                  {sshProfiles.map((profile) => (
                    <div className="settings-record-row" key={profile.id}>
                      <span className="record-icon"><Icon name="terminal" size={17} /></span>
                      <div><strong>{profile.name}</strong><small>{profile.user}@{profile.host}:{profile.port}{profile.identityFile === '' ? '' : ` · ${profile.identityFile}`}</small></div>
                      <span className="record-status">已保存</span>
                      <button aria-label={`移除 ${profile.name}`} className="icon-button subtle" onClick={() => removeSshProfile(profile.id)} type="button"><Icon name="trash" size={15} /></button>
                    </div>
                  ))}
                </div>}
                <form className="settings-card ssh-form" onSubmit={saveSshProfile}>
                  <div className="settings-card-title"><div><strong>添加 SSH 连接</strong><small>仅保存主机定义，不在未连接时显示在线状态。</small></div></div>
                  <div className="ssh-field-grid">
                    <label className="field"><span>名称 <small>可选</small></span><input onChange={(event) => setSshDraft({ ...sshDraft, name: event.target.value })} placeholder="开发服务器" value={sshDraft.name} /></label>
                    <label className="field"><span>主机</span><input onChange={(event) => setSshDraft({ ...sshDraft, host: event.target.value })} placeholder="192.168.1.10" value={sshDraft.host} /></label>
                    <label className="field"><span>用户名</span><input onChange={(event) => setSshDraft({ ...sshDraft, user: event.target.value })} placeholder="ubuntu" value={sshDraft.user} /></label>
                    <label className="field"><span>端口</span><input inputMode="numeric" onChange={(event) => setSshDraft({ ...sshDraft, port: event.target.value })} placeholder="22" value={sshDraft.port} /></label>
                    <label className="field ssh-identity-field"><span>私钥路径 <small>可选</small></span><input onChange={(event) => setSshDraft({ ...sshDraft, identityFile: event.target.value })} placeholder="C:\\Users\\name\\.ssh\\id_ed25519" value={sshDraft.identityFile} /></label>
                  </div>
                  <div className="settings-card-actions"><button className="button button-primary" type="submit">保存连接</button></div>
                </form>
              </SettingsPane>
            )}

            {tab === 'hooks' && (
              <SettingsPane eyebrow="HOOKS" title="钩子" description="钩子由 DSH 插件定义，并在对应生命周期运行。">
                <div className="preference-list hook-list">
                  <PreferenceRow title="任务开始前" description="在模型接收新任务前执行"><span className="preference-pill is-muted">未配置</span></PreferenceRow>
                  <PreferenceRow title="工具调用前" description="在 Shell、编辑或其他工具执行前运行"><span className="preference-pill is-muted">未配置</span></PreferenceRow>
                  <PreferenceRow title="工具调用后" description="工具返回结果后运行"><span className="preference-pill is-muted">未配置</span></PreferenceRow>
                  <PreferenceRow title="任务完成后" description="Agent 结束当前轮次后运行"><span className="preference-pill is-muted">未配置</span></PreferenceRow>
                </div>
                <div className="settings-inline-action"><span>安装或配置钩子插件后，状态会由 DSH 运行时接管。</span><button className="button" onClick={() => setTab('plugins')} type="button">查看插件</button></div>
              </SettingsPane>
            )}

            {tab === 'git' && (
              <SettingsPane eyebrow="GIT" title="Git" description="读取当前项目的仓库与工作区状态。">
                <EnvironmentToolbar loading={environmentLoading} onRefresh={() => void refreshEnvironment()} root={workspaceRoot} />
                {workspaceRoot === undefined ? <SettingsEmpty icon="folder" title="未选择项目" detail="打开一个项目后即可查看 Git 状态。" />
                  : environment?.isGit !== true ? <SettingsEmpty icon="branch" title="当前目录不是 Git 仓库" detail={workspaceRoot} />
                    : <>
                      <div className="settings-summary-grid">
                        <SummaryCard label="当前分支" value={environment.branch ?? 'HEAD'} />
                        <SummaryCard label="工作区" value={environment.changes.length === 0 ? '干净' : `${String(environment.changes.length)} 项变更`} />
                        <SummaryCard label="本地分支" value={String(environment.branches.length)} />
                      </div>
                      <div className="settings-record-list git-change-list">
                        {environment.changes.length === 0
                          ? <div className="settings-record-empty"><Icon name="check" size={17} />没有未提交变更</div>
                          : environment.changes.slice(0, 12).map((change) => <div className="settings-record-row" key={`${change.status}-${change.path}`}><code>{change.status}</code><div><strong>{change.path}</strong></div></div>)}
                      </div>
                    </>}
              </SettingsPane>
            )}

            {tab === 'environment' && (
              <SettingsPane eyebrow="ENVIRONMENT" title="环境" description="查看当前任务的本地执行环境。">
                <EnvironmentToolbar loading={environmentLoading} onRefresh={() => void refreshEnvironment()} root={workspaceRoot} />
                <div className="preference-list">
                  <PreferenceRow title="工作目录" description={workspaceRoot ?? '尚未选择项目'}><span className="preference-pill">{workspaceRoot === undefined ? '未设置' : '本地'}</span></PreferenceRow>
                  <PreferenceRow title="终端" description="使用项目目录启动独立 PowerShell 窗口"><button disabled={workspaceRoot === undefined} onClick={() => { if (workspaceRoot !== undefined) void window.desktop.project.openTerminal(workspaceRoot) }} type="button">打开终端<Icon name="external" size={14} /></button></PreferenceRow>
                  <PreferenceRow title="Git 仓库" description={environment?.isGit === true ? `分支 ${environment.branch ?? 'HEAD'}` : '当前目录未检测到仓库'}><span className="preference-pill">{environment?.isGit === true ? '已检测' : '无'}</span></PreferenceRow>
                </div>
              </SettingsPane>
            )}

            {tab === 'worktrees' && (
              <SettingsPane eyebrow="WORKTREES" title="Worktrees" description="查看当前仓库已存在的 Git worktree。">
                <EnvironmentToolbar loading={environmentLoading} onRefresh={() => void refreshEnvironment()} root={workspaceRoot} />
                {environment?.isGit !== true ? <SettingsEmpty icon="layers" title="没有可用的 Worktree 信息" detail="请先打开一个 Git 项目。" />
                  : <div className="settings-record-list worktree-list">
                    {environment.worktrees.map((worktree) => (
                      <div className="settings-record-row" key={worktree.path}>
                        <span className="record-icon"><Icon name="branch" size={16} /></span>
                        <div><strong>{worktree.branch ?? 'detached HEAD'}</strong><small>{worktree.path}</small></div>
                        {worktree.head !== undefined && <code>{worktree.head}</code>}
                      </div>
                    ))}
                  </div>}
              </SettingsPane>
            )}

            {tab === 'shortcuts' && (
              <SettingsPane eyebrow="KEYBOARD" title="键盘快捷键" description="当前可用的桌面操作快捷键。">
                <div className="shortcut-list">
                  <ShortcutRow keys={['Ctrl', 'N']} label="新建任务" />
                  <ShortcutRow keys={['Ctrl', 'K']} label="搜索任务" />
                  <ShortcutRow keys={['Enter']} label="发送消息" />
                  <ShortcutRow keys={['Shift', 'Enter']} label="消息内换行" />
                  <ShortcutRow keys={['Esc']} label="关闭菜单或浮层" />
                </div>
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
  return <section className="settings-pane"><div className="settings-section-copy"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div>{children}</section>
}

function PreferenceRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }): React.ReactElement {
  return <div className="preference-row"><div><strong>{title}</strong><small>{description}</small></div>{children}</div>
}

function PluginConfigRow({ icon, title, description }: { icon: 'terminal' | 'activity' | 'search' | 'cache'; title: string; description: string }): React.ReactElement {
  return <div className="plugin-config-row"><span><Icon name={icon} size={17} /></span><div><strong>{title}</strong><small>{description}</small></div><span className="enabled-dot" /><span className="plugin-config-status">已启用</span></div>
}

function EnvironmentToolbar({ root, loading, onRefresh }: { root: string | undefined; loading: boolean; onRefresh: () => void }): React.ReactElement {
  return <div className="environment-toolbar"><div><Icon name="folder" size={16} /><span>{root ?? '未选择项目'}</span></div><button aria-label="刷新项目状态" className={loading ? 'is-loading' : ''} disabled={root === undefined || loading} onClick={onRefresh} type="button"><Icon name="refresh" size={15} />刷新</button></div>
}

function SummaryCard({ label, value }: { label: string; value: string }): React.ReactElement {
  return <div className="settings-summary-card"><span>{label}</span><strong>{value}</strong></div>
}

function SettingsEmpty({ icon, title, detail }: { icon: 'folder' | 'branch' | 'layers'; title: string; detail: string }): React.ReactElement {
  return <div className="settings-empty"><span><Icon name={icon} size={20} /></span><strong>{title}</strong><small>{detail}</small></div>
}

function ShortcutRow({ label, keys }: { label: string; keys: string[] }): React.ReactElement {
  return <div className="shortcut-row"><span>{label}</span><div>{keys.map((key) => <kbd key={key}>{key}</kbd>)}</div></div>
}
