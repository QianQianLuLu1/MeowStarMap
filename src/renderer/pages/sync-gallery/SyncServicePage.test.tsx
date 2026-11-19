// @vitest-environment jsdom
/**
 * T1：SyncServicePage 装配冒烟——页面壳只负责装配 SyncConsoleLayout，
 * 导出名与 App.tsx 懒加载路径不变。原 ~1575 行逐节判据已随迁至 console/ 下
 * 按视图套件（ConnectView/SettingsView/OrganizerView/SyncConsoleLayout/
 * SyncStatusBar/AboutView），本文件不再承载业务判据。
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
  it('渲染控制台骨架：页头 h2 + 五视图子导航 + 底栏', async () => {
    renderView(<SyncServicePage />)
    expect(await screen.findByRole('heading', { level: 2, name: '同步服务' })).toBeInTheDocument()
    for (const id of ['connect', 'settings', 'organizer', 'inspiration', 'about']) {
      expect(screen.getByTestId(`sync-console-nav-${id}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId('sync-status-bar')).toBeInTheDocument()
    // 默认连接视图在场
    expect(screen.getByRole('heading', { level: 3, name: '暖暖相册' })).toBeInTheDocument()
  })
})
