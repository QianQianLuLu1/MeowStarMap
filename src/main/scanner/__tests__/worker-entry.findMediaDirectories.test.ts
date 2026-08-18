/**
 * @layer L1
 * @module src/main/scanner/worker-entry
 * @coverage findMediaDirectories 自定义路径/自动发现双集合拆分（修复主因：抑制发现 + 软过滤丢弃）
 * @dependencies 通过 vi.mock('../game-directory-discovery') 桩替换 6 个发现函数，不触发真实盘符/注册表 IO
 * @remarks 验证：① 正确/错误自定义路径不抑制全盘搜索；② 自定义路径恒包含；
 *          ③ 不含 infinitynikki 的自定义路径不被软过滤丢弃；④ 含 infinitynikki 自动目录时自定义路径仍保留；
 *          ⑤ 无自定义路径时与原软过滤行为一致（向后兼容）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
// 桩替换发现模块：findMediaDirectories（来自 worker-entry，真实）内部通过 import 绑定调用这些函数，
// vi.mock 可可靠拦截（ESM 命名空间只读，无法直接 vi.spyOn 拦截内部调用）。
import * as discovery from '../game-directory-discovery'

vi.mock('../game-directory-discovery', () => ({
  searchBySignatureShallow: vi.fn(),
  searchByMediaFolderSignatureShallow: vi.fn(),
  findSteamGamePaths: vi.fn(),
  findEpicGamePaths: vi.fn(),
  getAvailableDrives: vi.fn(),
  getUserDataPaths: vi.fn()
}))

import { findMediaDirectories } from '../worker-entry'

// 真实存在的临时目录，用作"用户配置的自定义路径"（不含 infinitynikki 关键字）。
// findMediaDirectories 用 fs.promises.access 校验存在性，因此必须创建真实目录。
let customDir: string

beforeEach(() => {
  vi.clearAllMocks()
  customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-fmd-'))
})

afterEach(() => {
  try {
    fs.rmSync(customDir, { recursive: true, force: true })
  } catch {
    // 清理失败忽略
  }
})

// 桩：让自动发现（Steam/Epic/用户数据/全盘签名）返回固定值，避免真实 IO。
function stubDiscovery(opts: {
  steam?: string[]
  epic?: string[]
  userData?: string[]
  drives?: string[]
  mediaFolder?: string[]
  signature?: string | null
}) {
  discovery.findSteamGamePaths.mockResolvedValue(opts.steam ?? [])
  discovery.findEpicGamePaths.mockResolvedValue(opts.epic ?? [])
  discovery.getUserDataPaths.mockResolvedValue(opts.userData ?? [])
  discovery.getAvailableDrives.mockResolvedValue(opts.drives ?? [])
  discovery.searchByMediaFolderSignatureShallow.mockResolvedValue(opts.mediaFolder ?? [])
  discovery.searchBySignatureShallow.mockResolvedValue(opts.signature ?? null)
}

describe('findMediaDirectories（主因修复）', () => {
  it('用例1：存在但错误的自定义路径不抑制全盘签名搜索', async () => {
    // 自定义路径真实存在（但里面没有暖暖媒体），旧实现会让 found.size>0 跳过全盘搜索。
    // 新实现：customSet 与 autoSet 分离，autoSet 为空时仍执行全盘签名搜索。
    stubDiscovery({
      steam: [],
      epic: [],
      userData: [],
      drives: ['X:\\'],
      mediaFolder: ['X:\\auto\\media']
    })

    const result = await findMediaDirectories([customDir])

    // 全盘签名搜索确实执行（mediaFolder 桩被调用）
    expect(discovery.searchByMediaFolderSignatureShallow).toHaveBeenCalled()
    // 自定义路径 + 全盘搜索发现的目录都应出现
    expect(result).toContain(customDir)
    expect(result).toContain('X:\\auto\\media')
  })

  it('用例2：正确的自定义路径恒包含于结果', async () => {
    stubDiscovery({
      steam: ['C:\\steam\\InfinityNikki'],
      epic: [],
      userData: [],
      drives: [],
      mediaFolder: []
    })

    const result = await findMediaDirectories([customDir])

    expect(result).toContain(customDir)
    expect(result).toContain('C:\\steam\\InfinityNikki')
  })

  it('用例3：不含 infinitynikki 的自定义路径不被软过滤丢弃', async () => {
    // 自动发现一个不含 infinitynikki 的目录；软过滤回退时不应误删自定义路径。
    stubDiscovery({
      steam: [],
      epic: [],
      userData: [],
      drives: ['X:\\'],
      mediaFolder: ['X:\\OtherGame\\media']
    })

    const result = await findMediaDirectories([customDir])

    expect(result).toContain(customDir)
    expect(result).toContain('X:\\OtherGame\\media')
  })

  it('用例4：含 infinitynikki 的自动目录存在时，自定义路径仍被保留', async () => {
    // 旧实现：末尾对整个 found 做 infinitynikki 软过滤，会把不含该关键字的自定义路径整体挤出。
    stubDiscovery({
      steam: ['C:\\steam\\InfinityNikki'],
      epic: [],
      userData: [],
      drives: [],
      mediaFolder: []
    })

    const result = await findMediaDirectories([customDir])

    // 软过滤只作用于自动发现集合，自定义路径应保留
    expect(result).toContain(customDir)
    expect(result).toContain('C:\\steam\\InfinityNikki')
  })

  it('用例5：无自定义路径时与原软过滤行为一致（向后兼容）', async () => {
    // 同时存在含/不含 infinitynikki 的自动目录：软过滤只保留含 infinitynikki 的。
    stubDiscovery({
      steam: ['C:\\steam\\InfinityNikki', 'C:\\steam\\OtherGame'],
      epic: [],
      userData: [],
      drives: [],
      mediaFolder: []
    })

    const result = await findMediaDirectories()

    // 含 infinitynikki 的自动目录保留；不含的被软过滤剔除
    expect(result).toContain('C:\\steam\\InfinityNikki')
    expect(result).not.toContain('C:\\steam\\OtherGame')
    // 结果去重且无 undefined
    expect(new Set(result).size).toBe(result.length)
  })

  it('用例5-补充：无 infinitynikki 命中时回退保留全部自动目录', async () => {
    // 所有自动目录均不含 infinitynikki → 软过滤回退，保留全部签名命中目录（与原逻辑一致）
    stubDiscovery({
      steam: ['C:\\steam\\GameA', 'C:\\steam\\GameB'],
      epic: [],
      userData: [],
      drives: [],
      mediaFolder: []
    })

    const result = await findMediaDirectories()

    // 无 infinitynikki 命中 → 回退保留全部签名命中目录（与原逻辑一致）
    expect(result).toContain('C:\\steam\\GameA')
    expect(result).toContain('C:\\steam\\GameB')
  })
})
