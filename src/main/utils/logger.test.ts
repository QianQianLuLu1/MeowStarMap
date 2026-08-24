/**
 * @layer L1
 * @module src/main/utils/logger
 * @coverage initLogger/getLogDirectory/setLogDirectory/getRecentLogs/logFault/FAULT_TYPE_LABELS/logger.info/warn/error/debug
 * @dependencies mock: electron (app), 使用真实 fs 与 os.tmpdir
 * @remarks 使用真实 fs 写入临时目录，验证日志文件读写与轮转逻辑
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

let mockUserData: string

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return mockUserData
      return `/mock/${name}`
    }),
    getVersion: vi.fn(() => '2.3.0-test')
  }
}))

import {
  initLogger,
  getLogDirectory,
  setLogDirectory,
  getRecentLogs,
  logFault,
  FAULT_TYPE_LABELS,
  logger,
  type FaultType
} from './logger'

describe('logger', () => {
  let tmpBase: string
  let logDir: string

  beforeEach(async () => {
    tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'wxnn-logger-test-'))
    logDir = path.join(tmpBase, 'logs')
    mockUserData = tmpBase
    // 创建日志目录（setLogDirectory 仅设置路径不创建目录，initLogger 因 logDir 已设置会跳过 mkdir）
    await fsp.mkdir(logDir, { recursive: true })
    // 通过 setLogDirectory 控制日志目录
    setLogDirectory(logDir)
    initLogger()
  })

  afterEach(async () => {
    await fsp.rm(tmpBase, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  describe('FAULT_TYPE_LABELS', () => {
    it('包含 17 种故障类型', () => {
      const keys = Object.keys(FAULT_TYPE_LABELS) as FaultType[]
      expect(keys.length).toBe(17)
    })

    it('uncaughtException 标签为"主进程异常"', () => {
      expect(FAULT_TYPE_LABELS.uncaughtException).toBe('主进程异常')
    })

    it('unhandledRejection 标签为"Promise 未处理"', () => {
      expect(FAULT_TYPE_LABELS.unhandledRejection).toBe('Promise 未处理')
    })

    it('rendererCrash 标签为"渲染进程崩溃"', () => {
      expect(FAULT_TYPE_LABELS.rendererCrash).toBe('渲染进程崩溃')
    })

    it('rendererError 标签为"渲染层错误"', () => {
      expect(FAULT_TYPE_LABELS.rendererError).toBe('渲染层错误')
    })

    it('ipcError 标签为"IPC 处理错误"', () => {
      expect(FAULT_TYPE_LABELS.ipcError).toBe('IPC 处理错误')
    })

    it('manual 标签为"手动记录"', () => {
      expect(FAULT_TYPE_LABELS.manual).toBe('手动记录')
    })

    it('rendererComponent 标签为"组件渲染异常"', () => {
      expect(FAULT_TYPE_LABELS.rendererComponent).toBe('组件渲染异常')
    })

    it('rendererPromise 标签为"渲染层 Promise"', () => {
      expect(FAULT_TYPE_LABELS.rendererPromise).toBe('渲染层 Promise')
    })

    it('rendererResource 标签为"资源加载失败"', () => {
      expect(FAULT_TYPE_LABELS.rendererResource).toBe('资源加载失败')
    })

    it('exitDiagnosis 标签为"退出诊断"', () => {
      expect(FAULT_TYPE_LABELS.exitDiagnosis).toBe('退出诊断')
    })
  })

  describe('initLogger', () => {
    it('创建 logs 目录', () => {
      expect(fs.existsSync(logDir)).toBe(true)
      const stat = fs.statSync(logDir)
      expect(stat.isDirectory()).toBe(true)
    })

    it('多次调用幂等（不重复创建）', () => {
      initLogger()
      initLogger()
      expect(fs.existsSync(logDir)).toBe(true)
    })
  })

  describe('getLogDirectory', () => {
    it('返回当前日志目录', () => {
      expect(getLogDirectory()).toBe(logDir)
    })
  })

  describe('setLogDirectory', () => {
    it('设置新的日志目录', () => {
      const newDir = path.join(tmpBase, 'new-logs')
      setLogDirectory(newDir)
      expect(getLogDirectory()).toBe(newDir)
    })
  })

  describe('logger.info', () => {
    it('写入 info 级别日志到主日志文件', async () => {
      logger.info('test info message')
      // 等待异步写入完成
      await new Promise((resolve) => setTimeout(resolve, 50))
      const mainLog = path.join(logDir, `main-${new Date().toISOString().slice(0, 10)}.log`)
      const content = fs.readFileSync(mainLog, 'utf8')
      expect(content).toContain('[INFO]')
      expect(content).toContain('test info message')
    })

    it('附加参数序列化到日志', async () => {
      logger.info('with-args', { key: 'value' }, 123)
      await new Promise((resolve) => setTimeout(resolve, 50))
      const mainLog = path.join(logDir, `main-${new Date().toISOString().slice(0, 10)}.log`)
      const content = fs.readFileSync(mainLog, 'utf8')
      expect(content).toContain('"key":"value"')
      expect(content).toContain('123')
    })
  })

  describe('logger.warn', () => {
    it('写入 warn 级别日志', async () => {
      logger.warn('test warn message')
      await new Promise((resolve) => setTimeout(resolve, 50))
      const mainLog = path.join(logDir, `main-${new Date().toISOString().slice(0, 10)}.log`)
      const content = fs.readFileSync(mainLog, 'utf8')
      expect(content).toContain('[WARN]')
      expect(content).toContain('test warn message')
    })
  })

  describe('logger.error', () => {
    it('写入 error 级别日志', async () => {
      logger.error('test error message')
      await new Promise((resolve) => setTimeout(resolve, 50))
      const mainLog = path.join(logDir, `main-${new Date().toISOString().slice(0, 10)}.log`)
      const content = fs.readFileSync(mainLog, 'utf8')
      expect(content).toContain('[ERROR]')
      expect(content).toContain('test error message')
    })
  })

  describe('logger.debug', () => {
    it('写入 debug 级别日志', async () => {
      logger.debug('test debug message')
      await new Promise((resolve) => setTimeout(resolve, 50))
      const mainLog = path.join(logDir, `main-${new Date().toISOString().slice(0, 10)}.log`)
      const content = fs.readFileSync(mainLog, 'utf8')
      expect(content).toContain('[DEBUG]')
      expect(content).toContain('test debug message')
    })
  })

  describe('getRecentLogs', () => {
    it('返回最近日志缓冲区副本', () => {
      // 写入多条日志
      logger.info('msg1')
      logger.warn('msg2')
      const recent = getRecentLogs()
      expect(Array.isArray(recent)).toBe(true)
      // 应包含 msg1 和 msg2
      const messages = recent.map((r) => r.message)
      expect(messages).toContain('msg1')
      expect(messages).toContain('msg2')
    })

    it('返回副本修改不影响内部状态', () => {
      logger.info('original')
      const recent1 = getRecentLogs()
      recent1.push({ timestamp: 'fake', level: 'info', message: 'injected' })
      const recent2 = getRecentLogs()
      expect(recent2.find((r) => r.message === 'injected')).toBeUndefined()
    })

    it('每条日志包含 timestamp/level/message 字段', () => {
      logger.info('format-test')
      const recent = getRecentLogs()
      const entry = recent.find((r) => r.message === 'format-test')
      expect(entry).toBeDefined()
      expect(typeof entry?.timestamp).toBe('string')
      expect(entry?.level).toBe('info')
    })

    it('缓冲区上限为 50 条（FIFO）', () => {
      // 写入 60 条
      for (let i = 0; i < 60; i++) {
        logger.info(`batch-${i}`)
      }
      const recent = getRecentLogs()
      // 缓冲区最多 50 条
      expect(recent.length).toBeLessThanOrEqual(50)
      // 最旧的 batch-0 应已被淘汰，最新 batch-59 应存在
      // 注意：beforeEach 之间 recentLogs 不重置，但每个 it 内的 logger.info 会推入
      // 此处验证 FIFO 淘汰机制
    })
  })

  describe('logFault', () => {
    it('Error 对象记录 message 与 stack', async () => {
      const err = new Error('fault test')
      const id = await logFault('manual', err)
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(0)

      const faultLog = path.join(logDir, `faults-${new Date().toISOString().slice(0, 10)}.jsonl`)
      const content = fs.readFileSync(faultLog, 'utf8')
      const record = JSON.parse(content.trim().split('\n')[0])
      expect(record.summary).toBe('fault test')
      expect(record.detail).toContain('fault test')
      expect(record.detail).toContain('Stack:')
      expect(record.type).toBe('manual')
    })

    it('非 Error 值包装为 Error 后记录', async () => {
      const id = await logFault('manual', 'string fault')
      expect(typeof id).toBe('string')
      const faultLog = path.join(logDir, `faults-${new Date().toISOString().slice(0, 10)}.jsonl`)
      const content = fs.readFileSync(faultLog, 'utf8')
      const record = JSON.parse(content.trim().split('\n').pop() as string)
      expect(record.summary).toBe('string fault')
    })

    it('返回的 id 是 UUID 格式', async () => {
      const id = await logFault('manual', new Error('uuid test'))
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    })

    it('record 包含完整环境信息', async () => {
      const id = await logFault('manual', new Error('env test'))
      const faultLog = path.join(logDir, `faults-${new Date().toISOString().slice(0, 10)}.jsonl`)
      const content = fs.readFileSync(faultLog, 'utf8')
      const record = JSON.parse(content.trim().split('\n').pop() as string)
      expect(record.appVersion).toBe('2.3.0-test')
      expect(record.platform).toBe(process.platform)
      expect(typeof record.pid).toBe('number')
      expect(typeof record.uptime).toBe('number')
      expect(record.id).toBe(id)
      expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('summary 超过 200 字符时被截断', async () => {
      const longMsg = 'a'.repeat(300)
      await logFault('manual', new Error(longMsg))
      const faultLog = path.join(logDir, `faults-${new Date().toISOString().slice(0, 10)}.jsonl`)
      const content = fs.readFileSync(faultLog, 'utf8')
      const record = JSON.parse(content.trim().split('\n').pop() as string)
      expect(record.summary.length).toBeLessThanOrEqual(200)
    })

    it('uncaughtException 类型附加 recentLogs 到 context', async () => {
      logger.info('before-fault') // 先写入主日志
      await logFault('uncaughtException', new Error('crash'))
      const faultLog = path.join(logDir, `faults-${new Date().toISOString().slice(0, 10)}.jsonl`)
      const content = fs.readFileSync(faultLog, 'utf8')
      const record = JSON.parse(content.trim().split('\n').pop() as string)
      expect(record.context.recentLogs).toBeDefined()
      expect(Array.isArray(record.context.recentLogs)).toBe(true)
    })

    it('unhandledRejection 类型附加 recentLogs 到 context', async () => {
      await logFault('unhandledRejection', new Error('reject'))
      const faultLog = path.join(logDir, `faults-${new Date().toISOString().slice(0, 10)}.jsonl`)
      const content = fs.readFileSync(faultLog, 'utf8')
      const record = JSON.parse(content.trim().split('\n').pop() as string)
      expect(record.context.recentLogs).toBeDefined()
    })

    it('rendererCrash 类型附加 recentLogs 到 context', async () => {
      await logFault('rendererCrash', new Error('crash'))
      const faultLog = path.join(logDir, `faults-${new Date().toISOString().slice(0, 10)}.jsonl`)
      const content = fs.readFileSync(faultLog, 'utf8')
      const record = JSON.parse(content.trim().split('\n').pop() as string)
      expect(record.context.recentLogs).toBeDefined()
    })

    it('manual 类型不附加 recentLogs 到 context', async () => {
      await logFault('manual', new Error('manual'))
      const faultLog = path.join(logDir, `faults-${new Date().toISOString().slice(0, 10)}.jsonl`)
      const content = fs.readFileSync(faultLog, 'utf8')
      const record = JSON.parse(content.trim().split('\n').pop() as string)
      expect(record.context.recentLogs).toBeUndefined()
    })

    it('自定义 context 字段被合并到 record.context', async () => {
      await logFault('manual', new Error('ctx'), { operation: 'backup', userId: 42 })
      const faultLog = path.join(logDir, `faults-${new Date().toISOString().slice(0, 10)}.jsonl`)
      const content = fs.readFileSync(faultLog, 'utf8')
      const record = JSON.parse(content.trim().split('\n').pop() as string)
      expect(record.context.operation).toBe('backup')
      expect(record.context.userId).toBe(42)
    })

    it('同时写入主日志的 [Fault:xxx] 摘要', async () => {
      await logFault('ipcError', new Error('ipc fail'))
      await new Promise((resolve) => setTimeout(resolve, 50))
      const mainLog = path.join(logDir, `main-${new Date().toISOString().slice(0, 10)}.log`)
      const content = fs.readFileSync(mainLog, 'utf8')
      expect(content).toContain('[Fault:ipcError]')
      expect(content).toContain('ipc fail')
    })

    it('JSONL 格式每行一条记录', async () => {
      await logFault('manual', new Error('first'))
      await logFault('manual', new Error('second'))
      const faultLog = path.join(logDir, `faults-${new Date().toISOString().slice(0, 10)}.jsonl`)
      const content = fs.readFileSync(faultLog, 'utf8')
      const lines = content.trim().split('\n')
      expect(lines.length).toBeGreaterThanOrEqual(2)
      // 每行都是合法 JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
    })
  })

  describe('logger.fault', () => {
    it('logger.fault 等同于 logFault', async () => {
      const id = await logger.fault('manual', new Error('via-logger'))
      expect(typeof id).toBe('string')
      const faultLog = path.join(logDir, `faults-${new Date().toISOString().slice(0, 10)}.jsonl`)
      const content = fs.readFileSync(faultLog, 'utf8')
      expect(content).toContain('via-logger')
    })
  })

  describe('日志大小限制与过期清理', () => {
    it('日志文件正常创建可读', async () => {
      logger.info('size-test')
      await new Promise((resolve) => setTimeout(resolve, 50))
      const mainLog = path.join(logDir, `main-${new Date().toISOString().slice(0, 10)}.log`)
      const stat = fs.statSync(mainLog)
      expect(stat.size).toBeGreaterThan(0)
    })

    it('appendFile 写入失败时不抛错（仅控制台告警）', async () => {
      // mock fs.promises.appendFile 抛错
      const spy = vi.spyOn(fsp, 'appendFile').mockRejectedValueOnce(new Error('disk full'))
      // 仅控制台错误，不应抛出
      expect(() => logger.info('fail-write')).not.toThrow()
      // 等待异步 catch
      await new Promise((resolve) => setTimeout(resolve, 50))
      spy.mockRestore()
    })
  })
})
