/**
 * 技术债 GitHub Issue 批量创建脚本
 *
 * 读取 docs/debt-registry.json 中 status=open 且 issue=null 的条目，
 * 通过 `gh issue create` 为每项创建 GitHub Issue（标签 tech-debt），
 * 创建成功后将 issue 号回填至注册表 JSON。
 *
 * 前置条件：
 *   - 已安装并登录 gh CLI（`gh auth status`）
 *   - 仓库已配置 remote（`gh repo view` 可正常输出）
 *
 * 用法：
 *   npx tsx scripts/debt/create-github-issues.ts          # 创建全部缺失 Issue
 *   npx tsx scripts/debt/create-github-issues.ts --dry-run # 仅打印将要创建的内容
 *   npx tsx scripts/debt/create-github-issues.ts DEBT-014  # 仅创建指定 ID
 *   npx tsx scripts/debt/create-github-issues.ts --backfill-only           # 跳过 gh 调用，仅将 null issue 标记为 false
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const REGISTRY_PATH = path.join(ROOT, 'docs', 'debt-registry.json')

interface DebtItem {
  id: string
  category: string
  section: number
  status: string
  priority: string
  title: string
  description: string
  files: string[]
  lines: number[]
  issue: number | false | null
}

interface Registry {
  updatedAt: string
  items: DebtItem[]
}

const CATEGORY_LABELS: Record<string, string> = {
  'i18n-user': 'i18n-用户文案',
  'i18n-log': 'i18n-内部日志',
  'type-drift': '类型漂移',
  docs: '文档',
  a11y: '可访问性',
  theme: '主题样式',
  'supply-chain': '供应链安全',
  validation: '参数校验',
  'test-gap': '测试缺口',
  'memory-leak': '内存泄漏',
  perf: '性能',
  startup: '启动流程',
  cache: '缓存',
  concurrency: '并发策略',
  robustness: '健壮性'
}

const PRIORITY_LABELS: Record<string, string> = {
  high: '🔴 高',
  medium: '🟡 中',
  low: '🟢 低'
}

function buildIssueBody(item: DebtItem): string {
  const lines: string[] = []
  lines.push(`## 技术债务：${item.title}`)
  lines.push('')
  lines.push(`**注册表 ID**：\`${item.id}\``)
  lines.push(`**分类**：${CATEGORY_LABELS[item.category] ?? item.category}`)
  lines.push(`**优先级**：${PRIORITY_LABELS[item.priority] ?? item.priority}`)
  lines.push(`**技术债清单章节**：§${item.section}`)
  lines.push('')

  if (item.files.length > 0) {
    lines.push('### 涉及文件')
    lines.push('')
    for (const f of item.files) {
      lines.push(`- \`${f}\``)
    }
    lines.push('')
  }

  if (item.lines.length > 0) {
    lines.push('### 相关行号')
    lines.push('')
    lines.push(`\`${item.lines.join(' / ')}\``)
    lines.push('')
  }

  lines.push('### 描述')
  lines.push('')
  lines.push(item.description)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('> 本 Issue 由 `scripts/debt/create-github-issues.ts` 自动创建。')
  lines.push(`> 对应技术债清单：\`docs/技术债清单.md\` §${item.section}`)
  lines.push(
    '> 修复后请：① 关闭本 Issue  ② 更新 `docs/技术债清单.md` 对应条目状态  ③ 将 `docs/debt-registry.json` 中该条目的 `status` 改为 `done` 并回填 `issue` 号。'
  )

  return lines.join('\n')
}

function ensureTechDebtLabel(): void {
  try {
    execFileSync('gh', ['label', 'list', '--json', 'name', '--jq', '.[].name'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch {
    console.warn('[create-issues] ⚠ 无法获取标签列表，跳过标签创建检查')
    return
  }

  // 确保 tech-debt 标签存在
  try {
    execFileSync(
      'gh',
      ['label', 'create', 'tech-debt', '--description', '技术债务跟踪', '--color', 'e8d44d'],
      { stdio: 'pipe' }
    )
  } catch {
    // 标签可能已存在，忽略
  }
}

function createIssue(item: DebtItem, dryRun: boolean): number | null {
  const title = `[tech-debt] ${item.id}: ${item.title}`
  const body = buildIssueBody(item)
  const labels = `tech-debt,${item.category}`

  if (dryRun) {
    console.log(`\n--- [DRY RUN] ${item.id} ---`)
    console.log(`Title: ${title}`)
    console.log(`Labels: ${labels}`)
    console.log(`Body:\n${body.slice(0, 200)}...`)
    return null
  }

  try {
    // 使用临时文件传递 body，避免 shell 转义问题
    const tmpFile = path.join(ROOT, '.cache', `issue-body-${item.id}.md`)
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true })
    fs.writeFileSync(tmpFile, body, 'utf-8')

    // 使用 execFileSync + 参数数组，避免 shell 注入风险
    const result = execFileSync(
      'gh',
      ['issue', 'create', '--title', title, '--label', labels, '--body-file', tmpFile],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    )

    // 清理临时文件
    fs.unlinkSync(tmpFile)

    // gh issue create 输出格式: https://github.com/owner/repo/issues/123
    const match = result.trim().match(/issues\/(\d+)/)
    if (match) {
      return parseInt(match[1], 10)
    }
    console.warn(`[create-issues] ⚠ 无法从 gh 输出解析 issue 号: ${result.trim()}`)
    return null
  } catch (err) {
    console.error(`[create-issues] ✖ 创建 ${item.id} 失败:`, err)
    return null
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const backfillOnly = args.includes('--backfill-only')
  const dryRun = args.includes('--dry-run')
  const filterId = args.find((a) => a.startsWith('DEBT-'))

  console.log('\n[create-issues] 技术债务 GitHub Issue 批量创建')
  console.log(`  注册表: ${REGISTRY_PATH}`)
  console.log(
    `  模式: ${backfillOnly ? 'BACKFILL ONLY（跳过 gh 调用）' : dryRun ? 'DRY RUN（仅预览）' : '正式创建'}`
  )
  if (filterId) console.log(`  过滤: 仅处理 ${filterId}`)
  console.log('')

  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error('[create-issues] ✖ 注册表文件不存在:', REGISTRY_PATH)
    process.exit(1)
  }

  const registry: Registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'))

  if (!dryRun && !backfillOnly) {
    ensureTechDebtLabel()
    // --backfill-only：跳过 gh 调用，将所有 null issue 标记为 false
    if (backfillOnly) {
      let marked = 0
      for (const item of registry.items) {
        if (item.issue === null) {
          item.issue = false
          marked++
          console.log(`  ⊘ ${item.id} (${item.status}) → 标记为不跟踪`)
        }
      }
      if (marked > 0) {
        registry.updatedAt = new Date().toISOString().slice(0, 10)
        fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf-8')
        console.log(`\n[create-issues] ✓ 注册表已更新（${marked} 个条目标记为不跟踪）`)
      } else {
        console.log('[create-issues] ✓ 无需标记（全部条目已有 issue 值）')
      }
      process.exit(0)
    }
  }

  const targets = registry.items.filter((item) => {
    if (item.status !== 'open') return false
    if (item.issue !== null) return false
    if (filterId && item.id !== filterId) return false
    return true
  })

  let created = 0
  let failed = 0

  if (targets.length > 0) {
    console.log(`[create-issues] 待创建: ${targets.length} 个 Issue\n`)

    for (const item of targets) {
      const issueNumber = createIssue(item, dryRun)
      if (dryRun) {
        created++
      } else if (issueNumber !== null) {
        item.issue = issueNumber
        created++
        console.log(`  ✓ ${item.id} → #${issueNumber}`)
      } else {
        failed++
      }
    }
  } else {
    console.log('[create-issues] 无需创建新 Issue（全部 open 条目已有 issue 号）')
  }

  // 将非 open 且 issue 仍为 null 的条目标记为 false（不会创建 Issue）
  let skipped = 0
  for (const item of registry.items) {
    if (item.status !== 'open' && item.issue === null) {
      item.issue = false
      skipped++
      console.log(`  ⊘ ${item.id} (${item.status}) → 标记为不跟踪`)
    }
  }

  const needsSave = created > 0 || skipped > 0
  if (!dryRun && needsSave) {
    registry.updatedAt = new Date().toISOString().slice(0, 10)
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf-8')
    console.log(
      `\n[create-issues] ✓ 注册表已更新（${created} 个 issue 号回填, ${skipped} 个标记为不跟踪）`
    )
  }

  console.log(
    `\n[create-issues] 完成: ${created} 创建${dryRun ? '（预览）' : ''}, ${failed} 失败, ${skipped} 跳过`
  )
  process.exit(failed > 0 ? 1 : 0)
}

main()
