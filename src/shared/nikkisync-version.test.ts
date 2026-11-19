import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NIKKISYNC_ALIGNED_COMMIT, NIKKISYNC_ALIGNED_VERSION } from './nikkisync-version'

// shared 测试被 src/main/tsconfig（commonjs）覆盖，不能用 import.meta；
// ci-linux 装置下 __dirname 派生路径失真（实测缺仓库根段），改经 process.cwd()（装置翻译 cwd，与既有 src 测试同口径）
describe('nikkisync-version 基准常量', () => {
  it('与基准钉子测试的 EXPECTED_HEAD 逐字一致（防漂移）', () => {
    const pinSource = readFileSync(
      join(process.cwd(), 'scripts/__tests__/nikkisync-baseline-pin.test.ts'),
      'utf8'
    )
    expect(pinSource).toContain(`EXPECTED_HEAD = '${NIKKISYNC_ALIGNED_COMMIT}'`)
  })

  it('版本串为 public-beta  tag 形态且与提交对应', () => {
    expect(NIKKISYNC_ALIGNED_VERSION).toMatch(/^v\d+\.\d+\.\d+-public-beta\.\d+$/)
    expect(NIKKISYNC_ALIGNED_COMMIT).toMatch(/^[0-9a-f]{40}$/)
  })
})
