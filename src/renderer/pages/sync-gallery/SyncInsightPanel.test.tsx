// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SyncInsightPanel } from './SyncInsightPanel'
import type { AssetSummary } from '../../../shared/sync/protocol'

/**
 * 同步图库「上游索引面」面板测试（02 计划 N6）。
 *
 * 这三条通道早已在契约里，缺的只是调用方，所以本文件锁的是**接线**：
 * 打到哪个通道、命中怎么呈现、失败怎么降级、以及「不展开就不发请求」。
 */

function summary(assetId: string): AssetSummary {
  return {
    assetId,
    type: 'photo',
    state: 'ready',
    capturedAt: '2026-10-01T00:00:00.000Z',
    revision: 1,
    hasMotion: false,
    hasMetadata: false
  } as unknown as AssetSummary
}

interface ApiPlan {
  suits?: { items: Array<Record<string, unknown>> }
  clothing?: { items: Array<Record<string, unknown>> }
  stats?: Record<string, unknown>
  suitsError?: Error
  clothingError?: Error
  statsError?: Error
}

function install(plan: ApiPlan = {}) {
  const searchSuits = vi.fn(async () => {
    if (plan.suitsError) throw plan.suitsError
    return plan.suits ?? { items: [] }
  })
  const searchClothing = vi.fn(async () => {
    if (plan.clothingError) throw plan.clothingError
    return plan.clothing ?? { items: [] }
  })
  const profileStats = vi.fn(async () => {
    if (plan.statsError) throw plan.statsError
    return plan.stats ?? { libraryRevision: 1, topSuits: [], topClothing: [] }
  })
  ;(window as unknown as Record<string, unknown>).electronAPI = {
    nikkisync: { searchSuits, searchClothing, profileStats }
  }
  return { searchSuits, searchClothing, profileStats }
}

const TITLE = '套装/服装检索与档案统计'

function submit(term: string, api: ReturnType<typeof install>): void {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: term } })
  fireEvent.submit(screen.getByRole('button', { name: '检索' }).closest('form') as HTMLElement)
  void api
}

beforeEach(() => {
  install()
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as Record<string, unknown>).electronAPI
})

describe('SyncInsightPanel', () => {
  it('桥缺失时整块不渲染（不谎报「没有命中」）', () => {
    ;(window as unknown as Record<string, unknown>).electronAPI = {}
    render(<SyncInsightPanel />)
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it('正常：套装检索命中 ⇒ 渲染套装名与照片数，且打的是 searchSuits', async () => {
    const api = install({
      suits: {
        items: [
          {
            suitId: 'suit_swan',
            suitName: '天鹅童话',
            observedPartCount: 2,
            photoCount: 3,
            photos: [
              { asset: summary('a1'), matchedParts: [{ clothingId: 'c1', name: '天鹅之裙' }] }
            ]
          }
        ]
      }
    })
    render(<SyncInsightPanel />)
    fireEvent.click(screen.getByText(TITLE))
    submit('天鹅', api)
    await waitFor(() => expect(api.searchSuits).toHaveBeenCalledWith({ query: '天鹅' }))
    expect(await screen.findByText('天鹅童话')).toBeInTheDocument()
    expect(screen.getByText('3 张')).toBeInTheDocument()
    expect(screen.getByText('天鹅之裙')).toBeInTheDocument()
    expect(api.searchClothing).not.toHaveBeenCalled()
  })

  it('正常：切到服装作用域后打 searchClothing，并显示所属套装', async () => {
    const api = install({
      clothing: {
        items: [
          {
            clothingId: 'cloth_star',
            name: '星夜长发',
            category: 'hair',
            suitName: '星夜回响',
            photoCount: 5,
            photos: []
          }
        ]
      }
    })
    render(<SyncInsightPanel />)
    fireEvent.click(screen.getByText(TITLE))
    fireEvent.change(screen.getByLabelText('检索范围'), { target: { value: 'clothing' } })
    submit('星夜', api)
    await waitFor(() => expect(api.searchClothing).toHaveBeenCalledWith({ query: '星夜' }))
    expect(await screen.findByText('星夜长发')).toBeInTheDocument()
    expect(screen.getByText('星夜回响')).toBeInTheDocument()
    expect(api.searchSuits).not.toHaveBeenCalled()
  })

  it('边界：空关键词不发起请求；无命中给出空态文案而非报错', async () => {
    const api = install()
    render(<SyncInsightPanel />)
    fireEvent.click(screen.getByText(TITLE))
    fireEvent.submit(screen.getByRole('button', { name: '检索' }).closest('form') as HTMLElement)
    expect(api.searchSuits).not.toHaveBeenCalled()

    submit('不存在', api)
    await waitFor(() => expect(api.searchSuits).toHaveBeenCalled())
    expect(await screen.findByText('没有命中')).toBeInTheDocument()
  })

  it('异常：检索失败只在本面板内联提示，不影响其余区块', async () => {
    const api = install({ suitsError: new Error('runtime is not ready') })
    render(<SyncInsightPanel />)
    fireEvent.click(screen.getByText(TITLE))
    submit('天鹅', api)
    expect(await screen.findByText('检索失败')).toBeInTheDocument()
  })

  it('档案统计：折叠时一次都不拉；首次展开才发请求并渲染两组榜', async () => {
    const api = install({
      stats: {
        libraryRevision: 7,
        topSuits: [{ suitId: 's1', suitName: '天鹅童话', photoCount: 9 }],
        topClothing: [{ clothingId: 'c1', name: '星夜长发', photoCount: 4 }]
      }
    })
    render(<SyncInsightPanel />)
    expect(api.profileStats).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(TITLE))
    await waitFor(() => expect(api.profileStats).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('最常穿的套装')).toBeInTheDocument()
    expect(screen.getByText('天鹅童话')).toBeInTheDocument()
    expect(screen.getByText('最常穿的衣服')).toBeInTheDocument()
    expect(screen.getByText('星夜长发')).toBeInTheDocument()
    // 重复展开不再发第二次（懒加载只做一次）
    fireEvent.click(screen.getByText(TITLE))
    await waitFor(() => expect(api.profileStats).toHaveBeenCalledTimes(1))
  })

  it('档案统计：读取失败降级为内联文案，不抛穿渲染', async () => {
    const api = install({ statsError: new Error('boom') })
    void api
    render(<SyncInsightPanel />)
    fireEvent.click(screen.getByText(TITLE))
    expect(await screen.findByText('统计读取失败')).toBeInTheDocument()
  })
})
