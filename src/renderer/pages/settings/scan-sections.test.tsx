/**
 * @vitest-environment jsdom
 *
 * scan-sections.tsx 的域内回归（文件名与源文件同 base，使 npm run verify /
 * .husky/pre-commit 能自动把本文件绑到 scan-sections.tsx 上——此前该源文件没有匹配套件，
 * 而 ImportRootsSection / ScanFallbackSection / ScanGameRootsSection 三份按组件命名的
 * 套件都不会被 find-related-tests.ts 匹配到）。
 *
 * 钉两件事：
 *  (a) customScanPaths 必须经 utils/scan-exclusions 的 load/saveCustomScanPaths 读写。
 *      ScanPathsSection 原先裸调 settings.get 并把原始数组直接 cast 成 string[] 渲染，
 *      绕过了 normalizePathList 的非字符串/空白剔除，脏配置会原样落进 UI。
 *  (b) 四个「扫描范围」块合并到同一屏后，兜底块写入 customScanPaths 必须让同屏的
 *      只读块重新读取。拆页时这靠「切页重挂 effect」免费提供，合页后不再自动成立。
 *
 * 运行：npx vitest run src/renderer/pages/settings/scan-sections.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ScanPathsSection, ScanDirectoriesSection } from './scan-sections'
import { GlobalToastContext } from './shared'

vi.mock('../../icons', () => ({
  IconClose: () => <svg data-testid="icon-close" />,
  IconFolderOpen: () => <svg data-testid="icon-folder-open" />,
  IconRefresh: () => <svg data-testid="icon-refresh" />
}))

const mockShowMessage = vi.fn()

/** 可变的 settings 替身：customScanPaths 走真实的读-改-写链路 */
let settingsStore: Record<string, unknown>
let settingsSet: ReturnType<typeof vi.fn>

function installElectronApi(persisted: Record<string, unknown> = {}) {
  settingsStore = { ...persisted }
  settingsSet = vi.fn((key: string, value: unknown) => {
    settingsStore[key] = value
    return Promise.resolve()
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    settings: {
      get: vi.fn((key: string, fallback: unknown) =>
        Promise.resolve(settingsStore[key] !== undefined ? settingsStore[key] : fallback)
      ),
      set: settingsSet
    },
    dialog: { selectDirectory: vi.fn(async () => null) },
    scanner: {
      start: vi.fn(async () => ({ success: true, filesFound: 0 })),
      onComplete: vi.fn(() => vi.fn()),
      detectGameRoots: vi.fn(async () => [])
    },
    importRoot: { list: vi.fn(async () => []), removeRoot: vi.fn() }
  }
}

const renderWithToast = (ui: React.ReactElement) =>
  render(<GlobalToastContext.Provider value={mockShowMessage}>{ui}</GlobalToastContext.Provider>)

beforeEach(() => {
  installElectronApi()
  mockShowMessage.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ScanPathsSection — customScanPaths 读写必须过归一化', () => {
  it('(a) 剔除空串/空白/非字符串项，只渲染合法目录', async () => {
    // 脏配置：一条合法 + 一条空串 + 一条纯空白 + 一条非字符串
    installElectronApi({ customScanPaths: ['D:\\ok', '', '   ', 42] })
    renderWithToast(<ScanPathsSection />)

    await waitFor(() => expect(screen.getByText('D:\\ok')).toBeInTheDocument())
    expect(screen.getAllByRole('button', { name: '移除' })).toHaveLength(1)
    // 有合法目录时不得再出现空态文案（用完整文案做精确匹配，避免子串断言恒真）
    expect(
      screen.queryByText('未配置自定义游戏目录，扫描器将自动全盘搜索游戏特征文件', { exact: false })
    ).not.toBeInTheDocument()
  })

  it('(b) 保存时写入的是归一化后的数组，而非原始脏数据', async () => {
    installElectronApi({ customScanPaths: ['D:\\ok', ''] })
    const dialog = (
      window as unknown as {
        electronAPI: { dialog: { selectDirectory: ReturnType<typeof vi.fn> } }
      }
    ).electronAPI.dialog
    dialog.selectDirectory.mockResolvedValue('E:\\new')

    renderWithToast(<ScanPathsSection />)
    await waitFor(() => expect(screen.getByRole('button', { name: '添加游戏目录' })).toBeEnabled())

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '添加游戏目录' }))
    })

    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith('customScanPaths', ['D:\\ok', 'E:\\new'])
    )
  })
})

describe('ScanDirectoriesSection — 合并同屏后的读写一致性', () => {
  it('兜底块新增目录后，「游戏目录」块无需切页即自动列出该条', async () => {
    installElectronApi({ customScanPaths: ['D:\\existing'] })
    const dialog = (
      window as unknown as {
        electronAPI: { dialog: { selectDirectory: ReturnType<typeof vi.fn> } }
      }
    ).electronAPI.dialog
    dialog.selectDirectory.mockResolvedValue('F:\\fallback-picked')

    renderWithToast(<ScanDirectoriesSection />)
    await waitFor(() => expect(screen.getByText('D:\\existing')).toBeInTheDocument())

    const pickRootBtn = screen.getByRole('button', { name: '选择游戏安装根目录' })
    await act(async () => {
      fireEvent.click(pickRootBtn)
    })

    // 兜底块把目录写进了 customScanPaths；同屏的「游戏目录」块必须重新读到它
    await waitFor(() => expect(screen.getByText('F:\\fallback-picked')).toBeInTheDocument(), {
      timeout: 3000
    })
  })
})
