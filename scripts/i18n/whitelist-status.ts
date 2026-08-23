/**
 * i18n 存量技术债白名单 —— 现状分析脚本（只读）
 *
 * 统计 legacy 白名单中每个文件仍残留的中文硬编码违规数，按模块聚合，并列出
 * 已清零（可立即从白名单移除）的候选文件。输出给 docs/i18n/whitelist-status.md
 * 与 CI 守卫（guard.ts）共用。
 *
 * 用法：
 *   npx tsx scripts/i18n/whitelist-status.ts            # 打印控制台报告
 *   npx tsx scripts/i18n/whitelist-status.ts --json    # 仅输出 JSON
 *   npx tsx scripts/i18n/whitelist-status.ts --md docs/i18n/whitelist-status.md  # 刷新快照文档
 *
 * 铁律：本脚本只读，绝不 writeFile 改源码 / eslint 配置（--md 仅写独立的快照文档）。
 */

import * as fs from 'fs'
import * as path from 'path'
import { lintNoRestrictedSyntax, loadWhitelistFiles } from './_shared'

interface FileStat {
  file: string
  violations: number
  loc: Array<{ line: number; col: number }>
}

interface ModuleStat {
  files: number
  violations: number
}

interface Report {
  generatedAt: string
  totalFiles: number
  totalViolations: number
  clearedFiles: number
  byModule: Record<string, ModuleStat>
  files: FileStat[]
  candidatesForRemoval: string[]
}

function moduleOf(file: string): string {
  const parts = file.split('/')
  // src/<main|renderer|shared>/... 取前两段；其余取首段
  if (parts[0] === 'src' && parts[1]) return `${parts[0]}/${parts[1]}`
  return parts[0] ?? 'unknown'
}

function buildReport(whitelist: string[], statMap: Map<string, FileStat>): Report {
  const files: FileStat[] = [...statMap.values()].sort(
    (a, b) => b.violations - a.violations || a.file.localeCompare(b.file)
  )
  const byModule: Record<string, ModuleStat> = {}
  for (const f of files) {
    const mod = moduleOf(f.file)
    byModule[mod] = byModule[mod] ?? { files: 0, violations: 0 }
    byModule[mod].files += 1
    byModule[mod].violations += f.violations
  }
  const candidatesForRemoval = files.filter((f) => f.violations === 0).map((f) => f.file)
  const totalViolations = files.reduce((s, f) => s + f.violations, 0)
  return {
    generatedAt: new Date().toISOString(),
    totalFiles: files.length,
    totalViolations,
    clearedFiles: candidatesForRemoval.length,
    byModule,
    files,
    candidatesForRemoval
  }
}

function renderMarkdown(r: Report): string {
  const lines: string[] = []
  lines.push('# i18n 存量白名单现状快照（自动生成）')
  lines.push('')
  lines.push(`> 由 \`npm run i18n:status\` 生成于 ${r.generatedAt}。`)
  lines.push('> 本文件为只读快照，请勿手工编辑；修复完一个文件请运行脚本刷新并同步从白名单移除。')
  lines.push('')
  lines.push(`- **白名单文件总数**：${r.totalFiles}`)
  lines.push(`- **残留中文硬编码违规总数**：${r.totalViolations}`)
  lines.push(`- **已清零（可移除）文件数**：${r.clearedFiles}`)
  lines.push('')
  lines.push('## 按模块分布')
  lines.push('')
  lines.push('| 模块 | 文件数 | 违规数 |')
  lines.push('| --- | ---: | ---: |')
  for (const [mod, s] of Object.entries(r.byModule).sort(
    (a, b) => b[1].violations - a[1].violations
  )) {
    lines.push(`| ${mod} | ${s.files} | ${s.violations} |`)
  }
  lines.push('')
  lines.push('## 文件明细（违规降序）')
  lines.push('')
  lines.push('| 文件 | 违规数 | 首处位置 |')
  lines.push('| --- | ---: | --- |')
  for (const f of r.files) {
    const where = f.loc[0] ? `${f.loc[0].line}:${f.loc[0].col}` : '-'
    lines.push(`| \`${f.file}\` | ${f.violations} | ${where} |`)
  }
  lines.push('')
  lines.push('## 已清零（建议立即从白名单移除）')
  lines.push('')
  if (r.candidatesForRemoval.length === 0) {
    lines.push('_（无）_')
  } else {
    for (const f of r.candidatesForRemoval) lines.push(`- \`${f}\``)
  }
  lines.push('')
  return lines.join('\n')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const mdIdx = args.indexOf('--md')
  const mdPath = mdIdx !== -1 ? args[mdIdx + 1] : undefined

  const whitelist = await loadWhitelistFiles()
  if (whitelist.length === 0) {
    console.error(
      '[i18n:status] 未在 eslint.config.js 找到 warn 级 no-restricted-syntax 白名单块。'
    )
    process.exit(1)
  }

  const statMap = await lintNoRestrictedSyntax(whitelist)
  const report = buildReport(whitelist, statMap)

  if (mdPath) {
    fs.writeFileSync(path.resolve(process.cwd(), mdPath), renderMarkdown(report), 'utf-8')
    console.log(`[i18n:status] 快照已写入 ${mdPath}`)
  }
  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  if (!mdPath) {
    console.log(
      `白名单文件：${report.totalFiles} 残留违规：${report.totalViolations} 已清零：${report.clearedFiles}`
    )
    console.log('按模块：')
    for (const [mod, s] of Object.entries(report.byModule).sort(
      (a, b) => b[1].violations - a[1].violations
    )) {
      console.log(`  ${mod}: ${s.files} 文件 / ${s.violations} 违规`)
    }
    if (report.candidatesForRemoval.length) {
      console.log('可立即移除：')
      for (const f of report.candidatesForRemoval) console.log(`  - ${f}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
