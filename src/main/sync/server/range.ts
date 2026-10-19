/**
 * Range 请求头解析 — NikkiSync 协议仅支持单区间（语义照上游 LocalSyncServer.parseRange）。
 *
 * 返回值：
 * - undefined：无/空 Range 头 → 200 全量
 * - {start, end}：单区间 `bytes=A-B` / `bytes=A-` / `bytes=-N`（后缀）；
 *   end 越界钳制到 size-1 → 206
 * - null：多区间（含逗号）、非法格式、start>=size、end<start → 416
 */

export interface ByteRange {
  start: number
  end: number
}

export type ParsedRange = ByteRange | null | undefined

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/

export function parseRangeHeader(value: string | undefined, size: number): ParsedRange {
  if (!value) return undefined
  const match = value.trim().match(RANGE_PATTERN)
  if (!match) return null
  const startText = match[1] ?? ''
  const endText = match[2] ?? ''
  if (startText === '' && endText === '') return null

  let start: number
  let end: number
  if (startText === '') {
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startText)
    end = endText === '' ? size - 1 : Number(endText)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
  if (start < 0 || end < start || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}
