import { describe, expect, it } from 'vitest'
import { buildExportPayload, getResonanceExportFileName } from './exportPayload'
import { parseImportFileText } from './importParse'
import { createEmptyWardrobeData } from './wardrobe'
import type { ResonanceGetDataResult } from '../../../shared/types/resonance'

function makeData(): ResonanceGetDataResult {
  return {
    pulls: [
      {
        id: 2,
        banner_id: '2',
        item_id: '1020000001',
        obtained_at: '2025-01-02 10:00:00',
        source: 'json',
        created_at: ''
      },
      {
        id: 1,
        banner_id: '2',
        item_id: '2020000002',
        obtained_at: '2025-01-01 10:00:00',
        source: 'json',
        created_at: ''
      }
    ],
    edits: [
      {
        id: 1,
        banner_id: '3',
        item_id: '2020000003',
        obtained_at: '2025-01-03 09:00:00',
        created_at: ''
      }
    ],
    pearpal: [
      {
        banner_id: '4',
        item_id: '1020000001',
        pool_cnt: 5,
        obtained_at: '2025-01-04 00:00:00',
        raw: {
          card_pool_id: '4',
          pool_cnt: 5,
          result: '1020000001',
          times_from_last_five_stars: 7,
          times_from_last_four_stars: 2,
          rarity: '5'
        }
      }
    ],
    evo: [{ banner_id: '2', outfit_id: '10001', level: 2, updated_at: '' }],
    wardrobe: {
      version: 1,
      ownedItemIds: [1020000001, 2020000002],
      ownedMakeupIds: [10001001],
      ownedMomoIds: [],
      ownedPropIds: [],
      ownedEurekaColorIds: [1341],
      updatedAt: '2025-01-01T00:00:00.000Z'
    }
  }
}

const allOptions = {
  includePulls: true,
  includeEdits: true,
  includePearpal: true,
  includeEvo: true,
  includeWardrobe: true
}

describe('buildExportPayload', () => {
  it('导出格式与源站同构，pulls 最新在前', () => {
    const payload = buildExportPayload(makeData(), allOptions, new Date('2025-06-01T00:00:00Z'))
    expect(payload).not.toBeNull()
    expect(payload!.pulls['2']).toEqual([
      ['2025-01-02 10:00:00', '1020000001'],
      ['2025-01-01 10:00:00', '2020000002']
    ])
    expect(payload!.edits['3']).toEqual([['2025-01-03 09:00:00', '2020000003']])
    expect(payload!.evo['2']).toEqual([['10001', 2]])
    expect(payload!.pearpal['4']![0].times_from_last_five_stars).toBe(7)
    expect(payload!.wardrobe?.ownedEurekaColorIds).toEqual([1341])
  })

  it('全部为空时返回 null（无可导出）', () => {
    const empty: ResonanceGetDataResult = {
      pulls: [],
      edits: [],
      pearpal: [],
      evo: [],
      wardrobe: createEmptyWardrobeData()
    }
    expect(buildExportPayload(empty, allOptions)).toBeNull()
  })

  it('内容勾选生效', () => {
    const payload = buildExportPayload(makeData(), { ...allOptions, includePulls: false })
    expect(payload!.pulls).toEqual({})
    expect(payload!.edits['3']).toHaveLength(1)
  })
})

describe('导出 → 导入 round-trip 一致性', () => {
  it('导出文件再解析后数据深度一致', () => {
    const payload = buildExportPayload(makeData(), allOptions, new Date('2025-06-01T00:00:00Z'))
    const text = JSON.stringify(payload)
    const parsed = parseImportFileText(text)

    expect(parsed.versionMismatch).toBe(false)
    // pulls：round-trip 后逐条一致
    expect(parsed.pulls[2]).toEqual([
      ['2025-01-02 10:00:00', '1020000001'],
      ['2025-01-01 10:00:00', '2020000002']
    ])
    expect(parsed.edits[3]).toEqual([['2025-01-03 09:00:00', '2020000003']])
    expect(parsed.evo[2]).toEqual([['10001', 2]])
    expect(parsed.pearpal[4]).toEqual([
      {
        card_pool_id: '4',
        pool_cnt: 5,
        result: '1020000001',
        times_from_last_five_stars: 7,
        times_from_last_four_stars: 2,
        rarity: '5'
      }
    ])
    expect(parsed.wardrobe).toEqual(makeData().wardrobe)
    expect(parsed.invalid).toHaveLength(0)
    expect(parsed.totalValidRecords).toBe(5)
  })

  it('源站风格导出（无 version/app 字段）也能导入', () => {
    const legacySourceFile = {
      pulls: { 2: [['2025-01-02 10:00:00', '1020000001']] },
      edits: {},
      evo: {},
      pearpal: {},
      wardrobe: { version: 1, ownedItemIds: [1020000001], updatedAt: '' }
    }
    const parsed = parseImportFileText(JSON.stringify(legacySourceFile))
    expect(parsed.format).toBe('current')
    expect(parsed.version).toBeNull()
    expect(parsed.wardrobe?.ownedItemIds).toEqual([1020000001])
  })
})

describe('getResonanceExportFileName', () => {
  it('包含日期', () => {
    expect(getResonanceExportFileName(new Date('2025-06-01T00:00:00Z'))).toBe(
      'nikkigallery-resonance-2025-06-01.json'
    )
  })
})
