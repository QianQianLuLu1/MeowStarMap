/**
 * N3/G6：上游 windows-app.ts 落盘的 5 个聚合诊断文件在本仓的等价实现。
 * P6（用户已明确批准）：诊断不脱敏——绝对路径/UID/sha256 全量保留，
 * 原「剔除敏感串」契约已反转，本套件钉住保留行为。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DIAGNOSTIC_FILE_NAMES, writeAggregateDiagnostic } from './diagnostic-files'

const dirs: string[] = []
const makeDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikki-diag-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('aggregate diagnostics', () => {
  it('normal: writes an allowed file with only aggregate counters', () => {
    const dir = makeDir()
    const result = writeAggregateDiagnostic(dir, 'metadata-status.json', {
      resolved: 12,
      failed: 1,
      stages: { runtimeReadyMs: 34 }
    })
    expect(result).toEqual({ ok: true })
    const written = JSON.parse(
      fs.readFileSync(path.join(dir, 'metadata-status.json'), 'utf8')
    ) as Record<string, unknown>
    expect(written.resolved).toBe(12)
    expect(written.failed).toBe(1)
  })

  it('abnormal: rejects an unknown filename (no arbitrary path writes)', () => {
    expect(() => writeAggregateDiagnostic(makeDir(), '../../evil.json', {})).toThrow(
      'Invalid diagnostic name'
    )
  })

  it('abnormal: reports a failed write instead of throwing', () => {
    const result = writeAggregateDiagnostic(
      path.join(os.tmpdir(), 'missing-dir-nikki'),
      'scan-status.json',
      {}
    )
    expect(result.ok).toBe(false)
  })

  it('boundary: preserves absolute paths, UIDs and hashes in the payload (P6 不脱敏)', () => {
    const dir = makeDir()
    const result = writeAggregateDiagnostic(dir, 'metadata-status.json', {
      resolved: 3,
      path: 'C:\\Users\\someone\\photos\\a.jpg',
      uid: '1234567890',
      sha256: 'a'.repeat(64)
    })
    expect(result).toEqual({ ok: true })
    const written = JSON.parse(
      fs.readFileSync(path.join(dir, 'metadata-status.json'), 'utf8')
    ) as Record<string, unknown>
    expect(written.resolved).toBe(3)
    expect(written.path).toBe('C:\\Users\\someone\\photos\\a.jpg')
    expect(written.uid).toBe('1234567890')
    expect(written.sha256).toBe('a'.repeat(64))
  })

  it('boundary: preserves sensitive strings in nested objects and arrays (P6 不脱敏)', () => {
    const dir = makeDir()
    const result = writeAggregateDiagnostic(dir, 'scan-status.json', {
      roots: ['D:\\Game\\GamePlayPhotos\\123456789'],
      detail: { posixPath: '/home/someone/photos', hashes: ['b'.repeat(64)] }
    })
    expect(result).toEqual({ ok: true })
    const written = JSON.parse(
      fs.readFileSync(path.join(dir, 'scan-status.json'), 'utf8')
    ) as Record<string, unknown>
    expect(written.roots).toEqual(['D:\\Game\\GamePlayPhotos\\123456789'])
    expect(written.detail).toEqual({
      posixPath: '/home/someone/photos',
      hashes: ['b'.repeat(64)]
    })
  })

  it('boundary: all five upstream filenames are declared', () => {
    expect(DIAGNOSTIC_FILE_NAMES).toEqual([
      'metadata-status.json',
      'scan-status.json',
      'startup-error.log',
      'game-discovery.log',
      'startup-service-timings.json'
    ])
  })
})
