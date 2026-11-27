import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useUIStore } from '../../../stores/uiStore'
import type { NikkiSyncServerStatusInfo } from '../../../../shared/types/electron-api'
import { CONSOLE_BRAND_IMAGE } from './brand-assets'
import { ConsoleIcon, type ConsoleIconName } from './ConsoleIcons'
import {
  CONSOLE_VIEWS,
  CONSOLE_VIEW_STORAGE_KEY,
  CONSOLE_HEADING_KEYS,
  CONSOLE_NAV_KEYS,
  SYNC_CONSOLE_HOST_VIEW,
  isConsoleView,
  type ConsoleView
} from './console-views'
import { ORGANIZER_BADGE_STATES } from './organizer-states'
import { ConnectView } from './ConnectView'
import { SettingsView } from './SettingsView'
import { OrganizerView } from './OrganizerView'
import { InspirationView } from './InspirationView'
import { AboutView } from './AboutView'
import './sync-console.css'

/** T10：待批角标轮询间隔（上游 DesktopPageScript 的 5s 节奏）。 */
const BADGE_POLL_MS = 5000
const SETTING_ORGANIZER_ENABLED = 'nikkisync.organizerEnabled'

const NAV_ICONS: Record<ConsoleView, ConsoleIconName> = {
  connect: 'phone',
  settings: 'settings',
  organizer: 'trash',
  inspiration: 'album',
  about: 'info'
}

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
 * N2/N3：同步控制台骨架——上游 DesktopPage 同款 188px 品牌子导航 +
 * 当前视图页头（h1/副标题/状态 chip）+ 视图容器。
 *
 * 设计约束：
 * - 标题随视图切换（CONSOLE_HEADING_KEYS），视图内不再重复页面级 h1；
 * - 子导航复用宿主 nav 语义，但外观走 .sync-console 局部设计系统，不改全局主题；
 * - 视图按需挂载（切走即卸载）：轮询定时器随卸载结构性清零；
 * - 状态 chip 只在视图切换时取一次快照；Connect 可见时由其 2s 轮询回传，
 *   不新增常驻全局定时器。
 */
export const SyncConsoleLayout: React.FC = () => {
  const { t } = useTranslation()
  const currentView = useUIStore((s) => s.currentView)
  const [view, setView] = useState<ConsoleView>(readStoredView)
  const [organizerEnabled, setOrganizerEnabled] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const [serverStatus, setServerStatus] = useState<NikkiSyncServerStatusInfo | null>(null)
  // Layout 初始快照与 Connect 刷新共用请求代次，乱序旧响应不得覆盖新状态。
  const statusRequestRef = useRef(0)
  const [brandImageFailed, setBrandImageFailed] = useState(false)

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

  // 页头 chip：进入控制台时取一次快照；后续由 Connect 可见轮询回传。
  // 不在**子视图切换**时追加 IPC（`view` 不进依赖），保证「切到关于即停表」的轮询门控不退化。
  useEffect(() => {
    if (currentView !== SYNC_CONSOLE_HOST_VIEW) return
    let alive = true
    const getStatus = window.electronAPI?.nikkisync?.getServerStatus
    if (typeof getStatus !== 'function') {
      setServerStatus(null)
      return
    }
    const request = ++statusRequestRef.current
    void getStatus()
      .then((next) => {
        if (alive && request === statusRequestRef.current) setServerStatus(next ?? null)
      })
      .catch(() => {
        if (alive && request === statusRequestRef.current) setServerStatus(null)
      })
    return () => {
      alive = false
    }
  }, [currentView])

  const handleServerStatusChange = useCallback((next: NikkiSyncServerStatusInfo | null): void => {
    statusRequestRef.current += 1
    setServerStatus(next)
  }, [])

  const handleNavigate = useCallback((next: ConsoleView): void => {
    setView(next)
  }, [])

  const handleOrganizerEnabledChange = useCallback((enabled: boolean): void => {
    setOrganizerEnabled(enabled)
  }, [])

  // T10：待批角标 5s 轮询。门控关闭时清零计数且不留定时器；
  // 计数口径 = 上游 activeStates（含 executing），与 OrganizerPanel.ts:14 逐字一致。
  useEffect(() => {
    if (currentView !== SYNC_CONSOLE_HOST_VIEW || !organizerEnabled) {
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

  const chipState = !serverStatus
    ? 'unavailable'
    : serverStatus.available === false
      ? 'unavailable'
      : serverStatus.running
        ? 'ready'
        : 'offline'
  const chipText =
    chipState === 'ready'
      ? t('syncConsole.status.running')
      : chipState === 'offline'
        ? t('syncConsole.status.stopped')
        : t('syncConsole.status.unavailable')

  // 部分语种 brandName 与 brandLatin 同值（如英文包两键都是 Momo Camera），第二行会整行重复
  const brandName = t('syncConsole.shell.brandName')
  const brandLatin = t('syncConsole.shell.brandLatin')

  return (
    <div className="sync-console" data-testid="sync-console">
      <div className="sc-shell">
        {/* 188px 品牌子导航：显式内部导航，不新增宿主 ViewLevel */}
        <aside className="sc-sidebar">
          <div className="sc-brand">
            {brandImageFailed ? (
              <span className="sc-brand-avatar sc-brand-fallback" aria-hidden="true">
                <ConsoleIcon name="camera" size={22} />
              </span>
            ) : (
              <img
                className="sc-brand-avatar"
                data-testid="sync-console-brand-image"
                src={CONSOLE_BRAND_IMAGE}
                alt={t('syncConsole.shell.brandAlt')}
                width={42}
                height={42}
                onError={() => setBrandImageFailed(true)}
              />
            )}
            <div>
              <div className="sc-brand-name">{brandName}</div>
              {brandLatin !== brandName ? (
                <div className="sc-brand-english">{brandLatin}</div>
              ) : null}
            </div>
          </div>

          <nav className="sc-nav" aria-label={t('syncConsole.shell.navAria')}>
            {CONSOLE_VIEWS.map((id) => (
              <button
                key={id}
                type="button"
                data-testid={`sync-console-nav-${id}`}
                className="sc-nav-item"
                aria-current={view === id ? 'page' : undefined}
                aria-label={t(CONSOLE_NAV_KEYS[id])}
                onClick={() => handleNavigate(id)}
              >
                <ConsoleIcon name={NAV_ICONS[id]} size={18} />
                <span className="sc-nav-label">{t(CONSOLE_NAV_KEYS[id])}</span>
                {id === 'organizer' && pendingCount > 0 && (
                  <span className="sc-nav-badge" data-testid="sync-console-organizer-badge">
                    {pendingCount}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className="sc-sidebar-footer">
            <span>{t('syncConsole.shell.footerCompat')}</span>
            <span>{t('syncConsole.shell.footerDisclaimer')}</span>
          </div>
        </aside>

        <div className="sc-main">
          <main className="sc-workspace">
            {/* N3：一页一个标题；状态 chip 与上游 page-header 同位 */}
            <header className="sc-page-header">
              <div>
                <h1 className="sc-page-title">{t(CONSOLE_HEADING_KEYS[view].title)}</h1>
                <p className="sc-page-subtitle">{t(CONSOLE_HEADING_KEYS[view].subtitle)}</p>
              </div>
              <span
                className="sc-chip"
                data-testid="sync-console-status-chip"
                data-state={chipState}
                role="status"
                aria-label={chipText}
              >
                <span className="sc-chip-dot" aria-hidden="true" />
                <span>{chipText}</span>
              </span>
            </header>

            {view === 'connect' && (
              <ConnectView
                onNavigate={handleNavigate}
                onServerStatusChange={handleServerStatusChange}
              />
            )}
            {view === 'settings' && <SettingsView />}
            {view === 'organizer' && (
              <OrganizerView onEnabledChange={handleOrganizerEnabledChange} />
            )}
            {view === 'inspiration' && <InspirationView />}
            {view === 'about' && <AboutView />}
          </main>
        </div>
      </div>
    </div>
  )
}
