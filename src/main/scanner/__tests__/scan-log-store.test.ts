import { describe, it, expect, beforeEach } from 'vitest'
import {
  scanLogStore,
  classifyFsError,
  __resetScanLogStore,
  type ScanLogKind
} from '../scan-log-store'

beforeEach(() => {
  __resetScanLogStore()
})

describe('scanLogStore', () => {
  it('startRun 清空历史并重置自增 id', () => {
    scanLogStore.append({ stage: 'A', message: 'm1' })
    scanLogStore.startRun()
    expect(scanLogStore.getEntries()).toHaveLength(0)
    scanLogStore.append({ stage: 'B', message: 'm2' })
    expect(scanLogStore.getEntries()[0].id).toBe(1)
  })

  it('append 顺序追加并自动补全 ts/id/level/kind 默认值', () => {
    scanLogStore.append({ stage: '启动', message: '开始' })
    scanLogStore.append({ stage: '注册表1', message: '读取', level: 'warn', kind: 'permission' })
    const entries = scanLogStore.getEntries()
    expect(entries).toHaveLength(2)
    expect(entries[0].id).toBe(1)
    expect(entries[0].level).toBe('info')
    expect(entries[0].kind).toBe('other')
    expect(entries[1].level).toBe('warn')
    expect(entries[1].kind).toBe('permission')
    expect(typeof entries[0].ts).toBe('number')
  })

  it('append 非法 level/kind 回退为默认', () => {
    scanLogStore.append({
      stage: 'x',
      message: 'y',
      level: 'BAD' as 'info',
      kind: 'BAD' as ScanLogKind
    })
    const e = scanLogStore.getEntries()[0]
    expect(e.level).toBe('info')
    expect(e.kind).toBe('other')
  })

  it('getEntriesSince 仅返回 id 大于 since 的条目', () => {
    scanLogStore.append({ stage: 'A', message: 'a' })
    scanLogStore.append({ stage: 'B', message: 'b' })
    scanLogStore.append({ stage: 'C', message: 'c' })
    const since2 = scanLogStore.getEntriesSince(2)
    expect(since2.map((e) => e.stage)).toEqual(['C'])
  })

  it('ring buffer 超过 2000 条时丢弃最旧', () => {
    for (let i = 0; i < 2005; i++) scanLogStore.append({ stage: 'S', message: String(i) })
    const entries = scanLogStore.getEntries()
    expect(entries).toHaveLength(2000)
    // 最早保留的应是第 6 条（2005-2000+1）
    expect(entries[0].message).toBe('5')
  })

  it('clear 清空但保留后续自增连续性', () => {
    scanLogStore.append({ stage: 'A', message: 'a' })
    scanLogStore.clear()
    expect(scanLogStore.getEntries()).toHaveLength(0)
    scanLogStore.append({ stage: 'B', message: 'b' })
    // clear 重置了 nextId
    expect(scanLogStore.getEntries()[0].id).toBe(1)
  })
})

describe('classifyFsError', () => {
  it('ENOENT → path-missing', () => {
    expect(classifyFsError({ code: 'ENOENT' })).toBe('path-missing')
  })
  it('EACCES/EPERM → permission', () => {
    expect(classifyFsError({ code: 'EACCES' })).toBe('permission')
    expect(classifyFsError({ code: 'EPERM' })).toBe('permission')
  })
  it('其他/无 code → other', () => {
    expect(classifyFsError({ code: 'ENOTEMPTY' })).toBe('other')
    expect(classifyFsError(new Error('boom'))).toBe('other')
    expect(classifyFsError(null)).toBe('other')
  })
})
