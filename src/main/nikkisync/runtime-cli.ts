/**
 * 内嵌 NikkiSync Runtime 的无 UI 验证入口（整合阶段 2）——刻意保持薄壳：
 * 参数解析与文本形态都在 `runtime-cli-report.ts`（两者均有单测），本文件只做
 * “跑流程（start → scan → query → stop）→ 分流 stdout/stderr → 定退出码”。
 *
 * 与 `probe-cli.ts` 同样的存在理由：作为 electron-vite main 的独立入口，它经与真实
 * 主进程完全相同的 CJS 打包管线产出，因此可在一台没有 GUI 的机器上一并验证四件事——
 *   1. 变量式动态 import 未被折叠成 `require()`（否则即 ERR_REQUIRE_ASYNC_MODULE）；
 *   2. 库文件能被上游 `DatabaseManager` 建出全部业务表；
 *   3. 上游 game-directory-discovery + ScannerService 确实发现并入库；
 *   4. `SyncReadRepository` + `row-mappers` 的查询面可用（含 motion_photo 聚合）。
 *
 * 运行方式：
 *   - 本地 Node：npx tsx src/main/nikkisync/runtime-cli.ts --game-root=<安装根>
 *   - 打包产物 + Electron：
 *     ELECTRON_RUN_AS_NODE=1 electron.exe dist/main/main/app/nikkisync-runtime.js --game-root=<安装根>
 */

import path from 'node:path'
import { buildPackagingContext } from './embedding-paths'
import { createManagerDependencies } from './runtime-facade'
import { createRuntimeManager } from './runtime-manager'
import {
  formatRuntimeRunLines,
  isRuntimeRunErrorLine,
  parseRuntimeCliArgs,
  type RuntimeRunSummary
} from './runtime-cli-report'
import type { NikkiSyncSessionOptions } from './runtime-types'

async function main(): Promise<void> {
  const args = parseRuntimeCliArgs(process.argv.slice(2))
  const options: NikkiSyncSessionOptions = {
    databaseFile: path.join(args.dataDir, 'nikkisync.db'),
    watcher: args.watcher,
    projectRoot: process.cwd(),
    ...(args.gameRoot ? { gameRoot: args.gameRoot } : {}),
    packagingContext: buildPackagingContext({ isPackaged: false, projectRoot: process.cwd() })
  }
  const logs: string[] = []
  const manager = createRuntimeManager(
    createManagerDependencies(options, (_level, message) => logs.push(message))
  )

  const status = await manager.start(options)
  const summary: RuntimeRunSummary = {
    ok: status.state === 'running',
    state: status.state,
    dbPath: status.dbPath,
    linkReady: status.linkReady,
    tables: status.tables?.length ?? 0,
    ...(status.error ? { error: status.error } : {})
  }

  if (status.state === 'running') {
    const scan = (await manager.scan({})) as { filesObserved?: number; assetsCreated?: number }
    summary.filesObserved = scan.filesObserved
    summary.assetsCreated = scan.assetsCreated
    const page = (await manager.listAssets({ limit: args.limit })) as {
      items: Array<{ assetId?: string; type?: string }>
    }
    summary.assets = page.items.length
    summary.motionAssets = page.items.filter((item) => item.type === 'motion_photo').length
    summary.firstAssetId = page.items[0]?.assetId
  }

  // 本阶段不启 LAN 服务，停止链只有 scanner + 库
  await manager.stop()
  if (!summary.ok && !summary.error && logs.length > 0) summary.error = logs[logs.length - 1]

  for (const line of formatRuntimeRunLines(summary)) {
    if (isRuntimeRunErrorLine(line)) {
      console.error(line)
    } else {
      process.stdout.write(`${line}\n`)
    }
  }
  process.exitCode = summary.ok ? 0 : 1
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error(`[fatal   ] runtime cli crashed: ${message}`)
  process.exitCode = 1
})
