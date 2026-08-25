/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/pages/GalleryPage
 * @coverage useEffect 拆分契约：media:updated 订阅独立于 currentView/showCorruptedOnly
 * @dependencies fs（源码结构检查）
 * @remarks 任务 3（P1）验证：useEffect 已拆分为两个，订阅 media:updated 的 useEffect 仅依赖
 *   [setMediaFiles]，避免依赖变化时解绑订阅导致扫描完成通知丢失。
 *
 * 测试策略：GalleryPage 依赖 VirtualImageGrid/ListView/TimelineView/MasonryView/EventTimelineView
 *   等大量子组件与 hooks，直接 render 需 mock 数十个模块且脆弱。参考项目已有的
 *   right-click-wiring.test.ts 结构性检查模式，通过源码结构验证 useEffect 拆分契约，
 *   保证测试稳定可维护。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { render, screen, waitFor, act } from '@testing-library/react'

// —— T4/D5 渲染行为测试的依赖 mock：子组件一律空渲染，EmptyState 透出 subtitle 供断言 ——
vi.mock('../components/common/EmptyState', () => ({
  EmptyState: ({ subtitle }: { subtitle?: unknown }) => (
    <div data-testid="empty-state-subtitle">{String(subtitle ?? '')}</div>
  )
}))
vi.mock('../components/common/ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('../components/common/TaskProgressOverlay', () => ({ TaskProgressOverlay: () => null }))
vi.mock('../components/common/PropertiesDialog', () => ({ PropertiesDialog: () => null }))
vi.mock('../components/common/ContextMenu', () => ({ ContextMenu: () => null }))
vi.mock('../components/common/WifiShareDialog', () => ({ WifiShareDialog: () => null }))
vi.mock('../components/common/ShareGuideDialog', () => ({ ShareGuideDialog: () => null }))
vi.mock('../components/gallery/VirtualImageGrid', () => ({ VirtualImageGrid: () => null }))
vi.mock('../components/gallery/ListView', () => ({ ListView: () => null }))
vi.mock('../components/gallery/TimelineView', () => ({ TimelineView: () => null }))
vi.mock('../components/gallery/MasonryView', () => ({ MasonryView: () => null }))
vi.mock('../components/gallery/EventTimelineView', () => ({ EventTimelineView: () => null }))
vi.mock('../components/gallery/GalleryToolbar', () => ({ GalleryToolbar: () => null }))
vi.mock('../components/gallery/BatchActions', () => ({ BatchActions: () => null }))
vi.mock('../components/gallery/RenameDialog', () => ({ RenameDialog: () => null }))
vi.mock('../components/gallery/WatermarkDialog', () => ({ WatermarkDialog: () => null }))
vi.mock('../components/gallery/SlideshowPlayer', () => ({ SlideshowPlayer: () => null }))
vi.mock('../components/gallery/BatchRenameDialog', () => ({ BatchRenameDialog: () => null }))
vi.mock('../components/gallery/ImportWizard', () => ({ ImportWizard: () => null }))
vi.mock('../components/gallery/SmartGroupPanel', () => ({ SmartGroupPanel: () => null }))
vi.mock('../components/scanner/ScanProgress', () => ({ ScanProgress: () => null }))
vi.mock('../icons', () => ({ IconImage: () => null }))
vi.mock('../hooks/useFileOperations', () => ({
  useFileOperations: () => ({
    handleOpen: vi.fn(),
    handleEdit: vi.fn(),
    handleSaveAs: vi.fn(),
    handleCopy: vi.fn(),
    handleMove: vi.fn(),
    handleRename: vi.fn(),
    handleToggleFavorite: vi.fn(),
    deleteFilesBatch: vi.fn(),
    getDeleteConfirm: vi.fn(() => ({ title: '', message: '', onConfirm: vi.fn() })),
    deleteProgress: null,
    cancelDelete: vi.fn()
  })
}))
vi.mock('../hooks/useBatchOperations', () => ({
  useBatchOperations: () => ({
    handleBatchExport: vi.fn(),
    handleBatchMove: vi.fn(),
    handleTransferToProfile: vi.fn(),
    handleBatchWatermark: vi.fn(),
    handleCancelWatermarkTask: vi.fn(),
    handleBatchRename: vi.fn(),
    setWatermarkDialog: vi.fn(),
    setWatermarkConfig: vi.fn(),
    setBatchRenameDialog: vi.fn(),
    watermarkDialog: false,
    watermarkConfig: null,
    watermarkProgress: null,
    watermarking: false,
    batchRenameDialog: false,
    selectedFiles: []
  })
}))
vi.mock('../hooks/useGallerySearch', () => ({
  useGallerySearch: () => ({ inputValue: '', setInputValue: vi.fn() })
}))
vi.mock('../hooks/useRefreshMedia', () => ({ useRefreshMedia: () => vi.fn() }))
vi.mock('../hooks/useFilteredMediaFiles', () => ({ useFilteredMediaFiles: () => [] }))
vi.mock('./settings/sections', () => ({ useGlobalToast: () => vi.fn() }))
vi.mock('../utils/gallery', () => ({ getContextMenuItems: vi.fn(() => []) }))

import { GalleryPage } from './GalleryPage'
import { useMediaStore } from '../stores/mediaStore'
import { useUIStore } from '../stores/uiStore'

const galleryPageSrc = fs.readFileSync(
  path.resolve(process.cwd(), 'src', 'renderer', 'pages', 'GalleryPage.tsx'),
  'utf-8'
)

describe('GalleryPage useEffect 拆分契约（任务 3）', () => {
  it('应存在两个独立的 useEffect 块（订阅与加载分离）', () => {
    // 统计 useEffect 调用次数（含前导空格避免匹配注释）
    const useEffectMatches = galleryPageSrc.match(/\buseEffect\(/g)
    expect(useEffectMatches, 'GalleryPage 应至少包含 2 个 useEffect 调用').not.toBeNull()
    expect(useEffectMatches!.length).toBeGreaterThanOrEqual(2)
  })

  it('useEffect 1：响应 currentView/showCorruptedOnly 变化触发首次加载', () => {
    // 定位"仅响应 currentView/showCorruptedOnly 变化触发首次加载"注释
    const refreshMarker = '仅响应 currentView/showCorruptedOnly 变化触发首次加载'
    expect(galleryPageSrc).toContain(refreshMarker)

    // 定位 useEffect 1 的依赖数组：[setMediaFiles, setLoading, currentView, showCorruptedOnly]
    const refreshBlockStart = galleryPageSrc.indexOf(refreshMarker)
    const depArrayEnd = galleryPageSrc.indexOf('])', refreshBlockStart)
    expect(depArrayEnd, 'useEffect 1 依赖数组未找到').toBeGreaterThan(refreshBlockStart)
    const refreshBlock = galleryPageSrc.slice(refreshBlockStart, depArrayEnd + 2)

    expect(refreshBlock).toContain('setMediaFiles')
    expect(refreshBlock).toContain('setLoading')
    expect(refreshBlock).toContain('currentView')
    expect(refreshBlock).toContain('showCorruptedOnly')
    expect(refreshBlock).toContain('fetchMediaFromDatabase')
  })

  it('useEffect 2：media:updated 订阅仅依赖 [setMediaFiles]（不含 currentView/showCorruptedOnly）', () => {
    // 定位"全局订阅 media:updated"注释
    const subscribeMarker = '全局订阅 media:updated，仅注册一次'
    expect(galleryPageSrc).toContain(subscribeMarker)

    const subscribeBlockStart = galleryPageSrc.indexOf(subscribeMarker)
    // 取从注释到该 useEffect 闭合 } 的片段
    const depArrayStart = galleryPageSrc.indexOf('[', subscribeBlockStart)
    const depArrayEnd = galleryPageSrc.indexOf('])', depArrayStart)
    expect(depArrayEnd, 'useEffect 2 依赖数组未找到').toBeGreaterThan(depArrayStart)
    const depArray = galleryPageSrc.slice(depArrayStart, depArrayEnd + 2)

    // 关键契约：依赖数组仅含 setMediaFiles
    expect(depArray).toContain('setMediaFiles')
    // 不应包含 currentView 或 showCorruptedOnly（避免依赖变化时解绑订阅）
    expect(depArray).not.toContain('currentView')
    expect(depArray).not.toContain('showCorruptedOnly')
  })

  it('useEffect 2：订阅 media.onUpdated 并在回调内调用 fetchMediaFromDatabase', () => {
    const subscribeMarker = '全局订阅 media:updated，仅注册一次'
    const subscribeBlockStart = galleryPageSrc.indexOf(subscribeMarker)
    // 取该 useEffect 块足够长的片段验证订阅内容
    const subscribeBlock = galleryPageSrc.slice(subscribeBlockStart, subscribeBlockStart + 600)

    expect(subscribeBlock).toContain('media')
    expect(subscribeBlock).toContain('onUpdated')
    expect(subscribeBlock).toContain('fetchMediaFromDatabase')
    expect(subscribeBlock).toContain('setMediaFiles')
  })

  it('useEffect 2：cleanup 应解绑订阅（unsubscribe）', () => {
    const subscribeMarker = '全局订阅 media:updated，仅注册一次'
    const subscribeBlockStart = galleryPageSrc.indexOf(subscribeMarker)
    const subscribeBlock = galleryPageSrc.slice(subscribeBlockStart, subscribeBlockStart + 800)

    // 验证返回的 cleanup 函数调用 unsubscribe
    expect(subscribeBlock).toContain('return')
    expect(subscribeBlock).toMatch(/unsubscribe/)
  })
})

/**
 * 回归测试：永久删除确认弹窗在确认后应自动关闭（#fix-permanent-delete-dialog）
 * 根因：handleDelete 曾直接把 fileOperations.getDeleteConfirm 返回的 onConfirm 透传为
 *   ConfirmDialog 的 onConfirm，而该回调只负责执行删除、从不关闭对话框，导致
 *   系统删除二次确认后软件内弹窗常驻不关闭。
 * 约定：沿用本文件源码结构性断言模式；断言范围严格限定在 handleDelete 函数体内，
 *   以 'const handleDelete = useCallback(' 起、下一个 '// 稳定回调' 注释止，
 *   避免误命中 handleBatchDelete / handleCleanupCorrupted 中已有的同类「关闭弹窗」写法。
 */
describe('GalleryPage handleDelete 确认后关闭弹窗（#fix-permanent-delete-dialog）', () => {
  it('handleDelete 的 onConfirm 在确认后应将确认弹窗 open 置为 false', () => {
    const startMarker = 'const handleDelete = useCallback('
    const endMarker = '  // 稳定回调'
    const startIdx = galleryPageSrc.indexOf(startMarker)
    const endIdx = galleryPageSrc.indexOf(endMarker, startIdx)
    expect(startIdx, 'handleDelete 定义未找到').toBeGreaterThan(-1)
    expect(endIdx, 'handleDelete 函数体结束标记（稳定回调注释）未找到').toBeGreaterThan(startIdx)

    // 仅截取 handleDelete 函数体（不含后续 handleBatchDelete 等），检查是否在该作用域内关闭弹窗
    const handleDeleteBlock = galleryPageSrc.slice(startIdx, endIdx)

    // 修复写法：用 finally 包裹 config.onConfirm，并在其中 setConfirmDialog(...) open:false
    expect(handleDeleteBlock).toContain('setConfirmDialog((prev) => ({ ...prev, open: false }))')
  })
})

/**
 * T4/D5：图库空状态区分「从未扫描 / 已扫描但无截图」
 * 根因：首装扫描成功后发现的全是启动器缓存图，图库按设计过滤后为空；
 *   但空态文案仍是“点击扫描按钮开始扫描”，用户误判自动扫描没生效而反复扫描。
 * 契约：挂载时查询 scanner.status（completed/failed 视为已扫描）+ 订阅 scanner.onComplete，
 *   置位 hasScanned 后空态 subtitle 切换为 emptySubtitleScanned 引导文案。
 */
describe('GalleryPage 图库空状态区分从未扫描/已扫描无截图（T4/D5）结构契约', () => {
  it('应存在 hasScanned 状态：useState(false)', () => {
    expect(galleryPageSrc).toContain('const [hasScanned, setHasScanned] = useState(false)')
  })

  it('应存在查询 scanner.status 的 useEffect：completed/failed 时置位 hasScanned，查询失败静默兜底', () => {
    const marker = 'D5：区分'
    expect(galleryPageSrc).toContain(marker)
    const blockStart = galleryPageSrc.indexOf(marker)
    const block = galleryPageSrc.slice(blockStart, blockStart + 900)

    expect(block).toContain('window.electronAPI?.scanner')
    expect(block).toContain('.status()')
    expect(block).toContain("'completed'")
    expect(block).toContain("'failed'")
    expect(block).toContain('setHasScanned(true)')
    // 查询失败不影响页面渲染（catch 兜底）
    expect(block).toContain('.catch')
  })

  it('应订阅 scanner.onComplete：扫描完成事件置位 hasScanned 并在卸载时解绑', () => {
    const marker = 'D5：区分'
    const blockStart = galleryPageSrc.indexOf(marker)
    const block = galleryPageSrc.slice(blockStart, blockStart + 900)

    expect(block).toContain('onComplete')
    expect(block).toContain('unsubscribe')
  })

  it('空状态 subtitle 应按 hasScanned 三元切换 emptySubtitleScanned / emptySubtitle（D2：仅限 gallery 视图）', () => {
    // D2（评审修复批次 B）修复后三元增加 currentView === 'gallery' 限定，prettier 需折行，
    // 先归一化空白再断言完整三元结构（视图限定 + hasScanned + 两个 i18n key）
    const normalized = galleryPageSrc.replace(/\s+/g, ' ')
    expect(normalized).toContain(
      "currentView === 'gallery' && hasScanned ? t('galleryPage.emptySubtitleScanned') : t('galleryPage.emptySubtitle')"
    )
  })
})

describe('GalleryPage 图库空状态区分从未扫描/已扫描无截图（T4/D5）渲染行为', () => {
  type ScannerStatusResult = {
    status: 'idle' | 'running' | 'completed' | 'failed'
    scanned: number
    found: number
    currentPath: string
  }
  type CompleteCallback = (result: {
    success: boolean
    message: string
    filesFound?: number
  }) => void
  let statusMock: ReturnType<typeof vi.fn>
  let onCompleteCallback: CompleteCallback | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    onCompleteCallback = null
    statusMock = vi.fn().mockResolvedValue({
      status: 'idle',
      scanned: 0,
      found: 0,
      currentPath: ''
    })
    const onCompleteMock = vi.fn((cb: CompleteCallback) => {
      onCompleteCallback = cb
      return () => {}
    })

    // electronAPI：scanner.status/onComplete + media.list/category.list（fetchMediaFromDatabase 走通返回空列表）
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      scanner: { status: statusMock, onComplete: onCompleteMock },
      media: {
        list: vi.fn().mockResolvedValue({ files: [], categories: [], total: 0, hasMore: false }),
        onUpdated: vi.fn(() => () => {})
      },
      category: { list: vi.fn().mockResolvedValue({ categories: [] }) }
    }

    // 重置 store：空媒体列表 + 默认图库视图（persist 恢复/上个用例残留均归位）
    useMediaStore.setState({
      mediaFiles: [],
      loading: false,
      scanProgress: { scanning: false, scanned: 0, found: 0, currentPath: '', status: 'idle' }
    })
    useUIStore.setState({
      currentView: 'gallery',
      viewMode: 'grid',
      selectedMediaIds: [],
      showDuplicates: false,
      showCorruptedOnly: false
    })
  })

  it('U-G：status=completed 且图库为空 → subtitle 切换为已扫描引导文案', async () => {
    statusMock.mockResolvedValue({
      status: 'completed',
      scanned: 2,
      found: 30,
      currentPath: ''
    } satisfies ScannerStatusResult)

    render(<GalleryPage />)

    // setup.ts 已初始化 zh-CN i18n，可断言 emptySubtitleScanned 真实文案
    await waitFor(() => {
      expect(screen.getByTestId('empty-state-subtitle').textContent).toContain('已完成扫描')
    })
    // 不再是“从未扫描”误导文案
    expect(screen.getByTestId('empty-state-subtitle').textContent).not.toContain('点击扫描按钮')
  })

  it('U-G①：status=idle → 仍渲染“从未扫描”默认文案', async () => {
    render(<GalleryPage />)

    await waitFor(() => {
      expect(screen.getByTestId('empty-state-subtitle').textContent).toContain(
        '点击扫描按钮开始扫描游戏截图'
      )
    })
  })

  it('U-G②：status 查询失败（reject）→ 兜底保持默认文案', async () => {
    statusMock.mockRejectedValue(new Error('boom'))

    render(<GalleryPage />)

    await waitFor(() => {
      expect(screen.getByTestId('empty-state-subtitle').textContent).toContain(
        '点击扫描按钮开始扫描游戏截图'
      )
    })
  })

  it('U-G③：status=idle 但收到 scanner:complete 事件 → hasScanned 置位切换文案', async () => {
    render(<GalleryPage />)

    await waitFor(() => {
      expect(screen.getByTestId('empty-state-subtitle').textContent).toContain(
        '点击扫描按钮开始扫描游戏截图'
      )
    })

    // 触发 scanner:complete（扫描已执行过，无论成败都算已扫描）
    expect(onCompleteCallback).not.toBeNull()
    act(() => {
      onCompleteCallback!({ success: true, message: 'done' })
    })

    await waitFor(() => {
      expect(screen.getByTestId('empty-state-subtitle').textContent).toContain('已完成扫描')
    })
  })

  it('U-H：status=completed 但 currentView=launcher-cache → 空态 subtitle 保持默认文案（D2 视图限定）', async () => {
    statusMock.mockResolvedValue({
      status: 'completed',
      scanned: 2,
      found: 30,
      currentPath: ''
    } satisfies ScannerStatusResult)
    // 已扫描用户切到空的「缓存」板块：此时显示已扫描引导文案会自指矛盾
    //（文案引导用户“前往「缓存」板块”，但用户此刻就在缓存板块）
    useUIStore.setState({ currentView: 'launcher-cache' })

    render(<GalleryPage />)

    // 等待 status 查询完成并 flush hasScanned 置位的微任务链，
    // 确保断言时置位已生效（否则修复前的文案切换尚未发生，断言会假通过）
    await waitFor(() => {
      expect(statusMock).toHaveBeenCalledTimes(1)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // 非 gallery 视图：保持「从未扫描」默认文案，不切换为已扫描引导文案
    expect(screen.getByTestId('empty-state-subtitle').textContent).toContain(
      '点击扫描按钮开始扫描游戏截图'
    )
    expect(screen.getByTestId('empty-state-subtitle').textContent).not.toContain('已完成扫描')
  })
})
