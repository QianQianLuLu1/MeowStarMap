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
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
function openPanel() {
  const details = screen.getByTestId('sync-inspiration-panel') as HTMLDetailsElement
  details.open = true
  fireEvent(details, new Event('toggle'))
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
