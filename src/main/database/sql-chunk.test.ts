import { describe, it, expect } from 'vitest'
import { chunkArray, SQL_IN_CHUNK_SIZE } from './sql-chunk'

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
