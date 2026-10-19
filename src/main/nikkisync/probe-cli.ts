/**
 * NikkiSync 链接探针 CLI（整合阶段 1）——刻意保持为薄壳：报告由 `probe.ts` 生成，
 * 文本形态由 `formatNikkiSyncLinkProbeReport()` 决定（两者均有单测），本文件只做
 * “跑探针 → 分流 stdout/stderr → 定退出码”。
 *
 * 作为 electron-vite main 的独立入口随真实主进程走同一条 CJS 打包管线，因此它同时校验：
 *   1. 打包器没有把变量式动态 import 折叠成 require()（否则运行时即报
 *      ERR_REQUIRE_ASYNC_MODULE）；
 *   2. 四包在目标宿主（本地 Node / Electron 内置 Node）里确实可装载。
 *
 * 运行方式：
 *   - 打包产物 + Electron：ELECTRON_RUN_AS_NODE=1 electron.exe dist/main/main/app/nikkisync-probe.js
 *   - 本地 Node：npx tsx src/main/nikkisync/probe-cli.ts
 */

import {
  formatNikkiSyncLinkProbeReport,
  isNikkiSyncProbeErrorLine,
  runNikkiSyncLinkProbe
} from './probe'
import { buildPackagingContext, type PackagingContext } from './embedding-paths'

/**
 * 打包态（asar 内运行）才构造上下文：存在 process.resourcesPath 即说明跑在 Electron
 * 安装产物里，此时必须走 unpacked 路径兜底与显式 schemaSql。
 * 本地 Node / dev 下返回 undefined，保持阶段 1 已验证的上游默认定位行为。
 */
function contextFromRuntime(): PackagingContext | undefined {
  const resourcesPath = process.resourcesPath
  if (!resourcesPath) return undefined
  try {
    return buildPackagingContext({
      isPackaged: true,
      resourcesPath,
      projectRoot: process.cwd()
    })
  } catch {
    return undefined
  }
}

async function main(): Promise<void> {
  const report = await runNikkiSyncLinkProbe(contextFromRuntime())
  for (const line of formatNikkiSyncLinkProbeReport(report)) {
    if (isNikkiSyncProbeErrorLine(line)) {
      console.error(line)
    } else {
      process.stdout.write(`${line}\n`)
    }
  }
  process.exitCode = report.ok ? 0 : 1
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error(`[fatal   ] probe crashed: ${message}`)
  process.exitCode = 1
})
