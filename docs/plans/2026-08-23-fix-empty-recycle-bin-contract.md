# 修复「清空回收站」提示失败且未清空的实施计划（已执行）

> 计划生成日期：2026-08-23 ｜ 状态：✅ 已执行并通过全部门禁
> 关联诊断文档：`docs/FIX-empty-recycle-bin-2026-08-18.md`（仅部分相关，未触及本次根因）

## 1. 问题概述

打包后的版本在「回收站」板块点击「清空回收站」时：

- 右下角弹出「失败」提示（error toast）；
- 回收站列表未被清空 / 不刷新；
- 主进程侧其实已执行物理删除（`trashBatch` + `hardDeleteBatch`），但 UI 把成功误判为失败。

**范围**：仅修复 `emptyRecycleBin` 这一条缺陷链路，不改动其他无关功能。

## 2. 根因分析（确凿）

渲染端 `RecycleBinPage.handleEmptyRecycleBin` 读取 `result.success` 判定成败，但 IPC 契约中该字段恒为 `undefined`：

- 主进程 `media:emptyRecycleBin`（`src/main/ipc/handlers/media-lifecycle-handler.ts:237-280`）成功返回 `{ message, movedCount, missingCount, failedCount }`，经 `wrapHandlerNoArgs` 包成 `{ success:true, data:{...} }`。
- preload `call<T>()`（`src/main/preload/ipc.ts:41-51`）解包 `IpcResponse` 时只 `return res.data`，**从不回传 `success` 字段**。
- 故渲染端 `result.success` 恒为 `undefined` → `if (!result.success) throw`（第 216 行）在成功路径必然抛错 → `useStagedTask.run` 进入 `error` 分支 → 右下角 error toast；且其后 `await loadRecycleBin()` 永不执行 → 列表不刷新。

`docs/FIX-empty-recycle-bin-2026-08-18.md` 只针对 `shell.trashItem` 瞬态失败加了重试 / 熔断 / 日志聚合，未触及此契约错配，故问题依旧。

**次生缺陷**：成功分支引用的 i18n key `recycleBin.emptySuccess` 在全部 12 个语言包中均缺失（搜索 0 命中），即便修复判定后也会显示原始 key。

同类潜在契约错配（**超出本次范围**，仅作观察）：渲染端 `restore` / `softDelete` / `permanentDelete` 同样读取 `result.success`，存在相同「恒 undefined」误判。本次按用户要求不改，但建议后续统一收敛（见第 7 节）。

## 3. 修复方案（最小侵入，复用既有基础设施，0 新增依赖）

复用项目既有「`call` 解包 → `IpcError` 异常传播 → `useStagedTask` 三态」链路，成功即 `await` 不抛异常、失败即抛 `IpcError`：

1. 删除 `RecycleBinPage.tsx` 第 216 行的 `if (!result.success) throw new Error(result.message)` 误判；
2. 成功路径直接信任 `call()` 解析结果，并用主进程已本地化的 `result.message`（如「已清空回收站（共 N 项）」）作为成功提示，兜底 `t('recycleBin.emptySuccess')`；`error` / `cancelled` 分支逻辑保持不变；
3. 同步修正 `src/renderer/vite-env.d.ts:442` 类型声明为 `Promise<{ message: string }>`，消除与实际契约偏差、防回归；
4. 补齐 `recycleBin.emptySuccess` 兜底文案到全部 12 个语言包。

## 4. 依赖声明

**无新增任何运行时 / 开发依赖**。全部复用既有且已安装的成熟设施：

- `electron`（40.x）：`shell.trashItem` / `dialog.showMessageBox`；
- `better-sqlite3`：回收站记录物理删除；
- `zod` + `wrapHandlerNoArgs`：参数校验与响应包装；
- `react`、`react-i18next`：渲染与 i18n；
- `vitest` / `@testing-library/react` / `jsdom`：测试；
- `typescript`：类型门禁。

> 不引入任何 `trash` / `rimraf` / 重试 / URL 第三方库；`shell.trashItem` 已是 Electron 官方跨平台回收站 API。本次仅修「契约错配」，不动 2026-08-18 已落地的重试 / 熔断代码。

## 5. 启动说明（验证命令）

```powershell
npm install                              # 增量安装（禁用 npm ci，Safe-Delete 网关限制）
npm run dev                              # 开发模式复现 / 调试
npx tsc -b                              # 类型门禁
npm test                                # 全量单元测试（3563 用例）
npm run test:main -- media.test         # 主进程回收站用例
npm run test:renderer                   # 渲染层用例
npm run i18n:check                      # i18n key 完整性
# 打包验证（规避 clean 步 Safe-Delete EPERM，不可用 npm run dist:win）：
npx electron-vite build                 # 直接构建，不触发 clean
# 确认 dist/main/package.json == { "type": "commonjs" }
npx electron-builder --win --publish never   # 产出 release/NikkiGallery-Setup-<ver>.exe
```

## 6. 错误处理

| 场景                                   | 处理方式                                                                  | 用户可见结果                                                               |
| -------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 回收站为空（`rows.length===0`）        | 主进程提前返回 `{message, movedCount:0}`，不弹确认框                      | 成功 message（不报错）                                                     |
| 用户取消确认框                         | 主进程 `throw AppError.canceled` → `call` 抛 `IpcError`（`IPC_CANCELED`） | `staged.run` `cancelled` 分支静默，无弹窗                                  |
| 主进程真实失败（trashItem 持续失败等） | `wrapHandlerNoArgs` 捕获 → `{success:false,error}` → `call` 抛 `IpcError` | `staged.run` `error` 分支显示真实 message                                  |
| 渲染端契约错配（修复前）               | `result.success` 恒 `undefined` 误抛                                      | 右下角「失败」弹窗（本次修复对象）                                         |
| 修复后成功                             | `await` 解析不抛 → 走 `done` 分支                                         | `showMessage(successMessage \|\| t('recycleBin.emptySuccess'), 'success')` |
| 部分成功部分失败                       | 主进程返回 `message` 含成功 / 失败数                                      | 成功 toast + 列表刷新（失败项保留供重试）                                  |

## 7. 参数校验

| 位置                              | 校验内容                                          | 手段                                |
| --------------------------------- | ------------------------------------------------- | ----------------------------------- |
| `media:emptyRecycleBin`           | 无入参                                            | `wrapHandlerNoArgs`（拒绝多余参数） |
| 主进程 `rows.length===0`          | 空回收站提前返回，不弹确认框                      | 早返回                              |
| `trashItemWithFallback(filePath)` | 非空字符串；失败时 `pathExists` 复检存在性        | 函数内防御                          |
| `useStagedTask.run` `stageLabels` | 非空数组（`createStages` 空数组抛错）             | `RunStagedOptions.stageLabels` 校验 |
| `vite-env.d.ts` 类型              | `emptyRecycleBin` 返回 `{message}` 不含 `success` | 类型修正（防回归）                  |

## 8. 基础测试用例

**主进程（`src/main/ipc/handlers/media.test.ts`，直接 `getHandler('media:emptyRecycleBin')()`）**

| 用例                                         | 输入                                 | 预期                                                                  |
| -------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| 契约锁：返回含 `message` 且无 `success` 字段 | 模拟主进程成功路径                   | `result.data.message` 为字符串；`('success' in result.data)` 为 false |
| 回收站为空返回提示                           | 空 rows                              | `movedCount===0`，message 含「为空」                                  |
| 用户取消抛 `canceled`                        | `showMessageBox` 返回 `response!==1` | `error.code==='IPC_CANCELED'`                                         |
| 确认后批量删除                               | `trashItem` resolve                  | `hardDeleteBatch` 被调用，`movedCount>0`                              |
| 重试 / 熔断既有用例                          | `trashItem` reject/resolve 序列      | 行为与 2026-08-18 约定一致                                            |

**渲染侧（`src/renderer/pages/RecycleBinPage.empty.test.tsx`，结构性断言，沿用 `GalleryPage.test.tsx` 模式）**

| 用例                                                                            | 预期                                                              |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 源码不再包含 `if (!result.success) throw` 误判写法（剔除注释行后断言）          | 不匹配该模式                                                      |
| 成功路径 `await loadRecycleBin()` 被调用                                        | 源码含该调用                                                      |
| 成功 toast 使用 `success` 语义且优先主进程文案 + 兜底 `recycleBin.emptySuccess` | 源码含 `showMessage(..., 'success')` 与 `recycleBin.emptySuccess` |

## 9. 子任务与验收（每步先验证通过再进入下一步）

### 子任务 1 ── 复现与契约基线确认 ✅

- 文件：无修改。
- 输入：运行主侧测试 + 阅读 `call` / `handleEmptyRecycleBin` 源码。
- 输出：复现现象记录 + 基线。
- 验收：`npm run test:main -- media.test` 全绿（72 → 含本计划后 73）；确认 `media-action.ts:31` 返回 `{message}` 无 `success`；确认 `RecycleBinPage.tsx:216` 误判行存在；确认 `emptySuccess` 在 12 语言包均缺失。

### 子任务 2 ── 渲染端核心修复 + 类型修正 ✅

- 文件：`src/renderer/pages/RecycleBinPage.tsx`（删误判行、成功 toast 改用 `successMessage`）、`src/renderer/vite-env.d.ts:442`。
- 输入：渲染端 `result = {message, movedCount, missingCount, failedCount}`。
- 输出：成功路径信任解析结果 → success toast + `loadRecycleBin()` 执行；类型声明与实际契约一致。
- 验收：`npx tsc -b` 通过；全仓无对 `emptyRecycleBin` 结果 `.success` 的引用。

### 子任务 3 ── i18n 兜底 key 补齐 ✅

- 文件：`src/renderer/i18n/locales/{zh-CN,zh-TW,en,ja,ko,de,fr,ru,es,pt,vi,th}.json`。
- 输入：缺失 key 现状。
- 输出：12 语言包新增 `emptySuccess`。
- 验收：`npm run i18n:check` 通过（12 locale 全部 3507 keys 对齐）。

### 子任务 4 ── 回归测试补充 ✅

- 文件：`src/main/ipc/handlers/media.test.ts`（契约锁用例）、`src/renderer/pages/RecycleBinPage.empty.test.tsx`（新建）。
- 验收：`npm test` 全量 **188 文件 / 3563 用例全绿**；`eslint` 改动文件无错误。

### 子任务 5 ── 构建与打包端到端验证 ✅（构建侧）/ ⚠️（GUI 交互侧）

- 文件：无（仅验证）。
- 验收（已达成）：
  - `npx electron-vite build` 成功，`dist/main/package.json == {"type":"commonjs"}`；
  - `npx electron-builder --win --publish never` 成功，产出 `release/NikkiGallery-Setup-2.3.5.exe`；
  - 打包产物 `dist/renderer` 已包含 `emptySuccess` key（RecycleBinPage chunk + 全部 12 i18n chunk 各 1 处命中），证明修复已随包发布；
  - `npx tsc -b` / `npm run i18n:check` / `eslint` 全绿。
- 说明：本无显示环境，**无法在自动化中模拟人工点击 GUI**；交互式「点击清空回收站 → 看成功 toast + 列表清空」需用户在安装包中手动确认。逻辑正确性已由单测 + 结构性断言 + 打包产物核查三重覆盖。

## 10. 后续建议（超出本次范围）

渲染端 `restore` / `softDelete` / `permanentDelete` 同样读取 `result.success`（preload `call()` 不回传该字段），存在与本次相同的「恒 undefined 误判」潜在缺陷。建议另立任务统一收敛：在 `src/main/preload/ipc.ts` 的 `call` 返回时补 `{ success: true, ...res.data }`，或在各消费点改用「异常即失败」判定。本次未改以保持最小爆炸半径。
