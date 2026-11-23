// @vitest-environment jsdom
/**
 * T1：SyncServicePage 装配冒烟——页面壳只负责装配 SyncConsoleLayout，
 * 导出名与 App.tsx 懒加载路径不变。原 ~1575 行逐节判据已随迁至 console/ 下
 * 按视图套件（ConnectView/SettingsView/OrganizerView/SyncConsoleLayout/
 * AboutView），本文件不再承载业务判据。
 *
 * 运行：npx vitest run src/renderer/pages/sync-gallery/SyncServicePage.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SyncServicePage } from './SyncServicePage'
import { setupConsoleTest, renderView } from './console/sync-console-test-utils'

beforeEach(() => {
  setupConsoleTest()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SyncServicePage 装配壳（T1）', () => {
  it('渲染控制台骨架：页头 h1 + 五视图子导航 + 视图内容', async () => {
    renderView(<SyncServicePage />)
    expect(await screen.findByRole('heading', { level: 1, name: '暖暖相册' })).toBeInTheDocument()
    for (const id of ['connect', 'settings', 'organizer', 'inspiration', 'about']) {
      expect(screen.getByTestId(`sync-console-nav-${id}`)).toBeInTheDocument()
    }
    // 全宽底栏已随上游移除（版本/重启/导出分别回到关于 hero、Android 卡、关于页）
    expect(screen.queryByTestId('sync-status-bar')).not.toBeInTheDocument()
    // 默认连接视图确实挂载（页头 h1 是 Layout 自己渲染的，不能证明视图内容在场）
    expect(screen.getByTestId('sync-service-pc-section')).toBeInTheDocument()
    expect(screen.getByTestId('sync-console-android-card')).toBeInTheDocument()
  })
})
