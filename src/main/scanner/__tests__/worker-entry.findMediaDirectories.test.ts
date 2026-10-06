import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as discovery from '../game-directory-discovery'

// 已删除的全盘签名搜索函数仍保留桩，用于断言"零调用"（与 nikki_albums 一致：不做全盘递归）。
// getUserDataPaths 已从 findMediaDirectories 收敛移除（spec 二：不做全盘扫描、不经目录过滤）。
// importOriginal 展开真实模块：normalizeCustomGameRoot 等纯函数保持真实实现（真实 fs，本文件不 mock fs），
// 仅覆写三渠道发现函数，避免把真实注册表/盘符探测带进测试。
vi.mock('../game-directory-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../game-directory-discovery')>()),
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

  it('用例6：自定义路径为 X6Game 目录本身 → 归一化为父目录（2026-10-04 日志回归）', async () => {
    stubDiscovery({ roots: [] })
    const gameRoot = path.join(customDir, 'game')
    const x6Dir = path.join(gameRoot, 'X6Game')
    fs.mkdirSync(x6Dir, { recursive: true })

    const result = await findMediaDirectories([x6Dir])

    // 修复前 x6Dir 被当作游戏根原样返回，下游会拼出 ...\X6Game\X6Game\... 双层错误路径（E002）
    expect(result).toEqual([gameRoot])
  })

  it('用例7：自定义路径为启动器目录 → 归一化为 <p>\\InfinityNikki', async () => {
    stubDiscovery({ roots: [] })
    const launcherDir = path.join(customDir, 'launcher')
    const gameRoot = path.join(launcherDir, 'InfinityNikki')
    fs.mkdirSync(path.join(gameRoot, 'X6Game'), { recursive: true })

    const result = await findMediaDirectories([launcherDir])

    expect(result).toEqual([gameRoot])
  })

  it('用例8：不存在的 X6Game 配置不能被提升为存在的父目录', async () => {
    stubDiscovery({ roots: [] })
    const missingX6Dir = path.join(customDir, 'X6Game')

    const result = await findMediaDirectories([missingX6Dir])

    expect(result).toEqual([])
  })

  it('用例9：自定义根与自动发现根按 Windows 路径大小写去重', async () => {
    stubDiscovery({ roots: [customDir.toUpperCase()] })

    const result = await findMediaDirectories([customDir])

    expect(result).toEqual([customDir])
  })
})
