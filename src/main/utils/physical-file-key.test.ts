import { describe, it, expect } from 'vitest'
import { dedupeByPhysicalFile, statPhysicalFile, type PhysicalFileKey } from './physical-file-key'

interface Row {
  id: number
  file_path: string
}

const row = (id: number, file_path: string): Row => ({ id, file_path })

/** 注入式 stat 桩：路径 → 物理身份，未登记的路径视为 stat 失败（返回 null） */
function statStub(map: Record<string, PhysicalFileKey>) {
  return (p: string): PhysicalFileKey | null => map[p] ?? null
}

const DEV = 2686564740
const INO_A = 281474977187906
const INO_B = 281474977187907

describe('statPhysicalFile', () => {
  it('路径不存在时返回 null（fail-open，不抛错）', () => {
    expect(statPhysicalFile('/definitely/not/exist/hard-link-probe')).toBeNull()
  })

  it('路径为空串或非字符串时返回 null，不调用 statSync', () => {
    expect(statPhysicalFile('')).toBeNull()
    expect(statPhysicalFile(undefined as unknown as string)).toBeNull()
  })
})

describe('dedupeByPhysicalFile', () => {
  it('正常：不同物理文件全部保留', () => {
    const rows = [row(1, '/a'), row(2, '/b')]
    const stat = statStub({ '/a': { dev: DEV, ino: INO_A }, '/b': { dev: DEV, ino: INO_B } })
    expect(dedupeByPhysicalFile(rows, stat)).toEqual(rows)
  })

  it('正常：同一物理文件（硬链接）只保留 id 较小的一行', () => {
    const rows = [row(7, '/hard-link-b'), row(3, '/hard-link-a')]
    const stat = statStub({
      '/hard-link-a': { dev: DEV, ino: INO_A },
      '/hard-link-b': { dev: DEV, ino: INO_A }
    })
    expect(dedupeByPhysicalFile(rows, stat)).toEqual([row(3, '/hard-link-a')])
  })

  it('异常：stat 失败的行一律保留，不参与去重', () => {
    const rows = [row(1, '/gone-1'), row(2, '/gone-2')]
    const stat = statStub({})
    expect(dedupeByPhysicalFile(rows, stat)).toEqual(rows)
  })

  it('异常：stat 失败的行不影响其余行的正常去重', () => {
    const rows = [row(1, '/same-a'), row(2, '/same-b'), row(3, '/gone')]
    const stat = statStub({
      '/same-a': { dev: DEV, ino: INO_A },
      '/same-b': { dev: DEV, ino: INO_A }
    })
    expect(dedupeByPhysicalFile(rows, stat)).toEqual([row(1, '/same-a'), row(3, '/gone')])
  })

  it('边界：空数组与单元素数组原样返回', () => {
    const stat = statStub({})
    expect(dedupeByPhysicalFile([], stat)).toEqual([])
    expect(dedupeByPhysicalFile([row(1, '/a')], stat)).toEqual([row(1, '/a')])
  })

  it('边界：file_path 为空串/undefined 的行保留且不崩', () => {
    const rows = [row(1, ''), row(2, undefined as unknown as string), row(3, '/a')]
    const stat = statStub({ '/a': { dev: DEV, ino: INO_A } })
    expect(dedupeByPhysicalFile(rows, stat)).toEqual(rows)
  })

  it('边界：三行同一物理文件只保留 id 最小的一行', () => {
    const rows = [row(9, '/hq'), row(2, '/screenshot'), row(5, '/video')]
    const stat = statStub({
      '/hq': { dev: DEV, ino: INO_A },
      '/screenshot': { dev: DEV, ino: INO_A },
      '/video': { dev: DEV, ino: INO_A }
    })
    expect(dedupeByPhysicalFile(rows, stat)).toEqual([row(2, '/screenshot')])
  })

  it('边界：不同设备的相同 inode 视为不同物理文件', () => {
    const rows = [row(1, '/dev-a'), row(2, '/dev-b')]
    const stat = statStub({
      '/dev-a': { dev: DEV, ino: INO_A },
      '/dev-b': { dev: DEV + 1, ino: INO_A }
    })
    expect(dedupeByPhysicalFile(rows, stat)).toEqual(rows)
  })

  it('边界：文件系统不返回文件索引号（exFAT/FAT/网络盘 ino=0）时不得把不同文件误并为一行', () => {
    // NTFS 之外的卷不提供文件索引号，同卷所有文件的 ino 恒为同一退化值；若采信它，
    // 整卷会被并成一行，markDuplicatesInWorker 随即命中 rows.length < 2 清空重复标记。
    const rows = [row(1, '/vol-a/x.jpg'), row(2, '/vol-a/y.jpg')]
    const stat = statStub({
      '/vol-a/x.jpg': { dev: DEV, ino: 0 },
      '/vol-a/y.jpg': { dev: DEV, ino: 0 }
    })
    // 身份不可辨 ⇒ 两行都保留（宁可少去重，不可误删候选）
    expect(dedupeByPhysicalFile(rows, stat)).toEqual(rows)
  })

  it('默认 stat 为 statPhysicalFile（真实 fs），不存在路径的行被保留', () => {
    const rows = [row(1, '/no/such/file-a'), row(2, '/no/such/file-b')]
    expect(dedupeByPhysicalFile(rows)).toEqual(rows)
  })
})
