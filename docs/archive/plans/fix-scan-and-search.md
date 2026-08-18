# 修复三种扫描方式 + 搜索索引持久化（执行结果）

> 基于用户打包版日志 `D:/Users/Downloads/wxnn-logs-2026-08-15` 的根因分析与修复落地。
> 生成日期：2026-08-15。改动严格收敛在扫描/搜索链路，未引入任何新依赖。

## 一、根因结论（来自日志 + 源码交叉验证）

| Bug | 严重度                     | 根因                                                                                                                                                                                                                                     | 证据                                                                                                          |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A   | 高/确定                    | `search:exportIndex` 把临时目录建在 `search-index/` 内部，先 `rm(indexDir)` 把刚写好的 `.tmp` 一并删除，再 `rename` 必然 `ENOENT`                                                                                                        | 日志每次启动必现 `[Search] 全量重建失败: ENOENT: rename '...search-index\.tmp' -> '...search-index'`（5+ 次） |
| B   | 高/确定                    | `refreshPathGuardRoots` 仅注册 DB 的 `source_path`，**不注册** settings 的 `customScanPaths`；扫描前 `scanner:start` 也未把扫描根登记进 `pathGuard`，导致「自动定位游戏目录 / 增量扫描」的 `customKnownPaths` 被「路径不在白名单内」拦截 | 日志多次 `路径不在白名单内，禁止 读取 操作`（渲染进程 fault）                                                 |
| C   | 诊断后结论：**无需改代码** | 诊断测试证实 `findMediaDirectories` + `scanDirectory` 机制正常：给定正确目录能发现文件且 `source_path` 正确。用户日志中「扫描 1 个目录，发现 0 个媒体文件」发生在 **增量模式**（`增量模式: true`），是已索引文件的预期跳过行为           | `scan-diagnose.test.ts` 3/3 通过                                                                              |

## 二、已落地修改

### Bug A — `src/main/ipc/handlers/search-index-handler.ts`

- 临时目录由 `path.join(indexDir, '.tmp')` 改为 **兄弟目录** `path.join(app.getPath('userData'), 'search-index.tmp')`。
- `rm(indexDir)` 不再波及临时目录；`rename(tmpDir, indexDir)` 不再 `ENOENT`。
- `rename` 包 `try/catch`，失败时清理残留 `tmpDir` 并抛 `AppError.internal`，避免半写入状态。

### Bug B — `src/main/ipc/handlers/scanner-handler.ts`

- 在 `assertScanPathsAllowed(options)` **之前**插入扫描根登记：
  ```ts
  const scanRoots = [options?.path, ...(options?.customKnownPaths ?? [])]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => path.resolve(p))
  if (scanRoots.length > 0) pathGuard.registerRoots(scanRoots)
  ```
- 关闭「自动定位 / 增量扫描」因 `customKnownPaths` 未在白名单内被拦截的缺口；与 `dialog-handler` 的 `pathGuard.register` 行为一致（路径来自 dialog 选择或 settings，属用户显式授权，非任意路径提权）。

### Bug C — 诊断结论（无代码改动）

- 新增 `src/main/scanner/__tests__/scan-diagnose.test.ts`（真实 fixtures：NikkiPhotos 布局 + 中文相册 + <5KB 小图 + 非媒体文件）。
- `findMediaDirectories([fixture])` 返回正确目录；`scanDirectory(fixture, false, true)` 命中 3 张图片（<5KB 被过滤），`applyFilters=false` 命中 4 张。
- 结论：扫描机制本身正确，0 文件为增量跳过；真正需要修复的是 A + B。

## 三、依赖声明 / 启动说明 / 错误处理 / 参数校验 / 测试用例

- **依赖声明**：无新增依赖。复用 `electron` / `fs` / `zod` / `flexsearch` / `better-sqlite3` / 项目内 `pathGuard`（白名单）与 `wrapHandler`（参数校验）。
- **启动说明**：`npm install` → `npm run dev`（Electron 启动后观察日志应不再出现 `[Search] 全量重建失败` 与「路径不在白名单内」）。
- **错误处理**：Bug A 的 `rename` 失败兜底清理；Bug B 的 `registerRoots` 失败仅记日志不阻断扫描；`assertScanPathsAllowed` 失败仍广播 `scanner:complete` 避免前端卡死。
- **参数校验**：沿用 `scannerStartSchema`（`schemas.filePath` 等）；`customKnownPaths` 走 `schemas.filePath` 数组且上限 64；扫描根再经 `path.resolve` 归一化。
- **基础测试用例**：
  - `src/main/ipc/handlers/__tests__/search-index-handler.test.ts`（1 例）：断言 `rename` 目标为兄弟 `search-index.tmp`、索引落盘、`search-index.tmp` 不残留。
  - `src/main/ipc/handlers/scanner-handler.test.ts`（扩展 2 例）：带 `path + customKnownPaths` 时扫描前已 `registerRoots`，且无扫描根时不调用 `registerRoots`。
  - `src/main/scanner/__tests__/scan-diagnose.test.ts`（3 例）：发现 + 过滤 + 命中数回归。

## 四、验收（实测）

- `npx vitest run src/main/scanner/__tests__ src/main/ipc/handlers/__tests__/search-index-handler.test.ts src/main/ipc/handlers/scanner-handler.test.ts` → **4 文件 / 25 测试全绿**。
- `npx eslint`（改动文件）→ **0 error**（48 个中文硬编码 warning，属仓库既有风格，非本次引入）。
- `npx tsc --noEmit` → 改动文件无 type 错误。（`src/renderer/pages/settings/scan-sections.tsx` 的 `importRoot` 类型错误为独立进行中工作的既有问题，不在本次改动范围内。）

## 五、范围护栏

- 仅触碰：`search-index-handler.ts`、`scanner-handler.ts`、`worker-entry.ts`（仅新增 `scanDirectory` 导出以支持测试）、对应测试。
- 未触碰：设置页 UI、`import-handler`、`media-handler`、缩略图/解密/视频流水线等无关模块。
