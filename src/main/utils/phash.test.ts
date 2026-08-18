import { describe, it, expect } from 'vitest'
import { hammingDistance } from './phash'

/**
 * 仅测试 hammingDistance 纯函数；calculatePHash 依赖 sharp，不在此处覆盖
 */
describe('phash - hammingDistance', () => {
  it('两个相同 hash 距离为 0', () => {
    const h = '0000000000000000000000000000000000000000000000000000000000000000'
    expect(hammingDistance(h, h)).toBe(0)
  })

  it('完全相反的两个 hash 距离等于长度', () => {
    const h1 = '0000000000'
    const h2 = '1111111111'
    expect(hammingDistance(h1, h2)).toBe(10)
  })

  it('仅一位不同距离为 1', () => {
    const h1 = '1010101010'
    const h2 = '1010101011'
    expect(hammingDistance(h1, h2)).toBe(1)
  })

  it('长度不一致返回 -1', () => {
    expect(hammingDistance('1010', '101')).toBe(-1)
    expect(hammingDistance('1010', '10101')).toBe(-1)
  })

  it('空字符串返回 -1', () => {
    expect(hammingDistance('', '')).toBe(-1)
    expect(hammingDistance('1010', '')).toBe(-1)
  })

  it('64 位标准 pHash 长度正常工作', () => {
    const h1 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    const h2 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde0'
    expect(hammingDistance(h1, h2)).toBe(1)
  })

  it('对称性：distance(a, b) === distance(b, a)', () => {
    const h1 = '10101010'
    const h2 = '11001100'
    expect(hammingDistance(h1, h2)).toBe(hammingDistance(h2, h1))
  })

  it('64 位全 0 字符串与自身距离为 0', () => {
    const h = '0'.repeat(64)
    expect(hammingDistance(h, h)).toBe(0)
  })

  it('64 位全 1 字符串与自身距离为 0', () => {
    const h = '1'.repeat(64)
    expect(hammingDistance(h, h)).toBe(0)
  })

  it('64 位全 0 与全 1 距离等于 64', () => {
    expect(hammingDistance('0'.repeat(64), '1'.repeat(64))).toBe(64)
  })

  it('非 0/1 字符的字符串仍能按位比较（固化当前行为）', () => {
    // hammingDistance 仅做字符不等比较，不校验是否为 0/1
    expect(hammingDistance('abcdef', 'abcdef')).toBe(0)
    expect(hammingDistance('abcdef', 'abcdeg')).toBe(1)
    expect(hammingDistance('aaaa', 'bbbb')).toBe(4)
  })

  it('超长字符串（128 位）也能正常工作', () => {
    const h1 = '01'.repeat(64) // 128 位
    const h2 = '10'.repeat(64) // 完全反相
    expect(hammingDistance(h1, h2)).toBe(128)
  })

  it('单字符 hash 距离判定', () => {
    expect(hammingDistance('0', '0')).toBe(0)
    expect(hammingDistance('0', '1')).toBe(1)
  })
})
