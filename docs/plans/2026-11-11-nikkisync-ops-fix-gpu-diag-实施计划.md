# 修复「其他电脑导出/收藏/删除失效 + 界面花屏」实施计划

## Context（为什么改）

故障机诊断包（`D:\Users\Downloads\wxnn-logs-2026-11-10.zip\wxnn-logs-2026-11-10.zip`，2.5.6 正式版，Win11 Insider 26300，i7-12700H 混合显卡）+ 用户报错原文 **「参数校验失败：[0.0] Invalid input expected number, received NaN」** 确诊两条根因：

**根因 A（三功能失效）**：故障机持久化 `gallery.dataSource='nikkisync'`，图库卡片 `id=assetId`（字符串，`src/renderer/utils/assetViewModel.ts:89`），但操作 hook 硬编码本地库通道 `Number(file.id)` → NaN → zod 恒拒：

- 收藏 `src/renderer/hooks/useFavoriteToggle.ts:32`
- 删除 `src/renderer/hooks/useFileOperations.ts:292/304`（批量 :334 起同病）
- 导出走 file_path 不受 NaN 影响，但 `file:export` 的 `assertMediaAccessPath` 依赖 `src/main/nikkisync/resource-allowlist.ts` 内存授权表——runtime 未运行时表被 clear() → 恒 IPC_PATH_FORBIDDEN。诊断包实锤状态漂移：10:55 启动 `runtime disabled`，11:01 渲染层连报 3 次 `NikkiSync runtime is not ready (runtime state is idle)`。

设计意图（`docs/sync-integration/04-ui-bridge-plan.md`）：nikkisync 模式用户编辑写 `asset_edits` 叠加层。**读路径已接、写路径从未接**（全仓无 `assetEdits.set` 消费点）。连带缺口（不修等于没修）：

1. `asset-edits:set` 是**整行覆盖**（`asset-edits-repository.ts` toParams：缺省字段落列默认值）→ 直接接收藏会清零 rating/tags/notes，必须先改合并语义。
2. `operationHistoryStore.ts:119` 把 mediaId 一律 `Number()` → assetId → NaN → 历史落库被 zod 拒 → 每次收藏弹「历史保存失败」。
3. `fetchAssetPage` 不过滤 `is_deleted`（mediaStore.ts:397 只滤 profileUid）→ 隐藏后卡片仍在图库。
4. `loadRecycleBin` 只查本地库、`RecycleBinPage` 三个操作全部 `Number(id)` → nikkisync 隐藏资产进不了回收站、无法恢复。
5. 撤销栈两处 undo handler（useFileOperations.ts:93/:111）走本地通道。

**根因 B（花屏，证据受限）**：GPU 子进程全天反复 reason=killed，主进程多次 when-ready 阶段被原生层杀死；三级自愈已升 compatLevel=2 且 diag.log 实锤 `--disable-gpu --disable-software-rasterizer` 已下发仍被杀。诊断包缺 GPU 型号/驱动、缺 chromium-debug.log（manifest 声称有但包内无）、缺 gpu-pref.json。**现有证据不足以定论花屏根因，本轮只补取证，不做 GPU 开关盲改。**

**附带事实**：自动更新 404（2.5.6 release 无 latest.yml，上传是发布人动作）；故障机 3665 入库文件 935 磁盘缺失（导出缺失文件按现有逐文件失败如实报告，非缺陷）。

**明确不纳入范围**：ENOTEMPTY search-index.tmp 未捕获错误；详情页评分/标签/备注写路径（`updateMediaFileAndPersist`，同属叠加层缺口但不在确诊三功能内，列后续任务）；GPU 开关盲改；上游 organizer 删除队列接入。

---

## 1. 依赖声明

**零新增依赖、零版本变更。** 全部复用仓内既有设施：`assetEdits` API、`toAssetViewModel`、`settleWithConcurrency`（`src/shared/utils/concurrency.ts`）、`extractUserMessage`、`wrapHandler`+zod、FakeDb/db 桩测试约定、`collectGpuStatus` 探针（`src/main/app/gpu-status.ts:96`）。不执行 npm install（若执行过，须重跑 `npm run link:nikkisync` 恢复 junction）。

## 2. 启动说明

- 环境：Windows x64，Node ≥ 22.12.0（package.json engines），Electron 41.10.6；`npm ci` 安装。NikkiSync 链接可选（未链接是受支持默认态，链接态用例自动 skip）。
- 开发启动 `npm run dev`；构建 `npm run build`；冒烟 `npm run e2e:smoke`（须先 build，`e2e/dist-guard.ts` 拦截）。
- 每子任务跑对应测试子集 + `npm run verify`（只读）；全量收尾见 §8。
- 漂移场景手工复现（T3 验收）：dev 设置页写 `gallery.dataSource='nikkisync'` + `nikkisync.runtimeEnabled=false` 后重启 → diag.log 出现 forcing 启动行、图库可取数、导出可选目录成功。

## 3. 错误处理（异常分支 / 兜底 / 日志）

- 主进程新通道一律 `wrapHandler` + zod；业务错误抛 AppError 家族（db 未就绪 `AppError.preconditionFailed`，复用 `main.error.databaseNotInit`）；runtime 未就绪沿用 nikkisync-handler `toAppError` 的 PRECONDITION_FAILED 分类，不新增错误码。
- 渲染层 toast 一律经 `extractUserMessage`（useFavoriteToggle 现有 `error.message` 直弹顺手订正）；批量操作沿用「逐文件失败如实报告 + 成功项移出 store」。
- 回收站回捞：单资产 detail 失败跳过 + console.error（复用 `mediaStore.log.*` key）；整页全失败返 null 保留旧列表（与 fetchMediaFromDatabase null 契约同口径）。
- 取证链全 fail-open：GPU 探针失败 ⇒ `info.gpu=null`；chromium 探测失败只留痕；诊断包单文件复制失败不拖垮整包。
- 撤销历史：NaN 守卫后 assetId 操作的 mediaId 落 undefined（payload 携带 assetId，撤销不依赖 DB 行 media_id）。

## 4. 参数校验（入参类型 / 必填 / 边界 / 非法值）

| 通道                                   | 校验                                                                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asset-edits:set`（既有，schema 不变） | assetId: string trim 1..128；patch 各键可选（isFavorite boolean、rating int 0..5、tags ≤50×(1..64)、notes ≤5000、categoryId int≥1 nullable、isHidden boolean 等）；**deletedAt 不接受渲染层传入**，由主进程生成 |
| `asset-edits:listHidden`（新）         | `z.tuple([z.object({ limit: int 1..500, offset: int 0..1_000_000 })])`；越界/非整数/缺参 ⇒ VALIDATION_ERROR                                                                                                     |
| 渲染层分流                             | 仅当 `file.nikkisync?.assetId` 为非空字符串走叠加层；本地分支保持 `Number(id)`；`operationHistoryStore.push` 的 mediaId 仅 `Number.isFinite` 时下传                                                             |
| 启动 forcing                           | `gallery.dataSource` 非字符串回落 'local'；env 只认精确 '0'/'1'，`NIKKI_NIKKISYNC_RUNTIME=0` 逃生阀优先级不变                                                                                                   |

## 5. 基础测试用例（正常 / 异常 / 边界）

- **正常**：nikkisync 卡片收藏 → `assetEdits.set(assetId,{isFavorite})` 且本地通道零调用；软删 → isHidden=true 且卡片移出图库、进回收站；恢复 → isHidden=false 且 deletedAt=null；导出经授权表放行；source=nikkisync 启动 forcing runtime。
- **异常**：set 部分补丁不 wipe 既有 rating/tags；detail 回捞 404 跳过；runtime idle 取数返 null 保留旧列表；GPU 探针 reject 时诊断包仍成功（gpu=null）；撤销 payload 带 assetId 走叠加分支；push assetId 不再产生 NaN mediaId。
- **边界**：listHidden limit=0/501、offset=-1 拒；空隐藏集 `{edits:[],total:0}`；重复隐藏保留首次 deletedAt；isHidden=false 清 deletedAt；env=0 压过 forcing；隐藏过滤后游标照常推进；offset 翻页去重；chromium 日志存在/缺席两态探测行。

**红-绿纪律**：每个回归测试必须先跑出红（修复前失败），否则重写测试判据；改码后同命令转绿。测试与源码同目录 `*.test.ts(x)`。

## 6. 分子任务清单（依赖序 T0→T1→T2→T3→T4→T5/T6/T7→T8→T9→T10/T11→T12）

> 通用：受保护文件（handlers/services/preload api）实质改动须在**前 5 行内替换**一条 `// @core-change: <真实中文原因>`。源文件 UTF-8 无 BOM、LF。每节点收尾 `npm run verify`。

### T0｜计划落盘仓库

- 将本计划写入 `D:\Workbuddy 项目\WXNN YD - 副本\WXNN XiangCe\docs\plans\2026-11-11-nikkisync-ops-fix-gpu-diag-实施计划.md`（用户要求写入仓库；plan mode 期间只能写计划文件，批准后第一步落盘）。
- 验收：文件存在，`npm run docs:links` 不新增死引用。

### T1｜asset-edits:set 合并语义 + deletedAt 自动时间戳

- 文件：`src\main\ipc\handlers\asset-edits-handler.ts`（受保护，@core-change: set 改为部分合并保留既有编辑，isHidden 翻转由主进程落 deletedAt）；`src\shared\types\electron-api.ts`（仅订正 AssetEditsPatchInfo JSDoc）。
- 输入/输出：入参出参形状不变。内部 `getOne` → base patch → `{...base,...patch,updatedAt:now}`；isHidden=true ⇒ deletedAt=既有值??now（重复隐藏保留首次）；isHidden=false ⇒ null；未给 isHidden ⇒ 保留。
- 红灯：`asset-edits-handler.test.ts` 追加：①已有行 rating=4/tags 非空，set {isFavorite:false} → INSERT params rating 位=4、tags 保留（现状落 0/[] ⇒ 红）；②isHidden 翻转时间戳三态；③无既有行部分补丁落列默认。
- 验收：`npx vitest run src/main/ipc/handlers/asset-edits-handler.test.ts` exit 0，既有用例不回归。

### T2｜asset-edits:listHidden 新通道

- 文件：`src\main\database\asset-edits-repository.ts`（listHidden(limit,offset) 静态 SQL `WHERE is_hidden=1 ORDER BY deleted_at DESC, asset_id ASC LIMIT ? OFFSET ?` + countHidden()，缺表回退 []/0）；`asset-edits-handler.ts`（与 T1 同批同条 @core-change，注册通道返回 {edits,total}）；`src\main\preload\api\asset-edits.ts`（受保护，@core-change: 新增 listHidden；一行 call 装配，**键数不变 ⇒ preload.test.ts 清单断言不动**）；`src\shared\types\electron-api.ts`（AssetEditsHiddenPageInfo）；`docs\IPC_CONTRACT.md` §9（listHidden 行 + set 合并/deletedAt 语义注记）。
- 红灯：`asset-edits-repository.test.ts`（只回隐藏行/排序/limit-offset 绑定/缺表回退）；`asset-edits-handler.test.ts`（通道数断言 2→3 先红；越界 VALIDATION_ERROR；空表；db=null PRECONDITION_FAILED）。
- 验收：`npx vitest run src/main/database/asset-edits-repository.test.ts src/main/ipc/handlers/asset-edits-handler.test.ts` exit 0；`npm run typecheck` exit 0。

### T3｜启动漂移修复：source=nikkisync ⇒ forcing 启动 runtime（同时救活导出）

- 文件：`src\main\app\nikkisync-runtime-setup.ts`（非受保护）。导出纯函数 `shouldForceRuntimeForGallerySource(env, settings)`；早退条件（现 :479 `!resolveRuntimeEnabled(...) && !syncEnabled`）追加第三条件；forcing 命中 runtimeLog 留痕。不碰装载缝变量式 import、不碰探针。
- 红灯：`src\main\app\__tests__\nikkisync-runtime-setup.test.ts` 追加：①runtimeEnabled=false + dataSource=nikkisync ⇒ manager.start 调 1 次（现状早退 ⇒ 红）；②同①+env=0 ⇒ 不调；③dataSource=local ⇒ 不调；④脏值 ⇒ false。
- 验收：`npx vitest run src/main/app/__tests__/nikkisync-runtime-setup.test.ts` exit 0。**file-export-handler.ts 零改动**（授权链：runtime start → 图库 getResourceRecords('path') → registerNikkiSyncResourcePaths → 规则 4 放行）。

### T4｜assetDetailToSummary 纯函数

- 文件：`src\renderer\utils\assetViewModel.ts`（新增 `assetDetailToSummary(asset: NikkiAsset): AssetSummary`；模型转换只允许在此文件）。
- 红灯：`assetViewModel.test.ts`：派生映射正常例；motion/metadata 缺席 ⇒ false；toAssetViewModel 消费派生 summary + edit.isHidden ⇒ is_deleted=true、deleted_at 取 edit。
- 验收：`npx vitest run src/renderer/utils/assetViewModel.test.ts` exit 0。

### T5｜收藏写路径 + 撤销 + 历史 NaN 守卫

- 文件：`src\renderer\hooks\useFavoriteToggle.ts`（assetId 分支 → assetEdits.set；payload 带 {assetId,originalFavorite,newFavorite}；catch 改 extractUserMessage）；`src\renderer\hooks\useFileOperations.ts`（favorite_toggle undo :111 按 payload.assetId 分支）；`src\renderer\stores\operationHistoryStore.ts`（push mediaId 改 Number.isFinite 守卫）。
- 红灯：`useFavoriteToggle.test.ts`（nikkisync 文件 id='a/1' ⇒ set 被调、updateFavorite 零调用、失败回滚 + userMessage 优先）；`useFileOperations.restore-undo.test.ts`（undo 带 assetId 走 set）；`operationHistoryStore.test.ts`（push mediaId='a/1' ⇒ add 收到 undefined，现状 NaN ⇒ 红）。
- 验收：`npx vitest run src/renderer/hooks/useFavoriteToggle.test.ts src/renderer/hooks/useFileOperations.restore-undo.test.ts src/renderer/stores/operationHistoryStore.test.ts` exit 0。

### T6｜删除写路径：软删/彻底删/批量/撤销

- 文件：`src\renderer\hooks\useFileOperations.ts`。软删（:304）assetId ⇒ assetEdits.set({isHidden:true})，toast 复用 `main.media.message.softDeleted`（零新增 key）；彻底删（:292）⇒ file.deletePermanent([file_path]) + assetEdits.set({isHidden:true})，**不调 mediaAction.delete**；deleteFilesBatch（:334）knownIds 扩为 Map<id,MediaFile> 逐 id 分流；media_soft_delete undo（:93）payload.assetId ⇒ set({isHidden:false}) + onRefreshMedia。
- 红灯：`useFileOperations.test.ts` + `useFileOperations.deleteProgress.test.tsx`：软删/彻底删/批量混合 id 集/撤销四组，断言本地通道零调用 + 叠加层参数 + 失败项保留。
- 验收：`npx vitest run src/renderer/hooks/useFileOperations.test.ts src/renderer/hooks/useFileOperations.deleteProgress.test.tsx` exit 0。

### T7｜图库取数过滤隐藏资产

- 文件：`src\renderer\stores\mediaStore.ts`（fetchAssetPage :397 附近追加 `!file.is_deleted` 过滤；游标/hasMore 照常推进）。
- 红灯：`mediaStore.nikkisync.test.ts`：一页含 isHidden=true 资产 ⇒ files 不含它、nextCursor 不变（现状含 ⇒ 红）；state='deleted' 同样被滤。
- 验收：`npx vitest run src/renderer/stores/mediaStore.nikkisync.test.ts` exit 0。

### T8｜回收站取数 nikkisync 分支

- 文件：`src\renderer\stores\mediaStore.ts`。loadRecycleBin 按 source 分流到 loadNikkiRecycleBin()：listHidden(limit=200=RECYCLE_BIN_PAGE_SIZE, offset) → settleWithConcurrency 并发 5 逐条 getAssetDetail（失败跳过）→ 整页一次 getResourceRecords('path') → assetDetailToSummary + toAssetViewModel（edit 用 listHidden 行）→ 写 recycleBinFiles/Total/HasMore；模块级 offset 复位/推进；loadNextRecycleBinPage 同分流 + dedupeAgainst；整页全失败返 null。
- 红灯：新增 `src\renderer\stores\mediaStore.recycle-nikkisync.test.ts`（沿用 mediaStore.nikkisync.test.ts 桩手法）：正常回捞（id=assetId、deleted_at 来自 edit、file_path 来自 path records）；detail 404 跳过；全失败保留旧列表；续页去重；local 源仍走 media.list。
- 验收：`npx vitest run src/renderer/stores/mediaStore.recycle-nikkisync.test.ts src/renderer/stores/mediaStore.nikkisync.test.ts` exit 0。

### T9｜回收站操作 nikkisync 分支

- 文件：`src\renderer\pages\RecycleBinPage.tsx`（restore ⇒ set({isHidden:false})，toast 复用 `main.media.message.restored`；permanentDelete ⇒ file.deletePermanent([file_path])，file_path 空按失败计；emptyRecycleBin ⇒ listHidden 按 500/页遍历 + 整页 file.deletePermanent，行数上限 ceil(total/500)）；`src\renderer\i18n\locales\*.json` 12 份（仅新增 2 key：`recycleBin.assetPermanentConfirm` / `recycleBin.assetEmptyConfirm`，明示「直接从磁盘删除、不经系统回收站」）。
- 红灯：`RecycleBinPage.restore.test.tsx` / `.permanentDelete.test.tsx` / `.empty.test.tsx` 各加 nikkisync 组（本地 mediaAction 零调用 + 通道参数 + 失败重试态）。
- 验收：三测试文件 exit 0；`npm run i18n:guard` exit 0。
- 语义边界（写入 CHANGELOG）：彻底删除/清空后叠加层行保留（上游 assets 表归 runtime 所有），回收站条目仍在、缩略图转占位，待上游重扫标 missing。

### T10｜诊断包取证补全（花屏证据链）

- 文件：`src\main\services\log-service.ts`（受保护，@core-change: 诊断包补 GPU 状态段与 gpu-pref.json，manifest 按实际入包文件登记并声明缺失）。collectSystemInfo 加 gpu 段（`await import('../app/gpu-status')` 动态引入 collectGpuStatus，避免 services→app 静态耦合；失败 ⇒ gpu=null）；复制 userData/gpu-pref.json 入包；manifest contents 按实际复制结果构建 + missing 数组。
- 红灯：`log-service.test.ts`（vi.mock gpu-status）：system-info 含 gpu 段（现状无 ⇒ 红）；探针 reject 导出仍成功；gpu-pref 存在则入包；chromium 缺席 ⇒ contents 不含 + missing 含。
- 验收：`npx vitest run src/main/services/log-service.test.ts` exit 0。

### T11｜chromium-debug.log 缺失可判定化

- 文件：`src\main\index.ts`（appendSwitch 成功后 diagLog 记录意图路径）；`src\main\utils\startup-diagnostic.ts`（新增纯函数 chromiumLogPresenceLine(diagDir)：existsSync+size，fail-open；宿主 path 属 IO 层，不引入 win32 钉 ⇒ 无需 path-semantics-guard 登记）；`src\main\app\lifecycle.ts`（createMainWindow 后写 presence 行进 diag.log）。
- 红灯：`startup-diagnostic.test.ts`：临时目录造文件 ⇒ exists=true+size；缺席 ⇒ exists=false；stat 抛错 ⇒ fail-open 行。
- 验收：`npx vitest run src/main/utils/startup-diagnostic.test.ts` exit 0；`npm run dev` 手工确认 diag.log 出现 target 行与 presence 行。

### T12｜文档与发布收口

- `docs\IPC_CONTRACT.md` 复核 §9；`CHANGELOG.md` 新版本节（三功能修复、回收站语义边界、取证补全、latest.yml 发布动作；**只写 commit 短哈希，不写 docs/plans 路径**——仓库硬约束）；复核 3 处 @core-change；`npm run verify` core-gate 通过。

## 7. 节点验证口径

每任务：先红（指定测试文件）→ 改码 → 同命令绿 → `npm run verify`（typecheck + lint 只读 + core-gate + prettier --check + 相关单测）。失败即修复后重跑，不跳过不弱化。

## 8. 收尾全量验证（全部 exit 0 方可发布）

```
npm run lint
npm run typecheck
npm run typecheck:e2e
npm run i18n:guard
npm test
npm run test:ci-linux
npm run audit
npm run build
npm run e2e:smoke
```

手工验收（dev）：①漂移场景重启 forcing 生效；②nikkisync 源收藏/软删/恢复/彻底删/批量/撤销全链路；③导出选目录成功；④导出诊断包含 gpu 段 + gpu-pref.json + manifest missing 如实。

## 9. 发布注意事项

1. **latest.yml 必须随安装包上传**（2.5.6 自动更新 404 的直接原因，发布人动作，代码代做不了）。
2. **故障机只能手动升级**（其 2.5.6 自动更新链路已断）；升级后首次启动 T3 forcing 生效，无需手动开 runtime。
3. 花屏未定论：本版本只补取证。收到新诊断包（含 gpu 段/gpu-pref.json/chromium presence 行）后再裁决杀进程来源（杀软/Insider 构建/GPU 阶梯），本轮不动任何 GPU 开关。
4. 935 磁盘缺失文件导出按现有逐文件失败如实报告，非缺陷，不修。
