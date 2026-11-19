import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NIKKISYNC_ALIGNED_COMMIT, NIKKISYNC_ALIGNED_VERSION } from './nikkisync-version'

describe('nikkisync-version 基准常量', () => {
  it('与基准钉子测试的 EXPECTED_HEAD 逐字一致（防漂移）', () => {
    const pinSource = readFileSync(
      join(__dirname, '../../scripts/__tests__/nikkisync-baseline-pin.test.ts'),
      'utf8'
    )
    expect(pinSource).toContain(`EXPECTED_HEAD = '${NIKKISYNC_ALIGNED_COMMIT}'`)
  })

  it('版本串为 public-beta  tag 形态且与提交对应', () => {
    expect(NIKKISYNC_ALIGNED_VERSION).toMatch(/^v\d+\.\d+\.\d+-public-beta\.\d+$/)
    expect(NIKKISYNC_ALIGNED_COMMIT).toMatch(/^[0-9a-f]{40}$/)
  })
})
