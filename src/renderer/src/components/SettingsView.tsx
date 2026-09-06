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
const GIT_SETTINGS_KEY = 'deepseek-desktop:git-settings'
const WORKTREE_SETTINGS_KEY = 'deepseek-desktop:worktree-settings'
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

const emptySshDraft: Omit<SshProfile, 'id'> = { name: '', host: '', user: '', port: '', identityFile: '' }

interface GitSettings {
  branchPrefix: string
  mergeMethod: 'merge' | 'squash'
  forceWithLease: boolean
  draftPullRequests: boolean
  reviewPresentation: 'inline' | 'separate'
  autoMergeWhenReady: boolean
  monitorInstructions: string
  commitInstructions: string
  pullRequestInstructions: string
}

interface WorktreeSettings {
  rootDirectory: string
  fetchBeforeCreate: boolean
  autoDeleteOld: boolean
  retentionLimit: number
}

const defaultGitSettings: GitSettings = {
  branchPrefix: 'codex/',
  mergeMethod: 'merge',
  forceWithLease: false,
  draftPullRequests: true,
  reviewPresentation: 'inline',
  autoMergeWhenReady: false,
  monitorInstructions: '',
  commitInstructions: '',
  pullRequestInstructions: '',
}

const defaultWorktreeSettings: WorktreeSettings = {
  rootDirectory: '',
  fetchBeforeCreate: false,
  autoDeleteOld: true,
  retentionLimit: 15,
}

function readStoredSettings<T extends object>(key: string, fallback: T): T {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { ...fallback, ...value as Partial<T> }
      : fallback
  } catch {
    return fallback
  }
}

interface ViewTransitionHandle { ready: Promise<void> }

function resolvedAppearance(value: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  return value === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    : value
}

function comparableModelId(value: string): string {
  return (value.split('/').at(-1) ?? value).toLowerCase().replace(/[^a-z0-9]+/gu, '')
}

function matchingModelId(ids: readonly string[], selected: string): string | undefined {
  return ids.find((id) => id === selected)
    ?? ids.find((id) => comparableModelId(id) === comparableModelId(selected))
}

export function SettingsView(): React.ReactElement {
  const setView = useApp((state) => state.setView)
  const workspaceRoot = useApp((state) => state.workspaceRoot)
  const agentPreset = useApp((state) => state.agentPreset)
  const setAgentPreset = useApp((state) => state.setAgentPreset)
  const appearance = useApp((state) => state.appearance)
  const setAppearance = useApp((state) => state.setAppearance)
  const activeSessionId = useApp((state) => state.activeSessionId)
  const sessions = useApp((state) => state.sessions)
  const patchSession = useApp((state) => state.patchSession)
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
  const [sshDialogOpen, setSshDialogOpen] = useState(false)
  const [sshAuthentication, setSshAuthentication] = useState<'agent' | 'identity'>('agent')
  const [gitSettings, setGitSettings] = useState<GitSettings>(() => readStoredSettings(GIT_SETTINGS_KEY, defaultGitSettings))
  const [worktreeSettings, setWorktreeSettings] = useState<WorktreeSettings>(() => readStoredSettings(WORKTREE_SETTINGS_KEY, defaultWorktreeSettings))

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

  useEffect(() => {
    localStorage.setItem(GIT_SETTINGS_KEY, JSON.stringify(gitSettings))
  }, [gitSettings])

  useEffect(() => {
    localStorage.setItem(WORKTREE_SETTINGS_KEY, JSON.stringify(worktreeSettings))
  }, [worktreeSettings])

  async function save(): Promise<void> {
    setSaving(true)
    setError(undefined)
    const env: Record<string, string> = { ...desktopEnv }
    delete env.DEEPSEEK_API_KEY
    delete env.DEEPSEEK_BASE_URL
    if (apiKey.trim() !== '') env.DEEPSEEK_API_KEY = apiKey.trim()
    if (baseUrl.trim() !== '') env.DEEPSEEK_BASE_URL = baseUrl.trim()
    try {
      await window.desktop.settings.write(env)
      setDesktopEnv(env)
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
      const catalog = await dsh.modelCatalog()
      const activeSelection = sessions.find((session) => session.id === activeSessionId)?.selectedModel
      const current = activeSelection ?? catalog.default
      const matched = matchingModelId(ids, current.model)
      if (activeSessionId !== undefined && current.provider === 'deepseek-official' && matched !== undefined && matched !== current.model) {
        const accepted = await dsh.selectModel({
          sessionId: activeSessionId,
          provider: current.provider,
          model: matched,
        })
        patchSession(activeSessionId, { selectedModel: accepted.selected })
        setFetchMessage(`已加载 ${String(ids.length)} 个模型，并将当前模型匹配为 ${accepted.selected.model}`)
      } else {
        setFetchMessage(`已加载 ${String(ids.length)} 个模型，回到对话即可在下拉选择`)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setFetching(false)
    }
  }

  function saveSshProfile(event: React.FormEvent): void {
    event.preventDefault()
    const address = sshDraft.host.trim()
    if (address === '') {
      setError('SSH 连接需要填写主机名')
      return
    }
    if (sshAuthentication === 'identity' && sshDraft.identityFile.trim() === '') {
      setError('使用身份文件时需要填写私钥路径')
      return
    }
    const separator = address.lastIndexOf('@')
    const user = separator > 0 ? address.slice(0, separator) : ''
    const host = separator > 0 ? address.slice(separator + 1) : address
    const profile: SshProfile = {
      ...sshDraft,
      id: globalThis.crypto.randomUUID(),
      name: sshDraft.name.trim() || host,
      host,
      user,
      port: sshDraft.port.trim() || '22',
      identityFile: sshAuthentication === 'identity' ? sshDraft.identityFile.trim() : '',
    }
    const next = [...sshProfiles, profile]
    setSshProfiles(next)
    localStorage.setItem(SSH_PROFILES_KEY, JSON.stringify(next))
    setSshDraft(emptySshDraft)
    setSshAuthentication('agent')
    setSshDialogOpen(false)
    setError(undefined)
  }

  function removeSshProfile(id: string): void {
    const next = sshProfiles.filter((profile) => profile.id !== id)
    setSshProfiles(next)
    localStorage.setItem(SSH_PROFILES_KEY, JSON.stringify(next))
  }

  function closeSshDialog(): void {
    setSshDialogOpen(false)
    setSshDraft(emptySshDraft)
    setSshAuthentication('agent')
    setError(undefined)
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
              <SettingsPane eyebrow="CONNECTIONS" title="连接" description="管理本地与远程开发环境的连接。">
                <div className="settings-subsection-heading">
                  <div><h3>SSH 连接</h3><p>保存常用主机，之后可从项目选择器快速使用。</p></div>
                  <button className="button button-primary settings-add-button" onClick={() => { setSshDialogOpen(true); setError(undefined) }} type="button"><Icon name="plus" size={15} />添加</button>
                </div>
                {sshProfiles.length > 0
                  ? <div className="settings-record-list ssh-profile-list">
                    {sshProfiles.map((profile) => (
                      <div className="settings-record-row" key={profile.id}>
                        <span className="record-icon"><Icon name="terminal" size={17} /></span>
                        <div><strong>{profile.name}</strong><small>{profile.user === '' ? '' : profile.user + '@'}{profile.host}:{profile.port}{profile.identityFile === '' ? '' : ' · ' + profile.identityFile}</small></div>
                        <span className="record-status">已保存</span>
                        <button aria-label={'移除 ' + profile.name} className="icon-button subtle" onClick={() => removeSshProfile(profile.id)} type="button"><Icon name="trash" size={15} /></button>
                      </div>
                    ))}
                  </div>
                  : <div className="connection-empty"><span><Icon name="link" size={21} /></span><strong>尚未添加连接</strong><small>添加 SSH 主机后会显示在此处。</small></div>}
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
              <SettingsPane eyebrow="GIT" title="Git" description="配置 ChatGPT 创建分支、提交和 Pull Request 时使用的默认行为。">
                <div className="preference-list git-settings-card">
                  <PreferenceRow title="分支前缀" description="ChatGPT 创建新分支时使用的前缀">
                    <input aria-label="分支前缀" className="settings-compact-input" onChange={(event) => setGitSettings({ ...gitSettings, branchPrefix: event.target.value })} spellCheck={false} value={gitSettings.branchPrefix} />
                  </PreferenceRow>
                  <PreferenceRow title="Pull Request 合并方法" description="选择 ChatGPT 合并 Pull Request 的方式">
                    <SegmentedControl
                      ariaLabel="Pull Request 合并方法"
                      onChange={(mergeMethod) => setGitSettings({ ...gitSettings, mergeMethod })}
                      options={[{ label: '合并', value: 'merge' }, { label: '压缩合并', value: 'squash' }]}
                      value={gitSettings.mergeMethod}
                    />
                  </PreferenceRow>
                  <PreferenceRow title="始终强制推送" description="从 ChatGPT 推送时使用 --force-with-lease">
                    <SettingsToggle checked={gitSettings.forceWithLease} label="始终强制推送" onChange={(forceWithLease) => setGitSettings({ ...gitSettings, forceWithLease })} />
                  </PreferenceRow>
                  <PreferenceRow title="创建草稿 Pull Request" description="从 ChatGPT 创建 PR 时默认使用草稿 Pull Request">
                    <SettingsToggle checked={gitSettings.draftPullRequests} label="创建草稿 Pull Request" onChange={(draftPullRequests) => setGitSettings({ ...gitSettings, draftPullRequests })} />
                  </PreferenceRow>
                  <PreferenceRow title="审查结果呈现方式" description="尽可能在当前聊天中启动 /review，或启动单独的审查聊天">
                    <SegmentedControl
                      ariaLabel="审查结果呈现方式"
                      onChange={(reviewPresentation) => setGitSettings({ ...gitSettings, reviewPresentation })}
                      options={[{ label: '内联', value: 'inline' }, { label: '单独', value: 'separate' }]}
                      value={gitSettings.reviewPresentation}
                    />
                  </PreferenceRow>
                </div>

                <SettingsSectionTitle title="监控并修复 Pull Request" />
                <div className="preference-list git-settings-card">
                  <PreferenceRow title="准备就绪时自动合并" description="继续监控，直到 Pull Request 合并">
                    <SettingsToggle checked={gitSettings.autoMergeWhenReady} label="准备就绪时自动合并" onChange={(autoMergeWhenReady) => setGitSettings({ ...gitSettings, autoMergeWhenReady })} />
                  </PreferenceRow>
                  <SettingsTextArea
                    description="监控 Pull Request 时需要遵循的额外要求"
                    onChange={(monitorInstructions) => setGitSettings({ ...gitSettings, monitorInstructions })}
                    placeholder="例如：检查通过后评论 /merge，并批准不相关的视觉回归变更…"
                    title="监控说明"
                    value={gitSettings.monitorInstructions}
                  />
                </div>

                <SettingsSectionTitle title="生成说明" />
                <div className="preference-list git-settings-card">
                  <SettingsTextArea
                    description="将添加到提交信息生成提示中"
                    onChange={(commitInstructions) => setGitSettings({ ...gitSettings, commitInstructions })}
                    placeholder="例如：使用约定式提交，并在正文中说明验证结果…"
                    title="提交说明"
                    value={gitSettings.commitInstructions}
                  />
                  <SettingsTextArea
                    description="将添加到 PR 标题/描述生成提示中"
                    onChange={(pullRequestInstructions) => setGitSettings({ ...gitSettings, pullRequestInstructions })}
                    placeholder="例如：说明用户可见的变化、测试步骤和风险…"
                    title="Pull Request 说明"
                    value={gitSettings.pullRequestInstructions}
                  />
                </div>
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
              <SettingsPane eyebrow="WORKTREES" title="Worktrees" description="配置 ChatGPT 创建和清理 Git 工作树的方式。">
                <div className="preference-list worktree-settings-card">
                  <PreferenceRow title="工作树根目录" description="ChatGPT 创建托管工作树的目录。留空则使用默认位置">
                    <input aria-label="工作树根目录" className="settings-wide-input" onChange={(event) => setWorktreeSettings({ ...worktreeSettings, rootDirectory: event.target.value })} placeholder="C:/Users/GNiTi/.codex/worktrees" spellCheck={false} value={worktreeSettings.rootDirectory} />
                  </PreferenceRow>
                  <PreferenceRow title="创建工作树前始终获取上游更新" description="在创建每个新工作树前获取上游更新">
                    <SettingsToggle checked={worktreeSettings.fetchBeforeCreate} label="创建工作树前始终获取上游更新" onChange={(fetchBeforeCreate) => setWorktreeSettings({ ...worktreeSettings, fetchBeforeCreate })} />
                  </PreferenceRow>
                  <PreferenceRow title="自动删除旧工作树" description="推荐大多数用户启用。关闭后需要手动管理旧工作树和磁盘空间">
                    <SettingsToggle checked={worktreeSettings.autoDeleteOld} label="自动删除旧工作树" onChange={(autoDeleteOld) => setWorktreeSettings({ ...worktreeSettings, autoDeleteOld })} />
                  </PreferenceRow>
                  <PreferenceRow title="自动删除限制" description="超过此数量后，较旧的托管工作树会自动被清理">
                    <input aria-label="自动删除限制" className="settings-number-input" inputMode="numeric" max={99} min={1} onChange={(event) => setWorktreeSettings({ ...worktreeSettings, retentionLimit: Math.max(1, Math.min(99, Number(event.target.value) || 1)) })} type="number" value={worktreeSettings.retentionLimit} />
                  </PreferenceRow>
                </div>

                <div className="worktree-section-heading">
                  <div><h3>{environment?.isGit === true && environment.worktrees.length > 0 ? '当前工作树' : '尚无工作树'}</h3>{environment?.isGit === true && environment.worktrees.length > 0 && <span>{environment.worktrees.length}</span>}</div>
                  <button aria-label="刷新工作树" className={environmentLoading ? 'worktree-refresh is-loading' : 'worktree-refresh'} disabled={workspaceRoot === undefined || environmentLoading} onClick={() => void refreshEnvironment()} type="button"><Icon name="refresh" size={17} /></button>
                </div>
                {environment?.isGit === true && environment.worktrees.length > 0
                  ? <div className="settings-record-list worktree-list">
                    {environment.worktrees.map((worktree) => (
                      <div className="settings-record-row" key={worktree.path}>
                        <span className="record-icon"><Icon name="branch" size={16} /></span>
                        <div><strong>{worktree.branch ?? 'detached HEAD'}</strong><small>{worktree.path}</small></div>
                        {worktree.head !== undefined && <code>{worktree.head}</code>}
                      </div>
                    ))}
                  </div>
                  : <div className="worktree-empty"><span><Icon name="layers" size={22} /></span><strong>ChatGPT 创建的工作树将显示在此处</strong><small>{workspaceRoot === undefined ? '打开项目后即可读取工作树。' : '当前项目还没有托管工作树。'}</small></div>}
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
      {sshDialogOpen && (
        <div className="settings-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) closeSshDialog() }}>
          <form aria-labelledby="ssh-dialog-title" className="ssh-dialog" onSubmit={saveSshProfile}>
            <div className="ssh-dialog-header">
              <h2 id="ssh-dialog-title">添加 SSH 连接</h2>
              <button aria-label="关闭" className="icon-button subtle" onClick={closeSshDialog} type="button"><Icon name="close" size={17} /></button>
            </div>
            <label className="ssh-dialog-field">
              <span>显示名称</span>
              <input autoFocus onChange={(event) => setSshDraft({ ...sshDraft, name: event.target.value })} value={sshDraft.name} />
            </label>
            <label className="ssh-dialog-field">
              <span>主机名</span>
              <input onChange={(event) => setSshDraft({ ...sshDraft, host: event.target.value })} placeholder="host.com 或 user@host.com" spellCheck={false} value={sshDraft.host} />
            </label>
            <label className="ssh-dialog-field">
              <span>SSH 端口 <small>（可选）</small></span>
              <input inputMode="numeric" onChange={(event) => setSshDraft({ ...sshDraft, port: event.target.value.replace(/\D/gu, '') })} value={sshDraft.port} />
            </label>
            <div aria-label="SSH 身份验证方式" className="ssh-auth-switch" role="group">
              <button aria-pressed={sshAuthentication === 'agent'} className={sshAuthentication === 'agent' ? 'is-active' : ''} onClick={() => setSshAuthentication('agent')} type="button">无身份验证</button>
              <button aria-pressed={sshAuthentication === 'identity'} className={sshAuthentication === 'identity' ? 'is-active' : ''} onClick={() => setSshAuthentication('identity')} type="button">身份文件</button>
            </div>
            {sshAuthentication === 'identity' && (
              <label className="ssh-dialog-field ssh-identity-path">
                <span>身份文件</span>
                <input onChange={(event) => setSshDraft({ ...sshDraft, identityFile: event.target.value })} placeholder="C:\Users\name\.ssh\id_ed25519" spellCheck={false} value={sshDraft.identityFile} />
              </label>
            )}
            {error !== undefined && <div className="ssh-dialog-error" role="alert">{error}</div>}
            <div className="ssh-dialog-actions">
              <button className="button" onClick={closeSshDialog} type="button">取消</button>
              <button className="button button-primary" disabled={sshDraft.host.trim() === '' || (sshAuthentication === 'identity' && sshDraft.identityFile.trim() === '')} type="submit">保存</button>
            </div>
          </form>
        </div>
      )}
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

function SettingsToggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }): React.ReactElement {
  return (
    <button aria-checked={checked} aria-label={label} className={checked ? 'settings-toggle is-checked' : 'settings-toggle'} onClick={() => onChange(!checked)} role="switch" type="button">
      <span />
    </button>
  )
}

function SegmentedControl<T extends string>({ ariaLabel, value, options, onChange }: {
  ariaLabel: string
  value: T
  options: readonly { label: string; value: T }[]
  onChange: (value: T) => void
}): React.ReactElement {
  return (
    <div aria-label={ariaLabel} className="settings-segmented" role="group">
      {options.map((option) => (
        <button aria-pressed={value === option.value} className={value === option.value ? 'is-selected' : ''} key={option.value} onClick={() => onChange(option.value)} type="button">{option.label}</button>
      ))}
    </div>
  )
}

function SettingsSectionTitle({ title }: { title: string }): React.ReactElement {
  return <div className="settings-section-title"><h3>{title}</h3></div>
}

function SettingsTextArea({ title, description, value, placeholder, onChange }: {
  title: string
  description: string
  value: string
  placeholder: string
  onChange: (value: string) => void
}): React.ReactElement {
  return (
    <div className="settings-text-area-row">
      <div><strong>{title}</strong><small>{description}</small></div>
      <textarea onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={3} value={value} />
    </div>
  )
}

function PluginConfigRow({ icon, title, description }: { icon: 'terminal' | 'activity' | 'search' | 'cache'; title: string; description: string }): React.ReactElement {
  return <div className="plugin-config-row"><span><Icon name={icon} size={17} /></span><div><strong>{title}</strong><small>{description}</small></div><span className="enabled-dot" /><span className="plugin-config-status">已启用</span></div>
}

function EnvironmentToolbar({ root, loading, onRefresh }: { root: string | undefined; loading: boolean; onRefresh: () => void }): React.ReactElement {
  return <div className="environment-toolbar"><div><Icon name="folder" size={16} /><span>{root ?? '未选择项目'}</span></div><button aria-label="刷新项目状态" className={loading ? 'is-loading' : ''} disabled={root === undefined || loading} onClick={onRefresh} type="button"><Icon name="refresh" size={15} />刷新</button></div>
}

function ShortcutRow({ label, keys }: { label: string; keys: string[] }): React.ReactElement {
  return <div className="shortcut-row"><span>{label}</span><div>{keys.map((key) => <kbd key={key}>{key}</kbd>)}</div></div>
}
