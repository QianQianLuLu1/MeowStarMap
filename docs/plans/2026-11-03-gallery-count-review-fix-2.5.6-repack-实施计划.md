# 图库计数二轮复查：四处缺陷修复 + 六道闸门全绿 + 2.5.6 重打包

## 0. 第 0 步（批准后第一件事）

本文件即第 0 步的产物：按仓库既有协议先落仓、独立提交一笔 `docs(plans)`，之后才动代码。上一轮同类计划见 `docs/plans/2026-11-03-fix-media-recognized-count-500-limit-实施计划.md`（本轮复查对象正是它那 7 笔提交）。

## 1. Context（为什么做这件事）

**审查范围不是「未提交代码」**：开工时 `git status --porcelain` 为空，工作树干净。最后一次安装包出在 2026-11-03 18:30（`release/MeowStarMap-Setup-2.5.6.exe`，184,744,586 B），此后又落了 7 笔提交（`4ab298a..HEAD`），全部属于同一轮修复——图库「图片/视频 识别数量」被显示成最多 500。所以本轮的判据对象是 `git log 4ab298a..HEAD`，以及**包内字节与源码的差**。本地 `main` 领先 `origin/main` 73 笔，用户裁决**只提交、不推送**。

**版本号是零编辑**：`package.json` 的 `version` 本就是 `2.5.6`，`CHANGELOG.md` 的 `## [2.5.6] - 2026-11-01` 唯一且不重复（由 `scripts/__tests__/check-changelog-release.test.ts` 的三条真实文件契约钉着）。按「目标版本已是当前值 ⇒ 如实报零编辑，不为凑任务造改动」的口径交付。

### 复查结论（5 条，用户已裁决「全部四处代码缺陷都修」）

| #   | 缺陷与证据位置                                                                                                                                                                                                                                                                                            | 判定                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | `CHANGELOG.md` 的 `[Unreleased]` 仍挂着 500 计数条目（24–27 行）⇒ 开工实跑 `npx tsx scripts/check-changelog-release.ts` 打回「✖ [Unreleased] 含 1 条待发布条目 … 变更日志未收口，禁止打包」。该脚本在 `npm run pre-dist-check` 链内，即 `dist:win` 的硬前置                                               | **阻断打包**，必须收口 |
| 2   | `fetchMediaFromDatabase` 的深度取数循环（`mediaStore.ts` 566–649）只在**循环结束后**写 `mediaCursor`/`hasMoreMedia`，全程不置任何互斥标志；`loadNextMediaPage:746` 的守卫只看 `loadingMore`/`hasMoreMedia` ⇒ 用户在整刷在途时触底，会拿**刷新前的旧游标**并发写游标，两条写者交错后下一次触底**静默跳行** | 真实缺陷（走 TDD）     |
| 3   | `resolveListTotal` 可能回 `media_count` **缓存**值（`getMediaCountCache`，24h TTL + stale 位，`media-update.ts:130` 异步重建），而新加的 `countMediaByType` 是**实时** `GROUP BY`；两者同一次响应返回 ⇒ 状态栏能渲染出「共 1200 个文件（图片 1400 · 视频 50）」这种算术上不可能的数                       | 真实缺陷（走 TDD）     |
| 4   | `useGallerySummaryCounts.ts` 头注声称「AppShell 状态栏、Sidebar『图片 / 视频』、GalleryPage 统计条共用」，实测消费方只有 `AppShell.tsx:67` 与 `Sidebar.tsx:153` 两处；`GalleryPage.tsx` 的 `.length` 全是空态判定/索引数学/放映开关，没有对用户展示的数量                                                 | 注释失真               |
| 5   | `useRefreshMedia.ts` 的重试循环把「被更新的一轮取代」（`depthRefreshSeq` 顶前 ⇒ `fetchMediaFromDatabase` 弃权返回 `null`，这本身是**成功**语义）与「真的取数失败」混为一谈，重试耗尽会弹虚假的 `toast.mediaLoadFailed`                                                                                    | 轻微                   |

### 已核过并确认合规、本轮不改的规范面

`docs/IPC_CONTRACT.md` §2.10 已登记 `typeCounts`（可选、同 WHERE、仅首页、`image + video` 可 `< total`）且与 `media-handler.ts` 的返回塑形一致；`media-handler.ts` 顶部的 `// @core-change:` 恰好一条、落在前 5 行、是**替换**旧原因而非累加；本轮触及的 `.tsx` 未新增任何 `#rrggbb`/`rgb()`/`hsl()` 硬编码色值；未引入 `process.platform` 开关决定路径语义；新增行引用的 `mediaStore.log.fetchError` 在 12 个语包齐备（未新增键，`npm run i18n:guard` 无新增义务）。

### 已排除（不是元凶，别去动）

- `setMediaFiles` 只写数组，**不**复位 `hasMoreMedia` 与三个计数字段——复位块属于 `setSource`。开工初期据此怀疑「调用方把服务端计数抹成 null」，读码后判为**不成立**。
- `media-handler.ts:184` 的 `pageSize: z.number().int().positive().max(500).optional()`：它是真实入口闸门，该修的是越界传参而不是拆闸门。深度循环传的是 `Math.min(targetDepth - files.length, MEDIA_PAGE_SIZE)`，循环条件保证 `files.length < targetDepth` ⇒ 恒 ≥ 1，天然在 `positive()` 域内。
- `SCAN_BATCH_SIZE`、`SQL_IN_CHUNK_SIZE`、各处 500ms 进度节流、NikkiSync 协议侧 `MAX_PAGE_LIMIT`：与本页大小 500 同数不同义。

## 2. 依赖声明

**零新增依赖**，不改 `package.json` 的 dependencies/devDependencies，不引入锁文件版本变化。

与依赖有关的一条既有事实必须写在明面：**`npm install` / `npm update` 会按锁文件收敛 `node_modules`，静默删掉 `npm run link:nikkisync` 建好的 4 条 `@nikkisync/*` junction**（识别信号是输出里的 `removed 4 packages`——那 4 个「包」就是 junction，不是真依赖）。后果不报错而是**静默降级**：`build.files` 的对象式 `from/to` 拷不到东西 ⇒ 安装包缺整个内嵌同步运行时（体积掉约 608,615 B）。所以本轮任何一次 `npm install` 之后必须紧跟 `npm run link:nikkisync` + `npm run link:nikkisync:check` 才允许进构建，且出包前要再校验一次。

## 3. 启动与运行说明

本轮不启动 dev server（无 UI 新增，验证靠单测 + 打包产物）。真实存在的命令（逐条核对过 `package.json`，不存在 `install` 脚本、`npm install` 走 npm 内建生命周期）：

```bash
npm install                 # 跑完必须立刻重新 link（见 §2）
npm run build               # clean && electron-vite build && 写 dist/main/package.json
npm test                    # vitest run（node project 收 src/ + scripts/ + e2e/ 的 *.test.ts）
npm run typecheck           # tsc -b && tsc -p tsconfig.scripts.json
npm run typecheck:e2e       # tsc --noEmit -p e2e
npm run lint                # eslint .
npm run i18n:guard          # tsx scripts/i18n/guard.ts
npm run test:ci-linux       # vitest run --config vitest.ci-linux.config.ts（只读诊断）
npm run e2e:smoke           # playwright test --config e2e/playwright.config.ts --grep-invert @perf
npm run dist:win            # build:recycle-helper && build && pre-dist-check && electron-builder --win && verify:dist
npm run verify:dist         # tsx scripts/pre-dist-check.ts --verify-asar
npm run verify              # 只读增量闸门（typecheck + eslint 无 --fix + core-gate + prettier --check + 相关单测）
```

**`e2e:smoke` 的次序冲突（必须在计划里解决，否则会被当成「跳过了一项」）**：`e2e/helpers.ts` 的 `findUnpackedExe()` 认 `release/win-unpacked/*.exe`，所以它是**打包之后**的闸门。用户点名的六项按真实次序分两段：`npm install` / `build` / `test` / `typecheck` / `test:ci-linux` 在出包前跑全绿；`e2e:smoke` 与 `verify:dist` 在新包落地后跑。标准名被历史残壳占住时 `e2e:smoke` 只会 throw「未找到 `release/win-unpacked/*.exe`」——那是**前提不成立**，不是跳过，要这样记账。

## 4. 错误处理

- **#2 的收尾必须用 `finally`，且只有「本轮仍在位」才清屏障**：循环里的提前 `return null` 都是「代次被后来者顶掉」，此时**不能**替新一轮清屏障（否则屏障被旧轮误放、竞态原地复活）。判据统一为 `myRefresh === depthRefreshSeq`；循环之前的失败出口与 `catch` 侧代次仍在本轮，必须清除，否则一次取数失败就把触底永久打死。
- **#3 的兜底是「夹取而非重算」**：`total >= image + video` 是恒成立的不变式（`total` 按同一 WHERE 数全部 `file_type`，含 `live_photo` 等历史第三种取值；`typeCounts` 只回填 image/video）。夹取即证伪缓存过期，**不新增第二次 COUNT**——`media_count` 缓存存在的理由正是省掉默认视图的 O(n) 扫描。
- **#5 的兜底是「宁少弹不错弹」**：仅当代次前进量**超过自己这几轮调用所能解释的量**时判定为被取代、不弹 toast；`fetchMediaFromRuntime`（nikkisync 源）不 bump 代次 ⇒ 真实失败照常弹，行为不变。
- **打包失败分类**：`electron-builder` 若死在 `EPERM rename('release\win-unpacked.tmp' -> 'release\win-unpacked')` 或 `EBUSY unlink`（本机历史上被腾讯电脑管家 `QQPCRTP.exe` 对新解压树主动加锁），走 `electronDist` 旁路。旁路**跳过了 `dist:win` 链里的 `pre-dist-check` 与 `verify:dist` 两步**，必须手工补跑，不得拿「出包成功」代替闸门通过。搬运用 `cp -rf` 而非 `mv`（被锁文件只挡 rename/unlink，读取与就地覆盖允许），并当场用 `sha256sum` 证两侧 `app.asar` 全等。
- 跨进程错误仍走 `AppError` 家族；本轮不新增错误类、不改 `IpcResponse`/`IpcError` 结构。

## 5. 参数校验

- 不放宽任何既有闸门（见 §1「已排除」首条对 zod 的定性）。
- `MAX_DEPTH_PAGES = 200`（200 × 500 = 10 万条）给死循环硬上限；触顶时记 `console.error` 并保住已取数据，`hasMoreMedia` 留 `true`，不谎报已到齐。
- `countMediaByType` 与 `countMedia` 共用**同一个** `whereClause` + `whereParams`，口径与列表严格一致，不引入第二处 WHERE 拼装点。
- `typeCounts` 为**可选**字段、仅首页返回：旧渲染层拿不到即回落数组长度 ⇒ 向后兼容，无需迁移期双写。

## 6. 实施节点

> **提交拆分纪律**：`.husky/pre-commit` 的 lint-staged 对 `src/**/*.{ts,tsx}` 键会跑匹配套件 ⇒ **刻意留红的 src 提交会被自家闸门拒**（Step 1 FAILED）。所以 #2/#3/#5 的「红测试 + 修复」各自合并成一笔提交、把修复前的红读数写进 commit body 留痕；**禁止 `--no-verify`**。`docs/` 与 `CHANGELOG.md` 不触发 `test:precommit`，独立成笔。`scripts/**` 不触发，那里的红/绿拆分照做。

### Node 1 — 变更日志收口（解阻断）

- **涉及文件**：`CHANGELOG.md`
- **输入/输出**：`[Unreleased]` 的 500 计数条目（含续行）**逐字整体搬**进 `## [2.5.6] - 2026-11-01` → `### Fixed | 修复`，按 2.5.6 节内既有先例补「（2026-11-03，自 `[Unreleased]` 并入）」；`[Unreleased]` 标题与说明行**保留**（契约测试要求该板块存在），文末 `[Unreleased]: …/compare/v2.5.6...HEAD` 不动（最新节仍是 2.5.6，该断言才成立）。
- **验收标准**：`npx tsx scripts/check-changelog-release.ts` 打 `✔ [Unreleased] 已收口（无待发布条目）`；`npx vitest run scripts/__tests__/check-changelog-release.test.ts` 全绿。
- **提交**：`docs(changelog): 将 500 计数修复并入 2.5.6 节以放行打包闸门`

### Node 2 — #2 深度取数与触底续页互斥（红→绿，一笔提交）

- **涉及文件**：`src/renderer/stores/mediaStore.ts`、`src/renderer/stores/mediaStore.test.ts`
- **输入/输出**：新增**模块级**屏障标志（与 `depthRefreshSeq` 同处，刻意**不进 Zustand state**——`loadingMore` 是用户可见的，`VirtualImageGrid.tsx:352` 据此渲染「加载更多…」脚注，借它会改变渲染表现）。`fetchMediaFromDatabase` 进入本地分支即置位，`finally` 里仅当 `myRefresh === depthRefreshSeq` 才清除；`loadNextMediaPage` 的守卫加一条该标志。
- **基础测试用例**（三类）：边界——库 1200 条、目标深度 600，循环在途时触底**不得**多发一次 `media:list`（**修复前必红**）；正常——循环结束后触底照常推进游标与追加；异常——中途某页失败仍保住已取数据、`hasMoreMedia` 为 `true`、游标停在最后一个成功页的 `nextCursor`（既有契约，不得回归成红），并显式验证屏障已释放。
- **验收标准**：`npx vitest run src/renderer/stores/mediaStore.test.ts` 全绿；红读数写进 commit body。
- **提交**：`fix(store): 深度取数加互斥屏障，杜绝触底续页与整刷并发抢写游标`
- **如实记账的残留**：进入循环时若已有一次触底续页在途，本轮不抢占它（沿用其自身 `finally` 收尾）；屏障只保证「刷新起来之后不再让触底钻进来」。

### Node 3 — #3 `total >= image + video` 不变式（红→绿，一笔提交）

- **涉及文件**：`src/main/database/media-repository.ts`、`src/main/database/media-repository.test.ts`
- **输入/输出**：新增私有 `clampTotalToTypeCounts(total, typeCounts)`（返回 `Math.max(total, image + video)`），在 keyset 首页与 offset 首页两个返回口、`countMediaByType` 之后套到 `result.total`。**夹取点选仓储**而非 handler/渲染层的理由：不变式必须对「渲染层实际消费的那份数」成立，而唯一同时握着这两个数的位置就是这里；放 handler 要在两条分支重复、且漏掉回收站等其他 `listMedia` 消费方；放渲染层等于让它编造真值，且 `AppShell`/`Sidebar` 读的是三个独立 store 字段。
- **基础测试用例**：边界——`setMediaCountCache(1)` 造缓存命中 + 库里 2 image 1 video ⇒ 现返回 `total: 1` 对 `typeCounts: { image: 2, video: 1 }`，断言 `total >= image + video` **必红**，夹取后为 3 转绿；正常——无缓存时两者同源、断言本就成立；异常——第三种 `file_type` 使 `image + video < total` 的**合法**形态必须保持原值，证明没把 `>` 也夹成 `=`。
- **验收标准**：`npx vitest run src/main/database/media-repository.test.ts scripts/__tests__/media-page-limit-guard.test.ts` 全绿。
- **提交**：`fix(database): 缓存总数与实时分类型计数冲突时按不变式夹取`

### Node 4 — #4 注释订正 + #5 虚假 toast（一笔提交，#5 先红）

- **涉及文件**：`src/renderer/hooks/useGallerySummaryCounts.ts`、`src/renderer/stores/mediaStore.ts`、`src/renderer/hooks/useRefreshMedia.ts`、`src/renderer/hooks/useRefreshMedia.test.ts`
- **输入/输出**：头注消费方改为「AppShell 状态栏与 Sidebar『图片 / 视频』两处」；`mediaStore.ts` 导出只读访问器 `getMediaRefreshGeneration()`；`useRefreshMedia` 首 call 前记 `genBefore`，`null` 分支仅在 `getMediaRefreshGeneration() <= genBefore + 自己的调用轮数` 时才 `onError?.(...)`。不新增 i18n 键（复用 `gallery.media.log.refreshNullFailed`）。
- **基础测试用例**：异常——代次被第三方顶前 ⇒ 不弹 toast（**修复前必红**）；正常——只有 own 轮数前进 ⇒ 照弹（互补用例，必须始终绿，防「把真失败改哑」）；边界——nikkisync 源代次恒不前进 ⇒ 真失败仍弹。
- **验收标准**：`npx vitest run src/renderer/hooks/useRefreshMedia.test.ts src/renderer/hooks/useGallerySummaryCounts.test.ts src/renderer/components/layout/Sidebar.test.tsx` 全绿。
- **提交**：`fix(renderer): 整刷被取代不再冒充加载失败，并订正计数 Hook 的消费方注释`

### Node 5 — 六道闸门 + 全局回归（不提交）

按序 `npm run lint` → `npm run typecheck` → `npm run typecheck:e2e` → `npm run i18n:guard` → `npm test` → `npm run test:ci-linux` → `npm run verify`。基线：开工实测受影响 6 套件 **294 例全绿 / 4.09s**；全量口径约 437 文件 / 6700+ 通过，**且基线随 @nikkisync 链接在否漂移**（链接缺席时 `*.linked` 套件会整批跳过），比对失败数前先确认 `npm run link:nikkisync:check`。
**一票否决**：任一红灯必须先修再进下一节点；不得用 `it.skip`、放宽断言、调阈值凑绿。

### Node 6 — 归档 + 重新出包

`mkdir _safe_backup_20261103-<hhmm>` 后把现役 `MeowStarMap-Setup-2.5.6.exe` / `.blockmap` / `latest.yml` / `win-unpacked` 整体移入（该目录被 `.gitignore` 覆盖；安装包在 git 里没有任何副本，属不可再生孤本，先留底再覆盖）。出包前**立刻**校验链接 → `npm run build` → `npx tsx scripts/check-changelog-release.ts` → `npm run pre-dist-check` → 首选 `npm run dist:win`，死锁则走 §4 的旁路并手工补跑两步。
**验收标准**：`release/MeowStarMap-Setup-2.5.6.exe` 重新存在；`npm run verify:dist` **不带参数**全绿，且禁串步回显的 asar 路径是 `release\win-unpacked\resources\app.asar` 新树。

### Node 7 — 包内新鲜度取证 + e2e + 收尾提交

用 `@electron/asar` 的 `listPackage` + `extractFile` 从新包取 JS（**条目名是反斜杠带前导分隔符，只能去前导符、绝不能把 `\` 换成 `/`**，否则必报 `was not found in this archive`）。三条判据：① 主进程产物出现新的夹取表达式、归档包同位置 0 命中；② 渲染层 chunk 里屏障标志的新增计数相对归档包为正；③ `latest.yml` 的 `size` 与 `sha512` **两轴**都不同于归档的 184,744,586 B / `CZG9nDg9…`（同大小同哈希就是只换 `releaseDate` 的空重跑）。随后 `npm run e2e:smoke`（`[e2e] executable:` 必须打印 `release/win-unpacked/喵星图.exe` 才算验到新树）。
**提交**：`docs(release): 登记本轮四处复查修复入 2.5.6 变更日志` + `docs(plans): 回写四处修复、六道闸门与 2.5.6 重打包执行读数`。每笔提交后 `git status --porcelain` 复核钩子改写残余。**不执行 `git push`。**

## 7. Verification（收尾硬门）

- 六道闸门每项有**实测**读数；#2/#3/#5 三组回归用例各有「修复前红 → 修复后绿」两次对照，红文本原样入 commit body。
- 变异抽查做两次：M1 还原被修的实现 ⇒ 证缺陷例有牙；M2 撤掉一个调用点 ⇒ 证新增夹具载荷真在被判据覆盖。两次之后都用 `sha256sum` 证明恢复是逐字节还原。
- `CHANGELOG.md` 的 `[Unreleased]` 无列表项且 `[2.5.6]` 节唯一；新包内字节含本轮修复。
- `git log` 按节点拆笔、无空提交、无 `--no-verify` 痕迹。

## 8. 风险与回滚

1. **覆盖今日 18:30 的包**：孤本先移入 `_safe_backup_*/`，回滚 = 原样移回。
2. **旁路产物等价性**：`signAndEditExecutable: false` 是仓内既有配置（溯 `a89d1e4`），不是旁路引入的差异，别把它读成「旁路导致 exe 缺图标」；等价性靠 `app.asar` 逐文件 `sha256` 与包内取数证。
3. **夹取掩盖真实计数**：只可能抬高 `total`、不可能压低；`total > image + video` 的合法形态由既有第三种 `file_type` 用例钉住。
4. **屏障漏清 ⇒ 触底永久失效**：`finally` + 代次守卫覆盖全部早退路径，并由异常用例显式验证释放。
5. **`findAsarUnpacked` 字典序假绿**：它取 `release/**` readdir 首命中。清场后残壳被半清会物理堵死该路径，但**代码侧无显式选择参数这一弱点仍在**，不因环境干净就从遗留清单里划掉。
6. **`tsc -b` 的 emit 落点**必须留在 `.cache/tsmain`，不得指回 `dist/main`——否则覆写 electron-vite 的 `preload.js`，`sandbox: true` 的 preload 无法 require 兄弟模块，e2e 以 `window.electronAPI` undefined 假失败。

## 9. 本轮明确不做

- 不改 `media:list` 的 `pageSize` zod 上界（闸门本身是对的）。
- 不动 `favorites`/`size` 两类只能按已加载数组算的口径（`media:list` 的 WHERE 不含 `is_favorite`，服务端无等价真值；拉齐后即收敛）。
- 不重构 `useGallerySummaryCounts` 的判据（「`hasMoreMedia` 为真且服务端计数到位才用真值」是本轮刻意保持单一可判定的唯一一条）。
- 不推送远端、不补 `v2.5.6` tag、不改 `.gitignore`/CI 配置。

## 10. 执行读数（本轮实测，2026-11-03）

_待各节点实跑后回写。_
