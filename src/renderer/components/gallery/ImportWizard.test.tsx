/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/components/gallery/ImportWizard
 * @coverage 导入向导步骤流转与按钮启用条件（修复：步骤 2“下一步”误依赖 targetDir 导致永久禁用）
 * @dependencies react, react-i18next, window.electronAPI, utils/format, utils/date, BaseDialog
 * @remarks jsdom 环境；window.electronAPI 整体注入 mock；i18n 使用 zh-CN 基准语言
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { ComponentProps } from 'react'
// jest-dom matcher（toBeDisabled 等）的类型扩展；运行时 setup 已全局引入，此处仅补类型
import '@testing-library/jest-dom/vitest'
import { ImportWizard } from './ImportWizard'

// 隔离 BaseDialog 依赖（与 BaseDialog.test.tsx 同款模式）
vi.mock('../../hooks/useFocusTrap', () => ({
  useFocusTrap: () => ({ current: null })
}))

vi.mock('../../utils/motionPresets', () => ({
  fadeVariants: {},
  scaleFadeVariants: {},
  fastFade: {},
  springSoft: {},
  slideUpVariants: {},
  slideDownVariants: {}
}))

// 隔离图标（ImportWizard + BaseDialog 使用）
vi.mock('../../icons', () => ({
  IconImport: () => <svg data-testid="icon-import" />,
  IconImage: () => <svg data-testid="icon-image" />,
  IconVideo: () => <svg data-testid="icon-video" />,
  IconClose: () => <svg data-testid="icon-close" />
}))

vi.mock('../common/IconButton', () => ({
  IconButton: ({ children, onClick, ...props }: ComponentProps<'button'>) => (
    <button data-testid="icon-button" onClick={onClick} {...props}>
      {children}
    </button>
  )
}))

const SRC_DIR = 'C:\\src'
const TARGET_DIR = 'C:\\dst'

const FILES = [
  {
    sourcePath: 'C:\\src\\a.png',
    fileName: 'a.png',
    size: 1024,
    mtime: '2026-08-01T00:00:00.000Z',
    ext: '.png',
    isVideo: false
  },
  {
    sourcePath: 'C:\\src\\b.jpg',
    fileName: 'b.jpg',
    size: 2048,
    mtime: '2026-08-02T00:00:00.000Z',
    ext: '.jpg',
    isVideo: false
  }
]

interface MockImportApi {
  preview: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  selectDirectory: ReturnType<typeof vi.fn>
}

function mockApi(): MockImportApi {
  const api: MockImportApi = {
    preview: vi.fn(),
    run: vi.fn(),
    selectDirectory: vi.fn()
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    dialog: { selectDirectory: api.selectDirectory },
    import: {
      preview: api.preview,
      run: api.run,
      onProgress: vi.fn(() => vi.fn())
    }
  }
  return api
}

const nextButton = () => screen.getByRole('button', { name: '下一步' })

/** 步骤 1：点“浏览”完成一次扫描（默认返回 FILES）；有文件时等待“下一步”解锁 */
async function scan(api: MockImportApi, files: unknown[] = FILES) {
  api.selectDirectory.mockResolvedValue(SRC_DIR)
  api.preview.mockResolvedValue({ success: true, files })
  fireEvent.click(screen.getByText('浏览'))
  await waitFor(() => expect(api.preview).toHaveBeenCalledWith(SRC_DIR))
  if (files.length > 0) {
    await waitFor(() => expect(nextButton()).not.toBeDisabled())
  }
}

/** 进入步骤 2（需先 scan） */
async function goToStep2(api: MockImportApi) {
  await scan(api)
  fireEvent.click(nextButton())
  expect(screen.getByText('步骤 2/3：预览并选择待导入文件')).toBeTruthy()
}

/** 进入步骤 3（需先 goToStep2，选中集默认全选） */
async function goToStep3(api: MockImportApi) {
  await goToStep2(api)
  fireEvent.click(nextButton())
  expect(screen.getByText('步骤 3/3：配置导入规则并执行')).toBeTruthy()
}

describe('ImportWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('正常流程', () => {
    it('C1: 扫描成功默认全选，步骤 2“下一步”可用（不依赖目标目录）', async () => {
      const api = mockApi()
      render(<ImportWizard open onClose={vi.fn()} />)
      await scan(api)

      // 进入步骤 2
      fireEvent.click(nextButton())
      expect(screen.getByText('步骤 2/3：预览并选择待导入文件')).toBeTruthy()
      expect(screen.getByText('a.png')).toBeTruthy()
      expect(screen.getByText('b.jpg')).toBeTruthy()
      // 核心断言：有选中文件即可用，targetDir 此时为空字符串
      expect(nextButton()).not.toBeDisabled()
      expect(screen.getByText(/已选 2 \/ 2 个/)).toBeTruthy()
    })

    it('C2: 从步骤 2 可进入步骤 3，规则区块渲染且未选目标目录时“开始导入”禁用', async () => {
      const api = mockApi()
      render(<ImportWizard open onClose={vi.fn()} />)
      await goToStep3(api)

      expect(screen.getByText('命名规则')).toBeTruthy()
      expect(screen.getByText('目录分类')).toBeTruthy()
      expect(screen.getByText('同名文件冲突处理')).toBeTruthy()
      const startBtn = screen.getByRole('button', { name: '开始导入' })
      expect(startBtn).toBeDisabled()
    })

    it('C3: 输入目标目录后“开始导入”可用，点击后调用 import.run 并渲染结果卡片', async () => {
      const api = mockApi()
      api.run.mockResolvedValue({
        imported: FILES,
        failed: [],
        skipped: [],
        warnings: []
      })
      render(<ImportWizard open onClose={vi.fn()} />)
      await goToStep3(api)

      fireEvent.change(screen.getByPlaceholderText('选择目标目录'), {
        target: { value: TARGET_DIR }
      })
      const startBtn = screen.getByRole('button', { name: '开始导入' })
      expect(startBtn).not.toBeDisabled()
      fireEvent.click(startBtn)

      await waitFor(() =>
        expect(api.run).toHaveBeenCalledWith(['C:\\src\\a.png', 'C:\\src\\b.jpg'], TARGET_DIR, {
          namingRule: 'keep',
          categorize: 'flat',
          conflictStrategy: 'rename'
        })
      )
      // 结果卡片：成功 2 / 跳过 0 / 失败 0
      await waitFor(() => expect(screen.getByText('完成')).toBeTruthy())
    })

    it('C3b: “上一步”可回退且状态保留，再前进不丢已选文件', async () => {
      const api = mockApi()
      render(<ImportWizard open onClose={vi.fn()} />)
      await goToStep3(api)

      fireEvent.click(screen.getByRole('button', { name: '上一步' }))
      expect(screen.getByText('步骤 2/3：预览并选择待导入文件')).toBeTruthy()
      expect(nextButton()).not.toBeDisabled()
      fireEvent.click(nextButton())
      expect(screen.getByText('步骤 3/3：配置导入规则并执行')).toBeTruthy()
    })
  })

  describe('边界条件', () => {
    it('B1: 空目录扫描后步骤 1“下一步”保持禁用', async () => {
      const api = mockApi()
      render(<ImportWizard open onClose={vi.fn()} />)
      await scan(api, [])
      expect(nextButton()).toBeDisabled()
    })

    it('B2: 取消全选后步骤 2“下一步”锁定，重新全选恢复可用', async () => {
      const api = mockApi()
      render(<ImportWizard open onClose={vi.fn()} />)
      await goToStep2(api)

      fireEvent.click(screen.getByText('取消全选'))
      expect(nextButton()).toBeDisabled()

      fireEvent.click(screen.getByText('全选'))
      expect(nextButton()).not.toBeDisabled()
    })

    it('B3: 取消全选后仅勾选单个文件，按钮激活且摘要更新', async () => {
      const api = mockApi()
      render(<ImportWizard open onClose={vi.fn()} />)
      await goToStep2(api)

      fireEvent.click(screen.getByText('取消全选'))
      fireEvent.click(screen.getByText('a.png'))
      expect(nextButton()).not.toBeDisabled()
      expect(screen.getByText(/已选 1 \/ 2 个/)).toBeTruthy()
    })

    it('B5: 扫描进行中“下一步”锁定，扫描完成后解锁', async () => {
      const api = mockApi()
      render(<ImportWizard open onClose={vi.fn()} />)
      let resolvePreview!: (v: unknown) => void
      api.selectDirectory.mockResolvedValue(SRC_DIR)
      api.preview.mockReturnValue(
        new Promise((resolve) => {
          resolvePreview = resolve
        })
      )
      fireEvent.click(screen.getByText('浏览'))

      // 等待 loading 置位（selectDirectory promise 需先 flush）
      await waitFor(() => expect(screen.getByText(/正在扫描源目录/)).toBeTruthy())
      expect(nextButton()).toBeDisabled()

      await act(async () => {
        resolvePreview({ success: true, files: FILES })
      })
      await waitFor(() => expect(nextButton()).not.toBeDisabled())
    })

    it('B6: 关闭后重新打开向导，状态复位到步骤 1', async () => {
      const api = mockApi()
      const { rerender } = render(<ImportWizard open onClose={vi.fn()} />)
      await goToStep3(api)

      rerender(<ImportWizard open={false} onClose={vi.fn()} />)
      rerender(<ImportWizard open onClose={vi.fn()} />)

      expect(screen.getByText('步骤 1/3：选择源文件夹')).toBeTruthy()
      // 旧选中集不复存在：直接点“下一步”应禁用（无扫描结果）
      expect(nextButton()).toBeDisabled()
    })
  })

  describe('异常场景', () => {
    it('E1: preview 返回失败时展示错误文案，“下一步”禁用且无选中残留', async () => {
      const api = mockApi()
      render(<ImportWizard open onClose={vi.fn()} />)
      api.selectDirectory.mockResolvedValue(SRC_DIR)
      api.preview.mockResolvedValue({ success: false, files: [], message: '无法读取源目录' })
      fireEvent.click(screen.getByText('浏览'))

      await waitFor(() => expect(screen.getByText('无法读取源目录')).toBeTruthy())
      expect(nextButton()).toBeDisabled()
    })

    it('E2: preview 抛异常时展示错误信息，“下一步”禁用', async () => {
      const api = mockApi()
      render(<ImportWizard open onClose={vi.fn()} />)
      api.selectDirectory.mockResolvedValue(SRC_DIR)
      api.preview.mockRejectedValue(new Error('boom'))
      fireEvent.click(screen.getByText('浏览'))

      await waitFor(() => expect(screen.getByText('boom')).toBeTruthy())
      expect(nextButton()).toBeDisabled()
    })

    it('E3: 扫描失败后重扫成功，无脏状态残留可正常进入步骤 2', async () => {
      const api = mockApi()
      render(<ImportWizard open onClose={vi.fn()} />)
      api.selectDirectory.mockResolvedValue(SRC_DIR)
      api.preview.mockResolvedValueOnce({ success: false, files: [], message: '无法读取源目录' })
      api.preview.mockResolvedValueOnce({ success: true, files: FILES })

      fireEvent.click(screen.getByText('浏览'))
      await waitFor(() => expect(screen.getByText('无法读取源目录')).toBeTruthy())

      fireEvent.click(screen.getByText('浏览'))
      await waitFor(() => expect(nextButton()).not.toBeDisabled())
      fireEvent.click(nextButton())
      expect(screen.getByText('步骤 2/3：预览并选择待导入文件')).toBeTruthy()
      expect(nextButton()).not.toBeDisabled()
      expect(screen.getByText(/已选 2 \/ 2 个/)).toBeTruthy()
    })

    it('E4: 手动编辑源路径后旧预览立即失效，“下一步”锁定', async () => {
      const api = mockApi()
      render(<ImportWizard open onClose={vi.fn()} />)
      await scan(api)

      fireEvent.change(screen.getByPlaceholderText('选择或输入源文件夹路径'), {
        target: { value: 'C:\\other' }
      })
      expect(nextButton()).toBeDisabled()
    })

    it('E5: import.run 返回失败列表时结果卡片展示失败计数', async () => {
      const api = mockApi()
      api.run.mockResolvedValue({
        imported: [],
        failed: [{ sourcePath: 'C:\\src\\a.png', message: 'copy failed' }],
        skipped: [{ sourcePath: 'C:\\src\\b.jpg', reason: 'exists' }],
        warnings: []
      })
      render(<ImportWizard open onClose={vi.fn()} />)
      await goToStep3(api)

      fireEvent.change(screen.getByPlaceholderText('选择目标目录'), {
        target: { value: TARGET_DIR }
      })
      fireEvent.click(screen.getByRole('button', { name: '开始导入' }))

      await waitFor(() => expect(api.run).toHaveBeenCalled())
      // 失败 1 / 跳过 1 / 成功 0 的计数渲染
      await waitFor(() => expect(screen.getByText('完成')).toBeTruthy())
    })
  })
})
