# 修复「清空软件内回收站未转入系统回收站而是永久删除」实施计划

> 状态：已确认（2026-10-24）｜关联缺陷：部分电脑上清空软件内回收站后，文件未按确认文案承诺「先移至系统回收站」，而是被直接永久删除。
> 证据来源：问题电脑日志包 `wxnn-logs-2026-10-22.zip`（2.5.2→2.5.3→2.5.5-beta 版本时间线、自动更新 404、零回收站操作日志、扫描 31 项缺失）+ git 考古（`a5d154c`、`80d910a`）。

## 0. 根因分析（已闭环）

**缺陷**：≥2.5.5-beta 的版本上，「清空回收站」`media:emptyRecycleBin` 与「彻底删除」`media:permanentDelete` 用 `fsp.unlink` 直接永久删除文件，而回收站页确认文案（`recycleBin.emptyConfirm`/`permanentConfirm`/`summaryWithHint`，zh-CN.json 1618/1624/1640 行，自项目基线未改）始终承诺「文件会先移至系统回收站」。

**因果链**：

1. `a5d154c`（2026-09-09，随 v2.5.2 发布）：empty/permanentDelete 由 `shell.trashItem` 改 `fsp.unlink`。动机是「Shell API 大批量 2474 项 94.5% 瞬时失败」——但那是旧架构产物：当时「软删除」在删除时就已把文件搬进系统回收站（`file:delete`→`shell.trashItem`），清空时 trashItem 打的是已消失的原路径，自然失败。该结论是误诊；当时只更新了 `main.media.dialog.*` 死文案，回收站页四条承诺文案漏改。
2. `80d910a`（2026-10-08，随 2.5.5-beta 发布）：软删除改为纯 DB 标记、文件留在原位。从此清空时 `unlink` 删的是真实文件——**永久删除 100% 必现**（任何电脑、任何盘符）。
3. **「部分电脑」的真相**：版本碎片化。问题电脑自动更新持续失败（`NikkiGallery2.5.2/latest.yml 404`、`NikkiGallery2.5.3 404`、`ERR_CONNECTION_RESET`）。≤2.5.3 的电脑删除时文件即入系统回收站（用户看得到）；≥2.5.5-beta 的电脑文件从不进系统回收站。与盘符/权限/系统版本无关：日志零 EPERM/EBUSY/EACCES，媒体全在本地盘 E:/F:。
4. 日志佐证：10-08~10-22 全部 16 个日志文件无任何回收站操作日志（成功静默）；10-22 扫描「123 项检查、31 个缺失」与文件已被永久删除的后果吻合。

**方案取舍**：恢复 `shell.trashItem`（Electron 内置）。评估过 npm `trash` 包：Windows 实现委托原生 NAPI 模块 `recycle-bin`（0.1.3，3 年未更新、周下载 58），引入原生 ABI/打包风险，且项目发布配方禁 npm install——弃用。旧「94.5% 失败」前提已随 `80d910a` 消失（文件现在真实存在于原路径），沿用既有重试/熔断/三态/B1 机制兜底。

## 1. 依赖声明

**零新增依赖**。仅重新启用 Electron 内置 `shell.trashItem`（`import { shell } from 'electron'`，Electron 41 支持）。不新增 npm 包、不跑 npm install、不改 electron-builder 配置。

## 2. 启动说明

- 环境：现有仓库已 `npm install`；无需任何新准备。
- 开发验证：`npm run dev` → 删一张照片入软件回收站 → 清空 → 打开 Windows 回收站确认文件在系统回收站中、原路径消失。
- 自动化：`npx vitest run src/main/ipc/handlers/media.test.ts src/main/ipc/handlers/media-lifecycle-handler.test.ts src/main/ipc/handlers/_trash-utils.test.ts`（节点级）；`npm test` + `npm run verify`（全局回归）。

## 3. 错误处理（三态 + B1 数据安全约定，骨架全沿用）

| 分支                                                     | 行为                                                    | 兜底/日志                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| trashItem 成功                                           | 三态 `ok` → movedCount，DB 记录可删                     | —                                                                                                                                |
| 路径不存在（trashItem 抛错 + pathExists 复检为否）       | 三态 `missing` → 删 DB，不计失败                        | pathExists 复检兜底                                                                                                              |
| trashItem 抛错且文件仍存在（占用/网络盘/Shell 瞬时失败） | 退避重试 2 次（50ms→100ms），重试前 pathExists 复检     | 重试用尽仍存在 → `failed`：**不删 DB、绝不 fallback unlink**，聚合计 1 条 `logger.warn`（`main.media.log.recycleBinMoveFailed`） |
| 连续失败 ≥10                                             | 熔断停重试（快速失败）                                  | 同现状                                                                                                                           |
| 回收站为空                                               | 提前返回 `recycleBinEmpty`，movedCount=0                | 同现状                                                                                                                           |
| 缩略图清理                                               | 不变：仍 `fsp.unlink` best-effort（缓存文件非用户文件） | 同现状                                                                                                                           |

## 4. 参数校验

入参出参零变化：`media:permanentDelete` 仍 `schemas.mediaIdArrayBulk`（非空正整数数组 ≤1000）；`media:emptyRecycleBin` 仍无参。返回结构 `{ message, deletedCount, failedCount }` / `{ message, movedCount, missingCount, failedCount }` 逐字不变，仅 `movedCount` 语义回归「移入系统回收站数」（渲染端只消费 message/failedCount，无需改动）。

## 5. 子任务分解（严格 TDD：每节点先红后绿）

### T0 落档计划

- 文件：`docs/plans/2026-10-24-fix-empty-recyclebin-system-trash.md`（本文件）
- 验收：文件存在且 `git status` 可见。

### T1 红灯——复现缺陷的测试（`src/main/ipc/handlers/media.test.ts`）

- 反转 `a5d154c` 的两个断言用例（现 468/686 行）并新增三态/B1 断言：
  - R1 `emptyRecycleBin 确认后对每个文件调用 shell.trashItem 且不以 unlink 删除媒体文件`（trashItem 以 `/a`、`/b` 被调；unlink 不以媒体 file_path 被调）
  - R2 `permanentDelete` 同构反转
  - R3 trashItem 抛错 + pathExists=false → missingCount=1、DB 记录被删
  - R4 trashItem 持续抛错 + pathExists=true → failedCount=1、DB 保留、恰好 3 次尝试、warn 聚合 1 条
- 输入：既有 mock 基建（`shellTrashItemMock`/`unlinkMock`/`pathExistsMock`）。输出：R1–R4 红、其余绿。
- 验收：`npx vitest run src/main/ipc/handlers/media.test.ts` 中 R1–R4 失败（修复前必须红）。

### T2 修复——`src/main/ipc/handlers/_trash-utils.ts` + `src/main/ipc/handlers/media-lifecycle-handler.ts`

- `_trash-utils.ts`：`unlinkWithFallback`→`trashItemWithFallback`（原语 `fsp.unlink`→`shell.trashItem`，三态/重试/熔断/聚合日志逐行保留，重加 `import { shell } from 'electron'`）；`unlinkBatch`→`trashBatch`、`UnlinkResult`→`TrashItemResult`、`UnlinkBatchOutcome`→`TrashBatchOutcome`；模块头注释改写（说明 94.5% 是旧双回收站架构产物、`80d910a` 后前提消失）；替换首行 `@core-change`（`_` 前缀文件豁免闸门，仅卫生性更新）。
- `media-lifecycle-handler.ts`：import 与 2 处调用点（104/148 行）换 `trashBatch`；阶段注释「物理删除」→「移入系统回收站」；**首行 `@core-change` 替换**：`// @core-change: 清空回收站与彻底删除恢复移入系统回收站语义，修复与确认文案矛盾的永久删除`（受保护路径，两层闸门）。
- 输入：`rows: readonly { id, file_path }[]`；输出：`TrashBatchOutcome`（字段不变）。
- 验收：R1–R4 转绿；`npm run verify` 通过。

### T3 平移——既有用例与邻接 mock

- `media.test.ts`：empty/permanent 的 unlink 三态族用例（missing/failed/重试成功/重试用尽/重试中消失/日志聚合/熔断/movedCount，约 13 个）mock 目标 `unlinkMock`→`shellTrashItemMock`，语义断言不变；缩略图清理用例的 unlink 断言**保留**（清理仍是 unlink）。
- `media-lifecycle-handler.test.ts`：`unlinkBatchMock` 更名 `trashBatchMock`（`vi.mock('./_trash-utils')` 桩）。
- `_trash-utils.test.ts`：因模块新 import electron，按需补 `vi.mock('electron')`；其缩略图用例不动。
- 验收：三个测试文件全绿。

### T4 文案与契约

- `src/renderer/i18n/locales/zh-CN.json`（仅 zh-CN，key 不动、其他 11 locale 不动——guard 只校验 key 对齐）：
  - `main.media.log.recycleBinMoveFailed`（2879 行）：「物理删除失败」→「移入系统回收站失败 {{failed}}/{{total}} 项，DB 记录已保留供重试。样例: …」
  - `main.media.message.permanentDeletePartial`（2868 行）：「已彻底删除…删除失败」→「已移入系统回收站 {{deleted}} 项（{{failed}} 项移入失败，已保留记录供手动处理）」
- `docs/IPC_CONTRACT.md` §2.7/§2.8：行为变更注记改回 trashItem 语义、movedCount 语义回归说明。
- 验收：`npm run verify` 通过；`npm run i18n:guard` 通过。

### T5 全局回归

- `npm test` 全量 → `npm run verify` → `npm run typecheck` + `npm run lint` 全量 → `npm run i18n:guard`。
- 全绿后按 Conventional Commits 提交（pre-commit 钩子会再跑闸门），提交后 `git status --porcelain` 复核。
- 验收：无任何新增失败项；未通过全部回归不得结束。

## 6. 测试用例矩阵

- **正常**：R1/R2（trashItem 逐文件被调、DB 删、movedCount 计数）、清空为空提前返回、契约锁（返回字段无 success）。
- **异常**：R4（重试用尽保 DB）、EBUSY 首败重试成功、多项失败聚合成 1 条 warn、连续 10 失败熔断。
- **边界**：R3（路径不存在判 missing 删 DB）、重试期间文件消失立即停、2000 id 分片、缩略图清理不触碰缓存目录外路径（保留现有断言）。

## 7. 明确不做（防蔓延）

- 不改软删除/恢复语义（`80d910a` 架构不动）。
- 不动图库 `file:deletePermanent` 链路（其文案「此操作不可恢复」与 unlink 语义一致，非本缺陷）。
- 不动插件桥 `file:delete`/`moveToRecycleBin`（本就移入系统回收站，非本缺陷）。
- 不实现「从系统回收站还原」；不处理大回收站串行 trashItem 的性能优化（如需后续另立计划）。
- 不发版、不打包（版本定档另议）。
