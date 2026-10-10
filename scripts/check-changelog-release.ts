/**
 * 变更日志收口闸门（打包前）
 *
 * 铁律：本脚本只读，绝不 writeFile 改源码。
 *
 * 背景：CHANGELOG.md 为手工维护（Keep a Changelog），2026-10-01 发布 2.5.3 后未执行
 * 「将 [Unreleased] 并入版本节并清空」的收口步骤，导致已随 2.5.3 安装包发布的变更
 * 在日志中长期标记为「未发布」。本闸门在打包前（npm run pre-dist-check 链）校验：
 *   1. package.json version 在 CHANGELOG.md 中存在对应版本节（防改版本号忘更新日志）；
 *   2. [Unreleased] 节无待发布条目（防「装的是 x.y.z、日志说未发布」错位随包出货）。
 * 任一 error 阻断打包（exit 1）；warning 仅提示不阻断。
 *
 * 用法：npx tsx scripts/check-changelog-release.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

/** CHANGELOG.md 中的一个 `## [...]` 节标题 */
export interface ChangelogSection {
  /** 节标识：'Unreleased' 或版本号（如 '2.5.3'） */
  version: string
  /** 标题中的发布日期（YYYY-MM-DD），未填为 null */
  date: string | null
  /** 标题所在行号（1 起） */
  line: number
}

/** [Unreleased] 节内的一条待发布条目 */
export interface ChangelogEntry {
  /** 条目所在行号（1 起） */
  line: number
  /** 条目文本（去掉行首缩进的原行） */
  text: string
}

/** 收口校验结果：errors 非空即未收口（阻断打包），warnings 仅提示 */
export interface ChangelogReleaseCheckResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  sections: ChangelogSection[]
  unreleasedEntries: ChangelogEntry[]
}

// 节标题：## [Unreleased] | 未发布 / ## [2.5.3] - 2026-10-11（容忍标题尾部中英注释与多余空格）
const SECTION_HEADING_RE = /^##\s+\[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?(?:\s+.*)?$/
// 条目行：- / * 列表（含缩进子条目）；-item 无空格不算
const ENTRY_LINE_RE = /^\s*[-*]\s+\S/
// 语义化版本前缀（x.y.z）
const VERSION_RE = /^\d+\.\d+\.\d+/

/** 解析 CHANGELOG.md：提取全部节标题与 [Unreleased] 节内的条目（### 子标题不截断节体） */
export function analyzeChangelog(changelogText: string): {
  sections: ChangelogSection[]
  unreleasedEntries: ChangelogEntry[]
} {
  const lines = changelogText.replace(/\r\n?/g, '\n').split('\n')
  const sections: ChangelogSection[] = []
  const unreleasedEntries: ChangelogEntry[] = []
  let current: ChangelogSection | null = null
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(SECTION_HEADING_RE)
    if (match) {
      current = { version: (match[1] ?? '').trim(), date: match[2] ?? null, line: i + 1 }
      sections.push(current)
      continue
    }
    if (current && current.version.toLowerCase() === 'unreleased' && ENTRY_LINE_RE.test(lines[i])) {
      unreleasedEntries.push({ line: i + 1, text: lines[i].trim() })
    }
  }
  return { sections, unreleasedEntries }
}

/** 收口判定：package.json 版本有对应版本节且不重复、[Unreleased] 无待发布条目 */
export function checkChangelogRelease(input: {
  changelogText: string
  packageVersion: string
}): ChangelogReleaseCheckResult {
  const errors: string[] = []
  const warnings: string[] = []
  const { changelogText, packageVersion } = input

  if (typeof changelogText !== 'string' || changelogText.trim().length === 0) {
    errors.push('CHANGELOG.md 内容为空或不是字符串，无法校验')
    return { ok: false, errors, warnings, sections: [], unreleasedEntries: [] }
  }
  if (typeof packageVersion !== 'string' || !VERSION_RE.test(packageVersion)) {
    errors.push(`package.json version 非法（期望 x.y.z 形态）：${JSON.stringify(packageVersion)}`)
    return { ok: false, errors, warnings, sections: [], unreleasedEntries: [] }
  }

  const { sections, unreleasedEntries } = analyzeChangelog(changelogText)

  // 1. package.json 版本必须有对应版本节，且不重复
  const pkgSections = sections.filter((s) => s.version === packageVersion)
  if (pkgSections.length === 0) {
    errors.push(
      `CHANGELOG.md 中不存在 [${packageVersion}] 版本节：发版/重新打包前请先为该版本补写变更记录`
    )
  } else if (pkgSections.length > 1) {
    errors.push(
      `CHANGELOG.md 中 [${packageVersion}] 版本节重复出现 ${pkgSections.length} 次（行 ${pkgSections
        .map((s) => s.line)
        .join('、')}），请合并为一节`
    )
  }

  // 2. [Unreleased] 必须已收口（条目应已并入版本节并清空）
  const hasUnreleased = sections.some((s) => s.version.toLowerCase() === 'unreleased')
  if (!hasUnreleased) {
    warnings.push(
      'CHANGELOG.md 中未找到 [Unreleased] 板块（不影响打包，但偏离 Keep a Changelog 格式）'
    )
  } else if (unreleasedEntries.length > 0) {
    const head = unreleasedEntries
      .slice(0, 3)
      .map((e) => `行 ${e.line}: ${e.text.slice(0, 60)}${e.text.length > 60 ? '…' : ''}`)
      .join('；')
    errors.push(
      `[Unreleased] 仍有 ${unreleasedEntries.length} 条待发布条目（${head}${
        unreleasedEntries.length > 3 ? ' 等' : ''
      }）。本次打包产物版本为 ${packageVersion}，这些变更将随包发布但日志仍标记为「未发布」；` +
        `请先按 CHANGELOG.md「编写规范」第 6 条将其并入 [${packageVersion}] 版本节并清空 [Unreleased]，再执行打包`
    )
  }

  return { ok: errors.length === 0, errors, warnings, sections, unreleasedEntries }
}

function main(): void {
  console.log('\n[check-changelog-release] 校验 CHANGELOG.md 发布收口状态\n')

  const changelogPath = path.join(ROOT, 'CHANGELOG.md')
  let changelogText: string
  try {
    changelogText = fs.readFileSync(changelogPath, 'utf-8')
  } catch {
    console.error('[check-changelog-release] ✖ 无法读取 CHANGELOG.md，请确认文件存在于仓库根目录')
    process.exit(1)
  }

  let packageVersion: string | undefined
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
      version?: string
    }
    packageVersion = pkg.version
  } catch {
    console.error('[check-changelog-release] ✖ 无法读取 package.json')
    process.exit(1)
  }

  const result = checkChangelogRelease({
    changelogText,
    packageVersion: packageVersion ?? ''
  })

  const latest = result.sections.find((s) => s.version.toLowerCase() !== 'unreleased')
  if (!latest) {
    console.error(
      '[check-changelog-release] ✖ CHANGELOG.md 中未解析到任何版本节，请检查标题格式（## [x.y.z] - YYYY-MM-DD）'
    )
    process.exit(1)
  }
  console.log(
    `  ✔ 解析到 ${result.sections.length} 个版本节（最新：${latest.version}，package.json：${packageVersion}）`
  )

  const pkgSectionExists = result.sections.some((s) => s.version === packageVersion)
  if (pkgSectionExists) {
    console.log(`  ✔ [${packageVersion}] 版本节存在且唯一`)
  }

  const hasUnreleased = result.sections.some((s) => s.version.toLowerCase() === 'unreleased')
  if (hasUnreleased) {
    if (result.unreleasedEntries.length === 0) {
      console.log('  ✔ [Unreleased] 已收口（无待发布条目）')
    } else {
      console.error(`  ✖ [Unreleased] 含 ${result.unreleasedEntries.length} 条待发布条目`)
    }
  }

  for (const warning of result.warnings) {
    console.warn(`  ⚠ ${warning}`)
  }
  for (const error of result.errors) {
    console.error(`  ✖ ${error}`)
  }

  if (!result.ok) {
    console.error(
      '\n[check-changelog-release] ❌ 变更日志未收口，禁止打包。请修复上述问题后重试。\n'
    )
    process.exit(1)
  }
  console.log('\n[check-changelog-release] ✅ 变更日志收口校验通过，可以执行打包。\n')
  process.exit(0)
}

// 仅在以脚本方式直接运行（tsx scripts/check-changelog-release.ts）时启动 CLI；被测试导入时不执行
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('check-changelog-release.ts')) {
  main()
}
