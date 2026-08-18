import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import { execFile } from 'child_process'
import { clipboard } from 'electron'

/**
 * 集成测试：剪贴板分享服务端到端链路
 *
 * 范围：覆盖「选中文件 → 校验 → 过滤 → 构造 CF_HDROP → 写入剪贴板」完整链路，
 *      以及「应用状态检测 → 缓存 → TTL 失效」生命周期。
 *
 * 与现有 share-clipboard-service.test.ts（characterization 单元测试）的区别：
 *   - 单元测试聚焦单个函数的输入输出
 *   - 集成测试聚焦多步骤端到端流程与跨函数协作
 *
 * 模块级状态隔离：share-clipboard-service 内部的 installPathCache 是模块级变量，
 *   跨测试会遗留缓存导致隔离问题。采用 vi.resetModules() + 动态 import，
 *   每个测试拿到新鲜的模块实例。
 *
 * 边界场景：
 *   1. 并发调用 copyFilesToClipboard（用户连点"分享"按钮）
 *   2. installPathCache TTL 失效（5 分钟后重新检测）
 *   3. 非 win32 平台不支持 CF_HDROP（macOS/Linux 兜底）
 */

// ============================================================
// Mock 声明（hoisted）
// ============================================================

vi.mock('electron', () => ({
  clipboard: { writeBuffer: vi.fn() },
  app: {
    getPath: vi.fn(() => '/tmp/test-userdata'),
    getVersion: vi.fn(() => '2.5.0')
  }
}))

vi.mock('fs', () => ({
  default: {
    statSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(),
    promises: {
      stat: vi.fn(),
      access: vi.fn(),
      appendFile: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
      unlink: vi.fn().mockResolvedValue(undefined)
    }
  }
}))

vi.mock('child_process', () => ({
  execFile: vi.fn()
}))

// ============================================================
// 动态 import：配合 vi.resetModules 实现模块级状态隔离
// ============================================================
type ShareService = typeof import('./share-clipboard-service')
let shareService: ShareService

const originalPlatform = process.platform

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  vi.mocked(clipboard.writeBuffer).mockImplementation(() => {})
  vi.mocked(fs.promises.appendFile).mockResolvedValue(undefined as never)
  shareService = await import('./share-clipboard-service')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  vi.useRealTimers()
})

// ============================================================
// Helpers
// ============================================================

function mockStats(isFile: boolean, isDirectory = false) {
  return { isFile: () => isFile, isDirectory: () => isDirectory }
}

/** 模拟所有 reg/tasklist/wmic/powershell 调用失败（即「未安装」） */
function mockAllExternalCommandsFail(): void {
  vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
    const callback = (typeof _opts === 'function' ? _opts : cb) as (
      err: Error | null,
      stdout?: string
    ) => void
    callback(new Error('not found'), '')
    return undefined as never
  })
}

// ============================================================
// 集成测试用例
// ============================================================

describe('集成：剪贴板分享端到端链路', () => {
  describe('正常流程：选中文件 → 校验 → 写入剪贴板', () => {
    it('3 个文件（2 存在 + 1 不存在）→ 成功复制 2 个，跳过 1 个，HDROP 缓冲区结构正确', async () => {
      vi.mocked(fs.promises.stat)
        .mockResolvedValueOnce(mockStats(true) as never)
        .mockResolvedValueOnce(mockStats(true) as never)
        .mockRejectedValueOnce(new Error('ENOENT') as never)

      const result = await shareService.copyFilesToClipboard([
        'C:\\photos\\a.jpg',
        'C:\\photos\\b.mp4',
        'C:\\photos\\missing.jpg'
      ])

      expect(result).toEqual({
        success: true,
        count: 2,
        skipped: 1,
        message: expect.stringContaining('已复制 2 个文件')
      })

      expect(clipboard.writeBuffer).toHaveBeenCalledTimes(1)
      expect(clipboard.writeBuffer).toHaveBeenCalledWith('CF_HDROP', expect.any(Buffer))

      // 验证 HDROP 缓冲区结构：DROPFILES 头 20 字节 + UTF-16LE 路径
      const buf = vi.mocked(clipboard.writeBuffer).mock.calls[0][1] as Buffer
      expect(buf.length).toBeGreaterThanOrEqual(20)
      expect(buf.readUInt32LE(0)).toBe(20) // pFiles 偏移
      expect(buf.readUInt32LE(16)).toBe(1) // fWide = 1（UTF-16）
      const pathsSection = buf.subarray(20).toString('utf16le')
      expect(pathsSection).toContain('a.jpg')
      expect(pathsSection).toContain('b.mp4')
      expect(pathsSection).not.toContain('missing.jpg')
    })

    it('完整链路：filterValidPaths 与 copyFilesToClipboard 行为一致', async () => {
      vi.mocked(fs.promises.stat).mockResolvedValue(mockStats(true) as never)

      const paths = ['C:\\x.jpg', 'C:\\y.jpg']
      const filterResult = await shareService.filterValidPaths(paths)
      const copyResult = await shareService.copyFilesToClipboard(paths)

      expect(filterResult.valid).toEqual(paths)
      expect(filterResult.skipped).toBe(0)
      expect(copyResult.count).toBe(filterResult.valid.length)
      expect(copyResult.skipped).toBe(filterResult.skipped)
    })
  })

  // ============================================================
  // 边界 1：并发调用（用户连点"分享"按钮）
  // ============================================================
  describe('边界 1：并发调用 copyFilesToClipboard', () => {
    it('5 次并发调用 → 每次独立完成，clipboard.writeBuffer 被调用 5 次', async () => {
      vi.mocked(fs.promises.stat).mockResolvedValue(mockStats(true) as never)

      const calls = Array.from({ length: 5 }, (_, i) =>
        shareService.copyFilesToClipboard([`C:\\photo${i}.jpg`])
      )
      const results = await Promise.all(calls)

      expect(results.every((r) => r.success)).toBe(true)
      expect(results.map((r) => r.count)).toEqual([1, 1, 1, 1, 1])
      expect(clipboard.writeBuffer).toHaveBeenCalledTimes(5)
      for (let i = 0; i < 5; i++) {
        const buf = vi.mocked(clipboard.writeBuffer).mock.calls[i][1] as Buffer
        const pathsSection = buf.subarray(20).toString('utf16le')
        expect(pathsSection).toContain(`photo${i}.jpg`)
      }
    })

    it('并发调用中部分文件不可访问 → 各自独立统计 skipped', async () => {
      vi.mocked(fs.promises.stat)
        .mockResolvedValueOnce(mockStats(true) as never)
        .mockRejectedValueOnce(new Error('ENOENT') as never)
        .mockResolvedValueOnce(mockStats(true) as never)
        .mockRejectedValueOnce(new Error('EACCES') as never)
        .mockResolvedValueOnce(mockStats(true) as never)

      const calls = [
        shareService.copyFilesToClipboard(['C:\\ok1.jpg']),
        shareService.copyFilesToClipboard(['C:\\missing1.jpg']),
        shareService.copyFilesToClipboard(['C:\\ok2.jpg']),
        shareService.copyFilesToClipboard(['C:\\locked.jpg']),
        shareService.copyFilesToClipboard(['C:\\ok3.jpg'])
      ]
      const results = await Promise.all(calls)

      expect(results.map((r) => r.success)).toEqual([true, false, true, false, true])
      expect(results.map((r) => r.count)).toEqual([1, 0, 1, 0, 1])
      expect(results.map((r) => r.skipped)).toEqual([0, 1, 0, 1, 0])
      expect(clipboard.writeBuffer).toHaveBeenCalledTimes(3)
    })
  })

  // ============================================================
  // 边界 2：installPathCache TTL 失效
  // ============================================================
  describe('边界 2：应用状态检测缓存 TTL（5 分钟）', () => {
    it('首次检测 → 第二次命中缓存 → 推进 6 分钟后缓存失效重新检测', async () => {
      vi.useFakeTimers()
      mockAllExternalCommandsFail()

      // 第一次：触发完整 4 层检测
      await shareService.getAppStatus('wechat')
      expect(vi.mocked(execFile).mock.calls.length).toBeGreaterThan(0)

      // 第二次：应命中缓存
      vi.mocked(execFile).mockClear()
      const status2 = await shareService.getAppStatus('wechat')
      expect(status2.installed).toBe(false)
      expect(vi.mocked(execFile)).not.toHaveBeenCalled()

      // 推进 6 分钟（超过 5 分钟 TTL）
      vi.advanceTimersByTime(6 * 60 * 1000)
      vi.mocked(execFile).mockClear()

      // 第三次：缓存已过期，重新检测
      await shareService.getAppStatus('wechat')
      expect(vi.mocked(execFile).mock.calls.length).toBeGreaterThan(0)
    })

    it('不同渠道独立缓存：检测 wechat 后检测 qq，qq 不命中 wechat 缓存', async () => {
      mockAllExternalCommandsFail()

      await shareService.getAppStatus('wechat')
      expect(vi.mocked(execFile).mock.calls.length).toBeGreaterThan(0)

      // qq 不应命中 wechat 的缓存
      vi.mocked(execFile).mockClear()
      await shareService.getAppStatus('qq')
      expect(vi.mocked(execFile).mock.calls.length).toBeGreaterThan(0)

      // qq 再次检测应命中 qq 自己的缓存
      vi.mocked(execFile).mockClear()
      await shareService.getAppStatus('qq')
      expect(vi.mocked(execFile)).not.toHaveBeenCalled()
    })
  })

  // ============================================================
  // 边界 3：非 win32 平台不支持 CF_HDROP
  // ============================================================
  describe('边界 3：非 win32 平台兜底', () => {
    it('linux 平台 → copyFilesToClipboard 返回平台不支持，clipboard 不被调用', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      vi.mocked(fs.promises.stat).mockResolvedValue(mockStats(true) as never)

      const result = await shareService.copyFilesToClipboard(['C:\\photo.jpg'])

      expect(result.success).toBe(false)
      expect(result.message).toContain('当前平台不支持 CF_HDROP')
      expect(clipboard.writeBuffer).not.toHaveBeenCalled()
    })

    it('darwin 平台 → getAppStatus 返回未安装，不调用任何 Windows 命令', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

      const status = await shareService.getAppStatus('wechat')

      expect(status).toEqual({ installed: false, running: false, installPath: null })
      expect(vi.mocked(execFile)).not.toHaveBeenCalled()
    })

    it('平台从 win32 切到 linux 再切回 → 每次行为与当前平台一致', async () => {
      vi.mocked(fs.promises.stat).mockResolvedValue(mockStats(true) as never)

      // win32：成功
      const r1 = await shareService.copyFilesToClipboard(['C:\\a.jpg'])
      expect(r1.success).toBe(true)
      expect(clipboard.writeBuffer).toHaveBeenCalledTimes(1)

      // 切到 linux：失败
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      const r2 = await shareService.copyFilesToClipboard(['C:\\a.jpg'])
      expect(r2.success).toBe(false)
      expect(clipboard.writeBuffer).toHaveBeenCalledTimes(1)

      // 切回 win32：再次成功
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      const r3 = await shareService.copyFilesToClipboard(['C:\\a.jpg'])
      expect(r3.success).toBe(true)
      expect(clipboard.writeBuffer).toHaveBeenCalledTimes(2)
    })
  })
})
