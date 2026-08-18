# 修复打包版本"图库"板块不显示应扫描媒体

## 背景

打包安装版本中"图库"板块空白或大面积破图。根因有三：自动扫描空库（主因）、指定目录扫描被图库过滤（次因 A）、悬空缩略图未重建（次因 B）。本计划按优先级逐一修复，每步先验证通过再进入下一步。

## 依赖声明（五要素）

- **依赖声明**：复用现有 `fs`/`fs.promises`/`path`/`child_process`/`tinyglobby`/`../utils/constants`/`workerLog`/`shouldStop`/`ImportRootRepository`/`processThumbnailForRow`/`HandlerContext`/`schemas.filePath`。**新增依赖为 0**（无新 npm 包、无新 IPC 通道、无新数据库表）。
- **启动说明**：新增 `game-directory-discovery.ts` 为无副作用纯函数模块，导入即就绪；`findMediaDirectories` 返回 `string[]`，调用方（`worker-entry` L1319/L1361）无感。
- **错误处理**：单盘遍历异常 / vdf 读取失败 / 注册表查询失败均降级返回空，由其他路径/盘符兜底，不中断扫描；`import_roots` 登记失败仅 `logger.warn` 降级，不影响扫描成功返回。
- **参数校验**：`scanner:start` 经 `scannerStartSchema` + `assertScanPathsAllowed` 校验（`schemas.filePath` 为 `z.string().min(1)`，空字符串直接被拒）；`getUserDataPaths` 对 `process.env` 缺失做兜底。
- **基础测试**：`worker-entry.findMediaDirectories.test.ts`（桩替换 discovery 模块）、`scanner-handler.test.ts`（import_roots 登记 5+ 用例）。

## 子任务

### A 核心修复（主因）— `src/main/scanner/worker-entry.ts` + 新增 `game-directory-discovery.ts`

`findMediaDirectories()` 原实现将"自定义路径"与"自动发现"并入同一 `Set`，导致两个缺陷：

1. 早退条件 `found.size > 0` 把"存在但无暖暖媒体的自定义路径"也计入，抑制全盘签名搜索 → 只扫 1 个错误目录、发现 0 文件。
2. 末尾 `infinitynikki` 软过滤作用于整个 `found`，当用户配置的不含该关键字自定义路径与含该关键字的自动发现目录共存时，自定义路径被整体挤出结果。

修复：拆分为 `customSet`（自定义路径，恒包含）与 `autoSet`（自动发现）。早退判断仅基于 `autoSet.size`；软过滤只作用于 `autoSet`；最终返回 `[...customSet, ...filteredAuto]`（去重）。将 6 个发现函数抽取至 `game-directory-discovery.ts` 以便 `vi.mock` 桩替换。

### B 单元测试（主因）

新增 `src/main/scanner/__tests__/worker-entry.findMediaDirectories.test.ts`，6 例：错误/空自定义路径不抑制自动发现；正确自定义路径恒包含；不含 `infinitynikki` 的自定义路径不被丢弃；含 `infinitynikki` 自动目录时自定义路径仍保留；无自定义路径时与原软过滤行为一致；无 `infinitynikki` 命中时回退保留全部。

### C 验证+测试（次因 A）— `src/main/ipc/handlers/scanner-handler.ts`

既有 L84-97 `import_roots` 登记实现已正确（守卫 `result.success && options?.path`、try/catch 降级、`await` 在 `notifyMediaUpdated` 之前、复用 `ImportRootRepository.addImportRoot`）。无需改实现，仅扩展 `scanner-handler.test.ts` 至 6 例，新增"空 path 被 zod 校验拒绝、不登记"用例。

### D 修复（次因 B）— `src/main/app/startup-tasks.ts`

`cleanupAndRepairDatabase` 的 `rowsToRepair` 原仅修复 `width/height` 为空或 `thumbnail` 为 NULL 的记录。新增分支：阶段一检测 `thumbnail` 非空但对应文件不存在的悬空缩略图，记入 `danglingThumbnailIds`，阶段二 `rowsToRepair` 过滤纳入该集合，复用 `processThumbnailForRow` 重建。仅对源文件有效的记录判定，避免对正常记录重复调用 sharp/ffmpeg。

### E 文档与全量验证

本文档 + `fix-gallery-not-displaying-progress.md`；执行 `npm run typecheck`、`npm run lint`、相关 vitest 全部通过。

## 改动范围

3 个源文件（`worker-entry.ts`、`scanner-handler.ts` 仅验证、不变、`startup-tasks.ts`）+ 1 个新模块（`game-directory-discovery.ts`）+ 2 个测试文件 + 2 个文档。`findMediaDirectories` 返回契约不变，blast radius 小。

---

## 完成状态（合并自 fix-gallery-not-displaying-progress.md）

> 归档日期：2026-08-17。全部子任务已完成并通过验证。

| 子任务              | 状态 | 结果摘要                                                                                                                     |
| ------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| A 主因核心修复      | ✅   | `findMediaDirectories` 双集合拆分（`customSet` 恒包含 + `autoSet` 软过滤），6 个发现函数抽取至 `game-directory-discovery.ts` |
| B 主因单元测试      | ✅   | `worker-entry.findMediaDirectories.test.ts` 6 例全绿                                                                         |
| C 次因 A 验证+测试  | ✅   | `import_roots` 登记实现确认正确，`scanner-handler.test.ts` 补至 13 例全绿                                                    |
| D 次因 B 悬空缩略图 | ✅   | `startup-tasks.ts` 新增悬空缩略图检测分支，复用 `processThumbnailForRow` 重建                                                |
| E 文档与全量验证    | ✅   | typecheck 无错误；lint 0 error；相关单测全绿（6 + 13 + 36 例）                                                               |

## 附：关联计划摘要（合并自 fix-custom-scan-gallery-visibility.md）

**问题**：「指定目录」扫描 toast 报数正常，但图库板块不显示扫描到的文件。

**根因**：图库查询 WHERE 只放行游戏 HQ 路径或 `import_roots` 已登记根目录前缀的文件；而「指定目录」扫描从不登记 import root，文件入库后被整体排除。

**修复**：`scanner:start` 成功且携带显式 `path` 时，复用 `ImportRootRepository.addImportRoot()`（幂等 `INSERT OR IGNORE`）登记该目录。零新增依赖 / IPC 通道 / 数据库表。登记失败 try/catch 降级为 `logger.warn`，不阻断扫描成功返回；`await` 登记完成后才 `notifyMediaUpdated()`。

**验证**：`scanner-handler.test.ts` 5 例（带 path 登记、无 path 不登记、登记失败不阻断、扫描失败不登记、重复扫描幂等）。

**已否决方案**：放宽 HQ 过滤（破坏产品语义）、把 `customScanPaths` 登记进 `import_roots`（配置可随时增删，归属歧义）。
