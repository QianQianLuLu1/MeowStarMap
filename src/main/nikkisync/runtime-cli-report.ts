/**
 * 内嵌 Runtime 无 UI 验证入口的输出层（整合阶段 2）。
 *
 * 与 `probe.ts` 承担同一角色（见 `src/main/nikkisync/AGENTS.md` 硬性约定 8）：
 * 报告 → 文本形态必须是可单测的纯函数，入口壳 `runtime-cli.ts` 只保留
 * “跑流程 → 分流 stdout/stderr → 定退出码”三件事，否则壳的 0% 覆盖面会随功能增长
 * 把真实覆盖率问题藏进排除项。
 *
 * 字符串字面量保持英文（src/** 的中文硬编码护栏为 error）。
 */

import os from 'node:os'
import path from 'node:path'

/** 缺省取前 5 条资产（够验证 DTO 形态，又不在日志里刷屏）。 */
export const DEFAULT_CLI_LIMIT = 5
/** 缺省库目录：系统临时目录，验证不污染 userData。 */
export const DEFAULT_CLI_DATA_DIR_NAME = 'nikkisync-embed-cli'

export interface RuntimeCliArgs {
  gameRoot?: string
  dataDir: string
  limit: number
  watcher: boolean
}

/** 一次运行的结论（`runtime-cli.ts` 汇总后交给输出层）。 */
export interface RuntimeRunSummary {
  ok: boolean
  state: string
  dbPath: string
  linkReady: boolean
  tables: number
  filesObserved?: number
  assetsCreated?: number
  assets?: number
  motionAssets?: number
  firstAssetId?: string
  error?: string
}

function cliTempDir(): string {
  return path.join(os.tmpdir(), DEFAULT_CLI_DATA_DIR_NAME)
}

/**
 * 解析 `--k=v` 形态参数：未知键忽略、空值忽略、limit 越界忽略（保持缺省）。
 * 纯函数：临时目录经 `tempDir` 注入，单测不依赖真实 os.tmpdir()。
 */
export function parseRuntimeCliArgs(
  argv: readonly string[],
  tempDir: string = cliTempDir()
): RuntimeCliArgs {
  const parsed: RuntimeCliArgs = { dataDir: tempDir, limit: DEFAULT_CLI_LIMIT, watcher: false }
  for (const item of argv) {
    const match = /^--([a-z-]+)=(.*)$/i.exec(item)
    if (!match) continue
    const key = match[1]!.toLowerCase()
    const value = match[2]!.trim()
    if (value === '') continue
    if (key === 'game-root') parsed.gameRoot = value
    else if (key === 'data-dir') parsed.dataDir = value
    else if (key === 'watcher') parsed.watcher = value === '1' || value === 'true'
    else if (key === 'limit') {
      const limit = Number(value)
      if (Number.isSafeInteger(limit) && limit >= 1 && limit <= 500) parsed.limit = limit
    }
  }
  return parsed
}

/** 报告 → 文本行序列。约定：`[fail    ]` / `[result  ] FAILED` 行属错误输出。 */
export function formatRuntimeRunLines(summary: RuntimeRunSummary): string[] {
  const lines = [
    `[nikkisync-runtime] state=${summary.state} dbPath=${summary.dbPath} ` +
      `linkReady=${summary.linkReady} tables=${summary.tables}`
  ]
  if (summary.filesObserved !== undefined) {
    lines.push(
      `[scan    ] filesObserved=${summary.filesObserved} ` +
        `assetsCreated=${summary.assetsCreated ?? 0}`
    )
  }
  if (summary.assets !== undefined) {
    lines.push(
      `[query   ] assets=${summary.assets} motionAssets=${summary.motionAssets ?? 0} ` +
        `firstAssetId=${summary.firstAssetId ?? 'n/a'}`
    )
  }
  if (summary.ok) {
    lines.push('[result  ] OK')
    return lines
  }
  lines.push(`[fail    ] ${summary.error ?? 'unknown failure'}`)
  lines.push('[result  ] FAILED')
  return lines
}

/** 报告行是否属于错误输出（调用方据此分流到 stderr）。 */
export function isRuntimeRunErrorLine(line: string): boolean {
  return line.startsWith('[fail    ]') || line.startsWith('[result  ] FAILED')
}
