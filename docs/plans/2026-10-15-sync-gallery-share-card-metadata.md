# 阶段 5：同步图库独立入口 + 分享图移植 + 元数据详情

> 生成日期：2026-10-15 · 分支 `feat/gallery-runtime-embed` @ `661db3a` · 上游 NikkiSync @ `d4ca7d7`
> 唯一真相源：本文件。范围依据见 [`../sync-integration/04-ui-bridge-plan.md`](../sync-integration/04-ui-bridge-plan.md)（阶段 4 已交付面）。
> 铁律：**不新增第二个 SQLite 连接**、**不新增 IPC 通道**、**不改 NikkiSync 任何源文件**、**不 commit / 不 push**。

---

## 0. 步骤 0 执行记录（代码同步与现状取证，已完成）

| 动作                     | 现场命令                                                                      | 原始输出与判定                                                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定位真实仓库             | `find . -maxdepth 3 -name .git`                                               | `./NikkiSync/.git`、`./WXNN XiangCe/.git` ⇒ 工作区根只是容器目录，Electron 应用在 `WXNN XiangCe/`                                                                                                                                             |
| NikkiSync 是否需拉取     | `git -C NikkiSync ls-remote origin main` vs `git -C NikkiSync rev-parse HEAD` | 两侧同为 `d4ca7d7a164d44ca91dcc3e7e7604b9839296ad3` ⇒ **已在 GitHub 最新，跳过 fetch/checkout/pull**（执行它们只会是无操作或制造风险）                                                                                                        |
| NikkiSync 是否有本地改动 | `git -C NikkiSync status --porcelain=v1`、`git stash list`                    | 均空 ⇒ 无需 stash/rebase                                                                                                                                                                                                                      |
| 建链复验                 | `npx tsx scripts/link-nikkisync.ts --check`                                   | `root=...\NikkiSync source=sibling`，四链全 `ok`，退出码 0                                                                                                                                                                                    |
| 装载面诊断               | `npx tsx scripts/verify-nikkisync-link.ts`                                    | **退出码 0**，10 项全 ✓（依赖自包含 / 四链在位 / 四包 `dist` 齐 / migrations 可读 / LocalSyncServer 与 GalleryRuntime 产物在位 / 主进程产物无 `require("@nikkisync` / `app.asar.unpacked` 含 schema / node:sqlite 可导入 / electron 41.10.6） |
| **不跑 `npm install`**   | —                                                                             | 它会剪掉 `node_modules/@nikkisync/*` 四条 junction（本目录 AGENTS.md 规则 6），令全部 `*.linked.test.ts` 集体降级为 skip，把真实回归藏起来                                                                                                    |
| 基线闸门                 | `npm run typecheck`、`npm test`                                               | `TYPECHECK_EXIT=0`；**Test Files 380 passed / Tests 5983 passed \| 2 skipped / EXIT=0 / 46.84s**，其中 `sync-server.linked.test.ts` 12 例真实执行（未降级 skip）                                                                              |

### 0.1 本阶段新增的三条会改变方案的取证

只读方式：复制 `{userData}/nikkisync/nikkisync.db(+wal)` 到临时目录后查询，**原文件时间戳与大小逐字未变**。

| 事实                                                                                                                                                                                                                         | 证据                                                                                                                                                    | 后果                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 内嵌库有 31 个资产（25 `photo` + 6 `motion_photo`），`resources` 60 行（`source_high_quality` 25 / `source_low_quality` 23 / `source_primary` 6 / `source_motion` 6），**无任何 `derived_*`**                                | `SELECT asset_type, COUNT(*) FROM assets GROUP BY asset_type`、同构查询 role 分布                                                                       | 缩略图只能由本 App 按需生成（沿用 `useOnDemandThumbnails`），不能指望上游                                                                                                                                                |
| `assets.metadata_json` 31/31 非空，但结构是 `{schemaVersion, identity, capture:{}, camera:{}, raw{nativeParamToken, nativeParamPayload, nativeParamNuan5Md5}}`——**`camera` 与 `capture` 恒为空对象，`dressing` 全表 0 命中** | 逐行 `JSON.parse` 统计：25/31 有 raw 载荷（约 48KB base64），6 个 `motion_photo` 连 raw 也没有                                                          | **穿搭/拍摄参数无法从 metadata 得到**。C2/C3 的实际数据源必须是本 App 已有的解密链 `decrypt:decodeFile`；metadata 只是「将来 resolver 打开后」的优先覆盖源。据此，C1（路径授权口径）不是优化项而是**唯一可行路径的前置** |
| 上游 `revision_journal` 不存在；TS 侧无分享图实现                                                                                                                                                                            | 全仓 grep `revision_journal` = 0 命中；`grep -rln ShareCard --include=*.ts apps packages` = 0；`grep playerMetadata apps/pc-companion/src/index.ts` = 0 | 真名是 `change_journal` + `library_state.library_revision`（移植面 `sync_change_journal`）；分享图只能**移植**小程序 `share-card.js`，不存在「直接调用不重写」                                                           |

### 0.2 一处需要重新确认的验收标准

原验收第 7 条「分享图输出与 NikkiSync 原生效果一致」在**像素层面不可达**：图标只存在于 `metadata.dressing.clothes[].thumbnail`，该列由上游远端字典提供器写入，而本 App 的 `createRuntimeSession`（`src/main/nikkisync/runtime-facade.ts:408`）只传 `databaseFile / scanner / server`；本仓亦无任何单品图标资源；接 CDN 图标又要新增主进程下载通道（受保护路径）。

等价判据改为三条可测项：**几何等价**（同一录制型假 ctx 下 op 序列与坐标逐项相等）、**语义等价**（payload 五段 / `PARAMETER_ORDER` 顺序 / `—` 缺值语义 / 别名表）、**降级等价**（图标格走原生 `图标暂缺` 分支且 `missingIcons` 如实返回）。字体渲染差异不做数值门槛，仅人工并排目测。

---

## 1. 依赖声明

- **零新增 npm 依赖**（`qrcode ^1.5.4` 已在；不移植 `@napi-rs/canvas`，避免新增原生依赖 + Electron ABI + `pre-dist-check.ts` 校验项）。
- 不改 `package.json`；不新增 `@nikkisync/*` 静态值/类型导入（ESLint 双层护栏 + 阶段 9 自包含决策）。
- 跨进程类型一律 `import type` 自 vendored `src/shared/sync/protocol.ts` / `domain-types.ts`。
- **不跑 `npm install`**；若因故跑过，立刻 `npm run link:nikkisync` + `npm run verify:nikkisync` 复验。

## 2. 启动说明

```bash
cd "WXNN XiangCe"
npm run link:nikkisync          # 确认四链在位
npm run verify:nikkisync        # 事实表（预期退出码 0）
npm run dev                     # 设置页开 nikkisync.runtimeEnabled 后进入侧栏第 10 项
```

## 3. 范围与已交付面（不重复实现）

| 原诉求子项            | 已存在实现（阶段 1–4）                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| 同步数据库连接实例    | 内嵌 Runtime 独占 `{userData}/nikkisync/nikkisync.db`                                                  |
| 只读 Repository       | `runtime-facade.ts` `createQuerySurface()` = 上游 `SyncReadRepository` + `row-mappers` 零转换          |
| 独立 IPC 命名空间     | 17 条 `nikkisync:*` + 6 条 `sync:*`                                                                    |
| Asset→多Resource 适配 | `renderer/utils/assetViewModel.ts` `toAssetViewModel()`；`mediaStore.source: 'local' \| 'nikkisync'`   |
| 服务生命周期          | `nikkisync/runtime-manager.ts` 状态机（含 `startSyncServer/stop/syncStatus/pairingCode/revokeDevice`） |
| 配对二维码            | `renderer/components/sync/PairingQrDialog.tsx`                                                         |

本阶段真实缺口只有三块：**独立一级入口（A）**、**分享图（B）**、**穿搭/拍摄参数展示（C）**，外加一个挡住 B/C 的授权口径缺陷 **C1**。

## 4. 架构决策

- **D-A 独立 store，共享取数函数，不共享 mediaStore 的列表**。否决「进新页时 `setSource('nikkisync')`」：GalleryPage 是 keep-alive 常驻，其 effect 依赖 `currentView`，导航即触发 `fetchMediaFromDatabase()`，而源分流发生在**调用时刻** ⇒ 两个源的请求互相覆盖 `mediaFiles`、翻页游标串味，且「不改 GalleryPage」无法兑现。落地：把 `mediaStore.ts` 的 nikkisync 取数段抽成导出纯函数 `fetchAssetPage()`（不写 store），原函数改为调用它并自行 `setState`（分流点语义不动）；新建 `syncGalleryStore.ts`。
- **D-B 分享图在渲染层 canvas 生成，落盘复用既有通道**。`toDataURL` → `electronAPI.editor.saveAs`；「打开所在位置」用 `shell.showItemInFolder`。⇒ 两个受保护面（`ipc/handlers/**`、`preload/api/**`）一行不改，零 `@core-change` 成本。
- **D-C 详情参数 = 单一 hook `useAssetParams`**。`hasMetadata` 且映射非空 ⇒ `nikkisync.getAssetDetail`；否则回落 `useGameParams`（解密链）。五个面板 JSX 不动，只换 hook 调用点。依据 §0.1，本机实际会**恒走回落链**。

## 5. 子任务分解

| 编号   | 修改/新增文件                                                                                                                                                                                                                                                                                             | 输入 → 输出                                                                             | 验收标准                                                                                                                                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** | `src/main/app/media-protocol.ts`（规则 4 下沉进 `isMediaPathAllowed`，协议 handler 改为只调该函数）；`src/main/app/__tests__/media-protocol.test.ts`（新增 6 例）；`resource-allowlist.ts` / `media-read-guard.ts` 注释同步                                                                               | 登记过的 NikkiSync 绝对路径 → 展示与读取**同一判定结果**                                | ① 登记+媒体扩展名 ⇒ true；② `.txt`/`.exe` ⇒ false；③ 未登记 ⇒ false；④ 本 App DB 为 null 时规则仍生效；⑤ 表清空后一律拒绝；⑥ Windows 大小写折叠命中；⑦ `media-protocol.test.ts` 全量零回归；⑧ `npm run test:main` 绿 |
| **A1** | `stores/uiStore.ts`（`ViewLevel` 加 `'sync-gallery'`，**不**入 `MULTI_SELECT_VIEWS`）、`App.tsx`（`ALL_VIEWS` + `VIEW_LEVEL_MAP` + switch）、`components/layout/Sidebar.tsx`（`navItems` 在 `resonance-records` 后插入）、`components/layout/AppShell.tsx`（状态栏文案）、`icons/index.tsx`（`IconSync`） | 点击侧栏第 10 项 → `currentView==='sync-gallery'`                                       | `npm run typecheck` 0 错；`Sidebar.test.tsx` 断言 10 项且第 4 项仍是共鸣录；切回 gallery 不清空选中集                                                                                                                |
| **A2** | `stores/mediaStore.ts` 抽 `fetchAssetPage()`；新增 `stores/syncGalleryStore.ts` + `.test.ts`                                                                                                                                                                                                              | 游标 + limit → 视图模型页                                                               | 单页 4 次往返；`cursor=null` 不传该键；空页返回 `{files:[],hasMore:false}`；既有 `mediaStore.nikkisync.test.ts` **断言一字不改**仍绿                                                                                 |
| **A3** | 新增 `pages/sync-gallery/{SyncGalleryPage,SyncGalleryToolbar,SyncAssetDrawer,SyncEmptyState}.tsx` + 各自 `*.test.tsx`                                                                                                                                                                                     | `syncGalleryStore` → 网格 / 抽屉 / 空态                                                 | 4 例：10 条渲染、触底单次 loadMore（并发保护）、空态含可执行指令 `npm run link:nikkisync`、点卡片带显式 `files` 开全屏；**禁止静默空网格**                                                                           |
| **A4** | 12 个 `renderer/i18n/locales/*.json` + 新增 `locales/sync-gallery-keys.test.ts`                                                                                                                                                                                                                           | `nav.syncGallery` / `appShell.viewStatus.syncGallery` / `syncGallery.*` / `shareCard.*` | `npm run i18n:guard` 与 `i18n:check` 退出码 0；**禁止**用 `sync-i18n-keys` 以空串糊对齐、禁止新增文件进 i18n 白名单                                                                                                  |
| **C2** | 新增 `renderer/utils/game-params-from-metadata.ts` + `.test.ts`（纯、零 electron/react/i18next）                                                                                                                                                                                                          | `InfinityPhotoMetadata` → `GameParamsData`                                              | 6 例绿（全量富 metadata / 仅 camera / clothes 原始数组 / undefined / raw 不含 dictionary / NaN）；缺项**如实缺**不伪造                                                                                               |
| **C3** | 新增 `renderer/hooks/useAssetParams.ts` + `.test.ts`；五个面板各 2 行换 hook                                                                                                                                                                                                                              | `MediaFile` → 参数对象（metadata 优先，解密链回落）                                     | 4 例绿，含「无 `nikkisync` 字段时与今天逐字一致」；`DetailPage.*.test.tsx` 三件零回归；缓存键**必须含 `assetId`**                                                                                                    |
| **B1** | 新增 `renderer/utils/share-card/shareCardModel.ts` + `.test.ts`                                                                                                                                                                                                                                           | 参数对象 → payload + 布局盒模型                                                         | 8 例绿；几何常量逐字照 `share-card.js:2,5,20-39`；呈现规则照 `:40-51`；**零中文字面量**（文案由调用方注入 `copy`）；超长抛 `InternalError`                                                                           |
| **B2** | 新增 `renderer/utils/share-card/shareCardRender.ts` + `.test.ts`                                                                                                                                                                                                                                          | ctx + payload → 绘制 op                                                                 | 坐标/字号/圆角/透明度逐字照 `:52-99`；canvas 内部色值加中文豁免注释，不外溢到组件样式                                                                                                                                |
| **B3** | 新增 `__tests__/fixtures/share-card.reference.js`（`share-card.js` 逐字副本）+ `__tests__/shareCardParity.test.ts`（`node:vm` 加载）                                                                                                                                                                      | 同一录制型假 ctx 跑参考实现 vs 本实现                                                   | **op 序列与坐标逐项相等**；无法等价项登记进 `docs/技术债清单.md`，不悄悄放宽断言                                                                                                                                     |
| **B4** | 新增 `components/sync/ShareCardDialog.tsx` + `.test.tsx`                                                                                                                                                                                                                                                  | 资产 → 多页 PNG 预览 + 落盘                                                             | 5 例绿（两页渲染 / `CANCELED` 不弹错误 toast / 参数缺失仍出图且数值 `—` / 取消不写盘 / `missingIcons>0` 提示条）；`motion_photo` 拒绝出图并给文案                                                                    |
| **B5** | `SyncAssetDrawer.tsx` 与 `DetailPage.tsx` 各加分享入口；新增 `utils/share-card/README.md`                                                                                                                                                                                                                 | —                                                                                       | 两源均可分享；README 记录移植映射表与非等价项                                                                                                                                                                        |

## 6. 错误处理

- 主进程侧一律 `AppError` 家族，由 `wrapHandler` 转 `IpcError`；`getAssetDetail` 的 `NOT_FOUND` / `PRECONDITION_FAILED` 在 `useAssetParams` 内静默回落解密链。
- 渲染层业务错误**禁止** `throw new Error`：分享图超长用 `InternalError`，参数越界用 `ValidationError`（渲染层硬 lint 拦 `ThrowStatement > NewExpression[callee.name='Error']`）。
- toast 文案一律经 `useErrorToast` / `extractUserMessage`。
- `syncGalleryStore` 不得被 `mediaStore` import（避免复活历史循环依赖）；新页任何 IPC 失败都不得影响 GalleryPage。

## 7. 参数校验

- 本阶段**不新增 IPC 通道** ⇒ 无新增 zod schema；复用既有 17 条 `nikkisync:*` 的 `z.tuple` 约束（`listSchema.limit 1..500`、`resourceRecordsSchema.assetIds 1..500`、`changesSchema.after ≥ 0`）。
- 渲染层自校验：`fetchAssetPage` 的 `limit` 必须落在 `1..500`（越界即 `ValidationError`，不把非法值发给主进程）；分享图 `rotation` 只接受 `{0,90,180,270}`，其余归一为 0；`clothes` 截断上限 100、`outfit` 每页 6 条的语义与原生一致。

## 8. 风险

1. **i18n 守卫**：12 包键必须同批补齐，漏一种语言即 CI 红。
2. **`ViewLevel` 三处隐性穷尽点**：`VIEW_LEVEL_MAP`（tsc 硬红，好事）、`ALL_VIEWS` + switch 的 `default: <GalleryPage/>`（**静默渲染图库**）、`AppShell` 的 `default: ''`（静默空白状态栏）。后两处只能靠测试与手工验收兜。
3. **覆盖率阈值闸门**：`all:true` + `include: src/**/*.{ts,tsx}`，新模块必须自带测试，不许扩大 exclude。
4. **核心路径双层闸门**：默认零受保护文件改动。若中途必须加通道，须整条替换 `nikkisync-handler.ts` 顶部 `// @core-change:` 原因（旧原因不复用）并同步 preload / `preload.test.ts` / `IPC_CONTRACT.md` / `vite-env.d.ts`。
5. **junction 被剪**：`npm install` 后 `runtime-status` 变 `unavailable`，看着像新页 bug。
6. **canvas 被 `media://` 污染**：`toDataURL` 抛 SecurityError ⇒ 沿用 `utils/imageProcessor.ts` 的 `crossOrigin='anonymous'` 既有链路并实测；退路是走已有通道取字节转 blob URL，**不为此新增 IPC**。
7. **详情页缓存串味**：`useGameParams` 现键是 `${filePath}::${uid}`，两源同游戏目录时路径可能相同（参数相同属期望命中），但 `useAssetParams` 新增的 detail 缓存键必须含 `assetId`。

## 9. 明确不做的事

不动 `runtime-facade/runtime-loader/embedding-paths/sync-server-view/runtime-manager`；不新增 `nikkisync:*`/`sync:*` 通道、不改 `IPC_CONTRACT.md`；不改 `mediaStore` 的分流语义、`GalleryPage` 数据源开关与 `library-changed` 订阅、`settings/sync-sections.tsx`；不重复实现配对二维码/服务启停/扫描编排/`asset_edits`；不接远端 resolver / 字典提供器 / 图标下载缓存；不新增第二个 SQLite 连接、不动 `nikkisync.db` 表结构；不碰 `media_files` 及任何原有表；不碰 NikkiSync 任何源文件；不动 `stash@{0}: phase7-wip-parked`；不 commit / 不 push。

## 10. 验证

```bash
npm run verify
npm run typecheck
npm run lint
npm run test:renderer
npm run test:main
npm run i18n:guard && npm run i18n:check
npm run test:coverage
npm test                              # 全量，基线 = 380 文件 / 5983 通过 / 2 跳过
npx vitest run src/renderer/utils/share-card
npx vitest run src/main/app/__tests__/media-protocol.test.ts
npm run preview:check                 # 导航项漂移应仍为 WARN（非阻断）
```

`npm run dev` 手工验收：① 侧栏第 10 项出现，切 `en`/`ja`/`zh-TW` 不渲染原始 key，状态栏文案非空；② 进新页网格出图，**切回「图库」确认仍是本地源数据**（D-A 核心不变式）；③ 新页大图可放大翻页、抽屉五面板有值且含本地解析出的服装名；④ C1 专项：同一资产不再 `PATH_FORBIDDEN`，未登记路径仍被拒；⑤ 分享图预览分页、无 `tainted` 报错、保存落 PNG、「打开所在位置」成功；⑥ 与手机端并排目测面板位置/滑轨/参数顺序/`—`/页脚 `i/N`；⑦ `motion_photo` 出图被拒并给文案；⑧ 收口 `git status --porcelain` 复核钩子未意外改写。

---

## 11. 执行记录

### 11.1 C1 路径授权口径下沉（2026-10-15 完成）

红灯先行：`src/main/app/__tests__/media-protocol.test.ts` 新增 `阶段 5 · C1` 用例组 6 例，改动前实跑结果 —— `41 tests | 4 failed`，失败全部为 `AssertionError: expected false to be true`（32 / 35 / 36 / 37），两条负例（33 `.txt`+`.exe`、34 未登记）改动前即为绿，说明它们锁的是「不放宽」边界而非新行为。

改动：`isMediaPathAllowed()` 顶部新增规则 4（判在取 DB **之前**，`mediaPathCache` **不写入**——授权表随 `libraryRevision` 整表替换、随 `runtime.stop()` 清空，而缓存有 5 分钟 TTL，写入会让「先判否、后登记」的分页路径在窗口内持续被拒）；协议 handler 内的重复判定删除，改为只调 `isMediaPathAllowed`。`media-protocol.ts` 与 `resource-allowlist.ts` 的头部注释同步（原「三条既有规则」表述已过期）。

绿灯：`npx vitest run src/main/app/__tests__/media-protocol.test.ts` ⇒ **41 passed (41)**；`npx vitest run src/main` ⇒ **Test Files 202 passed / Tests 3740 passed | 2 skipped / EXIT=0**（含 `media-read-guard`、`decrypt-handler` 等既有回归用例零改动通过）。`npm run verify` 五项全 ✓。

### 11.2 A1–A4 一级入口、独立 store、页面与 12 语言（2026-10-15 完成）

红灯先行：`Sidebar.test.tsx` 由 9 项改 10 项并新增第 5 项断言 ⇒ 实跑 `3 failed`；`syncGalleryStore.test.ts` 首跑 `Cannot find module './syncGalleryStore'`。

落地清单：

| 文件                                          | 改动                                                                                                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/renderer/stores/uiStore.ts`              | `ViewLevel` 加 `'sync-gallery'`；**未**加入 `MULTI_SELECT_VIEWS`（两页各自持有选中集，注释写明理由）                                                                                                                                             |
| `src/renderer/App.tsx`                        | `ALL_VIEWS`、`VIEW_LEVEL_MAP`（`'sync-gallery': 1`）、switch 新增 case（注释点明「有 default 兜底，漏 case 不会编译失败」）                                                                                                                      |
| `src/renderer/components/layout/Sidebar.tsx`  | `navItems` 在 `resonance-records` **之后**插入，保持 index 3 = 共鸣录                                                                                                                                                                            |
| `src/renderer/components/layout/AppShell.tsx` | `getViewStatusLabel` 加 case                                                                                                                                                                                                                     |
| `src/renderer/icons/index.tsx`                | 新增 `IconSync`（repeat 双向回环，与 `IconRotateCw` 区分）                                                                                                                                                                                       |
| `src/renderer/stores/mediaStore.ts`           | 抽出导出纯函数 `fetchAssetPage()`（含 `ASSET_PAGE_LIMIT_MAX=500` 前置校验），`fetchMediaFromRuntime` / `loadNextAssetPage` 改为调用它；分流点语义一字未动                                                                                        |
| `src/renderer/stores/syncGalleryStore.ts`     | 新增，独立列表状态 + `loadFirst/loadMore/reset`；`error` 存 i18n key 而非译文；注释写明「不被 mediaStore 反向 import」的单向依赖约束                                                                                                             |
| `src/renderer/pages/sync-gallery/`            | 新增 `SyncGalleryPage.tsx` / `SyncGalleryToolbar.tsx`（含纯函数 `toRuntimeGroup`，8 态→3 档）/ `SyncAssetDrawer.tsx` + 三件同名套件                                                                                                              |
| `src/renderer/i18n/locales/*.json` × 12       | 同批 +46 行/包：`nav.syncGallery`、`appShell.viewStatus.syncGallery`、顶层 `syncGallery` 块（含 `drawer.*`）；新增 `sync-gallery-keys.test.ts` 作哨兵（键存在 + 非空 + `nav===viewStatus` + `syncGallery` 子树 12 包同构 + `linkHint` 必含命令） |

绿灯：`npx typecheck` 0 错；`npx vitest run src/renderer/pages/sync-gallery src/renderer/i18n/locales src/renderer/utils/assetViewModel.test.ts src/renderer/stores src/renderer/components/layout` ⇒ **18 files / 213 tests passed**；`npm run i18n:guard` ✅。

偏差记录（与原计划的差异，均已核对现场）：

1. 空态未单独建 `SyncEmptyState.tsx`，改为复用既有 `components/common/EmptyState`（它已内建 `empty/loading/error` 三态 + CTA），避免造一个与 4 处既有空态重复的组件。可执行指令通过 `subtitle` 传入。
2. 详情抽屉 `SyncAssetDrawer` 直接复用图库那五个参数面板（它们已支持 `gameParams` 注入缝），**未**改任何面板内部逻辑。

### 11.3 C2/C3 元数据优先层：**按取证结果不做**（待确认）

计划里的 `game-params-from-metadata.ts` + `useAssetParams.ts` 是为「NikkiSync 已解析出 metadata」这一前提准备的。步骤 0 的实测（§0.1）否证了该前提：本机 31 个资产 `metadata_json` 的 `camera` 与 `capture` **全是空对象**，`dressing` 全表 0 命中——因为 `createRuntimeSession` 从不传 `metadataResolver`/字典。

因此：

- 写了这两个模块会得到一段**恒不生效**的分支（`hasMetadata` 恒 false ⇒ 永远回落 `useGameParams`），并且要为此改动 5 个共享面板；
- 验收第 5 条「穿搭参数、拍摄参数完整展示」由**既有解密链**满足：`SyncAssetDrawer` 里那五个面板内部就在调 `useGameParams` → `decrypt:decodeFile`，而 C1 已经把 nikkisync 资产路径的授权口径补齐，这正是该链此前读不到数据的唯一障碍。

决定：本阶段不实现 C2/C3，改为在 `SyncAssetDrawer` 复用既有面板。**若将来内嵌 Runtime 打开 resolver/字典，再按 D-C 补 metadata 优先层。**

### 11.4 B1–B5 分享图移植（2026-10-15 完成）

红灯先行：`shareCardJob.test.ts` 首跑暴露假 ctx 缺绘制方法（`missingIcons` 计 0）；`ShareCardDialog.test.tsx` 首跑因抽屉标题与按钮同文案导致 `Found multiple elements`，改 `getByRole` 后绿。

落地清单：

| 文件                                                                        | 内容                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/renderer/utils/share-card/shareCardModel.ts`                           | `clean` / `resolveOutfitName` / `parameterPresentation` / `wrapText` / `buildShareCardPayload` / `layoutShareCards`，常量与公式逐字照上游 `share-card.js:2,5,15-51`；中文 label 匹配换成规范键匹配（模块内零中文字面量） |
| `src/renderer/utils/share-card/shareCardRender.ts`                          | `renderShareCardPage` + `roundedRectPath`，坐标/字号/圆角/透明度逐字照 `:52-99`；图上中文全部由 `copy` 注入                                                                                                              |
| `src/renderer/utils/share-card/shareCardInput.ts`                           | `GameParamsData → 载荷`；12 项规范键 + 2 项追加（镜头旋转/景深），效果区取 pose/光源/滤镜/地点；穿搭名走本地 `getClothName`，上限 100                                                                                    |
| `src/renderer/utils/share-card/shareCardJob.ts`                             | canvas 与导出**全部注入**的出图编排；取消在每个检查点生效并返回空数组；`missingIcons` 口径对齐上游（按穿搭条目计，与有无 iconPath 无关）                                                                                 |
| `src/renderer/utils/share-card/__tests__/fixtures/share-card.reference.txt` | 上游 `share-card.js` **逐字节副本**（17664 字节，sha256 `6dea2d2a…435d3b`，被钉成一条断言）；用 `.txt` 后缀避开 prettier/eslint 的 `src/**/*.js` 作用域                                                                  |
| `src/renderer/utils/share-card/__tests__/shareCardParity.test.ts`           | 对拍：同一录制型假 ctx 先喂参考实现（中文 label 行）再喂本仓实现（规范键 + zh 注入文案），断言 op 序列与坐标逐项相等。覆盖单页、旋转 90°、空态降级、多页分页 4 组                                                        |
| `src/renderer/components/sync/ShareCardDialog.tsx`                          | 出图面板（容器复用 `Drawer`，不新造模态）；图上文案以 `{lng:'zh-CN'}` 钉死；`toDataURL` → `editor.saveAs`；目录框取消不当作错误；`motion_photo` 拒绝出图                                                                 |
| `src/renderer/pages/sync-gallery/SyncAssetDrawer.tsx`                       | `footer` 加「生成分享图」入口                                                                                                                                                                                            |
| `src/renderer/pages/DetailPage.tsx`                                         | 游戏信息面板区块末尾加入口 + 挂面板（本地图库同样能分享）                                                                                                                                                                |

上游 `render` 与 `rounded` 是模块内私有函数（`module.exports` 只给 4 个符号），故对拍在**加载时**向 vm 追加一行导出，夹具本体保持逐字不动。

等价判据实测结果：4 组对拍**逐项相等**，`npm run test:coverage` 与全量门禁见 §11.5。

已登记的非等价项（不放宽断言，见 §0.2）：字体像素差异；本仓参数覆盖度是原生 `playerMetadata` 的**超集**（多出 镜头旋转/景深/高光/阴影/柔光范围 等）；穿搭名解析率是**超集**（本地 7369 条 vs 原生「名称待解析」）；单品图标恒缺（走 `图标暂缺` 分支）。

### 11.5 门禁与遗留

- `npm run typecheck` ⇒ `EXIT=0`；`npm run lint` ⇒ **0 errors**（11 条 warning 全是存量 DEBT-030 的 `unicode-bom`）；`npm run verify` ⇒ 5 项全 ✓；`npm run i18n:guard` ✅。
- 新增套件：share-card 4 件 + sync 面板 + 页面/工具栏/抽屉 + store + 语言包哨兵 = **71 例**；`npm test` ⇒ **390 files / 6065 passed | 2 skipped**。
- **两处与本次改动无关的时间敏感抖动**：`src/main/utils/zip-archive.test.ts`（其 `afterEach` 在 Windows 上对被 abort 的归档目录 `rmSync` 报 `ENOTEMPTY`）与 `src/main/media-worker/worker-entry.test.ts`（500ms 进度节流用例），全量并发时各红过一次，**单跑均 100% 通过**（前者 11/11，后者 42/42），且两文件都不在本次改动清单内。需要说明的是：本次新增的 jsdom 组件套件把全量耗时从 ~47s 抬到 ~91s，会**提高这类时间敏感用例的偶发概率**；未通过放宽或改写它们来「让门禁变绿」。
- 一次操作事故与修复：批量插入 locale 键的临时脚本用 `'  "syncGallery": '` 定位顶层键，该串同时命中 6 空格缩进的 `nav.syncGallery`，导致 `zh-CN.json` 被从 nav 中段截断（1931 字节）。因该文件的非 HEAD 内容全部由脚本生成，用 `git checkout -- <单个路径>` 恢复后重放，并给脚本加了**行首锚定 + 落盘前内存解析校验**两道保险；终检显示 12 个语言包各 +46/+39 行、键集同构、`git diff --stat` 无删除行。
- 未 commit、未 push；`stash@{0}: phase7-wip-parked` 未动。

### 11.6 覆盖率闸门、构建与尚未完成的验收

- `npm run test:coverage` ⇒ **EXIT=0**，`Test Files 390 passed / Tests 6066 passed | 2 skipped`。
  全仓 `All files 67.34 / 58.99 / 59.92 / 68.94`，高于 `vitest.config.ts` 阈值 `66 / 58 / 59 / 68`。
  新模块：`utils/share-card` **94.91 / 85.09 / 100 / 97**，`pages/sync-gallery` **75.24 / 81.92 / 61.9 / 76.92**。
- `npm run build` ⇒ **EXIT=0**，新页面与分享图面板各自成为独立懒加载 chunk
  （`SyncGalleryPage-*.js` 13.65 kB、`ShareCardDialog-*.js` 26.29 kB），证明 `App.tsx` 的 lazy 接线在打包期可解析。
- **三条时间敏感用例在全量并发下各红过一次，单跑均 100% 通过**，且都不在本次改动清单内：
  `src/main/utils/zip-archive.test.ts`（`afterEach` 的 `rmSync` 在 Windows 上撞 `ENOTEMPTY`）、
  `src/main/media-worker/worker-entry.test.ts`（500ms 进度节流，42/42 独立通过）、
  `src/renderer/utils/imageProcessor.canvas.test.ts`（10s 超时，7/7 独立通过）。
  全量耗时因本次新增 4 个 jsdom 套件从 ~47s 升到 ~91s，会抬高三者偶发概率。
  处置：不改写、不放宽、不关掉它们，留待独立的稳定性工单。
- **尚未完成**：§10 的 `npm run dev` 8 条人工验收（侧栏第 10 项、跨源不变式、抽屉五面板实际出值、
  C1 专项的 `PATH_FORBIDDEN` 消失、真机出图与手机端并排目测、保存落盘、实况拒绝、i18n 三语切换）。
  自动化只证到「布局/绘制 op 序列与上游逐项相等」，**没有**证明过真机像素观感与运行时交互，
  因此验收第 3–9 条目前状态是「代码就绪、待人工确认」。
