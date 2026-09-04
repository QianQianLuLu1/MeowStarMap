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
 *
 * 另覆盖 PathGuard 的 userPicked（用户显式选择即授权）语义：registrUserPicked 登记 +
 * isUserPicked 归一化前缀匹配 + 与 roots 联动（见 docs/plans/fix-specified-dir-whitelist.md）。
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'

// 仅 stub electron（validator.ts 顶层 import 了 electron），保留 ../validator 真实实现
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getName: () => 'test', getAppPath: () => '/tmp' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { schemas, pathGuard } from './validator'

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

// ============================================================================
// PathGuard userPicked（用户显式选择即授权）
// 修复「指定目录」扫描误报「路径不在白名单内，禁止读取操作」：对话框显式选中的
// 目录不受敏感目录黑名单误拦；归一化与前缀语义与 roots 判定一致。
// ============================================================================

describe('PathGuard userPicked（用户显式选择即授权）', () => {
  // Windows 风格系统目录：本修复的目标场景（用户经对话框显式选择）
  const SYS_PICKED = 'D:\\Program Files\\Game\\Album'

  it('D1: registerUserPicked 后自身/子路径/大小写变体均命中，且联动 register（非敏感路径 isAllowed 通过）', () => {
    pathGuard.registerUserPicked(SYS_PICKED)
    expect(pathGuard.isUserPicked(SYS_PICKED)).toBe(true)
    expect(pathGuard.isUserPicked('d:\\program files\\game\\album\\sub\\photo.jpg')).toBe(true)
    expect(pathGuard.isUserPicked('D:\\PROGRAM FILES\\GAME\\ALBUM')).toBe(true)
    // registerUserPicked 与 register 等价登记 roots：普通目录 isAllowed 放行
    pathGuard.registerUserPicked('D:\\Games\\Album2')
    expect(pathGuard.isAllowed('D:\\Games\\Album2')).toBe(true)
  })

  it('D2: 未登记路径 / 前缀边界 / 非绝对路径 / 空串不命中', () => {
    expect(pathGuard.isUserPicked('E:\\Other\\Album')).toBe(false)
    // 目录名边界必须为分隔符：'Program Filesabc' 不得命中 'Program Files' 形态的登记根
    expect(pathGuard.isUserPicked('D:\\Program Filesabc\\Game\\Album')).toBe(false)
    expect(pathGuard.isUserPicked('relative\\path')).toBe(false)
    expect(pathGuard.isUserPicked('')).toBe(false)
  })
})
