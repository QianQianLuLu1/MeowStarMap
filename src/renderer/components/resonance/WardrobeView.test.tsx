import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ReactNode } from 'react'
import { WardrobeView } from './WardrobeView'
import { useResonanceStore } from '../../stores/resonanceStore'
import { BANNER_DATA, OUTFIT_ITEMS } from '../../utils/resonance/staticData'
import type { ResonanceWardrobeData } from '../../../shared/types/resonance'

/**
 * WardrobeView 组件测试：图鉴目录与名称包 mock 为小型假数据，
 * 验证分类切换 / 套装聚合 / 勾选提交 / 搜索过滤 / 推断流程。
 * react-virtuoso 在 jsdom 下无法量测尺寸，mock 为直接渲染全部行。
 */

const BANNER_2 = BANNER_DATA['2']!
const OUTFIT_5 = BANNER_2.outfit5StarId[0]!
const ITEM_5 = OUTFIT_ITEMS[OUTFIT_5]![0]!
const ITEM_5_ID = Number(ITEM_5)

const fixtures = vi.hoisted(() => {
  const fakeNames = {
    banner: {},
    outfit: { '11': '测试套装' },
    item: {
      '101': '测试连衣裙',
      '102': '测试鞋子',
      '201': '散件发饰'
    },
    makeup: { '31': '测试套装妆', '32': '测试唇彩', '33': '测试底妆' },
    momo: { '41': '测试Momo' },
    prop: { '51': '测试道具' },
    eureka: { '1130010013': '初雪·头部' },
    isFallback: false
  }
  const fakeCatalog = {
    items: [
      { id: 101, quality: 5, type: 'dresses', style: null, labels: [] },
      { id: 102, quality: 4, type: 'shoes', style: null, labels: [] },
      { id: 201, quality: 3, type: 'hair', style: null, labels: [] }
    ],
    outfits: [{ id: 11, quality: 5, style: null, labels: [] }],
    makeups: [
      { id: 31, quality: 5, type: 'fullMakeup', style: null },
      { id: 32, quality: 4, type: 'lips', style: null },
      { id: 33, quality: 4, type: 'baseMakeup', style: null }
    ],
    momo: [{ id: 41, quality: 4 }],
    eurekas: [
      {
        id: 1130010013,
        suitId: 113001,
        position: 'head',
        quality: 5,
        styles: { elegant: 0, fresh: 0, sweet: 0, sexy: 0, cool: 0 },
        mainStyle: 'elegant',
        tagIds: [],
        provinceId: 1,
        colors: [
          { id: 1341, order: 1, colorType: 1 },
          { id: 1342, order: 2, colorType: 1 }
        ]
      }
    ],
    props: [{ id: 51, quality: 4 }],
    outfitItems: { '11': [101, 102] },
    makeupItems: { '31': [] },
    makeupOutfits: {},
    momoOutfits: {},
    palettes: { palettes: { '1': { colors: ['#ff0000', '#00ff00'] } } }
  }
  return { fakeNames, fakeCatalog }
})

vi.mock('react-virtuoso', async () => {
  const { createElement } = await import('react')
  return {
    Virtuoso: ({
      data,
      itemContent
    }: {
      data?: unknown[]
      itemContent?: (index: number, row: unknown) => ReactNode
    }) =>
      createElement(
        'div',
        { 'data-testid': 'virtuoso-list' },
        (data ?? []).map((row, index) => itemContent?.(index, row))
      )
  }
})

vi.mock('../../utils/resonance/staticData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/resonance/staticData')>()
  return {
    ...actual,
    loadCatalog: vi.fn(() => Promise.resolve(fixtures.fakeCatalog)),
    loadNames: vi.fn(() => Promise.resolve(fixtures.fakeNames))
  }
})

const emptyWardrobe: ResonanceWardrobeData = {
  version: 1,
  ownedItemIds: [],
  ownedMakeupIds: [],
  ownedMomoIds: [],
  ownedPropIds: [],
  ownedEurekaColorIds: [],
  updatedAt: ''
}

const updateWardrobeMock = vi.fn()

describe('WardrobeView', () => {
  beforeEach(() => {
    updateWardrobeMock.mockReset()
    updateWardrobeMock.mockResolvedValue({ wardrobe: emptyWardrobe })
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      resonance: { updateWardrobe: updateWardrobeMock }
    }
    useResonanceStore.getState().reset()
    useResonanceStore.setState({
      loaded: true,
      wardrobe: { ...emptyWardrobe, ownedItemIds: [101] }
    })
  })
  afterEach(cleanup)

  it('渲染分类页签、套装聚合卡片与汇总徽标', async () => {
    render(<WardrobeView />)
    expect(await screen.findByText('测试套装')).toBeTruthy()
    expect(screen.getByText('集齐中')).toBeTruthy()
    expect(screen.getByText('1/2')).toBeTruthy()
    expect(screen.getByText('已拥有 1 / 3')).toBeTruthy()
    expect(screen.getByRole('button', { name: '部件' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '妆容' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '共鸣色' })).toBeTruthy()
  })

  it('展开套装勾选部件触发 updateWardrobe（新增拥有）', async () => {
    render(<WardrobeView />)
    fireEvent.click(await screen.findByText('测试套装'))
    const checkbox = await screen.findByRole('checkbox', { name: '测试鞋子' })
    expect((screen.getByRole('checkbox', { name: '测试连衣裙' }) as HTMLInputElement).checked).toBe(
      true
    )
    fireEvent.click(checkbox)
    await vi.waitFor(() => {
      expect(updateWardrobeMock).toHaveBeenCalledWith([{ category: 'item', itemId: 102 }], [])
    })
  })

  it('搜索关键词过滤套装与散件', async () => {
    render(<WardrobeView />)
    await screen.findByText('测试套装')
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: '散件' }
    })
    // 散件组按名称命中后需手动展开查看部件行
    fireEvent.click(await screen.findByText('散件（未归属套装）'))
    expect(await screen.findByText('散件发饰')).toBeTruthy()
    expect(screen.queryByText('测试套装')).toBeNull()
  })

  it('稀有度筛选只保留对应品质部件', async () => {
    render(<WardrobeView />)
    fireEvent.click(await screen.findByText('测试套装'))
    await screen.findByText('测试鞋子')
    fireEvent.change(screen.getByRole('combobox', { name: '稀有度' }), {
      target: { value: '5' }
    })
    expect(screen.getByText('测试连衣裙')).toBeTruthy()
    expect(screen.queryByText('测试鞋子')).toBeNull()
    expect(screen.queryByText('散件（未归属套装）')).toBeNull()
  })

  it('Momo 平铺分类勾选触发 updateWardrobe', async () => {
    render(<WardrobeView />)
    await screen.findByText('测试套装')
    fireEvent.click(screen.getByRole('button', { name: 'Momo' }))
    const checkbox = await screen.findByRole('checkbox', { name: '测试Momo' })
    fireEvent.click(checkbox)
    await vi.waitFor(() => {
      expect(updateWardrobeMock).toHaveBeenCalledWith([{ category: 'momo', itemId: 41 }], [])
    })
  })

  it('共鸣色分类渲染色块 chip 并可勾选', async () => {
    render(<WardrobeView />)
    await screen.findByText('测试套装')
    fireEvent.click(screen.getByRole('button', { name: '共鸣色' }))
    const chip = await screen.findByRole('button', {
      name: '初雪·头部 #1341 · 未拥有'
    })
    fireEvent.click(chip)
    await vi.waitFor(() => {
      expect(updateWardrobeMock).toHaveBeenCalledWith(
        [{ category: 'eureka_color', itemId: 1341 }],
        []
      )
    })
  })

  it('推断确认框：无记录时确认不产生写入', async () => {
    render(<WardrobeView />)
    await screen.findByText('测试套装')
    fireEvent.click(screen.getByRole('button', { name: '从共鸣记录推断' }))
    expect(screen.getByText('从共鸣记录推断衣橱')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    await vi.waitFor(() => {
      expect(updateWardrobeMock).not.toHaveBeenCalled()
    })
  })

  it('推断确认框：有共鸣记录时按推断结果批量写入', async () => {
    // 将真实卡池 5★ 物品注入假图鉴，使推断链路（真实卡池数据 → 假图鉴索引）可命中
    fixtures.fakeCatalog.items.push({
      id: ITEM_5_ID,
      quality: 5,
      type: 'dresses',
      style: null,
      labels: []
    })
    useResonanceStore.setState({
      pulls: [
        {
          id: 1,
          banner_id: '2',
          item_id: ITEM_5,
          obtained_at: '2025-07-01 10:00:00',
          source: 'json',
          created_at: ''
        }
      ],
      wardrobe: { ...emptyWardrobe }
    })
    render(<WardrobeView />)
    await screen.findByText('测试套装')
    fireEvent.click(screen.getByRole('button', { name: '从共鸣记录推断' }))
    expect(screen.getByText('从共鸣记录推断衣橱')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    await vi.waitFor(() => {
      expect(updateWardrobeMock).toHaveBeenCalledWith([{ category: 'item', itemId: ITEM_5_ID }], [])
    })
  })
})
