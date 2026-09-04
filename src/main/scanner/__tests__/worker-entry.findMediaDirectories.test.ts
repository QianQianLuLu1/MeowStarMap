import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as discovery from '../game-directory-discovery'

// 已删除的全盘签名搜索函数仍保留桩，用于断言"零调用"（与 nikki_albums 一致：不做全盘递归）。
// getUserDataPaths 已从 findMediaDirectories 收敛移除（spec 二：不做全盘扫描、不经目录过滤）。
vi.mock('../game-directory-discovery', () => ({
  searchBySignatureShallow: vi.fn(() => Promise.resolve(null)),
  searchByMediaFolderSignatureShallow: vi.fn(() => Promise.resolve([])),
  searchByInstallTreeSignatureShallow: vi.fn(() => Promise.resolve([])),
  findSteamGamePaths: vi.fn(),
  findEpicGamePaths: vi.fn(),
  findGameInstallRootsByPriority: vi.fn()
}))

import { findMediaDirectories } from '../worker-entry'

let customDir: string

beforeEach(() => {
  vi.clearAllMocks()
  customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-fmd-'))
})

afterEach(() => {
  try {
    fs.rmSync(customDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function stubDiscovery(opts: { roots?: string[] }) {
  discovery.findSteamGamePaths.mockResolvedValue([])
  discovery.findEpicGamePaths.mockResolvedValue([])
  discovery.findGameInstallRootsByPriority.mockResolvedValue(opts.roots ?? [])
}

describe('findMediaDirectories（收敛为仅三渠道游戏根目录 + 自定义路径）', () => {
  it('用例1：自定义路径恒包含，且三个签名函数零调用', async () => {
    stubDiscovery({ roots: [] })
    const result = await findMediaDirectories([customDir])
    expect(result).toContain(customDir)
    expect(discovery.searchByMediaFolderSignatureShallow).not.toHaveBeenCalled()
    expect(discovery.searchBySignatureShallow).not.toHaveBeenCalled()
    expect(discovery.searchByInstallTreeSignatureShallow).not.toHaveBeenCalled()
  })

  it('用例2：三渠道游戏根目录（findGameInstallRootsByPriority）并入结果', async () => {
    stubDiscovery({ roots: ['C:\\steam\\InfinityNikki'] })
    const result = await findMediaDirectories()
    expect(result).toContain('C:\\steam\\InfinityNikki')
  })

  it('用例3：不含 infinitynikki 的自定义路径仍被保留', async () => {
    stubDiscovery({ roots: [] })
    const result = await findMediaDirectories([customDir])
    expect(result).toContain(customDir)
  })

  it('用例4：根目录名称不含 infinitynikki 也全部保留（已移除软过滤）', async () => {
    stubDiscovery({ roots: ['C:\\steam\\GameA', 'C:\\steam\\GameB'] })
    const result = await findMediaDirectories()
    expect(result).toContain('C:\\steam\\GameA')
    expect(result).toContain('C:\\steam\\GameB')
  })

  it('用例5：自定义路径与三渠道根目录去重合并', async () => {
    stubDiscovery({ roots: ['C:\\steam\\InfinityNikki'] })
    const result = await findMediaDirectories([customDir])
    expect(result).toContain(customDir)
    expect(result).toContain('C:\\steam\\InfinityNikki')
    expect(result.length).toBe(2)
  })
})
