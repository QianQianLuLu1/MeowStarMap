/**
 * @layer L3
 * @module src/main/ipc/media-read-guard
 * @coverage assertMediaReadPath 双层读路径白名单校验分支
 * @dependencies media-protocol(isMediaPathAllowed) / validator(assertFileReadPath, 真实 PathGuard)
 *
 * 验证目标（媒体白名单优先、PathGuard 兜底）：
 *   1. 命中媒体白名单 → 放行，assertFileReadPath 零调用
 *   2. 未命中媒体白名单但 PathGuard 放行（已注册根）→ 成功，
 *      assertFileReadPath 调用 1 次
 *   3. 双白名单均不命中（敏感目录 / 未注册盘符路径）→ 抛
 *      AppError（code = IPC_PATH_FORBIDDEN）
 *   4. 可选：用户主目录凭据目录（黑名单）即使位于 userHome 内也被拒绝
 *   5. 快路径敏感目录黑名单复检：即使 isMediaPathAllowed=true，敏感路径仍被拒绝（回落兜底后由黑名单拒绝）
 *   6. 快路径 realpath 复检（符号链接 / junction 绕过）：
 *      a. realpath 解出敏感路径 → 回落 assertFileReadPath(real) 被拒
 *      b. realpath 抛错（不存在 / 无权限）→ 维持放行，交由下游读取报错
 *      c. realpath 解出非敏感真实路径 → 正常放行，assertFileReadPath 零调用
 */
import os from 'os'
import path from 'path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from './handler-context'

const { isMediaPathAllowedMock, loggerDebugMock, realpathNativeMock } = vi.hoisted(() => {
  return {
    isMediaPathAllowedMock: vi.fn(),
    loggerDebugMock: vi.fn(),
    // 快路径 realpath 复检：默认恒等返回（无符号链接），各用例按分支覆写
    realpathNativeMock: vi.fn((p: string) => p)
  }
})

// fs 部分 mock：仅接管 realpathSync.native（guard 唯一使用的 fs API），
// 其余成员保留真实实现，避免影响真实 validator / ipc-validate 的行为
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const base = ((actual as unknown as { default?: typeof actual }).default ??
    actual) as typeof actual
  const realpathSync = Object.assign(
    ((...args: Parameters<typeof base.realpathSync>) =>
      base.realpathSync(...args)) as typeof base.realpathSync,
    { native: realpathNativeMock as unknown as typeof base.realpathSync.native }
  )
  const patched = { ...base, realpathSync }
  return { ...patched, default: patched }
})

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: {
    getPath: vi.fn(() => '/mock'),
    getAppPath: vi.fn(() => '/mock'),
    getName: vi.fn(() => 'mock'),
    getLocale: vi.fn(() => 'zh-CN')
  },
  BrowserWindow: vi.fn(),
  nativeImage: { createFromPath: vi.fn() },
  dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn() }
}))

// 媒体白名单由测试按分支控制返回值
vi.mock('../app/media-protocol', () => ({
  isMediaPathAllowed: isMediaPathAllowedMock
}))

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: loggerDebugMock },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

// PathGuard 使用真实实现（含敏感目录黑名单）；
// 仅将 assertFileReadPath 包装为可计数函数，行为不变（委托真实实现）
vi.mock('./validator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./validator')>()
  return {
    ...actual,
    assertFileReadPath: vi.fn(actual.assertFileReadPath)
  }
})

import { assertMediaReadPath, assertMediaDeletePath } from './media-read-guard'
import { assertFileReadPath, pathGuard } from './validator'
import { AppError } from '../../shared/errors/app-error'

const assertFileReadPathMock = vi.mocked(assertFileReadPath)

function makeCtx(): HandlerContext {
  const dbStub = {
    prepare: () => ({ get: () => undefined, all: () => [], run: () => ({}) })
  }
  return {
    dbManager: {
      getDatabase: vi.fn(() => dbStub as never),
      getWorkerBridge: vi.fn(() => undefined),
      getDbPath: vi.fn(() => '/mock/db.sqlite')
    },
    scannerManager: {} as never,
    mediaWorkerManager: {} as never,
    taskScheduler: {} as never,
    thumbnailGen: { getCacheDir: () => '/mock/thumb' } as never,
    fileService: {} as never,
    videoService: {} as never,
    watermarkService: {} as never,
    videoEditorBridge: {} as never,
    getMainWindow: () => null,
    notifyMediaUpdated: vi.fn(),
    invalidateMediaPathCache: vi.fn(),
    applyUITheme: vi.fn(),
    isThumbnailsGenerating: () => false,
    setThumbnailsGenerating: vi.fn()
  } as unknown as HandlerContext
}

describe('assertMediaReadPath 双层读路径白名单校验', () => {
  beforeEach(() => {
    assertFileReadPathMock.mockClear()
    isMediaPathAllowedMock.mockReset()
    loggerDebugMock.mockClear()
    // 默认无符号链接：realpath 恒等返回入参
    realpathNativeMock.mockReset()
    realpathNativeMock.mockImplementation((p: string) => p)
  })

  it('命中媒体白名单时直接放行，assertFileReadPath 零调用', () => {
    isMediaPathAllowedMock.mockReturnValue(true)

    expect(() =>
      assertMediaReadPath(makeCtx(), 'D:/games/InfinityNikki/photo/001.jpg')
    ).not.toThrow()
    // 关键：命中媒体白名单后不得再走审批白名单
    expect(assertFileReadPathMock).not.toHaveBeenCalled()
    // 命中时记录 debug 日志（复用 main.decrypt.log.mediaWhitelistHit key）
    expect(loggerDebugMock).toHaveBeenCalledTimes(1)
  })

  it('未命中媒体白名单但 PathGuard 已注册根时兜底放行，assertFileReadPath 调用 1 次', () => {
    isMediaPathAllowedMock.mockReturnValue(false)
    pathGuard.register('D:/allowed-root')

    expect(() => assertMediaReadPath(makeCtx(), 'D:/allowed-root/photo.jpg')).not.toThrow()
    // 关键：未命中媒体白名单时回退审批白名单兜底，且兜底放行
    expect(assertFileReadPathMock).toHaveBeenCalledTimes(1)
    expect(assertFileReadPathMock).toHaveBeenCalledWith('D:/allowed-root/photo.jpg')
  })

  it('双白名单均不命中时抛出 AppError（IPC_PATH_FORBIDDEN）：系统敏感目录', () => {
    isMediaPathAllowedMock.mockReturnValue(false)

    expect(() => assertMediaReadPath(makeCtx(), 'C:/Windows/System32/config/SAM')).toThrow(AppError)
    expect(assertFileReadPathMock).toHaveBeenCalledTimes(1)
    try {
      assertMediaReadPath(makeCtx(), 'C:/Windows/System32/config/SAM')
    } catch (e) {
      expect((e as AppError).code).toBe('IPC_PATH_FORBIDDEN')
    }
  })

  it('双白名单均不命中时抛出 AppError（IPC_PATH_FORBIDDEN）：未注册盘符路径', () => {
    isMediaPathAllowedMock.mockReturnValue(false)

    try {
      assertMediaReadPath(makeCtx(), 'Z:/unregistered/file.jpg')
      expect.unreachable('未注册路径必须被拒绝')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).code).toBe('IPC_PATH_FORBIDDEN')
    }
    expect(assertFileReadPathMock).toHaveBeenCalledTimes(1)
  })

  it('敏感目录黑名单：用户主目录凭据目录（.ssh）即使位于 userHome 内也被拒绝', () => {
    isMediaPathAllowedMock.mockReturnValue(false)
    const credentialPath = path.join(os.homedir(), '.ssh', 'id_rsa')

    expect(() => assertMediaReadPath(makeCtx(), credentialPath)).toThrow(AppError)
    expect(assertFileReadPathMock).toHaveBeenCalledTimes(1)
  })

  it('快路径黑名单复检：敏感路径即使命中媒体白名单（mock=true）仍被拒绝', () => {
    // 纵深防御：媒体白名单命中也不走快路径，回落 assertFileReadPath 后由黑名单拒绝；
    // 即使 userHome 已注册进 PathGuard，敏感目录仍始终拒绝（PathGuard 对系统敏感目录不放行）
    isMediaPathAllowedMock.mockReturnValue(true)
    pathGuard.register(os.homedir())
    const credentialPath = path.join(os.homedir(), '.ssh', 'id_rsa')

    expect(() => assertMediaReadPath(makeCtx(), credentialPath)).toThrow(AppError)
    // 关键：敏感路径不走快路径，必然回落兜底校验 1 次（而非命中白名单后零调用）
    expect(assertFileReadPathMock).toHaveBeenCalledTimes(1)
    try {
      assertMediaReadPath(makeCtx(), credentialPath)
    } catch (e) {
      expect((e as AppError).code).toBe('IPC_PATH_FORBIDDEN')
    }
  })

  it('快路径 realpath 复检：媒体目录下的软链指向敏感路径时被拒绝（回落 real 路径兜底）', () => {
    // 攻击构造：D:\...\ScreenShot\evil.jpg 是指向 %USERPROFILE%\.aws\credentials 的软链/junction
    // 入参本身不含敏感段（isSensitivePath=false）且命中媒体白名单，唯一防线是 realpath 复检
    isMediaPathAllowedMock.mockReturnValue(true)
    const linkPath = 'D:/games/InfinityNikki/X6Game/ScreenShot/evil.jpg'
    const realTarget = path.join(os.homedir(), '.aws', 'credentials')
    realpathNativeMock.mockImplementation(() => realTarget)

    try {
      assertMediaReadPath(makeCtx(), linkPath)
      expect.unreachable('指向敏感路径的软链必须被拒绝')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).code).toBe('IPC_PATH_FORBIDDEN')
    }
    // 关键：兜底校验收到的是解引用后的真实路径（用入参调用则 PathGuard 仍会被绕过）
    expect(assertFileReadPathMock).toHaveBeenCalledTimes(1)
    expect(assertFileReadPathMock).toHaveBeenCalledWith(realTarget)
    // 被拒时不得记录“白名单命中”debug 日志
    expect(loggerDebugMock).not.toHaveBeenCalled()
  })

  it('快路径 realpath 复检：realpath 抛错（不存在/无权限）时维持放行，交由下游读取报错', () => {
    isMediaPathAllowedMock.mockReturnValue(true)
    realpathNativeMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    })

    expect(() =>
      assertMediaReadPath(makeCtx(), 'D:/games/InfinityNikki/photo/001.jpg')
    ).not.toThrow()
    expect(assertFileReadPathMock).not.toHaveBeenCalled()
    expect(loggerDebugMock).toHaveBeenCalledTimes(1)
  })

  it('快路径 realpath 复检：真实路径非敏感时正常放行，assertFileReadPath 零调用', () => {
    isMediaPathAllowedMock.mockReturnValue(true)
    // 媒体目录本身位于 junction 上的合法场景：realpath 落到另一盘符但仍非敏感
    realpathNativeMock.mockImplementation(() => 'E:/real-media/InfinityNikki/photo/001.jpg')

    expect(() =>
      assertMediaReadPath(makeCtx(), 'D:/games/InfinityNikki/photo/001.jpg')
    ).not.toThrow()
    expect(realpathNativeMock).toHaveBeenCalledWith('D:/games/InfinityNikki/photo/001.jpg')
    expect(assertFileReadPathMock).not.toHaveBeenCalled()
    expect(loggerDebugMock).toHaveBeenCalledTimes(1)
  })
})

describe('assertMediaDeletePath 删除路径三级校验（userPicked → 媒体白名单 → PathGuard 兜底）', () => {
  beforeEach(() => {
    assertFileReadPathMock.mockClear()
    isMediaPathAllowedMock.mockReset()
    loggerDebugMock.mockClear()
  })

  it('N1 userPicked 命中放行：不再走 PathGuard 兜底（与 scanner:start 短路同语义）', () => {
    isMediaPathAllowedMock.mockReturnValue(false)
    pathGuard.registerUserPicked('E:/delete-picked-root')

    expect(() =>
      assertMediaDeletePath(makeCtx(), 'E:/delete-picked-root/photo/001.jpg')
    ).not.toThrow()
    // 关键：userPicked 短路后不得再走审批白名单兜底
    expect(assertFileReadPathMock).not.toHaveBeenCalled()
  })

  it('N2 已入库媒体命中媒体白名单放行（与 media:// 展示授权同口径）', () => {
    isMediaPathAllowedMock.mockReturnValue(true)

    expect(() =>
      assertMediaDeletePath(makeCtx(), 'D:/games/InfinityNikki/photo/001.jpg')
    ).not.toThrow()
    expect(assertFileReadPathMock).not.toHaveBeenCalled()
  })

  it('N3 双白名单未命中但 PathGuard 已注册根时兜底放行，assertFileReadPath 调用 1 次', () => {
    isMediaPathAllowedMock.mockReturnValue(false)
    pathGuard.register('E:/delete-root')

    expect(() => assertMediaDeletePath(makeCtx(), 'E:/delete-root/photo.jpg')).not.toThrow()
    expect(assertFileReadPathMock).toHaveBeenCalledTimes(1)
    expect(assertFileReadPathMock).toHaveBeenCalledWith('E:/delete-root/photo.jpg')
  })

  it('E1 三级皆不命中（系统敏感目录）抛出 AppError（IPC_PATH_FORBIDDEN）', () => {
    isMediaPathAllowedMock.mockReturnValue(false)

    expect(() => assertMediaDeletePath(makeCtx(), 'C:/Windows/notepad.exe')).toThrow(AppError)
    expect(assertFileReadPathMock).toHaveBeenCalledTimes(1)
  })

  it('E2 三级皆不命中（未注册盘符路径）抛出 AppError（IPC_PATH_FORBIDDEN）', () => {
    isMediaPathAllowedMock.mockReturnValue(false)

    try {
      assertMediaDeletePath(makeCtx(), 'Z:/unregistered/file.jpg')
      expect.unreachable('未注册路径必须被拒绝')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).code).toBe('IPC_PATH_FORBIDDEN')
    }
    expect(assertFileReadPathMock).toHaveBeenCalledTimes(1)
  })

  it('B1 核心场景：敏感目录（Program Files）下已入库媒体删除放行（修复目标）', () => {
    // 游戏装在 Steam 默认路径下：旧链路 assertFileReadPath 被 isSensitivePath 黑名单硬拒，
    // 新守卫凭已入库媒体白名单放行（与 media:// 展示、media:permanentDelete 口径一致）
    isMediaPathAllowedMock.mockReturnValue(true)
    const steamPhoto =
      'C:/Program Files (x86)/Steam/steamapps/common/InfinityNikki/X6Game/ScreenShot/001.jpg'

    expect(() => assertMediaDeletePath(makeCtx(), steamPhoto)).not.toThrow()
    expect(assertFileReadPathMock).not.toHaveBeenCalled()
  })

  it('B2 非绝对路径不短路，原样落 PathGuard 兜底拒绝', () => {
    isMediaPathAllowedMock.mockReturnValue(false)

    expect(() => assertMediaDeletePath(makeCtx(), 'relative/a.jpg')).toThrow(AppError)
    expect(assertFileReadPathMock).toHaveBeenCalledTimes(1)
  })
})
