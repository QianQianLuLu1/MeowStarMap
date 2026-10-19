import { describe, expect, it } from 'vitest'
import { exportJpeg, exportExportMetadata } from './jpeg-export'

/**
 * 无损 JPEG 导出纯函数测试（阶段 6，移植自上游 photo-export.mjs）。
 * 断言对齐上游 local-sync-server.test.ts 的 export 契约：EXIF 注入、
 * orientation 旋转换算、raw 敏感字段隔离、像素数据不动。
 */

/** 最小可用 JPEG（SOI + 最小帧段 + SOS + EOI 的段结构即可，exportJpeg 不解码像素） */
function minimalJpeg(): Buffer {
  // SOI + APP0(JFIF) + DQT + SOF0 + DHT + SOS 头 + 2 扫描字节 + EOI
  return Buffer.from(
    'ffd8ffe000104a46494600010100000100010000' + // SOI + APP0
      'ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432' + // DQT
      'ffc0000b080001000101011100' + // SOF0 8x8
      'ffc4001f0000010501010101010100000000000000000102030405060708090a0b' + // DHT
      'ffda0008010100003f00' + // SOS
      'ffd9',
    'hex'
  )
}

describe('exportExportMetadata（协议元数据白名单化）', () => {
  it('only picks whitelisted fields and drops raw/native secrets', () => {
    const normalized = exportExportMetadata({
      schemaVersion: 1,
      identity: { uid: 'PRIVATE', gameVersion: '2.5.1' },
      capture: { capturedAt: '2026-10-11T08:09:10.000Z' },
      camera: { focalLength: 35, apertureSection: 1.2, evil: 'x' },
      raw: { nativeParamPayload: 'PRIVATE' },
      dressing: { clothes: [{ id: 'c1', name: '天鹅之梦', category: 'dresses' }] },
      filter: { name: '暖阳' },
      location: { name: '花愿小镇' }
    })
    expect(normalized.camera).toEqual({ focalLength: 35, apertureSection: 1.2 })
    expect(normalized.version).toBe('2.5.1')
    expect(normalized.capturedAt).toBe('2026-10-11T08:09:10.000Z')
    expect(normalized.filter).toBe('暖阳')
    expect(normalized.location).toBe('花愿小镇')
    expect(normalized.clothes).toEqual(['天鹅之梦'])
    expect(JSON.stringify(normalized)).not.toContain('PRIVATE')
  })

  it('degrades gracefully for missing/invalid metadata', () => {
    expect(exportExportMetadata(undefined)).toEqual({ camera: {}, clothes: [] })
    expect(exportExportMetadata({ camera: { focalLength: Number.NaN } })).toEqual({
      camera: {},
      clothes: []
    })
  })
})

describe('exportJpeg（无损 EXIF 重写）', () => {
  it('returns identical bytes when no exif and no rotation requested', () => {
    const jpeg = minimalJpeg()
    expect(exportJpeg(jpeg, {}, { exif: false, rotation: 0 })).toEqual(jpeg)
  })

  it('injects Momo Camera / Infinity Nikki / NikkiSync EXIF and keeps pixels', () => {
    const jpeg = minimalJpeg()
    const output = exportJpeg(
      jpeg,
      { capture: { capturedAt: '2026-10-11T08:09:10.000Z' } },
      { exif: true, rotation: 0 }
    )
    expect(output.includes(Buffer.from('Momo Camera'))).toBe(true)
    expect(output.includes(Buffer.from('Infinity Nikki'))).toBe(true)
    expect(output.includes(Buffer.from('NikkiSync'))).toBe(true)
    expect(output.includes(Buffer.from('2026:10:11 08:09:10'))).toBe(true)
    // 扫描数据（SOS 之后）与原文件逐字节一致（未解码/未重压缩）
    const scanOf = (b: Buffer): Buffer => b.subarray(b.indexOf(Buffer.from([0xff, 0xda])))
    expect(scanOf(output)).toEqual(scanOf(jpeg))
  })

  it('maps clockwise rotation onto the EXIF orientation tag', () => {
    const jpeg = minimalJpeg()
    const output = exportJpeg(jpeg, {}, { exif: false, rotation: 90 })
    // orientation 1 --90°顺时针--> 6；默认 TIFF 为小端序（II），tag 0x0112 的 LE 字节序
    expect(
      output.includes(Buffer.from([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00]))
    ).toBe(true)
  })

  it('round-trips an existing EXIF block without duplicating it', () => {
    const first = exportJpeg(minimalJpeg(), {}, { exif: true, rotation: 0 })
    const second = exportJpeg(first, {}, { exif: true, rotation: 90 })
    const app1Count = second
      .subarray(0, second.indexOf(Buffer.from([0xff, 0xda])))
      .reduce(
        (count, _, index) =>
          second[index] === 0xff && second[index + 1] === 0xe1 ? count + 1 : count,
        0
      )
    expect(app1Count).toBe(1)
  })

  it('rejects invalid options and non-JPEG input', () => {
    const jpeg = minimalJpeg()
    expect(() => exportJpeg(jpeg, {}, { exif: true, rotation: 91 as 90 })).toThrow('Export options')
    expect(() => exportJpeg(Buffer.from('not a jpeg'), {}, { exif: true })).toThrow('JPEG required')
  })

  it('truncates an overlong ImageDescription without leaving a partial \\u escape', () => {
    const jpeg = minimalJpeg()
    // 100 件服装（上限）×120 字符（clean 上限），第 97 项嵌入一个非 ASCII 字符：
    // 转义后 description 前缀 53 + JSON 头 24 + 96×(122+1) + 1(引号) + 110 = 11996 起，
    // \uXXXX（6 码元）恰好横跨 12000 截断点
    const clothes = Array.from({ length: 100 }, () => 'A'.repeat(120))
    clothes[96] = 'A'.repeat(110) + '中' + 'A'.repeat(9)
    const metadata = { dressing: { clothes: clothes.map((name) => ({ name })) } }

    // 构造自检：截断点必须确实落在转义内部（否则本用例没有复现目标缺陷）
    const full =
      'Infinity Nikki virtual photography; game parameters: ' +
      JSON.stringify(exportExportMetadata(metadata)).replace(
        /[^\x20-\x7e]/g,
        (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
      )
    expect(full.length).toBeGreaterThan(12000)
    expect(full.slice(0, 12000)).toMatch(/\\u[0-9a-f]{0,3}$/)

    const output = exportJpeg(jpeg, metadata, { exif: true, rotation: 0 })
    const description = readImageDescription(output)
    expect(description.length).toBeLessThanOrEqual(12000)
    // 截断只允许整段丢弃，不得产生畸形转义
    expect(full.startsWith(description)).toBe(true)
    expect(description).not.toMatch(/\\u[0-9a-f]{0,3}$/)
  })
})

/** 从导出产物回读 ImageDescription（tag 0x10e，ASCII）：定位首个 APP1/Exif → IFD0 条目 → 值区 */
function readImageDescription(output: Buffer): string {
  const app1Start = output.indexOf(Buffer.from([0xff, 0xe1]))
  expect(app1Start).toBeGreaterThan(0)
  const tiff = output.subarray(app1Start + 10) // FFE1(2) + 段长(2) + 'Exif\0\0'(6)
  const le = tiff[0] === 73
  const u16 = (p: number): number => (le ? tiff.readUInt16LE(p) : tiff.readUInt16BE(p))
  const u32 = (p: number): number => (le ? tiff.readUInt32LE(p) : tiff.readUInt32BE(p))
  const ifdOffset = u32(4)
  const count = u16(ifdOffset)
  for (let n = 0; n < count; n++) {
    const entry = ifdOffset + 2 + n * 12
    if (u16(entry) !== 0x10e) continue
    expect(u16(entry + 2)).toBe(2) // ASCII
    const size = u32(entry + 4)
    const valueOffset = size > 4 ? u32(entry + 8) : entry + 8
    return tiff.toString('ascii', valueOffset, valueOffset + size - 1) // 去尾部 NUL
  }
  throw new Error('ImageDescription not found')
}
