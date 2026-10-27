import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 审计配置契约测试：保证 audit-ci.jsonc / package.json / .github/workflows/build.yml /
 * .npmrc 四处与"本地与 CI 共用同一份审计配置（唯一事实来源）"的约定不漂移。
 * 背景与计划见 docs/archive/plans/2026-09-26-npm-audit-mirror-bypass.md（已归档，不入仓）、
 * docs/troubleshooting-npm-audit-mirror.md。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const OFFICIAL_REGISTRY = 'https://registry.npmjs.org'
// GHSA 编号：GHSA- 前缀 + 3 组 4 位小写字母/数字
const GHSA_PATTERN = /^GHSA(-[a-z0-9]{4}){3}$/
// npm 包名（简化校验）：可选 @scope/ 前缀 + 小写包名段
const NPM_NAME_PATTERN = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/**
 * 迁移基线：2026-09-26 自 build.yml@ebb2044 内联 allowlist 迁入 audit-ci.jsonc 的 28 项豁免。
 * 这是"子集"断言而非"相等"断言：未来新增豁免只需改 jsonc；若要移除基线项（豁免清退），
 * 必须同步修改本基线，作为一次显式的评审动作。
 */
const MIGRATION_BASELINE: readonly string[] = [
  'GHSA-23hp-3jrh-7fpw',
  'GHSA-34x7-hfp2-rc4v',
  'GHSA-8qq5-rm4j-mr97',
  'GHSA-83g3-92jg-28cx',
  'GHSA-qffp-2rhf-9h96',
  'GHSA-9ppj-qmqm-q256',
  'GHSA-r6q2-hw4h-h46w',
  'GHSA-8x88-c5mf-7j5w',
  'GHSA-r292-9mhp-454m',
  'GHSA-52v5-jr5w-gjxr',
  'GHSA-9f4c-93c8-jc8g',
  'GHSA-5xrq-8626-4rwp',
  'GHSA-fx2h-pf6j-xcff',
  'GHSA-2v37-7h3g-55p8',
  'GHSA-3jxr-9vmj-r5cp',
  'GHSA-4cwx-7wf7-3272',
  'GHSA-5j98-mcp5-4vw2',
  'GHSA-5jgf-p345-68v8',
  'GHSA-5p4m-2wfm-xmqj',
  'GHSA-73wf-gq98-2v4g',
  'GHSA-7p8r-x3mc-p8w7',
  'GHSA-c83g-rgw3-j3cx',
  'GHSA-f65p-4m7j-42xc',
  'GHSA-fph4-wmhf-6fwf',
  'GHSA-jqff-g426-hqxp',
  'GHSA-mh99-v99m-4gvg',
  'GHSA-mwp4-54f8-5fhr',
  'GHSA-rgw5-rvv9-x895'
]

/** 剥离 JSONC 注释；跳过字符串字面量内部，保证 URL 中的 // 与块注释样式字符串内容不被误删。 */
export function stripJsoncComments(input: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < input.length) {
    const ch = input.charAt(i)
    if (inString) {
      out += ch
      if (ch === '\\') {
        // 转义序列：连同下一个字符原样保留（如 \" 不视为字符串结束）
        i += 1
        if (i < input.length) out += input.charAt(i)
      } else if (ch === '"') {
        inString = false
      }
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && input.charAt(i + 1) === '/') {
      while (i < input.length && input.charAt(i) !== '\n') i += 1
      continue
    }
    if (ch === '/' && input.charAt(i + 1) === '*') {
      const end = input.indexOf('*/', i + 2)
      if (end === -1) throw new Error('JSONC 块注释未闭合')
      i = end + 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** 解析 JSONC 文本（容忍 BOM / CRLF / 尾注释），产出 JSON 值。 */
export function parseJsonc(raw: string): unknown {
  const cleaned = raw.replace(/^\uFEFF/, '')
  return JSON.parse(stripJsoncComments(cleaned))
}

/** 校验 allowlist 形状：字符串数组、无空值、无重复、每项为 GHSA 编号或 npm 包名。 */
export function validateAllowlist(allowlist: unknown): void {
  if (!Array.isArray(allowlist)) {
    throw new Error('allowlist 必须是字符串数组')
  }
  const seen = new Set<string>()
  for (const entry of allowlist) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`allowlist 存在空值或非字符串条目：${String(entry)}`)
    }
    if (seen.has(entry)) {
      throw new Error(`allowlist 存在重复条目：${entry}`)
    }
    seen.add(entry)
    // 疑似 GHSA 编号（任意大小写前缀）但不符合标准格式的，一律视为畸形条目，
    // 避免大小写/段数笔误混进包名分支被放行
    if (/^ghsa/i.test(entry) && !GHSA_PATTERN.test(entry)) {
      throw new Error(
        `allowlist 条目疑似 GHSA 编号但格式不合法（应为 GHSA-xxxx-xxxx-xxxx）：${entry}`
      )
    }
    if (!GHSA_PATTERN.test(entry) && !NPM_NAME_PATTERN.test(entry)) {
      throw new Error(`allowlist 条目既不是合法 GHSA 编号也不是 npm 包名：${entry}`)
    }
  }
}

/** 校验必需键齐全，缺失时列出全部缺失键名。 */
export function requireKeys(config: Record<string, unknown>, keys: readonly string[]): void {
  const missing = keys.filter((k) => !(k in config))
  if (missing.length > 0) {
    throw new Error(`audit-ci.jsonc 缺少必需键：${missing.join(', ')}`)
  }
}

describe('stripJsoncComments（JSONC 注释剥离）', () => {
  it('正常：剥离行注释与块注释', () => {
    const input = ['{ // 行注释', '  "a": 1, /* 块注释 */', '  // 尾注释', '}'].join('\n')
    const stripped = stripJsoncComments(input)
    expect(stripped).not.toContain('//')
    expect(stripped).not.toContain('/*')
    expect(stripped.replace(/\s+/g, '')).toBe('{"a":1,}')
  })

  it('边界：字符串内的 // 与 /* */ 不被当作注释（URL 保真）', () => {
    const input = '{"url": "https://registry.npmjs.org", "s": "a/*b*/c"}'
    expect(stripJsoncComments(input)).toBe(input)
  })

  it('边界：字符串内的转义引号不终止字符串', () => {
    const input = '{"s": "quote \\" then // still string"}'
    expect(stripJsoncComments(input)).toBe(input)
  })

  it('边界：块注释内出现 // 也整体剥离', () => {
    expect(stripJsoncComments('{/* has // inside */"a":1}')).toBe('{"a":1}')
  })

  it('异常：未闭合的块注释抛错', () => {
    expect(() => stripJsoncComments('{"a":1/* 未闭合')).toThrow('块注释未闭合')
  })
})

describe('parseJsonc（JSONC 解析）', () => {
  it('边界：容忍 BOM、CRLF 与尾注释', () => {
    const raw = '\uFEFF{\r\n  // c1\r\n  "high": true\r\n} // 尾注释'
    expect(parseJsonc(raw)).toEqual({ high: true })
  })

  it('异常：JSON5 风格的裸键名（缺引号）抛错', () => {
    expect(() => parseJsonc('{ high: true }')).toThrow()
  })
})

describe('validateAllowlist（豁免清单校验）', () => {
  it('异常：重复条目抛错', () => {
    expect(() => validateAllowlist(['GHSA-23hp-3jrh-7fpw', 'GHSA-23hp-3jrh-7fpw'])).toThrow(
      '重复条目'
    )
  })

  it('异常：畸形条目抛错（小写前缀 / 段数不足 / 空串）', () => {
    expect(() => validateAllowlist(['ghsa-23hp-3jrh-7fpw'])).toThrow('GHSA')
    expect(() => validateAllowlist(['GHSA-123'])).toThrow('GHSA')
    expect(() => validateAllowlist([''])).toThrow('空值')
    expect(() => validateAllowlist(['   '])).toThrow('空值')
  })

  it('边界：空数组与 npm 包名条目均合法（不误伤未来清零场景）', () => {
    expect(() => validateAllowlist([])).not.toThrow()
    expect(() => validateAllowlist(['tar', '@scope/pkg-name'])).not.toThrow()
  })
})

describe('requireKeys（必需键校验）', () => {
  it('异常：缺失键在报错信息中逐个列出', () => {
    expect(() => requireKeys({ high: true }, ['$schema', 'registry'])).toThrow(
      '缺少必需键：$schema, registry'
    )
    expect(() => requireKeys({ high: true }, ['high'])).not.toThrow()
  })
})

describe('audit-ci.jsonc 文件契约（仓库根）', () => {
  const raw = readFileSync(path.join(repoRoot, 'audit-ci.jsonc'), 'utf8')
  const config = parseJsonc(raw) as Record<string, unknown>

  it('正常：存在、可解析且包含全部必需键，阈值与 schema 正确', () => {
    requireKeys(config, ['$schema', 'high', 'registry', 'allowlist'])
    expect(config.high).toBe(true)
    expect(typeof config.$schema).toBe('string')
  })

  it('正常：registry 覆盖为官方源（npmmirror 等镜像不实现审计端点）', () => {
    expect(String(config.registry).replace(/\/+$/, '')).toBe(OFFICIAL_REGISTRY)
  })

  it('正常：allowlist 合法（无重复 / 格式正确）且包含迁移基线 28 项', () => {
    expect(MIGRATION_BASELINE).toHaveLength(28)
    validateAllowlist(config.allowlist)
    const allowlist = config.allowlist as string[]
    for (const id of MIGRATION_BASELINE) {
      expect(allowlist).toContain(id)
    }
  })
})

describe('package.json 审计脚本契约', () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }

  it('正常：audit 脚本与 CI 共用同一份 audit-ci.jsonc 配置', () => {
    expect(pkg.scripts?.audit).toBe('audit-ci --config ./audit-ci.jsonc')
  })

  it('正常：audit:fix 固定走官方 registry 执行 npm audit fix', () => {
    const fix = pkg.scripts?.['audit:fix'] ?? ''
    expect(fix).toContain('npm audit fix')
    expect(fix).toContain(OFFICIAL_REGISTRY)
  })
})

describe('.github/workflows/build.yml 审计步骤契约', () => {
  const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'build.yml'), 'utf8')

  it('正常：审计步骤引用共享配置文件', () => {
    expect(workflow).toContain('npx audit-ci --config ./audit-ci.jsonc')
  })

  it('正常：CI 不再内联豁免清单（防两份清单漂移）', () => {
    expect(workflow).not.toContain('--allowlist')
    expect(workflow).not.toMatch(/GHSA-/)
  })
})

describe('.npmrc 项目约定', () => {
  it('边界：保持零配置约定，不含 registry 键（镜像走用户级/环境变量）', () => {
    const npmrc = readFileSync(path.join(repoRoot, '.npmrc'), 'utf8')
    for (const line of npmrc.split(/\r?\n/)) {
      expect(line.trim()).not.toMatch(/^registry\s*=/)
    }
  })
})
