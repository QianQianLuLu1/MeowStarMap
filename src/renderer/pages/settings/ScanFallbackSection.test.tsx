/**
 * @vitest-environment jsdom
 *
 * ScanFallbackSection（需求六：多级兜底引导）单元测试
 *
 * 覆盖 5 个用例：
 *  (a) 一级兜底：选游戏根目录 → 主进程校验通过 → scanner.start({ fullScan: true, customKnownPaths }) 并持久化
 *  (b) 一级兜底校验未检出相册目录 → 明确提示但仍发起扫描（无静默失败）
 *  (c) 二级兜底：直接选 GamePlayPhotos 文件夹 → 跳过校验直接发起扫描
 *  (d) 用户取消目录选择 → 不发起扫描
 *  (e) 提权按钮 → app.relaunchAsAdmin
 *
 * 复用项目既有脚手架（tests/setup.ts）：jsdom + i18n(zh-CN) + window.electronAPI 占位。
 *
 * 运行：npx vitest run src/renderer/pages/settings/ScanFallbackSection.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ScanFallbackSection } from './scan-sections'
import { GlobalToastContext } from './shared'

vi.mock('../../icons', () => ({
  IconClose: () => <svg data-testid="icon-close" />,
  IconFolderOpen: () => <svg data-testid="icon-folder-open" />,
  IconRefresh: () => <svg data-testid="icon-refresh" />
}))

const PICKED = 'D:\\游戏\\无限暖暖'

const mockShowMessage = vi.fn()

let selectDirectory: Mock
let scannerStart: Mock
let detectGameRoots: Mock
let relaunchAsAdmin: Mock
let settingsGet: Mock
let settingsSet: Mock
let store: Record<string, unknown>

function installElectronApi() {
  store = {}
  selectDirectory = vi.fn()
  scannerStart = vi.fn().mockResolvedValue({ success: true, filesFound: 3 })
  detectGameRoots = vi.fn(() =>
    Promise.resolve([{ path: PICKED, mtimeMs: 100, hasGamePlayPhotos: true, source: 'custom' }])
  )
  relaunchAsAdmin = vi.fn().mockResolvedValue({ ok: true })
  settingsGet = vi.fn((key: string, fallback: unknown) =>
    Promise.resolve(store[key] !== undefined ? store[key] : fallback)
  )
  settingsSet = vi.fn((key: string, value: unknown) => {
    store[key] = value
    return Promise.resolve()
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    dialog: { selectDirectory },
    scanner: { start: scannerStart, detectGameRoots },
    app: { relaunchAsAdmin },
    settings: { get: settingsGet, set: settingsSet }
  }
}

function renderSection() {
  return render(
    <GlobalToastContext.Provider value={mockShowMessage}>
      <ScanFallbackSection />
    </GlobalToastContext.Provider>
  )
}

beforeEach(() => {
  installElectronApi()
  mockShowMessage.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ScanFallbackSection — 多级兜底引导（需求六）', () => {
  it('(a) 一级兜底：选择游戏根目录后校验通过并发起全盘扫描，路径持久化', async () => {
    selectDirectory.mockResolvedValue(PICKED)
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: '选择游戏安装根目录' }))

    await waitFor(() => expect(scannerStart).toHaveBeenCalledTimes(1))
    expect(scannerStart).toHaveBeenCalledWith({
      fullScan: true,
      customKnownPaths: [PICKED],
      excludedPaths: []
    })
    // 三级兜底：手动选择的路径写入配置（支持多条）
    expect(store['customScanPaths']).toEqual([PICKED])
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith('扫描完成，发现 3 个媒体文件', 'success')
    )
  })

  it('(b) 未检出官方相册时明确提示，但仍发起扫描（不静默失败）', async () => {
    detectGameRoots = vi.fn(() =>
      Promise.resolve([{ path: PICKED, mtimeMs: 100, hasGamePlayPhotos: false, source: 'custom' }])
    )
    ;(
      window as unknown as { electronAPI: { scanner: { detectGameRoots: unknown } } }
    ).electronAPI.scanner.detectGameRoots = detectGameRoots
    selectDirectory.mockResolvedValue(PICKED)
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: '选择游戏安装根目录' }))

    await waitFor(() => expect(scannerStart).toHaveBeenCalledTimes(1))
    expect(mockShowMessage).toHaveBeenCalledWith(
      '该目录下未检出官方相册（GamePlayPhotos），请确认选择的是包含 X6Game 的游戏安装根目录',
      'info'
    )
  })

  it('(c) 二级兜底：直接选择 GamePlayPhotos 文件夹时跳过根目录校验', async () => {
    selectDirectory.mockResolvedValue(PICKED)
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: '直接选择 GamePlayPhotos 文件夹' }))

    await waitFor(() => expect(scannerStart).toHaveBeenCalledTimes(1))
    expect(detectGameRoots).not.toHaveBeenCalled()
    expect(scannerStart).toHaveBeenCalledWith({
      fullScan: true,
      customKnownPaths: [PICKED],
      excludedPaths: []
    })
  })

  it('(d) 用户取消目录选择时不发起扫描', async () => {
    selectDirectory.mockResolvedValue(null)
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: '选择游戏安装根目录' }))

    await waitFor(() => expect(selectDirectory).toHaveBeenCalledTimes(1))
    expect(scannerStart).not.toHaveBeenCalled()
    expect(store['customScanPaths']).toBeUndefined()
  })

  it('(e) 点击「以管理员身份重启」调用 app:relaunchAsAdmin', async () => {
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: '以管理员身份重启' }))

    await waitFor(() => expect(relaunchAsAdmin).toHaveBeenCalledTimes(1))
    expect(mockShowMessage).toHaveBeenCalledWith('正在以管理员身份重启…', 'info')
  })
})
