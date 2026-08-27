/**
 * @layer L1
 * @module src/main/utils/startup-diagnostic
 * @coverage logStartupError/readStartupErrors/clearStartupErrors/getStartupLogPathValue
 * @dependencies mock: electron (app), 使用真实 fs 与 os.tmpdir
 * @remarks 使用真实 fs 写入临时目录，验证文件读写逻辑
 *          模块内部缓存 startupLogPath，使用 vi.resetModules + 动态 import 隔离模块实例
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

// 用 vi.hoisted 暴露可在 vi.mock 工厂内访问的可变基准目录
const { getTmpBase, setTmpBase } = vi.hoisted(() => {
  let base = ''
  return {
    getTmpBase: () => base,
    setTmpBase: (b: string) => {
      base = b
    }
  }
})

// 仅覆写 os.homedir，使其落到测试临时目录，避免 fallback 路径在真实用户目录下建目录
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => getTmpBase() || actual.homedir() }
})

// 当前用例的 mock userData 路径
let mockUserData: string
// 当前用例的 mock app.getPath 实现（每个用例独立以便测试抛错场景）
let mockGetPathImpl: (name: string) => string = () => '/mock/default'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => mockGetPathImpl(name))
  }
}))

// 动态加载模块，确保每个用例拿到全新的模块实例（startupLogPath 重新计算）
async function loadModule() {
  const mod = await import('./startup-diagnostic')
  return mod
}

describe('startup-diagnostic', () => {
  let tmpBase: string

  beforeEach(async () => {
    tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'wxnn-startup-test-'))
    setTmpBase(tmpBase)
    mockUserData = path.join(tmpBase, 'userData')
    await fsp.mkdir(mockUserData, { recursive: true })
    mockGetPathImpl = (name: string) => {
      if (name === 'userData') return mockUserData
      return path.join(tmpBase, name)
    }
    // 重置模块缓存，确保 startupLogPath 重新计算
    vi.resetModules()
    // 清空 getPath 调用记录
    vi.mocked(await import('electron')).app.getPath.mockClear()
  })

  afterEach(async () => {
    await fsp.rm(tmpBase, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  describe('getStartupLogPathValue', () => {
    it('返回用户友好目录下的 startup-errors.log 路径', async () => {
      const { getStartupLogPathValue } = await loadModule()
      const p = getStartupLogPathValue()
      // 关键：日志落在用户友好的 NikkiGallery/Diagnostics，而非隐藏的 AppData
      expect(p).toMatch(/NikkiGallery[\\/]Diagnostics[\\/]startup-errors\.log$/)
    })

    it('多次调用返回相同路径（缓存）', async () => {
      const { getStartupLogPathValue } = await loadModule()
      const p1 = getStartupLogPathValue()
      const p2 = getStartupLogPathValue()
      expect(p1).toBe(p2)
    })

    it('app.getPath 抛错时回退到用户友好目录（文档/NikkiGallery/Diagnostics）', async () => {
      // 配置 getPath 抛错（模拟 app 未就绪）
      mockGetPathImpl = () => {
        throw new Error('app not ready')
      }
      const { getStartupLogPathValue } = await loadModule()
      const p = getStartupLogPathValue()
      expect(p).toMatch(/NikkiGallery[\\/]Diagnostics[\\/]startup-errors\.log$/)
    })
  })

  describe('logStartupError', () => {
    it('Error 对象记录 message 与 stack', async () => {
      const { logStartupError, readStartupErrors } = await loadModule()
      const err = new Error('test boom')
      logStartupError('init', err)
      const content = readStartupErrors()
      expect(content).toContain('[STAGE: init]')
      expect(content).toContain('test boom')
      // stack 包含 'Error: test boom'
      expect(content).toContain('Error: test boom')
    })

    it('非 Error 值 String() 化记录', async () => {
      const { logStartupError, readStartupErrors } = await loadModule()
      logStartupError('load', 'string error message')
      const content = readStartupErrors()
      expect(content).toContain('string error message')
      expect(content).toContain('[STAGE: load]')
    })

    it('数字错误值也能记录', async () => {
      const { logStartupError, readStartupErrors } = await loadModule()
      logStartupError('parse', 42)
      const content = readStartupErrors()
      expect(content).toContain('42')
    })

    it('对象错误值 String() 化记录', async () => {
      const { logStartupError, readStartupErrors } = await loadModule()
      logStartupError('serialize', { key: 'value' })
      const content = readStartupErrors()
      expect(content).toContain('[object Object]')
    })

    it('null 错误值 String() 化记录', async () => {
      const { logStartupError, readStartupErrors } = await loadModule()
      logStartupError('null-stage', null)
      const content = readStartupErrors()
      expect(content).toContain('null')
    })

    it('undefined 错误值 String() 化记录', async () => {
      const { logStartupError, readStartupErrors } = await loadModule()
      logStartupError('undefined-stage', undefined)
      const content = readStartupErrors()
      expect(content).toContain('undefined')
    })

    it('记录包含 ISO 8601 时间戳', async () => {
      const { logStartupError, readStartupErrors } = await loadModule()
      logStartupError('time-check', new Error('msg'))
      const content = readStartupErrors()
      // 格式: [2026-01-01T00:00:00.000Z]
      expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/)
    })

    it('多次调用追加写入（不覆盖）', async () => {
      const { logStartupError, readStartupErrors } = await loadModule()
      logStartupError('stage-1', new Error('first'))
      logStartupError('stage-2', new Error('second'))
      const content = readStartupErrors()
      expect(content).toContain('first')
      expect(content).toContain('second')
      expect(content).toContain('[STAGE: stage-1]')
      expect(content).toContain('[STAGE: stage-2]')
    })

    it('日志文件超过 100KB 时重置文件', async () => {
      const { logStartupError, readStartupErrors, getStartupLogPathValue } = await loadModule()
      // 先写入超过 100KB 的内容
      const big = new Error('x'.repeat(120 * 1024))
      logStartupError('big', big)
      // 此时文件应已超过 100KB
      const statBefore = fs.statSync(getStartupLogPathValue())
      expect(statBefore.size).toBeGreaterThan(100 * 1024)

      // 再次写入应触发重置
      logStartupError('reset', new Error('after-reset'))
      const content = readStartupErrors()
      // 重置后内容仅包含最新一条
      expect(content).toContain('after-reset')
      // 旧的大块内容应被覆盖
      expect(content).not.toContain('x'.repeat(1024))
    })

    it('日志文件不存在时（ENOENT）能创建新文件', async () => {
      const { logStartupError, readStartupErrors, getStartupLogPathValue } = await loadModule()
      // 确保文件不存在
      const logPath = getStartupLogPathValue()
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath)
      }
      logStartupError('fresh', new Error('first-write'))
      expect(fs.existsSync(logPath)).toBe(true)
      const content = readStartupErrors()
      expect(content).toContain('first-write')
    })

    it('app.getPath 抛错时回退到用户友好目录仍能写入', async () => {
      mockGetPathImpl = () => {
        throw new Error('app not ready')
      }
      const { logStartupError, getStartupLogPathValue } = await loadModule()
      // 即使 getPath 抛错，logStartupError 也不应抛错
      expect(() => logStartupError('fallback', new Error('test'))).not.toThrow()
      const logPath = getStartupLogPathValue()
      expect(logPath).toMatch(/NikkiGallery[\\/]Diagnostics[\\/]startup-errors\.log$/)
      // 清理可能存在的临时文件
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath)
      }
    })
  })

  describe('readStartupErrors', () => {
    it('日志文件不存在时返回空字符串', async () => {
      const { readStartupErrors, getStartupLogPathValue } = await loadModule()
      const logPath = getStartupLogPathValue()
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath)
      }
      expect(readStartupErrors()).toBe('')
    })

    it('返回文件全部内容', async () => {
      const { logStartupError, readStartupErrors } = await loadModule()
      logStartupError('read-test', new Error('content-1'))
      logStartupError('read-test-2', new Error('content-2'))
      const content = readStartupErrors()
      expect(content).toContain('content-1')
      expect(content).toContain('content-2')
    })

    it('读取失败时返回空字符串（静默处理）', async () => {
      const { logStartupError, readStartupErrors } = await loadModule()
      // mock fs.readFileSync 抛错
      vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
        throw new Error('read fail')
      })
      expect(readStartupErrors()).toBe('')
      vi.restoreAllMocks()
      // 恢复后能正常读取
      logStartupError('restore', new Error('ok'))
      expect(readStartupErrors()).toContain('ok')
    })
  })

  describe('clearStartupErrors', () => {
    it('删除已存在的日志文件', async () => {
      const { logStartupError, clearStartupErrors, getStartupLogPathValue } = await loadModule()
      logStartupError('clear-test', new Error('to-be-cleared'))
      const logPath = getStartupLogPathValue()
      expect(fs.existsSync(logPath)).toBe(true)
      clearStartupErrors()
      expect(fs.existsSync(logPath)).toBe(false)
    })

    it('日志文件不存在时不抛错', async () => {
      const { clearStartupErrors, getStartupLogPathValue } = await loadModule()
      const logPath = getStartupLogPathValue()
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath)
      }
      expect(() => clearStartupErrors()).not.toThrow()
    })

    it('清除后 readStartupErrors 返回空字符串', async () => {
      const { logStartupError, clearStartupErrors, readStartupErrors } = await loadModule()
      logStartupError('clear-read', new Error('before-clear'))
      clearStartupErrors()
      expect(readStartupErrors()).toBe('')
    })

    it('清除后可重新写入', async () => {
      const { logStartupError, clearStartupErrors, readStartupErrors } = await loadModule()
      logStartupError('first', new Error('first-content'))
      clearStartupErrors()
      logStartupError('second', new Error('second-content'))
      const content = readStartupErrors()
      expect(content).not.toContain('first-content')
      expect(content).toContain('second-content')
    })
  })

  describe('logStartupError 错误兜底', () => {
    it('所有 fs 操作失败时不抛错（最外层 catch 兜底）', async () => {
      const { logStartupError } = await loadModule()
      // mock fs.statSync / writeFileSync / appendFileSync 全部抛错
      vi.spyOn(fs, 'statSync').mockImplementation(() => {
        throw new Error('stat fail')
      })
      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw new Error('write fail')
      })
      vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
        throw new Error('append fail')
      })
      expect(() => logStartupError('all-fail', new Error('test'))).not.toThrow()
      vi.restoreAllMocks()
    })

    it('statSync 抛非 ENOENT 错误时改用 appendFileSync', async () => {
      const { logStartupError } = await loadModule()
      // 模拟 statSync 抛 EACCES（非 ENOENT），应走 appendFileSync 分支
      vi.spyOn(fs, 'statSync').mockImplementation(() => {
        const err = new Error('EACCES') as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      })
      const appendSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {})
      logStartupError('eacces', new Error('perm-test'))
      expect(appendSpy).toHaveBeenCalled()
      vi.restoreAllMocks()
    })
  })
})
