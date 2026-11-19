import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '../../../components/common/PageHeader'
import { IconSync } from '../../../icons'
import { useUIStore } from '../../../stores/uiStore'
import {
  CONSOLE_VIEWS,
  CONSOLE_VIEW_STORAGE_KEY,
  CONSOLE_HEADING_KEYS,
  CONSOLE_NAV_KEYS,
  isConsoleView,
  type ConsoleView
} from './console-views'
import { ORGANIZER_BADGE_STATES } from './organizer-states'
import { ConnectView } from './ConnectView'
import { SettingsView } from './SettingsView'
import { OrganizerView } from './OrganizerView'
import { InspirationView } from './InspirationView'
import { AboutView } from './AboutView'
import { SyncStatusBar } from './SyncStatusBar'

/** T10：待批角标轮询间隔（上游 DesktopPageScript 的 5s 节奏）。 */
const BADGE_POLL_MS = 5000
const SETTING_ORGANIZER_ENABLED = 'nikkisync.organizerEnabled'

/** 读回上次停留的子视图；非法/缺席一律回 connect（不臆造视图态）。 */
function readStoredView(): ConsoleView {
  try {
    const stored = window.localStorage.getItem(CONSOLE_VIEW_STORAGE_KEY)
    if (stored && isConsoleView(stored)) return stored
  } catch {
    // localStorage 不可用（隐私模式等）⇒ 默认视图
  }
  return 'connect'
}

/**
 * T1：同步控制台骨架——PageHeader + 左侧五视图子导航 + 视图容器 + 底栏。
 *
 * 设计约束：
 * - 页头标题钉住 syncService.page.title（页面级 h2 语义不变），副标题随视图切换；
 * - 子导航复用 Sidebar 的 nav-item 词汇，不新增 ViewLevel（宿主路由栈不受影响，
 *   返回键弹的是宿主视图栈，控制台子视图态经 localStorage 持久化，返回不丢栈）；
 * - 视图按需挂载（切走即卸载）：各视图内的轮询定时器随卸载结构性清零；
 * - 待批角标由 Layout 自持 5s 轮询，双门控 currentView==='sync-service' &&
 *   organizerEnabled（keep-alive 下页面隐藏 ≠ 卸载，必须显式停表）。
 */
export const SyncConsoleLayout: React.FC = () => {
  const { t } = useTranslation()
  const currentView = useUIStore((s) => s.currentView)
  const [view, setView] = useState<ConsoleView>(readStoredView)
  const [organizerEnabled, setOrganizerEnabled] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  /** 底栏重启成功 ⇒ 连接视图重挂载即时重读状态（其余视图不受影响）。 */
  const [refreshTick, setRefreshTick] = useState(0)

  // 子视图持久化：切换即落盘，返回/重进恢复上次停留位
  useEffect(() => {
    try {
      window.localStorage.setItem(CONSOLE_VIEW_STORAGE_KEY, view)
    } catch {
      // 静默：持久化失败不影响本次会话导航
    }
  }, [view])

  // 开关读回（OrganizerView 未挂载时角标门控也要有真相）；读不到一律视为关
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const value = await window.electronAPI?.settings.get(SETTING_ORGANIZER_ENABLED, false)
        if (alive) setOrganizerEnabled(value === true)
      } catch {
        // 静默：保持关闭态
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const handleNavigate = useCallback((next: ConsoleView): void => {
    setView(next)
  }, [])

  const handleOrganizerEnabledChange = useCallback((enabled: boolean): void => {
    setOrganizerEnabled(enabled)
  }, [])

  const handleRefresh = useCallback((): void => {
    setRefreshTick((tick) => tick + 1)
  }, [])

  // T10：待批角标 5s 轮询。门控关闭时清零计数且不留定时器；
  // 计数口径 = 上游 activeStates（含 executing），与 OrganizerPanel.ts:14 逐字一致。
  useEffect(() => {
    if (currentView !== 'sync-service' || !organizerEnabled) {
      setPendingCount(0)
      return
    }
    const getQueue = window.electronAPI?.nikkisync?.getOrganizerQueue
    if (typeof getQueue !== 'function') return
    let alive = true
    const poll = async (): Promise<void> => {
      try {
        const queue = await getQueue()
        if (!alive) return
        const count = (queue?.items ?? []).filter((item) =>
          ORGANIZER_BADGE_STATES.has(item.state)
        ).length
        setPendingCount(count)
      } catch {
        if (alive) setPendingCount(0)
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), BADGE_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [currentView, organizerEnabled])

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('syncService.page.title')}
        subtitle={t(CONSOLE_HEADING_KEYS[view].subtitle)}
        icon={<IconSync size={20} />}
      />
      <div className="flex min-h-0 flex-1">
        {/* 左侧子导航：复用 Sidebar nav-item 词汇（glass/active），不新增 ViewLevel */}
        <nav
          className="w-40 shrink-0 space-y-1 overflow-y-auto border-r p-3"
          style={{ borderColor: 'var(--divider)' }}
          aria-label={t('syncService.page.title')}
        >
          {CONSOLE_VIEWS.map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`sync-console-nav-${id}`}
              className={`nav-item w-full ${view === id ? 'active' : ''}`}
              aria-current={view === id ? 'page' : undefined}
              onClick={() => handleNavigate(id)}
            >
              <span className="flex-1 text-left">{t(CONSOLE_NAV_KEYS[id])}</span>
              {id === 'organizer' && pendingCount > 0 && (
                <span
                  data-testid="sync-console-organizer-badge"
                  className="ml-1 rounded-full px-1.5 text-xs"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                >
                  {pendingCount}
                </span>
              )}
            </button>
          ))}
        </nav>
        {/* 视图容器：按需挂载，切走即卸载（轮询随卸载清零） */}
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          {view === 'connect' && (
            <ConnectView key={`connect-${refreshTick}`} onNavigate={handleNavigate} />
          )}
          {view === 'settings' && <SettingsView />}
          {view === 'organizer' && <OrganizerView onEnabledChange={handleOrganizerEnabledChange} />}
          {view === 'inspiration' && <InspirationView />}
          {view === 'about' && <AboutView />}
        </main>
      </div>
      {/* T11：底栏（双版本 + 重启 + 导出诊断） */}
      <div className="px-6 py-3" style={{ borderTop: '1px solid var(--divider)' }}>
        <SyncStatusBar onRefresh={handleRefresh} />
      </div>
    </div>
  )
}
