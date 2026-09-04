/**
 * @layer L2
 * @module src/main/scanner/scan-abort
 * @coverage 中止标志状态机：默认值/置位/复位/连续置位幂等
 *          + 反向导入守卫（game-directory-discovery 严禁 import worker-entry）
 * @dependencies 无 electron / 无 fs（纯状态 + 源码文本断言）
 *
 * 反向导入守卫的背景：game-directory-discovery 曾从 worker-entry 导入 shouldStop，
 * 导致主进程侧（scanner-handler → game-directory-discovery）跨块引用整份 worker-entry，
 * 其模块顶层 15s 心跳看门狗在主进程永远收不到 WORKER_PING，启动 15s 后
 * process.exit(0) 静默杀死主进程（2026-08-29 打包版闪退根因）。
 * 本守卫防止该 import 边回归。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { resetScanAbort, abortScan, isScanAborted } from '../scan-abort'

beforeEach(() => {
  resetScanAbort()
})

describe('scan-abort 中止标志状态机', () => {
  it('1. 默认未中止；resetScanAbort 幂等复位', () => {
    expect(isScanAborted()).toBe(false)
    resetScanAbort()
    expect(isScanAborted()).toBe(false)
  })

  it('2. abortScan 置位后读取为 true；resetScanAbort 后恢复 false', () => {
    abortScan()
    expect(isScanAborted()).toBe(true)
    resetScanAbort()
    expect(isScanAborted()).toBe(false)
  })

  it('3. 连续 abortScan 幂等（多次置位不改变语义）', () => {
    abortScan()
    abortScan()
    expect(isScanAborted()).toBe(true)
  })

  it('4. 置位后可再次置位前复位（多轮扫描场景：SCAN_STOP → SCAN_START 复位）', () => {
    abortScan()
    resetScanAbort()
    abortScan()
    expect(isScanAborted()).toBe(true)
    resetScanAbort()
    expect(isScanAborted()).toBe(false)
  })
})

describe('反向导入守卫（主进程不得引用 worker 入口）', () => {
  const scannerDir = path.resolve(__dirname, '..')

  it('5. game-directory-discovery.ts 不得 import worker-entry（防止看门狗进入主进程 chunk）', () => {
    const source = fs.readFileSync(path.join(scannerDir, 'game-directory-discovery.ts'), 'utf8')
    expect(source).not.toMatch(/from\s+'\.[^']*worker-entry'/)
  })

  it('6. scan-abort.ts 必须保持零 import（可被主进程安全加载，无副作用）', () => {
    const source = fs.readFileSync(path.join(scannerDir, 'scan-abort.ts'), 'utf8')
    expect(source).not.toMatch(/^import\s/m)
    expect(source).not.toMatch(/^const .* = require\(/m)
  })
})
