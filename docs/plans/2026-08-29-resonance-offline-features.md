# 共鸣录四项离线功能实装计划（共鸣记录 / 我的衣橱 / 导入数据 / 个人统计）

- 日期：2026-08-29
- 状态：**已全部实装完成（2026-08-30）**。T0–T14 全部落地；与原计划的差异见 §10 与本文末尾「执行补充注记」。
- 源项目：[gongeo.us-nikki-tracker](https://github.com/dastrokes/gongeo.us-nikki-tracker)（dastrokes，MIT License，已获授权）
- 源仓库获取：`git clone --depth 1 https://github.com/dastrokes/gongeo.us-nikki-tracker` 到**系统临时目录**（如 `%TEMP%\gongeo-us-nikki-tracker`），仅作生成期只读参考；运行时零依赖，产物已提交进本仓库。

## 执行补充注记（2026-08-30 第二阶段收尾）

1. **T9/T10/T11 三子页**：WardrobeView（五分类 + 套装聚合 + 搜索/筛选 + 批量勾选 + 从共鸣记录推断）、ImportExportView（预览/分批提交/进度取消/导出/清空/快照标注）、StatsView（总览卡 + 欧非分析 + SVG 直方图/累计曲线 + 按卡池明细）全部实装，各有组件测试。
2. **偏离采纳**：迁移内联进 connection.ts 幂等执行循环（无独立函数/版本号）；导入进度/取消在渲染层分批实现（每批 ≤2000 行单事务，无主进程事件通道）——均为功能等价。
3. **i18n**：12 语言全部补齐（实译 zh-TW/en/ja/ko/de/es/fr/pt/ru；th/vi 英文回退，待源项目/后续版本翻译）；`check-i18n-keys` 全绿。致谢条目已加 `settings.about.depDesc.gongeouNikkiTracker` + `depDescTodo.gongeous`（非 zh/en 语言 UI 显示英文占位提示）。
4. **离线守护**：offline-guard.test.ts（运行时打桩 + 静态扫描 + 反向用例）通过；共鸣录新增源码零网络 API、零 http(s):// 字面量。
5. **走查修复**：dev 实测发现清空全部后页面停留加载态，已修复（clearAllResonanceData reset 后强制重拉）；ipc-setup/preload 契约测试随新 handler 同步（39 handlers / 30 键）。
6. **基线遗留（与本功能无关，未动）**：typecheck 17 错（recovery/mediaStore 等历史文件）、lint 10 错 6 警（.cache/e2e/scripts）、vitest 2 败（path-safety 权限用例、GalleryStackOverflow 栈溢出）——改动前后完全一致。

## 1. 依赖声明

结论：**零新增运行时依赖、零新增开发依赖**。全部使用宿主既有依赖。

| 包名                    | 版本（读自宿主 package.json） | 用途                                | 新增/已有 | 替代方案评估                         | 许可证 |
| ----------------------- | ----------------------------- | ----------------------------------- | --------- | ------------------------------------ | ------ |
| zod                     | ^4.4.3                        | 全部 IPC 入口与导入文件 schema 守卫 | 已有      | 自写校验（否决：重复造轮、覆盖不全） | MIT    |
| better-sqlite3          | ^12.11.1                      | 持久化（新表）                      | 已有      | —                                    | MIT    |
| zustand                 | ^5.0.14                       | 渲染层状态                          | 已有      | —                                    | MIT    |
| react / react-dom       | ^19.2.7                       | UI                                  | 已有      | —                                    | MIT    |
| react-i18next / i18next | ^17.0.10 / ^26.3.6            | UI 文案                             | 已有      | —                                    | MIT    |
| react-virtuoso          | ^4.18.11                      | 共鸣记录长列表                      | 已有      | masonic（网格瀑布流，不适合列表）    | MIT    |
| tsx                     | ^4.23.1                       | 运行生成脚本（devDependency）       | 已有      | —                                    | MIT    |

源项目依赖逐项裁定（均**不引入**）：

| 源依赖                           | 裁定   | 判断依据                                                |
| -------------------------------- | ------ | ------------------------------------------------------- |
| snappyjs 0.7.0                   | 不使用 | 仅 Pearpal API 响应解压需要，该联网途径已整体剔除       |
| fflate 0.8.3                     | 不使用 | 仅云同步 gzip 需要，云同步已剔除                        |
| fuse.js 7.5.0                    | 不使用 | 本地模糊搜索；四项功能名称过滤用 `String.includes` 足够 |
| idb 8.0.3                        | 不使用 | 浏览器 IndexedDB 封装；持久化映射宿主 SQLite            |
| @supabase/supabase-js            | 不使用 | 联网后端客户端，剔除                                    |
| echarts + nuxt-echarts           | 不使用 | 图表用 SVG/CSS 手写（直方图/累计曲线规模小）            |
| sortablejs                       | 不使用 | 无拖拽排序需求                                          |
| naive-ui / nuxt / pinia / vueuse | 不使用 | 源前端框架与状态库，按约束禁止带入                      |

## 2. 启动说明

1. **环境前提**：Windows x64；Node ≥ 20（仓库 `.node-version` = 22）；better-sqlite3 为原生模块，`npm install` 后 electron-vite dev 直接可用；打包时 `npmRebuild: true` 自动针对 Electron ABI 重编译（与宿主现状一致，无新增原生依赖）。
2. **常用命令**（以宿主实际 scripts 为准）：
   - 安装：`npm install`
   - 开发：`npm run dev`
   - 检查：`npm run typecheck`、`npm run lint`、`npm test`（或 `npm run test:main` / `test:renderer` / `test:db`）、`npm run i18n:check`
   - 打包：`npm run dist:win`
3. **数据库迁移**：随应用启动在 `DatabaseManager.applyMigrations()` 内自动执行；本功能为**纯新增表**（`CREATE TABLE IF NOT EXISTS`，幂等、可重复执行），对已有库零破坏；迁移前自动 `VACUUM INTO` 预备份（既有机制），失败整体回滚。回滚方式：git revert 后残留表无害（不被读取）；亦可用设置内 `backup:restore` 整库恢复（新表自动包含在既有整库备份内）。
4. **验证路径**：启动后侧边栏点「共鸣录」→ 四个子页（共鸣记录 / 我的衣橱 / 导入数据 / 个人统计）。断网自测：断开局域网/无线后重复以上操作，四页全部可用（宿主自带的更新检查失败属既有行为，与本功能无关）。
5. **源仓库获取**：见文件头；仅生成脚本（`scripts/generate-resonance-*.ts`）需要它，生成产物已提交。
6. **回滚方式**：见第 3 点。

## 3. 总体设计

**数据流**：渲染层 zustand store ← `window.electronAPI.resonance.*`（preload）→ `resonance-handler`（zod 校验 + wrapHandler）→ `ResonanceRepository`（better-sqlite3，全参数绑定）→ `userData/database/wxnn_photo_manager.db` 新表。保底/统计/合并/导入解析校验等业务计算全部为渲染层纯函数（自源项目移植）；主进程只负责存储、文件读取解析（含 PathGuard）与导出写盘。

**新增 SQLite 表**（迁移 v4，`migrateResonanceTables()`，全部 `CREATE TABLE IF NOT EXISTS` + 参数绑定）：

| 表                       | 列                                                                                                                                                                                                              | 约束                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| resonance_pulls          | id INTEGER PK AUTOINCREMENT, banner_id TEXT NOT NULL, item_id TEXT NOT NULL, obtained_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'json' CHECK(source IN ('json','manual-import')), created_at TEXT NOT NULL | UNIQUE(banner_id, obtained_at, item_id)；索引 (banner_id, obtained_at) |
| resonance_edits          | banner_id TEXT NOT NULL, item_id TEXT NOT NULL, created_at TEXT NOT NULL                                                                                                                                        | UNIQUE(banner_id, item_id)                                             |
| resonance_pearpal        | banner_id TEXT NOT NULL, item_id TEXT NOT NULL, pool_cnt INTEGER NOT NULL, obtained_at TEXT NOT NULL                                                                                                            | UNIQUE(banner_id, item_id, pool_cnt)                                   |
| resonance_evo            | banner_id TEXT NOT NULL, outfit_id TEXT NOT NULL, level INTEGER NOT NULL CHECK(level BETWEEN 0 AND 4), updated_at TEXT NOT NULL                                                                                 | UNIQUE(banner_id, outfit_id)                                           |
| resonance_wardrobe_items | category TEXT NOT NULL CHECK(category IN ('item','makeup','momo','prop','eureka_color')), item_id INTEGER NOT NULL, updated_at TEXT NOT NULL                                                                    | PRIMARY KEY(category, item_id)                                         |

说明：品质不入库（由静态数据推导，与源语义一致）；更新时间戳存 `app_settings` KV（key 前缀 `resonance.`）；合并幂等键比源站更细（含 item_id，修复源站「同一秒多条丢失」缺陷），JSON round-trip 仍完全兼容。

**IPC 通道（9 个，全部 zod + wrapHandler，错误走 AppError/IPC_ERROR_CODES）**：

| 通道                         | 入参（要点）                                           | 出参                                                                                                    |
| ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| resonance:getData            | 无参                                                   | {pulls, edits, pearpal, evo, wardrobe, updatedAt}                                                       |
| resonance:addManualRecord    | (bannerId 数字, itemId 10 位数字串, obtainedAt 时间串) | {added}                                                                                                 |
| resonance:updateManualRecord | (recordId, obtainedAt)                                 | {updated}                                                                                               |
| resonance:deleteRecord       | (recordId)                                             | {deleted}                                                                                               |
| resonance:importPreview      | (filePath)                                             | {format:'legacy'\|'current', version, counts:{added,duplicate,invalid}, samples, wardrobe?}，**零写入** |
| resonance:importCommit       | (importIdtoken 引用的载荷结构)                         | {imported} + 进度事件 resonance:importProgress + resonance:importCancel                                 |
| resonance:export             | (options:{includeWardrobe 等, filePath})               | {path}，写盘前置 PathGuard 校验                                                                         |
| resonance:updateWardrobe     | (adds:[{category,itemId}]≤5000, removes:[…]≤5000)      | {wardrobe}                                                                                              |
| resonance:clearAll           | 无参                                                   | {cleared}                                                                                               |

文件选择复用既有 `dialog:openFile` / `dialog:saveFile` 通道。

**导入/导出格式 = 源项目同构**：`{pulls:{bannerId:[[ts,itemId],...]}, edits:{...}, evo:{...}, pearpal:{...}, wardrobe?}`；同时兼容源站旧格式 `Record<number, PullRecord[]>`。版本不兼容时预览层给「尝试兼容导入 / 放弃」双选项。用户可从 gongeo.us 网页版经本地 JSON 文件全程离线迁移。

**渲染层结构**：

- 纯逻辑：`src/renderer/utils/resonance/`（types / banners 装载 / catalogCompactFormat / merge / process / personalStats / percentile / wardrobe / importParse / exportPayload / staticData）
- 静态数据：`src/renderer/data/resonance/`（banners.json、outfits.json、catalog/*.json、percentile.json、snapshot-meta.json、names/<lang>.json ×12 懒加载）
- store：`src/renderer/stores/resonanceStore.ts`
- UI：`ResonanceRecordsPage.tsx` 改为容器 + 内嵌四子页切换（按钮组范式）；子组件 `src/renderer/components/resonance/`；长列表 react-virtuoso；图表纯 SVG/CSS；主题走 CSS 变量（--bg-tertiary/--text-primary/--accent 等）+ glass-panel/btn-* 工具类，不硬编码色值。

**i18n 与致谢**：词条加 `resonance.*` 段同步 12 语言（zh-CN 基准）；实体名不入 i18next（数量过大），走 `names/<lang>.json` 名称包按语言懒加载，缺译回退英文。致谢在 `settings/about-sections.tsx` 的 AboutLicenseSection `runtimeDeps` 新增 `gongeo.us-nikki-tracker`（MIT）条目；zh-CN/en 文案照抄授权文案，其余 10 语言填英文并以独立 key `settings.about.depDescTodo.gongeous` 承载「待翻译，当前回退英文」TODO 标记（JSON 无注释，不删 key、不改结构）。

## 4. 数据裁剪摘要

源仓库约 334MB（大头为卡池立绘 PNG），本功能取子集：

| 产物                  | 来源                                            | 裁剪规则                                                                                                                                                                                                                         | 实测体积   |
| --------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| banners.json          | 源 data/banners.ts（21KB，73 卡池）             | 原样转 JSON（常驻池 runs.end 快照为生成日）                                                                                                                                                                                      | 见生成报告 |
| outfits.json          | 源 data/outfits/（105 个 TS 文件）              | 合并为单 JSON：outfitId → items[]                                                                                                                                                                                                | 见生成报告 |
| catalog/*.json        | 源 public/catalog/（12 片）                     | 取 11 片（items/outfits/makeups/momo/eurekas/props/outfitItems/makeupItems/makeupOutfits/momoOutfits/palettes），逐字节原样保留（压缩元组格式，运行时用移植的解码器展开）；**剔除 sketches（85KB，地图宝箱坐标，四功能不需要）** | 见生成报告 |
| percentile.json       | 源 data/percentile.json                         | 原样 + snapshot-meta.json（来源/生成时间/游戏版本）                                                                                                                                                                              | 3KB        |
| names/<lang>.json ×12 | 源 app/locales/{de,en,es,fr,it,pt,ja,ko,zh,tw}/ | 生成脚本只保留产物数据集中出现的实体 id；宿主 12 语言中 ru/th/vi 源无翻译 → 复制英文包并在生成脚本与 meta 中记 TODO；按语言动态 import 分 chunk                                                                                  | 见生成报告 |

剔除理由备注：palettes 起初计划剔除，但衣橱「共鸣色（eureka color）」需要颜色映射支撑展示，且体积可控，故纳入；sketches 与四项功能完全无关，剔除。

## 5. 错误处理（沿用宿主机制：AppError + IPC_ERROR_CODES + useErrorToast/useGlobalToast；不弹原生系统框、不写空 catch、不吞异常）

| 场景                                   | 处理                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 导入文件解析失败（损坏/编码错/缺字段） | zod 守卫失败 → VALIDATION_ERROR + 可读中文错误（i18n key 带字段/行定位），不写库                                           |
| 导入数据版本不兼容                     | 预览层识别格式/版本，给「兼容导入 / 放弃」选项                                                                             |
| 数据量过大                             | 文件大小与记录数上限（zod max）；importCommit 分批事务（1000 行/批）+ importProgress 进度事件 + importCancel 取消，不卡 UI |
| 重复/冲突记录                          | 预览返回新增/重复/无效计数（幂等键 = UNIQUE 约束），由用户确认后提交                                                       |
| 数据库写入失败（磁盘满/锁/约束冲突）   | 分批事务失败整体回滚，不留半截数据；错误映射 AppError（DatabaseError）上抛                                                 |
| 文件读写失败、导出路径非法             | 读路径经 PathGuard 白名单；导出前置校验（父目录存在、可写、扩展名合法），拒绝执行并提示具体原因                            |
| IPC 失败/主进程异常                    | 渲染层 EmptyState error 态 + useErrorToast（按 code 分级时长），不白屏不静默                                               |
| 静态快照缺失/损坏                      | 降级：名称回退显示 itemId、欧非区块隐藏、图鉴空态；不崩溃                                                                  |
| （若存在）联网入口被点击               | 本次无此类入口（边界点 A 结论：无预置入口）                                                                                |

## 6. 参数校验

- 校验库：宿主既有 zod v4；schema 定义在 `src/shared/types/resonance.ts`（主进程 IPC 与渲染层二次轻校验共用）。
- 校验边界：全部 9 个 IPC 通道（wrapHandler 强制 safeParse）+ 导入文件解析入口（本地文件属不可信输入，按同等强度 schema 守卫：顶层结构、格式识别、版本字段、数组上限（总记录 ≤ 200_000、单卡池 ≤ 50_000）、时间格式 `YYYY-MM-DD HH:mm(:ss)?` 正则、itemId/bannerId 数字串格式、字符串长度上限、未知字段剥离）。
- 覆盖：共鸣记录增删改字段（类型/范围/枚举/必填）、衣橱批量更新（category 枚举、itemId 正整数、批量上限 5000/次）、导入文件内容、导出参数（路径合法性 + 内容勾选）、统计查询参数（纯函数入参）、静态图鉴加载（解码器守卫，损坏降级）。
- 非法输入：拒绝执行 + 明确文案 + 零副作用（preview 不写库，commit 前全量校验）。

## 7. 基础测试用例（vitest，与源码同目录 `*.test.ts`；禁止跳过/占位/注释失败用例凑通过率）

1. **纯函数**（src/renderer/utils/resonance/*.test.ts）
   - merge：全重复/部分重叠/乱序/空集/中间时间段插入
   - process（保底）：零抽、刚好触发清零、跨卡池独立计数、4★/5★ 分别计数、type-3 归入 4StarOnly、edits 负索引不参与 pity
   - personalStats：总数/稀有度分布/平均出货/按卡池与时间分组/欧非百分位与档位/直方图分桶
   - percentile：插值边界（低于最小/高于最大/区间内）+ 快照缺失降级
   - importParse：合法（旧/新格式）/缺字段/类型错/超大数组/异常字符/重复键
   - exportPayload → importParse round-trip 深度相等（含 wardrobe/pearpal/evo）
   - wardrobe：normalize 去重排序、套装进度（零件/全满/部分）、变体与进化等级推断、从共鸣记录推断衣橱
   - catalogCompactFormat：各 part 解码 + 损坏输入守卫
2. **数据库层**（src/main/database/resonance-repository.test.ts，MockDatabase 内存引擎范式）：迁移幂等可重复执行；干净库 CRUD；UNIQUE 约束生效；分批事务写失败回滚
3. **IPC handler**（src/main/ipc/handlers/resonance-handler.test.ts，捕获注册闭包直调）：正常路径返回正确；校验失败返回 VALIDATION_ERROR 且不落库；importPreview 不产生任何写操作
4. **状态层**（resonanceStore.test.ts）：各 action 对状态影响；IPC reject 分支不污染状态
5. **schema**：每个 schema ≥1 合法 + ≥2 非法
6. **离线断言**（offline-guard.test.ts，本次必做）：vi.stubGlobal 打桩 fetch + spy http/https 模块，跑 导入解析→合并→保底统计→衣橱→导出组装 核心流程断言零网络调用；静态扫描全部新增 resonance 源文件断言无网络 API；含「故意注入 fetch 必须报警」反向用例防假绿

## 8. 子任务清单（每项：涉及文件 / 输入 / 输出 / 验收标准）

> 执行纪律：逐子任务实施，每步跑「三项检查」（`npm run typecheck` + `npm run lint` + 相关 vitest 套件），全绿才进入下一项。

### T0 源仓库获取与静态数据产物生成

- 文件：新增 `scripts/generate-resonance-static-data.ts`、`scripts/generate-resonance-names.ts`、`src/renderer/utils/resonance/catalogCompactFormat.ts`（解码器先移植供校验）、生成 `src/renderer/data/resonance/**`、`.prettierignore`（追加生成数据目录）；产出 `docs/plans/2026-08-29-resonance-offline-data-report.md`
- 输入：临时目录源仓库（data/、public/catalog/、app/locales/）
- 输出：banners.json、outfits.json、catalog/*.json（11 片）、percentile.json、snapshot-meta.json、names/<lang>.json ×12、体积报告
- 验收：产物 JSON 可解析、可被 tsc 解析引用；解码器能解出全部 11 片；脚本幂等可重跑；体积报告落盘

### T1 共享类型与 zod schema

- 文件：新增 `src/shared/types/resonance.ts`、`src/shared/types/resonance.test.ts`
- 输入：本计划 §3/§6；输出：DTO（与源 shared/types 同构）+ 6 组 schema
- 验收：typecheck 绿；每 schema ≥1 合法 + 2 非法单测通过

### T2 纯函数移植 + 单测

- 文件：新增 `src/renderer/utils/resonance/{types,merge,process,personalStats,percentile,wardrobe,importParse,exportPayload,catalogCompactFormat}.ts` + 同名 `.test.ts`
- 输入：源 shared/utils/trackerDataMerge.ts、wardrobe.ts、variants.ts、bannerCompletionLevels.ts、wardrobeTrackerImport.ts、wardrobeSummary.ts、app/utils/{stats,percentile,catalogCompactFormat}.ts、app/composables/useBannerPullData.ts（processBannerPullData/processJsonImport）、usePersonalStats.ts、usePearpalData.ts（processPearpalData 纯转换部分）、app/utils/profileDataExport.ts
- 输出：框架无关纯函数；**剥离对 useBannerPullApi（联网）的 import 耦合**
- 验收：§7.1 全部场景覆盖且通过；三项检查全绿
- 差异说明：源 processBannerPullData 依赖 Pinia/composable 包装，移植为纯函数签名 `(banners, pulls, edits, deps) => ProcessedBanner`；addMissingItems（未获得件占位 count=0）一并移植

### T3 静态数据装载模块 + 降级

- 文件：新增 `src/renderer/utils/resonance/staticData.ts` + `staticData.test.ts`
- 输入：T0 产物；输出：类型安全装载器（banners/outfits 静态 import；catalog/names 动态 import 懒加载；percentile + meta），缺失/损坏降级（名称回退 itemId、欧非区块隐藏、图鉴空态）
- 验收：降级单测通过；三项检查全绿

### T4 SQLite 迁移 + Repository

- 文件：修改 `src/main/database/connection.ts`（applyMigrations 链尾追加 `migrateResonanceTables()` + 索引语句）；新增 `src/main/database/resonance-repository.ts` + `resonance-repository.test.ts`
- 输入：§3 表结构；输出：幂等迁移 + CRUD/批量插入/分批事务（沿用 500 分片与 workerBridge 范式，SQL 全参数绑定）
- 验收：迁移重复执行幂等；干净库 CRUD 正确；UNIQUE 生效；写失败事务回滚；三项检查全绿

### T5 IPC handler + preload

- 文件：新增 `src/main/ipc/handlers/resonance-handler.ts` + `resonance-handler.test.ts`、`src/main/preload/api/resonance.ts`；修改 `src/main/app/ipc-setup.ts`（注册）、`src/main/preload.ts`（挂 `resonance` 命名空间）
- 输入：T1 schema + T4 repository；输出：§3 全部 9 通道 + 2 个进度/取消事件通道
- 验收：正常路径正确；校验失败返回 VALIDATION_ERROR 且不落库；importPreview 零写入；export 走 saveFile + PathGuard；遵循 docs/IPC_CONTRACT.md 双层 success 契约；三项检查全绿

### T6 zustand store

- 文件：新增 `src/renderer/stores/resonanceStore.ts` + `resonanceStore.test.ts`
- 输入：T5 preload API；输出：数据/加载态/选择器 + 模块级异步 action（沿用宿主「store 内纯 reducer、异步在模块级函数」范式）
- 验收：action 状态影响正确；IPC reject 分支不污染状态；三项检查全绿

### T7 页面容器

- 文件：修改 `src/renderer/pages/ResonanceRecordsPage.tsx`（占位 → 容器 + 四子页切换，保留既有 resonance.brand/title i18n key）；新增 `src/renderer/components/resonance/` 骨架
- 输入：T6 store；输出：四子页骨架（空态）
- 验收：dev 启动可进入四子页；两套主题样式正常；首次进入触发数据懒加载；三项检查全绿

### T8 共鸣记录页

- 文件：新增 `src/renderer/components/resonance/RecordsView.tsx`（+ 子组件）等
- 输入：store + process 纯函数；输出：卡池筛选 + virtuoso 记录列表（时间/物品名/品质色/该抽跨度）+ 手动补录（BaseDialog 表单）/改时间/删除（ConfirmDialog）+ 各池垫抽提示
- 验收：增删改持久化且重启仍在；非法输入被拦截并提示；三项检查全绿

### T9 我的衣橱页

- 文件：新增 `src/renderer/components/resonance/WardrobeView.tsx` 等
- 输入：store + wardrobe 纯函数 + catalog 装载；输出：五分类切换 + 套装卡片进度 + 部件批量勾选（≤5000/批）+ 拥有状态筛选 + 名称过滤 + 「从共鸣记录推断」一键
- 验收：批量更新落库重启仍在；全满/部分/变体/进化进度正确；三项检查全绿

### T10 导入数据页

- 文件：新增 `src/renderer/components/resonance/ImportExportView.tsx` 等
- 输入：store + importParse/exportPayload；输出：选文件→预览（格式/版本/新增·重复·无效计数；版本不兼容给「兼容导入/放弃」）→提交（进度+可取消）→结果；导出（内容勾选 + saveFile）；清空（危险确认）
- 验收：解析失败给可读中文错误定位行/字段且零写入；大数据量不卡 UI；导出→导入 round-trip 一致；导出路径非法前置拒绝；三项检查全绿

### T11 个人统计页

- 文件：新增 `src/renderer/components/resonance/StatsView.tsx` + SVG 图表子组件
- 输入：store + personalStats/percentile；输出：总览卡（总抽数/4★5★/平均出货/欧非百分位+档位）+ SVG 出货分布直方图 + 按卡池明细表 + 累计曲线；百分位快照标注（来源/生成时间/「静态快照不会自动更新」），缺失时隐藏欧非区块
- 验收：与纯函数口径一致；断网可用；三项检查全绿

### T12 i18n + 致谢

- 文件：修改 12 × `src/renderer/i18n/locales/*.json`（resonance.* 段 + settings.about.depDesc.gongeouNikkiTracker + depDescTodo 标记 key）、`src/renderer/pages/settings/about-sections.tsx`（runtimeDeps 追加条目）
- 输入：提示词 §11 固定文案；输出：全语言词条
- 验收：`npm run i18n:check` 绿；切换 12 语言页面无缺 key 报错；zh/en 致谢照抄、其余英文 + TODO 标记；三项检查全绿

### T13 离线断言与静态核查

- 文件：新增 `src/renderer/utils/resonance/offline-guard.test.ts`
- 输入：T2 纯函数 + T0 数据；输出：运行时打桩断言 + 静态扫描 + 反向用例
- 验收：核心流程零网络调用断言通过；扫描覆盖全部新增文件；反向用例报警

### T14 收尾

- 文件：修改 `CHANGELOG.md`（Keep a Changelog 中文版式 [Unreleased]）；本文档状态更新
- 输入：T0–T13 产物；输出：dev 启动走查四页（含断网场景）；全量 typecheck + lint + test + i18n:check 全绿
- 验收：§9 最终验收清单逐项通过

## 9. 离线范围核查清单

### 9.1 被采纳的离线模块（为何无需联网）

| 模块                           | 判断依据                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| JSON 文件导入（旧/新格式）     | 纯 `JSON.parse` + zod 结构校验（源 processJsonImport 无任何 $fetch/import http）                                      |
| 手动补录（pulls 的手动增改删） | 表单生成 EditRecord/PullRecord，纯本地                                                                                |
| 导出 JSON                      | 纯内存组装 + saveFile 对话框 + fs 写盘（源 profileDataExport 同构）                                                   |
| 保底/统计/欧非计算             | 源 processBannerPullData/computeGlobalStats/usePersonalStats/percentile 均为纯函数，入参仅静态数据与本地记录          |
| 百分位静态快照                 | data/percentile.json（2.9KB，源站社区聚合快照，含 generated_at），随包分发、UI 标注来源与截止日期、**无任何刷新逻辑** |
| 衣橱（含变体/进化/推断）       | 源 wardrobe 系列纯函数 + 静态目录数据；Pearpal 衣着推断依赖联网 API，剔除，仅保留「从共鸣记录推断」                   |
| 名称包                         | 生成期从源仓库 locales 提取，随包分发                                                                                 |

### 9.2 被剔除的联网模块（为何需要联网）

| 模块                     | 联网证据                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 游戏 API 拉取抽卡        | `app/composables/useBannerPullApi.ts` → `https://{region}-clickhouse.infoldgames.com`（cookie 换取 + 翻页拉流） |
| Pearpal API 拉取         | `app/composables/usePearpalApi.ts` → `pearpal-api.infoldgames.com` / `myl-api.nuanpaper.com`（snappy 响应）     |
| 云同步/云备份            | `useDataSync.ts` → Supabase Storage（fflate gzip 上传下载）                                                     |
| 社区统计上传与全局统计页 | `useUserBannerStats.ts` → POST /api/stats；`pages/global/*`                                                     |
| 账号与鉴权               | `useAuth.ts` / Supabase OAuth                                                                                   |
| 社区投票/排行/tierlist   | `useBannerVote.ts`（supabase.rpc）、`pages/vote.vue`、`useCommunityTierlist.ts`                                 |
| 反馈系统                 | `useFeedback.ts` → /api/feedback/*                                                                              |
| 云端图鉴补全             | `useSupabaseItems.ts` 等 → /api/items/*                                                                         |
| 云搜索（向量）           | `server/api/search/items.get.ts` → Pinecone                                                                     |
| Lookbook                 | `pages/lookbook.vue` → /api/lookbook                                                                            |
| 广告/错误上报/访问统计   | AdSenseSlot、@sentry/nuxt、Umami script                                                                         |
| CDN 图片                 | `imageProvider.ts` → ImageKit/Cloudinary/cdn.gongeo.us（本功能不展示物品立绘，无此依赖）                        |

### 9.3 边界点结论

- **边界点 A**：宿主「共鸣录」为占位板块，**不存在任何预置导入入口**；宿主全部既有导入能力（ImportWizard/import:* IPC/导入根）均为图库本地文件型且不在共鸣录板块。无需隐藏/置灰拍板；本期导入页从零新建且只含本地文件型入口。宿主「设置→工具→分享码解码」的解密 DLL 内部可能发起网络 I/O，属既有功能、不在共鸣录板块、本期不碰。
- **边界点 B**：无未决项。源项目全部 4 种导入途径的联网性均已从代码确证（见 9.1/9.2）。

### 9.4 静态快照数据说明

- 卡池数据（banners.json/outfits.json）：源仓库 master 分支，LATEST_BANNER_ID=73，游戏版本对应 catalog index `gameVersion` 字段；生成日期见 snapshot-meta.json。
- 图鉴目录（catalog/*.json）：源 `public/catalog/index.json` 标注 `gameVersion: 2.9.1`、`generatedAt: 2026-08-28`。
- 百分位快照（percentile.json）：`generated_at` 见文件内字段；来源 gongeo.us 社区聚合统计。
- **过期说明**：以上均为静态快照、不会自动更新。过期仅影响：新卡池不出现在选择列表、新物品不出现在衣橱、百分位参考值滞后。不影响已有记录的计算与展示。UI 在个人统计页与导入页明示「静态快照，不会自动更新」及版本/截止日期。

## 10. 与提示词描述的差异

1. 边界点 A 前提不成立（无预置联网入口），三选一拍板不再需要。
2. 源站 3 档案槽位不实装，v1 单数据集（表结构无 slot 列，后续扩展加列即可）。
3. 合并幂等键比源站更细（含 item_id，修复源站「同一秒多条丢失」），round-trip 兼容。
4. 源项目为 Vue/Nuxt，仅逻辑复用；其浏览器存储（IndexedDB/localStorage）全部映射 SQLite。
5. i18n 致谢的 TODO 标记以独立 JSON key 承载（JSON 不支持注释）。
6. palettes 从「剔除」改为「纳入」（衣橱共鸣色展示需要，体积可控）；sketches 剔除。
7. 生成的数据 JSON 目录加入 `.prettierignore`（沿用宿主 cloth-names.json 先例）。
