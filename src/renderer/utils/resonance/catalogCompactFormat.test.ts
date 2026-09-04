import { describe, it, expect } from 'vitest'
import { decodeCatalogPartPayload } from './catalogCompactFormat'
import type { CatalogItemEntry } from './catalogCompactFormat'

/**
 * 紧凑目录格式解码器测试：压缩壳 / 裸行数组 / 已展开数组三种形态，
 * 覆盖计划 §7.1 要求的「各 part 解码 + 损坏输入守卫」。
 */

describe('decodeCatalogPartPayload items', () => {
  it('压缩壳：字典解析 type/style、label 编号展开、可选字段条件输出', () => {
    const decoded = decodeCatalogPartPayload('items', {
      v: 1,
      t: ['hair', 'dresses'],
      s: ['sweet', 'cool'],
      r: [
        [1020000001, 5, 0, 0, [3, 'customLabel'], 1, 1020000009],
        [[1020000002, 1020000003], 4, 1, 1, [], null, null]
      ]
    }) as CatalogItemEntry[]
    expect(decoded).toHaveLength(3)
    expect(decoded[0]).toEqual({
      id: 1020000001,
      quality: 5,
      type: 'hair',
      style: 'style.sweet',
      labels: ['label.3.name', 'customLabel'],
      obtain_type: 1,
      catalogGroupRootId: 1020000009
    })
    // 同族多 id：逐 id 展开并携带 catalogGroupIds，无 root / obtain 时字段缺省
    expect(decoded[1]!.id).toBe(1020000002)
    expect(decoded[2]!.id).toBe(1020000003)
    expect(decoded[1]!.catalogGroupIds).toEqual([1020000002, 1020000003])
    expect(decoded[1]!.style).toBe('style.cool')
    expect(decoded[1]!.type).toBe('dresses')
    expect('obtain_type' in decoded[1]!).toBe(false)
    expect('catalogGroupRootId' in decoded[1]!).toBe(false)
  })

  it('裸行数组形态（无 v/r 壳）按默认字典解码', () => {
    const decoded = decodeCatalogPartPayload('items', [
      [[1020000005], 4, 0, null, [], null, null]
    ]) as CatalogItemEntry[]
    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toMatchObject({ id: 1020000005, quality: 4, type: 'hair', style: null })
  })

  it('已展开数组原样透传', () => {
    const expanded = [{ id: 1, quality: 5, type: 'hair', style: null, labels: [] }]
    expect(decodeCatalogPartPayload('items', expanded)).toBe(expanded)
  })
})

describe('decodeCatalogPartPayload outfits / makeups / momo', () => {
  it('outfits 裸行解码', () => {
    const decoded = decodeCatalogPartPayload('outfits', [
      [[1020000009], 5, 0, [1], 2, null]
    ]) as Array<{
      id: number
      quality: number
      style: string | null
      labels: string[]
      obtain_type?: number
    }>
    expect(decoded[0]).toMatchObject({
      id: 1020000009,
      quality: 5,
      style: 'style.sweet',
      labels: ['label.1.name'],
      obtain_type: 2
    })
  })

  it('makeups 压缩壳使用妆容类型字典', () => {
    const decoded = decodeCatalogPartPayload('makeups', {
      v: 1,
      t: ['fullMakeup', 'lips'],
      s: ['sweet'],
      r: [[[2020000001], 5, 1, 0, 2, null]]
    }) as Array<{ type: string; style: string | null; obtain_type: number }>
    expect(decoded[0]).toMatchObject({ type: 'lips', style: 'style.sweet', obtain_type: 2 })
  })

  it('momo 多 id 展开、version 字符串化', () => {
    const decoded = decodeCatalogPartPayload('momo', {
      v: 1,
      r: [[[1160100148, 1160100149], 4, 1, '2.8', null]]
    }) as Array<{ id: number; version?: string; catalogGroupIds?: number[] }>
    expect(decoded).toHaveLength(2)
    expect(decoded[0]!.id).toBe(1160100148)
    expect(decoded[1]!.id).toBe(1160100149)
    expect(decoded[0]!.version).toBe('2.8')
    expect(decoded[0]!.catalogGroupIds).toEqual([1160100148, 1160100149])
  })
})

describe('decodeCatalogPartPayload eurekas / props / relations', () => {
  it('eurekas：风格五维、主风格、颜色序号', () => {
    const decoded = decodeCatalogPartPayload('eurekas', {
      v: 1,
      s: ['sweet', 'cool'],
      r: [
        [
          1160100001,
          1020000009,
          0,
          5,
          [10, 8, 9, 7, 6],
          0,
          [3, 4, 'x'],
          5,
          [
            [9001, 2],
            [9002, 1]
          ]
        ]
      ]
    }) as Array<Record<string, unknown>>
    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toMatchObject({
      id: 1160100001,
      suitId: 1020000009,
      position: 'head',
      quality: 5,
      mainStyle: 'sweet',
      tagIds: [3, 4],
      provinceId: 5
    })
    expect(decoded[0]!.styles).toEqual({ elegant: 10, fresh: 8, sweet: 9, sexy: 7, cool: 6 })
    expect(decoded[0]!.colors).toEqual([
      { id: 9001, order: 1, colorType: 2 },
      { id: 9002, order: 2, colorType: 1 }
    ])
  })

  it('props：sources/bannerIds 白名单过滤、可选字段条件输出', () => {
    const decoded = decodeCatalogPartPayload('props', {
      v: 1,
      r: [[1160000001, 4, 1160000000, ['event', 'bogus'], '2.9', [71, 'x']]]
    }) as Array<Record<string, unknown>>
    expect(decoded[0]).toMatchObject({
      id: 1160000001,
      quality: 4,
      variantRootId: 1160000000,
      sources: ['event'],
      version: '2.9',
      bannerIds: [71]
    })
  })

  it('relations：outfitId → itemIds 映射（压缩壳与裸行两种形态）', () => {
    const fromShell = decodeCatalogPartPayload('outfitItems', {
      v: 1,
      r: [['1020000009', [1020000001, 1020000002, 'x']]]
    }) as Record<string, number[]>
    expect(fromShell).toEqual({ '1020000009': [1020000001, 1020000002] })

    const fromRows = decodeCatalogPartPayload('momoOutfits', [
      [1160100148, [1160100149]]
    ]) as Record<string, number[]>
    expect(fromRows).toEqual({ '1160100148': [1160100149] })
  })
})

describe('decodeCatalogPartPayload 损坏输入守卫（不抛异常，原样透传）', () => {
  it('非对象/非数组输入原样返回', () => {
    expect(decodeCatalogPartPayload('items', null)).toBeNull()
    expect(decodeCatalogPartPayload('items', 42)).toBe(42)
    expect(decodeCatalogPartPayload('outfitItems', 'garbage')).toBe('garbage')
  })

  it('缺少 r 或 v 的对象、元素非数组的数组原样返回', () => {
    const shellOnly = { v: 1 }
    expect(decodeCatalogPartPayload('items', shellOnly)).toBe(shellOnly)
    const malformed = { v: 1, r: 'not-rows' }
    expect(decodeCatalogPartPayload('momo', malformed)).toBe(malformed)
    const flatArray = [1, 2, 3]
    expect(decodeCatalogPartPayload('props', flatArray)).toBe(flatArray)
  })

  it('行内字段畸形时降级为空集合而不抛出', () => {
    const decoded = decodeCatalogPartPayload('eurekas', {
      v: 1,
      r: [[1160100001, 'x', 'y', null, 'z', null, 'w', null, 'v']]
    }) as Array<Record<string, unknown>>
    expect(decoded).toHaveLength(1)
    expect(decoded[0]!.tagIds).toEqual([])
    expect(decoded[0]!.colors).toEqual([])
  })
})
