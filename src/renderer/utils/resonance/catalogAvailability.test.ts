import { describe, it, expect } from 'vitest'
import {
  normalizeCatalogRegionScope,
  isCatalogEntryAvailableInScope,
  filterCatalogIdsByRegionScope
} from './catalogAvailability'
import { loadCatalog } from './staticData'

/**
 * 区域可用性覆盖表测试：global/cn 双服目录差异逐条判定。
 */

describe('normalizeCatalogRegionScope', () => {
  it('合法值原样返回，非法/缺失回退 global', () => {
    expect(normalizeCatalogRegionScope('cn')).toBe('cn')
    expect(normalizeCatalogRegionScope('global')).toBe('global')
    expect(normalizeCatalogRegionScope(undefined)).toBe('global')
    expect(normalizeCatalogRegionScope(null)).toBe('global')
    expect(normalizeCatalogRegionScope('jp')).toBe('global')
    expect(normalizeCatalogRegionScope(1)).toBe('global')
  })
})

describe('isCatalogEntryAvailableInScope', () => {
  it('无覆盖表条目的实体在双服均可用', () => {
    expect(isCatalogEntryAvailableInScope('item', 1020000001, 'global')).toBe(true)
    expect(isCatalogEntryAvailableInScope('item', 1020000001, 'cn')).toBe(true)
    // makeup 无覆盖表条目
    expect(isCatalogEntryAvailableInScope('makeup', 2020000001, 'cn')).toBe(true)
    expect(isCatalogEntryAvailableInScope('makeup', 2020000001, 'global')).toBe(true)
  })

  it('cn 限定条目：cn 可用、global 不可用', () => {
    expect(isCatalogEntryAvailableInScope('item', 1021720039, 'cn')).toBe(true)
    expect(isCatalogEntryAvailableInScope('item', 1021720039, 'global')).toBe(false)
    expect(isCatalogEntryAvailableInScope('momo', 1160100148, 'cn')).toBe(true)
    expect(isCatalogEntryAvailableInScope('momo', 1160100148, 'global')).toBe(false)
  })

  it('global 限定条目：global 可用、cn 不可用', () => {
    expect(isCatalogEntryAvailableInScope('item', 1021720040, 'global')).toBe(true)
    expect(isCatalogEntryAvailableInScope('item', 1021720040, 'cn')).toBe(false)
  })

  it('上游 2.10.1 已把两条 cn 限定转为全球可用，覆盖表须剔除', async () => {
    // 依据：上游 65bb3d8f 的 shared/utils/catalogAvailability.ts 删除了 1021780109 / 1021940016 两条 cn 覆盖。
    // 先证明二者仍在 2.10.1 图鉴目录中（是「转全球可用」而非条目下架），再断言双服均可用。
    const catalog = await loadCatalog()
    const itemIds = new Set((catalog!.items as Array<{ id: number }>).map((item) => item.id))
    expect(itemIds.has(1021780109)).toBe(true)
    expect(itemIds.has(1021940016)).toBe(true)

    expect(isCatalogEntryAvailableInScope('item', 1021780109, 'global')).toBe(true)
    expect(isCatalogEntryAvailableInScope('item', 1021780109, 'cn')).toBe(true)
    expect(isCatalogEntryAvailableInScope('item', 1021940016, 'global')).toBe(true)
    expect(isCatalogEntryAvailableInScope('item', 1021940016, 'cn')).toBe(true)
  }, 30_000)

  it('scope 非法时回退 global 语义', () => {
    expect(isCatalogEntryAvailableInScope('item', 1021720039, 'jp' as never)).toBe(false)
    expect(isCatalogEntryAvailableInScope('item', 1020000001, 'jp' as never)).toBe(true)
  })
})

describe('filterCatalogIdsByRegionScope', () => {
  it('按范围过滤并保持原有顺序', () => {
    const ids = [1020000001, 1021720039, 1021720040, 1021780027]
    expect(filterCatalogIdsByRegionScope('item', ids, 'cn')).toEqual([
      1020000001, 1021720039, 1021780027
    ])
    expect(filterCatalogIdsByRegionScope('item', ids, 'global')).toEqual([1020000001, 1021720040])
  })

  it('空输入返回空数组', () => {
    expect(filterCatalogIdsByRegionScope('item', [], 'cn')).toEqual([])
  })
})
