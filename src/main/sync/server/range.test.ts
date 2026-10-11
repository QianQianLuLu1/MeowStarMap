import { describe, expect, it } from 'vitest'
import { parseRangeHeader } from './range'

/**
 * Range 头解析（照上游 LocalSyncServer.parseRange 语义）：
 * - 仅支持单区间 `bytes=A-B` / `bytes=A-` / `bytes=-N`
 * - 多区间/非法格式 → null（416）
 * - start >= size 或 end < start → null（416）
 * - end 越界钳制到 size-1；无 Range 头 → undefined（200 全量）
 */
describe('parseRangeHeader', () => {
  const SIZE = 20

  it('returns undefined when the header is absent or empty', () => {
    expect(parseRangeHeader(undefined, SIZE)).toBeUndefined()
    expect(parseRangeHeader('', SIZE)).toBeUndefined()
  })

  it('parses a closed range bytes=A-B', () => {
    expect(parseRangeHeader('bytes=2-5', SIZE)).toEqual({ start: 2, end: 5 })
    expect(parseRangeHeader('bytes=0-0', SIZE)).toEqual({ start: 0, end: 0 })
    expect(parseRangeHeader('bytes=0-19', SIZE)).toEqual({ start: 0, end: 19 })
  })

  it('parses an open-ended range bytes=A- and clamps end to size-1', () => {
    expect(parseRangeHeader('bytes=18-', SIZE)).toEqual({ start: 18, end: 19 })
    expect(parseRangeHeader('bytes=0-', SIZE)).toEqual({ start: 0, end: 19 })
    expect(parseRangeHeader('bytes=5-999999', SIZE)).toEqual({ start: 5, end: 19 })
  })

  it('parses a suffix range bytes=-N', () => {
    expect(parseRangeHeader('bytes=-5', SIZE)).toEqual({ start: 15, end: 19 })
    expect(parseRangeHeader('bytes=-100', SIZE)).toEqual({ start: 0, end: 19 })
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseRangeHeader(' bytes=2-5 ', SIZE)).toEqual({ start: 2, end: 5 })
  })

  it('rejects multi-range and malformed values as unsatisfiable', () => {
    expect(parseRangeHeader('bytes=0-1,3-4', SIZE)).toBeNull()
    expect(parseRangeHeader('bytes=abc', SIZE)).toBeNull()
    expect(parseRangeHeader('bytes=-', SIZE)).toBeNull()
    expect(parseRangeHeader('items=0-5', SIZE)).toBeNull()
    expect(parseRangeHeader('bytes=-0', SIZE)).toBeNull()
  })

  it('rejects unsatisfiable ranges', () => {
    expect(parseRangeHeader('bytes=20-', SIZE)).toBeNull() // start >= size
    expect(parseRangeHeader('bytes=25-30', SIZE)).toBeNull()
    expect(parseRangeHeader('bytes=10-5', SIZE)).toBeNull() // end < start
  })

  it('handles a zero-length resource', () => {
    expect(parseRangeHeader('bytes=0-', 0)).toBeNull()
    expect(parseRangeHeader('bytes=-1', 0)).toBeNull()
  })
})
