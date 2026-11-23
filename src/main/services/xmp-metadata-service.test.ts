/**
 * @layer L2
 * @module src/main/services/xmp-metadata-service
 * @coverage readMetadataFromFile：正常解析 wxnn:EditorData / 解析异常仍释放文件句柄 / 非图片短路
 * @dependencies exifr（低层 Exifr 桩）、sharp 桩、i18n 桩、logger 桩
 * @remarks 回归背景：exifr 7 的高层 parse(filePath) 只在成功路径关闭内部 FileHandle，
 *          解析抛错（损坏/截断图片）时句柄泄漏；Node 26 起 GC 回收未关闭的 FileHandle
 *          会升级为未捕获异常（ERR_INVALID_STATE），表现为进程退出码非 0。
 *          故此处用 close 调用断言锁定「异常路径也必须释放句柄」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  read: vi.fn(async () => undefined),
  parse: vi.fn(async (): Promise<unknown> => null)
}))

vi.mock('sharp', () => ({ default: vi.fn() }))

vi.mock('../i18n', () => ({ t: (key: string) => key }))

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

vi.mock('exifr', () => {
  class Exifr {
    file = { close: h.close }
    read = h.read
    parse = h.parse
  }
  return { default: { Exifr }, Exifr }
})

import { readMetadataFromFile } from './xmp-metadata-service'
import { EDITOR_METADATA_SCHEMA_VERSION } from '../../shared/types/editor-metadata'

describe('readMetadataFromFile', () => {
  beforeEach(() => {
    h.close.mockClear()
    h.read.mockClear()
    h.parse.mockReset()
  })

  it('正常：解析 wxnn:EditorData 并释放句柄', async () => {
    const metadata = {
      schemaVersion: EDITOR_METADATA_SCHEMA_VERSION,
      appVersion: '2.5.7',
      exportTimestamp: '2026-11-23T00:00:00.000Z',
      params: {},
      filter: null,
      filterIntensity: 0,
      watermark: null
    }
    h.parse.mockResolvedValueOnce({
      _xmp: { 'wxnn:EditorData': Buffer.from(JSON.stringify(metadata)).toString('base64') }
    })

    const result = await readMetadataFromFile('C:\\photos\\a.jpg')

    expect(result).toEqual(metadata)
    expect(h.read).toHaveBeenCalledWith('C:\\photos\\a.jpg')
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('异常：解析抛错时返回 null 且仍关闭句柄（回归：FileHandle 泄漏）', async () => {
    h.parse.mockRejectedValueOnce(new Error('corrupt jpeg'))

    const result = await readMetadataFromFile('C:\\photos\\broken.jpg')

    expect(result).toBeNull()
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('边界：非图片扩展名短路，不创建读取器', async () => {
    const result = await readMetadataFromFile('C:\\photos\\a.txt')

    expect(result).toBeNull()
    expect(h.read).not.toHaveBeenCalled()
    expect(h.close).not.toHaveBeenCalled()
  })
})
