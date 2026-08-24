/**
 * @layer L1
 * @module src/main/ipc/validator
 * @coverage 通用 zod schema 集合（真实 schema 行为，不 mock ../validator）
 *
 * 修复回归点：mediaIdArrayBulk 去掉了 mediaId 数组的 1000 人为上限，
 * 但保留元素级校验（非空 + 正整数）。下游 media-repository 经 sql-chunk 的
 * chunkArray 已按 500 分片，可承载任意长度数组。
 *
 * 说明：media.test.ts 通过 vi.mock('../validator') 将 schemas 替换为链式 proxy、
 * 不执行真实 zod 校验，因此「参数校验」语义只能在本文件（真实 schema）覆盖。
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'

// 仅 stub electron（validator.ts 顶层 import 了 electron），保留 ../validator 真实实现
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getName: () => 'test', getAppPath: () => '/tmp' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { schemas } from './validator'

// handler 实际使用 z.tuple([schema]) 包裹，这里复刻同样的解析路径
const bulkTuple = z.tuple([schemas.mediaIdArrayBulk])
const cappedTuple = z.tuple([schemas.mediaIdArray])

const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

describe('schemas.mediaIdArrayBulk（修复 1000 上限后）', () => {
  it('接受 1500 个合法 id —— 修复前会被 1000 上限拒绝', () => {
    const r = bulkTuple.safeParse([ids(1500)])
    expect(r.success).toBe(true)
    if (r.success) expect((r.data as number[][])[0]).toHaveLength(1500)
  })

  it('接受正好 1000 / 2000 个合法 id', () => {
    expect(bulkTuple.safeParse([ids(1000)]).success).toBe(true)
    expect(bulkTuple.safeParse([ids(2000)]).success).toBe(true)
  })

  it('空数组仍被 .min(1) 拒绝（安全边界不降）', () => {
    const r = bulkTuple.safeParse([[]])
    expect(r.success).toBe(false)
  })

  it('含 0 / 负数 / 小数 / 非数字 仍被 .int().positive() 拒绝', () => {
    expect(bulkTuple.safeParse([[1, 0, -5, 1.5, 'x' as unknown as number]]).success).toBe(false)
  })
})

describe('schemas.mediaIdArray（保留 1000 上限，控制对照）', () => {
  it('合法小数组通过', () => {
    expect(cappedTuple.safeParse([[1, 2, 3]]).success).toBe(true)
  })

  it('超过 1000 仍被 .max(1000) 拒绝（确认仅 bulk 变体放宽）', () => {
    expect(cappedTuple.safeParse([ids(1001)]).success).toBe(false)
    expect(cappedTuple.safeParse([ids(1000)]).success).toBe(true)
  })
})

// ============================================================================
// filePathArrayBulk：去掉 filePathArray 的 1000 人为上限，保留元素级校验
// （非空 + 1-1024 字符）。绝对路径白名单/敏感目录校验在 handler 层
// （assertFileReadPath）完成，不在此文件覆盖。
// ============================================================================
const pathTuple = z.tuple([schemas.filePathArrayBulk])
const cappedPathTuple = z.tuple([schemas.filePathArray])
const absPaths = (n: number) =>
  Array.from({ length: n }, (_, i) => `/mock/dir/file-${String(i).padStart(5, '0')}.jpg`)

describe('schemas.filePathArrayBulk（修复 1000 上限后）', () => {
  it('接受 1500 个合法路径 —— 修复前会被 1000 上限拒绝', () => {
    const r = pathTuple.safeParse([absPaths(1500)])
    expect(r.success).toBe(true)
    if (r.success) expect((r.data as string[][])[0]).toHaveLength(1500)
  })

  it('接受正好 1000 / 2000 / 3000 个合法路径', () => {
    expect(pathTuple.safeParse([absPaths(1000)]).success).toBe(true)
    expect(pathTuple.safeParse([absPaths(2000)]).success).toBe(true)
    expect(pathTuple.safeParse([absPaths(3000)]).success).toBe(true)
  })

  it('空数组仍被 .min(1) 拒绝（安全边界不降）', () => {
    expect(pathTuple.safeParse([[]]).success).toBe(false)
  })

  it('含空串 / 非字符串元素仍被元素级校验拒绝', () => {
    expect(pathTuple.safeParse([['/a.jpg', '', '/b.jpg']]).success).toBe(false)
    expect(pathTuple.safeParse([['/a.jpg', 123 as unknown as string]]).success).toBe(false)
  })

  it('元素超过 1024 字符仍被 .max(MAX_FILE_PATH_LENGTH) 拒绝', () => {
    const long = `/mock/dir/${'x'.repeat(2000)}.jpg`
    expect(pathTuple.safeParse([[long]]).success).toBe(false)
  })
})

describe('schemas.filePathArray（保留 1000 上限，控制对照）', () => {
  it('合法小数组通过', () => {
    expect(cappedPathTuple.safeParse([['/a.jpg', '/b.jpg']]).success).toBe(true)
  })

  it('超过 1000 仍被 .max(1000) 拒绝（确认仅 bulk 变体放宽）', () => {
    expect(cappedPathTuple.safeParse([absPaths(1001)]).success).toBe(false)
    expect(cappedPathTuple.safeParse([absPaths(1000)]).success).toBe(true)
  })
})
