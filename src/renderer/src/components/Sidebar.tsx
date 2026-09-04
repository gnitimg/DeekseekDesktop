import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { dsh } from '../dsh-client'
import { PROJECT_PREFERENCES_KEY, useApp, type DesktopSession } from '../store'
import type { View } from '../types'
import { BrandMark, Icon } from './Icon'

const NAV: ReadonlyArray<{ id: View; label: string; icon: 'grid' | 'clock' }> = [
  { id: 'automations', label: '自动化', icon: 'clock' },
  { id: 'plugins', label: '插件', icon: 'grid' },
]

function projectName(path: string | undefined): string {
  if (path === undefined) return '快速任务'
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? path
}

function relativeTime(timestamp: number): string {
  const elapsed = Date.now() - timestamp
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))} 分钟`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时`
  return `${Math.floor(elapsed / 86_400_000)} 天`
}

interface SessionGroup {
  key: string
  label: string
  path?: string
  sessions: DesktopSession[]
}

interface MenuPosition { left: number, top: number }

function fitMenuPosition(left: number, top: number, width = 218, height = 340): MenuPosition {
  return {
    left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
  }
}

interface ProjectPreferences {
  collapsed: string[]
  hidden: string[]
  labels: Record<string, string>
  pinned: string[]
  order: string[]
  sections: Array<{ id: string, label: string }>
  sectionByProject: Record<string, string>
}

const DEFAULT_PROJECT_PREFERENCES: ProjectPreferences = {
  collapsed: [],
  hidden: [],
  labels: {},
  pinned: [],
  order: [],
  sections: [],
  sectionByProject: {},
}

function readProjectPreferences(): ProjectPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(PROJECT_PREFERENCES_KEY) ?? '{}') as Partial<ProjectPreferences>
    return {
      collapsed: Array.isArray(stored.collapsed) ? stored.collapsed : [],
      hidden: Array.isArray(stored.hidden) ? stored.hidden : [],
      labels: stored.labels !== null && typeof stored.labels === 'object' ? stored.labels : {},
      pinned: Array.isArray(stored.pinned) ? stored.pinned : [],
      order: Array.isArray(stored.order) ? stored.order : [],
      sections: Array.isArray(stored.sections)
        ? stored.sections.filter((item): item is { id: string, label: string } => item !== null && typeof item === 'object' && typeof item.id === 'string' && typeof item.label === 'string')
        : [],
      sectionByProject: stored.sectionByProject !== null && typeof stored.sectionByProject === 'object' ? stored.sectionByProject : {},
    }
  } catch {
    return DEFAULT_PROJECT_PREFERENCES
  }
}

export function Sidebar(): React.ReactElement {
  const view = useApp((state) => state.view)
  const setView = useApp((state) => state.setView)
  const sessions = useApp((state) => state.sessions)
  const activeSessionId = useApp((state) => state.activeSessionId)
  const addSession = useApp((state) => state.addSession)
  const patchSession = useApp((state) => state.patchSession)
  const pinnedSessionIds = useApp((state) => state.pinnedSessionIds)
  const toggleSessionPin = useApp((state) => state.toggleSessionPin)
  const archiveSessionLocally = useApp((state) => state.archiveSessionLocally)
  const clearProjectSelection = useApp((state) => state.clearProjectSelection)
  const selectSession = useApp((state) => state.selectSession)
  const workspaceRoot = useApp((state) => state.workspaceRoot)
  const setWorkspaceRoot = useApp((state) => state.setWorkspaceRoot)
  const dshUrl = useApp((state) => state.dshUrl)
  const sidebarCollapsed = useApp((state) => state.sidebarCollapsed)
  const toggleSidebar = useApp((state) => state.toggleSidebar)
  const agentPreset = useApp((state) => state.agentPreset)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>()
  const [projectPreferences, setProjectPreferences] = useState<ProjectPreferences>(readProjectPreferences)
  const [projectMenuKey, setProjectMenuKey] = useState<string | undefined>()
  const [projectMenuPosition, setProjectMenuPosition] = useState<MenuPosition | undefined>()
  const [renamingKey, setRenamingKey] = useState<string | undefined>()
  const [renameDraft, setRenameDraft] = useState('')
  const [removeConfirmKey, setRemoveConfirmKey] = useState<string | undefined>()
  const [sectionMenuKey, setSectionMenuKey] = useState<string | undefined>()
  const [creatingSectionFor, setCreatingSectionFor] = useState<string | undefined>()
  const [sectionDraft, setSectionDraft] = useState('')
  const [sessionMenuId, setSessionMenuId] = useState<string | undefined>()
  const [sessionMenuPosition, setSessionMenuPosition] = useState<MenuPosition | undefined>()
  const [sessionRenamingId, setSessionRenamingId] = useState<string | undefined>()
  const [sessionRenameDraft, setSessionRenameDraft] = useState('')
  const [archiveConfirmId, setArchiveConfirmId] = useState<string | undefined>()
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [projectKind, setProjectKind] = useState<'local' | 'remote'>('local')
  const searchRef = useRef<HTMLInputElement>(null)
  const projectMenuRef = useRef<HTMLDivElement>(null)
  const sessionMenuRef = useRef<HTMLDivElement>(null)

  const visibleSessions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (normalized === '') return sessions
    return sessions.filter((session) => (
      session.title.toLocaleLowerCase().includes(normalized)
      || session.cwd?.toLocaleLowerCase().includes(normalized) === true
    ))
  }, [query, sessions])

  const groups = useMemo<SessionGroup[]>(() => {
    const map = new Map<string, SessionGroup>()
    for (const session of visibleSessions) {
      const key = session.cwd ?? '__quick__'
      if (projectPreferences.hidden.includes(key)) continue
      const group = map.get(key) ?? {
        key,
        label: projectPreferences.labels[key] ?? projectName(session.cwd),
        ...(session.cwd === undefined ? {} : { path: session.cwd }),
        sessions: [],
      }
      group.sessions.push(session)
      map.set(key, group)
    }
    for (const group of map.values()) {
      group.sessions.sort((left, right) => {
        const pinDifference = Number(pinnedSessionIds.includes(right.id)) - Number(pinnedSessionIds.includes(left.id))
        return pinDifference !== 0 ? pinDifference : right.updatedAt - left.updatedAt
      })
    }
    const order = new Map(projectPreferences.order.map((key, index) => [key, index]))
    const sectionOrder = new Map(projectPreferences.sections.map((section, index) => [section.id, index]))
    const pinned = new Set(projectPreferences.pinned)
    return [...map.values()].sort((left, right) => {
      const pinDifference = Number(pinned.has(right.key)) - Number(pinned.has(left.key))
      if (pinDifference !== 0) return pinDifference
      const leftSection = projectPreferences.sectionByProject[left.key]
      const rightSection = projectPreferences.sectionByProject[right.key]
      const sectionDifference = (leftSection === undefined ? Number.MAX_SAFE_INTEGER : sectionOrder.get(leftSection) ?? Number.MAX_SAFE_INTEGER)
        - (rightSection === undefined ? Number.MAX_SAFE_INTEGER : sectionOrder.get(rightSection) ?? Number.MAX_SAFE_INTEGER)
      if (sectionDifference !== 0) return sectionDifference
      const leftOrder = order.get(left.key)
      const rightOrder = order.get(right.key)
      if (leftOrder !== undefined || rightOrder !== undefined) {
        return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER)
      }
      return (right.sessions[0]?.updatedAt ?? 0) - (left.sessions[0]?.updatedAt ?? 0)
    })
  }, [pinnedSessionIds, projectPreferences, visibleSessions])

  function updateProjectPreferences(updater: (current: ProjectPreferences) => ProjectPreferences): void {
    setProjectPreferences((current) => updater(current))
  }

  function closeProjectMenu(): void {
    setProjectMenuKey(undefined)
    setProjectMenuPosition(undefined)
    setRenamingKey(undefined)
    setRemoveConfirmKey(undefined)
    setSectionMenuKey(undefined)
    setCreatingSectionFor(undefined)
    setSectionDraft('')
  }

  function closeSessionMenu(): void {
    setSessionMenuId(undefined)
    setSessionMenuPosition(undefined)
    setSessionRenamingId(undefined)
    setArchiveConfirmId(undefined)
  }

  function openSessionMenu(session: DesktopSession, position: MenuPosition): void {
    closeProjectMenu()
    setSessionMenuId(session.id)
    setSessionMenuPosition(position)
    setSessionRenamingId(undefined)
    setArchiveConfirmId(undefined)
  }

  function beginSessionRename(session: DesktopSession): void {
    setSessionRenamingId(session.id)
    setSessionRenameDraft(session.title)
    setArchiveConfirmId(undefined)
  }

  async function saveSessionRename(session: DesktopSession): Promise<void> {
    const title = sessionRenameDraft.trim()
    if (title === '') return
    setActionError(undefined)
    try {
      const result = await dsh.renameSession({ sessionId: session.id, title })
      patchSession(session.id, { title: result.title, updatedAt: Date.now() })
      closeSessionMenu()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function archiveTask(session: DesktopSession): Promise<void> {
    if (archiveConfirmId !== session.id) {
      setArchiveConfirmId(session.id)
      setSessionRenamingId(undefined)
      return
    }
    setActionError(undefined)
    try {
      await dsh.archiveSession({ sessionId: session.id })
      archiveSessionLocally(session.id)
      closeSessionMenu()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  function toggleProject(key: string): void {
    updateProjectPreferences((current) => ({
      ...current,
      collapsed: current.collapsed.includes(key)
        ? current.collapsed.filter((item) => item !== key)
        : [...current.collapsed, key],
    }))
  }

  function toggleProjectPin(key: string): void {
    updateProjectPreferences((current) => ({
      ...current,
      pinned: current.pinned.includes(key)
        ? current.pinned.filter((item) => item !== key)
        : [...current.pinned, key],
    }))
    closeProjectMenu()
  }

  function assignProjectSection(projectKey: string, sectionId?: string): void {
    updateProjectPreferences((current) => {
      const sectionByProject = { ...current.sectionByProject }
      if (sectionId === undefined) delete sectionByProject[projectKey]
      else sectionByProject[projectKey] = sectionId
      return { ...current, sectionByProject }
    })
    closeProjectMenu()
  }

  function createProjectSection(projectKey: string): void {
    const label = sectionDraft.trim()
    if (label === '') return
    const id = `section-${Date.now().toString(36)}`
    updateProjectPreferences((current) => ({
      ...current,
      sections: [...current.sections, { id, label }],
      sectionByProject: { ...current.sectionByProject, [projectKey]: id },
    }))
    closeProjectMenu()
  }

  async function ensureWorkspace(group: SessionGroup): Promise<string> {
    if (group.path === undefined) throw new Error('快速任务不属于磁盘项目')
    const result = await dsh.createWorkspace({ path: group.path })
    return result.workspace.workspaceId
  }

  async function moveProject(group: SessionGroup, direction: -1 | 1): Promise<void> {
    const isPinned = projectPreferences.pinned.includes(group.key)
    const movableGroups = groups.filter((item) => item.path !== undefined && projectPreferences.pinned.includes(item.key) === isPinned)
    const movableKeys = movableGroups.map((item) => item.key)
    const sourceIndex = movableKeys.indexOf(group.key)
    const targetIndex = sourceIndex + direction
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= movableKeys.length) return
    const nextKeys = [...movableKeys]
    ;[nextKeys[sourceIndex], nextKeys[targetIndex]] = [nextKeys[targetIndex], nextKeys[sourceIndex]]
    const anchorKey = nextKeys[targetIndex + 1]
    const anchor = movableGroups.find((item) => item.key === anchorKey)
    setActionError(undefined)
    try {
      const workspaceId = await ensureWorkspace(group)
      const beforeWorkspaceId = anchor === undefined ? undefined : await ensureWorkspace(anchor)
      await dsh.moveWorkspace({ workspaceId, ...(beforeWorkspaceId === undefined ? {} : { beforeWorkspaceId }) })
      updateProjectPreferences((current) => ({
        ...current,
        order: [...nextKeys, ...current.order.filter((item) => !nextKeys.includes(item))],
      }))
      closeProjectMenu()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  function beginRename(group: SessionGroup): void {
    setRenamingKey(group.key)
    setRenameDraft(group.label)
    setRemoveConfirmKey(undefined)
  }

  async function saveRename(group: SessionGroup): Promise<void> {
    const label = renameDraft.trim()
    if (label === '') return
    setActionError(undefined)
    try {
      const workspaceId = await ensureWorkspace(group)
      const result = await dsh.renameWorkspace({ workspaceId, title: label })
      updateProjectPreferences((current) => ({
        ...current,
        labels: { ...current.labels, [group.key]: result.workspace.title },
      }))
      closeProjectMenu()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function removeProject(group: SessionGroup): Promise<void> {
    if (removeConfirmKey !== group.key) {
      setRemoveConfirmKey(group.key)
      setRenamingKey(undefined)
      return
    }
    setActionError(undefined)
    try {
      const workspaceId = await ensureWorkspace(group)
      await dsh.deleteWorkspace({ workspaceId })
      updateProjectPreferences((current) => ({
        ...current,
        hidden: [...new Set([...current.hidden, group.key])],
        pinned: current.pinned.filter((item) => item !== group.key),
        order: current.order.filter((item) => item !== group.key),
      }))
      if (group.path !== undefined) clearProjectSelection(group.path)
      if (workspaceRoot === group.path) setWorkspaceRoot(undefined)
      closeProjectMenu()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function createSession(cwd = workspaceRoot): Promise<void> {
    if (creating || dshUrl === undefined) return
    if (cwd === undefined) {
      setProjectKind('local')
      setProjectDialogOpen(true)
      return
    }
    const reusable = sessions.find((session) => (
      session.blank && !session.running && (session.cwd ?? undefined) === (cwd ?? undefined)
    ))
    if (reusable !== undefined) {
      selectSession(reusable.id)
      return
    }
    setCreating(true)
    setActionError(undefined)
    if (cwd !== undefined) {
      updateProjectPreferences((current) => ({
        ...current,
        hidden: current.hidden.filter((item) => item !== cwd),
      }))
    }
    try {
      const created = await dsh.createSession({
        cwd,
        agentPreset,
      })
      addSession({
        id: created.sessionId,
        title: '新任务',
        updatedAt: Date.now(),
        running: false,
        blank: true,
        cwd,
      })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  async function chooseProject(): Promise<void> {
    const selected = await window.desktop.project.chooseDirectory()
    if (selected === undefined) return
    setWorkspaceRoot(selected)
    await createSession(selected)
  }

  async function continueProjectCreation(): Promise<void> {
    if (projectKind === 'remote') {
      localStorage.setItem('deepseek-desktop:settings-tab', 'connections')
      setProjectDialogOpen(false)
      setView('settings')
      return
    }
    setProjectDialogOpen(false)
    await chooseProject()
  }

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus()
  }, [searchOpen])

  useEffect(() => {
    if (!projectDialogOpen) return
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setProjectDialogOpen(false)
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [projectDialogOpen])

  useEffect(() => {
    localStorage.setItem(PROJECT_PREFERENCES_KEY, JSON.stringify(projectPreferences))
  }, [projectPreferences])

  useEffect(() => {
    if (projectMenuKey === undefined) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && projectMenuRef.current?.contains(event.target) === true) return
      closeProjectMenu()
    }
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeProjectMenu()
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onEscape)
    }
  }, [projectMenuKey])

  useEffect(() => {
    if (sessionMenuId === undefined) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && sessionMenuRef.current?.contains(event.target) === true) return
      closeSessionMenu()
    }
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeSessionMenu()
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onEscape)
    }
  }, [sessionMenuId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      if (event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        if (sidebarCollapsed) toggleSidebar()
        setSearchOpen(true)
      }
      if (event.key.toLocaleLowerCase() === 'n') {
        event.preventDefault()
        void createSession()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <aside className="sidebar">
      <div className="sidebar-titlebar titlebar-drag">
        <button
          aria-label={sidebarCollapsed ? '展开侧栏' : '返回任务'}
          className="brand-button titlebar-no-drag"
          onClick={() => { if (sidebarCollapsed) toggleSidebar(); else setView('chat') }}
          type="button"
        >
          <BrandMark size={26} />
          <span className="brand-copy">
            <strong>DeepSeek</strong>
            <small>Harness</small>
          </span>
        </button>
        <button
          aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
          className="icon-button subtle titlebar-no-drag sidebar-toggle"
          onClick={toggleSidebar}
          type="button"
        >
          <Icon name={sidebarCollapsed ? 'chevron-right' : 'chevron-left'} size={16} />
        </button>
      </div>

      <div className="sidebar-content">
        <div className="sidebar-actions">
          <button className="sidebar-action primary-action" disabled={creating || dshUrl === undefined} onClick={() => void createSession()} type="button">
            <span className="action-icon"><Icon name="plus" size={17} /></span>
            <span>{creating ? '正在创建…' : '新建任务'}</span>
            <kbd>Ctrl N</kbd>
          </button>
          {searchOpen ? (
            <div className="sidebar-search">
              <Icon name="search" size={16} />
              <input
                aria-label="搜索任务"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索任务或项目"
                ref={searchRef}
                value={query}
              />
              <button aria-label="关闭搜索" onClick={() => { setSearchOpen(false); setQuery('') }} type="button">
                <Icon name="close" size={14} />
              </button>
            </div>
          ) : (
            <button className="sidebar-action" onClick={() => setSearchOpen(true)} type="button">
              <span className="action-icon"><Icon name="search" size={17} /></span>
              <span>搜索</span>
              <kbd>Ctrl K</kbd>
            </button>
          )}
          {NAV.map((item) => (
            <button
              className={`sidebar-action ${view === item.id ? 'is-active' : ''}`}
              key={item.id}
              onClick={() => setView(item.id)}
              type="button"
            >
              <span className="action-icon"><Icon name={item.icon} size={17} /></span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-divider" />

        <div className="projects-heading">
          <span>项目</span>
          <button aria-label="创建项目" className="icon-button subtle project-create-trigger" onClick={() => setProjectDialogOpen(true)} type="button">
            <Icon name="folder-plus" size={16} />
          </button>
        </div>

        <div className="session-scroll">
          {groups.length === 0 ? (
            <div className="sidebar-empty">{query === '' ? '还没有任务' : '没有匹配结果'}</div>
          ) : groups.map((group, groupIndex) => {
            const collapsed = projectPreferences.collapsed.includes(group.key)
            const pinned = projectPreferences.pinned.includes(group.key)
            const movableGroups = groups.filter((item) => item.path !== undefined && projectPreferences.pinned.includes(item.key) === pinned)
            const movableIndex = movableGroups.findIndex((item) => item.key === group.key)
            const menuOpen = projectMenuKey === group.key
            const sectionId = projectPreferences.sectionByProject[group.key]
            const previousSectionId = groupIndex === 0 ? undefined : projectPreferences.sectionByProject[groups[groupIndex - 1]?.key ?? '']
            const section = projectPreferences.sections.find((item) => item.id === sectionId)
            return (
            <Fragment key={group.key}>
            {section !== undefined && sectionId !== previousSectionId && <div className="project-section-heading"><span>{section.label}</span><small>{groups.filter((item) => projectPreferences.sectionByProject[item.key] === sectionId).length}</small></div>}
            <section className={`project-group ${pinned ? 'is-pinned' : ''}`} key={group.key}>
              <div
                className={`project-label ${menuOpen ? 'has-menu' : ''}`}
                onContextMenu={(event) => {
                  if (group.path === undefined) return
                  event.preventDefault()
                  setProjectMenuKey(group.key)
                  setProjectMenuPosition(fitMenuPosition(event.clientX, event.clientY))
                  setRenamingKey(undefined)
                  setRemoveConfirmKey(undefined)
                }}
              >
                <button
                  aria-expanded={!collapsed}
                  className="project-toggle"
                  onClick={() => toggleProject(group.key)}
                  title={group.path}
                  type="button"
                >
                  <Icon name="folder" size={14} />
                  <span className="project-name">{group.label}</span>
                  {pinned && <Icon className="project-pin-indicator" name="pin" size={11} />}
                  <span className="project-count">{group.sessions.length}</span>
                  <Icon className={`project-caret ${collapsed ? 'is-collapsed' : ''}`} name="chevron-down" size={12} />
                </button>
                {group.path !== undefined && (
                  <button
                    aria-expanded={menuOpen}
                    aria-haspopup="menu"
                    aria-label={`${group.label} 项目菜单`}
                    className="project-more"
                    onClick={(event) => {
                      if (menuOpen) closeProjectMenu()
                      else {
                        const rect = event.currentTarget.getBoundingClientRect()
                        setProjectMenuKey(group.key)
                        setProjectMenuPosition(fitMenuPosition(rect.left - 12, rect.bottom + 4))
                        setRenamingKey(undefined)
                        setRemoveConfirmKey(undefined)
                      }
                    }}
                    type="button"
                  >
                    <Icon name="more" size={15} />
                  </button>
                )}
                {menuOpen && projectMenuPosition !== undefined && (
                  <div className="project-menu is-floating" ref={projectMenuRef} role="menu" style={{ left: projectMenuPosition.left, top: projectMenuPosition.top }}>
                    {renamingKey === group.key ? (
                      <form className="project-rename-form" onSubmit={(event) => { event.preventDefault(); void saveRename(group) }}>
                        <label htmlFor={`project-name-${group.key}`}>项目名称</label>
                        <div>
                          <input
                            autoFocus
                            id={`project-name-${group.key}`}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            value={renameDraft}
                          />
                          <button aria-label="保存名称" disabled={renameDraft.trim() === ''} type="submit"><Icon name="check" size={14} /></button>
                          <button aria-label="取消重命名" onClick={() => setRenamingKey(undefined)} type="button"><Icon name="close" size={14} /></button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <button onClick={() => toggleProjectPin(group.key)} role="menuitem" type="button">
                          <Icon name="pin" size={15} /><span>{pinned ? '取消置顶' : '置顶'}</span>
                        </button>
                        <button onClick={() => beginRename(group)} role="menuitem" type="button">
                          <Icon name="edit" size={15} /><span>重命名</span>
                        </button>
                        <button className="project-submenu-trigger" onClick={() => { setSectionMenuKey(sectionMenuKey === group.key ? undefined : group.key); setCreatingSectionFor(undefined) }} role="menuitem" type="button">
                          <Icon name="layers" size={15} /><span>分区</span><Icon name="chevron-right" size={14} />
                        </button>
                        {sectionMenuKey === group.key && (
                          <div className="project-section-menu">
                            <button className={sectionId === undefined ? 'is-selected' : ''} onClick={() => assignProjectSection(group.key)} type="button"><span>无分区</span>{sectionId === undefined && <Icon name="check" size={14} />}</button>
                            {projectPreferences.sections.map((item) => (
                              <button className={sectionId === item.id ? 'is-selected' : ''} key={item.id} onClick={() => assignProjectSection(group.key, item.id)} type="button"><span>{item.label}</span>{sectionId === item.id && <Icon name="check" size={14} />}</button>
                            ))}
                            <div className="project-menu-divider" />
                            {creatingSectionFor === group.key ? (
                              <form className="section-create-form" onSubmit={(event) => { event.preventDefault(); createProjectSection(group.key) }}>
                                <input autoFocus onChange={(event) => setSectionDraft(event.target.value)} placeholder="分区名称" value={sectionDraft} />
                                <button aria-label="创建分区" disabled={sectionDraft.trim() === ''} type="submit"><Icon name="check" size={14} /></button>
                              </form>
                            ) : (
                              <button onClick={() => { setCreatingSectionFor(group.key); setSectionDraft('') }} type="button"><Icon name="plus" size={14} /><span>新建分区…</span></button>
                            )}
                          </div>
                        )}
                        <div className="project-menu-divider" />
                        <span className="project-menu-caption">移动项目</span>
                        <button disabled={movableIndex <= 0} onClick={() => void moveProject(group, -1)} role="menuitem" type="button">
                          <Icon name="arrow-up" size={15} /><span>上移</span>
                        </button>
                        <button disabled={movableIndex >= movableGroups.length - 1} onClick={() => void moveProject(group, 1)} role="menuitem" type="button">
                          <Icon className="rotate-180" name="arrow-up" size={15} /><span>下移</span>
                        </button>
                        <div className="project-menu-divider" />
                        <button className="project-menu-danger" onClick={() => void removeProject(group)} role="menuitem" type="button">
                          <Icon name="trash" size={15} />
                          <span>{removeConfirmKey === group.key ? '再次点击确认移除' : '移除项目'}</span>
                        </button>
                        {removeConfirmKey === group.key && <small className="project-remove-note">只从侧栏移除，不会删除磁盘文件。</small>}
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className={`project-sessions-collapse ${collapsed ? 'is-collapsed' : ''}`}>
              <div className="project-sessions">
                {group.sessions.map((session) => {
                  const menuOpen = sessionMenuId === session.id
                  return (
                    <div
                      className={`session-row-wrap ${menuOpen ? 'has-menu' : ''}`}
                      key={session.id}
                      onContextMenu={(event) => { event.preventDefault(); openSessionMenu(session, fitMenuPosition(event.clientX, event.clientY, 218, 230)) }}
                    >
                      <button
                        className={`session-row ${session.id === activeSessionId && view === 'chat' ? 'is-current' : ''}`}
                        onClick={() => { closeSessionMenu(); selectSession(session.id) }}
                        style={{ paddingLeft: session.parentId === undefined ? undefined : 26 }}
                        type="button"
                      >
                        <span className={`session-presence ${session.running ? 'is-running' : ''}`} />
                        <span className="session-title">{session.title}</span>
                        <span className="session-time">{relativeTime(session.updatedAt)}</span>
                      </button>
                      <button
                        aria-expanded={menuOpen}
                        aria-haspopup="menu"
                        aria-label={`${session.title} 任务菜单`}
                        className="session-more"
                        onClick={(event) => {
                          if (menuOpen) closeSessionMenu()
                          else {
                            const rect = event.currentTarget.getBoundingClientRect()
                            openSessionMenu(session, fitMenuPosition(rect.left - 12, rect.bottom + 4, 218, 230))
                          }
                        }}
                        type="button"
                      >
                        <Icon name="more" size={15} />
                      </button>
                      {menuOpen && sessionMenuPosition !== undefined && (
                        <div className="project-menu session-menu is-floating" ref={sessionMenuRef} role="menu" style={{ left: sessionMenuPosition.left, top: sessionMenuPosition.top }}>
                          {sessionRenamingId === session.id ? (
                            <form className="project-rename-form" onSubmit={(event) => { event.preventDefault(); void saveSessionRename(session) }}>
                              <label htmlFor={`session-name-${session.id}`}>任务名称</label>
                              <div>
                                <input
                                  autoFocus
                                  id={`session-name-${session.id}`}
                                  onChange={(event) => setSessionRenameDraft(event.target.value)}
                                  value={sessionRenameDraft}
                                />
                                <button aria-label="保存名称" disabled={sessionRenameDraft.trim() === ''} type="submit"><Icon name="check" size={14} /></button>
                                <button aria-label="取消重命名" onClick={() => setSessionRenamingId(undefined)} type="button"><Icon name="close" size={14} /></button>
                              </div>
                            </form>
                          ) : (
                            <>
                              <button onClick={() => { toggleSessionPin(session.id); closeSessionMenu() }} role="menuitem" type="button">
                                <Icon name="pin" size={15} /><span>{pinnedSessionIds.includes(session.id) ? '取消置顶' : '置顶'}</span>
                              </button>
                              <button onClick={() => beginSessionRename(session)} role="menuitem" type="button">
                                <Icon name="edit" size={15} /><span>重命名</span>
                              </button>
                              <div className="project-menu-divider" />
                              <button className="project-menu-danger" onClick={() => void archiveTask(session)} role="menuitem" type="button">
                                <Icon name="archive" size={15} />
                                <span>{archiveConfirmId === session.id ? '再次点击确认归档' : '归档任务'}</span>
                              </button>
                              {archiveConfirmId === session.id && <small className="project-remove-note">任务会从项目列表隐藏，运行记录仍保留。</small>}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              </div>
            </section>
            </Fragment>
          )})}
        </div>

        {actionError !== undefined && <div className="sidebar-error">{actionError}</div>}
      </div>

      <div className="sidebar-footer">
        <button className={`account-row ${view === 'settings' ? 'is-active' : ''}`} onClick={() => setView('settings')} type="button">
          <span className="account-avatar">D<span className={`connection-dot ${dshUrl !== undefined ? 'is-online' : 'is-offline'}`} /></span>
          <span className="account-copy">
            <strong>DeepSeek</strong>
          </span>
          <Icon name="settings" size={16} />
        </button>
      </div>

      {projectDialogOpen && createPortal((
        <div className="project-create-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setProjectDialogOpen(false) }}>
          <section aria-labelledby="create-project-title" aria-modal="true" className="project-create-dialog" role="dialog">
            <header>
              <h2 id="create-project-title">创建项目</h2>
              <button aria-label="关闭创建项目" onClick={() => setProjectDialogOpen(false)} type="button"><Icon name="close" size={17} /></button>
            </header>
            <span className="project-create-label">项目类型</span>
            <div className="project-kind-grid">
              <button className={projectKind === 'local' ? 'is-selected' : ''} onClick={() => setProjectKind('local')} type="button">
                <Icon name="monitor" size={21} />
                <i aria-hidden="true" />
                <span><strong>本地</strong><small>在你的电脑上编辑、运行和测试文件</small></span>
              </button>
              <button className={projectKind === 'remote' ? 'is-selected' : ''} onClick={() => setProjectKind('remote')} type="button">
                <Icon name="globe" size={21} />
                <i aria-hidden="true" />
                <span><strong>远程</strong><small>通过 SSH 选择已配置主机上的工作区</small></span>
              </button>
            </div>
            {projectKind === 'remote' && <p className="project-create-note">下一步将在“连接”中添加或选择 SSH 主机。</p>}
            <footer>
              <button className="button button-primary" onClick={() => void continueProjectCreation()} type="button">{projectKind === 'local' ? '下一步' : '打开连接设置'}</button>
            </footer>
          </section>
        </div>
      ), document.body)}
    </aside>
  )
}
