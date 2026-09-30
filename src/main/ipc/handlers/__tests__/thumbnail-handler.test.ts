/**
 * @layer L3
 * @module src/main/ipc/handlers/thumbnail-handler
 * @coverage thumbnail:generate 按需生成结果回写 DB（fix-thumbnail-persist-and-ondemand N2）
 * @dependencies electron
 *
 * 缺陷：按需生成结果只存渲染层组件 state，DB thumbnail 保持 NULL → 该行生成的缓存
 * 文件不在启动孤儿清理白名单（thumbnail IS NOT NULL）内，每次启动被当孤儿删除，
 * 下个会话重新生成，形成"每次启动重复生成"死循环。
 * 修复：generate 成功（standard 档）后仅填补 thumbnail IS NULL 的行，并在实际写入时
 * 失效 media:// 协议白名单缓存（对齐 notifyMediaUpdated 既有模式）。
 * 注：错误分支用例（写库抛错不影响返回）在修复前即为绿——它是新契约的一部分，
 * 红灯由回写行为用例承担（修复前不写库 → 断言失败）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'os'
import path from 'path'
import { registerThumbnailHandlers } from '../thumbnail-handler'
import { makeCtx, getHandler } from '../_test-helpers'

// pathGuard 对用户主目录始终放行（isAllowed 规则 2），测试路径取主目录下避免被拒
const TEST_FILE_PATH = path.join(os.homedir(), 'wxnn-thumb-handler-test', 'a.jpg')

const mockState = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle: mockState.handleMock },
  app: { getPath: vi.fn(() => '') }
}))

/** 内存 DB stub：仅覆盖 MediaRepository 降级同步路径用到的 prepare().run() 形态 */
function makeDbStub(changes: number, throwOnPrepare = false) {
  const runMock = vi.fn(() => ({ changes, lastInsertRowid: 1 }))
  const prepareMock = vi.fn(() => {
    if (throwOnPrepare) throw new Error('db down')
    return { run: runMock }
  })
  return { db: { prepare: prepareMock, exec: vi.fn(), transaction: vi.fn() }, prepareMock, runMock }
}

describe('thumbnail:generate 按需生成结果回写（fix-thumbnail-persist-and-ondemand N2）', () => {
  beforeEach(() => {
    mockState.handleMock.mockClear()
  })

  function setup(generateResult: string | null, changes = 1, throwOnPrepare = false) {
    const { db, prepareMock, runMock } = makeDbStub(changes, throwOnPrepare)
    const generate = vi.fn(async () => generateResult)
    const ctx = makeCtx({
      thumbnailGen: { generate, getCacheDir: vi.fn(() => 'C:\\mock\\cache') },
      db
    })
    registerThumbnailHandlers(ctx)
    const handler = getHandler(mockState.handleMock, 'thumbnail:generate')
    return { ctx, generate, prepareMock, runMock, handler }
  }

  it('正常：generate 成功（standard 档）→ thumbnail IS NULL 行回写 + 失效协议白名单缓存', async () => {
    const filePath = TEST_FILE_PATH
    const { ctx, generate, prepareMock, runMock, handler } = setup('C:\\mock\\cache\\abc.jpg', 1)
    const res = (await handler(undefined, filePath, undefined)) as {
      success: boolean
      data: string | null
    }
    expect(res.success).toBe(true)
    expect(res.data).toBe('C:\\mock\\cache\\abc.jpg')
    expect(generate).toHaveBeenCalledWith(filePath, undefined)
    // 回写 SQL 必须只填补 thumbnail IS NULL 的行（不覆盖扫描/批量写入值）
    expect(prepareMock.mock.calls[0][0]).toContain('UPDATE media_files SET thumbnail = ?')
    expect(prepareMock.mock.calls[0][0]).toContain('thumbnail IS NULL')
    expect(runMock).toHaveBeenCalledWith(['C:\\mock\\cache\\abc.jpg', filePath])
    expect(ctx.invalidateMediaPathCache).toHaveBeenCalledTimes(1)
  })

  it('异常：generate 返回 null → 不写库、不失效缓存，仍正常返回 null', async () => {
    const { ctx, runMock, handler } = setup(null)
    const res = (await handler(undefined, TEST_FILE_PATH, undefined)) as {
      success: boolean
      data: string | null
    }
    expect(res.success).toBe(true)
    expect(res.data).toBeNull()
    expect(runMock).not.toHaveBeenCalled()
    expect(ctx.invalidateMediaPathCache).not.toHaveBeenCalled()
  })

  it('边界：quality=low / high 是派生档位 → 不写库', async () => {
    for (const quality of ['low', 'high'] as const) {
      const { runMock, handler } = setup('C:\\mock\\cache\\abc.jpg')
      await handler(undefined, TEST_FILE_PATH, quality)
      expect(runMock).not.toHaveBeenCalled()
    }
  })

  it('边界：UPDATE 未命中行（changes=0，行已有值或路径不存在）→ 不失效缓存', async () => {
    const { ctx, handler } = setup('C:\\mock\\cache\\abc.jpg', 0)
    await handler(undefined, TEST_FILE_PATH, undefined)
    expect(ctx.invalidateMediaPathCache).not.toHaveBeenCalled()
  })

  it('异常：写库抛错 → 不影响 IPC 正常返回生成路径', async () => {
    const { handler } = setup('C:\\mock\\cache\\abc.jpg', 1, true)
    const res = (await handler(undefined, TEST_FILE_PATH, undefined)) as {
      success: boolean
      data: string | null
    }
    expect(res.success).toBe(true)
    expect(res.data).toBe('C:\\mock\\cache\\abc.jpg')
  })
})
