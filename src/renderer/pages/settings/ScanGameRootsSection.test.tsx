/**
 * @vitest-environment jsdom
 *
 * GameRootsSection（需求三.3：多游戏目录选择）单元测试
 *
 * 覆盖 4 个用例：
 *  (a) 首次进入：默认勾选「含 GamePlayPhotos 且 mtime 最新」者，其余写入排除集并落初始化标记
 *  (b) 已初始化：按已保存排除集回显勾选状态
 *  (c) 取消勾选 → 该目录写入 excludedScanPaths
 *  (d) detectGameRoots 失败 → 展示失败原因与重试按钮，点击重试重新调用
 *
 * 复用项目既有脚手架（tests/setup.ts）：jsdom + i18n(zh-CN) + window.electronAPI 占位，
 * 与 ImportRootsSection.test.tsx 同构。
 *
 * 运行：npx vitest run src/renderer/pages/settings/ScanGameRootsSection.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { GameRootsSection } from './scan-sections'
import { GlobalToastContext } from './shared'

// 隔离图标（避免 svg 组件副作用）
vi.mock('../../icons', () => ({
  IconClose: () => <svg data-testid="icon-close" />,
  IconFolderOpen: () => <svg data-testid="icon-folder-open" />,
  IconRefresh: () => <svg data-testid="icon-refresh" />
}))

interface Candidate {
  path: string
  mtimeMs: number
  hasGamePlayPhotos: boolean
  source: 'custom' | 'official' | 'steam' | 'epic'
}

const CANDIDATES: Candidate[] = [
  { path: 'D:\\Games\\Old', mtimeMs: 1000, hasGamePlayPhotos: true, source: 'official' },
  { path: 'E:\\Games\\New', mtimeMs: 3000, hasGamePlayPhotos: true, source: 'official' },
  { path: 'F:\\Games\\NoAlbum', mtimeMs: 2000, hasGamePlayPhotos: false, source: 'steam' }
]

const mockShowMessage = vi.fn()

let detectGameRoots: Mock
let settingsGet: Mock
let settingsSet: Mock
let store: Record<string, unknown>

function installElectronApi(options?: { detectImpl?: () => Promise<unknown> }) {
  store = {}
  settingsGet = vi.fn((key: string, fallback: unknown) =>
    Promise.resolve(store[key] !== undefined ? store[key] : fallback)
  )
  settingsSet = vi.fn((key: string, value: unknown) => {
    store[key] = value
    return Promise.resolve()
  })
  detectGameRoots = vi.fn(
    options?.detectImpl ?? (() => Promise.resolve(CANDIDATES.map((c) => ({ ...c }))))
  )
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    settings: { get: settingsGet, set: settingsSet },
    scanner: { detectGameRoots }
  }
}

function renderSection() {
  return render(
    <GlobalToastContext.Provider value={mockShowMessage}>
      <GameRootsSection />
    </GlobalToastContext.Provider>
  )
}

function checkboxOf(path: string): HTMLInputElement {
  return screen.getByLabelText(path) as HTMLInputElement
}

beforeEach(() => {
  installElectronApi()
  mockShowMessage.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GameRootsSection — 多游戏目录选择（需求三.3）', () => {
  it('(a) 首次进入默认勾选含相册且 mtime 最新者，其余写入排除集', async () => {
    renderSection()

    await waitFor(() => expect(checkboxOf('E:\\Games\\New')).toBeInTheDocument())
    await waitFor(() => expect(checkboxOf('E:\\Games\\New').checked).toBe(true))

    expect(checkboxOf('D:\\Games\\Old').checked).toBe(false)
    expect(checkboxOf('F:\\Games\\NoAlbum').checked).toBe(false)

    // 排除集 = 未勾选的两项；并写入初始化标记
    await waitFor(() =>
      expect(store['excludedScanPaths']).toEqual(['D:\\Games\\Old', 'F:\\Games\\NoAlbum'])
    )
    expect(store['gameRootsSelectionInitialized']).toBe(true)
  })

  it('(b) 已初始化时按已保存排除集回显勾选状态', async () => {
    store['gameRootsSelectionInitialized'] = true
    store['excludedScanPaths'] = ['E:\\Games\\New']
    renderSection()

    await waitFor(() => expect(checkboxOf('E:\\Games\\New')).toBeInTheDocument())
    expect(checkboxOf('E:\\Games\\New').checked).toBe(false)
    expect(checkboxOf('D:\\Games\\Old').checked).toBe(true)
    expect(checkboxOf('F:\\Games\\NoAlbum').checked).toBe(true)
  })

  it('(c) 取消勾选后该目录写入 excludedScanPaths', async () => {
    store['gameRootsSelectionInitialized'] = true
    store['excludedScanPaths'] = []
    renderSection()

    await waitFor(() => expect(checkboxOf('E:\\Games\\New')).toBeInTheDocument())
    fireEvent.click(checkboxOf('E:\\Games\\New'))

    await waitFor(() => expect(store['excludedScanPaths']).toEqual(['E:\\Games\\New']))
    expect(checkboxOf('E:\\Games\\New').checked).toBe(false)
  })

  it('(d) detectGameRoots 失败时展示原因与重试按钮，点击重试重新调用', async () => {
    installElectronApi({ detectImpl: () => Promise.reject(new Error('IPC_UNAVAILABLE')) })
    renderSection()

    const retry = await waitFor(() => screen.getByRole('button', { name: '重试' }))
    expect(screen.getByText(/检测游戏目录失败/)).toBeInTheDocument()
    expect(detectGameRoots).toHaveBeenCalledTimes(1)

    fireEvent.click(retry)
    await waitFor(() => expect(detectGameRoots).toHaveBeenCalledTimes(2))
  })
})
