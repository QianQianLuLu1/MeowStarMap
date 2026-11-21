/**
 * @vitest-environment jsdom
 *
 * AppearanceDisplaySection（字体与显示）单元测试——聚焦玻璃效果档位（display.glassEffect）：
 *  (a) 持久化为 lite 时启动应用 html.glass-lite 类
 *  (b) 持久化为 rich / 非法值时不应用 glass-lite
 *  (c) 切换到 lite：写设置 + 挂类 + toast 反馈
 *  (d) 切换回 rich：写设置 + 摘类 + toast 反馈
 *
 * 复用项目既有脚手架（tests/setup.ts）：jsdom + i18n(zh-CN) + window.electronAPI 占位。
 *
 * 运行：npx vitest run src/renderer/pages/settings/AppearanceDisplaySection.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { AppearanceDisplaySection, normalizeGlassEffect } from './appearance-sections'
import { GlobalToastContext } from './shared'
import {
  __resetGlassDegradationForTest,
  detectSoftwareRendering
} from '../../utils/glass-degradation'

const mockShowMessage = vi.fn()

let settingsGet: Mock
let settingsSet: Mock
let store: Record<string, unknown>

function installElectronApi(persisted: Record<string, unknown> = {}) {
  store = { ...persisted }
  settingsGet = vi.fn((key: string, fallback: unknown) =>
    Promise.resolve(store[key] !== undefined ? store[key] : fallback)
  )
  settingsSet = vi.fn((key: string, value: unknown) => {
    store[key] = value
    return Promise.resolve()
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    settings: { get: settingsGet, set: settingsSet }
  }
}

function renderSection() {
  return render(
    <GlobalToastContext.Provider value={mockShowMessage}>
      <AppearanceDisplaySection />
    </GlobalToastContext.Provider>
  )
}

const htmlClasses = () => document.documentElement.className

beforeEach(() => {
  installElectronApi()
  mockShowMessage.mockClear()
  __resetGlassDegradationForTest()
  document.documentElement.className = ''
})

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.className = ''
})

describe('AppearanceDisplaySection — 玻璃效果档位', () => {
  it('(a) 持久化为 lite 时，挂载后应用 html.glass-lite 类', async () => {
    installElectronApi({ 'display.glassEffect': 'lite' })
    renderSection()
    await waitFor(() => expect(htmlClasses()).toContain('glass-lite'))
  })

  it('(b) 持久化为 rich 或非法值时，不应用 glass-lite', async () => {
    installElectronApi({ 'display.glassEffect': 'garbage' })
    renderSection()
    await waitFor(() => expect(settingsGet).toHaveBeenCalledWith('display.glassEffect', 'rich'))
    expect(htmlClasses()).not.toContain('glass-lite')
  })

  it('(c) 点击「轻度增强」：写设置 + 挂 glass-lite 类 + toast 反馈', async () => {
    renderSection()
    await waitFor(() => expect(screen.getByText('玻璃效果')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('radio', { name: '轻度增强' }))

    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('display.glassEffect', 'lite'))
    expect(htmlClasses()).toContain('glass-lite')
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalled())
  })

  it('(d) 点击「明显流动感」：写设置 + 摘 glass-lite 类 + toast 反馈', async () => {
    installElectronApi({ 'display.glassEffect': 'lite' })
    renderSection()
    await waitFor(() => expect(htmlClasses()).toContain('glass-lite'))

    fireEvent.click(screen.getByRole('radio', { name: '明显流动感' }))

    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('display.glassEffect', 'rich'))
    expect(htmlClasses()).not.toContain('glass-lite')
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalled())
  })
})

describe('normalizeGlassEffect', () => {
  it("仅 'lite' 归一为 lite，其余一律回退 rich", () => {
    expect(normalizeGlassEffect('lite')).toBe('lite')
    expect(normalizeGlassEffect('rich')).toBe('rich')
    expect(normalizeGlassEffect('garbage')).toBe('rich')
    expect(normalizeGlassEffect(undefined)).toBe('rich')
    expect(normalizeGlassEffect(null)).toBe('rich')
  })
})

/** 在既有 electronAPI 桩上补 app.getGpuStatus 并预热探测缓存（模拟 App 启动期已探测） */
async function primeGpuStatus(status: {
  hardwareAcceleration: { enabled: boolean; reason?: string }
  fallback: { compatLevel: number }
}) {
  const api = (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI
  api.app = { getGpuStatus: vi.fn(async () => status) }
  await detectSoftwareRendering()
}

describe('AppearanceDisplaySection — 软件渲染自动降级（2026-11-20 N1）', () => {
  afterEach(() => {
    __resetGlassDegradationForTest()
  })

  it('软件渲染（level2）下持久化为 rich，挂载后仍应用 html.glass-lite', async () => {
    installElectronApi({ 'display.glassEffect': 'rich' })
    await primeGpuStatus({
      hardwareAcceleration: { enabled: false, reason: 'user-disabled' },
      fallback: { compatLevel: 2 }
    })
    renderSection()
    await waitFor(() => expect(settingsGet).toHaveBeenCalledWith('display.glassEffect', 'rich'))
    expect(htmlClasses()).toContain('glass-lite')
  })

  it('软件渲染下点击「明显流动感」：设置照写 rich，但根类保持 glass-lite（不得覆写自动降级）', async () => {
    installElectronApi({ 'display.glassEffect': 'lite' })
    await primeGpuStatus({
      hardwareAcceleration: { enabled: false, reason: 'crash-fallback' },
      fallback: { compatLevel: 1 }
    })
    renderSection()
    await waitFor(() => expect(htmlClasses()).toContain('glass-lite'))

    fireEvent.click(screen.getByRole('radio', { name: '明显流动感' }))

    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('display.glassEffect', 'rich'))
    expect(htmlClasses()).toContain('glass-lite')
  })

  it('守卫：硬件健康时 rich 不挂 glass-lite（自动降级不得误伤健康机器）', async () => {
    installElectronApi({ 'display.glassEffect': 'rich' })
    await primeGpuStatus({
      hardwareAcceleration: { enabled: true, reason: 'default' },
      fallback: { compatLevel: 0 }
    })
    renderSection()
    await waitFor(() => expect(settingsGet).toHaveBeenCalledWith('display.glassEffect', 'rich'))
    expect(htmlClasses()).not.toContain('glass-lite')
  })
})
