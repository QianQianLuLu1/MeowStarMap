// @vitest-environment jsdom
/**
 * 审查修复回归（2026-11-20）：桥面残缺时的兜底。
 *
 * - `window.electronAPI.nikkisync` 整体缺席（老 preload）时，K2 同意拉取不得在
 *   effect 同步体里抛 TypeError 打掉子树（`.catch` 接不到同步抛出）；
 * - `settings.get` 拒绝（主进程设置库故障）时，外壳开关观测整体失败不得变成
 *   未处理 rejection（规范 §4「与主进程交互必须 try/catch」），页面须照常渲染。
 *
 * 运行：npx vitest run src/renderer/pages/sync-gallery/console/SettingsViewBridgeGap.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SettingsView } from './SettingsView'
import {
  setupConsoleTest,
  renderView,
  installElectronApi,
  settingsGet,
  SETTING_METADATA_RESOLVER
} from './sync-console-test-utils'

beforeEach(() => {
  setupConsoleTest()
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SettingsView 桥面残缺兜底', () => {
  it('nikkisync 命名空间整体缺失 + 解析开关开 ⇒ 页面不崩（同意块隐藏）', async () => {
    installElectronApi({ persisted: { [SETTING_METADATA_RESOLVER]: true } })
    // 老 preload：只有 settings 桥，没有 nikkisync 命名空间
    ;(window.electronAPI as unknown as { nikkisync?: unknown }).nikkisync = undefined
    renderView(<SettingsView />)
    expect(await screen.findByTestId('sync-service-shell-section')).toBeInTheDocument()
  })

  it('settings.get 拒绝 ⇒ 不冒未处理 rejection，外壳开关区照常渲染', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      installElectronApi()
      settingsGet.mockRejectedValue(new Error('settings bridge down'))
      renderView(<SettingsView />)
      expect(await screen.findByTestId('sync-service-shell-section')).toBeInTheDocument()
      // 让 refreshFlags 的 rejection 有机会浮出
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
