// @vitest-environment jsdom
/**
 * N4：灵感库面板（上游 /v1/inspiration*，v1.0.29）红灯测试。
 *
 * 文案一律走 syncGallery.inspiration 命名空间，本节点不编辑 locale JSON，
 * 故测试把 useTranslation 打桩成「返回 key 本身」——断言与语言包内容解耦。
 *
 * 运行：npx vitest run src/renderer/pages/sync-gallery/SyncInspirationPanel.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

import { SyncInspirationPanel } from './SyncInspirationPanel'

const listInspirations = vi.fn()
const saveInspiration = vi.fn()
const putInspirationImage = vi.fn()
const getInspirationImage = vi.fn()
/** `onLibraryChanged` 的订阅回调（测试内手动触发库变更） */
let libraryChangedHandler: (() => void) | null = null

const ENTRY_ID = '11111111-1111-4111-8111-111111111111'
const CODE_ID = '22222222-2222-4222-8222-222222222222'

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    title: '示例灵感',
    notes: '',
    tags: [],
    categories: [],
    status: 'want',
    createdAt: 1,
    deletedAt: 0,
    code: {
      id: CODE_ID,
      rawCode: '',
      type: 'unknown',
      sourceText: '',
      sourceUrl: null,
      parsedState: 'pending',
      snapshotJson: null,
      resolverVersion: null,
      dictionaryVersion: null,
      resolvedAt: 0
    },
    images: [],
    ...overrides
  }
}

interface InstallOpts {
  list?: unknown
  listReject?: boolean
  saveReject?: boolean
  missingBridge?: boolean
}

function installApi(opts: InstallOpts = {}) {
  vi.clearAllMocks()
  listInspirations.mockImplementation(() =>
    opts.listReject
      ? Promise.reject(new Error('inspiration surface is unavailable'))
      : Promise.resolve(
          opts.list ?? { items: [{ revision: 1, entry: makeEntry() }], nextCursor: null }
        )
  )
  saveInspiration.mockImplementation(() =>
    opts.saveReject
      ? Promise.reject(new Error('conflict'))
      : Promise.resolve({ revision: 2, entry: makeEntry() })
  )
  putInspirationImage.mockResolvedValue({ ok: true })
  getInspirationImage.mockResolvedValue(null)
  libraryChangedHandler = null
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    nikkisync: opts.missingBridge
      ? {}
      : {
          listInspirations,
          saveInspiration,
          putInspirationImage,
          getInspirationImage,
          onLibraryChanged: (cb: () => void) => {
            libraryChangedHandler = cb
            return () => {
              libraryChangedHandler = null
            }
          }
        }
  }
}

/** jsdom 不会自动实现 summary 点击切换 details：显式置 open 再派发原生 toggle 事件 */
function setPanelOpen(open: boolean) {
  const details = screen.getByTestId('sync-inspiration-panel') as HTMLDetailsElement
  details.open = open
  fireEvent(details, new Event('toggle'))
}
function openPanel() {
  setPanelOpen(true)
}

beforeEach(() => installApi())
afterEach(() => vi.restoreAllMocks())

describe('SyncInspirationPanel（N4 灵感库）', () => {
  it('正常：折叠态不发 IPC，首次展开才拉列表并渲染条目', async () => {
    render(<SyncInspirationPanel />)
    expect(listInspirations).not.toHaveBeenCalled()
    openPanel()
    await waitFor(() => expect(listInspirations).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('示例灵感')).toBeInTheDocument()
  })

  it('异常：save 冲突只在本面板内联报错（不弹全局 toast）', async () => {
    installApi({ saveReject: true })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(listInspirations).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('inspiration-new'))
    fireEvent.change(screen.getByTestId('inspiration-title-input'), {
      target: { value: '新灵感' }
    })
    fireEvent.click(screen.getByTestId('inspiration-save'))
    await waitFor(() => expect(screen.getByTestId('inspiration-save-error')).toBeInTheDocument())
    expect(saveInspiration).toHaveBeenCalled()
  })

  it('边界：空列表渲染空态，不谎报条目', async () => {
    installApi({ list: { items: [], nextCursor: null } })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getByTestId('inspiration-empty')).toBeInTheDocument())
  })

  it('边界：桥缺失（老 preload）静默不渲染面板', () => {
    installApi({ missingBridge: true })
    const { container } = render(<SyncInspirationPanel />)
    expect(screen.queryByTestId('sync-inspiration-panel')).toBeNull()
    expect(container.firstChild).toBeNull()
    expect(listInspirations).not.toHaveBeenCalled()
  })
})

describe('R4：内嵌模式（控制台灵感库页）', () => {
  it('不渲染 details/summary——避免浏览器合成未翻译的匿名折叠头，且挂载即取首屏', async () => {
    const { container } = render(<SyncInspirationPanel embedded />)
    const panel = screen.getByTestId('sync-inspiration-panel')
    expect(panel.tagName).toBe('DIV')
    expect(container.querySelector('details')).toBeNull()
    expect(container.querySelector('summary')).toBeNull()
    await waitFor(() => expect(listInspirations).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('示例灵感')).toBeInTheDocument()
  })

  it('内嵌模式：上次失败 + 库变更 ⇒ 只重取一次（不重复发 fetch-all）', async () => {
    installApi({ listReject: true })
    render(<SyncInspirationPanel embedded />)
    await waitFor(() => expect(listInspirations).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('inspiration-load-error')).toBeInTheDocument())

    listInspirations.mockImplementation(() =>
      Promise.resolve({ items: [{ revision: 1, entry: makeEntry() }], nextCursor: null })
    )
    act(() => libraryChangedHandler?.())
    await waitFor(() => expect(listInspirations).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('示例灵感')).toBeInTheDocument()
  })
})

describe('B8：外部 IPC 图片数组逐项收敛（判空 + 类型守卫）', () => {
  const validImage = {
    id: 'img-1',
    sha256: 'sha-1',
    mimeType: 'image/png',
    bytes: 1,
    addedAt: 1
  }

  it('images 含 null 不崩面板，且只渲染合法图片', async () => {
    installApi({
      list: {
        items: [
          {
            revision: 1,
            entry: makeEntry({
              images: [validImage, null, { ...validImage, id: 'img-2', sha256: 'sha-2' }]
            })
          }
        ],
        nextCursor: null
      }
    })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getByText('示例灵感')).toBeInTheDocument())
    expect(screen.getAllByTestId('inspiration-image-preview')).toHaveLength(2)
  })

  it('images 元素缺 id 被收敛，不渲染脏预览', async () => {
    installApi({
      list: {
        items: [{ revision: 1, entry: makeEntry({ images: [{ sha256: 'sha-x' }] }) }],
        nextCursor: null
      }
    })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getByText('示例灵感')).toBeInTheDocument())
    expect(screen.queryAllByTestId('inspiration-image-preview')).toHaveLength(0)
  })

  it('images 为空数组不渲染图片区', async () => {
    installApi({
      list: {
        items: [{ revision: 1, entry: makeEntry({ images: [] }) }],
        nextCursor: null
      }
    })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getByText('示例灵感')).toBeInTheDocument())
    expect(screen.queryAllByTestId('inspiration-image-preview')).toHaveLength(0)
  })

  it('entry 缺失不崩面板：脏行被 filterEntries 排除，不渲染列表项与图片', async () => {
    // T8 过滤契约（inspiration-filter.test.ts 钉住）：entry 缺失/脏行直接排除，
    // 面板消费 filterEntries ⇒ 脏行不再有渲染面（旧「渲染无图片行」口径已被过滤设计取代）。
    installApi({ list: { items: [{ revision: 1 }], nextCursor: null } })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(listInspirations).toHaveBeenCalled())
    expect(screen.queryAllByTestId('inspiration-item')).toHaveLength(0)
    expect(screen.queryAllByTestId('inspiration-image-preview')).toHaveLength(0)
  })
})

describe('B9：handleImage 代次保护 + busy 防并发', () => {
  /** 绕开 jsdom 对 File.arrayBuffer / WebCrypto 的实现差异，让上传链路确定可达 putInspirationImage。 */
  function makeUploadFile(bytes: number[] = [1, 2, 3]) {
    return {
      type: 'image/png',
      arrayBuffer: async () => new Uint8Array(bytes).buffer
    }
  }

  beforeEach(() => {
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(() => 'uuid-test'),
      subtle: { digest: async () => new ArrayBuffer(32) }
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  async function openDraftWithTitle() {
    const rendered = render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(listInspirations).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('inspiration-new'))
    fireEvent.change(screen.getByTestId('inspiration-title-input'), {
      target: { value: '待上传' }
    })
    return rendered
  }

  it('连续两次上传不串代次：仅一条结果写入草稿', async () => {
    await openDraftWithTitle()
    const input = screen.getByTestId('inspiration-image-input')
    fireEvent.change(input, { target: { files: [makeUploadFile([1])] } })
    fireEvent.change(input, { target: { files: [makeUploadFile([2])] } })
    await waitFor(() => expect(screen.getByTestId('inspiration-save')).not.toBeDisabled())
    fireEvent.click(screen.getByTestId('inspiration-save'))
    await waitFor(() => expect(saveInspiration).toHaveBeenCalled())
    expect(saveInspiration.mock.calls[0][0].entry.images).toHaveLength(1)
  })

  it('卸载后在途上传回调不再 setState（不追加图片、无 React 警告）', async () => {
    let resolvePut: () => void = () => {}
    putInspirationImage.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePut = resolve
        })
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const randomUUID = globalThis.crypto.randomUUID as ReturnType<typeof vi.fn>
    const { unmount } = await openDraftWithTitle()
    fireEvent.change(screen.getByTestId('inspiration-image-input'), {
      target: { files: [makeUploadFile()] }
    })
    await waitFor(() => expect(putInspirationImage).toHaveBeenCalledTimes(1))
    const uuidCallsBefore = randomUUID.mock.calls.length
    unmount()
    resolvePut()
    await act(async () => {
      await Promise.resolve()
    })
    expect(randomUUID.mock.calls.length).toBe(uuidCallsBefore)
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('B10：加载失败可重试 + 图片失败不静默', () => {
  it('加载失败后折叠再展开能重新发起 loadList（不死锁）', async () => {
    listInspirations
      .mockRejectedValueOnce(new Error('inspiration surface is unavailable'))
      .mockResolvedValueOnce({
        items: [{ revision: 1, entry: makeEntry() }],
        nextCursor: null
      })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getByTestId('inspiration-load-error')).toBeInTheDocument())
    expect(listInspirations).toHaveBeenCalledTimes(1)
    setPanelOpen(false)
    openPanel()
    await waitFor(() => expect(listInspirations).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('示例灵感')).toBeInTheDocument()
  })

  it('图片 getInspirationImage reject 有可见反馈（不再静默留占位）', async () => {
    installApi({
      list: {
        items: [
          {
            revision: 1,
            entry: makeEntry({
              images: [
                { id: 'img-1', sha256: 'sha-1', mimeType: 'image/png', bytes: 1, addedAt: 1 }
              ]
            })
          }
        ],
        nextCursor: null
      }
    })
    getInspirationImage.mockRejectedValue(new Error('image read failed'))
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getByText('示例灵感')).toBeInTheDocument())
    await waitFor(() =>
      expect(screen.getByTestId('inspiration-image-load-error')).toBeInTheDocument()
    )
  })
})

// ============================================================================
// 审查轮：F13 imageError 复位 / F14 delete 守卫 / F15 删除 busy 门 /
// F16 灵感列表加载更多 / F19 空 mime 按失败态
// ============================================================================

/** 与 B9 同款：绕开 jsdom 对 File.arrayBuffer / WebCrypto 的实现差异。 */
function stubCryptoForUpload(): void {
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn(() => 'uuid-test'),
    subtle: { digest: async () => new ArrayBuffer(32) }
  })
}

function makeUploadFile(bytes: number[] = [1, 2, 3]): unknown {
  return {
    type: 'image/png',
    arrayBuffer: async () => new Uint8Array(bytes).buffer
  }
}

describe('审查轮：F13/F14/F15/F16/F19', () => {
  beforeEach(() => {
    stubCryptoForUpload()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('F13 上传失败后取消/新建草稿 ⇒ imageError 复位，不再误显失败标记', async () => {
    putInspirationImage.mockRejectedValueOnce(new Error('put failed'))
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(listInspirations).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('inspiration-new'))
    fireEvent.change(screen.getByTestId('inspiration-title-input'), {
      target: { value: '上传' }
    })
    fireEvent.change(screen.getByTestId('inspiration-image-input'), {
      target: { files: [makeUploadFile()] }
    })
    await waitFor(() => expect(screen.getByTestId('inspiration-image-error')).toBeInTheDocument())
    // 取消并新建：错误标记必须复位（此前共享状态残留，新草稿一打开就显示失败）
    fireEvent.click(screen.getByTestId('inspiration-cancel'))
    fireEvent.click(screen.getByTestId('inspiration-new'))
    expect(screen.queryByTestId('inspiration-image-error')).not.toBeInTheDocument()
  })

  it('F14 entry 缺失的脏行不渲染 ⇒ 无删除入口、零 saveInspiration（不递脏条目给上游）', async () => {
    installApi({ list: { items: [{ revision: 1 }], nextCursor: null } })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(listInspirations).toHaveBeenCalled())
    expect(screen.queryAllByTestId('inspiration-item')).toHaveLength(0)
    expect(screen.queryByTestId('inspiration-delete')).not.toBeInTheDocument()
    expect(saveInspiration).not.toHaveBeenCalled()
  })

  it('F15 busy 期间删除被禁用且不执行（在途保存不被过期 baseRevision 撞 conflict）', async () => {
    let resolveSave: () => void = () => {}
    saveInspiration.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
        })
    )
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getByText('示例灵感')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('inspiration-new'))
    fireEvent.change(screen.getByTestId('inspiration-title-input'), {
      target: { value: '在途保存' }
    })
    fireEvent.click(screen.getByTestId('inspiration-save'))
    await waitFor(() => expect(saveInspiration).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('inspiration-delete')).toBeDisabled()
    fireEvent.click(screen.getByTestId('inspiration-delete'))
    expect(saveInspiration).toHaveBeenCalledTimes(1)
    resolveSave()
    await waitFor(() => expect(screen.getByTestId('inspiration-delete')).not.toBeDisabled())
  })

  it('F16 列表 nextCursor 有值 ⇒ 显示加载更多，点击消费游标追加下一页', async () => {
    installApi({
      list: {
        items: [{ revision: 1, entry: makeEntry({ title: '第一页' }) }],
        nextCursor: 'cursor-1'
      }
    })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getByText('第一页')).toBeInTheDocument())
    const more = screen.getByTestId('inspiration-load-more')
    listInspirations.mockResolvedValueOnce({
      items: [{ revision: 2, entry: makeEntry({ title: '第二页' }) }],
      nextCursor: null
    })
    fireEvent.click(more)
    await waitFor(() => expect(screen.getByText('第二页')).toBeInTheDocument())
    expect(listInspirations).toHaveBeenLastCalledWith({ limit: 100, after: 'cursor-1' })
    // 游标耗尽 ⇒ 按钮消失
    await waitFor(() =>
      expect(screen.queryByTestId('inspiration-load-more')).not.toBeInTheDocument()
    )
    expect(screen.getByText('第一页')).toBeInTheDocument()
  })

  it('F19 回捞图片缺 mimeType ⇒ 按失败态显示，不产出非法 data URL', async () => {
    installApi({
      list: {
        items: [
          {
            revision: 1,
            entry: makeEntry({
              images: [
                { id: 'img-1', sha256: 'sha-1', mimeType: 'image/png', bytes: 1, addedAt: 1 }
              ]
            })
          }
        ],
        nextCursor: null
      }
    })
    getInspirationImage.mockResolvedValue({ mimeType: '', bytesBase64: 'aa' })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getByText('示例灵感')).toBeInTheDocument())
    await waitFor(() =>
      expect(screen.getByTestId('inspiration-image-load-error')).toBeInTheDocument()
    )
  })
})

// ============================================================================
// T8：fetch-all 全量翻页 / 过滤条 / 手动刷新 / 15s 节流自动刷新（fake timers）
// ============================================================================

describe('T8：fetch-all 沿游标取全量', () => {
  it('多页游标逐页取全：limit=100 + after 链，游标耗尽即停且无加载更多', async () => {
    listInspirations
      .mockResolvedValueOnce({
        items: [{ revision: 1, entry: makeEntry({ title: '甲' }) }],
        nextCursor: 'c1'
      })
      .mockResolvedValueOnce({
        items: [
          {
            revision: 1,
            entry: makeEntry({ id: '33333333-3333-4333-8333-333333333333', title: '乙' })
          }
        ],
        nextCursor: 'c2'
      })
      .mockResolvedValueOnce({ items: [], nextCursor: null })
    render(<SyncInspirationPanel />)
    openPanel()
    expect(await screen.findByText('甲')).toBeInTheDocument()
    expect(screen.getByText('乙')).toBeInTheDocument()
    expect(listInspirations).toHaveBeenCalledTimes(3)
    expect(listInspirations.mock.calls[0][0]).toEqual({ limit: 100 })
    expect(listInspirations.mock.calls[1][0]).toEqual({ limit: 100, after: 'c1' })
    expect(listInspirations.mock.calls[2][0]).toEqual({ limit: 100, after: 'c2' })
    expect(screen.queryByTestId('inspiration-load-more')).not.toBeInTheDocument()
  })

  it('游标往复（c1→c2→c1）⇒ 重复游标即停，不得无限翻页', async () => {
    listInspirations
      .mockResolvedValueOnce({
        items: [{ revision: 1, entry: makeEntry({ title: '甲' }) }],
        nextCursor: 'c1'
      })
      .mockResolvedValueOnce({ items: [], nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: [], nextCursor: 'c1' })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getByText('甲')).toBeInTheDocument())
    // 第三次拿到的 c1 已走过 ⇒ 立即停（不进入 c1→c2→c1 的死循环）
    await waitFor(() => expect(listInspirations).toHaveBeenCalledTimes(3))
    expect(screen.getByTestId('inspiration-load-more')).toBeInTheDocument()
  })

  it('竞态：加载更多在途时整刷顶掉代次 ⇒ 按钮不得永久禁用', async () => {
    installApi({
      list: {
        items: [{ revision: 1, entry: makeEntry({ title: '第一页' }) }],
        nextCursor: 'cursor-1'
      }
    })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getByText('第一页')).toBeInTheDocument())
    // 续页挂起不返回
    let resolveMore: (value: unknown) => void = () => {}
    listInspirations.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMore = resolve
        })
    )
    fireEvent.click(screen.getByTestId('inspiration-load-more'))
    // 在途期间整表刷新：代次被顶掉，续页响应回来时必须被丢弃
    listInspirations.mockResolvedValueOnce({
      items: [{ revision: 1, entry: makeEntry({ title: '刷新页' }) }],
      nextCursor: 'cursor-1'
    })
    fireEvent.click(screen.getByTestId('inspiration-refresh'))
    await waitFor(() => expect(screen.getByText('刷新页')).toBeInTheDocument())
    await act(async () => {
      resolveMore({ items: [], nextCursor: null })
    })
    // 代次已作废 ⇒ loadingMore 必须复位，否则按钮被 disabled + 守卫双封，非重挂载不可恢复
    await waitFor(() => expect(screen.getByTestId('inspiration-load-more')).not.toBeDisabled())
  })

  it('跨页重复 id+revision 去重（游标抖动不得产出重复行）', async () => {
    listInspirations
      .mockResolvedValueOnce({
        items: [{ revision: 1, entry: makeEntry() }],
        nextCursor: 'c1'
      })
      .mockResolvedValueOnce({
        items: [{ revision: 1, entry: makeEntry() }],
        nextCursor: null
      })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(listInspirations).toHaveBeenCalledTimes(2))
    expect(screen.getAllByTestId('inspiration-item')).toHaveLength(1)
  })
})

describe('T8：过滤条（搜索/分类/状态）与手动刷新', () => {
  const FILTER_ITEMS = {
    items: [
      {
        revision: 1,
        entry: makeEntry({ title: '红裙染色', categories: ['裙装'], status: 'want' })
      },
      {
        revision: 1,
        entry: makeEntry({
          id: '33333333-3333-4333-8333-333333333333',
          title: '外套搭配',
          categories: ['外套'],
          status: 'reproduced',
          tags: ['保暖']
        })
      }
    ],
    nextCursor: null
  }

  it('搜索命中标题/标签 haystack；分类与状态精确过滤；无命中给过滤空态', async () => {
    installApi({ list: FILTER_ITEMS })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getAllByTestId('inspiration-item')).toHaveLength(2))
    expect(screen.getByTestId('inspiration-count-note')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('inspiration-search'), { target: { value: '保暖' } })
    expect(screen.getAllByTestId('inspiration-item')).toHaveLength(1)
    expect(screen.getByText('外套搭配')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('inspiration-search'), { target: { value: '' } })
    fireEvent.change(screen.getByTestId('inspiration-category-filter'), {
      target: { value: '裙装' }
    })
    expect(screen.getAllByTestId('inspiration-item')).toHaveLength(1)
    expect(screen.getByText('红裙染色')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('inspiration-category-filter'), {
      target: { value: '' }
    })
    fireEvent.change(screen.getByTestId('inspiration-status-filter'), {
      target: { value: 'reproduced' }
    })
    expect(screen.getAllByTestId('inspiration-item')).toHaveLength(1)
    expect(screen.getByText('外套搭配')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('inspiration-status-filter'), {
      target: { value: 'archived' }
    })
    expect(screen.queryAllByTestId('inspiration-item')).toHaveLength(0)
    expect(screen.getByTestId('inspiration-filter-empty')).toBeInTheDocument()
    // 过滤空态 ≠ 库空态（不谎报「没有灵感」）
    expect(screen.queryByTestId('inspiration-empty')).not.toBeInTheDocument()
  })

  it('手动刷新按钮重取全量列表', async () => {
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(listInspirations).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId('inspiration-refresh'))
    await waitFor(() => expect(listInspirations).toHaveBeenCalledTimes(2))
  })
})

describe('T8：15s 节流自动刷新（fake timers，上游 maybeRefresh 判据）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  async function flush(ms = 0) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it('可见 + 展开：15s 内不重取，到点才刷；卸载后定时器清零', async () => {
    vi.useFakeTimers()
    render(<SyncInspirationPanel autoRefreshVisible />)
    openPanel()
    await flush()
    expect(listInspirations).toHaveBeenCalledTimes(1)
    await flush(10000)
    expect(listInspirations).toHaveBeenCalledTimes(1)
    await flush(5000)
    expect(listInspirations).toHaveBeenCalledTimes(2)
    await flush(15000)
    expect(listInspirations).toHaveBeenCalledTimes(3)
  })

  it('编辑器打开期间跳过自动刷新；关闭后恢复', async () => {
    vi.useFakeTimers()
    render(<SyncInspirationPanel autoRefreshVisible />)
    openPanel()
    await flush()
    fireEvent.click(screen.getByTestId('inspiration-new'))
    await flush(30000)
    expect(listInspirations).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('inspiration-cancel'))
    await flush(15000)
    expect(listInspirations).toHaveBeenCalledTimes(2)
  })

  it('折叠态不自动刷新；不可见（缺省门控）不留定时器；卸载清零', async () => {
    vi.useFakeTimers()
    const { unmount } = render(<SyncInspirationPanel autoRefreshVisible />)
    openPanel()
    await flush()
    setPanelOpen(false)
    await flush(30000)
    expect(listInspirations).toHaveBeenCalledTimes(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)

    // 缺省门控：currentView 非 sync-inspiration（uiStore 初始 gallery）⇒ 零定时器
    const second = render(<SyncInspirationPanel />)
    openPanel()
    await flush()
    expect(vi.getTimerCount()).toBe(0)
    await flush(30000)
    expect(listInspirations).toHaveBeenCalledTimes(2)
    second.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('桥缺失 ⇒ 不渲染也不留定时器', () => {
    vi.useFakeTimers()
    installApi({ missingBridge: true })
    render(<SyncInspirationPanel autoRefreshVisible />)
    expect(vi.getTimerCount()).toBe(0)
  })
})

// ============================================================================
// T9：编辑器字段（标签/分类/五态/分享码）与列表卡徽标
// ============================================================================

describe('T9：编辑器字段与保存语义', () => {
  it('新建：逗号/顿号拆分去重 tags/categories；五态落库；rawCode 不臆造解析结果', async () => {
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(listInspirations).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('inspiration-new'))
    fireEvent.change(screen.getByTestId('inspiration-title-input'), {
      target: { value: '新灵感' }
    })
    fireEvent.change(screen.getByTestId('inspiration-tags-input'), {
      target: { value: '染色, 搭配，染色' }
    })
    fireEvent.change(screen.getByTestId('inspiration-categories-input'), {
      target: { value: '裙装、 外套' }
    })
    fireEvent.change(screen.getByTestId('inspiration-status-input'), {
      target: { value: 'reproduced' }
    })
    fireEvent.change(screen.getByTestId('inspiration-code-input'), {
      target: { value: 'a=1abcdefghij#' }
    })
    fireEvent.click(screen.getByTestId('inspiration-save'))
    await waitFor(() => expect(saveInspiration).toHaveBeenCalled())
    const entry = saveInspiration.mock.calls[0][0].entry
    expect(entry.tags).toEqual(['染色', '搭配'])
    expect(entry.categories).toEqual(['裙装', '外套'])
    expect(entry.status).toBe('reproduced')
    expect(entry.code.rawCode).toBe('a=1abcdefghij#')
    // 新建 code 只给基线空形态，不臆造 type/快照
    expect(entry.code.type).toBe('unknown')
    expect(entry.code.parsedState).toBe('pending')
    expect(entry.code.snapshotJson).toBeNull()
  })

  it('编辑回填：tags/categories join、状态、rawCode；码未变 ⇒ 基线 code 原样保留', async () => {
    const baseCode = {
      ...makeEntry().code,
      rawCode: 'old-code',
      type: 'dye',
      parsedState: 'resolved',
      snapshotJson: '{"k":1}',
      resolverVersion: 'r1',
      dictionaryVersion: 'd1',
      resolvedAt: 42
    }
    installApi({
      list: {
        items: [
          {
            revision: 3,
            entry: makeEntry({
              tags: ['x', 'y'],
              categories: ['裙装'],
              status: 'tried',
              code: baseCode
            })
          }
        ],
        nextCursor: null
      }
    })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getByText('示例灵感')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('inspiration-edit'))
    expect(screen.getByTestId('inspiration-tags-input')).toHaveValue('x, y')
    expect(screen.getByTestId('inspiration-categories-input')).toHaveValue('裙装')
    expect(screen.getByTestId('inspiration-status-input')).toHaveValue('tried')
    expect(screen.getByTestId('inspiration-code-input')).toHaveValue('old-code')
    fireEvent.click(screen.getByTestId('inspiration-save'))
    await waitFor(() => expect(saveInspiration).toHaveBeenCalled())
    const saved = saveInspiration.mock.calls[0][0]
    expect(saved.baseRevision).toBe(3)
    expect(saved.entry.code).toEqual(baseCode)
  })

  it('编辑改码 ⇒ parsedState 回 pending、快照/版本/时间清空（type 保留，交上游重解析）', async () => {
    const baseCode = {
      ...makeEntry().code,
      rawCode: 'old-code',
      type: 'dye',
      parsedState: 'resolved',
      snapshotJson: '{"k":1}',
      resolverVersion: 'r1',
      dictionaryVersion: 'd1',
      resolvedAt: 42
    }
    installApi({
      list: { items: [{ revision: 3, entry: makeEntry({ code: baseCode }) }], nextCursor: null }
    })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getByText('示例灵感')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('inspiration-edit'))
    fireEvent.change(screen.getByTestId('inspiration-code-input'), {
      target: { value: 'new-code' }
    })
    fireEvent.click(screen.getByTestId('inspiration-save'))
    await waitFor(() => expect(saveInspiration).toHaveBeenCalled())
    const code = saveInspiration.mock.calls[0][0].entry.code
    expect(code.rawCode).toBe('new-code')
    expect(code.type).toBe('dye')
    expect(code.parsedState).toBe('pending')
    expect(code.snapshotJson).toBeNull()
    expect(code.resolverVersion).toBeNull()
    expect(code.dictionaryVersion).toBeNull()
    expect(code.resolvedAt).toBe(0)
  })

  it('备注中的候选分享码给识别提示；点击采纳写入 rawCode；无候选不渲染提示', async () => {
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(listInspirations).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('inspiration-new'))
    expect(screen.queryByTestId('inspiration-code-hint')).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('inspiration-notes-input'), {
      target: { value: '试试 a=1abcdefghij# 这个码' }
    })
    const hint = await screen.findByTestId('inspiration-code-hint')
    fireEvent.click(hint)
    // 上游 insCandidates 逐字判据：'=' 非字母数字，回看即停 ⇒ 候选为 11 位码体 + '#'
    // （inspiration-filter.test.ts「回看遇 ASCII 标点即停」钉住同一口径）
    expect(screen.getByTestId('inspiration-code-input')).toHaveValue('1abcdefghij#')
  })

  it('未知状态收敛为 want（不臆造枚举外值）', async () => {
    installApi({
      list: {
        items: [{ revision: 1, entry: makeEntry({ status: 'alien-state' }) }],
        nextCursor: null
      }
    })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getByText('示例灵感')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('inspiration-edit'))
    expect(screen.getByTestId('inspiration-status-input')).toHaveValue('want')
  })
})

describe('T9：列表卡状态徽标 / 标签 chips / 分享码片段', () => {
  it('已知状态渲染徽标，tags 渲染 chips，rawCode 渲染片段', async () => {
    installApi({
      list: {
        items: [
          {
            revision: 1,
            entry: makeEntry({
              status: 'reproduced',
              tags: ['染色', '搭配'],
              code: { ...makeEntry().code, rawCode: 'a=1abcdefghij#' }
            })
          }
        ],
        nextCursor: null
      }
    })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getByText('示例灵感')).toBeInTheDocument())
    expect(screen.getByTestId('inspiration-status-badge')).toHaveTextContent(
      'syncGallery.inspiration.status.reproduced'
    )
    expect(screen.getAllByTestId('inspiration-tag-chip')).toHaveLength(2)
    expect(screen.getByTestId('inspiration-code-snippet')).toHaveTextContent('a=1abcdefghij#')
  })

  it('未知状态不渲染徽标；无 tags/码不占位', async () => {
    installApi({
      list: {
        items: [{ revision: 1, entry: makeEntry({ status: 'alien-state' }) }],
        nextCursor: null
      }
    })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getByText('示例灵感')).toBeInTheDocument())
    expect(screen.queryByTestId('inspiration-status-badge')).not.toBeInTheDocument()
    expect(screen.queryAllByTestId('inspiration-tag-chip')).toHaveLength(0)
    expect(screen.queryByTestId('inspiration-code-snippet')).not.toBeInTheDocument()
  })
})
