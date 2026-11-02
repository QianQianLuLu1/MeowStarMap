# 清空回收站失效：诊断结论与修复计划

## 1. Context（为什么做这件事）

用户报告「回收站无法正常使用，重点是清空回收站失效」。我用真实设备日志 + 代码走查把问题定位清楚了，结论是**两件事叠在一起**，其中只有一件是代码缺陷：

**证据 A — 真机日志**（`C:\Users\45001\AppData\Roaming\meow-star-map\logs\main.log`，2026-11-01 17:25:12 → 17:25:43，4 条，全仓历史仅这一天出现）：

```
[RecycleBin] 移入系统回收站失败 41/46 项，DB 记录已保留供重试。
样例: H:\InfinityNikki Launcher\InfinityNikki\X6Game\Saved\GamePlayPhotos\114077271\CloudPhotos\702468873_Low.jpeg …
Error: Failed to perform delete operation
```

随后两次 41/41，最后一次 1/1（那是「彻底删除」单条链路，同样失败）。

我逐项排除了常见解释：文件确实存在、`Attributes=Archive`、非只读、非重解析点、非硬链接、单一 `:$DATA` 流、`H:` 是本地固定 NTFS 卷且 `H:\$RECYCLE.BIN` 存在、目录 ACL 给 `Authenticated Users` 的 Modify 含删除权。**首批 46 项里有 5 项成功**，所以不是全卷一律不可用。

**证据 B — 主进程与渲染层代码**：主进程 96 个用例（含 16 个 `media:emptyRecycleBin` 专项）当前**全部通过**，`trashBatch` 的三态判定与「失败项保留 DB 记录」的 B1 规则按设计工作——所以"什么都没删"是**正确的保守行为**，不是 bug。缺陷在别处。

### 预期流程 vs 实际表现

| 环节                       | 正常预期                                                                  | 实际表现                                                                                       | 判定                    |
| -------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------- |
| 用户点「清空回收站」→ 确认 | 进入 `media:emptyRecycleBin`                                              | 正常进入                                                                                       | ✅                      |
| 主进程 `shell.trashItem`   | 文件移入系统回收站                                                        | H 盘 41 项全部 `Failed to perform delete operation`                                            | ❌ 环境侧               |
| `idsToDelete`              | 全部                                                                      | 空 ⇒ `hardDeleteBatch` 直接 return（`media-repository.ts:812`），DB 一行未删                   | ✅ 符合 B1 设计         |
| IPC 返回                   | `{message, movedCount:0, missingCount:0, failedCount:41}`，传输层**成功** | 同左                                                                                           | ✅                      |
| 渲染层判定                 | `failedCount>0` ⇒ **红色错误 toast**                                      | **绿色成功 toast**（`RecycleBinPage.tsx:265-267` 只看 `phase==='done'`，从不读 `failedCount`） | ❌ **根因 1**           |
| 列表刷新                   | 失败时保留条目 + 给出出路                                                 | 条目还在，且**没有任何重试入口**                                                               | ❌ **根因 2**           |
| 用户再点                   | 重试或换路径                                                              | 又是绿色 toast，无限循环                                                                       | ❌ 用户感知「功能坏了」 |

### 根本原因（三条，都可从代码证伪/证实）

1. **契约漂移导致失败被谎报为成功。** `docs/IPC_CONTRACT.md` §2.8 第 224 行声明返回 `{message, movedCount, missingCount, failedCount}`，第 242 行明确写「`RecycleBinPage` 仅消费 `message` 与 `failedCount`」。但 `src/main/preload/api/media-action.ts:35` 与 `src/renderer/vite-env.d.ts:515` 都把返回类型收窄成 `{message: string}`——**TypeScript 从类型层面阻止了页面读 `failedCount`**，于是这个漂移能长期存活。同文件 `handlePermanentDelete`（`RecycleBinPage.tsx:194`）却在做 `if (r.failedCount > 0) throw new InternalError(r.message)`，证明本仓库已有正确范式，清空路径只是漏了。
2. **失败态不可达。** `handleEmptyRecycleBin` 只在 238 行 `setFailedAction(null)`，错误分支 265 从不 `setFailedAction('empty')` ⇒ `RecycleBinPage.tsx:450` 的 `retryEmpty` 按钮与 `handleRetry` 的 empty 分支（275 行）是**死代码**。用户没有出路。
3. **`shell.trashItem` 在该机 H 盘上恒定失败**（环境侧，非代码缺陷）。这是「清不掉」的物理原因，需要卷级取证定性，见节点 0。

### 我已按你的选择定型的方案

- 先**如实报错 + 打通重试**（根因 1、2）。
- 再给一条**显式同意**的兜底：清空失败后出现「跳过系统回收站，直接彻底删除」，二次确认写明"不进系统回收站、不可恢复"，同意后才 `unlink`。
- **不做自动回退**：`7d4459f` 明确禁止静默永久删除，且确认文案承诺「文件会先移至系统回收站」。自动 fallback 在「文件被占用」这类场景会把可恢复的删除变成不可恢复的数据丢失。

### 我的建议与保留意见（直说）

- ~~兜底能不能真删掉那 41 项，取决于取证结论~~ —— **节点 0 已定案**：`unlink` 在 H 盘每次成功，force 兜底能真正清空那 41 项。但仍要坚持原判断的纪律部分：**这次修的不是"H 盘回收站坏了"这个 Windows 侧成因**（成因未证实，见节点 0），应用侧修的是「把失败谎报成成功」+「没有出路」。确认框文案只陈述已证实的事实，不编造原因。
- `refreshMedia()` **不建议补**：`media:emptyRecycleBin` 末尾已 `ctx.notifyMediaUpdated()`，`GalleryPage.tsx:226` 全局订阅且图库 keep-alive；软删除条目本就不在图库查询集内（`is_deleted = 0`），清空对可见图库是零影响。`handleRestore:147` 那次调用是防御性冗余，不构成"没对齐"的缺陷。这条不属于本次修复范围。

---

## 2. 依赖声明

**无新增/变更依赖。** 全部复用仓库既有能力：

| 用途          | 复用对象                            | 位置                                                                                              |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| 永久删除原语  | `fsp.unlink` + ENOENT 容忍          | `src/main/services/file-service.ts:453-483`（语义参照，不跨层调用）；就地实现在 `_trash-utils.ts` |
| 聚合日志      | `trashBatch` 的「循环后一条」约定   | `src/main/ipc/handlers/_trash-utils.ts:160-173`                                                   |
| 错误对象      | `InternalError`                     | 已在 `RecycleBinPage.tsx:17` 导入                                                                 |
| 阶段进度/取消 | `useStagedTask` + `terminateStages` | `src/renderer/hooks/useStagedTask.ts:156-170`                                                     |
| zod           | 仓库现有 `zod@4.6.7`                | 无需升级                                                                                          |

安装方式：无（不执行 `npm install`，避免 `link:nikkisync` 被静默拆链的已知坑）。

## 3. 启动说明

```bash
# 单节点验证（逐条手敲，路径为仓库相对）
npx vitest run src/renderer/pages/RecycleBinPage.emptyBehavior.test.tsx
npx vitest run src/main/ipc/handlers/_trash-utils.force.test.ts
npx vitest run src/main/ipc/handlers/media.test.ts src/main/ipc/handlers/media-lifecycle-handler.test.ts
npx vitest run src/main/ipc/validator.test.ts
npx vitest run src/renderer/pages src/main/ipc   # 局部回归
npm run typecheck                               # 含新增类型探针
npm run i18n:guard && npm run sync-i18n-keys
npm run verify

# 全量收口
npm test && npm run lint && npm run typecheck && npm run typecheck:e2e && npm run i18n:guard

# 真机验证
npm run dev     # 进回收站 → 清空 → 观察红色 toast / 重试 / 彻底删除三段
```

## 4. 参数校验

唯一契约变更点，**向后兼容**（符合 `docs/CODING_CONVENTIONS.md` §1「新增字段可选、旧字段语义不变」）：

| 项   | 变更前                                             | 变更后                                                                                                           |
| ---- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 通道 | `media:emptyRecycleBin`                            | 名称不变                                                                                                         |
| 包装 | `wrapHandlerNoArgs`                                | `wrapHandler(ctx, z.tuple([z.boolean().optional()]), async ([force]) => ...)`                                    |
| 入参 | 无                                                 | `force?: boolean`；`undefined`/`false` = 走系统回收站；`true` = 直接 `unlink`                                    |
| 返回 | `{message, movedCount, missingCount, failedCount}` | 追加 `forceDeletedCount: number`（未 force 时恒为 0）；**绝不新增 `success` 字段**（`media.test.ts` 契约锁会红） |

已实测确认的两个关键前提（不是假设）：

1. **zod 4.6.7 下 `z.tuple([z.boolean().optional()]).safeParse([])` 返回 `OK`，`data = []`** ——所以旧调用方 `call('media:emptyRecycleBin')`（零实参 ⇒ `rawArgs = []`）解构出的 `force` 为 `undefined`，走非 force 分支，**不会因加参数而打断老调用**。`safeParse(undefined)` 才报错，而 `wrapHandler` 传的是数组，收不到 `undefined`。
2. `tests/mocks/mock-validator.ts:65-75` 的 `wrapHandler` **忽略 zod、只做 `unwrap(args)`** ⇒ 现有 16 个用例 `getHandler('media:emptyRecycleBin')()` 与新增的 `([true])` 都能直达 handler；同时这也意味着**主进程测试覆盖不到真实 zod 校验**，必须靠 `validator.test.ts` 补一条真 zod 用例（节点 1），否则该盲区会把生产红灯藏进绿灯里。

非法值处理：`force` 传非布尔 ⇒ zod `boolean` 报 `invalid_type` ⇒ `wrapHandler` 转 `VALIDATION_ERROR`，渲染层 `call()` 抛 `IpcError` ⇒ 红色 toast。不做任何"宽容强转"。

## 5. 错误处理

- **force 模式仍守 B1 不变式**：`unlink` 抛错且 `pathExists` 仍为真 ⇒ 计入 `failedPaths` ⇒ **不删该条 DB 记录**。只有「删除成功」与「文件本就不存在（ENOENT/`!pathExists`）」两类进 `idsToDelete`。
- force 模式**不再调 `shell.trashItem`，且单次尝试不重试**（用户已同意跳过回收站，重试一个已知坏掉的 Shell 调用没有意义，正是熔断器要防的耗时）。
- 三态计数语义**不重新定义** `movedCount`（`IPC_CONTRACT.md:231` 钉死了它 = 成功移入系统回收站的文件数），永久删除另记 `forceDeletedCount`。
- 文案不能撒谎：force 全成功复用 `main.media.message.permanentDeleted`；force 部分失败**新增 1 个主进程 key** `main.media.message.permanentDeletePartialForce`（"已彻底删除 {{deleted}} 项（{{failed}} 项删除失败，文件仍保留在磁盘）"）——现有 `permanentDeletePartial` 写的是"已移入系统回收站"，在 force 下是假话。
- 渲染层：`execute` 内 `if (result.failedCount > 0) throw new InternalError(result.message)` ⇒ `useStagedTask` 的 `catch` 产出 `phase:'error'` + `message` ⇒ 既有的 265 行分支直接把主进程文案透传成红色 toast（与 `handlePermanentDelete:212-218` 同构，白拿进度浮窗的错误态）。
- 渲染层再补一层 `try/catch`：`staged.run` 自身不应抛，但 `loadRecycleBin()` 等同步异常须兜住并照样点亮 `failedAction`。
- 日志：失败聚合沿用 `trashBatch` 的「总数 + 样例 3 条 + 首个 error」一条 warn 约定，**禁止逐项 warn**（历史教训：2474 行刷爆日志）。
- 兜底策略边界：`H:` 若属"权限/占用"类失败，`unlink` 也会失败 ⇒ 此时产出是诚实错误 + `failedAction==='empty'` 常驻，不谎报清空成功。

## 6. 实施节点（每节点：文件 / 输入→输出 / 验收）

> 协议：**先写能复现的红灯测试并确认为红，再改代码转绿**。每节点完成后立刻跑该节点的相关测试子集，红灯未红过就不算覆盖到 bug。

**节点 0 — 卷级取证 ✅ 已完成（结论=类1「卷级」，force 兜底成立）**

探针：`.cache/trash-probe/main.cjs`（Electron 41.10.6 裸主进程，gitignored，只创建/删除自己生成的 `.txt`；对真实照片仅做一次零写入的 `r+` 打开探测，前后字节数 6259129 未变）。

| #   | 卷                           | 路径形态     | `shell.trashItem`                               | `fs.unlink` |
| --- | ---------------------------- | ------------ | ----------------------------------------------- | ----------- |
| 1   | C: (`%TEMP%`)                | ASCII 无空格 | **OK**                                          | unlinked    |
| 2   | C: (`%TEMP%\has space`)      | **含空格**   | **OK**                                          | unlinked    |
| 3   | C: (`%TEMP%\喵星图探针`)     | **含中文**   | **OK**                                          | unlinked    |
| 4   | H: (`H:\` 根)                | ASCII 无空格 | **FAILED** `Failed to perform delete operation` | unlinked    |
| 5   | H: (`...\X6Game\ScreenShot`) | 含空格       | **FAILED** 同上                                 | unlinked    |

- 中途踩到的方法论坑（如实记录）：第一版对照实验把 D 盘仓库目录（同时含空格与中文）当控制组，得出「trashItem 到处都失败」的错误结论，差点误判成 Electron/路径写法缺陷。补做「同卷换形态 / 同形态换卷」的分离实验后才定案：**空格与非 ASCII 在 C 盘全部可用 ⇒ 不是路径形态 bug、不是 Electron bug**；`H:` 上连我们自己刚建的 ASCII 无空格文件都进不了回收站 ⇒ **H 盘卷级不接受 Shell 移入回收站**。
- 辅证：`H:\$RECYCLE.BIN\<我的SID>` 存在、对该用户 FullControl、可写（PowerShell 建删目录成功）⇒ 不是简单的 SID 目录缺失；真实照片非只读、非重解析点、非硬链接、当前未被独占锁定（`r+` 打开成功）⇒ **应用侧没有任何做错的地方，也确实删不掉这些文件**。生产日志「46 项里 5 项成功」与「少数记录落在健康卷上」相容。
- **对修复的直接含义**：`unlink` 在 H 盘每次成功 ⇒ 用户显式同意的「跳过系统回收站直接彻底删除」**能真正清掉那 41 项**，force 设计成立（不是类2/类3）。
- **对文案的硬约束**：确认框只能说「这些文件当前无法移入系统回收站」，**不得**断言原因（例如"该卷禁用了回收站"），因为 Windows 侧的确切成因（卷策略 / 卷类型）未被证实；同时不得暗示这是应用缺陷。给用户的处置建议放文档，不放 UI 文案。

**节点 1 — 红灯测试（只写测试，不改实现）**

- 新增 `src/renderer/pages/RecycleBinPage.emptyBehavior.test.tsx`（harness 抄 `RecycleBinPage.permanentDelete.test.tsx` 的真实 `render()` + `vi.mock('react-virtuoso')` + toast 桩；现有 `RecycleBinPage.empty.test.tsx` 是把 .tsx 当字符串做正则的**非行为测试**，正是这个 bug 看不见的原因，保留不动）。断言：
  - `failedCount:41` ⇒ `showMessage` 被以 `'error'` 调用且**从未**以 `'success'` 调用；`screen.getByText('重试清空')` 存在。
  - `failedCount:0` ⇒ `'success'` toast 且无「重试清空」。
  - 失败态点「跳过系统回收站，直接彻底删除」→ 确认 → `expect(mediaAction.emptyRecycleBin).toHaveBeenLastCalledWith(true)`。
  - 编译探针 `type EmptyResult = Awaited<ReturnType<...emptyRecycleBin>>` 携带 `failedCount`/`forceDeletedCount` ⇒ 让 `npm run typecheck` 在修复前就红。
- 新增 `src/main/ipc/handlers/_trash-utils.force.test.ts`（`trashBatch`/`trashItemWithFallback` 目前**零直接测试**，`_trash-utils.test.ts` 只测缩略图清理）：force 下 `shell.trashItem` 不被调用；非 force 下 `unlink` 不被调用（把 `7d4459f` 的"绝不静默永久删除"钉成测试）；ENOENT ⇒ `missing` 进 `idsToDelete`；EPERM+文件仍在 ⇒ `failedPaths` 且 DB 不删。
- 改 `src/main/ipc/handlers/media-lifecycle-handler.test.ts`：`getHandler('media:emptyRecycleBin')([true])` ⇒ `trashBatch` 收到 `{force:true}`、返回含 `forceDeletedCount`。
- 改 `src/main/ipc/handlers/media.test.ts`（真 `_trash-utils` + mock `shell`/`fs/promises`）：端到端 force 成功链、force 部分失败链（`hardDeleteBatch` 收 `[]`）、以及 `data` 仍无 `success` 键的契约锁。
- 改 `src/main/ipc/validator.test.ts`：真 zod 用例 `z.tuple([z.boolean().optional()])` 对 `[]` 与 `[true]` 均通过（补 mock-validator 盲区）。
- **验收**：`npx vitest run` 上述文件 ⇒ 新用例**全部为红**（逐条记录失败名，证明覆盖）；`npm run typecheck` 因探针红；`media.test.ts` 既有 16 个 empty 用例仍绿。

**节点 2 — `_trash-utils.ts` 支持 force**

- 文件：`src/main/ipc/handlers/_trash-utils.ts`（`trashItemWithFallback` 81-103、`trashBatch` 130-176、`TrashBatchOutcome` 106-115）。`_` 前缀 ⇒ 豁免核心路径闸门，且已在 `path-semantics-guard` 的 `PINNED` 表内（新增代码不引入新 win32 钉，无需登记）。
- 输入 `trashBatch(rows, opts?: {force?: boolean})` → 输出 `+forceDeletedCount`。
- 验收：`npx vitest run src/main/ipc/handlers/_trash-utils.force.test.ts` 全绿。

**节点 3 — handler 接 force**

- 文件：`src/main/ipc/handlers/media-lifecycle-handler.ts:134-181`。
- ⚠ **受保护路径**：`src/main/ipc/handlers/**/*.ts`。必须把第 1 行**替换**为本次真实原因（至多一条、不得为批量占位），且随同批改动提交。
- 输入 `([force])` → 输出 `{message, movedCount, missingCount, failedCount, forceDeletedCount}`；force 时选 force 文案。
- 验收：`npx vitest run src/main/ipc/handlers/media.test.ts src/main/ipc/handlers/media-lifecycle-handler.test.ts` 全绿；`git diff` 显示 `@core-change` 行是新增行。

**节点 4 — 修类型漂移**

- 文件：`src/main/preload/api/media-action.ts:35`（⚠ 受保护路径 `src/main/preload/api/**/*.ts`，**当前无 `@core-change` 行，需新增一条**）、`src/renderer/vite-env.d.ts:515`。
- 输出 `emptyRecycleBin: (force?: boolean) => Promise<{message; movedCount; missingCount; failedCount; forceDeletedCount}>`。
- 验收：`npm run typecheck` 绿；`npx vitest run src/main/preload/__tests__/preload.test.ts` 绿（该测试只断言 `electronAPI` 的 34 个**键名**，不断言方法签名，无需改）。

**节点 5 — 渲染层 + 文案**

- 文件：`src/renderer/pages/RecycleBinPage.tsx`（235-269 判定与 `failedAction`、413-463 浮动栏渲染条件放宽为 `selectedIds.size > 0 || failedAction === 'empty'`、62-65/465-484 新增 `confirm.type: 'emptyForce'`）；`src/renderer/i18n/locales/zh-CN.json` 新增 3 个渲染 key（`recycleBin.emptyForce` / `emptyForceConfirmTitle` / `emptyForceConfirm`）+ 1 个主进程 key；`npm run sync-i18n-keys` 把其余 11 包填 `""`（`returnEmptyString:false` 会回落 zh-CN，不会显示裸 key）。
- 验收：`npx vitest run src/renderer/pages` 全绿，含节点 1 的三条红灯转绿。

**节点 6 — 契约文档**

- 文件：`docs/IPC_CONTRACT.md` §2.8（217-243）：参数行加 `force?: boolean`、返回结构加 `forceDeletedCount`、行为注记补 force 链路与"渲染端消费 `message`/`failedCount`"。
- 验收：`npm run docs:links` 绿；`grep -n force docs/IPC_CONTRACT.md` 命中参数行与 `forceDeletedCount`。

**节点 7 — i18n 对齐**

- 验收：`npm run i18n:guard` 输出对齐校验通过。

**节点 8 — 全量回归（硬门槛，不过不收尾）**

- `npm test`（0 失败，覆盖率不低于 `vitest.config.ts` 的 66/58/59/68）· `npm run lint` · `npm run typecheck` · `npm run typecheck:e2e` · `npm run i18n:guard` · `npm run verify`（其 `core-gate` 步骤须对节点 3/4 两个受保护文件判为通过）。全部 exit 0。

**节点 9 — 真机收口**

- `npm run dev`：回收站点「清空」⇒ **红色** toast 写明失败项数 ⇒ 出现「重试清空」与「跳过系统回收站，直接彻底删除」⇒ 二次确认 ⇒ 确认后 `media:list {deletedOnly:true}` 返回 0 条、磁盘文件确实消失（或按节点 0 结论②③如实报告残留原因）。**不做 e2e**：仓库无回收站 e2e spec，新增成本高且需真机卷条件，本次不扩面。

## 7. 基础测试用例（正常 / 异常 / 边界）

| 类别 | 用例                                           | 判据                                                                                                               |
| ---- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 正常 | 非 force，全成功                               | `movedCount=N, failedCount=0`，`shell.trashItem` 调 N 次，`unlink` 不调用媒体文件，DB 删 N，绿色 toast，无重试按钮 |
| 正常 | force，全成功                                  | `forceDeletedCount=N, movedCount=0, failedCount=0`，`trashItem` **不调用**，`hardDeleteBatch([ids])`，列表刷新为 0 |
| 正常 | `failedCount=0` 的成功 toast                   | 沿用主进程 `message`，兜底 `recycleBin.emptySuccess`                                                               |
| 异常 | `failedCount=41`（本次线上实况）               | 红色 toast + 透传主进程文案 + 「重试清空」出现 + **绝不调用 `'success'` toast** + DB 记录保留                      |
| 异常 | force 下 `unlink` EPERM 且文件仍在             | 计入 `failedPaths`，该 id **不进** `idsToDelete`，`hardDeleteBatch` 收 `[]`                                        |
| 异常 | IPC 传输层抛 `IpcError`                        | 渲染层 catch 后仍点亮 `failedAction==='empty'`                                                                     |
| 边界 | 回收站为空（0 行）                             | 主进程早退 `{message:'回收站为空，无需清理', movedCount:0}`，渲染层不误报失败                                      |
| 边界 | 旧调用方零实参 `call('media:emptyRecycleBin')` | 真 zod 判 `[]` 通过，`force === undefined` ⇒ 走系统回收站（向后兼容）                                              |
| 边界 | `force` 传非布尔                               | `VALIDATION_ERROR` ⇒ 渲染层红色 toast，不静默吞                                                                    |
| 边界 | 连续失败触发熔断（阈值 10）                    | 后续项 `retries=0` 快速失败，仍不 fallback unlink（非 force）                                                      |
| 边界 | 返回体 `not.toHaveProperty('success')`         | 契约锁继续为绿                                                                                                     |

## 8. 关键文件清单

| 文件                                                                       | 动作                                       |
| -------------------------------------------------------------------------- | ------------------------------------------ |
| `src/main/ipc/handlers/_trash-utils.ts`                                    | 改（force 原语，豁免闸门）                 |
| `src/main/ipc/handlers/media-lifecycle-handler.ts`                         | 改（⚠ 受保护，替换第 1 行 `@core-change`） |
| `src/main/preload/api/media-action.ts`                                     | 改（⚠ 受保护，新增 `@core-change`）        |
| `src/renderer/vite-env.d.ts`                                               | 改（返回类型）                             |
| `src/renderer/pages/RecycleBinPage.tsx`                                    | 改（失败判定 / 重试 / force 确认流）       |
| `src/renderer/i18n/locales/*.json`（12 包）                                | 改（4 key，zh-CN 手写 + sync 补齐）        |
| `docs/IPC_CONTRACT.md`                                                     | 改（§2.8）                                 |
| `RecycleBinPage.emptyBehavior.test.tsx` / `_trash-utils.force.test.ts`     | 新增                                       |
| `media.test.ts` / `media-lifecycle-handler.test.ts` / `validator.test.ts`  | 追加用例                                   |
| `docs/plans/2026-11-02-fix-empty-recyclebin-failed-as-success-实施计划.md` | 新增（本文件按仓库协议落仓）               |

## 9. 明确不做

顺手重构 `RecycleBinPage`（含把写操作搬进 Zustand)、给 `emptyRecycleBin` 加路径白名单校验（与同批 `trashItem` 现状不对称，属独立安全议题)、自动 fallback 永久删除、`refreshMedia()` 对齐、回收站 e2e spec、把失败 id 持久化成新表/新列（需迁移且无安全收益，force 直接作用于全部 `is_deleted=1`，确认框文案按 `totalCount` 如实写「全部 N 项」）。

---

## 10. 执行记录（实测读数，非计划复述）

| 节点             | 实测结果                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 取证           | 类1 卷级（见上表）。探针与临时目录已全部清理，`H:\` 无残留，真实照片字节数前后一致（6259129）                                                                                                                                                                                                                                                                                                                     |
| 1 红灯           | 主进程侧 **13 failed / 149 passed**；渲染侧行为套件 **4 failed / 2 passed**（2 绿是刻意钉「已正确行为不被破坏」的锚，已在用例名上区分）。`npm run typecheck` 修复前实测报 4 条 TS2353（把 vite-env.d.ts 临时还原到 HEAD 复现，随后原样恢复并确认转绿）                                                                                                                                                            |
| 2 `_trash-utils` | 38 passed（10 新 force + 28 既有缩略图清理，无回归）                                                                                                                                                                                                                                                                                                                                                              |
| 3 handler        | 98 passed（media.test.ts + media-lifecycle-handler.test.ts）                                                                                                                                                                                                                                                                                                                                                      |
| 4 类型           | `npm run typecheck` 绿；preload + validator 套件 86 passed                                                                                                                                                                                                                                                                                                                                                        |
| 5 渲染层         | `npx vitest run src/renderer/pages` **269 passed / 31 文件**；`sync-i18n-keys` 给 11 个语言包各 +5 key；`i18n:guard` 通过                                                                                                                                                                                                                                                                                         |
| 6 文档           | `docs:links` 无死引用                                                                                                                                                                                                                                                                                                                                                                                             |
| 8 全量回归       | `npm test` **465 文件 / 7352 passed / 20 skipped / 0 failed**；`lint`、`typecheck`、`typecheck:e2e` 全部 exit 0；`test:coverage` **exit 0**（71.22 / 62.67 / 64.26 / 72.82，高于 66/58/59/68 门限）；`npm run build` 成功；`npm run verify` 5 项全 ✓（含 core-gate 对两个受保护文件判通过）                                                                                                                       |
| 9 真机           | **部分完成**。用真实构建产物 + **隔离 userData** 跑通：`emptyRecycleBin()` 与 `emptyRecycleBin(true)` 经真实 zod 与真实 IPC 均返回全 5 字段且内层无 `success`；React 挂载（`#root` 2 个子节点）、侧栏导航到回收站、空态渲染、「清空回收站」按钮 disabled（符合空库预期），截图核对无白屏/无布局破损。**未执行**：对用户真实 41 项点「跳过系统回收站直接彻底删除」——该步会永久删除真实照片，属用户决定，已单独交回 |

### 计划与实际的偏差（如实登记）

1. **主进程 i18n 两个 key 提前到节点 3 落地**（原计划放节点 5）：handler 的 force 文案在节点 3 的用例里就要断言，晚加会让节点 3 的验收跑不过。
2. **新增一条计划里没有的测试**：`validator.test.ts` 补 `[undefined]` 形态。原因是节点 4 把 preload 改成无条件 `call('media:emptyRecycleBin', force)`，未选 force 时真实 `rawArgs` 是 `[undefined]` 而非 `[]`；这条若不被真实 zod 覆盖，默认清空路径会在**生产**报 `VALIDATION_ERROR` 而所有 mock 测试全绿。实测 zod 4.6.7 接受它。
3. **`wrapHandlerNoArgs` 的 import 需一并删除**（改造后该文件不再使用），否则 `no-unused-vars` 报错——计划未列。
4. **`_trash-utils.ts` 被 prettier 重排过一次**：`npm run verify` 的 format 步骤实测 ✗ 后按仓库口径 `prettier --write --end-of-line auto` 修正，未放宽任何闸门。
5. **`RecycleBinPage.tsx` 原始 diff 行数（220）大于实质改动（忽略空白后 79+/23-）**：浮动栏子元素被条件化后整体缩进变化，属结构性必要改动，非顺手格式化。
6. **节点 9 的判据被拆成两半**：原计划把「红色 Toast + 出路 + 真实删除」一并验收；执行后确认最后半步是不可逆的用户数据删除，遂只做隔离环境部分并交回决策——这不是偷懒，而是把可逆与不可逆验证分开记账。

---

## 11. 审查轮执行记录（2026-11-02 二次全面审查：8 修 3 记账）

交付形态：用户下达「全面审查近期提交与未提交代码 → 修复 → 六项验证全绿 → 提交 → 版本 2.5.6 → 重打包」。
审查窗口 = 本文件节点 0–9 的全部未提交改动 + `a3cfaf6..d86c7c2` 的源码提交（2.5.6 定版之后的非 docs 提交）。

### 11.1 修复的 8 条（逐条红→绿真实读数）

| 编号 | 站点与缺陷                                                                                                                                                                                                                                                   | 红灯实测（修复前）                                                                                                                                                                                                                 | 绿灯实测（修复后）                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| F1   | `_trash-utils.ts` force 分支写 `{ result: …, error: undefined as unknown }` ⇒ `firstError` 恒未赋值 ⇒ 聚合 `logger.warn` 第二参数是 `undefined`，与同文件「聚合一条含**首个错误**」的自陈不符；用户「直接彻底删除」失败时 EPERM/EBUSY/只读卷无从分辨         | `npx vitest run _trash-utils.force.test.ts` ⇒ **1 failed / 11 passed**，原文 `AssertionError: expected undefined to be an instance of Error`；同批【对照锁】非 force 例为绿（证明夹具不空转）                                      | `_trash-utils.force.test.ts` + `_trash-utils.test.ts` **40 passed**（12 + 28，无回归）                                                   |
| F2   | `zh-CN.json` `recycleBin.emptyForceConfirm` 首句断言「这 {{count}} 项文件**当前无法移入系统回收站**」，而 force 作用于 `getSoftDeletedMediaPaths()` 的当前全部软删除记录（含失败后新软删除、可能落在健康卷的条目）；真机日志本身即混合形态（46 项里 5 成功） | 行为套件把 `ConfirmDialog` 的 `message` 落进 DOM 后断言 ⇒ **1 failed / 6 passed**，原文 `expected '这 41 项文件当前无法移入系统回收站。…' to contain '全部 41 项'`                                                                 | `RecycleBinPage.emptyBehavior.test.tsx` + `RecycleBinPage.empty.test.tsx` **10 passed**；`i18n:guard` ✅（键数不变、其余 11 语包零改动） |
| F3   | `isBareDirectoryRoot` 的 UNC 支 `/^\\\\…/` 只认两个反斜杠起始，而 `absolutePath` 的 refine 放行 `/` 起始 ⇒ `//nas/share` 既过 zod 又过盘根闸，整个共享根可被登记成同步照片源（`f29bd5a` 的 D3 闸从另一侧漏进来）                                             | `nikkisync-handler.test.ts` ⇒ 盘根用例组 **3 failed / 101 passed**，含 `expected false to be true`（`isBareDirectoryRoot('//nas/share')`）                                                                                         | **104 passed**（含 `//nas/share/photos` 子目录继续放行的反向钉）                                                                         |
| F4   | `toAppError` 用 `/not ready                                                                                                                                                                                                                                  | unavailable                                                                                                                                                                                                                        | must be started                                                                                                                          | not running/i`，而生效失败分类只用 `/not ready | unavailable/i`⇒`requireSession()`/ 上游`createPairingPayload`的`Server must be started …` 一族在两条链上拿到不同分类码，与 f29bd5a 自陈的「判据同源」不符 | 红灯原文 `expected { applyError: 'scan-failed' } to match { applyError: 'runtime-unavailable' }`（消息 `Server must be started before creating a pairing payload`） | 与 `installation-not-found` / `scan-failed` / `runtime-unavailable` 三既有例同绿。**如实限定影响面**：`applyGameRoot` 今日可达的错误文案两侧结论一致，本条钉的是判据同源，不是已观测的用户可见故障 |
| F4b  | `:555` 注释写死 `runtime-manager :496/:540` 行号（已漂过一次）                                                                                                                                                                                               | —                                                                                                                                                                                                                                  | 改为引用 `installNotfoundMessage` 与 `state.error` 比较点，不再写行号                                                                    |
| F5   | `stop()` 只在入口 `settleScan()`，未把停机发布进 `state.scanInFlight` ⇒ 停机在途时新到的 `scan()` 只等上一轮扫描、不等这次停机，两条拆除链作用在同一会话上                                                                                                   | `npx vitest run runtime-manager.test.ts` ⇒ 首版判据（拿终态 `state`）**修复前即绿**，属无效判据；改用「按会话对象各自数 `dispose()`」重做后 **1 failed / 87 passed**，实测量为 `[2]`（同一会话被拆两次，关的是同一个 SQLite 句柄） | `npx vitest run src/main/nikkisync` ⇒ **16 files / 325 passed / 0 failed**（域内基线不减）                                               |
| F6   | e2e 头文档仍写「G2 手输根 B」，`d86c7c2` 起 G2 与 G1 同根；G1 行仍写「合成安装根A」而同根已改真机优先                                                                                                                                                        | —                                                                                                                                                                                                                                  | 文档与代码同源，并注明 d86c7c2 的取舍原因                                                                                                |
| F7   | e2e 模块顶层 `process.env.NIKKISYNC_GAME_ROOT = ROOT_BARE` 无复原；`workers: 1` 复用同一进程，该变量语义是「短路整条注册表 / PowerShell / 驱动器枚举链」，且整件 skip 时也会落进环境                                                                         | —                                                                                                                                                                                                                                  | 写入点挪进 `beforeAll`、`afterAll` 复原并加后置断言（撤掉复原即红）                                                                      |
| F8   | e2e G1 用 poll **之前**取的快照断言 `installRoot` / `lastScan`，poll 只校 `state` ⇒ 重建落在 poll 窗口内时判据打在旧会话上（假绿与假红都可能）                                                                                                               | —                                                                                                                                                                                                                                  | 每次 poll 覆盖 `latest`，收敛后对同一份快照判定；`npm run typecheck:e2e` exit 0                                                          |

变异/有效性抽查：F1 做了两次——把 `removeItemPermanently` 的 `failed` 退回不带 error ⇒ 新例复红；把 `failed` 误写成 `missing` ⇒ 既有 B1 例复红；两次复原后 `sha256sum` 与绿灯版逐字节一致（`8dff9d8e…`）。F5 的「修复前实测读数 `[2]`」本身即证明计数探针真的在被判据覆盖（不是空夹具）。

### 11.2 记账的 3 条（取证属实、本轮不修）

- **DEBT-044**「彻底删除选中项」与清空同走 `shell.trashItem`，卷级不可用时无出路（真机日志那条 `1/1` 失败就是它）。用户裁决本轮只修清空。
- **DEBT-045** `scan()` 串行闸门无超时、无合并（连点保存会排队跑 N 次全量扫描）。
- **DEBT-046** 未定义 token `--border-color` 残留 3 处（`plugin-sections.tsx:439` + `ShareCodeDecoderDialog.tsx:271/404`），来自基线 `a89d1e4` 与 `200691f`，在审查窗口之外。

### 11.3 与计划的偏差（如实订正，不改写原始预期）

1. **技术债编号落空重取**：计划 §6-N7 预写 DEBT-042/043/044，实际台账里 042/043 已于 2026-10-30 占用（路径裁剪两条），落账按 `max(id)+1` 改为 **044/045/046**。首次写号还踩到「`nextId()` 在 `push` 之前求值 ⇒ 三条都取到同一个 044」，已当场检出并修正为连号且断言 `dupes: 无`。教训：编号必须从**实际台账**取，不能从计划的想象值取。
2. **F5 的第一版判据无效**（拿终态 `status().state` 判「假 idle」，修复前就绿）。按「修复前就绿的测试等于没覆盖」的纪律推翻重做：改为逐会话对象计 `dispose()` 次数，才现出 `[2]` 的真红。**保留这条失败判据的登记**，否则读者会以为判据一次就写对。
3. **F4 的影响面按计划原文被写大了**：计划里说「渲染层给出扫描失败而不是 Runtime 未就绪」，实测 `applyGameRoot` 的可达错误两侧结论一致，故本条定性为**判据同源修复**而非用户可见缺陷。CHANGELOG 与技术债均按定性后的口径书写。
4. **`_trash-utils.ts` 的 `@core-change` 行未随 F1 更换**：该文件是 handlers 下的 `_` 前缀共享文件，豁免提交面 diff 闸门（`scripts/core-path-gate.ts`），且本轮改动只是把 force 的错误链补全，属同一次 force 能力的一部分，不构成新的授权事由。
5. **新增文件须先 `git add` 再跑全量 `npm test`**：`check-md-links` 的被跟踪文档死引用判据取 `git ls-files`，CHANGELOG 与 `docs/技术债清单.md` 引用尚未入 index 的本计划文档会把全量测试打红一例——本轮实测复现 2 处，`git add` 后 `docs:links` 回到 ✅。

### 11.4 收口验证读数

用户逐项指定的六道 gate，全部本机真跑、全部 exit 0：

| #   | 命令                    | 实测读数                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `npm install`           | exit 0（`300 packages are looking for funding` + allow-scripts 7 条提示，均为既有常态）。**如实登记拆链**：装完 `node_modules/@nikkisync` 只剩空 scope 目录 ⇒ 立刻 `npm run link:nikkisync`（`create` 四条）+ `link:nikkisync:check` 回到 **4 条 ok**；本轮 `package-lock.json` **未被本机 npm 重写**（`git diff --stat` 空），故无「还原 lock」动作 |
| 2   | `npm run build`         | exit 0（`✓ built in 4.90s`）；产物 `dist/main/main/app/index.js` 41,022 B、`dist/main/main/preload.js` 在位。附带的修复到位取证：`application.js` 内 `recycleBinRemoveFailed`=1、`forceDeletedCount`=6；渲染 `i18n-zh-CN-*.js` 命中 F2 新句「本操作作用于回收站当前的全部条目」，旧句「当前无法移入系统回收站」全 dist **0 命中**                    |
| 3   | `npm test`              | **465 files / 7357 passed / 20 skipped / 0 failed**，exit 0。回归核账：上一节点基线为 7352 passed，本轮新增 5 例（F1 两条 + F2 一条 + F4 一条 + F5 一条）⇒ **7352 + 5 = 7357**，文件数 465 不变（未新建套件文件），无既有用例被吞                                                                                                                    |
| 4   | `npm run typecheck`     | exit 0（`tsc -b` + `tsc -p tsconfig.scripts.json`）；另单跑 `npm run typecheck:e2e` exit 0（本轮改了 `e2e/`，该面必须独立验）                                                                                                                                                                                                                        |
| 5   | `npm run e2e:smoke`     | **19 passed（37.4s）**，exit 0；`[e2e] executable:` = `release/win-unpacked/喵星图.exe`（打的是 2026-11-01 出的现役包，本轮修复尚未进包 ⇒ 这一条是基线读数，出包后另跑一次）。改动过的照片目录套件真机复跑：**G1 ok（6.8s）/ G2 ok（6.6s）/ G3 ok（57ms）**，含 F8 的「收敛后快照」判据与 F7 的 `afterAll` 复原断言                                  |
| 6   | `npm run test:ci-linux` | **465 files / 7374 passed / 3 skipped / 0 failed**，exit 0（Linux 宿主语义装置下同一批用例；skip 差 17 条随链接/宿主语义漂移属已知）                                                                                                                                                                                                                 |

静态与安全面：`npm run lint` exit 0 · `npm run i18n:guard` ✅ · `npm run verify` **5 项全 ✓**（typecheck / lint / core-gate / format / test；core-gate 对 `media-action.ts`、`media-lifecycle-handler.ts`、`nikkisync-handler.ts` 三个受保护文件判通过）· `npm run audit` **exit 0（`Passed npm security audit.`，11 条 allowlist 命中含 DEBT-038 的 electron `GHSA-jr5w-w6x2-84p9`，本轮未新增任何豁免）** · `npm run docs:links` ✅ 无死引用 · `npx tsx scripts/check-changelog-release.ts` ✅ · `npm run preview:check` 10 项 FAIL=0 · `npm run debt:check` 4 条提醒（always-exit-0 语义）。

磁盘与产物前提：`D:` 可用 202 GB；仓外留底目录 `../WXNN-XiangCe-release-backup-20261101/` 已含上一轮现役三件与一份 `app.asar.old`（74,142,321 B），本轮出包前把当前 `release/` 三件再归档进去。

### 11.5 版本号核验与出包读数（N11 / N12）

**版本号（零编辑，有判据）**：八处声明位实测同为 2.5.6 —— `package.json` / `package-lock.json` 根 /
`packages[""]` / `README.md:10` 徽章 / `DEVELOPMENT.md`「当前版本」/ `DEVELOPMENT.en.md`「Current version」/
`AGENTS.md`「喵星图，v2.5.6」/ `CHANGELOG.md` 首个版本节。两道闸门复跑通过：
`check-changelog-release.ts`（15 个版本节、`[2.5.6]` 唯一、`[Unreleased]` 无待发布条目）、
`check-doc-versions.ts`（README 的 Electron 41.10 对 `package.json` 41.10.6）。
本轮 5 笔提交**未触碰** `package.json` / `package-lock.json`（`git log --name-only` 无命中）
⇒ 「把版本号设成 2.5.6」的真实交付是「有判据的零编辑」，不是找个地方改一下。

**出包**：标准配方 `npm run dist:win` **一次跑通**（本机杀软本轮未锁新建 asar），`EXIT=0`；
**未启用** electronDist 旁路、**未改**任何配置文件。新 `release/MeowStarMap-Setup-2.5.6.exe` 184,656,080 B
（出包前把现役包 184,655,711 B 三件归档到仓外 `../WXNN-XiangCe-release-backup-20261102/`）。

| 判据                            | 实测                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 新旧 `latest.yml` **size 轴**   | 184,655,711 → 184,656,080（不同）                                                                                                           |
| 新旧 `latest.yml` **sha512 轴** | `luOCEAnq…` → `Kd3ezrpC…`（不同）⇒ 不是只换 releaseDate 的空重跑                                                                            |
| `npm run verify:dist` 裸跑      | **exit 0**；禁串步读的是 `release\win-unpacked\resources\app.asar`（74,149,975 B，本轮新树），原生二进制与 `@nikkisync` 迁移 SQL 解包逐项 ✔ |
| 出包后 `npm run e2e:smoke`      | **19 passed（36.4s）**，`[e2e] executable:` = `release/win-unpacked/喵星图.exe`（新产物）                                                   |

**包内字节级差分取证**（`@electron/asar` 对新包 vs 上一轮归档 `app.asar.old` 逐 needle 取数；条目名是反斜杠
带前导 `\`，只去前导分隔符、绝不把 `\` 换成 `/`，换了必 `was not found in this archive`）：

| needle                                                  | 新包                         | 旧包（归档） | 结论                                                                                            |
| ------------------------------------------------------- | ---------------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `recycleBinRemoveFailed`（F1 新日志 key）               | 25                           | **0**        | F1 与主进程 i18n 两个新 key 确实入包                                                            |
| `本操作作用于回收站当前的全部条目`（F2 新句）           | 2                            | **0**        | F2 文案入包（主进程与渲染层两侧 locale 包）                                                     |
| `当前无法移入系统回收站`（F2 旧句）                     | **0**                        | 0            | 旧句包内 0 命中；旧包根本没有该键 ⇒ 新文案是本轮新入包的                                        |
| `(?:\\\\                                                | \/\/)`（F3 新 UNC 起始分支） | 1            | **0**                                                                                           | F3 正则入包 |
| `/^\\\\[^`（旧 UNC 独占特征）                           | 1                            | **2**        | 新包少一次；余下那次经上下文核对属 `UNC_ADMIN_SHARE_RE`（既有、与本次无关）⇒ 旧形态在包内已消失 |
| `scanInFlight`（F5 串行句柄属性名，esbuild 不改属性名） | 8                            | **5**        | +3 恰为 `stop()` 挂进闸门所需的「发布 / 比对 / 复位」三处                                       |
| `forceDeletedCount` / `must be started` / `not running` | 6 / 1 / 2                    | —            | F1 计数与 F4 收敛后的短语集均在主进程产物内                                                     |

**打包态契约真机判据**（临时探针 spec，真实打包产物 + 隔离 userData，跑完即删、不入仓）——在 shipped
二进制里经**真实 zod**（不是 mock-validator）调用 `media:emptyRecycleBin`：

- 零实参（老调用方形态，preload 传成 `[undefined]`）⇒ `{message:"回收站为空，无需清理", movedCount:0, missingCount:0, failedCount:0, forceDeletedCount:0}`，五字段齐备、内层无 `success`；
- `emptyRecycleBin(true)` ⇒ 同五字段，同样通过；
- 故意传字符串 `'true'` ⇒ 被真 zod 拒成 `参数校验失败：[0] Invalid input: expected boolean, received string`（不静默当 false）。

这条补上了单元层看不到的那一面：`media.test.ts` 的 mock-validator 不执行 schema，向后兼容只有打进产物再跑一次
才算被真机证明。**未执行**：对用户真实 41 项点「跳过系统回收站直接彻底删除」——不可逆的用户数据删除属用户决定，
仍单独交回。

### 11.6 本轮提交序列

`3401156` fix(recyclebin)（25 files，含计划文档与 CHANGELOG）· `4345980` fix(nikkisync) 盘根闸 + 分类同源 ·
`00cb7d2` fix(nikkisync) stop/scan 同闸门 · `734214b` test(e2e) 三处判据卫生 · `f434be9` docs(debt) 三条登记 ·
本次 `chore(release)` 回写收口读数。每笔都过了 `[PRE-COMMIT]` 三步（lint-staged / core-gate / tsc -b），
未使用 `--no-verify`；提交后对最终内容复跑 `npm test` 得 **465 files / 7357 passed / 20 skipped / 0 failed**
（与提交前逐字一致 ⇒ 钩子的 prettier 改写没有改变任何读数），并复跑 `npm run build`、`verify:dist`、`e2e:smoke`。
**未 push**（发布动作需另行批准）。
