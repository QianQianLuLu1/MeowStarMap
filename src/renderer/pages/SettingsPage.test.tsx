// @vitest-environment jsdom
/**
 * SettingsPage 导航结构回归守卫（同步服务剥离带出的两项契约）。
 *
 * ① `sync` 分组已从 `SETTINGS_GROUPS` 整体移除，同步服务改由「同步图库」板块下的
 *    二级子页承载 → 设置页左导航不得再出现「同步」分组或「同步服务」节。
 *    这一条没有类型系统兜底：`SETTINGS_GROUPS` 是普通数组常量，漏删只是少一个分组，
 *    编译与既有测试都不会报，只能在这里锁。
 *
 * ② 旧用户残留：`activeSection` 持久化在 localStorage 的 `settings-active-section`，
 *    删除分组前保存在这里的 `'sync-service'` 在升级后依然会被读出来。
 *    `findSection()` 返回 undefined 后由 `|| SETTINGS_GROUPS[0].sections[0]` 兜底，
 *    必须验证「不崩 + 渲染默认节」，而不是指望那行兜底代码永远不被改坏。
 *
 * 运行：npx vitest run src/renderer/pages/SettingsPage.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SettingsPage } from './SettingsPage'

const ACTIVE_SECTION_KEY = 'settings-active-section'

/**
 * `tests/setup.ts` 的 electronAPI 是「每次属性访问都返回一个新 vi.fn」的 Proxy，
 * 所以 `electronAPI.settings.get` 取到的是 undefined——默认节（GeneralStartupSection）
 * 的 `load()` 未被 await，会以 unhandled rejection 的形式炸掉整轮测试。
 * 这里显式装上 `settings.get/set` 的最小替身：被测对象是导航结构，不是那个开关的存取。
 */
beforeEach(() => {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    settings: {
      get: vi.fn(async (_key: string, fallback: unknown) => fallback),
      set: vi.fn(async () => undefined)
    },
    app: { relaunch: vi.fn() }
  }
})

describe('SettingsPage 不再承载同步服务', () => {
  it('左导航既无「同步」分组标题，也无「同步服务」节', async () => {
    localStorage.removeItem(ACTIVE_SECTION_KEY)
    render(<SettingsPage />)
    // 先等默认节（启动行为）渲染出来，确认不是整页崩了导致的「查不到」
    await screen.findByRole('switch', { name: '启动时自动扫描' })

    expect(
      screen.queryByRole('button', { name: '同步服务' }),
      '「同步服务」节应已从 SETTINGS_GROUPS 移除'
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('同步服务'),
      '设置页任何位置都不得再出现「同步服务」文案'
    ).not.toBeInTheDocument()
    expect(screen.queryByText('同步')).not.toBeInTheDocument()
  })

  it("残留 activeSection='sync-service' 时回退到默认节，不崩不白屏", async () => {
    localStorage.setItem(ACTIVE_SECTION_KEY, 'sync-service')
    render(<SettingsPage />)
    await screen.findByRole('switch', { name: '启动时自动扫描' })
    expect(
      screen.getByRole('heading', { level: 2, name: '设置' }),
      '页头必须仍在（证明不是整树卸载）'
    ).toBeInTheDocument()
    localStorage.removeItem(ACTIVE_SECTION_KEY)
  })
})
