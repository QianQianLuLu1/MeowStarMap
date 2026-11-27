/**
 * exifr 低层读取封装的句柄生命周期回归。
 *
 * FsReader 在首次 stat/read 失败时尚未被 Exifr.read 赋给 reader.file，
 * 封装必须在该读取器启动前取得所有权，才能覆盖这类早期失败路径。
 */
import fs from 'fs'
import type { FileHandle } from 'fs/promises'
import { createRequire } from 'module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseExifFile } from './exif-file'

/**
 * exifr 是外部化 CJS，内部的 `require('fs')` 拿的是真内置单例；
 * CI 宿主模拟装置只 mock 测试图里的 `fs`，桩只打在那边会落空（装置轴 4 的已知边界）。
 * 两侧都打，正常宿主上二者同一对象，仅多一次幂等 spy。
 */
const hostFs = createRequire(import.meta.url)('fs') as typeof fs

function mockOpen(fileHandle: unknown) {
  // 真正被 exifr 调用的是真内置单例这一份，返回值也应是它（断言调用参数才作数）
  const mocked = vi.spyOn(hostFs.promises, 'open').mockResolvedValue(fileHandle as FileHandle)
  if (hostFs.promises !== fs.promises) {
    vi.spyOn(fs.promises, 'open').mockResolvedValue(fileHandle as FileHandle)
  }
  return mocked
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseExifFile 文件句柄生命周期', () => {
  it('异常：fs.open 成功后 fh.stat 拒绝，仍关闭已打开句柄', async () => {
    const statError = new Error('stat failed')
    const close = vi.fn(async () => undefined)
    const open = mockOpen({
      stat: vi.fn().mockRejectedValue(statError),
      close
    })

    await expect(parseExifFile('C:\\photos\\broken.jpg')).rejects.toBe(statError)

    expect(open).toHaveBeenCalledWith('C:\\photos\\broken.jpg', 'r')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('异常：fs.open 成功后首块读取拒绝，仍关闭已打开句柄', async () => {
    const readError = new Error('read failed')
    const close = vi.fn(async () => undefined)
    mockOpen({
      stat: vi.fn().mockResolvedValue({ size: 64 }),
      read: vi.fn().mockRejectedValue(readError),
      close
    })

    await expect(parseExifFile('C:\\photos\\broken.jpg')).rejects.toBe(readError)

    expect(close).toHaveBeenCalledTimes(1)
  })

  it('正常：解析成功只关闭底层句柄一次', async () => {
    const tiff = Buffer.from([
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    ])
    const close = vi.fn(async () => undefined)
    const read = vi.fn(
      async (target: ArrayBufferView, offset: number, length: number, position: number) => {
        const bytes = tiff.subarray(position, position + length)
        new Uint8Array(target.buffer, target.byteOffset, target.byteLength).set(bytes)
        return { bytesRead: bytes.byteLength, buffer: target }
      }
    )
    mockOpen({
      stat: vi.fn().mockResolvedValue({ size: tiff.byteLength }),
      read,
      close
    })

    await expect(parseExifFile('C:\\photos\\empty.tif')).resolves.toBeNull()

    expect(close).toHaveBeenCalledTimes(1)
  })
})
