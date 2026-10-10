/**
 * 变更后最小验证脚本（只读）
 *
 * 供 Agent 与开发者在代码变更后一键运行 typecheck + lint + 核心路径授权闸门 + 格式 + 相关单测，
 * 确保变更不会破坏类型安全、代码规范、核心路径授权约定、格式一致或已有测试。
 *
 * 铁律：本脚本只读，绝不写文件。pre-commit 钩子（lint-staged 的 eslint --fix /
 * prettier --write）会改写并重新暂存文件，两者口径差异见 AGENTS.md
 * 「verify 与 pre-commit 闸门的差异」一节。
 *
 * 用法：
 *   npx tsx scripts/verify-changes.ts              # 验证所有变更文件
 *   npx tsx scripts/verify-changes.ts --staged      # 仅验证暂存文件
 *   npx tsx scripts/verify-changes.ts src/main/ipc/handlers/foo.ts  # 验证指定文件
 *
 * 退出码：
 *   0 — 全部通过
 *   1 — 存在失败项（查看输出中的 [VERIFY] 标记行定位具体阶段）
 */

import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { findRelatedTests } from './find-related-tests'
import { getPrettierKeys, parseFormatScopeKey, selectFormatTargets } from './verify-format-scope'

const cwd = process.cwd()
const args = process.argv.slice(2)
const stagedOnly = args.includes('--staged')
const explicitFiles = args.filter((a) => !a.startsWith('--'))

// ── 工具函数 ──

function runStep(label: string, cmd: string, cmdArgs: string[]): { ok: boolean; duration: number } {
  const start = Date.now()
  console.log(`\n${'='.repeat(60)}`)
  console.log(`[VERIFY] ▶ ${label}`)
  console.log(`${'='.repeat(60)}`)

  const result = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    cwd,
    shell: true
  })

  const duration = Date.now() - start
  const ok = result.status === 0
  console.log(`\n[VERIFY] ${ok ? '✓' : '✗'} ${label} — ${ok ? '通过' : '失败'} (${duration}ms)`)
  return { ok, duration }
}

function getChangedFiles(staged: boolean): string[] {
  const gitCmd = staged
    ? 'git diff --cached --name-only --diff-filter=ACM'
    : 'git diff --name-only HEAD --diff-filter=ACM'
  const result = spawnSync(gitCmd, { shell: true, cwd, encoding: 'utf-8' })
  if (result.status !== 0) {
    // HEAD 不存在时（首次提交）回退到暂存区
    const fallback = spawnSync('git diff --cached --name-only --diff-filter=ACM', {
      shell: true,
      cwd,
      encoding: 'utf-8'
    })
    return (fallback.stdout || '').trim().split('\n').filter(Boolean)
  }
  return (result.stdout || '').trim().split('\n').filter(Boolean)
}

function hasTsFiles(files: string[]): boolean {
  return files.some((f) => /\.tsx?$/.test(f))
}

/**
 * 从 package.json 的 lint-staged 配置推导「钩子会格式化哪些文件」的键列表。
 * 读取/解析失败时直接 exit 1：格式检查作用域不明时宁可报错，也不静默跳过造成假绿。
 */
function readPrettierKeys(): string[] {
  const pkgPath = resolve(cwd, 'package.json')
  let parsed: { 'lint-staged'?: Record<string, string | string[]> }
  try {
    parsed = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  } catch (err) {
    console.error(`\n[VERIFY] ✗ 无法读取 package.json 以推导格式检查作用域：${String(err)}`)
    console.error('[VERIFY] 格式检查无法执行 — 请修复后重试（不静默跳过，避免假绿）')
    process.exit(1)
  }
  const lintStaged = parsed['lint-staged']
  if (!lintStaged) {
    console.log('\n[VERIFY] ⊘ package.json 未配置 lint-staged，无格式化闸门，跳过格式检查')
    return []
  }
  return getPrettierKeys(lintStaged)
}

// ── 主流程 ──

console.log('[VERIFY] 变更后最小验证（只读） — typecheck + lint + format + test')
console.log(
  `[VERIFY] 模式: ${stagedOnly ? '暂存文件' : explicitFiles.length > 0 ? '指定文件' : '所有变更'}`
)

// 确定要验证的文件列表
let targetFiles: string[]
if (explicitFiles.length > 0) {
  targetFiles = explicitFiles
} else {
  targetFiles = getChangedFiles(stagedOnly)
}

const tsFiles = targetFiles.filter((f) => /\.tsx?$/.test(f))
const results: Array<{ step: string; ok: boolean; duration: number }> = []

// ── Step 1: TypeCheck（仅当存在 TS/TSX 变更时） ──
if (hasTsFiles(targetFiles)) {
  const r = runStep('TypeScript 类型检查 (tsc -b)', 'npx', ['--no-install', 'tsc', '-b'])
  results.push({ step: 'typecheck', ...r })
} else {
  console.log('\n[VERIFY] ⊘ 无 TS/TSX 变更，跳过类型检查')
}

// ── Step 2: Lint（对变更文件运行 eslint） ──
if (targetFiles.length > 0) {
  const lintTargets = targetFiles.filter(
    (f) => /\.(ts|tsx|js|jsx)$/.test(f) && existsSync(resolve(cwd, f))
  )
  if (lintTargets.length > 0) {
    const r = runStep('ESLint 代码规范检查（只读，不自动修复）', 'npx', [
      '--no-install',
      'eslint',
      '--no-error-on-unmatched-pattern',
      ...lintTargets
    ])
    results.push({ step: 'lint', ...r })
  } else {
    console.log('\n[VERIFY] ⊘ 无可 lint 的文件，跳过')
  }
} else {
  console.log('\n[VERIFY] ⊘ 无变更文件，跳过 lint')
}

// ── Step 2.5: 核心路径授权闸门（对本次 diff 判定 @core-change 授权；口径见 AGENTS.md「核心路径保护」） ──
// --staged 模式联动（对应 pre-commit 口径）；显式指定文件时透传，闸门内部过滤出受保护路径。
// 闸门自行以 ⊘ 跳过「不涉及受保护文件」的变更，此处无需预判。
if (targetFiles.length > 0) {
  const gateArgs = ['--no-install', 'tsx', 'scripts/core-path-gate.ts']
  if (stagedOnly) gateArgs.push('--staged')
  if (explicitFiles.length > 0) {
    gateArgs.push(...targetFiles.filter((f) => existsSync(resolve(cwd, f))))
  }
  const r = runStep('核心路径授权闸门 (@core-change diff 判定)', 'npx', gateArgs)
  results.push({ step: 'core-gate', ...r })
}

// ── Step 3: 格式检查（prettier --check，只读；作用域取自 lint-staged 配置） ──
// 仅检查钩子会跑 prettier 的路径，docs/**、.qoder/** 等不在闸门格式范围内的文件不误报。
// 行尾不参与判定（传 --end-of-line auto）：core.autocrlf 下工作区为 CRLF 而提交内容为 LF，
// 按 .prettierrc 的 endOfLine: "lf" 直检工作区会全盘假失败，且钩子改写行尾并不改变提交内容。
const prettierKeys = readPrettierKeys()
for (const key of prettierKeys.filter((k) => parseFormatScopeKey(k) === null)) {
  console.log(
    `\n[VERIFY] ⚠ 无法解析 lint-staged 键：${key}，该键未纳入格式检查（请更新 scripts/verify-format-scope.ts）`
  )
}
const formatTargets = selectFormatTargets(targetFiles, prettierKeys).filter((f) =>
  existsSync(resolve(cwd, f))
)
if (formatTargets.length > 0) {
  const r = runStep(`格式检查 (prettier --check, ${formatTargets.length} 个文件)`, 'npx', [
    '--no-install',
    'prettier',
    '--check',
    '--end-of-line',
    'auto',
    ...formatTargets
  ])
  results.push({ step: 'format', ...r })
} else {
  console.log('\n[VERIFY] ⊘ 无命中钩子格式范围的变更文件，跳过格式检查')
}

// ── Step 4: 相关单测（匹配规则见 scripts/find-related-tests.ts） ──
const related = findRelatedTests(cwd, tsFiles)
if (related.tests.length > 0) {
  const r = runStep(`相关单元测试 (${related.tests.length} 个文件)`, 'npx', [
    'vitest',
    'run',
    // vitest 5 移除了 basic reporter（未知名称会被当作自定义 reporter 模块加载并启动失败），
    // dot 是与原 basic 输出密度最接近的内置 reporter
    '--reporter=dot',
    ...related.tests
  ])
  results.push({ step: 'test', ...r })
}
if (related.missing.length > 0) {
  console.log(
    `\n[VERIFY] ⚠ ${related.missing.length} 个源文件未命中任何测试 — 缺少匹配套件（同目录与 __tests__/ 下均无 <base>.test.ts(x)）：`
  )
  for (const f of related.missing) console.log(`  - ${f}`)
}
if (related.tests.length === 0 && related.missing.length === 0) {
  console.log('\n[VERIFY] ⊘ 无 TS/TSX 变更，无测试需运行')
}

// ── 汇总报告 ──
console.log(`\n${'='.repeat(60)}`)
console.log('[VERIFY] 验证汇总')
console.log(`${'='.repeat(60)}`)

const totalDuration = results.reduce((sum, r) => sum + r.duration, 0)
const failed = results.filter((r) => !r.ok)

for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.step.padEnd(12)} ${r.duration}ms`)
}

console.log(`\n[VERIFY] 总计: ${results.length} 项, ${failed.length} 失败, 耗时 ${totalDuration}ms`)

if (related.missing.length > 0) {
  console.log(
    `[VERIFY] ⚠ 注意：${related.missing.length} 个源文件缺少匹配套件，相关测试未运行（明细见上方）`
  )
}

if (failed.length > 0) {
  console.log(`\n[VERIFY] 失败项: ${failed.map((r) => r.step).join(', ')}`)
  console.log('[VERIFY] 请修复上述错误后重试')
  process.exit(1)
} else {
  console.log('[VERIFY] ✓ 全部通过 — 可以安全提交')
  process.exit(0)
}
