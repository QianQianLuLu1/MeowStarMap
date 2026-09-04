# 修复计划：删除功能统一报错「参数校验失败:[0] mediaId 数组长度上限1000」

> 日期：2026-08-23 ｜ 影响 版本：v2.3.5 ｜ 状态：**已实施并验证**
> 涉及板块：图库、图片导入、缓存、重复文件（及其共用的批量操作/回收站链路）

---

## 1. 背景与现象

打包版本中，图库 / 图片导入 / 缓存 / 重复文件板块执行"删除"（及同族的批量操作）时，统一弹出：

```
参数校验失败:[0] mediaId 数组长度上限1000
```

（`mediaId` 即 media id 的口语化误称，实为 IPC 参数校验对 mediaId **数组**的长度限制。）

## 2. 根因分析

### 2.1 报错产生机制

- 主进程 IPC 统一校验器 `wrapHandler`（`src/main/ipc/validator.ts:331-365`）对 handler 位置参数做 zod 校验；失败时按 `[参数位置] <文案>` 拼接消息并经 i18n key `main.validator.paramValidationFailed` 包装为「参数校验失败:[0] …」。
- 上限来源：`schemas.mediaIdArray`（`src/main/ipc/validator.ts:62-68`）的 `.max(1000)`，常量 `MAX_MEDIA_ID_ARRAY_SIZE = 1000`（`src/main/utils/constants.ts:31`），文案 key `main.validator.mediaIdsMaxLength`。

### 2.2 触发链路（旧版构建 ≤ 2026-08-21）

渲染进程一次性向 IPC 传入 **>1000 个 mediaId 的数组**：

| 板块        | 触发点                                                                                                             | 说明                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 重复文件    | `DuplicatesPage.performDelete`（`src/renderer/pages/DuplicatesPage.tsx:522`）将选中 id 全量传给 `media:softDelete` | 「全部应用策略」（`applyStrategyToAll`，:472-489）收集全库重复项 id，轻易超过 1000 |
| 图库 / 缓存 | 旧版批量删除全量传数组；缓存视图复用 GalleryPage                                                                   | 现 HEAD 已改为逐条 IPC（`useFileOperations.deleteFilesBatch`，并发 5）             |
| 图片导入    | 向导本身无删除 IPC，报错来自与其余板块共用的受限通道                                                               | 现 ImportWizard 仅本地 Set 增删选择，无 mediaId 数组调用                           |

### 2.3 版本考古（关键结论）

- 报错文案「mediaId 数组长度上限 {{max}}」只存在于 2026-08-21 及更早提交（c2aa404 / 8fe0e92）的 `zh-CN.json`；当前文案已改为「mediaIds 数量超过上限 {{max}}」。
- 当前 HEAD（fac0fbc，2026-08-23）已完成主体修复：新增无上限 `schemas.mediaIdArrayBulk`（`validator.ts:75-77`，保留 `min(1)` 与正整数元素校验），`media:softDelete` / `media:restore` / `media:permanentDelete` 三通道已切换（`src/main/ipc/handlers/media-lifecycle-handler.ts:170/183/193`）。
- 下游 `media-repository` 早已通过 `sql-chunk` 的 `chunkArray`（500/批）+ `runChunkedTransaction` 分片执行事务，可承接任意长度数组——放开 IPC 层上限不引入 SQL 变量数风险。
- **用户安装的是修复前的旧安装包**（2026-08-23 10:56 的 release 产物已含主体修复）。

### 2.4 本次发现的残留缺口（修复不彻底会换个文案复现）

`profile:transferFiles`（`src/main/ipc/handlers/profile-handler.ts:103`）仍使用带 1000 上限的 `schemas.mediaIdArray`。图库/缓存板块批量「转移到档案」在 `src/renderer/hooks/useBatchOperations.ts:307` 一次性传入全部选中 id，>1000 个即报 `[0] mediaIds 数量超过上限 1000`。其下游 `transferFilesToProfile`（`src/main/database/media-repository.ts:1452-1458`）已按 500 分片跑事务，切换 schema 完全安全。

## 3. 修复方案总览（最小修改）

| #   | 改动                                                                                       | 文件                                                    | 性质         |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------ |
| 1   | `profile:transferFiles` 的 schema 由 `mediaIdArray` 切换为 `mediaIdArrayBulk`（+2 行注释） | `src/main/ipc/handlers/profile-handler.ts`              | 1 行核心改动 |
| 2   | 新增回归测试（真实 zod 校验路径，防回退）                                                  | `src/main/ipc/handlers/profile-handler.test.ts`（新建） | 测试         |
| 3   | 本修复计划文档                                                                             | `docs/plans/2026-08-23-fix-mediaid-array-limit-1000.md` | 文档         |

**不修改项**（最小修改原则，逐项登记于 §9）：

- `media:analyzeSceneTime`：仍用 capped schema（`.optional()`），但渲染端仅无参调用（`CategoriesPage.tsx:459`、`scan-sections.tsx:146`），无 >1000 调用方。
- 前端不做分批改造：主进程 bulk schema + SQL 分片已承接全量数组（Electron IPC 结构化克隆可承载数万元素）。
- `src/main/utils/ipc-validate.ts` 残留的旧版手写校验器 `validateMediaIdArray`：无 handler 调用方，不动。
- `import:run` / `file:*` 的路径数组 1000 上限：属「路径数组长度上限」另一族文案、且导入非删除功能，不在本次范围。

## 4. 子任务拆解

| 任务            | 修改文件                                                | 输入条件                                                         | 预期输出                                                                                             | 验收标准                                                                                                         | 状态                                                  |
| --------------- | ------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Task 0 基线验证 | 无                                                      | 当前 HEAD                                                        | 基线全绿结论                                                                                         | `npx vitest run src/main/ipc/validator.test.ts` 6 用例全过；`npm run typecheck` 无报错                           | ✅ 通过                                               |
| Task 1 核心修复 | `src/main/ipc/handlers/profile-handler.ts:103`          | `z.tuple([schemas.mediaIdArray, schemas.uid])`                   | `z.tuple([schemas.mediaIdArrayBulk, schemas.uid])`                                                   | typecheck 无报错；grep 确认删除/转移类通道无 capped `mediaIdArray` 引用（analyzeSceneTime 除外）                 | ✅ 通过                                               |
| Task 2 回归测试 | `src/main/ipc/handlers/profile-handler.test.ts`（新建） | 1500/3000 个合法 id + 合法 uid；空数组；非法元素；目标档案不存在 | 5 个用例：批量通过且全量下发 repo；非法输入返回 `IPC_VALIDATION_ERROR`；档案缺失返回 `IPC_NOT_FOUND` | `npx vitest run src/main/ipc/handlers/profile-handler.test.ts` 全过；**变异验证**：回退 schema 后 2 用例必然失败 | ✅ 通过（变异验证：回退时 2 failed，恢复后 5 passed） |
| Task 3 全量回归 | 无（只运行）                                            | Task 1/2 完成后的工作区                                          | 全量验证结论                                                                                         | `npm run typecheck`、`npm run lint`、`npm test` 全部通过，无新增失败                                             | ✅ 通过（187 文件 / 3570 用例）                       |
| Task 4 计划文档 | `docs/plans/2026-08-23-fix-mediaid-array-limit-1000.md` | 本文档                                                           | 含依赖声明/启动说明/错误处理/参数校验/基础测试用例 5 个强制章节                                      | 文档存在且章节齐全                                                                                               | ✅ 完成                                               |
| Task 5 构建打包 | 无（产出构建物）                                        | 修复后源码                                                       | 新 `release/NikkiGallery-Setup-2.3.5.exe`                                                            | `npm run dist` 成功完成                                                                                          | ✅ 完成（见 §10 验证记录）                            |

执行纪律：每个任务验证通过后才进入下一个（分步验证记录见 §10）。

## 5. 依赖声明

**零新增依赖**（package.json 无任何变更）。全部复用项目内既有设施：

| 复用项                                                           | 位置                                                             | 用途                                                            |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `schemas.mediaIdArrayBulk`                                       | `src/main/ipc/validator.ts:75-77`                                | 无 1000 上限、保留元素级校验的批量 schema（本次唯一切换目标）   |
| `wrapHandler` + `IPC_ERROR_CODES`                                | `src/main/ipc/validator.ts` / `src/shared/types/ipc-types.ts`    | 统一校验与错误响应包装（不动）                                  |
| `chunkArray`（500/批）+ `runChunkedTransaction`                  | `src/main/database/sql-chunk.ts` / `media-repository.ts:313-330` | 下游 SQL 分片事务，放开 IPC 上限的安全性依据（不动）            |
| vitest mock 范式（`vi.hoisted` + mock electron/MediaRepository） | `src/main/ipc/handlers/media.test.ts`                            | 新测试文件的模板；差异：不 mock `../validator`，使 zod 真实执行 |

## 6. 参数校验（IPC 校验规则调整方案）

### 6.1 通道/schema 对照表（本次修复后）

| IPC 通道                        | schema                                  | 数组上限      | 元素校验             | 状态                           |
| ------------------------------- | --------------------------------------- | ------------- | -------------------- | ------------------------------ |
| `media:softDelete`              | `mediaIdArrayBulk`                      | 无            | 正整数 + 非空(min 1) | 前次已修，本次复核在位         |
| `media:restore`                 | `mediaIdArrayBulk`                      | 无            | 同上                 | 同上                           |
| `media:permanentDelete`         | `mediaIdArrayBulk`                      | 无            | 同上                 | 同上                           |
| `profile:transferFiles`         | `mediaIdArray` → **`mediaIdArrayBulk`** | 1000 → **无** | 同上                 | **本次修改**                   |
| `media:analyzeSceneTime`        | `mediaIdArray.optional()`               | 1000（不变）  | 同上                 | 登记项：渲染端仅无参调用       |
| `file:delete` / `import:run` 等 | `filePathArray`                         | 1000（不变）  | 路径级校验           | 登记项：另一族文案，非本次范围 |

### 6.2 安全边界（不降级）

- `min(1)`：空数组仍被拒绝（防止无意义全量操作）。
- `z.number().int().positive()`：0 / 负数 / 小数 / 非数字元素仍被拒绝。
- 元组其余位置参数（`schemas.uid` 等）校验不变。
- 放开的**只是数组长度这一人为上限**；下游 SQL 仍按 500 分片绑定变量，规避 `SQLITE_MAX_VARIABLE_NUMBER`。

## 7. 错误处理

| 异常分支                        | 处理策略                                                                                                              | 降级方案                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| zod 校验失败                    | `wrapHandler` 统一返回 `{ success:false, code:'IPC_VALIDATION_ERROR', message:'参数校验失败:[0] …' }`，不进入业务逻辑 | 无需降级：属编程错误，前端 toast 展示后可修正重试                       |
| 元素非法（0/负/小数/非数字）    | 同上，被拒于 handler 之外                                                                                             | 前端 `useBatchOperations.ts:302` 已过滤 `NaN`；脏数据不会下发           |
| 分片事务中某片失败              | `runChunkedTransaction` + better-sqlite3 原生事务：整片回滚并抛错 → `wrapHandler` 捕获为 `IPC_INTERNAL_ERROR`         | DB 状态保持事务前一致；用户可重试整批（操作幂等：软删除/转移为 UPDATE） |
| 目标档案不存在（transferFiles） | `AppError.notFound` → `IPC_NOT_FOUND`，不触碰数据                                                                     | 前端刷新档案列表后重试                                                  |
| worker 写库进程不可用           | `MediaRepository` 未注入 workerBridge 时降级为同步直写（既有机制，不动）                                              | 自动降级，无需人工干预                                                  |

## 8. 基础测试用例

### 8.1 自动化（vitest，全部通过）

| 文件                                                          | 用例                                                                                                                                                                                                         | 预期                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `src/main/ipc/validator.test.ts`（既有，6 例）                | bulk schema 接受 1500/1000/2000 个 id；空数组/非法元素被拒；capped 版仍限 1000（控制对照）                                                                                                                   | 全过（基线复核）                                      |
| `src/main/ipc/handlers/profile-handler.test.ts`（新增，5 例） | ① 1500 个 id → success 且 `transferFilesToProfile` 收到全量 1500 ② 1001/3000 个 id 通过 ③ 空数组 → `IPC_VALIDATION_ERROR` ④ 非法元素 → `IPC_VALIDATION_ERROR` ⑤ 目标档案缺失 → `IPC_NOT_FOUND` 且不下发 repo | 全过；①②在旧 capped schema 下必败（已做变异验证证实） |

### 8.2 手动回归（打包版验收清单）

前置：库内重复项或选中项 >1000（可先用「全部应用策略」收集全库重复 id）。

1. **重复文件**：全部应用策略 →「移至回收站」→ 应成功并提示删除数量（旧版在此报错）。
2. **图库**：Ctrl+A 全选 >1000 张 → 批量删除 → 逐条并发执行成功，无「数组长度上限」报错。
3. **图库/缓存 → 转移到档案**：全选 >1000 张 → 转移到目标档案 → 成功提示 transferred=数量（本次修复点）。
4. **回收站**：选中 >1000 条 → 恢复 / 彻底删除 / 清空回收站 → 均成功。
5. **图片导入**：向导选择目录并导入 → 正常完成（该板块无删除 IPC；>1000 路径导入的限制为登记项，见 §9）。

## 9. 已知限制与登记项（本次不改）

| 项                                 | 位置                                            | 原因                                                                                                    |
| ---------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `import:run` 路径数组 1000 上限    | `src/main/ipc/handlers/import-handler.ts:47`    | 文案为「路径数组长度上限 1000」，另一族问题且非删除功能；如需放开可仿照本次方案新增 `filePathArrayBulk` |
| `media:analyzeSceneTime` 保留上限  | `src/main/ipc/handlers/media-handler.ts:109`    | 渲染端仅无参调用，无实际触发路径                                                                        |
| `ipc-validate.ts` 残留手写校验器   | `src/main/utils/ipc-validate.ts:248-269`        | 无调用方，属死代码，待后续清理任务                                                                      |
| 批量导出/移动/水印的路径 1000 上限 | `file:export` / `file:move` / `watermark:apply` | 同路径族，非本次范围                                                                                    |

## 10. 验证记录（2026-08-23 实际执行）

| 步骤     | 命令                                                           | 结果                                          |
| -------- | -------------------------------------------------------------- | --------------------------------------------- |
| 基线     | `npx vitest run src/main/ipc/validator.test.ts`                | 6/6 通过                                      |
| 基线     | `npm run typecheck`                                            | 无报错                                        |
| 修复后   | `npm run typecheck`                                            | 无报错                                        |
| 新测试   | `npx vitest run src/main/ipc/handlers/profile-handler.test.ts` | 5/5 通过                                      |
| 变异验证 | 临时回退 capped schema 重跑                                    | 2 failed（证明回归防线有效），恢复后 5/5 通过 |
| 全量     | `npm run lint`                                                 | 无报错                                        |
| 全量     | `npm test`                                                     | **187 文件 / 3570 用例全部通过**              |
| 打包     | `npm run dist`                                                 | 成功，产物见 `release/`                       |

## 11. 启动说明

- **开发调试**：`npm run dev`（electron-vite dev），按 §8.2 手动回归清单验证。
- **单元验证**：`npm test`（全量）或 `npx vitest run src/main/ipc/handlers/profile-handler.test.ts`（定点）。
- **构建**：`npm run build`。
- **打包安装版**：`npm run dist` → 产物 `release/NikkiGallery-Setup-2.3.5.exe`；安装后按 §8.2 验收（需 >1000 张测试图）。
- **注意**：旧安装包（≤2026-08-21 构建）不含修复，必须用新产物覆盖安装后再验证。
