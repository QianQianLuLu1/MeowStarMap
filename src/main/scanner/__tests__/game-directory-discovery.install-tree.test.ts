/**
 * @layer L1
 * @module src/main/scanner/game-directory-discovery
 * @coverage searchByInstallTreeSignatureShallow（非标准安装树锚点签名搜索）
 * @dependencies vi.mock('tinyglobby') 桩替换 glob，不触发真实盘符 IO
 * @remarks 验证：① 命中 X6Game 且父链含 infinitynikki → 返回父目录（安装树根）；
 *          ② 命中 InfinityNikki Launcher → 返回其上一级（安装树根）；
 *          ③ 命中 X6Game 但父链不含 infinitynikki（其他虚幻游戏误匹配）→ 被上下文校验拦截；
 *          ④ glob 抛错时降级返回空（不崩溃）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('tinyglobby', () => ({
  glob: vi.fn()
}))

import { glob } from 'tinyglobby'
import { searchByInstallTreeSignatureShallow } from '../game-directory-discovery'

const globMock = vi.mocked(glob)

beforeEach(() => {
  globMock.mockReset()
})

describe('searchByInstallTreeSignatureShallow（非标准安装树锚点）', () => {
  it('用例1：命中 X6Game 且父链含 infinitynikki → 返回父目录（安装树根）', async () => {
    // 用户真实路径：InfinityNikki Launcher\InfinityNikki\X6Game\...
    // glob 返回 X6Game 绝对目录，其父目录为 `...\InfinityNikki`（含 infinitynikki），应通过上下文校验。
    globMock.mockResolvedValue(['D:\\Games\\InfinityNikki Launcher\\InfinityNikki\\X6Game'])

    const roots = await searchByInstallTreeSignatureShallow('D:\\', 8)

    expect(roots).toContain('D:\\Games\\InfinityNikki Launcher\\InfinityNikki')
    // 仅返回父目录（安装树根），不再包含 X6Game 自身
    expect(roots).not.toContain('D:\\Games\\InfinityNikki Launcher\\InfinityNikki\\X6Game')
  })

  it('用例2：命中 InfinityNikki Launcher → 返回其上一级安装树根', async () => {
    globMock.mockResolvedValue(['E:\\Software\\InfinityNikki Launcher'])

    const roots = await searchByInstallTreeSignatureShallow('E:\\', 8)

    // 返回 Launcher 目录的父目录，递归即可进入其下 InfinityNikki\X6Game
    expect(roots).toContain('E:\\Software')
  })

  it('用例3：命中 X6Game 但父链不含 infinitynikki → 被上下文校验拦截（防误匹配）', async () => {
    // 其他虚幻引擎游戏（如 War Thunder 使用 X6Game 结构）不应被误判为无限暖暖。
    globMock.mockResolvedValue(['C:\\Games\\WarThunder\\X6Game'])

    const roots = await searchByInstallTreeSignatureShallow('C:\\', 8)

    expect(roots).toEqual([])
  })

  it('用例4：多个锚点命中同一安装树 → 父目录去重', async () => {
    // 同一安装树下同时命中 X6Game 与 InfinityNikki Launcher：
    // - X6Game 的父 = D:\Games\InfinityNikki Launcher\InfinityNikki（安装树根）
    // - InfinityNikki Launcher 的父 = D:\Games（启动器上一级根）
    // 两者均含 infinitynikki，应分别保留且去重（无重复元素）。
    globMock.mockResolvedValue([
      'D:\\Games\\InfinityNikki Launcher\\InfinityNikki\\X6Game',
      'D:\\Games\\InfinityNikki Launcher'
    ])

    const roots = await searchByInstallTreeSignatureShallow('D:\\', 8)

    expect(roots).toContain('D:\\Games\\InfinityNikki Launcher\\InfinityNikki')
    expect(roots).toContain('D:\\Games')
    expect(new Set(roots).size).toBe(roots.length)
  })

  it('用例5：glob 抛错 → 降级返回空（不崩溃）', async () => {
    globMock.mockRejectedValue(new Error('EACCES'))

    const roots = await searchByInstallTreeSignatureShallow('Z:\\', 8)

    expect(roots).toEqual([])
  })
})
