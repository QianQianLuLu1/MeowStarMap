import { describe, expect, it } from 'vitest'
import {
  MAX_PULLS_PER_BANNER,
  MAX_WARDROBE_BATCH,
  MAX_WISHLIST_ENTRIES,
  resonanceAddManualRecordArgs,
  resonanceBannerIdSchema,
  resonanceBannerWishlistSchema,
  resonanceDeleteRecordArgs,
  resonanceExportArgs,
  resonanceCommitImportArgs,
  resonanceImportFileSchema,
  resonanceReadImportFileArgs,
  resonanceItemIdSchema,
  resonanceOutfitIdSchema,
  resonancePullRecordListSchema,
  resonanceSetWishlistArgs,
  resonanceTimestampSchema,
  resonanceUpdateManualRecordArgs,
  resonanceUpdateWardrobeArgs
} from './resonance'

describe('resonanceTimestampSchema', () => {
  it('接受 "YYYY-MM-DD HH:mm:ss"', () => {
    expect(resonanceTimestampSchema.safeParse('2025-06-01 12:30:45').success).toBe(true)
  })
  it('接受省略秒的 "YYYY-MM-DD HH:mm"', () => {
    expect(resonanceTimestampSchema.safeParse('2025-06-01 12:30').success).toBe(true)
  })
  it('拒绝 ISO 格式与乱串', () => {
    expect(resonanceTimestampSchema.safeParse('2025-06-01T12:30:45Z').success).toBe(false)
    expect(resonanceTimestampSchema.safeParse('not-a-time').success).toBe(false)
  })
})

describe('resonanceBannerIdSchema', () => {
  it('接受数字串', () => {
    expect(resonanceBannerIdSchema.safeParse('73').success).toBe(true)
  })
  it('拒绝非数字与超长', () => {
    expect(resonanceBannerIdSchema.safeParse('banner-1').success).toBe(false)
    expect(resonanceBannerIdSchema.safeParse('1234567').success).toBe(false)
  })
})

describe('resonanceItemIdSchema', () => {
  it('接受 10 位物品 id', () => {
    expect(resonanceItemIdSchema.safeParse('1020100001').success).toBe(true)
  })
  it('拒绝过短/非数字', () => {
    expect(resonanceItemIdSchema.safeParse('123').success).toBe(false)
    expect(resonanceItemIdSchema.safeParse('1020x00001').success).toBe(false)
  })
})

describe('resonanceOutfitIdSchema', () => {
  it('接受 5 位套装 id', () => {
    expect(resonanceOutfitIdSchema.safeParse('10001').success).toBe(true)
  })
  it('拒绝 7 位变体 id 与空串', () => {
    expect(resonanceOutfitIdSchema.safeParse('1000101').success).toBe(false)
    expect(resonanceOutfitIdSchema.safeParse('').success).toBe(false)
  })
})

describe('resonancePullRecordListSchema', () => {
  it('接受合法记录列表', () => {
    const list: [string, string][] = [
      ['2025-06-01 12:30:45', '1020100001'],
      ['2025-06-02 08:00', '1020100002']
    ]
    expect(resonancePullRecordListSchema.safeParse(list).success).toBe(true)
  })
  it('拒绝时间格式错误的记录', () => {
    expect(resonancePullRecordListSchema.safeParse([['06/01/2025', '1020100001']]).success).toBe(
      false
    )
  })
  it('拒绝超过单卡池上限的数组', () => {
    const huge: [string, string][] = Array.from({ length: MAX_PULLS_PER_BANNER + 1 }, () => [
      '2025-06-01 12:30:45',
      '1020100001'
    ])
    const result = resonancePullRecordListSchema.safeParse(huge)
    expect(result.success).toBe(false)
  })
})

describe('resonanceImportFileSchema', () => {
  it('接受当前格式（含 pulls/wardrobe 段）', () => {
    const file = {
      version: 1,
      pulls: { 2: [['2025-06-01 12:30:45', '1020100001']] },
      wardrobe: { version: 1, ownedItemIds: [1020100001], updatedAt: '' }
    }
    expect(resonanceImportFileSchema.safeParse(file).success).toBe(true)
  })
  it('接受旧格式 Record<bannerId, PullRecord[]>', () => {
    const file = { 2: [['2025-06-01 12:30:45', '1020100001']] }
    expect(resonanceImportFileSchema.safeParse(file).success).toBe(true)
  })
  it('拒绝空对象（无任何数据段）', () => {
    expect(resonanceImportFileSchema.safeParse({}).success).toBe(false)
  })
  it('拒绝未知顶层结构（如数组）', () => {
    expect(resonanceImportFileSchema.safeParse([1, 2, 3]).success).toBe(false)
  })
  it('拒绝卡池键非法的记录映射', () => {
    expect(
      resonanceImportFileSchema.safeParse({ pulls: { abc: [['2025-06-01 12:30', '1020100001']] } })
        .success
    ).toBe(false)
  })
})

describe('resonanceAddManualRecordArgs', () => {
  it('接受合法三元组', () => {
    expect(
      resonanceAddManualRecordArgs.safeParse(['2', '1020100001', '2025-06-01 12:30:45']).success
    ).toBe(true)
  })
  it('拒绝缺失字段与非法时间', () => {
    expect(resonanceAddManualRecordArgs.safeParse(['2', '1020100001']).success).toBe(false)
    expect(resonanceAddManualRecordArgs.safeParse(['2', '1020100001', '2025/06/01']).success).toBe(
      false
    )
  })
})

describe('resonanceUpdateManualRecordArgs', () => {
  it('接受正整数 id + 时间', () => {
    expect(resonanceUpdateManualRecordArgs.safeParse([1, '2025-06-01 12:30']).success).toBe(true)
  })
  it('拒绝非正整数与非法时间', () => {
    expect(resonanceUpdateManualRecordArgs.safeParse([0, '2025-06-01 12:30']).success).toBe(false)
    expect(resonanceUpdateManualRecordArgs.safeParse([1.5, '2025-06-01 12:30']).success).toBe(false)
  })
})

describe('resonanceDeleteRecordArgs', () => {
  it('接受 kind + 正整数 id', () => {
    expect(resonanceDeleteRecordArgs.safeParse([{ kind: 'pull', id: 3 }]).success).toBe(true)
    expect(resonanceDeleteRecordArgs.safeParse([{ kind: 'edit', id: 3 }]).success).toBe(true)
  })
  it('拒绝未知 kind、负数与字符串 id', () => {
    expect(resonanceDeleteRecordArgs.safeParse([{ kind: 'other', id: 3 }]).success).toBe(false)
    expect(resonanceDeleteRecordArgs.safeParse([{ kind: 'pull', id: -1 }]).success).toBe(false)
    expect(resonanceDeleteRecordArgs.safeParse([{ kind: 'pull', id: '3' }]).success).toBe(false)
  })
})

describe('resonanceReadImportFileArgs / resonanceCommitImportArgs', () => {
  it('接受合法路径', () => {
    expect(resonanceReadImportFileArgs.safeParse(['C:\\data\\export.json']).success).toBe(true)
  })
  it('拒绝空路径', () => {
    expect(resonanceReadImportFileArgs.safeParse(['']).success).toBe(false)
  })
  it('commit 接受合法批次', () => {
    expect(
      resonanceCommitImportArgs.safeParse([
        {
          pulls: [{ bannerId: '2', itemId: '1020000001', obtainedAt: '2025-06-01 12:30:45' }],
          edits: [],
          pearpal: [],
          evo: []
        }
      ]).success
    ).toBe(true)
  })
  it('commit 拒绝非法行', () => {
    expect(
      resonanceCommitImportArgs.safeParse([
        {
          pulls: [{ bannerId: '2', itemId: 'bad', obtainedAt: '2025-06-01 12:30:45' }],
          edits: [],
          pearpal: [],
          evo: []
        }
      ]).success
    ).toBe(false)
  })
})

describe('resonanceExportArgs', () => {
  const validPayload = {
    version: 1,
    app: 'nikkigallery',
    exportedAt: '2025-06-01T00:00:00.000Z',
    pulls: { '2': [['2025-06-01 12:30:45', '1020000001']] },
    edits: {},
    evo: {},
    pearpal: {},
    wardrobe: { version: 1, ownedItemIds: [1020000001] }
  }
  it('接受合法路径 + 载荷', () => {
    expect(
      resonanceExportArgs.safeParse([{ filePath: 'C:\\out\\r.json' }, validPayload]).success
    ).toBe(true)
  })
  it('拒绝缺字段载荷', () => {
    expect(
      resonanceExportArgs.safeParse([{ filePath: 'C:\\out\\r.json' }, { version: 1 }]).success
    ).toBe(false)
  })
  it('拒绝非 .json 载荷参数缺失', () => {
    expect(resonanceExportArgs.safeParse([{ filePath: '' }, validPayload]).success).toBe(false)
  })
})

describe('resonanceUpdateWardrobeArgs', () => {
  it('接受合法批量更新', () => {
    const args = [
      {
        adds: [
          { category: 'item', itemId: 1020100001 },
          { category: 'eureka_color', itemId: 1341 }
        ],
        removes: []
      }
    ]
    expect(resonanceUpdateWardrobeArgs.safeParse(args).success).toBe(true)
  })
  it('拒绝未知分类与空更新', () => {
    expect(
      resonanceUpdateWardrobeArgs.safeParse([
        { adds: [{ category: 'weapon', itemId: 1 }], removes: [] }
      ]).success
    ).toBe(false)
    expect(resonanceUpdateWardrobeArgs.safeParse([{ adds: [], removes: [] }]).success).toBe(false)
  })
  it('拒绝超过批量上限', () => {
    const adds = Array.from({ length: MAX_WARDROBE_BATCH + 1 }, (_, i) => ({
      category: 'item',
      itemId: i + 1
    }))
    expect(resonanceUpdateWardrobeArgs.safeParse([{ adds, removes: [] }]).success).toBe(false)
  })
})

describe('resonanceBannerWishlistSchema', () => {
  it('接受 version 1 + 合法条目的心愿单（含空表，清空即写空）', () => {
    expect(resonanceBannerWishlistSchema.safeParse({ version: 1, entries: [] }).success).toBe(true)
    expect(
      resonanceBannerWishlistSchema.safeParse({
        version: 1,
        entries: [{ bannerId: 74 }, { bannerId: 77 }]
      }).success
    ).toBe(true)
  })

  it('拒绝版本漂移与条目形态非法', () => {
    expect(resonanceBannerWishlistSchema.safeParse({ version: 2, entries: [] }).success).toBe(false)
    expect(resonanceBannerWishlistSchema.safeParse({ entries: [] }).success).toBe(false)
    expect(
      resonanceBannerWishlistSchema.safeParse({
        version: 1,
        entries: [{ bannerId: '74' }]
      }).success
    ).toBe(false)
  })

  it('边界：bannerId 为 1..999999 的正整数（与卡池 id 的 6 位口径一致），条目数不超上限', () => {
    expect(
      resonanceBannerWishlistSchema.safeParse({ version: 1, entries: [{ bannerId: 0 }] }).success
    ).toBe(false)
    expect(
      resonanceBannerWishlistSchema.safeParse({ version: 1, entries: [{ bannerId: -1 }] }).success
    ).toBe(false)
    expect(
      resonanceBannerWishlistSchema.safeParse({ version: 1, entries: [{ bannerId: 1.5 }] }).success
    ).toBe(false)
    // 未来新增到三位数的卡池不得被 schema 硬上限挡住
    expect(
      resonanceBannerWishlistSchema.safeParse({ version: 1, entries: [{ bannerId: 100 }] }).success
    ).toBe(true)
    expect(
      resonanceBannerWishlistSchema.safeParse({
        version: 1,
        entries: [{ bannerId: 1_000_000 }]
      }).success
    ).toBe(false)
    const entries = Array.from({ length: MAX_WISHLIST_ENTRIES + 1 }, () => ({ bannerId: 1 }))
    expect(resonanceBannerWishlistSchema.safeParse({ version: 1, entries }).success).toBe(false)
  })
})

describe('resonanceSetWishlistArgs', () => {
  it('接受单参心愿单载荷', () => {
    expect(
      resonanceSetWishlistArgs.safeParse([{ version: 1, entries: [{ bannerId: 30 }] }]).success
    ).toBe(true)
    expect(resonanceSetWishlistArgs.safeParse([{ version: 1, entries: [] }]).success).toBe(true)
  })

  it('拒绝多余参数、缺参与非法载荷', () => {
    expect(resonanceSetWishlistArgs.safeParse([{ version: 1, entries: [] }, 'extra']).success).toBe(
      false
    )
    expect(resonanceSetWishlistArgs.safeParse([]).success).toBe(false)
    expect(resonanceSetWishlistArgs.safeParse([{ version: 1 }]).success).toBe(false)
  })
})
