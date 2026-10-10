import { describe, expect, it } from 'vitest'
import {
  ImportStructureError,
  countImportDiff,
  normalizeImportTimestamp,
  parseImportFileText,
  parsePearpalSuitIdsFromText
} from './importParse'
import type {
  ResonanceEditRow,
  ResonanceEvoRow,
  ResonancePearpalRow,
  ResonancePullRow
} from '../../../shared/types/resonance'

const TS = '2025-06-01 12:30:45'

describe('normalizeImportTimestamp', () => {
  it('缺秒补 :00', () => {
    expect(normalizeImportTimestamp('2025-06-01 12:30')).toBe('2025-06-01 12:30:00')
  })
  it('合法全格式原样返回', () => {
    expect(normalizeImportTimestamp(TS)).toBe(TS)
  })
  it('非法返回 null', () => {
    expect(normalizeImportTimestamp('2025/06/01')).toBeNull()
    expect(normalizeImportTimestamp(123)).toBeNull()
  })
})

describe('parseImportFileText 合法输入', () => {
  it('旧格式 Record<bannerId, PullRecord[]>', () => {
    const parsed = parseImportFileText(JSON.stringify({ 2: [[TS, '1020000001']] }))
    expect(parsed.format).toBe('legacy')
    expect(parsed.pulls[2]).toEqual([[TS, '1020000001']])
    expect(parsed.totalValidRecords).toBe(1)
    expect(parsed.invalid).toHaveLength(0)
  })

  it('当前格式（pulls/edits/evo/pearpal/wardrobe 全段）', () => {
    const file = {
      version: 1,
      pulls: { 2: [[TS, '1020000001']] },
      edits: { 3: [[TS, '2020000002']] },
      evo: { 2: [['10001', 2]] },
      pearpal: {
        4: [
          {
            card_pool_id: '4',
            pool_cnt: 1,
            result: '1020000001',
            times_from_last_five_stars: 3,
            times_from_last_four_stars: 1,
            rarity: '5'
          }
        ]
      },
      wardrobe: { version: 1, ownedItemIds: [1020000001], updatedAt: '' }
    }
    const parsed = parseImportFileText(JSON.stringify(file))
    expect(parsed.format).toBe('current')
    expect(parsed.version).toBe(1)
    expect(parsed.versionMismatch).toBe(false)
    expect(parsed.pulls[2]).toHaveLength(1)
    expect(parsed.edits[3]).toHaveLength(1)
    expect(parsed.evo[2]).toEqual([['10001', 2]])
    expect(parsed.pearpal[4]).toHaveLength(1)
    expect(parsed.wardrobe?.ownedItemIds).toEqual([1020000001])
    expect(parsed.totalValidRecords).toBe(4)
  })

  it('异常字符（unicode 物品名/表情）不破坏解析', () => {
    const file = { 2: [[TS, '1020000001']], 备注: '✨🎉' }
    void (file as { 备注?: string }).备注
    const parsed = parseImportFileText(JSON.stringify({ 2: [[TS, '1020000001']] }))
    expect(parsed.pulls[2]).toHaveLength(1)
  })
})

describe('parseImportFileText 结构失败', () => {
  it('JSON 损坏', () => {
    expect(() => parseImportFileText('{not-json')).toThrow(ImportStructureError)
  })
  it('缺字段/未知结构', () => {
    expect(() => parseImportFileText('{}')).toThrow(ImportStructureError)
    expect(() => parseImportFileText('[1,2,3]')).toThrow(ImportStructureError)
    expect(() => parseImportFileText(JSON.stringify({ pulls: { abc: [[TS, '1']] } }))).toThrow(
      ImportStructureError
    )
  })
})

describe('parseImportFileText 逐记录校验（计数 + 定位，不整体拒绝）', () => {
  it('缺字段/类型错/时间非法分别计数并采样', () => {
    const file = {
      pulls: {
        2: [[TS, '1020000001'], ['bad-time', '1020000001'], [TS, 'not-a-number'], [TS], 'garbage']
      }
    }
    const parsed = parseImportFileText(JSON.stringify(file))
    expect(parsed.pulls[2]).toHaveLength(1)
    expect(parsed.totalValidRecords).toBe(1)
    expect(parsed.invalid.length).toBeGreaterThan(0)
    expect(parsed.invalid.some((i) => i.reason === 'invalidTimestamp')).toBe(true)
    expect(parsed.invalid.some((i) => i.reason === 'invalidItemId')).toBe(true)
    expect(parsed.invalid.some((i) => i.location.includes('卡池 2'))).toBe(true)
  })

  it('超大数组超过单卡池上限被顶层拒绝', () => {
    // 构造 50001 条（超过 MAX_PULLS_PER_BANNER=50000）
    const big = Array.from({ length: 50_001 }, (_, i) => [
      `2025-01-01 ${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`,
      '1020000001'
    ])
    expect(() => parseImportFileText(JSON.stringify({ pulls: { 2: big } }))).toThrow(
      ImportStructureError
    )
  })

  it('版本高于当前支持 → versionMismatch 标记', () => {
    const parsed = parseImportFileText(
      JSON.stringify({ version: 2, pulls: { 2: [[TS, '1020000001']] } })
    )
    expect(parsed.versionMismatch).toBe(true)
  })
})

describe('countImportDiff 幂等键比对', () => {
  const existingPulls: Pick<ResonancePullRow, 'banner_id' | 'obtained_at' | 'item_id'>[] = [
    { banner_id: '2', obtained_at: TS, item_id: '1020000001' }
  ]
  const existingEdits: Pick<ResonanceEditRow, 'banner_id' | 'item_id'>[] = []
  const existingPearpal: Pick<ResonancePearpalRow, 'banner_id' | 'item_id' | 'pool_cnt'>[] = []
  const existingEvo: Pick<ResonanceEvoRow, 'banner_id' | 'outfit_id'>[] = []

  it('全重复', () => {
    const parsed = parseImportFileText(JSON.stringify({ 2: [[TS, '1020000001']] }))
    expect(
      countImportDiff(parsed, {
        pulls: existingPulls,
        edits: existingEdits,
        pearpal: existingPearpal,
        evo: existingEvo
      })
    ).toEqual({
      added: 0,
      duplicate: 1
    })
  })
  it('部分重叠', () => {
    const parsed = parseImportFileText(
      JSON.stringify({
        2: [
          [TS, '1020000001'],
          ['2025-06-02 08:00:00', '1020000001']
        ]
      })
    )
    const diff = countImportDiff(parsed, {
      pulls: existingPulls,
      edits: existingEdits,
      pearpal: existingPearpal,
      evo: existingEvo
    })
    expect(diff).toEqual({ added: 1, duplicate: 1 })
  })
  it('edits 以 banner+item 为键去重', () => {
    const existing: Pick<ResonanceEditRow, 'banner_id' | 'item_id'>[] = [
      { banner_id: '3', item_id: '2020000002' }
    ]
    const parsed = parseImportFileText(
      JSON.stringify({ edits: { 3: [['2025-06-01 00:00:00', '2020000002']] } })
    )
    expect(countImportDiff(parsed, { pulls: [], edits: existing, pearpal: [], evo: [] })).toEqual({
      added: 0,
      duplicate: 1
    })
  })
})

describe('bannerWishlist 段解析（同步上游 65bb3d8f）', () => {
  it('缺 bannerWishlist 时为 null', () => {
    const parsed = parseImportFileText(JSON.stringify({ pulls: { 2: [[TS, '1020000001']] } }))
    expect(parsed.wishlist).toBeNull()
  })

  it('合法心愿单按快照规范化（去重、丢弃未知卡池），不计入记录总数', () => {
    const parsed = parseImportFileText(
      JSON.stringify({
        pulls: { 2: [[TS, '1020000001']] },
        bannerWishlist: {
          version: 1,
          entries: [{ bannerId: 74 }, { bannerId: 74 }, { bannerId: 999999 }]
        }
      })
    )
    expect(parsed.format).toBe('current')
    expect(parsed.wishlist).toEqual({ version: 1, entries: [{ bannerId: 74 }] })
    expect(parsed.totalValidRecords).toBe(1)
  })

  it('仅含 bannerWishlist 的文件也识别为 current 格式', () => {
    const parsed = parseImportFileText(
      JSON.stringify({ bannerWishlist: { version: 1, entries: [] } })
    )
    expect(parsed.format).toBe('current')
    expect(parsed.wishlist).toEqual({ version: 1, entries: [] })
  })

  it('bannerWishlist 结构非法 → ImportStructureError（不静默丢段）', () => {
    for (const bad of [
      { version: 2, entries: [] },
      { version: 1, entries: 'x' },
      'not-an-object'
    ]) {
      expect(() => parseImportFileText(JSON.stringify({ pulls: {}, bannerWishlist: bad }))).toThrow(
        ImportStructureError
      )
    }
  })
})

describe('parsePearpalSuitIdsFromText（共鸣笔记 suit_list 提取）', () => {
  it('正常：取 info_from_self.suit_list，字符串与数字混用均可', () => {
    const text = JSON.stringify({ info_from_self: { suit_list: ['10399', 10347] } })
    expect(parsePearpalSuitIdsFromText(text)).toEqual([10399, 10347])
  })

  it('异常：非 JSON / 非对象 / 缺字段 / suit_list 非数组 → 空数组且不抛', () => {
    expect(parsePearpalSuitIdsFromText('{not-json')).toEqual([])
    expect(parsePearpalSuitIdsFromText('[1,2]')).toEqual([])
    expect(parsePearpalSuitIdsFromText('{}')).toEqual([])
    expect(parsePearpalSuitIdsFromText(JSON.stringify({ info_from_self: {} }))).toEqual([])
    expect(
      parsePearpalSuitIdsFromText(JSON.stringify({ info_from_self: { suit_list: 'x' } }))
    ).toEqual([])
    expect(parsePearpalSuitIdsFromText('')).toEqual([])
  })

  it('边界：过滤非安全整数与非数字元素并去重，保持出现顺序', () => {
    const text = JSON.stringify({
      info_from_self: { suit_list: ['10399', 10399, 1.5, 'abc', null, 10347, '', '9e999'] }
    })
    expect(parsePearpalSuitIdsFromText(text)).toEqual([10399, 10347])
  })

  it('边界：空 suit_list 返回空数组', () => {
    expect(
      parsePearpalSuitIdsFromText(JSON.stringify({ info_from_self: { suit_list: [] } }))
    ).toEqual([])
  })
})
