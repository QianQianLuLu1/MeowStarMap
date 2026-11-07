// @vitest-environment jsdom
/**
 * SyncInspirationPage（灵感库二级子页，层级 2）单元测试。
 *
 * N4 面板从 SyncServicePage 迁出为独立二级页后的页面级契约（面板自身行为由
 * SyncInspirationPanel.test.tsx 覆盖，这里只锁「页面壳 + 挂载面板」的装配语义）：
 *  (a) 页壳渲染 PageHeader（h2 标题复用 syncGallery.inspiration.title =「灵感库」）并挂载面板本体
 *  (b) 桥缺失（nikkisync 桥无灵感库方法）时页面壳仍渲染，面板静默隐藏（与面板既有守卫同口径）
 *  (c) 进页（面板折叠态）不发 IPC：列表拉取只由展开触发（面板既有契约，页面级不得破坏）
 *
 * 运行：npx vitest run src/renderer/pages/sync-gallery/SyncInspirationPage.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SyncInspirationPage } from './SyncInspirationPage'

/** 仿 SyncServicePage.test.tsx：整只替换 window.electronAPI（tests/setup.ts 的占位桩是单层 Proxy）。 */
function installApi(opts: { missingBridge?: boolean } = {}) {
  const listInspirations = vi.fn(async () => ({ items: [], nextCursor: null }))
  const nikkisync = opts.missingBridge
    ? {}
    : {
        listInspirations,
        saveInspiration: vi.fn(async () => ({ revision: 1, entry: {} })),
        putInspirationImage: vi.fn(async () => ({ ok: true })),
        getInspirationImage: vi.fn(async () => null)
      }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { nikkisync }
  return { listInspirations }
}

describe('SyncInspirationPage（灵感库二级子页）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('(a) 页壳渲染 h2「灵感库」并挂载灵感库面板本体', () => {
    installApi()
    render(<SyncInspirationPage />)
    expect(screen.getByRole('heading', { level: 2, name: '灵感库' })).toBeInTheDocument()
    expect(screen.getByTestId('sync-inspiration-summary')).toBeInTheDocument()
  })

  it('(b) 桥缺失（nikkisync 桥无灵感库方法）时页面壳仍渲染，面板静默隐藏', () => {
    installApi({ missingBridge: true })
    render(<SyncInspirationPage />)
    expect(screen.getByRole('heading', { level: 2, name: '灵感库' })).toBeInTheDocument()
    expect(screen.queryByTestId('sync-inspiration-summary')).not.toBeInTheDocument()
  })

  it('(c) 进页（面板折叠态）不得拉取灵感库列表——展开才发 IPC', () => {
    const { listInspirations } = installApi()
    render(<SyncInspirationPage />)
    expect(listInspirations).not.toHaveBeenCalled()
  })
})
