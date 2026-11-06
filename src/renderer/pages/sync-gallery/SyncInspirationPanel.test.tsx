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
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    nikkisync: opts.missingBridge
      ? {}
      : { listInspirations, saveInspiration, putInspirationImage, getInspirationImage }
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

  it('entry 缺失不崩面板，正常渲染列表项且无图片', async () => {
    installApi({ list: { items: [{ revision: 1 }], nextCursor: null } })
    render(<SyncInspirationPanel />)
    openPanel()
    await waitFor(() => expect(screen.getAllByTestId('inspiration-item')).toHaveLength(1))
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
