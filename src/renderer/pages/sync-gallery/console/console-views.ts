/**
 * T1：同步控制台五视图标识（上游 DesktopPage.ts:74 的 nav 五项，顺序一致）。
 * 子视图是控制台内部状态（localStorage 'syncConsole.view' 持久化），不新增 ViewLevel。
 */
import type { ViewLevel } from '../../../stores/uiStore'

export const CONSOLE_VIEWS = ['connect', 'settings', 'organizer', 'inspiration', 'about'] as const

/**
 * 控制台宿主视图：控制台是 `sync-gallery`（侧边栏「同步服务」）的直接界面。
 * 所有轮询/可见性门控一律比对本常量，不得散写字面量——宿主视图再变更时只改这里。
 */
export const SYNC_CONSOLE_HOST_VIEW: ViewLevel = 'sync-gallery'

export type ConsoleView = (typeof CONSOLE_VIEWS)[number]

/** 子导航持久化键（计划钉住字面量）。 */
export const CONSOLE_VIEW_STORAGE_KEY = 'syncConsole.view'

export function isConsoleView(value: unknown): value is ConsoleView {
  return typeof value === 'string' && (CONSOLE_VIEWS as readonly string[]).includes(value)
}

/** 视图标题/副标题键（显式映射，避免动态 t(key) 让键守卫看不见消费点）。 */
export const CONSOLE_HEADING_KEYS: Record<ConsoleView, { title: string; subtitle: string }> = {
  connect: {
    title: 'syncConsole.heading.connect.title',
    subtitle: 'syncConsole.heading.connect.subtitle'
  },
  settings: {
    title: 'syncConsole.heading.settings.title',
    subtitle: 'syncConsole.heading.settings.subtitle'
  },
  organizer: {
    title: 'syncConsole.heading.organizer.title',
    subtitle: 'syncConsole.heading.organizer.subtitle'
  },
  inspiration: {
    title: 'syncConsole.heading.inspiration.title',
    subtitle: 'syncConsole.heading.inspiration.subtitle'
  },
  about: {
    title: 'syncConsole.heading.about.title',
    subtitle: 'syncConsole.heading.about.subtitle'
  }
}

/** 子导航标签键（与 CONSOLE_VIEWS 顺序一一对应）。 */
export const CONSOLE_NAV_KEYS: Record<ConsoleView, string> = {
  connect: 'syncConsole.nav.connect',
  settings: 'syncConsole.nav.settings',
  organizer: 'syncConsole.nav.organizer',
  inspiration: 'syncConsole.nav.inspiration',
  about: 'syncConsole.nav.about'
}
