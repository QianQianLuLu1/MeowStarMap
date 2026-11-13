/**
 * N0.5 资产门禁：官方 EXE 内嵌服装图标包的常量、纯函数与落位校验。
 *
 * 红灯来源（资产落位前）：`../extract-nikkisync-icon-pack` 模块尚不存在，
 * 且 resources/nikkisync/pc/clothing-icons/ 下没有 manifest.json。
 * 落位后的真实资产断言用 skipIf 门控，保证无图标包的 CI 环境不会误报。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  CLOTHING_ICONS_DIR_SEGMENTS,
  ICON_PACK_EXE_SHA256,
  ICON_PACK_MANIFEST_SHA256,
  ICON_PACK_ZIP_SHA256,
  ICON_PACK_ZIP_SIZE,
  carveZipFromBuffer,
  verifyIconPackManifest
} from '../extract-nikkisync-icon-pack'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const packDir = path.join(projectRoot, ...CLOTHING_ICONS_DIR_SEGMENTS)
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

const syntheticZip = (size: number): Buffer => {
  const bytes = Buffer.alloc(size, 0x41)
  bytes.write('PK\x03\x04', 0, 'latin1')
  bytes.write('PK\x05\x06', size - 4, 'latin1')
  return bytes
}

describe('官方图标包常量（唯一真相源）', () => {
  it('EXE / ZIP / manifest 三组 SHA 与 ZIP 字节数逐值钉死', () => {
    expect(ICON_PACK_EXE_SHA256).toBe(
      '7d4aad76d9fe7355cea9d695cf7e67f32be09dfe0e4b1e9d65533953932bf250'
    )
    expect(ICON_PACK_ZIP_SHA256).toBe(
      'ddd70fbf87ebeb9722e37365a76a5d159951f1104c2e378578316e884e840b4f'
    )
    expect(ICON_PACK_MANIFEST_SHA256).toBe(
      'c39e0f672867c7ee59fe9f7865510d95a0f2bbbf6d47f56a21f9a95e134752f0'
    )
    expect(ICON_PACK_ZIP_SIZE).toBe(77678905)
  })
})

describe('carveZipFromBuffer（正常 / 异常 / 边界）', () => {
  it('正常：命中 ZIP 头且长度/SHA 匹配时返回该字节区间', () => {
    const zip = syntheticZip(512)
    const buffer = Buffer.concat([Buffer.from('PE-PREFIX'), zip, Buffer.from('TRAILER')])
    expect(carveZipFromBuffer(buffer, 512, sha256(zip))?.equals(zip)).toBe(true)
  })

  it('异常：SHA 不符时返回 undefined（不静默接受错误字节）', () => {
    const zip = syntheticZip(512)
    expect(carveZipFromBuffer(zip, 512, 'a'.repeat(64))).toBeUndefined()
  })

  it('边界：缓冲区短于期望长度、或没有 ZIP 头时返回 undefined', () => {
    expect(carveZipFromBuffer(Buffer.alloc(64), 512, 'a'.repeat(64))).toBeUndefined()
    expect(carveZipFromBuffer(Buffer.alloc(1024), 512, 'a'.repeat(64))).toBeUndefined()
  })
})

describe('verifyIconPackManifest（正常 / 异常 / 边界）', () => {
  const withTempDir = (work: (root: string) => void): void => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nikkisync-icon-pack-'))
    try {
      work(root)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
  const writeManifest = (root: string, entries: number, schemaVersion = 2): string => {
    const manifest = JSON.stringify({
      schemaVersion,
      version: 'synthetic',
      source: 'https://example.invalid',
      imageFormat: 'webp',
      entries: Array.from({ length: entries }, (_, i) => ({
        id: String(1000000000 + i),
        sha256: 'a'.repeat(64)
      })),
      effectEntries: []
    })
    fs.writeFileSync(path.join(root, 'manifest.json'), manifest)
    return sha256(manifest)
  }

  it('正常：schemaVersion 2 + webp + entries 达标 + SHA 匹配时返回条目数', () => {
    withTempDir((root) => {
      const expected = writeManifest(root, 9000)
      expect(verifyIconPackManifest(root, expected)).toBe(9000)
    })
  })

  it('异常：manifest SHA 不符或 JSON 损坏时抛错', () => {
    withTempDir((root) => {
      writeManifest(root, 9000)
      expect(() => verifyIconPackManifest(root, 'b'.repeat(64))).toThrow(/sha/i)
      fs.writeFileSync(path.join(root, 'manifest.json'), '{broken')
      expect(() => verifyIconPackManifest(root, 'b'.repeat(64))).toThrow()
    })
  })

  it('边界：entries 不足 9000 或 schemaVersion 非 2 时抛错', () => {
    withTempDir((root) => {
      const expected = writeManifest(root, 8999)
      expect(() => verifyIconPackManifest(root, expected)).toThrow(/entries/i)
      const legacy = writeManifest(root, 9000, 1)
      expect(() => verifyIconPackManifest(root, legacy)).toThrow(/schemaVersion/i)
    })
  })
})

describe('F5 图标包落盘安全（异常 / 边界）', () => {
  const withTempDir = (work: (root: string) => void): void => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nikkisync-icon-pack-f5-'))
    try {
      work(root)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
  const moduleOf = async (): Promise<Record<string, unknown>> =>
    (await import('../extract-nikkisync-icon-pack')) as unknown as Record<string, unknown>

  it('异常：manifest 条目越出包根必须抛 escapes root，不得 path.join 直读', async () => {
    const mod = await moduleOf()
    expect(typeof mod.verifySampleIcons).toBe('function')
    withTempDir((root) => {
      fs.writeFileSync(
        path.join(root, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 2,
          version: 'synthetic',
          source: 'https://example.invalid',
          imageFormat: 'webp',
          effectEntries: [],
          entries: [{ id: '1', file: '../evil.webp', sha256: 'a'.repeat(64) }]
        })
      )
      expect(() => (mod.verifySampleIcons as (r: string) => number)(root)).toThrow(/escapes root/i)
    })
  })

  it('边界：copyTree 重跑必须清掉 target 里的陈旧文件', async () => {
    const mod = await moduleOf()
    expect(typeof mod.copyTree).toBe('function')
    withTempDir((root) => {
      const src = path.join(root, 'src')
      const dest = path.join(root, 'dest')
      fs.mkdirSync(src)
      fs.mkdirSync(dest)
      fs.writeFileSync(path.join(src, 'fresh.webp'), 'new')
      fs.writeFileSync(path.join(dest, 'stale.webp'), 'old')
      ;(mod.copyTree as (s: string, d: string) => void)(src, dest)
      expect(fs.existsSync(path.join(dest, 'fresh.webp'))).toBe(true)
      expect(fs.existsSync(path.join(dest, 'stale.webp'))).toBe(false)
    })
  })

  it('边界：unzip 探测器报告不可用时回退 tar（不硬依赖系统 unzip）', async () => {
    const mod = await moduleOf()
    expect(typeof mod.resolveUnzipCommand).toBe('function')
    const resolve = mod.resolveUnzipCommand as (probe?: (command: string) => boolean) => string
    expect(resolve(() => false)).toBe('tar')
    expect(resolve(() => true)).toBe('unzip')
  })
})

describe.skipIf(!fs.existsSync(path.join(packDir, 'manifest.json')))(
  '真实服装图标包（资产落位后）',
  () => {
    it('manifest SHA 与上游 InitialManifestSha256 一致且 entries >= 9000', () => {
      const bytes = fs.readFileSync(path.join(packDir, 'manifest.json'))
      expect(sha256(bytes)).toBe(ICON_PACK_MANIFEST_SHA256)
      expect(verifyIconPackManifest(packDir, ICON_PACK_MANIFEST_SHA256)).toBeGreaterThanOrEqual(
        9000
      )
    })

    it('icons/ 与 effects/ 目录存在且非空', () => {
      for (const segment of ['icons', 'effects']) {
        const dir = path.join(packDir, segment)
        expect(fs.statSync(dir).isDirectory()).toBe(true)
        expect(fs.readdirSync(dir).length).toBeGreaterThan(0)
      }
    })
  }
)
