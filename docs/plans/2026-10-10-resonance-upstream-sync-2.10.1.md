# 共鸣录上游同步取证（gongeo.us-nikki-tracker 2.9.1 → 2.10.1）

日期：2026-10-10 · 范围：共鸣录板块静态数据快照 + 镜像逻辑 + 两个上游新功能移植
上游：`dastrokes/gongeo.us-nikki-tracker`（MIT）比较基准 `e4ef5e3d`（2026-08-28，上次快照来源）→ `65bb3d8f`（2026-10-09，本次同步目标）

计划文件：`.zcode/plans/resonance-upstream-sync-2.10.1.md`（本地目录，不入仓）

---

## 1. 结论摘要

| 指标                    | 同步前     | 同步后                                                       |
| ----------------------- | ---------- | ------------------------------------------------------------ |
| gameVersion             | 2.9.1      | **2.10.1**                                                   |
| 卡池数 / latestBannerId | 73         | **77**                                                       |
| totalCatalogEntries     | 10,676     | **11,095**                                                   |
| catalog 生成时间        | 2026-08-28 | 2026-09-23                                                   |
| percentile 生成时间     | 2026-03-15 | **2026-03-15（未变）**                                       |
| 缩略图张数              | 73         | **77**                                                       |
| `data/resonance` 体积   | ≈4.3 MB    | **7.30 MB / 107 文件**（含 names 3.9 MB、thumbnails 3.0 MB） |
| 新增功能                | —          | 卡池心愿单、共鸣 suit_list 一键导入衣柜                      |

全量回归：`npm test` **337 文件 / 5331 用例全通过**；`npm run typecheck`、`npm run lint`（0 error，11 条为 DEBT-030 存量 BOM warning）、`npm run i18n:guard`、`npm run i18n:check`（3804 键对齐）、`npm run build` 均通过；离线守卫 `offline-guard.test.ts` 5/5 通过。

---

## 2. 差异取证与处置

### 2.1 静态数据（走既有生成脚本，无手工改 JSON）

三条命令按 static-data → names → thumbnails 顺序执行（`--source` 指向仓库外只读克隆 `D:\tmp\gongeo-tracker-65bb3d8f`，`rev-parse HEAD` = `65bb3d8f08ff2bc67bf1b08ef98d88a3ab169f49`）：

- **卡池**：新增 74/75（`bannerType 3`，2.9.2 深眠池，`outfit5StarId: []`，带 `rewardIds`）、76/77（`bannerType 2`，2.10.1 限定池，档期分别到 2026-10-29 / 2026-11-26）；**卡池 30 追加 2.10.2 复刻档期**（记录页取末档展示版本号，故 `RecordsView` 现显示 v2.10.2）。
- **套装**：新增 6 个部件表 10343/10347/10394/10398/10399/10430。
- **图鉴**：11 片全部换 2.10.1 版本；`sketches` 仍按生成脚本既有约定**不引入**（共鸣录衣柜无 sketch 分类）。
- **百分位**：上游 `data/percentile.json` 未变更 → **未重生成**，`percentileGeneratedAt` 保持 2026-03-15。
- **名称包**：12 语言各 9523 条；`en` 分段增量与图鉴增量吻合（banner +4、整妆 +6、item +294、outfit +26、momo +5、prop +7、eureka +6）。
- **缩略图**：新增 74-77.png（索引 77 条）。

三项独立审计（均为只读脚本，结果入档）：

1. **新实体缺名**：74-77 卡池名、6 个新套装名、74/75 的 6 个 rewardId 物品名，在 `en` 与 `zh-CN` 名包中**零缺失**（计划 R1 停止条件未触发）。
2. **rewardIds 悬挂**：全库 132 个 `rewardIds` 对 `items.json` id 全集（8213 个）**零悬挂**（生成器只校验 banner→outfit，从不校验 rewardIds，故补此检）。
3. **幂等探针**：重跑三条命令后比对，105 个文件集合一致、字节内容全部一致，唯一差异是 `snapshot-meta.json` 的 `generatedAt`（脚本头注释声明的既定不确定性）；`banners.json` 常驻池 `runs[0].end` 因同日重跑未变。

### 2.2 镜像逻辑

| 项         | 上游                                                      | 本地落点                 | 处置                                                                                                                       |
| ---------- | --------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 区域覆盖表 | 删除 `1021780109`/`1021940016` 两条 cn 覆盖（转全球可用） | `catalogAvailability.ts` | 同步删除；测试先证明二者仍在 2.10.1 目录全集中（是转服非下架）再断言双服可用                                               |
| 变体工具   | 新增 `getFullMakeupVariantType(componentIds)`             | `variants.ts`            | 逐字移植 + 新增 `variants.test.ts`（此前无独立套件）                                                                       |
| 衣橱汇总   | 废弃 `endsWith('03')` 启发式，改按索引字段 `variantType`  | `wardrobe.ts`            | 公共类型 `WardrobeSummaryCatalogIndex.makeups` 增 `variantType`（与上游一致，经用户确认）；过滤改 `variantType === 'base'` |

**整妆判定分歧审计**（用本仓库真实 catalog + `variants.ts` 的前缀表解码复算，非推断）：2.10.1 共 95 个整妆，旧规则判基底 61 个、新规则判基底 60 个，**唯一分歧 = `10239002`**（尾缀 02 使旧规则计入，其部件前缀 1025 为进化3 → 新规则排除）。因此衣柜汇总的 `fullMakeups.total` 在国际服口径下会少 1 —— 这是上游修复的判定缺陷，属预期的用户可见统计变化。

### 2.3 移植的两个新功能

- **卡池心愿单**：`{version:1, entries:[{bannerId}]}` 与上游同构；`normalizeBannerWishlist` 按本地 `BANNER_DATA` 校验（结构非法抛 `ValidationError`，条目级非法静默丢弃以容忍跨版本文件）。持久化新增 `resonance_banner_wishlist` 表（`UNIQUE(banner_id)` + `INSERT OR IGNORE` 幂等），`clearAll` 连带清空。UI 为 `BannerWishButton`（`aria-pressed`、写入中禁重复点击）挂在卡池信息条，导入/导出面板各加一个勾选。
- **共鸣 suit_list 导入衣柜**：`getPearpalCompletedOutfitItemIds` + `parsePearpalSuitIdsFromText` + WardrobeView「从共鸣笔记导入」，复用 `dialog:openFile` / `resonance:readImportFile` / `resonance:updateWardrobe`，**零新增 IPC 通道**。

---

## 3. 相对计划的偏离（均为收敛改动面，已核实）

1. **计划提交 1、2 合并**：红灯测试与被其锚定的数据快照若分两次提交，第一条提交会留下必然失败的测试（且被 `test:precommit` 钩子拦下）。改为「锚定测试 + 生成物」同批提交，使每个提交都可独立通过。
2. **心愿单只新增 1 个 IPC 通道**：读取并入既有 `resonance:getData` 的可选 `wishlist` 字段（该通道本就是共鸣录的唯一全量读入口），只保留 `resonance:setWishlist` 作为写通道；比计划少一个通道。
3. **未新增 `ResonancePearpalNotebookPayload` 类型**：笔记结构完全外部、解析按 `unknown` 逐项收敛，声明无人消费的类型即死代码，故只在函数 JSDoc 标注上游出处。
4. **`getPearpalCompletedOutfitItemIds` 存在性判据替换**：本地目录索引无 `outfitById`，改以 `outfitItemsById.has(suitId)`；上游对「已登记但无部件」的集合同样返回空集，输出等价。已在函数注释中写明差异与出处。
5. **`includeWishlist` 为可选参数**（`ResonanceExportOptions` / `CommitImportOptions` / `ResonanceExportRequest`）：避免波及其余既有调用点与测试，缺省语义为「不导出/不覆盖」。

---

## 4. 明确不同步清单（下次同步不必重新推导）

上游 `e4ef5d→65bb3d8f` 的其余变更均判定为**宿主不适用**，未移植：

- profile slots / `slot` 形参贯穿 IndexedDB 组合式（本仓库单档案 + SQLite，无槽位概念）
- 社区 tierlist、全局搜索、图表重构与 `useStatsChartMaximize`、shareCard、landing page、Nuxt 4.6 升级
- `data/aliases.ts`、`data/attribute.json`、`data/source.json`、`data/entitySlugs/*`、`data/item-search/*`、`public/catalog/sketches.*`（本仓库生成器不消费）
- Cloudflare worker / Supabase / umami / 维护页等纯服务端项
- `itemSlugOverrides`、`communityTierlistScope`、`catalogListingFacets`、`searchAutocomplete` 等目录检索向工具

保留判断：`exportPayload` 的 `bannerWishlist?` **已移植**（导出格式对齐上游）；上游同文件其余改动（slots）不移植。

---

## 5. TDD 红绿取证（每个节点修复前实测 FAIL）

| 节点             | 红灯证据（实现前实测）                                                                                                | 绿灯证据（实现后）                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 数据快照锚点     | `staticData.test.ts` **5 failed**（77 卡池、卡池 30 复刻、6 新套装、meta 2.10.1、74-77 缩略图）                       | 三级生成后共鸣录 utils **11 文件 117 passed**                                          |
| 区域覆盖         | `catalogAvailability.test.ts` **1 failed**（`global` 期望 true 实得 false；目录成员前置已 PASS，证明非恒真）          | utils **118 passed**                                                                   |
| 整妆 variantType | 新夹具 + **还原旧实现**回放 → `wardrobe.test.ts` **3 failed**；`variants.test.ts` 因缺导出整文件失败（合计 8 failed） | `wardrobe.test.ts` 20/20、utils **148 passed**                                         |
| 心愿单纯函数     | `bannerWishlist.test.ts`（Cannot find module）+ `shared/types/resonance.test.ts` **5 failed**                         | 两文件 44/44                                                                           |
| 心愿单持久化/IPC | `resonance-repository.test.ts` **6 failed**（六张表、CRUD、幂等、getAllData、上限、clearAll）                         | repository 17/17；handler + preload **80 passed**（含「注册全部 10 个通道」）          |
| 心愿单 store/UI  | `resonanceStore.test.ts` **4 failed**（toggle、失败回滚、批次携带、导出载荷）                                         | store 21/21；组件 5 文件 **33 passed**                                                 |
| suit_list        | 纯函数 **7 failed**（is not a function）；组件 2 例在还原旧 UI 后 **failed**（Unable to find button）                 | utils 148/148、WardrobeView 10/10                                                      |
| 全局             | —                                                                                                                     | `npm test` **337 文件 / 5331 用例全通过**；main+shared 单独跑 174 文件 / 3294 用例通过 |

闸门与门禁：

- 核心路径授权：`resonance-handler.ts` 与 `preload/api/resonance.ts` 各带一条本次真实原因注释，`[CORE-GATE] ✓ 通过（2 个受保护文件）`。
- `docs/IPC_CONTRACT.md` 新增 §7 登记 `resonance:setWishlist` 及 `getData` / `commitImport` / `export` 的可选字段扩展（向后兼容，无破坏性变更）。
- 受保护文件之外的改动无需授权注释；`src/shared/types/resonance.ts` 与 `src/renderer/utils/resonance/**` 不在保护清单内。
- 数据提交的验证口径：`npm run verify` 的相关单测只由 `.ts/.tsx` 变更驱动（`scripts/verify-changes.ts:110,182`），纯 JSON/PNG 会让它**不跑任何测试**，故数据节点以显式 `npx vitest run src/renderer/utils/resonance` 为门。

---

## 6. 提交清单

| 提交      | 内容                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `47ad656` | `fix(resonance-data)`：静态快照同步（32 文件，含 4 张新缩略图与锚定测试）                            |
| `b66871a` | `fix(resonance)`：剔除两条过期 cn 区域覆盖                                                           |
| `1a12d54` | `fix(resonance)`：整妆基底判定改用 variantType                                                       |
| `2545252` | `feat(resonance)`：卡池心愿单（契约 / 纯函数 / DB / IPC / store / UI / 12 语言 / 契约文档，35 文件） |
| `96a37c0` | `feat(resonance)`：共鸣 suit_list 导入衣柜（18 文件）                                                |
| 本提交    | `docs(resonance)`：本取证报告 + 08-29 报告现值标注                                                   |

---

## 7. 手动验收清单（待用户在 `npm run dev` 中复核）

- 共鸣录 · 统计：图鉴元数据显示游戏版本 2.10.1；百分位生成时间仍为 2026-03-15。
- 共鸣录 · 记录：卡池 30 标注 v2.10.2；下拉可选 74-77 且缩略图为本地 `media://`/相对资源（DevTools Network 无任何 http(s) 图片请求）。
- 共鸣录 · 心愿单：星标切换后重启应用仍在；写入失败时回滚并出 toast。
- 共鸣录 · 衣橱：「从共鸣笔记导入」对含 `info_from_self.suit_list` 的笔记 JSON 能标出部件；无该字段时提示且不写入。
- 导入/导出：导出勾选「卡池心愿单」后 JSON 含 `bannerWishlist`；导入含该段的文件时出现对应勾选。
