import { describe, it, expect } from 'vitest'
import {
  chunkArray,
  SQL_IN_CHUNK_SIZE,
  SQLITE_MAX_VARIABLE_NUMBER,
  SQL_IN_HEADROOM,
  SQL_IN_SAFE_CEILING,
  assertChunkSize
} from './sql-chunk'

describe('chunkArray', () => {
  it('空数组返回空数组', () => {
    expect(chunkArray([])).toEqual([])
  })

  it('少于一片时原样返回单片', () => {
    expect(chunkArray([1, 2, 3], 5)).toEqual([[1, 2, 3]])
  })

  it('整除时均分', () => {
    expect(chunkArray([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4]
    ])
  })

  it('不整除时余数单独成片', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('默认片大小为 500，2000 个元素切成 4 片', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => i)
    const chunks = chunkArray(ids)
    expect(SQL_IN_CHUNK_SIZE).toBe(500)
    expect(chunks).toHaveLength(4)
    expect(chunks.every((c) => c.length === 500)).toBe(true)
    expect(chunks.flat()).toEqual(ids)
  })

  it('不修改入参', () => {
    const ids = [1, 2, 3]
    chunkArray(ids, 2)
    expect(ids).toEqual([1, 2, 3])
  })

  it('size 非正整数时抛错', () => {
    expect(() => chunkArray([1], 0)).toThrow(/正整数/)
    expect(() => chunkArray([1], -1)).toThrow(/正整数/)
    expect(() => chunkArray([1], 1.5)).toThrow(/正整数/)
  })
})

describe('SQLITE 变量上限不变量', () => {
  it('常量关系：分片安全天花板 < SQLITE 变量上限，且为额外绑定参数留余量', () => {
    expect(SQLITE_MAX_VARIABLE_NUMBER).toBe(999)
    expect(SQL_IN_HEADROOM).toBeGreaterThan(0)
    expect(SQL_IN_SAFE_CEILING).toBeLessThan(SQLITE_MAX_VARIABLE_NUMBER)
    expect(SQL_IN_SAFE_CEILING).toBe(SQLITE_MAX_VARIABLE_NUMBER - SQL_IN_HEADROOM)
  })

  it('SQL_IN_CHUNK_SIZE 严格低于安全天花板（既存分片永不触 999 上限）', () => {
    expect(SQL_IN_CHUNK_SIZE).toBeLessThan(SQL_IN_SAFE_CEILING)
  })

  it('assertChunkSize 接受正整数且不超过天花板', () => {
    expect(() => assertChunkSize(1)).not.toThrow()
    expect(() => assertChunkSize(SQL_IN_SAFE_CEILING)).not.toThrow()
  })

  it('assertChunkSize 在超过安全天花板时 fail-fast 抛错（阻断把单条 IN 推过 999 上限）', () => {
    expect(() => assertChunkSize(SQL_IN_SAFE_CEILING + 1)).toThrow(/安全上限/)
    expect(() => assertChunkSize(SQLITE_MAX_VARIABLE_NUMBER)).toThrow(/安全上限/)
    // 模拟极端场景：整页 B-tree 行数超 999 时，若误把分片设为整页大小会被立即拦截
    expect(() => assertChunkSize(1000)).toThrow(/安全上限/)
  })

  it('chunkArray 经 assertChunkSize 守卫，超过天花板直接抛错而非生成越界分片', () => {
    expect(() => chunkArray([1, 2, 3], SQL_IN_SAFE_CEILING + 1)).toThrow(/安全上限/)
  })
})
