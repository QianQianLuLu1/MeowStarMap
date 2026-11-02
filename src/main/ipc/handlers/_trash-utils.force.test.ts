/**
 * @layer L2
 * @module src/main/ipc/handlers/_trash-utils
 * @coverage trashBatch / trashItemWithFallback 的 force（跳过系统回收站，直接彻底删除）语义
 *
 * 背景（#fix-empty-recyclebin-failed-as-success）：真机取证证明 H 盘卷级不接受
 * shell.trashItem（同形态文件在 C 盘可移入、空格与中文都不是变量），trashBatch 因此
 * 逐项判 failed 并按 B1 规则保留 DB 记录——「什么都没删」是正确行为，但用户在显式
 * 同意后可以跳过系统回收站直接 unlink。本文件钉住这条新能力的安全边界。
 *
 * 用例分三类，必须分清（否则会被误读成「修复前就有红」或「测试没覆盖 bug」）：
 * - 【缺陷复现】force 系列：修复前必然为红（trashBatch 忽略第二参数、无 forceDeletedCount）。
 * - 【设计锁】非 force 系列：修复前即为绿，作用是防止新能力污染默认路径——
 *   即 7d4459f 的「绝不自动 fallback 永久删除」不变式。
 * - 【聚合日志】force 携带原始错误那条修复前为红（F1：force 分支把 err 吞在原语里）；
 *   同批的非 force 对照锁修复前即绿，用来证明前一条不是空夹具。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { shellTrashItemMock, pathExistsMock, unlinkMock, loggerWarnMock } = vi.hoisted(() => ({
  shellTrashItemMock: vi.fn(),
  pathExistsMock: vi.fn(),
  unlinkMock: vi.fn(),
  loggerWarnMock: vi.fn()
}))

vi.mock('electron', () => ({
  shell: { trashItem: shellTrashItemMock },
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))
vi.mock('../../utils/file-utils', () => ({ pathExists: pathExistsMock }))
// 仅替换 unlink，其余 fs/promises 保持真实实现（与 _trash-utils.test.ts 同一口径）
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const mocked = { ...actual, unlink: unlinkMock }
  return { ...mocked, default: mocked }
})
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: loggerWarnMock, error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

import { trashBatch, trashItemWithFallback } from './_trash-utils'

const H_PHOTO = 'H:\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\ScreenShot\\p.jpeg'
const H_PHOTO2 = 'H:\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\ScreenShot\\q.jpeg'

const enoent = (): NodeJS.ErrnoException => {
  const e = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
  e.code = 'ENOENT'
  return e
}
const eperm = (): NodeJS.ErrnoException => {
  const e = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException
  e.code = 'EPERM'
  return e
}
/** shell.trashItem 在真机的真实报错形态（见 main.log 2026-11-01 17:25） */
const shellDeleteFailure = (): Error => new Error('Failed to perform delete operation')

beforeEach(() => {
  vi.clearAllMocks()
  shellTrashItemMock.mockResolvedValue(undefined)
  unlinkMock.mockResolvedValue(undefined)
  pathExistsMock.mockResolvedValue(true)
})

describe('trashItemWithFallback — 非 force 路径（设计锁：绝不自动永久删除）', () => {
  it('【设计锁】trashItem 成功 ⇒ ok', async () => {
    const r = await trashItemWithFallback(H_PHOTO)
    expect(r.result).toBe('ok')
    expect(shellTrashItemMock).toHaveBeenCalledWith(H_PHOTO)
    expect(unlinkMock).not.toHaveBeenCalled()
  })

  it('【设计锁】trashItem 抛错且文件已消失 ⇒ missing（可安全删 DB）', async () => {
    shellTrashItemMock.mockRejectedValue(shellDeleteFailure())
    pathExistsMock.mockResolvedValue(false)
    const r = await trashItemWithFallback(H_PHOTO)
    expect(r.result).toBe('missing')
  })

  it('【设计锁】trashItem 持续抛错且文件仍在 ⇒ failed，且绝不 fallback 调 unlink', async () => {
    shellTrashItemMock.mockRejectedValue(shellDeleteFailure())
    pathExistsMock.mockResolvedValue(true)
    const r = await trashItemWithFallback(H_PHOTO)
    expect(r.result).toBe('failed')
    expect(r.error).toBeInstanceOf(Error)
    expect(unlinkMock).not.toHaveBeenCalled()
  })
})

describe('trashBatch — force（跳过系统回收站直接彻底删除）', () => {
  it('【缺陷复现/新能力】force=true ⇒ 走 unlink，且完全不调用 shell.trashItem', async () => {
    const out = await trashBatch([{ id: 1, file_path: H_PHOTO }], { force: true })
    expect(shellTrashItemMock).not.toHaveBeenCalled()
    expect(unlinkMock).toHaveBeenCalledWith(H_PHOTO)
    expect(out.idsToDelete).toEqual([1])
  })

  it('【缺陷复现/新能力】force 成功计入 forceDeletedCount，且不污染 movedCount（其语义固定为「移入系统回收站数」）', async () => {
    const out = await trashBatch(
      [
        { id: 1, file_path: H_PHOTO },
        { id: 2, file_path: H_PHOTO2 }
      ],
      { force: true }
    )
    expect(out.forceDeletedCount).toBe(2)
    expect(out.movedCount).toBe(0)
    expect(out.failedPaths).toEqual([])
  })

  it('【缺陷复现/新能力】force 下 ENOENT ⇒ 判 missing（进 idsToDelete，不计 forceDeletedCount）', async () => {
    unlinkMock.mockRejectedValue(enoent())
    const out = await trashBatch([{ id: 7, file_path: H_PHOTO }], { force: true })
    expect(out.missingCount).toBe(1)
    expect(out.forceDeletedCount).toBe(0)
    expect(out.idsToDelete).toEqual([7])
    expect(out.failedPaths).toEqual([])
  })

  it('【缺陷复现/新能力】force 下 unlink 失败且文件仍在 ⇒ failed 且保留 DB 记录（B1 在 force 下同样成立）', async () => {
    unlinkMock.mockRejectedValue(eperm())
    pathExistsMock.mockResolvedValue(true)
    const out = await trashBatch([{ id: 3, file_path: H_PHOTO }], { force: true })
    expect(out.failedPaths).toEqual([H_PHOTO])
    expect(out.idsToDelete).toEqual([])
    expect(out.forceDeletedCount).toBe(0)
  })

  it('【缺陷复现/新能力】force 单次尝试不重试（失败只 unlink 一次，避免已知坏调用拖成耗时）', async () => {
    unlinkMock.mockRejectedValue(eperm())
    pathExistsMock.mockResolvedValue(true)
    await trashBatch([{ id: 4, file_path: H_PHOTO }], { force: true })
    expect(unlinkMock).toHaveBeenCalledTimes(1)
  })

  it('【缺陷复现/新能力】未传 force ⇒ forceDeletedCount 恒为 0（向后兼容，老调用方不受影响）', async () => {
    const out = await trashBatch([{ id: 5, file_path: H_PHOTO }])
    expect(out.forceDeletedCount).toBe(0)
    expect(out.movedCount).toBe(1)
    expect(unlinkMock).not.toHaveBeenCalled()
  })

  it('【缺陷复现/新能力】force 混合三态 ⇒ 计数互不重叠', async () => {
    unlinkMock.mockImplementation(async (p: string) => {
      if (p === H_PHOTO2) throw enoent()
      return undefined
    })
    const out = await trashBatch(
      [
        { id: 10, file_path: H_PHOTO },
        { id: 11, file_path: H_PHOTO2 }
      ],
      { force: true }
    )
    expect(out.forceDeletedCount).toBe(1)
    expect(out.missingCount).toBe(1)
    expect(out.idsToDelete).toEqual([10, 11])
    expect(out.movedCount).toBe(0)
  })
})

/**
 * 聚合日志的诊断力（#fix-empty-recyclebin-failed-as-success 审查轮 F1）：
 * `trashBatch` 的约定是「循环后聚合一条：总数 + 样例路径 + **首个错误**」（见 _trash-utils.ts
 * 头注释 FIX(A-log)），force 模式换用 `recycleBinRemoveFailed` 的理由（"同一条日志谎称移入
 * 回收站失败会把用户引向错误的排查方向"）也只有在这条错误真的被带上时才站得住。
 * 修复前 force 分支写的是 `{ result: …, error: undefined as unknown }`，`firstError` 永不赋值
 * ⇒ 用户「直接彻底删除」失败时日志只剩"彻底删除失败 N/M 项"，EPERM / EBUSY / 只读卷无从分辨。
 */
describe('trashBatch — 聚合日志必须携带首个原始错误', () => {
  it('【缺陷复现】force 下 unlink EPERM ⇒ logger.warn 第二个参数携带原始错误', async () => {
    unlinkMock.mockRejectedValue(eperm())
    pathExistsMock.mockResolvedValue(true)

    await trashBatch([{ id: 21, file_path: H_PHOTO }], { force: true })

    expect(loggerWarnMock).toHaveBeenCalledTimes(1)
    const [message, error] = loggerWarnMock.mock.calls[0]
    expect(String(message)).toContain('彻底删除失败')
    // 判据落在错误对象本身上，而不是"文案里恰好提到 EPERM"——unlink 的原始 err 必须原样上送
    expect(error).toBeInstanceOf(Error)
    expect((error as NodeJS.ErrnoException).code).toBe('EPERM')
  })

  it('【对照锁】非 force 下 trashItem 失败 ⇒ 同样携带原始错误（证明上一条的夹具不是空转）', async () => {
    shellTrashItemMock.mockRejectedValue(shellDeleteFailure())
    pathExistsMock.mockResolvedValue(true)

    await trashBatch([{ id: 22, file_path: H_PHOTO }])

    expect(loggerWarnMock).toHaveBeenCalledTimes(1)
    const [message, error] = loggerWarnMock.mock.calls[0]
    expect(String(message)).toContain('移入系统回收站失败')
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Failed to perform delete operation')
  })
})
