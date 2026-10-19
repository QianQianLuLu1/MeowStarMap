import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_SUBCOMMANDS, buildE2eHint } from '../e2e-usage'

/**
 * e2e 误输入守卫的契约测试（scripts/AGENTS.md：核心逻辑导出供单测）。
 * 覆盖正常路径 / 异常路径 / 边界条件三类。
 * 背景：`npm run e2e : smoke`（冒号两侧带空格）时 npm 按空格切词，把脚本名解析为 e2e，
 * 只得到 npm 的 "Missing script" 无信息量报错；本守卫让裸 e2e 输出真实子命令清单并以 1 退出。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>
}

describe('package.json e2e 脚本契约', () => {
  it('正常：裸 e2e 脚本指向守卫脚本', () => {
    expect(pkg.scripts?.e2e).toBe('tsx scripts/e2e-usage.ts')
  })

  it('正常：清单里的每条命令都真实存在于 package.json（防清单漂移、防列假命令）', () => {
    expect(E2E_SUBCOMMANDS.length).toBeGreaterThan(0)
    for (const cmd of E2E_SUBCOMMANDS) {
      expect(pkg.scripts?.[cmd.name]).toBeTypeOf('string')
      expect(cmd.desc.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('buildE2eHint 文案正文', () => {
  it('正常：空 argv（npm 不转发多余参数时）仍列出全部可用命令', () => {
    const hint = buildE2eHint([])
    for (const cmd of E2E_SUBCOMMANDS) {
      expect(hint).toContain(`npm run ${cmd.name}`)
    }
    expect(hint).toContain('冒号两侧不能有空格')
  })

  it('异常：未识别的参数只给清单，不追加建议行', () => {
    const hint = buildE2eHint([':', '不存在'])
    expect(hint).toContain(`npm run ${E2E_SUBCOMMANDS[0].name}`)
    expect(hint).not.toContain('是否想运行')
  })

  it('异常：空串与 -- 等畸形 token 不抛异常，且不产生空建议', () => {
    expect(() => buildE2eHint(['--', '', '   '])).not.toThrow()
    expect(buildE2eHint(['--', '', '   '])).not.toContain('是否想运行')
  })

  it('边界：argv 只能追加建议，不得改写正文（空 argv 文案是其前缀）', () => {
    expect(buildE2eHint([':', 'smoke']).startsWith(buildE2eHint([]))).toBe(true)
  })
})

describe('buildE2eHint 建议行', () => {
  it('边界：大小写与粘连冒号都容错，统一建议 e2e:smoke', () => {
    for (const argv of [['smoke'], [':', 'SMOKE'], [':smoke']]) {
      expect(buildE2eHint(argv)).toContain('是否想运行 npm run e2e:smoke')
    }
  })

  it('边界：perf 建议 e2e:perf，不与 smoke 串台', () => {
    const hint = buildE2eHint(['perf'])
    expect(hint).toContain('是否想运行 npm run e2e:perf')
    expect(hint).not.toContain('是否想运行 npm run e2e:smoke')
  })
})
