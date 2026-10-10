import { describe, it, expect } from 'vitest'
import { getFullMakeupVariantType, getItemVariantType } from './variants'

/**
 * 整妆（fullMakeup）变体判定测试（逻辑复用自 gongeo.us-nikki-tracker 的
 * shared/utils/variants.ts getFullMakeupVariantType）。
 *
 * 整妆自身 id 不携带变体后缀，变体信息藏在 TbClothesSet.clothes 的部件 id 前缀里，
 * 因此需要按部件 id 反查整妆的变体类型。
 */

describe('getFullMakeupVariantType', () => {
  it('部件全部为基底前缀（1020）时判为 base', () => {
    expect(getFullMakeupVariantType([1020810001, 1020820001, 1020830001])).toBe('base')
  })

  it('部件含进化/觉醒前缀时返回首个非 base 的变体类型', () => {
    // 真实目录取证：整妆 10239002 的部件前缀为 1025（进化3）
    expect(getFullMakeupVariantType([1025810239, 1025820239, 1025830239])).toBe('evo3')
    expect(getFullMakeupVariantType([1022810001])).toBe('glowup')
    expect(getFullMakeupVariantType([1023810001])).toBe('evo1')
    expect(getFullMakeupVariantType([1024810001])).toBe('evo2')
  })

  it('基底部件在前、变体部件在后时仍判为变体', () => {
    expect(getFullMakeupVariantType([1020810001, 1025810001])).toBe('evo3')
  })

  it('异常输入不抛错：空数组 / 非 10 位 id 回落 base', () => {
    expect(getFullMakeupVariantType([])).toBe('base')
    expect(getFullMakeupVariantType([10001002])).toBe('base')
  })

  it('与 getItemVariantType 的前缀口径一致', () => {
    const components = [1020810001, 1025810239, 1022810001]
    const expected = components.map((id) => getItemVariantType(id)).find((type) => type !== 'base')
    expect(getFullMakeupVariantType(components)).toBe(expected ?? 'base')
  })
})
