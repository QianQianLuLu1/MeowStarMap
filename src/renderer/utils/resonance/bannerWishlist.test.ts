import { describe, expect, it } from 'vitest'
import { createEmptyBannerWishlist, normalizeBannerWishlist } from './bannerWishlist'
import { ValidationError } from '../../../shared/errors/app-error'

/**
 * 卡池心愿单规范化（逻辑复用自 gongeo.us-nikki-tracker 的
 * shared/utils/bannerWishlist.ts，MIT, dastrokes）。
 *
 * 与源实现的差异：结构非法时抛宿主 AppError 家族的 ValidationError（源实现抛裸 Error），
 * 卡池存在性校验改用本地静态快照 BANNER_DATA。
 */

describe('createEmptyBannerWishlist', () => {
  it('返回 version 1 空表', () => {
    expect(createEmptyBannerWishlist()).toEqual({ version: 1, entries: [] })
  })
})

describe('normalizeBannerWishlist', () => {
  it('合法载荷保留并去重（同 bannerId 只留一条，保持首次出现顺序）', () => {
    expect(
      normalizeBannerWishlist({
        version: 1,
        entries: [{ bannerId: 76 }, { bannerId: 74 }, { bannerId: 76 }]
      })
    ).toEqual({ version: 1, entries: [{ bannerId: 76 }, { bannerId: 74 }] })
  })

  it('丢弃快照中不存在的卡池、非整数 id 与字符串 id（容忍跨版本导入）', () => {
    const out = normalizeBannerWishlist({
      version: 1,
      entries: [{ bannerId: 999999 }, { bannerId: 1.5 }, { bannerId: '74' }, { bannerId: 75 }]
    })
    expect(out.entries).toEqual([{ bannerId: 75 }])
  })

  it('结构非法时抛 ValidationError', () => {
    expect(() => normalizeBannerWishlist(null)).toThrow(ValidationError)
    expect(() => normalizeBannerWishlist('74')).toThrow(ValidationError)
    expect(() => normalizeBannerWishlist([])).toThrow(ValidationError)
    expect(() => normalizeBannerWishlist({ version: 2, entries: [] })).toThrow(ValidationError)
    expect(() => normalizeBannerWishlist({ version: 1, entries: 'x' })).toThrow(ValidationError)
    expect(() => normalizeBannerWishlist({ entries: [] })).toThrow(ValidationError)
  })

  it('边界：空 entries 合法；条目为非对象时逐条跳过而非整体失败', () => {
    expect(normalizeBannerWishlist({ version: 1, entries: [] }).entries).toEqual([])
    expect(
      normalizeBannerWishlist({ version: 1, entries: [null, 'x', { bannerId: 2 }] }).entries
    ).toEqual([{ bannerId: 2 }])
  })

  it('2.10.1 新增卡池 74-77 可作为心愿单条目被接受', () => {
    const out = normalizeBannerWishlist({
      version: 1,
      entries: [74, 75, 76, 77].map((bannerId) => ({ bannerId }))
    })
    expect(out.entries.length).toBe(4)
  })
})
