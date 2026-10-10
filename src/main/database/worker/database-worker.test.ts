/**
 * @layer L1
 * @module src/main/database/worker/database-worker
 * @coverage 消息分发（DB_OPEN/DB_EXECUTE/DB_EXECUTE_BATCH/DB_TRANSACTION/DB_DISPOSE）、
 *           PRAGMA 序列、bigint→number 转换、事务回滚、致命错误非零退出、DB_LOG 转发
 * @dependencies 共享 mock 工具（tests/mocks）：
 *   - installParentPortStub：process.parentPort 桩（import 被测模块前安装，模块加载期即注册 message handler）
 *   - installBetterSqlite3Hook：Module._load 拦截惰性 require('better-sqlite3')，注入内存桩构造器
 * @remarks process.exit 被 spy 掉后不会真实终止进程，后续逻辑会继续执行，
 *          因此按代码路径断言桩 db 的调用与退出码，而非依赖真实退出。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { MockInstance } from 'vitest'
import {
  installParentPortStub,
  uninstallParentPortStub,
  installBetterSqlite3Hook,
  uninstallBetterSqlite3Hook
} from '../../../../tests/mocks'
import type { ParentPortStubHandle } from '../../../../tests/mocks'
import type { DbWorkerEvent } from './worker-protocol'

// ============ better-sqlite3 内存桩 ============

/** 与 better-sqlite3 Database 实例同形的可控桩（仅覆盖被测代码用到的面） */
class FakeDb {
  dbPath: string
  pragma = vi.fn()
  prepare = vi.fn()
  transaction = vi.fn()
  close = vi.fn()
  /** prepare 返回的语句桩（run 逐用例可编程） */
  stmt: { run: ReturnType<typeof vi.fn> }

  constructor(dbPath: string) {
    this.dbPath = dbPath
    this.stmt = { run: vi.fn(() => ({ changes: 1, lastInsertRowid: 1 })) }
    this.prepare.mockReturnValue(this.stmt)
    // 真实执行回调：回调内抛错会原样向外传播，模拟 better-sqlite3 事务回滚语义
    this.transaction.mockImplementation((fn: (...args: unknown[]) => unknown) => {
      return (...args: unknown[]) => fn(...args)
    })
  }
}

/** 全部构造出的桩实例（按构造顺序），供用例取用断言 */
const instances: FakeDb[] = []

/** 桩构造器：逐用例通过 mockImplementation 切换行为（如构造即抛错模拟 DB_OPEN 失败） */
const FakeDatabase = vi.fn()

/** 恢复为"正常构造"行为并清空实例收集 */
function useWorkingCtor(): void {
  instances.length = 0
  FakeDatabase.mockImplementation(function (this: void, dbPath: string) {
    const inst = new FakeDb(dbPath)
    instances.push(inst)
    return inst
  })
}

// ============ 测试脚手架 ============

let port: ParentPortStubHandle
let exitSpy: MockInstance

beforeAll(async () => {
  // 必须在 import 被测模块之前安装 parentPort 桩：模块加载期即注册 on('message') handler
  port = installParentPortStub()
  installBetterSqlite3Hook(FakeDatabase)
  // 阻止真实退出：stub 后 process.exit 不再终止进程，按代码路径断言即可
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  useWorkingCtor()
  await import('./database-worker')
})

afterAll(() => {
  vi.mocked(process.exit).mockRestore()
  uninstallBetterSqlite3Hook()
  uninstallParentPortStub()
})

beforeEach(() => {
  port.messages.length = 0
  exitSpy.mockClear()
  FakeDatabase.mockClear()
})

/** 发送指令并取走本次产生的全部事件 */
function emit(cmd: unknown): DbWorkerEvent[] {
  const from = port.messages.length
  port.emitMessage(cmd)
  return port.messages.slice(from) as DbWorkerEvent[]
}

/** 打开指定路径的 DB 并断言 DB_READY，返回本次新建的桩实例 */
function openDb(dbPath: string): FakeDb {
  const events = emit({ type: 'DB_OPEN', payload: { dbPath } })
  expect(events).toContainEqual({ type: 'DB_READY' })
  return instances[instances.length - 1]
}

// ============ 用例 ============

describe('database-worker 消息分发与生命周期', () => {
  it('DB_OPEN 成功 → 发送 DB_READY，且执行与主进程一致的 PRAGMA 序列', () => {
    const db = openDb('/data/app.db')

    expect(FakeDatabase).toHaveBeenCalledTimes(1)
    expect(FakeDatabase).toHaveBeenCalledWith('/data/app.db')
    expect(db.pragma.mock.calls.map((c) => c[0])).toEqual([
      'journal_mode = WAL',
      'foreign_keys = ON',
      'synchronous = NORMAL',
      'cache_size = -20000',
      'temp_store = MEMORY',
      'mmap_size = 268435456',
      'wal_autocheckpoint = 1000',
      'busy_timeout = 5000'
    ])
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('同路径重复 DB_OPEN 不重建连接（早退）', () => {
    emit({ type: 'DB_OPEN', payload: { dbPath: '/data/same.db' } })
    emit({ type: 'DB_OPEN', payload: { dbPath: '/data/same.db' } })

    // 构造器只命中一次；两次均回 DB_READY
    expect(FakeDatabase).toHaveBeenCalledTimes(1)
    expect(port.messages.filter((m) => (m as DbWorkerEvent).type === 'DB_READY')).toHaveLength(2)
  })

  it('不同路径 DB_OPEN 先 close 旧连接再新建', () => {
    const first = openDb('/data/one.db')
    const second = openDb('/data/two.db')

    expect(FakeDatabase).toHaveBeenCalledTimes(2)
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()
    expect(second.dbPath).toBe('/data/two.db')
  })

  it('DB_EXECUTE 成功 → DB_RESULT success:true 且携带 changes/lastInsertRowid', () => {
    const db = openDb('/data/exec.db')
    db.stmt.run.mockReturnValue({ changes: 3, lastInsertRowid: 42 })

    const events = emit({
      type: 'DB_EXECUTE',
      payload: { requestId: 7, statement: { sql: 'UPDATE t SET a = ?', params: [1] } }
    })

    expect(db.prepare).toHaveBeenCalledWith('UPDATE t SET a = ?')
    expect(db.stmt.run).toHaveBeenCalledWith([1])
    expect(events).toContainEqual({
      type: 'DB_RESULT',
      payload: { requestId: 7, success: true, result: { changes: 3, lastInsertRowid: 42 } }
    })
  })

  it('DB_EXECUTE 未提供 params 时缺省为空数组', () => {
    const db = openDb('/data/noparams.db')

    emit({
      type: 'DB_EXECUTE',
      payload: { requestId: 8, statement: { sql: 'DELETE FROM t' } }
    })

    expect(db.stmt.run).toHaveBeenCalledWith([])
  })

  it('lastInsertRowid 为 bigint 时转换为 number（toRunResult）', () => {
    const db = openDb('/data/bigint.db')
    db.stmt.run.mockReturnValue({ changes: 1, lastInsertRowid: 5n })

    const events = emit({
      type: 'DB_EXECUTE',
      payload: { requestId: 9, statement: { sql: 'INSERT INTO t VALUES (?)', params: ['x'] } }
    })

    const result = (events[0] as Extract<DbWorkerEvent, { type: 'DB_RESULT' }>).payload.result
    expect(result).toEqual({ changes: 1, lastInsertRowid: 5 })
    expect(typeof result?.lastInsertRowid).toBe('number')
  })

  it('DB_EXECUTE 语句抛错 → DB_RESULT success:false 并携带错误信息', () => {
    const db = openDb('/data/err.db')
    db.stmt.run.mockImplementation(() => {
      throw new Error('SQLITE_CONSTRAINT: boom')
    })

    const events = emit({
      type: 'DB_EXECUTE',
      payload: { requestId: 10, statement: { sql: 'INSERT INTO t VALUES (?)', params: [1] } }
    })

    expect(events).toContainEqual({
      type: 'DB_RESULT',
      payload: { requestId: 10, success: false, message: 'SQLITE_CONSTRAINT: boom' }
    })
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('DB_EXECUTE_BATCH 多语句事务内累积 changes/lastInsertRowid', () => {
    const db = openDb('/data/batch.db')
    db.stmt.run
      .mockReturnValueOnce({ changes: 2, lastInsertRowid: 10 })
      .mockReturnValueOnce({ changes: 3, lastInsertRowid: 11 })

    const events = emit({
      type: 'DB_EXECUTE_BATCH',
      payload: {
        requestId: 11,
        statements: [
          { sql: 'INSERT INTO t VALUES (?)', params: ['a'] },
          { sql: 'UPDATE t SET a = ?', params: ['b'] }
        ]
      }
    })

    expect(db.transaction).toHaveBeenCalledTimes(1)
    expect(db.prepare).toHaveBeenNthCalledWith(1, 'INSERT INTO t VALUES (?)')
    expect(db.prepare).toHaveBeenNthCalledWith(2, 'UPDATE t SET a = ?')
    expect(events).toContainEqual({
      type: 'DB_RESULT',
      payload: { requestId: 11, success: true, result: { changes: 5, lastInsertRowid: 11 } }
    })
  })

  it('DB_TRANSACTION 成功返回累积 changes/lastInsertRowid', () => {
    const db = openDb('/data/tx.db')
    db.stmt.run
      .mockReturnValueOnce({ changes: 1, lastInsertRowid: 100 })
      .mockReturnValueOnce({ changes: 4, lastInsertRowid: 101 })

    const events = emit({
      type: 'DB_TRANSACTION',
      payload: {
        requestId: 12,
        statements: [
          { sql: 'S1', params: [] },
          { sql: 'S2', params: [] }
        ]
      }
    })

    expect(events).toContainEqual({
      type: 'DB_RESULT',
      payload: { requestId: 12, success: true, result: { changes: 5, lastInsertRowid: 101 } }
    })
  })

  it('DB_TRANSACTION 中途语句抛错 → success:false，且经 DB_LOG 转发 warn', () => {
    const db = openDb('/data/tx-err.db')
    db.stmt.run
      .mockReturnValueOnce({ changes: 1, lastInsertRowid: 1 })
      .mockImplementationOnce(() => {
        throw new Error('tx statement failed')
      })

    const events = emit({
      type: 'DB_TRANSACTION',
      payload: {
        requestId: 13,
        statements: [
          { sql: 'OK', params: [] },
          { sql: 'FAIL', params: [] }
        ]
      }
    })

    expect(events).toContainEqual({
      type: 'DB_RESULT',
      payload: { requestId: 13, success: false, message: 'tx statement failed' }
    })
    // workerLog warn 经 parentPort 转发（info 级别在 worker 内丢弃）
    const logs = events.filter((e) => e.type === 'DB_LOG')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      type: 'DB_LOG',
      payload: { level: 'warn', message: expect.stringContaining('事务执行失败') }
    })
  })

  it('DB_DISPOSE → wal_checkpoint(PASSIVE) + close + 回发 DB_WORKER_DISPOSED + exit(0)', async () => {
    const db = openDb('/data/dispose.db')

    const events = emit({ type: 'DB_DISPOSE' })
    // setImmediate(process.exit) 确保确认消息已写出后再退出，需 flush 一个 macrotask 让 exitSpy 生效
    await new Promise((r) => setImmediate(r))

    expect(db.pragma).toHaveBeenCalledWith('wal_checkpoint(PASSIVE)')
    expect(db.close).toHaveBeenCalledTimes(1)
    expect(events).toEqual([{ type: 'DB_WORKER_DISPOSED' }])
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('DB_DISPOSE 后再 DB_EXECUTE → success:false（Database not opened in worker）', () => {
    // 上一用例已 DISPOSE（db = null），此处直接执行写操作
    const events = emit({
      type: 'DB_EXECUTE',
      payload: { requestId: 14, statement: { sql: 'UPDATE t SET a = 1' } }
    })

    expect(events).toContainEqual({
      type: 'DB_RESULT',
      payload: { requestId: 14, success: false, message: 'Database not opened in worker' }
    })
  })

  it("process 'exit' 事件兜底清理：WAL checkpoint + close", () => {
    const db = openDb('/data/exit-event.db')

    // 手动触发被测模块在 process.on('exit') 注册的兜底清理。
    // 前提：被测模块在 beforeAll 动态 import 时注册，是该测试进程内最后一个
    // exit 监听器（参照 media-worker/worker-entry.test.ts 既有用例的做法）。
    // 不用 process.emit('exit', 0)：那会广播触发全部 exit 监听器，误伤 vitest 框架
    // 与其他模块注册的清理逻辑。
    const listeners = process.listeners('exit') as Array<(code: number) => void>
    const workerExitHandler = listeners[listeners.length - 1]
    expect(workerExitHandler).toBeTruthy()
    workerExitHandler(0)

    expect(db.pragma).toHaveBeenCalledWith('wal_checkpoint(PASSIVE)')
    expect(db.close).toHaveBeenCalledTimes(1)
  })

  it('DB_OPEN 构造器抛错 → DB_WORKER_ERROR（含 "DB_OPEN 失败"）且以退出码 1 退出', () => {
    // vitest 5：桩被 `new Database(...)` 使用，箭头实现不可构造（会先抛
    // "is not a constructor" 而不是被测代码预期捕获的原始错误）
    FakeDatabase.mockImplementation(function createFailingDatabase() {
      throw new Error('native module ABI mismatch')
    })

    const events = emit({ type: 'DB_OPEN', payload: { dbPath: '/data/broken.db' } })

    expect(events).toContainEqual({
      type: 'DB_WORKER_ERROR',
      payload: { message: 'DB_OPEN 失败: native module ABI mismatch' }
    })
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(events.some((e) => e.type === 'DB_READY')).toBe(false)
  })
})
