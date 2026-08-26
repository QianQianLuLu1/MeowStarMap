import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as discovery from '../game-directory-discovery'

// 已删除的全盘签名搜索函数仍保留桩，用于断言"零调用"（与 nikki_albums 一致：不做全盘递归）。
vi.mock('../game-directory-discovery', () => ({
  searchBySignatureShallow: vi.fn(() => Promise.resolve(null)),
  searchByMediaFolderSignatureShallow: vi.fn(() => Promise.resolve([])),
  searchByInstallTreeSignatureShallow: vi.fn(() => Promise.resolve([])),
  findSteamGamePaths: vi.fn(),
  findEpicGamePaths: vi.fn(),
  findGameInstallRootsByPriority: vi.fn(),
  getAvailableDrives: vi.fn(() => Promise.resolve([])),
  getUserDataPaths: vi.fn()
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

function stubDiscovery(opts: { steam?: string[]; epic?: string[]; userData?: string[] }) {
  discovery.findSteamGamePaths.mockResolvedValue(opts.steam ?? [])
  discovery.findEpicGamePaths.mockResolvedValue(opts.epic ?? [])
  discovery.findGameInstallRootsByPriority.mockResolvedValue([
    ...(opts.steam ?? []),
    ...(opts.epic ?? [])
  ])
  discovery.getUserDataPaths.mockResolvedValue(opts.userData ?? [])
}

describe('findMediaDirectories（移除全盘签名搜索后）', () => {
  it('用例1：自定义路径恒包含，且三个签名函数零调用', async () => {
    stubDiscovery({ steam: [], epic: [], userData: [] })
    const result = await findMediaDirectories([customDir])
    expect(result).toContain(customDir)
    expect(discovery.searchByMediaFolderSignatureShallow).not.toHaveBeenCalled()
    expect(discovery.searchBySignatureShallow).not.toHaveBeenCalled()
    expect(discovery.searchByInstallTreeSignatureShallow).not.toHaveBeenCalled()
  })

  it('用例2：注册表/用户数据发现的游戏根目录并入结果', async () => {
    stubDiscovery({ steam: ['C:\\steam\\InfinityNikki'], userData: [] })
    const result = await findMediaDirectories()
    expect(result).toContain('C:\\steam\\InfinityNikki')
  })

  it('用例3：不含 infinitynikki 的自定义路径仍被保留', async () => {
    stubDiscovery({ steam: [], userData: [] })
    const result = await findMediaDirectories([customDir])
    expect(result).toContain(customDir)
  })

  it('用例4：软过滤仅保留含 infinitynikki 的自动目录', async () => {
    stubDiscovery({ steam: ['C:\\steam\\InfinityNikki', 'C:\\steam\\OtherGame'], userData: [] })
    const result = await findMediaDirectories()
    expect(result).toContain('C:\\steam\\InfinityNikki')
    expect(result).not.toContain('C:\\steam\\OtherGame')
  })

  it('用例5：无 infinitynikki 命中时回退保留全部自动目录', async () => {
    stubDiscovery({ steam: ['C:\\steam\\GameA', 'C:\\steam\\GameB'], userData: [] })
    const result = await findMediaDirectories()
    expect(result).toContain('C:\\steam\\GameA')
    expect(result).toContain('C:\\steam\\GameB')
  })
})
