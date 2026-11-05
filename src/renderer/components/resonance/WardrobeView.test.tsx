import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { WardrobeView } from './WardrobeView'
import { useResonanceStore } from '../../stores/resonanceStore'
import { BANNER_DATA, OUTFIT_ITEMS, loadCatalog } from '../../utils/resonance/staticData'
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

  it('从共鸣笔记导入：按 suit_list 展开部件，跳过已拥有项后写入衣橱', async () => {
    const openFile = vi.fn(() => Promise.resolve('C:\\notebook.json'))
    const readImportFile = vi.fn(() =>
      Promise.resolve({
        content: JSON.stringify({ info_from_self: { suit_list: ['11', 11, 999] } }),
        sizeBytes: 40
      })
    )
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      resonance: { updateWardrobe: updateWardrobeMock, readImportFile },
      dialog: { openFile }
    }

    render(<WardrobeView />)
    fireEvent.click(await screen.findByRole('button', { name: '从共鸣笔记导入' }))

    await vi.waitFor(() => expect(updateWardrobeMock).toHaveBeenCalledTimes(1))
    const [adds, removes] = updateWardrobeMock.mock.calls[0]! as unknown as [
      Array<{ category: string; itemId: number }>,
      unknown[]
    ]
    // 套装 11 的部件 101 已拥有 → 只补 102；未知套装 999 与重复 id 被丢弃
    expect(adds).toEqual([{ category: 'item', itemId: 102 }])
    expect(removes).toEqual([])
  })

  it('从共鸣笔记导入：笔记无 suit_list 时不写入并提示', async () => {
    const openFile = vi.fn(() => Promise.resolve('C:\\notebook.json'))
    const readImportFile = vi.fn(() =>
      Promise.resolve({ content: JSON.stringify({ info_from_self: {} }), sizeBytes: 20 })
    )
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      resonance: { updateWardrobe: updateWardrobeMock, readImportFile },
      dialog: { openFile }
    }

    render(<WardrobeView />)
    fireEvent.click(await screen.findByRole('button', { name: '从共鸣笔记导入' }))

    await vi.waitFor(() => expect(readImportFile).toHaveBeenCalledTimes(1))
    expect(updateWardrobeMock).not.toHaveBeenCalled()
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

  /**
   * 外链图片热链：六类地址渲染、属性、失败回退、失败集合清理。
   * 合规位数的真实样本仅在本 describe 内注入，既有 fixtures 与 10 个用例不受影响。
   */
  describe('外链图片 CDN 热链', () => {
    const SAMPLE = {
      outfitId: 10347,
      itemId: 1020100001,
      makeupId: 10399003,
      momoId: 1160100134,
      propId: 1280010126,
      eurekaId: 9001
    } as const

    const SRC = {
      outfit: `https://cdn.gongeo.us/images/outfits/${SAMPLE.outfitId}.png`,
      item: `https://cdn.gongeo.us/images/items/icons/${SAMPLE.itemId}.png`,
      makeup: `https://cdn.gongeo.us/images/items/makeups/${SAMPLE.makeupId}.png`,
      momo: `https://cdn.gongeo.us/images/momo/icons/${SAMPLE.momoId}.png`,
      prop: `https://cdn.gongeo.us/images/props/${SAMPLE.propId}.png`,
      eureka: `https://cdn.gongeo.us/images/eurekas/${SAMPLE.eurekaId}.png`
    } as const

    beforeEach(() => {
      const catalog = fixtures.fakeCatalog
      if (!catalog.outfits.some((entry) => entry.id === SAMPLE.outfitId)) {
        catalog.outfits.push({ id: SAMPLE.outfitId, quality: 5, style: null, labels: [] })
        // 套装组必须有关联部件，否则会被 groups 的 total > 0 过滤掉
        Object.assign(catalog.outfitItems, { [SAMPLE.outfitId]: [SAMPLE.itemId] })
      }
      if (!catalog.items.some((entry) => entry.id === SAMPLE.itemId)) {
        catalog.items.push({
          id: SAMPLE.itemId,
          quality: 5,
          type: 'dresses',
          style: null,
          labels: []
        })
      }
      if (!catalog.makeups.some((entry) => entry.id === SAMPLE.makeupId)) {
        catalog.makeups.push({ id: SAMPLE.makeupId, quality: 4, type: 'lips', style: null })
      }
      if (!catalog.momo.some((entry) => entry.id === SAMPLE.momoId)) {
        catalog.momo.push({ id: SAMPLE.momoId, quality: 4 })
      }
      if (!catalog.props.some((entry) => entry.id === SAMPLE.propId)) {
        catalog.props.push({ id: SAMPLE.propId, quality: 4 })
      }
      const colors = catalog.eurekas[0]!.colors
      if (!colors.some((color) => color.id === SAMPLE.eurekaId)) {
        colors.push({ id: SAMPLE.eurekaId, order: 3, colorType: 1 })
      }
      const names = fixtures.fakeNames
      Object.assign(names.outfit, { [SAMPLE.outfitId]: '注入套装' })
      Object.assign(names.item, { [SAMPLE.itemId]: '注入连衣裙' })
      Object.assign(names.makeup, { [SAMPLE.makeupId]: '注入唇彩' })
      Object.assign(names.momo, { [SAMPLE.momoId]: '注入Momo' })
      Object.assign(names.prop, { [SAMPLE.propId]: '注入道具' })
    })

    const hasImg = (src: string): boolean =>
      screen.queryAllByRole('img').some((img) => img.getAttribute('src') === src)

    const findImg = (src: string): HTMLElement | undefined =>
      screen.queryAllByRole('img').find((img) => img.getAttribute('src') === src)

    it('部件 tab：套装组卡与单品行分别渲染 outfit / item 地址', async () => {
      render(<WardrobeView />)
      await screen.findByText('注入套装')
      expect(hasImg(SRC.outfit)).toBe(true)
      fireEvent.click(screen.getByText('注入套装'))
      expect(hasImg(SRC.item)).toBe(true)
    })

    it('妆容 tab：散件行渲染 makeup 地址', async () => {
      render(<WardrobeView />)
      await screen.findByText('测试套装')
      fireEvent.click(screen.getByRole('button', { name: '妆容' }))
      fireEvent.click(await screen.findByText('散件（未归属套装）'))
      expect(hasImg(SRC.makeup)).toBe(true)
    })

    it('Momo tab：平铺行渲染 momo 地址', async () => {
      render(<WardrobeView />)
      await screen.findByText('测试套装')
      fireEvent.click(screen.getByRole('button', { name: 'Momo' }))
      expect(hasImg(SRC.momo)).toBe(true)
    })

    it('道具 tab：平铺行渲染 prop 地址', async () => {
      render(<WardrobeView />)
      await screen.findByText('测试套装')
      fireEvent.click(screen.getByRole('button', { name: '道具' }))
      expect(hasImg(SRC.prop)).toBe(true)
    })

    it('共鸣色 tab：chip 内渲染 eureka 地址且按钮可访问名称不变', async () => {
      render(<WardrobeView />)
      await screen.findByText('测试套装')
      fireEvent.click(screen.getByRole('button', { name: '共鸣色' }))
      const chip = await screen.findByRole('button', { name: /9001/ })
      expect(chip.getAttribute('aria-label')).toContain('9001')
      expect(within(chip).getByRole('img').getAttribute('src')).toBe(SRC.eureka)
    })

    it('全部图片按需加载、不带 Referer、主机唯一且六类地址齐备', async () => {
      render(<WardrobeView />)
      await screen.findByText('注入套装')
      const sources = new Set<string>()
      const collect = (): void => {
        for (const img of screen.getAllByRole('img')) {
          expect(img).toHaveAttribute('referrerpolicy', 'no-referrer')
          expect(img).toHaveAttribute('loading', 'lazy')
          expect(img.getAttribute('alt')).toBeTruthy()
          const src = img.getAttribute('src') ?? ''
          expect(src.startsWith('https://cdn.gongeo.us/')).toBe(true)
          expect(new URL(src).hostname).toBe('cdn.gongeo.us')
          expect(src.includes('?')).toBe(false)
          expect(src.includes('#')).toBe(false)
          sources.add(src)
        }
      }
      fireEvent.click(screen.getByText('注入套装'))
      collect()
      for (const label of ['妆容', 'Momo', '道具', '共鸣色']) {
        fireEvent.click(screen.getByRole('button', { name: label }))
        if (label === '妆容') fireEvent.click(await screen.findByText('散件（未归属套装）'))
        collect()
      }
      for (const src of Object.values(SRC)) {
        expect(sources.has(src)).toBe(true)
      }
    })

    it('图片加载失败回退既有占位，名称与勾选仍可用', async () => {
      render(<WardrobeView />)
      await screen.findByText('注入套装')
      fireEvent.click(screen.getByText('注入套装'))
      const img = findImg(SRC.item)
      expect(img).toBeTruthy()
      fireEvent.error(img!)
      expect(hasImg(SRC.item)).toBe(false)
      expect(screen.getByText('注入连衣裙')).toBeTruthy()
      const row = screen.getByRole('checkbox', { name: '注入连衣裙' }).closest('label')
      expect(row).toBeTruthy()
      expect(row!.querySelector('span[aria-hidden]')).toBeTruthy()
    })

    it('切换分类后失败集合被清理，图片重新渲染', async () => {
      render(<WardrobeView />)
      await screen.findByText('注入套装')
      fireEvent.click(screen.getByText('注入套装'))
      fireEvent.error(findImg(SRC.item)!)
      expect(hasImg(SRC.item)).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'Momo' }))
      fireEvent.click(screen.getByRole('button', { name: '部件' }))
      if (!hasImg(SRC.item)) fireEvent.click(screen.getByText('注入套装'))
      expect(hasImg(SRC.item)).toBe(true)
    })

    it('数据重新装载后失败集合重建，图片重新渲染', async () => {
      render(<WardrobeView />)
      await screen.findByText('注入套装')
      fireEvent.click(screen.getByText('注入套装'))
      fireEvent.error(findImg(SRC.item)!)
      expect(hasImg(SRC.item)).toBe(false)
      const before = vi.mocked(loadCatalog).mock.calls.length
      cleanup()
      render(<WardrobeView />)
      await screen.findByText('注入套装')
      expect(vi.mocked(loadCatalog).mock.calls.length).toBe(before + 1)
      fireEvent.click(screen.getByText('注入套装'))
      expect(hasImg(SRC.item)).toBe(true)
    })

    it('短标识实体不产生地址并回退既有色块或品质点', async () => {
      render(<WardrobeView />)
      await screen.findByText('测试套装')
      fireEvent.click(screen.getByText('测试套装'))
      const row = screen.getByRole('checkbox', { name: '测试鞋子' }).closest('label')
      expect(row).toBeTruthy()
      expect(within(row!).queryByRole('img')).toBeNull()
      expect(row!.querySelector('span[aria-hidden]')).toBeTruthy()
    })

    it('图片失败、切分类与短标识渲染均不产生未捕获异常', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        render(<WardrobeView />)
        await screen.findByText('注入套装')
        fireEvent.click(screen.getByText('注入套装'))
        const img = findImg(SRC.item)
        if (img) fireEvent.error(img)
        fireEvent.click(screen.getByRole('button', { name: 'Momo' }))
        // 过滤仓库既有的 React act() 警告，只断言没有其它错误
        const unexpected = errorSpy.mock.calls.filter(
          ([message]) => !String(message).includes('not wrapped in act')
        )
        expect(unexpected).toEqual([])
      } finally {
        errorSpy.mockRestore()
      }
    })
  })
})
