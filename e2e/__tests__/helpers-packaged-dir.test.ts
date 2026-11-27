/**
 * C8：packagedAppDir() 环境变量三分支契约（缺省/空串 → release/win-unpacked；
 * 相对 → 仓库根拼接；绝对 → 原样）。
 *
 * 期望值与实现用同一 path 绑定和同一 ROOT 推导（fileURLToPath，不用裸 __dirname），
 * 不触真实文件系统 ⇒ test:ci-linux 的 posix 绑定装置下两侧语义一致，不会拼出假路径。
 */
import { describe, it, expect, afterEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPackagedArtifactFreshness, packagedAppDir } from '../helpers'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENV_KEY = 'MEOWSTARMAP_E2E_PACKAGED_DIR'
const DEFAULT_DIR = path.join(ROOT_DIR, 'release', 'win-unpacked')

afterEach(() => {
  delete process.env[ENV_KEY]
})

describe('packagedAppDir 产物目录覆盖', () => {
  it('缺省：release/win-unpacked', () => {
    delete process.env[ENV_KEY]
    expect(packagedAppDir()).toBe(DEFAULT_DIR)
  })

  it('空串与纯空白：视同缺省（trim 后判空）', () => {
    process.env[ENV_KEY] = ''
    expect(packagedAppDir()).toBe(DEFAULT_DIR)
    process.env[ENV_KEY] = '   '
    expect(packagedAppDir()).toBe(DEFAULT_DIR)
  })

  it('相对路径：按仓库根解析', () => {
    process.env[ENV_KEY] = 'release-pkg/win-unpacked'
    expect(packagedAppDir()).toBe(path.join(ROOT_DIR, 'release-pkg', 'win-unpacked'))
  })

  it('相对路径两侧空白：trim 后仍按仓库根解析', () => {
    process.env[ENV_KEY] = '  release-pkg/win-unpacked  '
    expect(packagedAppDir()).toBe(path.join(ROOT_DIR, 'release-pkg', 'win-unpacked'))
  })

  it('绝对路径：原样采用，不再拼仓库根', () => {
    const absolute = path.resolve(ROOT_DIR, 'elsewhere', 'win-unpacked')
    process.env[ENV_KEY] = absolute
    expect(packagedAppDir()).toBe(absolute)
  })
})

describe('packaged artifact freshness', () => {
  it('同版本旧产物不得冒充当前源码构建', () => {
    expect(() => assertPackagedArtifactFreshness(1_000, 5_000)).toThrow(/陈旧/)
  })

  it('产物不早于源码时放行，并容忍 2 秒文件系统精度', () => {
    expect(() => assertPackagedArtifactFreshness(5_000, 5_000)).not.toThrow()
    expect(() => assertPackagedArtifactFreshness(4_500, 5_000)).not.toThrow()
  })
})
