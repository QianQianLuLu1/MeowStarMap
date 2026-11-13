/**
 * N3/G6 红灯来源：diagnostic-files.ts 尚不存在。
 * 上游 windows-app.ts 会落 5 个聚合诊断文件；本仓只有 IPC 快照、无落盘。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DIAGNOSTIC_FILE_NAMES,
  sanitizeAggregate,
  writeAggregateDiagnostic
} from './diagnostic-files'

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

  it('boundary: strips absolute paths, UIDs and hashes from the payload', () => {
    const clean = sanitizeAggregate({
      resolved: 3,
      path: 'C:\\Users\\someone\\photos\\a.jpg',
      uid: '1234567890',
      sha256: 'a'.repeat(64)
    })
    expect(clean.resolved).toBe(3)
    expect(JSON.stringify(clean)).not.toContain('C:\\Users')
    expect(JSON.stringify(clean)).not.toContain('1234567890')
    expect(JSON.stringify(clean)).not.toContain('a'.repeat(64))
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
