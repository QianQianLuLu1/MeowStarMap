/**
 * @layer L3
 * @module src/main/ipc/handlers/search-index-handler
 * @coverage search:exportIndex 原子落盘（Bug A 回归）
 * @dependencies electron(app) / fs
 *
 * Bug A：历史实现把临时目录建在 search-index 内部，rm(indexDir) 把刚写好的 .tmp 一并删除，
 * 再 rename 必然 ENOENT。修复后临时目录改为 indexDir 的【兄弟目录 search-index.tmp】。
 * 本测试验证 rename 目标为兄弟目录且索引最终落盘成功。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promises as fsp } from 'fs'
import { registerSearchIndexHandlers } from '../search-index-handler'
import { makeCtx, getHandler } from '../_test-helpers'

const mockState = vi.hoisted(() => ({ handleMock: vi.fn(), userData: '' }))

vi.mock('electron', () => ({
  ipcMain: { handle: mockState.handleMock, on: vi.fn() },
  app: { getPath: vi.fn((name: string) => (name === 'userData' ? mockState.userData : '')) }
}))

describe('search:exportIndex 原子重命名（Bug A 回归）', () => {
  let renameSpy: ReturnType<typeof vi.spyOn>

  beforeAll(async () => {
    mockState.userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'wxnn-sidx-'))
  })

  afterAll(async () => {
    await fsp.rm(mockState.userData, { recursive: true, force: true }).catch(() => {})
  })

  beforeEach(() => {
    mockState.handleMock.mockClear()
    renameSpy = vi.spyOn(fs.promises, 'rename')
    registerSearchIndexHandlers(makeCtx({}))
  })

  it('原子重命名：rename 源为兄弟目录 search-index.tmp，目标为 search-index，且不再抛 ENOENT', async () => {
    const handler = getHandler(mockState.handleMock, 'search:exportIndex')
    const res = (await handler(undefined, {
      segments: [{ key: 'seg1', data: 'hello-index' }],
      schemaHash: 'h1'
    })) as { success: boolean; data: { saved: boolean; path: string } }

    expect(res.success).toBe(true)
    expect(res.data).toEqual({ saved: true, path: path.join(mockState.userData, 'search-index') })
    // rename 源必须是兄弟目录 search-index.tmp（不再位于 indexDir 内部，故不会被 rm(indexDir) 误删）
    expect(renameSpy).toHaveBeenCalledWith(
      path.join(mockState.userData, 'search-index.tmp'),
      path.join(mockState.userData, 'search-index')
    )
    // 索引目录应落盘（含片段与元数据），且不存在残留 .tmp 目录
    const indexDir = path.join(mockState.userData, 'search-index')
    const files = await fsp.readdir(indexDir)
    expect(files).toContain('seg1')
    expect(files).toContain('.meta.json')
    await expect(fsp.access(path.join(mockState.userData, 'search-index.tmp'))).rejects.toThrow()
  })
})
