/**
 * @vitest-environment jsdom
 *
 * ImportRootsSection「添加指定目录」快捷功能单元测试
 *
 * 覆盖 5 个用例：
 *  (a) 点击按钮 → 选目录 → scanner.start({ path, fullScan: true })
 *  (b) 用户取消目录选择（返回 null）→ 不发起 scanner.start
 *  (c) scanner.start 抛异常（IPC 未注册/主进程崩溃）→ toast 错误且按钮恢复可用
 *  (d) 扫描成功（onComplete success）→ 列表刷新 + 成功 Toast
 *  (e) 扫描失败（onComplete fail）→ 失败 Toast + 列表不刷新
 *
 * 复用项目既有测试脚手架（tests/setup.ts）：jsdom + i18n(zh-CN) + window.electronAPI 占位。
 * 本文件仅按需覆盖具体 electronAPI 方法并注入 GlobalToastContext mock 以断言 Toast。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ImportRootsSection } from './scan-sections'
import { GlobalToastContext } from './shared'

// 隔离图标（避免 svg 组件副作用/控制台噪音）
vi.mock('../../icons', () => ({
  IconClose: () => <svg data-testid="icon-close" />,
  IconFolderOpen: () => <svg data-testid="icon-folder-open" />
}))

interface ScanResult {
  success: boolean
  message?: string
}

const SELECTED_DIR = 'C:\\Users\\test\\Pictures'

// 受测组件通过 useContext(GlobalToastContext) 取 showMessage；注入可断言的 mock
const mockShowMessage = vi.fn()

// 各用例共享的可变句柄（beforeEach 重新赋值）
let selectDirectory: ReturnType<typeof vi.fn>
let scannerStart: ReturnType<typeof vi.fn>
let listRoots: ReturnType<typeof vi.fn>
let onCompleteCbs: ((r: ScanResult) => void)[] = []

function installElectronApi() {
  onCompleteCbs = []
  selectDirectory = vi.fn()
  scannerStart = vi.fn().mockResolvedValue({ success: true })
  listRoots = vi.fn().mockResolvedValue([])
  const api = {
    dialog: { selectDirectory },
    scanner: {
      start: scannerStart,
      onComplete: (cb: (r: ScanResult) => void) => {
        onCompleteCbs.push(cb)
        return () => {
          // 取消订阅：从回调列表移除
          const idx = onCompleteCbs.indexOf(cb)
          if (idx >= 0) onCompleteCbs.splice(idx, 1)
        }
      }
    },
    importRoot: { list: listRoots, removeRoot: vi.fn() },
    settings: { get: vi.fn().mockResolvedValue([]), set: vi.fn() }
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = api
}

function renderSection() {
  return render(
    <GlobalToastContext.Provider value={mockShowMessage}>
      <ImportRootsSection />
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

describe('ImportRootsSection — 添加指定目录', () => {
  it('(a) 点击按钮选择目录后发起 scanner.start({ path, fullScan: true })', async () => {
    selectDirectory.mockResolvedValue(SELECTED_DIR)
    renderSection()

    const btn = screen.getByRole('button', { name: '添加指定目录' })
    await act(async () => {
      fireEvent.click(btn)
    })

    await waitFor(() => expect(scannerStart).toHaveBeenCalled())
    expect(selectDirectory).toHaveBeenCalledTimes(1)
    expect(scannerStart).toHaveBeenCalledWith({
      path: SELECTED_DIR,
      fullScan: true,
      customKnownPaths: undefined
    })
  })

  it('(b) 用户取消目录选择（返回 null）时不发起 scanner.start', async () => {
    selectDirectory.mockResolvedValue(null)
    renderSection()

    const btn = screen.getByRole('button', { name: '添加指定目录' })
    await act(async () => {
      fireEvent.click(btn)
    })

    await waitFor(() => expect(selectDirectory).toHaveBeenCalled())
    expect(scannerStart).not.toHaveBeenCalled()
  })

  it('(c) scanner.start 抛异常时给出错误 Toast 且按钮恢复可用', async () => {
    selectDirectory.mockResolvedValue(SELECTED_DIR)
    scannerStart.mockRejectedValue(new Error('ipc down'))
    renderSection()

    const btn = screen.getByRole('button', { name: '添加指定目录' })
    await act(async () => {
      fireEvent.click(btn)
    })

    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith(
        expect.stringContaining('指定目录扫描失败'),
        'error'
      )
    )
    // 兜底收口：扫描中标记复位，按钮恢复可点击
    await waitFor(() => expect(btn).toBeEnabled())
  })

  it('(d) 扫描成功（onComplete success）后刷新列表并给出成功 Toast', async () => {
    selectDirectory.mockResolvedValue(SELECTED_DIR)
    renderSection()

    const btn = screen.getByRole('button', { name: '添加指定目录' })
    await act(async () => {
      fireEvent.click(btn)
    })
    await waitFor(() => expect(scannerStart).toHaveBeenCalled())

    // 挂载时已拉取一次列表；成功后应再拉取一次
    expect(listRoots).toHaveBeenCalledTimes(1)

    await act(async () => {
      onCompleteCbs[0]({ success: true, message: '' })
    })

    await waitFor(() => expect(listRoots).toHaveBeenCalledTimes(2))
    expect(mockShowMessage).toHaveBeenCalledWith(
      expect.stringContaining('已添加指定目录'),
      'success'
    )
  })

  it('(e) 扫描失败（onComplete fail）后给出失败 Toast 且列表不刷新', async () => {
    selectDirectory.mockResolvedValue(SELECTED_DIR)
    renderSection()

    const btn = screen.getByRole('button', { name: '添加指定目录' })
    await act(async () => {
      fireEvent.click(btn)
    })
    await waitFor(() => expect(scannerStart).toHaveBeenCalled())

    expect(listRoots).toHaveBeenCalledTimes(1)

    await act(async () => {
      onCompleteCbs[0]({ success: false, message: 'boom' })
    })

    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith(
        expect.stringContaining('指定目录扫描失败'),
        'error'
      )
    )
    // 失败路径不刷新列表
    expect(listRoots).toHaveBeenCalledTimes(1)
  })
})
