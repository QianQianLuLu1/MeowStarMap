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
  searchByInstallTreeSignatureShallow: vi.fn(),
  findSteamGamePaths: vi.fn(),
  findEpicGamePaths: vi.fn(),
  findGameInstallRootsByPriority: vi.fn(),
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
  installTree?: string[]
}) {
  discovery.findSteamGamePaths.mockResolvedValue(opts.steam ?? [])
  discovery.findEpicGamePaths.mockResolvedValue(opts.epic ?? [])
  // findMediaDirectories 现通过渠道优先级解析器统一获取游戏根目录（启动器 > Steam > Epic）；
  // 集成测试中以 steam+epic 解析结果等价替代（启动器渠道在此 mock 中置空）。
  discovery.findGameInstallRootsByPriority.mockResolvedValue([
    ...(opts.steam ?? []),
    ...(opts.epic ?? [])
  ])
  discovery.getUserDataPaths.mockResolvedValue(opts.userData ?? [])
  discovery.getAvailableDrives.mockResolvedValue(opts.drives ?? [])
  discovery.searchByMediaFolderSignatureShallow.mockResolvedValue(opts.mediaFolder ?? [])
  discovery.searchBySignatureShallow.mockResolvedValue(opts.signature ?? null)
  discovery.searchByInstallTreeSignatureShallow.mockResolvedValue(opts.installTree ?? [])
}

// 共享桩路径：launcher 缓存目录（含 infinitynikki 关键字）与标准安装路径的游戏媒体目录。
const LAUNCHER_CACHE_DIR = 'C:\\Users\\x\\AppData\\Local\\InfinityNikki Launcher\\cache\\images'
const GAME_MEDIA_DIR = 'X:\\games\\InfinityNikki\\Saved\\GamePlayPhotos'

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

describe('findMediaDirectories（T1：全盘扫描强制签名搜索）', () => {
  it('U-A：forceSignatureSearch 时 launcher 缓存命中不早退，仍执行全盘签名搜索并合并结果', async () => {
    // 背景：打包版首装全盘扫描时，快速路径早退把“启动器缓存目录命中”当作“游戏目录已找到”，
    // 跳过全盘签名搜索——游戏装在非 Steam/Epic 标准路径的机器永远发现不了截图目录。
    stubDiscovery({
      steam: [],
      epic: [],
      userData: [LAUNCHER_CACHE_DIR],
      drives: ['X:\\'],
      mediaFolder: [GAME_MEDIA_DIR]
    })

    const result = await findMediaDirectories(undefined, { forceSignatureSearch: true })

    // 全盘签名搜索确实执行（修复前因早退而失败 ← RED 断言）
    expect(discovery.searchByMediaFolderSignatureShallow).toHaveBeenCalled()
    // 快速路径命中的 launcher 缓存目录与签名搜索命中的游戏目录都保留
    expect(result).toContain(LAUNCHER_CACHE_DIR)
    expect(result).toContain(GAME_MEDIA_DIR)
  })

  it('U-B：不传 opts 时保持快速早退不变（回归保护）', async () => {
    // 同样桩配置但不传 opts：launcher 缓存命中仍应早退，不触发全盘签名搜索。
    stubDiscovery({
      steam: [],
      epic: [],
      userData: [LAUNCHER_CACHE_DIR],
      drives: ['X:\\'],
      mediaFolder: [GAME_MEDIA_DIR]
    })

    const result = await findMediaDirectories()

    // 快速早退保持：签名搜索不应被调用
    expect(discovery.searchByMediaFolderSignatureShallow).not.toHaveBeenCalled()
    // 结果仅含快速路径命中的 userData 目录
    expect(result).toEqual([LAUNCHER_CACHE_DIR])
  })
})

describe('findMediaDirectories（批次A R1+R2：按来源分组修复）', () => {
  // U-I 场景：launcher 缓存命中（含 infinitynikki）+ 游戏装在不含 infinitynikki 的中文路径。
  // 修复前：签名搜索命中的中文目录与 launcher 缓存合并进同一 autoSet 后，软过滤发现
  // infinityNikkiDirs 非空 → filteredAuto 只保留 launcher 缓存 → 中文游戏目录被剔除。
  it('U-I：force 时签名搜索命中的非 infinitynikki 目录不被 launcher 缓存软过滤剔除', async () => {
    const CHINESE_GAME_MEDIA_DIR = 'X:\\游戏\\暖暖\\Saved\\GamePlayPhotos'
    stubDiscovery({
      steam: [],
      epic: [],
      userData: [LAUNCHER_CACHE_DIR],
      drives: ['X:\\'],
      mediaFolder: [CHINESE_GAME_MEDIA_DIR]
    })

    const result = await findMediaDirectories(undefined, { forceSignatureSearch: true })

    // 签名搜索确实执行（force 语义）
    expect(discovery.searchByMediaFolderSignatureShallow).toHaveBeenCalled()
    // 修复前：签名命中目录被软过滤剔除（仅剩 launcher 缓存）← RED 断言
    expect(result).toContain(CHINESE_GAME_MEDIA_DIR)
    expect(result).toContain(LAUNCHER_CACHE_DIR)
  })

  // U-J 场景：Steam/Epic 注册表已高置信命中游戏安装目录，force 不应再强制全盘 depth-6 搜索。
  it('U-J：force 时 Steam/Epic 注册表高置信命中仍早退，不执行全盘签名搜索', async () => {
    const STEAM_GAME_DIR = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\InfinityNikki'
    stubDiscovery({
      steam: [STEAM_GAME_DIR],
      epic: [],
      userData: [],
      drives: ['X:\\'],
      mediaFolder: ['X:\\other\\media']
    })

    const result = await findMediaDirectories(undefined, { forceSignatureSearch: true })

    // 修复前：force 无条件执行全盘搜索 ← RED 断言
    expect(discovery.searchByMediaFolderSignatureShallow).not.toHaveBeenCalled()
    // 注册表命中的 Steam 目录保留于结果
    expect(result).toContain(STEAM_GAME_DIR)
  })
})

describe('findMediaDirectories（非标准安装树：InfinityNikki Launcher\\InfinityNikki\\X6Game）', () => {
  // 核心回归场景：用户游戏装在官网/WeGame 启动器路径
  // `InfinityNikki Launcher\InfinityNikki\X6Game\...`，该路径既非 Steam/Epic 标准路径
  // （注册表命中不了），又可能缺失 exe 签名（游戏以 X6Game 形态存在），且媒体目录层级深
  // （X6Game\Saved\GamePlayPhotos\$uid$）。媒体文件夹签名常因 depth 边界漏扫，
  // 必须依赖新增的 installTree 锚点签名兜底发现安装树根。
  const NONSTANDARD_X6GAME_ROOT = 'D:\\Games\\InfinityNikki Launcher\\InfinityNikki'

  it('U-K：快速路径为空时，installTree 锚点签名发现的安装树根并入结果', async () => {
    // 快速路径全空（非 Steam/Epic/用户数据命中）→ 进入全盘签名搜索分支；
    // 媒体签名/ exe 签名均空（X6Game 形态无 exe，媒体又被 depth 漏掉），
    // 仅靠 installTree 锚点命中 X6Game → 返回父目录（安装树根）并入结果。
    stubDiscovery({
      steam: [],
      epic: [],
      userData: [],
      drives: ['D:\\'],
      mediaFolder: [],
      signature: null,
      installTree: [NONSTANDARD_X6GAME_ROOT]
    })

    const result = await findMediaDirectories()

    // 锚点签名搜索确实执行（独立于 mediaFolder/exe 命中结果）
    expect(discovery.searchByInstallTreeSignatureShallow).toHaveBeenCalled()
    // 安装树根被正确并入结果，使 scanDirectory 从其递归即可覆盖 X6Game\ScreenShot 等全部媒体
    expect(result).toContain(NONSTANDARD_X6GAME_ROOT)
  })

  it('U-L：installTree 锚点签名与 mediaFolder 签名可互补（两者都命中时全部并入）', async () => {
    // 媒体签名命中深层目录 + 锚点命中安装树根（去重后均保留），最大化覆盖。
    stubDiscovery({
      steam: [],
      epic: [],
      userData: [],
      drives: ['D:\\'],
      mediaFolder: ['D:\\Games\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\ScreenShot'],
      signature: null,
      installTree: [NONSTANDARD_X6GAME_ROOT]
    })

    const result = await findMediaDirectories()

    expect(discovery.searchByInstallTreeSignatureShallow).toHaveBeenCalled()
    expect(result).toContain('D:\\Games\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\ScreenShot')
    expect(result).toContain(NONSTANDARD_X6GAME_ROOT)
  })

  it('U-M：installTree 未发现时不影响既有签名搜索结果（回归保护）', async () => {
    // 进入全盘签名搜索分支（快速路径为空）：mediaFolder 命中，installTree 无命中，结果仍正确。
    stubDiscovery({
      steam: [],
      epic: [],
      userData: [],
      drives: ['X:\\'],
      mediaFolder: ['X:\\games\\InfinityNikki\\Saved\\GamePlayPhotos']
    })

    const result = await findMediaDirectories()

    // 锚点搜索被调用但无命中，不应污染结果
    expect(discovery.searchByInstallTreeSignatureShallow).toHaveBeenCalled()
    expect(result).toContain('X:\\games\\InfinityNikki\\Saved\\GamePlayPhotos')
  })
})
