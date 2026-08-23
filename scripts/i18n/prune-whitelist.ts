/**
 * i18n 存量技术债白名单 —— 自动瘦身脚本
 *
 * 找出白名单中"违规已清零"的文件，默认以 dry-run 列出候选；`--apply` 时精确地从
 * eslint.config.js 的 warn 块 files 数组中移除这些路径，使其回到 error 级硬阻断。
 *
 * 安全约束：
 *  - 仅移除 lint 统计违规数为 0 的文件；任何 >0 违规文件一律不移除。
 *  - 只改写 eslint.config.js 中 warn 级 no-restricted-syntax 块的 files 数组，不触碰其他块。
 *  - `--apply` 前必须先确认（默认 dry-run）；落盘后重跑 lint 校验无误。
 *
 * 用法：
 *   npx tsx scripts/i18n/prune-whitelist.ts          # dry-run，仅打印候选
 *   npx tsx scripts/i18n/prune-whitelist.ts --apply  # 从白名单移除清零文件
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import {
  CONFIG_PATH,
  findWarnBlockSpan,
  lintNoRestrictedSyntax,
  loadWhitelistFiles
} from './_shared'

function removeFromWarnBlock(text: string, toRemove: string[]): string {
  const span = findWarnBlockSpan(text)
  if (!span) throw new Error('未在 eslint.config.js 找到 warn 级 no-restricted-syntax 块')
  const inner = text.slice(span.innerStart, span.filesEnd)
  const kept = inner
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      const mm = t.match(/^(['"])(.+?)\1,?$/)
      return !mm || !toRemove.includes(mm[2])
    })
    .join('\n')
  return text.slice(0, span.innerStart) + kept + text.slice(span.filesEnd)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')

  const whitelist = await loadWhitelistFiles()
  if (whitelist.length === 0) {
    console.error('[i18n:prune] 白名单为空，无需瘦身。')
    process.exit(0)
  }

  const statMap = await lintNoRestrictedSyntax(whitelist)
  const candidates = [...statMap.values()].filter((f) => f.violations === 0).map((f) => f.file)

  if (candidates.length === 0) {
    console.log('[i18n:prune] 无违规清零的文件，白名单暂无可移除项。')
    process.exit(0)
  }

  console.log(`[i18n:prune] 检测到 ${candidates.length} 个违规清零文件（可移除）：`)
  for (const c of candidates) console.log(`  - ${c}`)

  if (!apply) {
    console.log('\n[i18n:prune] 以上为 dry-run 预览。追加 --apply 可写入 eslint.config.js。')
    process.exit(0)
  }

  const before = fs.readFileSync(CONFIG_PATH, 'utf-8')
  const after = removeFromWarnBlock(before, candidates)
  if (after === before) {
    console.error('[i18n:prune] 未对配置产生改动（路径可能已移除），中止。')
    process.exit(1)
  }
  fs.writeFileSync(CONFIG_PATH, after, 'utf-8')
  console.log(`[i18n:prune] 已从白名单移除 ${candidates.length} 个文件。`)

  // 落盘后二次校验：被移除文件在 error 级下应 0 违规
  const reStat = await lintNoRestrictedSyntax(candidates)
  const stillDirty = [...reStat.values()].filter((f) => f.violations > 0)
  if (stillDirty.length) {
    console.error('[i18n:prune] 危险：以下文件移除后仍有违规，正在回滚配置：')
    for (const f of stillDirty) console.error(`  - ${f.file}: ${f.violations}`)
    fs.writeFileSync(CONFIG_PATH, before, 'utf-8')
    process.exit(1)
  }
  console.log('[i18n:prune] 二次校验通过：被移除文件在 error 级下均为 0 违规。')
  console.log(
    `[i18n:prune] 建议随后运行：npm run i18n:status -- --md docs/i18n/whitelist-status.md`
  )
}

// 供单测使用的纯函数（不影响 CLI 行为）
export { removeFromWarnBlock }

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
