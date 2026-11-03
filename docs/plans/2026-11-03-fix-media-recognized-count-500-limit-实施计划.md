# 修复「图片/视频识别数量被限制为最多 500 个」

## 0. 第 0 步（批准后第一件事）

把本计划按仓库既有协议落仓为 `docs/plans/fix-media-recognized-count-500-limit.md`（`docs/plans/` 是本轮及历轮计划的存放位，如 `3aacc66`、`075c686`、`698236a` 各笔 docs(plans) 提交），并独立提交 `docs(plans): 落盘图库识别数量 500 上限回归的实施计划`。上一轮的同类计划 `docs/plans/fix-gallery-non-grid-500-display.md` 已于 `d654b9b` 之后被移入 `docs/archive/` 且不入仓，所以其 §4.1 测试编号已无法从仓库核对——本次落仓正是为了下一次不再靠记忆。

## 1. Context（为什么做这件事）

**用户可见症状**（已与用户确认）：图库底部状态栏「共 {{total}} 个文件（图片 {{images}} · 视频 {{videos}}）」与侧栏「图片 / 视频」计数恒停在 500，即使库里已识别入库上千条。用户选择了「两者都做」：计数改为服务端真值 **+** 网格视图也自动拉齐全库。

**这不是新 bug，是同一处病灶的第二次发作。** 提交 `d654b9b`（2026-09-08，计划文档 `fix-gallery-non-grid-500-display`，现已归档不入仓）修的是「list/timeline/masonry/event-timeline 四个视图没有触底入口，所以卡在首屏 500」，手法是在 `useFilteredMediaFiles.ts` 加 `shouldPullAll = isFilteringActive || viewMode !== 'grid'`。它**刻意把 grid 排除在外**，并在 `useFilteredMediaFiles.count.test.ts:131` 用一条用例把「grid 视图 600 条保持首屏 500」钉成了契约。于是默认视图下的 500 从未被解过——而计数取的是「已加载数组长度」，所以数字永远等于页大小。

### 三条独立根因（全部实测核对到行号）

| #   | 根因                                                                                                                                                                                                                                                     | 证据位置                                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1 | 计数是「已加载分页长度」，不是库中真值。`media:list` 早已回传服务端 `total`，`fetchMediaFromDatabase` 也早已透出来（`mediaStore.ts:565`），但**没有任何调用方消费**；同一文件的回收站却有 `recycleBinTotal: result.total ?? files.length` 的正确先例可抄 | `AppShell.tsx:64-77`（stats 遍历 `mediaFiles`）、`AppShell.tsx:85`（`total: mediaFiles.length`）、`Sidebar.tsx:136-162` 与 `:364-394`、`GalleryPage.tsx:783`、`mediaStore.ts:291`（`MEDIA_PAGE_SIZE = 500`）、`mediaStore.ts:709`（回收站先例）                                 |
| R-2 | 深度刷新把「已加载条数」当 `pageSize` 直传，越过主进程 zod 上界 ⇒ 整次刷新静默失效 ⇒ 新扫描到的文件永远进不了列表                                                                                                                                        | `GalleryPage.tsx:226-236`（`media:updated`）与 `:280-287`（`library-changed`）传 `limit: Math.max(MEDIA_PAGE_SIZE, mediaFiles.length)`；`mediaStore.ts:525` 原样写进 `pageSize`；`media-handler.ts:184` `pageSize: z….max(500)`；`mediaStore.ts:568-575` catch 后 `return null` |
| R-3 | grid 视图不自动拉齐（`shouldPullAll` 排除了它），且既有测试把这条钉成了契约                                                                                                                                                                              | `useFilteredMediaFiles.ts:109-121`、`useFilteredMediaFiles.count.test.ts:131-143`                                                                                                                                                                                               |

**R-2 的定性证据**：nikkisync 数据源分支后来单独补了 clamp（`mediaStore.ts:411-417`，注释原文「深度取数可能传入超过上游 zod 上界（500）的值……不 clamp 会让 `media:updated` 的整表刷新静默失效」），本地 DB 分支没有同款防护。`39bd786`（2026-10-14）引入 `Math.max(MEDIA_PAGE_SIZE, …)` 时只保护了一侧——这就是「修过又复现」的来路。

### 已排除（不是元凶，别去动）

- `scanner/worker-entry.ts:110` `SCAN_BATCH_SIZE = 500` —— 流式写入分批，满 500 即 flush 并继续到扫描结束，不是上限。
- `database/sql-chunk.ts:11` `SQL_IN_CHUNK_SIZE = 500` —— `IN (...)` 分片。
- 各处 `>= 500` —— 全是 500ms 进度节流（`scanner/worker-entry.ts:225`、`media-worker/worker-entry.ts:632/781/916` 等）。
- `media-worker/worker-entry.ts:520/:531` 的批量任务查询是全表 SELECT 无 LIMIT；`startup-tasks.ts:356-361` 只做 COUNT 分母。扫描/缩略图/pHash/重复/相似识别本身**没有被截断**。
- 同步服务页预检计数（`SyncServicePage.tsx:1274-1303`）走上游 `extraDirectories.inspect()` 全量枚举，不经分页。
- `sync-read-repository.ts:48` / `sync/server/api-router.ts:53` / `nikkisync-handler.ts:74` 的 `MAX_PAGE_LIMIT = 500` 是 NikkiSync 协议上界（上游真相源），本次不动。

**目标产出**：状态栏/侧栏/统计条显示库中真实识别数量；网格视图与其他视图一样把全库拉齐；`media:updated` 深度刷新真正生效不再静默失效；并留下静态守卫防止第三次复发。

---

## 2. 依赖声明

**零新增依赖。** 全程复用仓库既有能力：

| 复用项                                                | 位置                                                               | 用途                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------- |
| `countMedia(whereClause, whereParams)` 同 WHERE 口径  | `src/main/database/media-repository.ts:1199-1206`                  | Node 1 新计数方法严格照此签名与传参形态 |
| `buildListWhereClause()`                              | `media-repository.ts:561`                                          | 保证分类型计数与列表命中同一 WHERE      |
| `resolveListTotal()` 只在首页算一次的时机             | `media-repository.ts:1134-1137`                                    | Node 1 的插入点，不新增查询轮次         |
| `loadMoreMedia(cursor)`（只取数、不写 store）         | `mediaStore.ts:593-641`                                            | Node 4 的续页取数，不新写 IPC           |
| `dedupeAgainst()`                                     | `mediaStore.ts:644-647`                                            | Node 4 跨页去重                         |
| `recycleBinTotal` 的「服务端真值 + 数组长度兜底」模式 | `mediaStore.ts:709`、`:131` 注释                                   | Node 2 的 store 字段设计                |
| `MockDatabase` 内存 SQL 引擎                          | `src/main/database/media-repository.test.ts`                       | Node 1 红灯测试载体                     |
| `scripts/__tests__/*-guard.test.ts` 守卫惯例          | `path-semantics-guard.test.ts`、`typecheck-emit-isolation.test.ts` | Node 5                                  |

**依赖版本变更**：无。`package.json`、`package-lock.json` 不动。

**受保护路径**（`.qoder/rules/project-conventions.md` §「关键路径保护」）：本计划触碰 `src/main/ipc/handlers/media-handler.ts`。该文件首行已有 `// @core-change:`（两行续写，内容是 sync-integration 阶段4/5）。按约定「下次改动需替换为新原因，旧原因不复用」——Node 1 执行时把它整块替换为本次真实原因（`media:list 响应新增 typeCounts 分类型真计数，解除图库 500 计数上限`），全文件保持**至多一条**且位于前 5 行内。`src/main/database/`、`src/renderer/`、`src/shared/types/` 不在四个受保护 glob 内，无需授权注释。

---

## 3. 启动说明

### 环境准备

无需额外准备（不装新依赖、不迁 schema、不改构建配置）。开发依赖已在仓：Vitest 5 + jsdom + Testing Library + 真实 zod。

### 各节点验证命令

```bash
# 单套件（每节点红灯/绿灯都用它，最快）
npx vitest run src/main/database/media-repository.test.ts
npx vitest run src/renderer/components/layout/Sidebar.test.tsx
npx vitest run src/renderer/hooks/useFilteredMediaFiles.count.test.ts
npx vitest run src/renderer/stores/mediaStore.test.ts
npx vitest run scripts/__tests__/media-page-limit-guard.test.ts

# 分片速查
npm run test:main      # 主进程 + 数据库
npm run test:renderer  # 渲染层（jsdom）
```

### 全量回归（所有节点完成后，一票否决）

```bash
npm run verify          # 只读：tsc -b + eslint 无 --fix + core-gate + prettier --check + 相关单测
npm test                # 全量 vitest（本地单进程）
npm run test:ci-linux   # 按 CI(ubuntu) 宿主语义复跑；本次不新增路径比较，应无变化
npm run typecheck       # tsc -b（src）+ tsc -p tsconfig.scripts.json（scripts/，含 Node 5 新守卫）
npm run typecheck:e2e   # tsc --noEmit -p e2e
npm run lint            # eslint . 全量（CI lint-typecheck job 同口径）
npm run i18n:guard      # 本计划不新增 i18n key（复用现有 gallerySummary 的三个插值），应零变化
npm run test:coverage   # 覆盖率阈值门控
```

### 手工端到端验证

```bash
npm run dev
```

判据（必须逐条肉眼确认）：

1. 库内图片 + 视频 > 500：底部状态栏「共 N 个文件（图片 X · 视频 Y）」的 N **等于侧栏档案统计里的入库总数**，不再是 500；X + Y = N。
2. 首屏渲染后不滚动，等待自动拉齐完成：网格条目数 = 库内总数（`mediaFiles.length` 与真值收敛）。
3. 在图库里点一次收藏 → 触发 `media:updated` → 列表**不塌回 500**、滚动位置不闪回开头，且 DevTools Console 无 `[mediaStore] 加载失败` / `VALIDATION_ERROR` 日志（这是 R-2 修好的可观测标志）。
4. 切到「仅看收藏」「场景筛选」「搜索框输入」任一客户端筛选 → 计数随之变小且与实际渲染条目一致（证明没把服务端计数错接到筛选态）。
5. 切到「缓存」「截图」「回收站」三个视图 → 各自计数与列表实际条目一致（视图切换会重新查询，服务端 WHERE 变了）。

> 注：`npm run dev` 起真实 Electron，本次无法在 CI 里代跑；若本机跑不通（GPU/原生模块），我会如实标注 which check not-run，不拿单测冒充实机验证。

---

## 4. 错误处理

### Node 1（主进程计数）

- `countMediaByType` 不吞异常：SQLite 报错由 `wrapHandler` 统一转 `INTERNAL_ERROR`（约定 §2 禁止 handler 内手写 `try/catch + return {success:false}`）。仓储层是同步读，符合 `src/main/database/AGENTS.md` §1.1。
- 归一策略：`GROUP BY file_type` 返回的行集可能含历史值（如 `'live_photo'`、空串）。方法只回填 `image`/`video` 两个键，其余类型计入 `total`（由 `resolveListTotal` 独立给出）但不进 `typeCounts`。**因此 `image + video` 可能 < `total`** —— 这是口径事实，不是 bug；渲染层展示 X/Y 用 `typeCounts`，展示 N 用 `total`，两者不互相推导。测试必须覆盖这一条。
- 兜底：`typeCounts` 是**可选字段**。旧渲染层忽略；新渲染层拿不到时回退数组长度（Node 2 的 `?? files.length`，照抄 `recycleBinTotal` 的兜底写法）。
- 性能：只在首页算一次（与 `result.total` 同一分支），续页不重复 GROUP BY。`isDefaultView` 命中 `media_count` 缓存只覆盖 `total`，`typeCounts` 始终实时算——因为缓存里没有类型分布，宁可多一次 GROUP BY 也不引入第二个缓存真相源。

### Node 2（store 落值 + UI 消费）

- 服务端未给出（`undefined`/null，含 nikkisync 数据源分支）⇒ store 写 `null` ⇒ 消费 hook 自动回退数组长度，**不显示 NaN、不显示 0**。
- nikkisync 数据源没有等价的分类型计数能力（上游协议只给 `items` + `nextCursor`），本次不伪造。该源下 `hasMoreMedia` 语义仍由游标驱动，计数走数组长度分支 ⇒ 行为与今天一致，不新增失败面。这一点写进 hook 的 JSDoc。

### Node 3（grid 拉齐）

- `loadNextMediaPage` 已有 `loadingMore` 并发保护与「取数失败保持游标与 `hasMoreMedia` 不变，下轮重试」（`mediaStore.ts:655-674`）。本节点只是让更多视图走进这条既有安全路径，不新增错误分支。
- 失败不会死循环：`loadMoreMedia` 返 `null` 时 `loadNextMediaPage` 直接 `return`，`hasMoreMedia` 保持 true，但 `mediaCount` 不再变化 ⇒ effect 依赖不再触发。**必须在测试里钉住这条「取数失败不无限重试」**（新增用例，见 §5）。

### Node 4（深度刷新循环）

- **越界不再可能**：每次 IPC 的 `pageSize` 表达式恒为 `Math.min(剩余额度, MEDIA_PAGE_SIZE)`，Node 5 守卫把它钉成静态断言。
- **单飞 + 最新胜出**：模块级 `let depthSeq = 0`；进入即 `const my = ++depthSeq`；每个 `await` 之后检查 `if (my !== depthSeq) return null`（不写 store、直接放弃）。`media-update.ts` 的 100ms trailing throttle 已经把突发合并过一层，这里是第二层，防的是「一次全深度刷新还没跑完，下一次事件又起一轮」。
- **中途某页失败**：`break` 并保留已取到的 `collected`，写回 `hasMoreMedia = true` + 当前游标 ⇒ 列表可用、下轮自动续取；不整刷丢弃、不把 `hasMore` 谎报为 false（谎报会让 UI 以为全量已到齐，真值计数也就失去兜底）。
- **循环必须有硬上限**：`while` 加 `pages < MAX_DEPTH_PAGES`（取 200 ⇒ 200×500 = 10 万条封顶）防御游标不推进导致的死循环（`nextCursor` 为 null 但 `hasMore` 为 true 的历史畸形响应）。触发上限时记一条 `console.error` 供取证。
- 日志：沿用 `i18n.t('mediaStore.log.fetchError')` 既有键，不新增 i18n key。

### Node 5（守卫）

守卫自身读文件失败 ⇒ 直接判失败（不静默跳过），与其它 `*-guard.test.ts` 一致。

---

## 5. 参数校验

### 主进程入参（zod）

`media:list` 的 `pageSize` schema（`media-handler.ts:184`）**保持 `max(500)` 不变**。理由：这条上界是防「渲染层一个字符串/数字就把主进程同步 SQLite 打成几十 MB 结构化克隆」的真实闸门，属于对外契约；要修的是渲染层越界传参，不是拆闸门。**因此 R-2 的修法是让渲染层永不越界，而不是抬高上界。** 这也是 Node 5 守卫的判据方向。

不新增必填项、不改通道名、不改 `IpcResponse`/`IpcError` 结构。响应侧只**新增可选字段** `typeCounts`，符合约定 §「通道/契约变更的同步义务」的向后兼容要求（新增字段可选、旧字段语义不变），无需另起通道 + 双写。

### 新增 IPC 响应字段（三处类型同步）

```ts
typeCounts?: { image: number; video: number }
```

| 落点                     | 文件:行                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| 仓储返回类型             | `src/main/database/media-repository.ts:357`（`interface MediaListResult`） |
| 渲染层实际看到的声明面   | `src/renderer/vite-env.d.ts:661-671`（`media.list` 的返回块）              |
| preload `call<T>` 的类型 | `src/shared/types/electron-api.ts:314`（`interface MediaListResult`）      |
| 契约文档                 | `docs/IPC_CONTRACT.md` §2 内新增 `media:list` 小节                         |

> 已知漂移风险（本次只登记不清偿）：`shared/types/electron-api.ts:314` 的 `MediaListResult` 声明的是 `items`，而 handler 实际返回 `files`，渲染层靠 `vite-env.d.ts` 才对上。这是 `src/main/preload/AGENTS.md` §7「DTO 多处副本静默漂移」的既存实例。**本次只加 `typeCounts?`，不顺手合并这两份类型**（最小改动原则）；若要做合并属于独立重构，需另立计划。

### 渲染层新函数入参

`useGallerySummaryCounts(files: MediaFile[])`：

| 项     | 判据                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------------------- |
| 类型   | `MediaFile[]`，禁止 `any`；返回 `{ total: number; images: number; videos: number }`                             |
| 必填   | `files` 必填；`undefined` 时按空数组处理（返回 0）——渲染层不抛业务错                                            |
| 边界   | `files = []` ⇒ 若 `hasMoreMedia && mediaTotalCount !== null` 仍返回服务端值（首屏未到位的真实形态）；否则三个 0 |
| 非法值 | `mediaTotalCount` 为 `null`/非有限数 ⇒ 一律回退数组长度（用 `Number.isFinite` 判，不用 `                        |     | ` 以免把合法 0 当缺失） |

### 路径语义 / 编码（硬性约定 §5、§6）

本计划全部改动落在渲染层与 SQLite 查询，不引入任何新的路径比较，`src/main/scanner/uid-discovery.ts` 那类 win32 钉/方言判据不受影响 ⇒ `path-semantics-guard.test.ts` 三张登记表**不需要**新增条目。新文件一律 UTF-8 无 BOM + LF（`source-encoding.test.ts` 硬拦）。

---

## 6. 实施节点

> 每节点闭环：**先写能复现的红灯测试并确认它红 ⇒ 改代码 ⇒ 重跑确认绿 ⇒ 跑该节点相关测试子集**。红灯未红过就不算覆盖到 bug。

### Node 1 — 主进程按同一 WHERE 给出分类型真计数

**输入**：`media:list` 现有入参（不变）。
**输出**：响应多一个可选 `typeCounts: { image, video }`。

改：

1. `src/main/database/media-repository.ts:1206`（`countMedia` 之后）新增私有方法：
   ```ts
   /** 与 countMedia 同一 WHERE：图库的分类型真计数（R-1 根因修复） */
   private countMediaByType(whereClause: string, whereParams: unknown[]): { image: number; video: number } {
     const rows = this.db
       .prepare(`SELECT file_type as type, COUNT(*) as count FROM media_files ${whereClause} GROUP BY file_type`)
       .all(...whereParams) as Array<{ type: string | null; count: number }>
     // 只回填 image/video；其它历史类型计入 total 但不进本字段
   }
   ```
2. `MediaListResult`（`:357`）加 `typeCounts?: { image: number; video: number }`。
3. 调用点：游标分支首页 `:1134-1137`（与 `result.total` 同一个 `if (cursor === null || …)` 块内）+ offset 分支首页各补一次；续页不调用。
4. `src/main/ipc/handlers/media-handler.ts`：返回对象（`:226` 附近）加 `typeCounts: result.typeCounts`；**首行 `@core-change` 整块替换**为本次原因。
5. 三处类型同步（§5 表）+ `docs/IPC_CONTRACT.md` 新增 `media:list` 小节。

**红灯测试**：`src/main/database/media-repository.test.ts` 新增用例——MockDatabase 建表灌 700 行（500 image / 200 video），断言 `listMedia({cursor: null, pageSize: 500})` 返回 `typeCounts` 为 `{image:500, video:200}`；再加一例带 `hideDuplicates: true` 的，断言 `typeCounts` 已排除 `is_duplicate=1`（证明口径与列表 WHERE 一致，不是全表数）；再加一例含第三种 `file_type` 的，断言 `image + video < total` 且两个键都对。
**为何修前必红**：修前 `typeCounts` 恒 `undefined`。
**验收**：`npx vitest run src/main/database/media-repository.test.ts && npm run typecheck && npm run test:main` 全绿。

### Node 2 — 计数改取服务端真值（用户可见症状的正解）

**输入**：Node 1 的 `typeCounts` + 既有 `total`。
**输出**：状态栏 / 侧栏 / 统计条显示库中真实数量。

改：

1. `src/renderer/stores/mediaStore.ts`：state 新增 `mediaTotalCount: number | null`、`mediaImageCount: number | null`、`mediaVideoCount: number | null`（初值 `null`），照 `:131` 回收站的注释风格写明「服务端真值，null=未给出⇒回退数组长度」。
2. `fetchMediaFromDatabase`（`:471-576`）返回值加 `typeCounts`，并在 `:556-560` 的 `setState` 里一并写回三个计数；`fetchMediaFromRuntime`（`:404`）分支不写（保持 null）。
3. 新增 `src/renderer/hooks/useGallerySummaryCounts.ts`，规则（可判定）：
   **`hasMoreMedia === true` 且服务端计数非 null ⇒ 用服务端三元组；否则 ⇒ 遍历传入数组。**
   理由：`hasMoreMedia === true` 是「客户端数组确定不完整」的唯一可靠信号；一旦拉齐（false），数组即真值，且此时客户端筛选（收藏/场景/日期/评分/搜索/分组）已被 `isFilteringActive` 触发自动拉齐，长度可信。
4. 三处消费方改为调用该 hook：`AppShell.tsx:64-85`（`stats` useMemo 保留 `size`/`favorites` 两项——服务端没给，仍从数组算；只把 `images`/`videos`/`total` 换成 hook 值）、`Sidebar.tsx:136-162`（`imageCount`/`videoCount` 走 hook；`filteredImageCount` 等「已加载 vs 过滤后」诊断提示保持数组口径，否则提示语义就变了）、~~`GalleryPage.tsx:783`（`total={filteredFiles.length}` → hook）~~。
   - **执行时的偏离（Node 2）**：`GalleryPage.tsx:783` 经复核**不改**。它不是「识别数量」展示位，而是 `BatchActions` 的分母——「已选 N / 共 M」中的 M，且 `handleSelectAll` 只能选中 `filteredFiles` 里的条目。把 M 换成库中真值会显示「共 1200」却只全选 500 条，属于功能错乱而非计数修复。本节点的消费者因此是 **AppShell + Sidebar 两处**。
   - 另为 Sidebar 补一条判据：`showFilteredHint` 增加 `!hasMoreMedia` 前置。列表未拉齐时展示的是库中真值，此时并在旁边的「/ 过滤后条数」是数组口径，两者不同源会被读成「900 个里过滤后剩 3」；只在数组即真值时才显示该诊断提示。
   - 注意：`size`/`favorites` 走数组意味着超大库仍有遍历开销，但那是既存行为，本节点不改（避免顺手重构）。

**红灯测试**：`src/renderer/components/layout/Sidebar.test.tsx`（该套件已存在，直接加用例，不新建文件）：把 store 置为「`mediaFiles` 500 条 + `hasMoreMedia: true` + `mediaTotalCount: 1200` + `mediaImageCount: 900` + `mediaVideoCount: 300`」，渲染后断言图片计数文本为 `900`、视频为 `300`。
**为何修前必红**：修前 store 无这三个字段、组件遍历 500 条数组 ⇒ 渲染 500 口径的数字。
补一例反向：`hasMoreMedia: false` + 数组 600 条 ⇒ 用数组长度（证明不是无脑取服务端值）。
**验收**：`npx vitest run src/renderer/components/layout/Sidebar.test.tsx && npm run test:renderer && npm run i18n:guard` 全绿。

### Node 3 — grid 视图也自动拉齐全库（按用户「两者都做」的决定）

**输入**：`hasMoreMedia` + 当前视图。
**输出**：五个视图（含 grid）在无筛选、未拉齐时也逐页推进到 `hasMoreMedia === false`。

改：`src/renderer/hooks/useFilteredMediaFiles.ts:109-121`——`shouldPullAll` 的 `viewMode !== 'grid'` 判据去掉，effect 条件改为 `hasMoreMedia && currentView !== 'recycle-bin'`（`recycle-bin` 例外是既存事实，`recycleBinFiles` 独立数据源）。`viewMode` 若再无其它用途就删掉该 selector（不留未使用变量）。注释改写为「本轮决策：全视图拉齐；显示计数另由服务端真值兜住，见 docs/plans/fix-media-recognized-count-500-limit.md」。

**保留** `VirtualImageGrid` 的 `onEndReached`（`GalleryPage.tsx:442-444`、`:723`）作为兜底入口，不删。

**红灯测试**：改写 `src/renderer/hooks/useFilteredMediaFiles.count.test.ts:131-143`——原用例名「grid 视图不自动拉齐（守护首屏分页行为）：600 个保持首屏 500」改为「grid 视图同样自动拉齐：600 个全部加载」，断言 `mediaFiles` 长度到 600 且 `hasMoreMedia` 为 false。
**这是有意的契约翻转**，不是回归：原用例钉的是「未修复的病灶」，翻转为期望值即红灯。**必须在提交信息里点名说明翻转理由与出处**，避免下一个人当成 regression 又翻回去。
再补一例：mock `media.list` 第 2 页起抛错 ⇒ 断言停在已加载的 500 条且**不再继续发起第 3 次请求**（钉住 §4「失败不死循环」）。
**验收**：`npx vitest run src/renderer/hooks/useFilteredMediaFiles.count.test.ts src/renderer/hooks/useFilteredMediaFiles.test.ts src/renderer/hooks/useFilteredMediaFiles.contract.test.ts && npm run test:renderer` 全绿。

### Node 4 — 深度刷新不再越界（R-2，让 media:updated 真正生效）

**输入**：`fetchMediaFromDatabase({ limit })`，`limit` 语义 = **目标深度**（调用点不改）。
**输出**：一次刷新返回 `min(limit, 全库)` 条，且每次 IPC 的 `pageSize ≤ 500`。

改 `src/renderer/stores/mediaStore.ts:471-576` 本地分支（骨架）：

```ts
const target = Math.max(1, options?.limit ?? MEDIA_PAGE_SIZE)
const my = ++depthSeq // 最新胜出
const first = await window.electronAPI.media.list({
  cursor: null,
  pageSize: Math.min(target, MEDIA_PAGE_SIZE) /* 既有过滤照抄 */
})
if (my !== depthSeq) return null
let collected = first.files
let cursor = first.nextCursor ?? null
let hasMore = first.hasMore ?? false
while (hasMore && collected.length < target && cursor && pages < MAX_DEPTH_PAGES) {
  const remain = Math.min(target - collected.length, MEDIA_PAGE_SIZE)
  const next = await loadMoreMedia(cursor) // 复用 :593，只取数不写 store
  if (my !== depthSeq) return null
  if (!next) break // 中途失败：保住已取，hasMoreMedia 留 true
  collected = [...collected, ...dedupeAgainst(collected, next.files)]
  cursor = next.nextCursor
  hasMore = next.hasMore
}
// setState：mediaCursor=cursor、hasMoreMedia=hasMore、三个计数取 first.*
return { files: collected, categories, total: first.total, typeCounts: first.typeCounts, hasMore }
```

**不改** `GalleryPage.tsx:228`/`:283` 的 `Math.max(MEDIA_PAGE_SIZE, …)` 调用点（语义现在成立了）；`fetchMediaFromRuntime` 的 clamp（`:415`）保留原样。

**执行时的范围扩展（Node 4，已实测补上）**：`refreshMediaAfterScan` 原先不带 limit，扫描完成/取消这条最显眼的刷新路径会把列表整体缩回一页（500）并复位游标——正是用户报的那个时刻。改为与 `media:updated` 同口径传 `limit: max(MEDIA_PAGE_SIZE, 已加载条数)`；这之所以安全，正因为本节点已让 limit 的语义变成「目标深度」而非「单页大小」。配套 `loadMoreMedia` 增加可选第二参 `pageSize`（缺省 `MEDIA_PAGE_SIZE`，触底续页行为不变），供循环按剩余额度收口——复用它是为了让续页与首页命中**完全相同**的一组服务端过滤参数（accountUid / hideDuplicates / corruptedOnly / mediaSource / galleryHighQualityOnly），另起一处 `media.list` 调用就会造出第二套过滤条件真相源。

**红灯测试**：`src/renderer/stores/mediaStore.test.ts` 新增用例：mock `window.electronAPI.media.list` 记录每次入参，调 `fetchMediaFromDatabase({ limit: 1200 })`，断言 ①**每次**收到的 `pageSize` 都 `≤ 500`；②共 3 次调用（500+500+200）；③返回 1200 条；④`hasMoreMedia` 为 false。
**为何修前必红**：修前单次传 `pageSize: 1200` ⇒ 断言①当场失败（真实链路里这一步被主进程 zod 打成 `VALIDATION_ERROR`、`fetchMediaFromDatabase` 吞成 `null`，即静默失效）。
**验收**：`npx vitest run src/renderer/stores && npm run verify` 全绿。

### Node 5 — 防复发静态守卫（钉住三条不变式）

新建 `scripts/__tests__/media-page-limit-guard.test.ts`（node 环境，`fs.readFileSync` 读源码做静态断言，照 `verify-format-scope.test.ts` / `path-semantics-guard.test.ts` 的写法）：

1. **上界同源**：`mediaStore.ts` 的 `MEDIA_PAGE_SIZE = (\d+)` 必须等于 `media-handler.ts` 里 `pageSize: z.number().int().positive().max(\d+)` 的数值，也等于 `ASSET_PAGE_LIMIT_MAX`。任何一侧被单独改动即红。
2. **禁止越界直传**：`fetchMediaFromDatabase` 本地分支传给 `media.list` 的 `pageSize` 表达式必须含 `Math.min(`，禁止再出现裸 `pageSize: options?.limit ?? MEDIA_PAGE_SIZE`。
3. **禁止按视图决定是否拉齐**：`useFilteredMediaFiles.ts` 中不得再出现 `viewMode !== 'grid'` 这类把拉齐范围按视图切开的判据（钉住 Node 3 的契约翻转，防止有人「顺手」把 grid 排除回去——这正是本轮复发的直接机制）。

**红灯取证**：守卫先落盘、后跑 ⇒ 对当前（Node 2/3/4 尚未合入）代码断言②③必须红，逐节点修完转绿。**若某个断言天生就绿，说明它没覆盖到 bug，必须重写判据。**
**验收**：`npx vitest run scripts/__tests__/media-page-limit-guard.test.ts && npm run typecheck && npm run verify` 全绿（`scripts/` 由 `tsc -p tsconfig.scripts.json` 覆盖）。

---

## 7. Verification（收尾硬门）

按 `.qoder/rules/project-conventions.md`「校验与提交」与 `AGENTS.md` 工作流，全绿才算完：

1. `npm run verify`（只读；注意 `verify` 通过 ≠ 提交时文件不变，钩子仍会 `--fix`/`--write`）
2. `npm test`（全量，一票否决）→ `npm run test:ci-linux`
3. `npm run typecheck`、`npm run typecheck:e2e`、`npm run lint`、`npm run i18n:guard`
4. `npm run test:coverage`（覆盖率阈值门控，新增行必须有测试）
5. `npm run dev` 手测 §3 的 5 条判据
6. 变异抽查两次：① 把 Node 1 的 `typeCounts` 调用点注释掉 ⇒ Node 2 的 Sidebar 用例必须转红（证明链路真的连着）；② 把 Node 4 的 `Math.min` 去掉 ⇒ 守卫②与 mediaStore 用例必须同时转红。两次都要真红，否则判为「测试未覆盖」。
7. `git status --porcelain` 复核 pre-commit 钩子留下的改写；提交信息用 Conventional Commits，一节点一提交（`fix(database)` / `fix(renderer)` / `fix(gallery)` / `fix(store)` / `test(guard)`）。

## 8. 风险与回滚

| 风险                                                                                                                                                          | 处置                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 3 让超大库首屏走 N/500 次串行 IPC，首屏变慢、内存上升（这是用户主动选择「两者都做」的代价，原分页是为「万级文件 OOM」而设，见 `mediaStore.ts:288` 注释） | 保留 `onEndReached` 兜底 + `loadNextMediaPage` 的 `loadingMore` 串行保护；Node 4 的 `MAX_DEPTH_PAGES` 给硬上限。**若 dev 手测明显卡顿，Node 3 可单节点独立回滚，回滚后 Node 1/2 的服务端真值计数仍然成立**（数字不再停在 500，只是网格仍靠滚动翻页） |
| 服务端 `typeCounts` 不含客户端筛选，可能被误接到筛选态导致数字不变小                                                                                          | Node 2 规则以 `hasMoreMedia` 为唯一判据；筛选态因 Node 3 必然拉齐 ⇒ `hasMoreMedia=false` ⇒ 走数组长度。用 `hasMoreMedia=false` 反向用例钉住                                                                                                          |
| Node 4 循环中途 `media.list` 抛错导致整刷丢失                                                                                                                 | `break` 保留已取数据、`hasMoreMedia` 留 true 供下轮重试；§5 的失败用例覆盖                                                                                                                                                                           |
| `image + video ≠ total`（第三种历史 `file_type`）被当成 bug 追查                                                                                              | Node 1 测试显式覆盖并在契约文档写明口径                                                                                                                                                                                                              |
| 契约漂移：`shared/types` 的 `MediaListResult` 用 `items`、handler 用 `files`                                                                                  | 本次只加字段、登记于 §5，不顺手合并（合并属独立重构，另立计划）                                                                                                                                                                                      |
| 又被人「顺手」把 grid 排除回拉齐判据                                                                                                                          | Node 5 守卫第 3 条正是为此而写                                                                                                                                                                                                                       |

回滚顺序：Node 5 → 4 → 3 → 2 → 1 逐节点 `git revert`，节点间无相互依赖破坏正确性（Node 1/2 自成闭环，Node 3/4 各自独立）。

## 9. 本轮明确不做

- 不抬高 `media:list` 的 `pageSize` zod 上界（它是真实的入口闸门）。
- 不动 NikkiSync 协议侧的 `MAX_PAGE_LIMIT = 500`（上游真相源）。
- 不改 `SCAN_BATCH_SIZE`、`SQL_IN_CHUNK_SIZE`、500ms 节流（均非上限）。
- 不合并 `MediaListResult` 的 `items`/`files` 双副本。
- 不改 `AppShell` 里 `size`/`favorites` 的数组遍历算法（既存行为，非本 bug）。
