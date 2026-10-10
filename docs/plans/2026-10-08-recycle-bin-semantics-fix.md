# 修复计划：删除功能与回收站功能不可用（最终版 · 已执行完毕）

> 本文为 2026-10-08 轮次快照，当前口径以主规约文档为准（生命周期/约定见根 AGENTS.md 与 docs/CODING_CONVENTIONS.md；通道见 docs/IPC_CONTRACT.md）。
> 仓库：`D:/Zcode项目/WXNN XiangCe`（wxnn-photo-manager v2.5.3）
> 方案 A（用户已拍板）：软删除 = 纯数据库标记（`is_deleted=1` + `delete_origin='user'`），文件原地保留不动；恢复 = 翻转标记即完好还原；彻底删除/清空回收站 = `fsp.unlink` 真删文件 + 硬删 DB；右键「永久删除」不变。

---

## 一、根因分析（5 个叠加缺陷，已逐行读源码核实）

| 编号   | 缺陷                                                                                                                                  | 位置                                                                                                                  | 用户可感知症状                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **D1** | 软删除用 `shell.trashItem` 把文件移入 **Windows 系统回收站**，而 Electron 无还原 API → 回收站「恢复」只能翻转 DB 标记，文件实体回不来 | `useFileOperations.ts`（单文件/批量）→ `file.ts:21-29` → `file-service.ts:47-64`；恢复侧 `media-lifecycle-handler.ts` | 恢复后缩略图裂图、打开失败、被完整性校验标 `is_missing=1` |
| **D2** | 重扫 UPSERT 无条件把游戏目录树记录复位 `is_deleted=0`                                                                                 | `worker-entry.ts` `saveBatchToDatabase` 的 ON CONFLICT 复位分支                                                       | 删了又回来（方案 A 后游戏目录树软删记录每轮扫描必复活）   |
| **D3** | 详情页 / 全屏查看器删除走 `media:delete` = **硬删 DB 行**，记录根本进不了回收站                                                       | `DetailPage.tsx`、`FullscreenViewer.tsx` → `media-lifecycle-handler.ts:33-48`                                         | 从详情页删的照片，回收站里找不到                          |
| **D4** | 回收站页空依赖 `useEffect` + App keep-alive 保活 + 不订阅 `media:updated` → 只在首次挂载拉一次数据                                    | `RecycleBinPage.tsx:75-77`；`App.tsx` `display:none` 保活                                                             | 回收站列表长期为空/陈旧                                   |
| **D5** | `media:emptyRecycleBin` 在渲染端 ConfirmDialog 之外**又弹一次主进程原生确认框**，取消即 `AppError.canceled`                           | `media-lifecycle-handler.ts`                                                                                          | 弹两次框；点取消弹红色错误 Toast"清空失败"                |

### 已排除项

handler 未注册 / 通道名拼写不一致 / id 类型不匹配 / worker bridge 等待逻辑 / SQL 列名 / 分页恒空——全部核对无问题，属存量缺陷而非"刚改坏"。

---

## 二、依赖声明

**不新增、不变更任何依赖包。** 全部复用仓库既有能力：

| 复用项                                                                 | 位置                                                                                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 幂等加列迁移 `safeEnsureColumn()`                                      | `src/main/database/connection.ts`                                                                    |
| 批量物理删 + 三态 + 熔断 `unlinkBatch`                                 | `src/main/ipc/handlers/_trash-utils.ts`                                                              |
| 缩略图清理 `cleanupThumbnailsForRows` / `makeNativeThumbRecordCleaner` | `_trash-utils.ts`                                                                                    |
| 事件订阅 `onUpdated: (cb) => subscribe('media:updated', cb)`           | `src/main/preload/api/media.ts:66`                                                                   |
| 测试基建                                                               | `tests/mocks/mock-validator.ts`、`_test-helpers.ts` 范式（`makeCtx`/`getHandler`）、`tests/setup.ts` |

---

## 三、启动与运行说明

```bash
npm install                 # node_modules 已存在则跳过
npm run dev                 # electron-vite 开发启动
npm run build               # 全量构建
npm run dist:win            # 打包 NSIS 安装包
```

**功能自检路径**：

1. 图库右键删除 → 图库消失、资源管理器里文件仍在（D1）。
2. 回收站可见；恢复 → 回图库、缩略图正常、能打开。
3. 再删 → 回收站「彻底删除」→ 资源管理器文件消失（磁盘释放）。
4. 触发完整扫描 → 回收站条目不复活（D2）。
5. 详情页/全屏删除 → 进入回收站（D3）。
6. 回收站切页再切回 → 数据刷新（D4）。
7. 「清空回收站」只弹一次渲染端确认框（D5）。

**日志位置**：主进程 `logs/main-YYYY-MM-DD.log`；渲染层 DevTools Console。

---

## 四、错误处理机制

| 层                            | 机制                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| IPC 主进程                    | `wrapHandler`/`wrapHandlerNoArgs` 统一捕获转 `IpcError`；D5 修复后 emptyRecycleBin 无取消路径                                         |
| preload                       | `call<T>()` 成功只回传 `data`、失败抛 `IpcError`；渲染端禁止读 `result.success`（`media:softDelete` 真返回 `success:true`，读之合法） |
| 软删失败（DB 锁/worker 超时） | `useStagedTask.run()` 捕获 → `phase='error'` → Toast 透传 message；失败项保留供重试                                                   |
| 彻底删除部分失败              | `failedCount > 0` → 抛 `InternalError(r.message)`；失败项 DB 记录保留（`is_deleted=1`）供重试                                         |
| 恢复失败                      | `RecycleBinPage.handleRestore` catch → Toast + 「重试」按钮                                                                           |
| 清空空回收站                  | 返回"回收站为空"提示，按成功处理不报错                                                                                                |
| 日志                          | `unlinkBatch` 失败聚合一条 warn（失败数 + 3 条样例路径），禁止刷屏                                                                    |

---

## 五、参数校验规则（沿用 `src/main/ipc/validator.ts`，无新增）

| 通道                                                       | 校验                                            | 边界/非法值                                                      |
| ---------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| `media:softDelete`/`media:restore`/`media:permanentDelete` | `schemas.mediaIdArrayBulk`（正整数数组 min(1)） | 空数组 → repository 早 return；NaN/非正整数 → `VALIDATION_ERROR` |
| `media:delete`                                             | `schemas.mediaId`                               | 同上                                                             |
| `media:emptyRecycleBin`                                    | `wrapHandlerNoArgs`                             | 无入参                                                           |
| `media:list`（回收站取数）                                 | `pageSize ≤ 500`、`deletedOnly`、`cursor`       | 回收站固定 `pageSize=200`、首页 `cursor=null`                    |
| 文件路径（永久删除）                                       | `assertMediaDeletePath` 三级校验                | 未授权路径 → `IPC_PATH_FORBIDDEN`，脱敏仅留末 2 段               |

渲染层 id 契约：`MediaFile.id` 为 `string`，调主进程前统一 `Number(id)`。

---

## 六、子任务清单与执行记录（严格 TDD，全部完成）

执行顺序：T0 → T1 → T2 → T3 → T4 → T5 → T6。每步「红灯 → 修复 → 绿灯」闭环。

### T0 — 迁移：`media_files` 新增 `delete_origin` 列 ✅

- **目标文件**：`src/main/database/connection.ts`（`migrateDeleteOrigin()` 挂入 `runMigrations()`）
- **测试**：`connection.test.ts` 2 用例（列存在 + 幂等），**全绿**

### T1 — Repository：软删/恢复写入 `delete_origin` ✅

- **目标文件**：`src/main/database/media-repository.ts`（`softDeleteBatch`→'user'、`restoreBatch`→NULL、`softDeleteForPermanentDelete`→'user'+单引号 datetime、`softDeleteByRootPath`→'root'）
- **测试**：`media-repository.test.ts` 5 用例 + MockDatabase DDL/fixture 补列，**全绿**（298/298）

### T2 — 扫描器：复位谓词排除用户主动软删（D2 核心） ✅

- **目标文件**：`src/main/scanner/rescan-restore-sql.ts`（谓词修正为 `游戏目录树 AND COALESCE(delete_origin,'') <> 'user'`）、`src/main/scanner/worker-entry.ts`（删除本地常量改为 import `RESCAN_RESTORE_PREDICATE`）
- **红灯**：`delete_origin='user'` 的游戏目录树记录被重扫复活（`is_deleted` 复位为 0）——D2 精确复现
- **测试**：新建 `src/main/scanner/__tests__/rescan-restore-sql.test.ts` 4 用例（user 不复活 / root 复位 / NULL 存量复位 / 导入根不受影响），用 Node 26 内置 `node:sqlite` 真实执行含谓词的 UPSERT（better-sqlite3 为 Electron ABI 无法在 Node 测试环境加载，经 `createRequire` 运行时加载内置引擎绕开 vite 5 无法外部化实验模块的限制）
- **配套改写**：`scan-worker-recovery.test.ts` 正则断言纳入新谓词 + 空白归一化
- **验收**：13/13 全绿 + typecheck 通过

### T3 — 软删除不再搬动文件（D1） ✅

- **目标文件**：`src/renderer/hooks/useFileOperations.ts`（单文件与批量分支移除 `api.file.delete` 调用；批量分支 `pathById` 改为 `knownIds` 脏 id 防御集合）
- **红灯**：4 用例失败（`file.delete` 仍被调用 / softDelete 未被调用）
- **测试改写**：`useFileOperations.test.ts`——成功用例断言 `file.delete` 不被调用 + Toast 取 `dbRes.message`；失败用例改写为 softDelete 失败版；兜底用例 mock 改 `softDelete.mockRejectedValue`；新增批量用例
- **验收**：42/42 全绿（含 deleteProgress / restore-undo 回归）

### T4 — 详情页/全屏查看器删除改为软删（D3） ✅

- **目标文件**：`src/renderer/pages/DetailPage.tsx`、`src/renderer/components/gallery/FullscreenViewer.tsx`（`file.delete` + `mediaAction.delete` → `mediaAction.softDelete`；删除后 store 移除/跳回图库/索引回退/关闭全屏逻辑全部保留）
- **红灯**：两组件各 1 用例失败（softDelete 未被调用）
- **测试**：新建 `DetailPage.softDelete.test.tsx`、`FullscreenViewer.softDelete.test.tsx` 各 2 用例
- **验收**：13/13 全绿（含两组件既有 favorite/prefetch 回归）

### T5 — `media:emptyRecycleBin` 移除主进程二次弹窗（D5） ✅

- **目标文件**：`src/main/ipc/handlers/media-lifecycle-handler.ts`（受保护路径，文件首行已放置 `// @core-change: 清空回收站移除主进程 dialog 二次确认，与 media:permanentDelete 对齐，消除重复弹窗与取消误报 IPC_CANCELED`）
- **红灯**：新建 `media-lifecycle-handler.test.ts` 与改写后的 `media.test.ts` 用例均失败（`showMessageBox` 仍被调用）
- **配套**：`media.test.ts`「用户取消时抛 canceled」改写为「不弹原生确认框，任意响应下直接清空」；`docs/IPC_CONTRACT.md` §2.8 同步更新
- **验收**：87/87 全绿

### T6 — 回收站页面数据刷新（D4） ✅

- **目标文件**：`src/renderer/pages/RecycleBinPage.tsx`
- **改动**：① 首次挂载必拉取 + `currentView` 变回 `'recycle-bin'` 时重新拉取（`isFirstMountRef` 保证独立挂载/测试场景时序兼容）；② 订阅 `media:updated` 广播（可选调用 `onUpdated?.()`，当前视图为回收站时重新拉取，卸载时退订）
- **红灯**：2 用例失败（无订阅、无视图切换刷新）
- **测试**：新建 `RecycleBinPage.refresh.test.tsx` 2 用例（广播刷新 / 视图切回刷新）
- **验收**：21/21 全绿（含 empty/restore/permanentDelete/thumb 全部既有回归；源码结构性断言约束保持：无 `result.success`、保留 `await loadRecycleBin()`/`await refreshMedia()`/`recycleBin.emptySuccess`、无 `fetchMediaFromDatabase`）

### 明确不做（边界）

- `file-service.ts` `moveToRecycleBin` 部分成功报全失败问题（方案 A 后 `file:delete` 已无渲染层调用方，且 `src/main/services/**` 为受保护路径，收益低）
- `vite-env.d.ts` / `electron-api.ts` 类型漂移（纯类型层、无运行时影响，登记技术债）
- 详情页/全屏删除新增撤销入口（最小化改动）

---

## 七、基础测试用例设计（正常 / 异常 / 边界）

| 场景档 | 用例                                                       | 落点                                                     |
| ------ | ---------------------------------------------------------- | -------------------------------------------------------- |
| 正常   | 软删→回收站可见→恢复→图库可见且文件可读→彻底删除→文件消失  | T2/T3/T4 + 手工自检 1-4                                  |
| 正常   | 清空回收站只弹一次确认框、成功清空并刷新                   | T5 + 手工自检 7                                          |
| 异常   | `softDelete` 失败 → Toast 报错，记录不移除、不 pushHistory | T3                                                       |
| 异常   | `softDelete` reject → Toast 兜底文案                       | T3                                                       |
| 异常   | 彻底删除部分失败 → "已彻底删除 N 项，M 项失败"，失败项保留 | `media.test.ts` 既有用例（未弱化）                       |
| 异常   | 恢复失败 → Toast + 「重试」按钮                            | `RecycleBinPage.restore.test.tsx` 既有                   |
| 边界   | 空 id 数组 → repository 早 return                          | `media-repository.test.ts` 既有                          |
| 边界   | 回收站为空时清空 → 提示为空且不报错                        | `media-lifecycle-handler.test.ts` / `media.test.ts` 既有 |
| 边界   | `delete_origin IS NULL` 存量记录 → 重扫行为与修复前一致    | T2                                                       |
| 边界   | 非游戏目录树（导入根）的用户软删 → 不被复活                | T2                                                       |

---

## 八、关键文件清单

**生产代码（8）**：`src/main/database/connection.ts`、`src/main/database/media-repository.ts`、`src/main/scanner/worker-entry.ts`、`src/renderer/hooks/useFileOperations.ts`、`src/renderer/pages/DetailPage.tsx`、`src/renderer/components/gallery/FullscreenViewer.tsx`、`src/main/ipc/handlers/media-lifecycle-handler.ts`、`src/renderer/pages/RecycleBinPage.tsx`

**新增源文件（1）**：`src/main/scanner/rescan-restore-sql.ts`（重扫复位谓词唯一真源，T2）

**文档（1）**：`docs/IPC_CONTRACT.md`（§2.5 / §2.8 语义同步，详见 §十）

**新增测试（5）**：`src/main/scanner/__tests__/rescan-restore-sql.test.ts`、`src/main/ipc/handlers/media-lifecycle-handler.test.ts`、`src/renderer/pages/DetailPage.softDelete.test.tsx`、`src/renderer/components/gallery/FullscreenViewer.softDelete.test.tsx`、`src/renderer/pages/RecycleBinPage.refresh.test.tsx`

**配套改写测试（3）**：`scan-worker-recovery.test.ts`、`media.test.ts`、`useFileOperations.test.ts`（含 `connection.test.ts` / `media-repository.test.ts` 的 T0/T1 配套）

---

## 九、全局校验（终止条件）

```bash
npm test          # vitest 全量
npm run test:main
npm run test:db
npm run verify    # typecheck + lint + prettier + core-path-gate（只读）
npm run build     # 构建通过
```

未通过全部回归与全局校验，任务不得标记完成。

---

## 十、提交前审查补记（2026-10-08 复审，P1–P4）

本计划执行完毕后经过一轮全面审查，发现并修掉 4 项问题（本文件原位于仓库根 `fix-delete-recycle-plan.md`，现按仓库惯例归位本目录并加日期前缀）。

| 编号   | 问题                                                                                                                                                                                                                                                                                                              | 修复                                                                                                                                                                                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | `__tests__/rescan-restore-sql.test.ts` 在模块顶层 `nodeRequire('node:sqlite')`。`node:sqlite` 需 Node ≥ 22.5，而 `.node-version` 与 `.github/workflows/build.yml` 的 5 个 job 全部钉 Node 20 → CI `test` + `coverage` job 会以 `Cannot find module` 失败并连带阻断 `build`；本机 Node 24 无法暴露                 | 能力探测：`try { SqliteCtor = nodeRequire('node:sqlite').DatabaseSync } catch`，不可用时 `console.warn` 明确指路（当前 Node 版本 / 需 ≥ 22.5 / CI 属预期降级 / 本地复核口径），4 条语义用例整体包进 `describe.runIf(hasSqliteEngine)`                             |
| **P2** | 同文件 3 处把**值** `DatabaseSync` 用在类型位置（TS2749）。`src/main/tsconfig.json` 的 `exclude: ["**/*.test.ts"]` 使 `npm run typecheck` 看不见它，属潜伏缺陷                                                                                                                                                    | 类型位置统一改用 `import type { DatabaseSync as DatabaseSyncType }`；以隔离 `tsc` 复核：3 处 TS2749 → 0                                                                                                                                                           |
| **P3** | `docs/IPC_CONTRACT.md` §2.9 仍称 `media:delete` 的调用方含「详情页与全屏查看器的删除（源文件先移入系统回收站）」——D3 后为假；§2.5 返回值块缺 `success: true`，而现有 4 个渲染端调用方读它（`useFileOperations.ts:305/:379`、`DetailPage.tsx:205`、`FullscreenViewer.tsx:184`），违反 §1.1 的双层 success 同步义务 | §2.9 改为「仅永久删除链路调用，详情页/全屏已改走 §2.5」；§2.5 补 `success: true`、4 个调用方、软删不搬文件的语义与 `delete_origin` 三态复位口径；并登记 preload 侧 `call<{ message: string }>` 缺 `success` 的类型漂移（属 DEBT-011/012，本次不改受保护路径代码） |
| **P4** | 计划文件落在仓库根且未入库；根 `*.md` 在 prettier 闸门内（`*.{ts,js,json,md}` 仅匹配仓库根），提交时会被 `prettier --write` 静默改写；第八节「修改（8）」实际列了 10 项                                                                                                                                           | `git mv` 归位 `docs/plans/`（不在闸门格式范围），第八节按「生产代码 8 / 新增源文件 1 / 文档 1」重新分类                                                                                                                                                           |

**新增的无引擎依赖结构断言（P1 的配套，非替代）**：语义档在 Node 20 上必然跳过，若只留语义档则该谓词在 CI 上无人看守；兄弟用例 `scan-worker-recovery.test.ts` 的正则只断言「谓词接进 UPSERT 两条 CASE 臂」，**看不见布尔优先级**。以 `topLevelOperators()`（跳过 `'…'` 字面量含 `''` 转义、维护括号深度、词边界防 `RANDOM`/`ORACLE` 误判）断言：游戏树条件顶层无布尔算符、拼出的谓词恰一个顶层 `AND`、右操作数锁定 `COALESCE(delete_origin, '') <> 'user'`。

**红-绿取证（本机 Node，三变异 + 一档降级）**：

| 变异                                        | 结构断言     | 语义档                        | `scan-worker-recovery`    |
| ------------------------------------------- | ------------ | ----------------------------- | ------------------------- |
| A：删掉游戏树条件外层括号（`A OR B AND C`） | 3 条变红     | `user` 用例变红（照片被复活） | **仍全绿** ← 补测立论依据 |
| B：删掉 ` AND COALESCE(...)` 整句           | 3 条变红     | `user` 用例变红               | 变红                      |
| C：`<>` 改为 `=`                            | 右操作数变红 | 3 条变红                      | —                         |
| 假模块名模拟 Node 20                        | 7 条全绿     | 4 条 skipped + warn           | 全绿，退出码 0            |

还原生产文件后复跑：`rescan-restore-sql.test.ts` + `scan-worker-recovery.test.ts` = 15 passed。

**版本与打包结论**：`package.json:3` / `ARCHITECTURE.en.md:1628` / `DEVELOPMENT.en.md:5` 均已为 `2.5.3`，安装包名 `NikkiGallery-Setup-${version}` 仅取 `package.json`，`scripts/check-doc-versions.ts` 只校验 README 的 Electron 版本 → **本次无需任何版本改动**，直接 `npm run dist:win` 重新打包。
