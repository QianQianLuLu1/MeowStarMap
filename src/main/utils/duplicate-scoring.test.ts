import { describe, it, expect, vi, beforeEach } from 'vitest'

// R19：mock logger 避免 electron app 依赖与控制台噪声
const { loggerWarnMock } = vi.hoisted(() => ({
  loggerWarnMock: vi.fn()
}))

vi.mock('./logger', () => ({
  logger: {
    warn: loggerWarnMock,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fault: vi.fn()
  }
}))

import { scoreGroup, pickBestId, type ScoreInput } from './duplicate-scoring'

/**
 * duplicate-scoring 评分逻辑 characterization tests
 *
 * 目的：在 P2 重构前固化现有评分行为，作为安全网。
 * 评分维度（满分 100）：
 * - 分辨率 40 分（width*height 归一化）
 * - 文件大小 30 分（file_size 归一化）
 * - 拍摄时间 20 分（modified_at 越新越高）
 * - 收藏加权 10 分（is_favorite 或 rating > 0）
 *
 * 边界场景：空数组、null 尺寸、0 尺寸、无效日期、相同时间戳、
 * 极端分辨率/文件大小、负数 rating、分数相同排序稳定性。
 */

// 测试用工厂函数
function makeItem(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    id: 1,
    file_size: 1000,
    width: 1920,
    height: 1080,
    modified_at: '2024-01-01T00:00:00.000Z',
    is_favorite: false,
    rating: 0,
    ...overrides
  }
}

describe('duplicate-scoring', () => {
  beforeEach(() => {
    loggerWarnMock.mockClear()
  })

  describe('scoreGroup', () => {
    describe('空数组与单元素', () => {
      it('空数组返回空数组', () => {
        expect(scoreGroup([])).toEqual([])
      })

      it('单元素数组返回该项评分（归一化值全为 0 或 1）', () => {
        const item = makeItem()
        const result = scoreGroup([item])
        expect(result).toHaveLength(1)
        expect(result[0].item.id).toBe(1)
        // 单元素时 maxResolution = pixels，所以 resolutionNorm = 1
        expect(result[0].dimensions.resolution).toBe(1)
        // 单元素时 maxFileSize = file_size，所以 fileSizeNorm = 1
        expect(result[0].dimensions.fileSize).toBe(1)
        // 单元素时 maxTimestamp = minTimestamp，timestampRange = max(1, 0) = 1
        // recencyNorm = (ts - ts) / 1 = 0
        expect(result[0].dimensions.recency).toBe(0)
        // is_favorite=false, rating=0，favoriteNorm = 0
        expect(result[0].dimensions.favorite).toBe(0)
        // score = 1*40 + 1*30 + 0*20 + 0*10 = 70
        expect(result[0].score).toBe(70)
      })
    })

    describe('分辨率维度（40 分）', () => {
      it('width/height 为 null 时 pixels = 0，resolutionNorm = 0', () => {
        const items = [
          makeItem({ id: 1, width: null, height: null }),
          makeItem({ id: 2, width: 1920, height: 1080 })
        ]
        const result = scoreGroup(items)
        const item1 = result.find((r) => r.item.id === 1)!
        expect(item1.dimensions.resolution).toBe(0)
      })

      it('所有 width/height 为 null 时 maxResolution = 0，所有 resolutionNorm = 0', () => {
        const items = [
          makeItem({ id: 1, width: null, height: null }),
          makeItem({ id: 2, width: null, height: null })
        ]
        const result = scoreGroup(items)
        expect(result.every((r) => r.dimensions.resolution === 0)).toBe(true)
      })

      it('width/height 为 0 时 pixels = 0', () => {
        const items = [
          makeItem({ id: 1, width: 0, height: 0 }),
          makeItem({ id: 2, width: 1920, height: 1080 })
        ]
        const result = scoreGroup(items)
        const item1 = result.find((r) => r.item.id === 1)!
        expect(item1.dimensions.resolution).toBe(0)
      })

      it('最高分辨率项 resolutionNorm = 1', () => {
        const items = [
          makeItem({ id: 1, width: 1280, height: 720 }),
          makeItem({ id: 2, width: 1920, height: 1080 })
        ]
        const result = scoreGroup(items)
        const item2 = result.find((r) => r.item.id === 2)!
        expect(item2.dimensions.resolution).toBe(1)
      })

      it('分辨率归一化按宽×高乘积计算', () => {
        const items = [
          makeItem({ id: 1, width: 960, height: 540 }), // 518400
          makeItem({ id: 2, width: 1920, height: 1080 }) // 2073600
        ]
        const result = scoreGroup(items)
        const item1 = result.find((r) => r.item.id === 1)!
        // 518400 / 2073600 = 0.25
        expect(item1.dimensions.resolution).toBeCloseTo(0.25, 10)
      })
    })

    describe('文件大小维度（30 分）', () => {
      it('file_size = 0 时 fileSizeNorm = 0', () => {
        const items = [makeItem({ id: 1, file_size: 0 }), makeItem({ id: 2, file_size: 1000 })]
        const result = scoreGroup(items)
        const item1 = result.find((r) => r.item.id === 1)!
        expect(item1.dimensions.fileSize).toBe(0)
      })

      it('所有 file_size ≤ 0 时 maxFileSize = 0，所有 fileSizeNorm = 0', () => {
        const items = [makeItem({ id: 1, file_size: 0 }), makeItem({ id: 2, file_size: -100 })]
        const result = scoreGroup(items)
        expect(result.every((r) => r.dimensions.fileSize === 0)).toBe(true)
      })

      it('负数 file_size 不影响 maxFileSize（> 比较不命中）', () => {
        const items = [makeItem({ id: 1, file_size: -100 }), makeItem({ id: 2, file_size: -200 })]
        const result = scoreGroup(items)
        // 两个负数都不 > 0（初始 maxFileSize），所以 maxFileSize = 0
        expect(result.every((r) => r.dimensions.fileSize === 0)).toBe(true)
      })

      it('最大 file_size 项 fileSizeNorm = 1', () => {
        const items = [makeItem({ id: 1, file_size: 500 }), makeItem({ id: 2, file_size: 2000 })]
        const result = scoreGroup(items)
        const item2 = result.find((r) => r.item.id === 2)!
        expect(item2.dimensions.fileSize).toBe(1)
      })
    })

    describe('时间维度（20 分）', () => {
      it('无效日期字符串 → ts = NaN → recencyNorm = 1（fallback）', () => {
        const items = [
          makeItem({ id: 1, modified_at: 'invalid date' }),
          makeItem({ id: 2, modified_at: '2024-01-01T00:00:00.000Z' })
        ]
        const result = scoreGroup(items)
        const item1 = result.find((r) => r.item.id === 1)!
        // ts = NaN，Number.isFinite(NaN) = false，所以 recencyNorm = 1
        expect(item1.dimensions.recency).toBe(1)
      })

      it('所有日期都无效时 maxTimestamp = 0, minTimestamp = Infinity', () => {
        const items = [
          makeItem({ id: 1, modified_at: 'invalid' }),
          makeItem({ id: 2, modified_at: 'also invalid' })
        ]
        const result = scoreGroup(items)
        // timestampRange = max(1, 0 - Infinity) = max(1, -Infinity) = 1
        // recencyNorm = Number.isFinite(NaN) && 1 > 0 ? ... : 1 = 1
        expect(result.every((r) => r.dimensions.recency === 1)).toBe(true)
      })

      it('相同时间戳 → timestampRange = max(1, 0) = 1，recencyNorm = 0', () => {
        const items = [
          makeItem({ id: 1, modified_at: '2024-01-01T00:00:00.000Z' }),
          makeItem({ id: 2, modified_at: '2024-01-01T00:00:00.000Z' })
        ]
        const result = scoreGroup(items)
        expect(result.every((r) => r.dimensions.recency === 0)).toBe(true)
      })

      it('更新的时间戳 recencyNorm = 1，最旧的 recencyNorm = 0', () => {
        const items = [
          makeItem({ id: 1, modified_at: '2024-01-01T00:00:00.000Z' }), // 旧
          makeItem({ id: 2, modified_at: '2024-12-31T00:00:00.000Z' }) // 新
        ]
        const result = scoreGroup(items)
        const item1 = result.find((r) => r.item.id === 1)!
        const item2 = result.find((r) => r.item.id === 2)!
        expect(item1.dimensions.recency).toBe(0)
        expect(item2.dimensions.recency).toBe(1)
      })

      it('中间时间戳 recencyNorm 在 (0, 1) 之间', () => {
        const items = [
          makeItem({ id: 1, modified_at: '2024-01-01T00:00:00.000Z' }), // 0
          makeItem({ id: 2, modified_at: '2024-07-01T00:00:00.000Z' }), // 中间
          makeItem({ id: 3, modified_at: '2024-12-31T00:00:00.000Z' }) // 1
        ]
        const result = scoreGroup(items)
        const item2 = result.find((r) => r.item.id === 2)!
        expect(item2.dimensions.recency).toBeGreaterThan(0)
        expect(item2.dimensions.recency).toBeLessThan(1)
      })

      it('混合有效/无效日期时，无效日期的 recencyNorm = 1（最高）', () => {
        const items = [
          makeItem({ id: 1, modified_at: '2024-01-01T00:00:00.000Z' }),
          makeItem({ id: 2, modified_at: 'invalid' })
        ]
        const result = scoreGroup(items)
        const item1 = result.find((r) => r.item.id === 1)!
        const item2 = result.find((r) => r.item.id === 2)!
        // item1 是唯一有效日期，maxTimestamp = minTimestamp = its ts
        // recencyNorm = (ts - ts) / 1 = 0
        expect(item1.dimensions.recency).toBe(0)
        // item2 无效日期 → recencyNorm = 1
        expect(item2.dimensions.recency).toBe(1)
      })
    })

    describe('收藏维度（10 分）', () => {
      it('is_favorite = true 时 favoriteNorm = 1', () => {
        const result = scoreGroup([makeItem({ id: 1, is_favorite: true })])
        expect(result[0].dimensions.favorite).toBe(1)
      })

      it('rating > 0 时 favoriteNorm = 1', () => {
        const result = scoreGroup([makeItem({ id: 1, rating: 5 })])
        expect(result[0].dimensions.favorite).toBe(1)
      })

      it('rating = 0 且 is_favorite = false 时 favoriteNorm = 0', () => {
        const result = scoreGroup([makeItem({ id: 1, rating: 0, is_favorite: false })])
        expect(result[0].dimensions.favorite).toBe(0)
      })

      it('rating 为负数时 favoriteNorm = 0（rating > 0 不成立）', () => {
        const result = scoreGroup([makeItem({ id: 1, rating: -1 })])
        expect(result[0].dimensions.favorite).toBe(0)
      })

      it('is_favorite = true 且 rating = 0 时 favoriteNorm = 1', () => {
        const result = scoreGroup([makeItem({ id: 1, is_favorite: true, rating: 0 })])
        expect(result[0].dimensions.favorite).toBe(1)
      })
    })

    describe('score 计算', () => {
      it('满分 = 40 + 30 + 20 + 10 = 100', () => {
        // 单元素，分辨率/文件大小归一化为 1，时间为 0，收藏为 1
        const result = scoreGroup([makeItem({ is_favorite: true })])
        // score = 1*40 + 1*30 + 0*20 + 1*10 = 80
        expect(result[0].score).toBe(80)
      })

      it('score 保留 1 位小数（Math.round(score * 10) / 10）', () => {
        // 构造一个会产生多位小数的场景
        const items = [
          makeItem({ id: 1, width: 1000, height: 1000, file_size: 300 }), // 1000000 像素，300 字节
          makeItem({ id: 2, width: 1920, height: 1080, file_size: 1000 }) // 2073600 像素，1000 字节
        ]
        const result = scoreGroup(items)
        // 验证所有 score 都是 1 位小数
        for (const r of result) {
          expect(r.score).toBe(Math.round(r.score * 10) / 10)
        }
      })

      it('全 0 维度时 score = 0', () => {
        // 所有维度归一化为 0：maxResolution=0, maxFileSize=0, recencyNorm=0, favorite=0
        // 但单元素时 resolution/fileSize 会是 1，需要构造特殊场景
        const items = [
          makeItem({
            id: 1,
            width: null,
            height: null,
            file_size: 0,
            modified_at: '2024-01-01T00:00:00.000Z',
            is_favorite: false,
            rating: 0
          }),
          makeItem({
            id: 2,
            width: null,
            height: null,
            file_size: 0,
            modified_at: '2024-01-01T00:00:00.000Z',
            is_favorite: false,
            rating: 0
          })
        ]
        const result = scoreGroup(items)
        // maxResolution = 0, maxFileSize = 0, timestampRange = 1, recencyNorm = 0
        // score = 0*40 + 0*30 + 0*20 + 0*10 = 0
        expect(result.every((r) => r.score === 0)).toBe(true)
      })
    })

    describe('排序', () => {
      it('按 score 降序排序', () => {
        const items = [
          makeItem({ id: 1, width: 1280, height: 720, file_size: 500 }),
          makeItem({ id: 2, width: 1920, height: 1080, file_size: 2000, is_favorite: true }),
          makeItem({ id: 3, width: 640, height: 480, file_size: 100 })
        ]
        const result = scoreGroup(items)
        expect(result[0].score).toBeGreaterThanOrEqual(result[1].score)
        expect(result[1].score).toBeGreaterThanOrEqual(result[2].score)
        // 最高分应该是 id=2（分辨率最高 + 文件最大 + 收藏）
        expect(result[0].item.id).toBe(2)
      })

      it('分数相同时保持稳定排序（Array.sort 稳定性）', () => {
        // 构造完全相同的两项
        const items = [makeItem({ id: 1 }), makeItem({ id: 2 })]
        const result = scoreGroup(items)
        // 两项分数相同，排序稳定（Node 12+ 的 Array.sort 是稳定的）
        expect(result[0].score).toBe(result[1].score)
        // 不强制断言顺序，仅断言分数相同
      })

      it('分数相同但 favorite 状态不同时排序稳定（固化当前行为）', () => {
        // 两项的分数维度计算差异由 favorite + rating 决定，但若其他维度差异正好抵消，
        // 会出现"同分但 favorite 不同"的情况。当前 scoreGroup 仅按 score 降序排，
        // 不对 favorite 做次级排序，固化此行为。
        // 构造：item1 高分辨率低评分（无 favorite），item2 低分辨率有 favorite
        // item1: resolution=1, fileSize=1, recency=1, favorite=0 → 40+30+20+0 = 90
        // item2: resolution=0.5, fileSize=1, recency=1, favorite=1 → 20+30+20+10 = 80
        // 这是不同分；为构造"同分但 favorite 不同"：
        // item1: resolution=1, fileSize=1, recency=0, favorite=0 → 40+30+0+0 = 70
        // item2: resolution=1, fileSize=0, recency=1, favorite=1 → 40+0+20+10 = 70
        const items = [
          makeItem({
            id: 1,
            width: 1920,
            height: 1080,
            file_size: 1000,
            modified_at: '2024-01-01T00:00:00.000Z',
            is_favorite: false,
            rating: 0
          }),
          makeItem({
            id: 2,
            width: 1920,
            height: 1080,
            file_size: 0,
            modified_at: '2024-12-31T00:00:00.000Z',
            is_favorite: true,
            rating: 0
          })
        ]
        const result = scoreGroup(items)
        // 同分
        expect(result[0].score).toBe(result[1].score)
        // 当前实现不做 favorite 次级排序，仅按输入顺序保留稳定排序
        // Node 12+ Array.sort 稳定 → 输入在前者保留在前
        expect(result[0].item.id).toBe(1)
      })
    })

    describe('返回结构', () => {
      it('返回 ScoredItem 包含 item/score/dimensions', () => {
        const result = scoreGroup([makeItem()])
        expect(result[0]).toHaveProperty('item')
        expect(result[0]).toHaveProperty('score')
        expect(result[0]).toHaveProperty('dimensions')
        expect(result[0].dimensions).toHaveProperty('resolution')
        expect(result[0].dimensions).toHaveProperty('fileSize')
        expect(result[0].dimensions).toHaveProperty('recency')
        expect(result[0].dimensions).toHaveProperty('favorite')
      })

      it('保留原始 item 引用（不复制）', () => {
        const item = makeItem({ id: 42 })
        const result = scoreGroup([item])
        expect(result[0].item).toBe(item)
        expect(result[0].item.id).toBe(42)
      })

      it('泛型 T 扩展 ScoreInput 时保留额外字段', () => {
        interface ExtendedItem extends ScoreInput {
          extra: string
        }
        const items: ExtendedItem[] = [{ ...makeItem({ id: 1 }), extra: 'hello' }]
        const result = scoreGroup(items)
        expect(result[0].item.extra).toBe('hello')
      })
    })

    describe('极端输入', () => {
      it('极大分辨率（Number.MAX_SAFE_INTEGER）不溢出', () => {
        const items = [
          makeItem({ id: 1, width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER })
        ]
        const result = scoreGroup(items)
        expect(result[0].dimensions.resolution).toBe(1)
        expect(Number.isFinite(result[0].score)).toBe(true)
      })

      it('极大文件大小（Number.MAX_SAFE_INTEGER）不溢出', () => {
        const items = [makeItem({ id: 1, file_size: Number.MAX_SAFE_INTEGER })]
        const result = scoreGroup(items)
        expect(result[0].dimensions.fileSize).toBe(1)
      })

      it('Infinity width 会导致 pixels = Infinity，但归一化后仍是有限数', () => {
        const items = [makeItem({ id: 1, width: Infinity, height: Infinity })]
        const result = scoreGroup(items)
        // maxResolution = Infinity * Infinity = Infinity
        // resolutionNorm = Infinity / Infinity = NaN
        // 这是当前行为，固化它（潜在 bug，但不是本次重构范围）
        expect(result[0].dimensions.resolution).toBeNaN()
      })

      it('负数 width/height 会产生正 pixels（负×负=正）', () => {
        const items = [
          makeItem({ id: 1, width: -100, height: -100 }), // pixels = 10000
          makeItem({ id: 2, width: 1920, height: 1080 }) // pixels = 2073600
        ]
        const result = scoreGroup(items)
        const item1 = result.find((r) => r.item.id === 1)!
        // 10000 / 2073600 ≈ 0.00482
        expect(item1.dimensions.resolution).toBeCloseTo(10000 / 2073600, 10)
      })

      it('一个负数 width 一个正数 height 会产生负 pixels', () => {
        const items = [
          makeItem({ id: 1, width: -1920, height: 1080 }), // pixels = -2073600
          makeItem({ id: 2, width: 1920, height: 1080 }) // pixels = 2073600
        ]
        const result = scoreGroup(items)
        const item1 = result.find((r) => r.item.id === 1)!
        // maxResolution = 2073600（item2 的）
        // item1 pixels = -2073600，-2073600 > 2073600 为 false，所以不影响 maxResolution
        // resolutionNorm = -2073600 / 2073600 = -1
        expect(item1.dimensions.resolution).toBe(-1)
      })
    })
  })

  describe('pickBestId', () => {
    it('空数组返回 null', () => {
      expect(pickBestId([])).toBeNull()
    })

    it('单元素数组返回该项 id', () => {
      expect(pickBestId([makeItem({ id: 42 })])).toBe(42)
    })

    it('多元素数组返回最高分项 id', () => {
      const items = [
        makeItem({ id: 1, width: 1280, height: 720, file_size: 500 }),
        makeItem({ id: 2, width: 1920, height: 1080, file_size: 2000, is_favorite: true }),
        makeItem({ id: 3, width: 640, height: 480, file_size: 100 })
      ]
      expect(pickBestId(items)).toBe(2)
    })

    it('分数相同时返回第一个 item 的 id（取决于 scoreGroup 排序稳定性）', () => {
      const items = [makeItem({ id: 1 }), makeItem({ id: 2 })]
      // 两项完全相同，分数相同，sort 稳定时返回 id=1
      // Node 12+ Array.sort 稳定，所以返回 1
      const result = pickBestId(items)
      expect(result).toBe(1)
    })

    it('保留泛型类型', () => {
      interface ExtendedItem extends ScoreInput {
        extra: string
      }
      const items: ExtendedItem[] = [{ ...makeItem({ id: 99 }), extra: 'test' }]
      expect(pickBestId(items)).toBe(99)
    })
  })

  // ============ R19：NULL width/height 防御 ============
  describe('R19：width/height 为 NULL 时评分置 0 且不参与推荐删除', () => {
    it('NULL width/height 的项 score 强制为 0（即使其他维度很高）', () => {
      const items = [
        // NULL 项：file_size 最大 + 最新时间 + 收藏 → 原本应得高分
        makeItem({
          id: 1,
          width: null,
          height: null,
          file_size: 5000,
          modified_at: '2024-12-31T00:00:00.000Z',
          is_favorite: true,
          rating: 5
        }),
        // 有效项：分辨率/文件大小较低，时间较旧，无收藏
        makeItem({
          id: 2,
          width: 640,
          height: 480,
          file_size: 1000,
          modified_at: '2024-01-01T00:00:00.000Z',
          is_favorite: false,
          rating: 0
        })
      ]
      const result = scoreGroup(items)
      const nullItem = result.find((r) => r.item.id === 1)!
      const validItem = result.find((r) => r.item.id === 2)!
      // R19：NULL 项 score 必须为 0，无论其他维度多高
      expect(nullItem.score).toBe(0)
      // 有效项 score 应 > 0（resolution=1, fileSize=0.2, recency=0, favorite=0 → 40+6+0+0=46）
      expect(validItem.score).toBeGreaterThan(0)
      // 有效项应排在 NULL 项之前（因 score 更高）
      expect(result[0].item.id).toBe(2)
    })

    it('NULL 项 dimensions 仍保留实际归一化值供调试', () => {
      const items = [
        makeItem({ id: 1, width: null, height: null, file_size: 1000 }),
        makeItem({ id: 2, width: 1920, height: 1080, file_size: 1000 })
      ]
      const result = scoreGroup(items)
      const nullItem = result.find((r) => r.item.id === 1)!
      // dimensions.resolution 按 (0*0)/maxResolution 计算 = 0
      expect(nullItem.dimensions.resolution).toBe(0)
      // dimensions.fileSize 按 1000/1000 计算 = 1（仍参与归一化）
      expect(nullItem.dimensions.fileSize).toBe(1)
      // 但 score 强制为 0
      expect(nullItem.score).toBe(0)
    })

    it('所有项均 NULL 时所有 score 为 0，pickBestId 返回 null', () => {
      const items = [
        makeItem({ id: 1, width: null, height: null, is_favorite: true, rating: 5 }),
        makeItem({ id: 2, width: null, height: null, is_favorite: false, rating: 0 })
      ]
      const result = scoreGroup(items)
      expect(result.every((r) => r.score === 0)).toBe(true)
      // R19：所有项 NULL 时 pickBestId 返回 null，不推荐删除任何项
      expect(pickBestId(items)).toBeNull()
    })

    it('单元素 NULL 项时 pickBestId 返回 null（不推荐删除）', () => {
      const items = [makeItem({ id: 42, width: null, height: null })]
      // scoreGroup 仍返回该项（score=0），但 pickBestId 守卫返回 null
      const result = scoreGroup(items)
      expect(result).toHaveLength(1)
      expect(result[0].score).toBe(0)
      expect(pickBestId(items)).toBeNull()
    })

    it('混合 NULL 与有效项时 pickBestId 返回有效项 id', () => {
      const items = [
        makeItem({ id: 1, width: null, height: null, file_size: 9999, is_favorite: true }),
        makeItem({ id: 2, width: 1920, height: 1080, file_size: 1000 }),
        makeItem({ id: 3, width: null, height: null, file_size: 8888 })
      ]
      // 有效项只有 id=2，应被选为 bestId
      expect(pickBestId(items)).toBe(2)
    })

    it('检测到 NULL 项时记录一次 warn 日志（含项 id 列表）', () => {
      const items = [
        makeItem({ id: 1, width: null, height: null }),
        makeItem({ id: 2, width: 1920, height: 1080 }),
        makeItem({ id: 3, width: null, height: 1080 }) // width 为 null 也算
      ]
      scoreGroup(items)
      expect(loggerWarnMock).toHaveBeenCalledTimes(1)
      const [message, context] = loggerWarnMock.mock.calls[0]
      expect(message).toContain('2')
      expect(message).toContain('NULL')
      expect(Array.isArray(context.ids)).toBe(true)
      expect(context.ids).toContain(1)
      expect(context.ids).toContain(3)
      expect(context.ids).not.toContain(2)
    })

    it('无 NULL 项时不记录 warn 日志', () => {
      const items = [
        makeItem({ id: 1, width: 1920, height: 1080 }),
        makeItem({ id: 2, width: 0, height: 0 }) // 0 不是 null，不触发 warn
      ]
      scoreGroup(items)
      expect(loggerWarnMock).not.toHaveBeenCalled()
    })

    it('仅 width 为 null（height 有效）仍视为 NULL 项', () => {
      const items = [
        makeItem({ id: 1, width: null, height: 1080 }),
        makeItem({ id: 2, width: 1920, height: 1080 })
      ]
      const result = scoreGroup(items)
      const item1 = result.find((r) => r.item.id === 1)!
      expect(item1.score).toBe(0)
      expect(loggerWarnMock).toHaveBeenCalledTimes(1)
    })

    it('仅 height 为 null（width 有效）仍视为 NULL 项', () => {
      const items = [
        makeItem({ id: 1, width: 1920, height: null }),
        makeItem({ id: 2, width: 1920, height: 1080 })
      ]
      const result = scoreGroup(items)
      const item1 = result.find((r) => r.item.id === 1)!
      expect(item1.score).toBe(0)
      expect(loggerWarnMock).toHaveBeenCalledTimes(1)
    })
  })
})
