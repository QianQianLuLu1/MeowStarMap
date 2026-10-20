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
 * isUserPicked 归一化前缀匹配 + 与 roots 联动。
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import { z } from 'zod'

/**
 * CI 复现装置（永久）：把本文件的宿主语义强制成 Linux——宿主 path 绑定 = posix、
 * process.platform = 'linux'。理由：PathGuard 曾读宿主 path，而测试喂的是产品形态的
 * Windows 盘符路径，CI（ubuntu-latest）上 path.posix.isAbsolute('D:\\…') === false，
 * 白名单判定首行短路 → 「expected false to be true」与「路径不在白名单内」两类红灯。
 * 钉死 win32 后判定与宿主无关，因此这份 mock 在 Windows 上是「复现」，在 CI 上是恒等，
 * 两侧跑的是同一套断言（path.posix.win32 === path.win32，故被测代码里的显式 win32 不受影响）。
 * 工厂实现在 tests/mocks/posix-host-path.ts（与 `npm run test:ci-linux` 装置共用一份）；
 * 这里必须用工厂内动态 import——`vi.mock` 会被提升到文件顶部，引用顶层 import 绑定会撞 TDZ。
 */
vi.mock('path', async (importOriginal) => {
  const { posixHost } = await import('../../../tests/mocks/posix-host-path')
  return posixHost(importOriginal as () => Promise<unknown>)
})
vi.mock('node:path', async (importOriginal) => {
  const { posixHost } = await import('../../../tests/mocks/posix-host-path')
  return posixHost(importOriginal as () => Promise<unknown>)
})
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

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

  /**
   * 缺陷：写侧登记的是对话框返回的**原形态**路径，读侧（media:// 与 assertMediaReadPath）
   * 拿的是 realpath 之后的形态。二者不一致时，凡祖先含 junction / 符号链接 / SUBST /
   * 映射盘 / OneDrive 重定向的选中路径都永不相交 → 用户刚挑好的 logo 恒 403（表现为
   * 「换个目录就好了」）。归一必须放在写侧，一次覆盖全部 isUserPicked 消费方。
   */
  it('D3: registerUserPicked 同步登记 realpath 形态（junction / 映射盘不改址即失效）', () => {
    const JUNCTION = 'D:\\Photos\\logo.png'
    const REAL = 'E:\\OneDrive\\Photos\\logo.png'
    const spy = vi.spyOn(fs, 'realpathSync').mockImplementation(() => REAL)
    try {
      pathGuard.registerUserPicked(JUNCTION)
      expect(pathGuard.isUserPicked(REAL)).toBe(true)
      expect(pathGuard.isUserPicked(JUNCTION)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('D4: realpath 抛错时 fail-open —— 仍登记原形态且不向对话框冒泡异常', () => {
    const spy = vi.spyOn(fs, 'realpathSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    })
    try {
      expect(() => pathGuard.registerUserPicked('D:\\Picked\\Album')).not.toThrow()
      expect(pathGuard.isUserPicked('D:\\Picked\\Album')).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  /**
   * 安全边界护栏（修复前后皆绿，防后来者「顺手」把物理拼写也无条件登记）：
   * isUserPicked 在 scanner:start / settings:set / assertMediaAccessPath 处是**跳过黑名单**
   * 的短路，若 junction 的物理目标落在敏感目录，登记它等于给凭据/系统目录开一条直连读路。
   * 代价是「真身在敏感目录里的 logo 仍 403」——这是有意的取舍。
   */
  it('D5: realpath 落到敏感目录时不登记物理拼写（不给黑名单短路一个直连物理路径的拼写）', () => {
    const LOGICAL = 'D:\\Junction\\logo.png'
    const REAL_SENSITIVE = 'C:\\Program Files\\Launcher\\Album\\logo.png'
    const spy = vi.spyOn(fs, 'realpathSync').mockImplementation(() => REAL_SENSITIVE)
    try {
      pathGuard.registerUserPicked(LOGICAL)
      expect(pathGuard.isUserPicked(LOGICAL)).toBe(true)
      expect(pathGuard.isUserPicked(REAL_SENSITIVE)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  /**
   * 目录与文件必须分集合：scanner:start / settings:set 的短路前提是「这是一份被显式
   * 选中的**目录**」。本批把 `dialog:openFile` 的单个文件也纳入 userPicked 后，若继续
   * 用同一个判据，挑中的 logo 就能冒充扫描根（详见 scanner-handler.test.ts B5）。
   */
  it('D6: 文件登记不进目录集合，目录登记两集合并存', () => {
    const PICKED_FILE = 'D:\\Downloads\\D6-logo.png'
    const PICKED_DIR = 'D:\\D6-Album'
    pathGuard.registerUserPicked(PICKED_FILE)
    expect(pathGuard.isUserPicked(PICKED_FILE)).toBe(true)
    expect(pathGuard.isUserPickedDir(PICKED_FILE)).toBe(false)

    pathGuard.registerUserPickedDir(PICKED_DIR)
    expect(pathGuard.isUserPicked(PICKED_DIR)).toBe(true)
    expect(pathGuard.isUserPickedDir(PICKED_DIR)).toBe(true)
    // 目录级前缀语义只在目录集合内成立
    expect(pathGuard.isUserPickedDir(`${PICKED_DIR}\\sub`)).toBe(true)
    expect(pathGuard.isUserPickedDir(PICKED_FILE)).toBe(false)
  })
})
