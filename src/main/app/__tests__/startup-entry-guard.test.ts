/**
 * @layer L3
 * @module src/main/index
 * @coverage 启动入口异常兜底接线（进程入口无法行为单测，用静态源码守卫防回退）
 * @dependencies fs / path（只读源码文本）
 *
 * 背景：src/main/index.ts 被 vitest.config.ts 列入 coverage exclude（进程入口/引导壳），
 * 没有可行的行为单测路径。此处用源码文本断言锁住三条接线：
 *   1. app.whenReady().then(...) 末尾必须有 .catch(...)
 *   2. unhandledRejection 回调必须按启动期状态升级为致命
 *   3. 启动成功路径必须标记 settled
 * 修复前三条全部不成立（whenReady 回调内 189-214 行裸奔在 try 外，异常被静默吞掉）。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const indexPath = path.resolve(process.cwd(), 'src/main/index.ts')

function readIndexSource(): string {
  expect(fs.existsSync(indexPath), `找不到启动入口源码：${indexPath}`).toBe(true)
  return fs.readFileSync(indexPath, 'utf8')
}

describe('启动入口异常兜底接线（静态源码守卫）', () => {
  it('whenReady().then(...) 链末尾必须有 .catch(...)，否则启动早期异常静默挂起', () => {
    const src = readIndexSource()
    // 允许 prettier 把 app.whenReady().then(...) 折成链式多行
    expect(src).toMatch(/\.whenReady\(\)\s*\.then\(/)
    // 修复前 index.ts 以 `})` 收尾：189-214 行不在 try 内，抛错即 unhandledRejection
    expect(src).toMatch(/\.catch\s*\(\s*\(err\)\s*=>/)
    expect(src).toContain("stage: 'index.whenReady.catch'")
  })

  it('unhandledRejection 回调必须按 settled 状态升级为致命（保留运行期不杀应用的意图）', () => {
    const src = readIndexSource()
    // 以行首 `})` 作为回调闭合，避免被 handler 内部的 `... })` 提前截断
    const match = src.match(/process\.on\('unhandledRejection'[\s\S]*?\n\}\)/)
    expect(match, '找不到 unhandledRejection 回调').not.toBeNull()
    const handler = match![0]
    expect(handler).toContain('shouldEscalateUnhandledRejection')
    expect(handler).toContain('isStartupSettled')
    expect(handler).toContain('reportEarlyFatal')
  })

  it('启动成功路径必须调用 markStartupSettled()，使运行期 rejection 不再致命', () => {
    expect(readIndexSource()).toContain('markStartupSettled()')
  })

  it('R1：单实例锁必须在动态 import Application 之前获取（消除锁竞争窗口）', () => {
    // 修复前：锁在 lifecycle.ts 内（await import('./app/application') + new Application()
    // 之后）才获取——慢机/杀软扫描首实例的数秒内，第二次双击的实例可抢先拿锁，
    // 使首实例反被判为「已有实例运行」（实例角色颠倒）。
    const src = readIndexSource()
    const lockCall = src.indexOf('acquireSingleInstanceLockOrHandleFailure()')
    const heavyImport = src.indexOf("await import('./app/application')")
    expect(lockCall, 'index.ts 未调用 acquireSingleInstanceLockOrHandleFailure').toBeGreaterThan(-1)
    expect(heavyImport, 'index.ts 缺少 Application 动态 import').toBeGreaterThan(-1)
    expect(lockCall).toBeLessThan(heavyImport)
  })

  it('R1：锁失败必须立即早退，不得继续走赢家路径（防止第二实例写 boot-ok.marker）', () => {
    // 修复前：锁失败分支 return 后控制流回到 index.ts 的 initialize() 完成段，
    // 失败实例会继续执行 markStartupSettled() 并写共享 userData 的 boot-ok.marker，
    // 污染「启动成功」诊断标记。
    const src = readIndexSource()
    const lockCall = src.indexOf('acquireSingleInstanceLockOrHandleFailure()')
    const earlyReturn = src.indexOf('if (!gotLock) return')
    // 定位「功能性写入」而非字面提及：R1 注释块自身含 boot-ok.marker 字样且位于早退
    // 行之前，朴素 indexOf 会把注释位置当写入位置（前轮遗留红灯的根因）
    const markerWrite = src.indexOf('boot-ok.marker', earlyReturn)
    expect(earlyReturn, '缺少 !gotLock 早退分支').toBeGreaterThan(-1)
    expect(markerWrite, '缺少 boot-ok.marker 写入').toBeGreaterThan(-1)
    expect(earlyReturn).toBeGreaterThan(lockCall)
    expect(earlyReturn).toBeLessThan(markerWrite)
  })

  it('B：锁获取成功后必须立即注册 second-instance ack 写入监听（先于动态 import）', () => {
    // 修复前：健康赢家运行时，输家 6s 重试耗尽后仍弹「已有实例运行」——窗口已聚焦
    // 却又弹报错，用户感知为异常。赢家在锁获取后、重模块加载（杀软扫描热点窗口）
    // 之前注册 ack 写入器，输家检测到新鲜 ack 即静默让位不弹框。
    const src = readIndexSource()
    const lockCall = src.indexOf('acquireSingleInstanceLockOrHandleFailure()')
    const ackListener = src.indexOf("app.on('second-instance', () => writeSecondInstanceAck())")
    const heavyImport = src.indexOf("await import('./app/application')")
    expect(lockCall).toBeGreaterThan(-1)
    expect(ackListener, 'index.ts 缺少 ack 写入监听注册').toBeGreaterThan(-1)
    expect(heavyImport).toBeGreaterThan(-1)
    expect(ackListener).toBeGreaterThan(lockCall)
    expect(ackListener).toBeLessThan(heavyImport)
  })
})
