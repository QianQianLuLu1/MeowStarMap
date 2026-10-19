/**
 * e2e 误输入守卫（npm scripts 入口：`npm run e2e`）。
 *
 * 背景：npm 按空格切词，`npm run e2e : smoke` 解析出的脚本名是 `e2e`（`:` 与 `smoke` 变成参数），
 * 而本仓只有 `e2e:smoke` / `e2e:perf` 这类带冒号的脚本名，于是只剩 npm 那句无信息量的
 * "Missing script: e2e"。本守卫把裸 `e2e` 占住，改为列出真实子命令并以退出码 1 结束。
 *
 * 口径：守卫只做提示，绝不代为派发命令（避免把笔误洗成"看起来成功"的假绿）；
 * 核心逻辑导出为纯函数供 `__tests__/e2e-usage.test.ts` 单测。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface E2eSubcommand {
  name: string
  desc: string
}

/** 清单与 package.json 的一致性由测试守护（列了不存在的命令即失败） */
export const E2E_SUBCOMMANDS: ReadonlyArray<E2eSubcommand> = [
  { name: 'e2e:smoke', desc: '打包产物冒烟（排除 @perf 用例）' },
  { name: 'e2e:perf', desc: '性能基准用例' },
  { name: 'dist:win:smoke', desc: '重新打包后跑冒烟' },
  { name: 'dist:win:perf', desc: '重新打包后跑性能' },
  { name: 'typecheck:e2e', desc: 'e2e 目录类型检查' }
]

/** 建议行的固定前缀，测试据此判定"是否追加了建议" */
const SUGGEST_PREFIX = '是否想运行'

/** 丢掉冒号与空白 token，统一小写；非字符串入参一律忽略 */
function normalizeArgv(argv: readonly string[]): string[] {
  return argv
    .filter((arg): arg is string => typeof arg === 'string')
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0 && arg !== ':')
    .map((arg) => arg.toLowerCase())
}

/** 按命令名的冒号分段匹配（`smoke` → `e2e:smoke`）；命中不了就返回空串，不臆造命令 */
function findSuggestion(tokens: readonly string[]): string {
  for (const token of tokens) {
    const cleaned = token.replace(/:/g, '')
    if (!cleaned) continue
    const hit = E2E_SUBCOMMANDS.find((cmd) => cmd.name.split(':').includes(cleaned))
    if (hit) return hit.name
  }
  return ''
}

export function buildE2eHint(argv: readonly string[]): string {
  const lines = [
    '[e2e] ✖ 本仓没有名为 e2e 的脚本：npm 按空格切词，`npm run e2e : smoke` 里的脚本名是 e2e。',
    '可用命令：',
    ...E2E_SUBCOMMANDS.map((cmd) => `  npm run ${cmd.name.padEnd(16)}${cmd.desc}`),
    '提示：冒号两侧不能有空格，正确写法是 npm run e2e:smoke'
  ]
  const suggestion = findSuggestion(normalizeArgv(argv))
  if (suggestion) lines.push(`${SUGGEST_PREFIX} npm run ${suggestion}？`)
  return lines.join('\n')
}

/** 被单测 import 时必须静默——顶层 process.exit 会直接终止 vitest 进程 */
const invokedDirectly = (): boolean => {
  const self = path.resolve(fileURLToPath(import.meta.url))
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
  // Windows 盘符大写在两种入口下可能不一致，按小写比较
  return self.toLowerCase() === entry.toLowerCase()
}

if (invokedDirectly()) {
  process.stderr.write(buildE2eHint(process.argv.slice(2)) + '\n')
  process.exit(1)
}
