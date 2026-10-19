import { describe, it, expect } from 'vitest'

import {
  decideNikkiSyncGate,
  formatNikkiSyncStateDiagnostic,
  isUpstreamDbTouched,
  type DbSnapshot
} from '../nikkisync-guard'

/**
 * nikkisync-guard 纯函数单测。
 *
 * 背景见 docs/plans/2026-10-19-fix-e2e-smoke-nikkisync-links.md：
 * `npm install` 会剪掉 `node_modules/@nikkisync/*` junction（它们不是声明依赖），于是
 * `hasNikkiSyncLink()` 为 false、`runtime-manager.start()` 直接置 `state='unavailable'`。
 * 这是 src/main/nikkisync/AGENTS.md §6 明确支持的默认态——「不得把环境缺失伪装成逻辑失败」，
 * 但 N 套件此前没有按约定做门控，于是本机每次装完依赖都会把 e2e:smoke 报成
 * 「启动链没跑或抛错逃逸」，而主进程日志里其实已给出 `npm run link:nikkisync` 的指引。
 *
 * 本模块只做判定、不做修复：未建链 ⇒ skip 且 reason 必须可直接执行；
 * 已建链 ⇒ 一律继续断言（此时的 unavailable 是真实缺陷，绝不放行）。
 */

describe('decideNikkiSyncGate：未建链门控', () => {
  it('正常：已建链时继续执行，不做任何降级', () => {
    expect(decideNikkiSyncGate({ linked: true }).action).toBe('run')
  })

  it('异常：未建链时判为 skip，且 reason 同时给出两条可执行修复命令', () => {
    const decision = decideNikkiSyncGate({ linked: false })
    expect(decision.action).toBe('skip')
    expect(decision.reason).toContain('npm run link:nikkisync')
    expect(decision.reason).toContain('npm run verify:nikkisync')
  })

  it('边界：falsy 但非布尔的 linked 一律按未建链处理（宁可 skip 不误报）', () => {
    for (const linked of [undefined, null, 0, ''] as unknown as boolean[]) {
      expect(decideNikkiSyncGate({ linked }).action).toBe('skip')
    }
  })

  it('边界：skip reason 不得只说「环境缺失」，必须点名是 @nikkisync 链接', () => {
    expect(decideNikkiSyncGate({ linked: false }).reason).toContain('@nikkisync')
  })
})

describe('formatNikkiSyncStateDiagnostic：失败文案携带真实读数', () => {
  it('正常：state / linkReady / hint 三项原样出现在单行文案里', () => {
    const line = formatNikkiSyncStateDiagnostic({
      state: 'unavailable',
      linkReady: false,
      hint: 'the @nikkisync/* links are not ready; run `npm run link:nikkisync`'
    })
    expect(line).toContain('state=unavailable')
    expect(line).toContain('linkReady=false')
    expect(line).toContain('npm run link:nikkisync')
    expect(line.split('\n')).toHaveLength(1)
  })

  it('异常：running 且 linkReady=true 时也给出读数（供成功路径留档，不吞字段）', () => {
    const line = formatNikkiSyncStateDiagnostic({ state: 'running', linkReady: true })
    expect(line).toContain('state=running')
    expect(line).toContain('linkReady=true')
    expect(line).toContain('hint=none')
  })

  it('边界：hint 缺省 / 空串 / 非字符串一律打 hint=none，不得拼出 undefined', () => {
    expect(formatNikkiSyncStateDiagnostic({ state: 'idle', linkReady: true })).toContain(
      'hint=none'
    )
    expect(formatNikkiSyncStateDiagnostic({ state: 'idle', linkReady: true, hint: '' })).toContain(
      'hint=none'
    )
    expect(
      formatNikkiSyncStateDiagnostic({
        state: 'idle',
        linkReady: true,
        hint: undefined as unknown as string
      })
    ).not.toContain('undefined')
  })

  it('边界：state 缺省时打 state=<none>，不输出 undefined 字样', () => {
    const line = formatNikkiSyncStateDiagnostic({
      state: undefined as unknown as string,
      linkReady: false
    })
    expect(line).toContain('state=<none>')
    expect(line).not.toContain('undefined')
  })
})

describe('isUpstreamDbTouched：本次运行是否改动了上游默认库', () => {
  const snap = (exists: boolean, mtimeMs: number, sizeBytes: number): DbSnapshot => ({
    exists,
    mtimeMs,
    sizeBytes
  })

  it('正常：两侧都不存在 ⇒ 未触碰', () => {
    expect(isUpstreamDbTouched(snap(false, 0, 0), snap(false, 0, 0))).toBe(false)
  })

  it('正常：机器上本就有上游独立 exe 写的库，且本次运行没动它 ⇒ 未触碰', () => {
    // 本机既有状态：%LOCALAPPDATA%/NikkiSync/nikkisync.sqlite 长期存在，
    // 旧断言据此恒判红；改造后的判据只看「本次运行有没有改它」
    const before = snap(true, 1_753_000_000_000, 11_894_784)
    expect(isUpstreamDbTouched(before, snap(true, 1_753_000_000_000, 11_894_784))).toBe(false)
  })

  it('正常：同一引用比较仍判未触碰（不因引用相等而跳过读数）', () => {
    const both = snap(true, 1, 2)
    expect(isUpstreamDbTouched(both, both)).toBe(false)
  })

  it('正常：exists 为 true 但 sizeBytes 为 0（上游空库）仍按读数比较', () => {
    expect(isUpstreamDbTouched(snap(true, 5, 0), snap(true, 5, 0))).toBe(false)
    expect(isUpstreamDbTouched(snap(true, 5, 0), snap(true, 6, 0))).toBe(true)
  })

  it('异常：运行前不存在、运行后出现 ⇒ 本次写入', () => {
    expect(isUpstreamDbTouched(snap(false, 0, 0), snap(true, 1_753_000_999_000, 4096))).toBe(true)
  })

  it('异常：运行前存在、运行后消失 ⇒ 本次删除同样算触碰', () => {
    expect(isUpstreamDbTouched(snap(true, 1, 4096), snap(false, 0, 0))).toBe(true)
  })

  it('异常：mtime 变 ⇒ 被写过', () => {
    expect(isUpstreamDbTouched(snap(true, 1000, 4096), snap(true, 1001, 4096))).toBe(true)
  })

  it('异常：size 变 ⇒ 被写过', () => {
    expect(isUpstreamDbTouched(snap(true, 1000, 4096), snap(true, 1000, 8192))).toBe(true)
  })

  it('边界：非对象入参抛 TypeError（判据函数不猜，不静默放行）', () => {
    for (const bad of [undefined, null, 'x', 42] as unknown as DbSnapshot[]) {
      expect(() => isUpstreamDbTouched(bad, snap(false, 0, 0))).toThrow(TypeError)
      expect(() => isUpstreamDbTouched(snap(false, 0, 0), bad)).toThrow(TypeError)
    }
  })

  it('边界：字段缺失或 NaN 抛 TypeError', () => {
    const missing = { exists: true } as unknown as DbSnapshot
    const nan = snap(true, Number.NaN, 4096)
    expect(() => isUpstreamDbTouched(missing, missing)).toThrow(TypeError)
    expect(() => isUpstreamDbTouched(nan, nan)).toThrow(TypeError)
    expect(() => isUpstreamDbTouched(snap(true, 1, Number.NaN), snap(true, 1, 2))).toThrow(
      TypeError
    )
  })
})
