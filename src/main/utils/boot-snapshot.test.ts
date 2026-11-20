/**
 * boot-snapshot 单测（P4 启动环境快照）
 *
 * 依赖声明：vitest + 被测模块（boot-id / forensics-dir 叶子）
 * 启动说明：npx vitest run src/main/utils/boot-snapshot.test.ts
 * 错误处理：取证根解析失败 ⇒ 字段 null，不抛错（fail-open）
 * 参数校验：input 可选；缺省 switches=[] / userData=null
 * 基础测试用例：正常（全字段）/ 边界（无入参）/ 异常（字段在场不抛）
 */
import { describe, it, expect } from 'vitest'
import { buildBootSnapshot } from './boot-snapshot'
import { BOOT_ID } from './boot-id'

describe('boot-snapshot', () => {
  it('正常：含 argv/env/开关/bootId/pid/userData', () => {
    const snap = buildBootSnapshot({
      userDataPath: 'C:/ud',
      appliedSwitches: ['enable-logging=file']
    })
    expect(snap.bootId).toBe(BOOT_ID)
    expect(snap.pid).toBe(process.pid)
    expect(snap.argv).toEqual(process.argv)
    expect(snap.appliedSwitches).toEqual(['enable-logging=file'])
    expect(snap.userData).toBe('C:/ud')
    const env = snap.env as Record<string, string>
    expect(Object.keys(env).some((k) => k.toUpperCase() === 'PATH')).toBe(true)
  })

  it('边界：无入参 ⇒ switches 空数组、userData null，不抛', () => {
    const snap = buildBootSnapshot()
    expect(snap.appliedSwitches).toEqual([])
    expect(snap.userData).toBeNull()
  })

  it('异常：取证根字段在场（解析失败时为 null），不抛错', () => {
    const snap = buildBootSnapshot()
    expect('forensicsRoot' in snap).toBe(true)
    expect('forensicsSource' in snap).toBe(true)
  })
})
