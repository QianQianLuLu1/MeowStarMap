# 图库计数遗留轮：五项逐项处置 + 一次实测取舍 + 2.5.6 重打包

## 0. 第 0 步（批准后第一件事）

本文件即第 0 步的产物：按仓库既有协议先落仓、独立提交一笔 `docs(plans)`，之后才动代码。上一轮同类计划见 `docs/plans/2026-11-03-gallery-count-review-fix-2.5.6-repack-实施计划.md`，本轮处置对象正是它 §10「属实但本轮不修 / 未做（如实记账）」里与代码、工具链相关的 **1–5 条**；该节第 6 条是「未推送远端、未补 `v2.5.6` tag」，属流程状态而非工程账，**不在本轮范围，不因数到它而扩边界**。

## 1. Context（为什么做这件事）

那五条在上一轮被判为**事实成立**，但因最小化改动原则**刻意没修**。本轮不是「把五条一律修掉」，而是**逐项给出处置结论**：1 / 2 / 5 是可控缺陷，按 TDD 红-绿修；3 / 4 是同一处取舍的两面，**必须先拿实测读数再决定改不改**；决定不修的按仓库口径登记进 `docs/debt-registry.json` 与 `docs/技术债清单.md` §21。项 1 / 2 改的是渲染层运行时代码 ⇒ 本轮结尾重新出包，让 `release/` 与 HEAD 一致。

开工时 `git status --porcelain` 为空，HEAD = `a9d0dce`，本地 `main` 领先 `origin/main` 80 笔（以 `git rev-list --count origin/main..HEAD` 为准，不在本文重复记账）。用户裁决仍是**只提交、不推送、不补 tag**。

### 三条前提订正（逐字核到代码，与任务书原述不同）

| #    | 原述                                      | 核实结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项 3 | total 与 typeCounts 来自两个新鲜度源      | **比原述窄**。`isDefaultView` 要求 conditions **恰好 2 条**，而 HQ 路径条件使图库视图脱离默认状态 —— 仓储注释自己就写着「该条件使视图脱离默认状态，media_count 缓存不命中（走实时 COUNT）」（`media-repository.ts:627`、判据在 `:660-663`）⇒ **图库首屏的 `total` 与 `typeCounts` 本就是同一瞬间、同一 WHERE 的两次实时查询，已经同源**；混源只剩「非图库 + profile=all + showDuplicates=true」这一类窄路径，且已被上一轮的不变式夹取覆盖。「彻底同源」因此不是全量架构问题 |
| 项 4 | 每个首页都做一次 GROUP BY，且从未测过基线 | 前半为真（`:1139` 的 `cursor === null \|\| cursor.sortValue === undefined` 闸门 + `:1182` 的 `page === 0`），后半要**改判原因**：现有基线**恰好绕过这两步**。`e2e/perf.e2e.ts` 的 P4/P5 传 `{ page: 1, pageSize: 100 }` ⇒ 走 offset 分支且 `page !== 0` ⇒ GROUP BY 恒不执行；又不传 `galleryHighQualityOnly` ⇒ `isDefaultView` 为真、预热那次已重建缓存 ⇒ 实时 COUNT 也不执行。**直接跑现成工装会拿到「没有这个开销」的假读数**，必须先新造测量路径                         |
| 项 2 | 被取代路径仍打印「加载失败」的 dev 日志   | **比原述更吵**。`useRefreshMedia.ts:43` 的 `while (!result && attempt < MAX_RETRIES)` 不看 `superseded` ⇒ 被取代路径不只打 3 条误导 warn，还会**再发 3 次深度整刷**（每次 `++depthRefreshSeq`，每次是 `limit = max(500, 已加载条数)` 的取数）。已核实这**不是正确性缺陷**（最后一轮若成功即不弹 toast），是冗余工作量 ⇒ 用户裁决：本轮只分叉措辞，重试冗余登记为新债                                                                                                        |

助力一条（项 5）：修法与仓内既有意图一致。`pre-dist-check.ts:403-409` 的注释原文写着「findAsarUnpacked 那套『取 readdir 首个命中』的判据会随残留目录漂移，这里不复用它」—— 禁串侧早已选定 `resolveVerifyAsarTarget` 为唯一选择器，只是没把 unpacked 侧收敛过来。

### 已核实的约束（不是推测，逐条给出处）

- **`MediaRepository` 不能从 plain Node 脚本导入**：`media-repository.ts:8` → `../utils/logger` → `logger.ts:5` `import { app } from 'electron'`；`connection.ts:5` 同理。⇒ 测量装置不能直接 `import` 仓储。
- **单测的 MockDatabase 给不出耗时读数**：它是自研内存 SQL 引擎，`:1702` 注释自陈不做排序/索引 ⇒ 只能证语义正确。
- **原生 better-sqlite3 是 Electron ABI**，普通 Node 里 dlopen 报 `NODE_MODULE_VERSION` 不匹配（`e2e/perf-real.e2e.ts:344-345` 记录的是同一理由，它因此改用 `node:sqlite`）。`node:sqlite` 在仓内已有纯 Node 先例：`scripts/diagnose-duplicate-false-positive.ts:18`。
- **`normalizeRootPath` 可直接从真实源码 import**：`import-root-repository.ts` 只有两条 `import type`（`:1`/`:2`），无 electron 运行时依赖，函数在 `:25` 导出 ⇒ spike 少一处复制漂移。
- **中文模板字面量不会触 i18n 护栏**：`eslint.config.js:10-27` 的 `i18nGuardSelectors` 只有 `Literal[value=/[\u4e00-\u9fa5]/]` 与 `JSXText`，模板串在 ESTree 里是 `TemplateLiteral`；`console.warn` 也在放行侧（只禁 log/info/debug/trace/table/dir/dirxml）。存量白名单块已于 2026-08-23 清空（`eslint.config.js:461-464`）⇒「不得新增 i18n key」这条确实守得住（新增键会被 `checkKeyAlignment` 要求 11 个语包齐备）。
- **`.cache/**` 同时是 lint 忽略项与 markdown 的产物前缀**：`eslint.config.js:521` 的 ignores、`scripts/check-md-links.ts:85` 的 `ARTIFACT_PREFIXES` ⇒ spike 落 `.cache/` 不入库、不进 lint，计划文档引用它也不会把 `docs:links` 弄红。
- **本轮五处改动都不受核心路径授权闸门约束**：`scripts/core-path-gate.ts:37-42` 的 `PROTECTED_GLOBS` 只含 preload/api、ipc/handlers、services、shared/errors ⇒ 不需要 `@core-change` 注释。
- **性能基线锚点**：`e2e/perf-baseline.json` 的 `datasetImages: 1500`、`media-list-page500` dev 中位 `10.3ms`、`hardRules.*.maxMs = 1000`。
- **`file_type` 有单列索引 `idx_media_files_type`，但没有 `(is_deleted, file_type)` 组合索引**；`idx_media_files_profile_stats (account_uid, is_deleted, file_type)` 先导列是 `account_uid`，选 `all` 时用不上。

### 已排除（不是元凶，别去动）

- `loadNextAssetPage`（`mediaStore.ts:457-475`）：nikkisync 源的游标续页，与本地 keyset 游标不同构，且 nikkisync 分支在 `:774` 早退、代次恒不 bump ⇒ **本轮一行不动**。上一轮变异抽查用全局 `sed` 时，正是它里面字面量相同的另一条守卫被连带命中，靠 `sha256sum -c` 的 WARNING 才拦住。
- `media:list` 的 `pageSize` zod 上界（`max(500)`）：上一轮已定性为真实入口闸门，本轮不动。
- `clampTotalToTypeCounts` 的夹取本身：它是对的显示层不变式，本轮不动它，只动它的**上游是否还需要两个源**这个判据 —— 而那要先有读数。

## 2. 依赖声明

**零新增依赖**，不改 `package.json` 的 dependencies/devDependencies，不引入锁文件版本变化。测量用 `node:sqlite`（Node 24 内建，仓内已有先例），不装 duckdb、不装 sqlite3、不引 benchmark 库。

一条既有事实必须写在明面：**`npm install` / `npm update` 会静默删掉 `npm run link:nikkisync` 建好的 4 条 `@nikkisync/*` junction**（识别信号是输出里的 `removed 4 packages`）。后果是静默降级而非报错 —— 安装包缺整个内嵌同步运行时（体积掉约 608,615 B）。所以本轮任何一次 `npm install` 之后必须紧跟 `npm run link:nikkisync` + `npm run link:nikkisync:check` 才允许进构建，出包前再校验一次。

## 3. 启动与运行说明

本轮不启动 dev server（无 UI 新增，验证靠单测 + 打包产物）。唯一一次「起应用」是 Node 8 出包后的包内取证与首屏手测。真实存在的命令：

```bash
npm run build               # clean && electron-vite build && 写 dist/main/package.json
npm test                    # vitest run（node project 收 src/ + scripts/ + e2e/ 的 *.test.ts）
npm run typecheck           # tsc -b && tsc -p tsconfig.scripts.json
npm run typecheck:e2e       # tsc --noEmit -p e2e
npm run lint                # eslint .
npm run i18n:guard          # tsx scripts/i18n/guard.ts
npm run test:ci-linux       # vitest run --config vitest.ci-linux.config.ts（只读诊断）
npm run docs:links          # tsx scripts/check-md-links.ts（被跟踪 markdown 的死引用守护）
npm run pre-dist-check      # 打包前校验
npm run dist:win            # build:recycle-helper && build && pre-dist-check && electron-builder --win && verify:dist
npm run verify:dist         # tsx scripts/pre-dist-check.ts --verify-asar
npm run e2e:smoke           # playwright test --config e2e/playwright.config.ts --grep-invert @perf
npm run verify              # 只读增量闸门
npx tsx scripts/perf-test/emit-perf-readings.ts   # 读数注解（本轮只读，不改基线）
```

**测量装置的调用形态**（Node 2，跑完即删，不入库）：

```bash
npx tsx .cache/spike-media-count-cost/spike.ts
# 克隆源：本机 userData 下的 database/meow_star_map.db 三件套（.db / -wal / -shm）
# 装置只读克隆件，绝不以可写方式打开用户真实库
```

**`e2e:smoke` 的次序冲突（必须在计划里说明，否则会被当成「跳过了一项」）**：`e2e/helpers.ts` 的 `findUnpackedExe()` 认 `release/win-unpacked/*.exe`，所以它是**打包之后**的闸门。出包前跑它只会 throw「未找到」—— 那是**前提不成立**，不是跳过，要按这个真实次序记账。

## 4. 错误处理

- **项 1 的收尾纪律**：代次锚点在 `try` **之前**领（对齐 `:559` 的既有写法），`finally` 里 `loadingMore: false` **必须保持无条件复位** —— 一次弃权不得留下任何跨轮状态，否则一次迟到的页就把触底永久打死（与上一轮「屏障漏清 ⇒ 触底永久失效」同源）。
- **项 1 守卫的位置是论证出来的**：放在取数失败出口之后、`dedupeAgainst` + `addMediaFiles` **之前**。四类交错里 —— ① 无整刷参与 ⇒ 放行（不误伤正常触底）；② 整刷已完成并写完游标 ⇒ 弃权（正是要闭的残留本体）；③ 整刷弃权返回 null 没写 store ⇒ 白弃一页，代价有界（`hasMoreMedia` 仍 true，用户再触底即恢复）；④ 整刷未完成而本页先落地 ⇒ 弃权无害。**若把守卫只放在写游标之前而让追加先跑，就会留下「数组是旧快照的追加、游标是新轮的」错位，正是本轮在修的那类缺陷。**
- **项 2 的分叉不动控制流**：`superseded` 在 warn 处已是最近一次取数的结果，三元只换文本；`while` 条件、`else if (!superseded)` 分支、i18n 键全部不动。
- **项 5 保持 fail-closed，绝不回退扫描**：`asarPath` 为 null 或 `app.asar.unpacked` 不存在 ⇒ 直接 `fail` 并 return，沿用 `:639` 的既有级别；`*.tmp` 目录段的拒绝由 `resolveVerifyAsarTarget` 提供，派生函数继承之。既有那条「宁可红也不在陈旧树上假绿」的取向（`pre-dist-check.test.ts:380`）由 T3/T4 在解包侧复制。
- **项 3+4 的错误处理就是它的核心纪律**：**没有读数就不许动 `media-repository.ts` 的缓存策略**。spike 自带字面量自检 —— 若复制的 SQL 与源文件不再逐字相同，脚本 `exit 1` 并打印「spike 读数作废」，防止悄悄跑在过时 SQL 上产出假读数。
- 跨进程错误仍走 `AppError` 家族；本轮不新增错误类、不改 `IpcResponse`/`IpcError` 结构、不改任何 IPC 通道名 ⇒ `docs/IPC_CONTRACT.md` 无更新义务。

## 5. 参数校验

- 不放宽任何既有闸门。`deriveUnpackedTarget` 的入参 `asarPath: string | null` 与探针 `exists: (p: string) => boolean` 都是纯值注入，不做磁盘副作用，形状对齐同文件既有的 `missingPackedCapabilityArtifacts`。
- `resolve(index = 0)` 的夹具扩参必须**默认等价于既有 `queue.shift()`**，越界返回 `false`（守住既有「无请求在等时返回 false」契约），既有三处调用一行不改。
- spike 的两个臂（带 `accountUid` / 选 `all`）都要跑，因为后者正是 `idx_media_files_profile_stats` 用不上的那个场景；只跑一个臂等于挑读数好看的那条。

## 6. 实施节点

> **提交拆分纪律**：`.husky/pre-commit` 的 lint-staged 对 `src/**/*.{ts,tsx}` 键会跑匹配套件 ⇒ **刻意留红的 src 提交会被自家闸门拒**（Step 1 FAILED）。所以项 1 / 项 2 的「红测试 + 修复」各自合并成一笔、把修复前的红读数写进 commit body 留痕；**禁止 `--no-verify`**。`scripts/**` 与 `docs/**`、`CHANGELOG.md` 不触发 `test:precommit`，纪律上可拆两笔 —— 但 `tsconfig.scripts.json` 的 include 是 `scripts/**/*.ts`，只提红测试会让中间那笔的 `npm run typecheck` 断在 TS2305 ⇒ **项 5 也合并成一笔**，二分可用性优先于拆笔自由。

### Node 0 — 计划文档落仓

- **涉及文件**：本文件
- **输入/输出**：先落仓、先 `git add`。`docs/plans/*.md` 被 `scripts/check-md-links.ts` 按 `git ls-files` 判存在（`:25` 的关键取舍、`:340-347` 的取数方式），未入索引即被判死引用 ⇒ 由 `scripts/__tests__/check-md-links.test.ts` 的「`runCheck()` 的死引用数为 0」打回。
- **验收标准**：`git ls-files docs/plans` 能列出本文件；`npm run docs:links` 退出码 0。
- **提交**：`docs(plans): 图库计数遗留五项处置与 2.5.6 重打包实施计划`

### Node 1 — 项 5：`verify:dist` 的解包根改为从 asarPath 派生

- **涉及文件**：`scripts/pre-dist-check.ts`、`scripts/__tests__/pre-dist-check.test.ts`
- **输入/输出**：
  1. 在 `resolveVerifyAsarTarget` 之后新增**导出纯函数** `deriveUnpackedTarget(asarPath, exists)` → `{ unpackedRoot, appOutDir, reason }`。判据**只有一条**：`candidate = asarPath + '.unpacked'`；`asarPath === null` ⇒ 全 null 且 reason 指回 `resolveVerifyAsarTarget`；`!exists(candidate)` ⇒ 全 null 且 reason 带 candidate 全路径与「请先打包 / 传 --asar=<path>」；命中 ⇒ `appOutDir = dirname(dirname(candidate))`（仍是上两级）。**探针必须恰好被调用一次** —— 这条由用例断言，是「不再扫目录」的可证判据。
  2. `findAsarUnpacked`（`:505-529`）整函数删除。
  3. `checkUnpackedNativeBinaries`（`:635-641`）改为先 `resolveVerifyAsarTarget(process.argv, releaseDir)` 再 `deriveUnpackedTarget`；`:672` 的 `appOutDir` 就地 dirname 套 dirname 改为消费派生结果。
  4. `:403-409` 的注释**必须改写** —— 它现在指着一个已被删除的函数名，留着就是谎。
- **测试用例**（新 `describe` 紧跟 `resolveVerifyAsarTarget` 那组之后；默认用 `exists` 探针保持纯，涉及真实树布局的两条沿用该文件既有的 `mkdtempSync` + `finally rmSync` 形态）：
  - T1「解包根只从已解析 app.asar 派生，字典序更靠前的陈旧诱饵树不得被选中」：mkdtemp 造 `release/win-unpacked/resources/{app.asar,app.asar.unpacked/…}` **加**一棵名排在它之前的完整诱饵树 `release/aaa-stale-win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node`；断言派生根落在 win-unpacked、`appOutDir` 正确、探针调用序列**长度为 1 且唯一入参是派生候选**。
  - T2「electronDist 旁路：--asar 指哪棵树，解包根就在那棵树」（跟选择器走，不跟目录名走）。
  - T3「app.asar 有而 .unpacked 缺 ⇒ fail-closed，不回落扫描」。
  - T4「asarPath 为 null（默认路径缺失 / `*.tmp` 被拒）时不得凭空造根，探针 0 次」。
  - T5（实树契约）对本机真产物跑一遍派生，证语义迁移没把判据挪位；无产物时按 `verify-nikkisync-link.test.ts` 既有口径显式 skip 并写明理由 —— 这是**本轮唯一允许的 skip**，其余一律不许。
- **红读数怎么拿**（关键，否则 T1 只是新函数自证）：临时给 `findAsarUnpacked` 加 `export`（一行、不入库、事后定点还原），在同一棵 T1 合成树里实测它返回**诱饵**路径 ⇒ 把这条红文本连同 `deriveUnpackedTarget is not a function` 一起抄进 commit body。还原后 `git diff --exit-code` 只剩本轮真实改动。诚实标注：本机 `release/` 的 5 个 `build-*` 残壳实测都不含 `app.asar.unpacked`，弱点是**潜在**而非当场可复现。
- **验收标准**：`npx vitest run scripts/__tests__/pre-dist-check.test.ts` 全绿；`npm run typecheck`（含 scripts 层）绿；`grep` 证 `pre-dist-check.ts` 内 `findAsarUnpacked` 0 残留。
- **提交**：`fix(pre-dist-check): 解包根改由待审 app.asar 派生，杜绝陈旧树假绿`

### Node 2 — 项 3 + 项 4：先测，再决定（合并不硬修）

- **涉及文件**：`.cache/spike-media-count-cost/spike.ts`（throwaway，**不入库**，跑完即删）；读数进 Node 9 的计划回写。
- **装置**（约 120 行，只读）：
  1. `copyFile` 把本机 userData 的 `database/meow_star_map.db` + `-wal` + `-shm` 拷进 `.cache/spike-media-count-cost/clone/database/`，用 `node:sqlite` 的 `DatabaseSync` 打开**克隆件**。绝不以可写方式打开用户真实库（连 `VACUUM INTO` 都不用）。
  2. 逐字复制首屏图库口径的 WHERE 与三条语句：`S1` keyset 首页（`ORDER BY created_at DESC, id DESC LIMIT 501` 探针行）、`S2` `SELECT COUNT(*) as count FROM media_files ${where}`（源 `:1221`）、`S3` `SELECT file_type as type, COUNT(*) as count FROM media_files ${where} GROUP BY file_type`（源 `:1241`）；参数顺序按 `:648-656`。`normalizeRootPath` 从真实源码 import，私有常量复制并配**字面量自检**（读源文件断言这些串与 `conditions.length === 2` 仍在，不命中即 `exit 1` 判读数作废）。
  3. **30 轮 S1/S2/S3 轮转采样**（顺序采样会让页缓存按语句单向暖化），报 min / 中位 / p95 与 `S3/(S1+S2+S3)` 占比；两个臂：带 `accountUid`、不带。
  4. 三条语句都打 `EXPLAIN QUERY PLAN` —— 这一项几乎单独回答要不要修（走 `idx_media_files_type` 还是第二个全表扫描），成本为零。
  5. 规模臂（仅当克隆库行数 < 5000 时补）：合成表 + 从 `connection.ts` 复制的同一组索引，N = 1k / 10k / 50k。真实库文件只有 884 KB，大概率要走这一臂才能满足「万级」。
- **判据（在测量之前写死，不许事后挪）**：
  - **A（边际，主）**：同一库同一 WHERE 下 `median(S3) ≤ median(S2) × 1.5` **且** `median(S3) ≤ 8 ms` ⇒ **维持现状**，把项 3/4 登记为债并附读数。
  - **B（规模，副）**：10 000 行臂 `median(S3) ≤ 15 ms` **且** EQP 显示 S3 不引入第二个全表扫描 ⇒ 维持；否则登记债。
  - **绝对锚**：`S1+S2+S3` 合计应在 `media-list-page500` 基线（10.3 ms @1500 图）的 3 倍以内，且远低于 `hardRules` 的 1000 ms。
  - 请求原拟的「@1 万行 GROUP BY ≤ 15 ms 且占首屏 ≤ 20%」**作废**：15 ms 已 ≥ 整条首屏基线，两条阈值互相矛盾、不可能同时成立。本轮要判的是「GROUP BY 相对它旁边那条无条件付钱的 COUNT 贵不贵」，是**边际**问题不是绝对毫秒问题。
  - **超阈时的第一候选不是「把类型分布并入 `media_count` 缓存」** —— 那等于把上一轮刻意请回来的第二个真相源再请一次，且 `refreshMediaCountCache`（`:1384`）的口径与 `countMedia` 的 WHERE（`:646`）**不同构**，并入即引入新口径分叉。第一候选是加 `(is_deleted, file_type)` 组合索引（零口径代价、DDL 幂等），但那要动迁移 ⇒ 属下一轮。**这条写死在此，防止读数一出就现场扩范围。**
- **绝对值怎么拿**：不新建 e2e 装置。出包之后在新包的 DevTools 里用 `performance.now()` 夹住一次真实首屏 `media.list`，跑 5 次取中位 —— 真 engine + 真 IPC + 真序列化 + 真 WHERE，与 `media-list-page500` 同量级可比，且与本轮出包共用一趟成本。**主动取舍**：`@perf-real` 那条路线要克隆整棵 userData、要 300 s 超时、且它本身并不测 `media.list` 耗时，对「本轮要不要改」这个判定不载信息 ⇒ 降级为「仅当 S3 落在灰区时」的备用对照。
- **验收标准**：计划文档 §10 出现读数表（命令原文、克隆库行数、Node 版本、采样轮数、两个臂、三条 EQP）与据此做出的取舍结论；`media-repository.ts` 是否被改动与结论一致。
- **提交**：无（装置不入库，读数随 Node 9 回写）。

### Node 3 — 项 1：`loadNextMediaPage` 引入代次弃权（红+绿一笔）

- **涉及文件**：`src/renderer/stores/mediaStore.ts`、`src/renderer/stores/mediaStore.test.ts`
- **输入/输出**：`:781` 置 `loadingMore` 之后领 `const genAtEntry = depthRefreshSeq`；取数失败出口之后、追加之前加 `if (genAtEntry !== depthRefreshSeq) return`；`finally` 一字不改；`:779` 的 `depthFetchActive` 守卫保留（它拦「起跑时刻」，新守卫拦「已起跑未收尾」，两者互补）。
- **夹具改动**（唯一一处向后兼容扩参）：`setGatedPagedListMock` 的 `release` 加可选下标 `index = 0`，用 `splice` 取；默认值与既有 `shift()` 逐次等价 ⇒ 既有三处调用不改；越界返回 `false`。**doc 注释「放行最早的一次未决请求」必须同步改写**，否则注释说谎。
  > 为什么非扩不可（已穷举）：要绕过 `depthFetchActive`，迟到页必须在整刷**之前**发起 ⇒ 它的 promise 恒在队首；要让它**最后**落地只能逆序放行。没有第三条路（给 mock 加延迟会连带改掉既有用例的 flush 次数，侵入更大）。
- **测试用例**（插在既有屏障用例之后、同一 describe）：`迟到的触底页在整刷写完游标之后落地时不得覆写游标（§10 残留 1 闭合）`。时序：复刻「库里 1200 / 屏上 500 / 游标 `{id:701}` / `hasMoreMedia:true`」→ 先发触底（入队）→ 再发起 `fetchMediaFromDatabase({limit:600})` → 逆序放行整刷两页 → `await refreshing` → 最后放行队首那条迟到页 → `await late`。四条断言：① `mediaCursor` 仍是整刷写入的 `{id:601}`（**修复前实得 `{id:201}`，这就是红点**）；② `mediaFiles` 长度 600（修复前 1000，证守卫在追加之前）；③ `loadingMore === false`（无红牙的保险索，诚实标注它不是缺陷复现）；④ `media:list` 共 3 次（弃权路径没有再发一次 IPC）。
- **「正常触底不误伤」不新写用例**：既有条 `:609-617` 就是这条，新守卫下必须保持绿 ⇒ 把它点名写进 commit body 当反证，比重复一遍更省。
- **验收标准**：`npx vitest run src/renderer/stores/mediaStore.test.ts` 先红后全绿；邻居三套件 `mediaStore.integration.test.ts` / `useFilteredMediaFiles.count.test.ts` / `mediaStore.nikkisync.test.ts` 保持绿；`npm run typecheck` 绿。
- **提交**：`fix(store): 触底续页引入代次弃权，迟到的页不再覆写整刷写入的游标`

### Node 4 — 项 2：重试日志措辞按「被取代 / 真失败」分叉（红+绿一笔）

- **涉及文件**：`src/renderer/hooks/useRefreshMedia.ts`、`src/renderer/hooks/useRefreshMedia.test.ts`
- **输入/输出**：warn 改为按 `superseded` 分叉的**模板字面量**三元 —— 取代分支 `[useRefreshMedia] 本轮已被新一轮整刷取代，${delay}ms 后再取一次 (${attempt}/${MAX_RETRIES})`，失败分支**逐字保持**原文。不动 `while` 条件、不动 `else if (!superseded)`、不新增 i18n key。
  > 「失败」那条一字不改不是美观问题，是取证需要：包内 needle 表把 `[useRefreshMedia] 加载失败` 当**对照组**（新旧包各应 1 命中），串一改本轮重打包就失去唯一的双向对照组。新增的取代串同时作为本轮**新 needle**（新包 1、旧包 0）。
- **测试用例**（新开一个 describe，夹具 `vi.spyOn(console, 'warn')`，还原交既有 `afterEach` 的 `vi.restoreAllMocks()`）：
  - 取代分支：第一次返回 null（配假 gen 每次 +2）、第二次成功 ⇒ 只等 500 ms。断言首条 warn **含**取代措辞、**不含**「加载失败」，且 `onError` 未调用。**修复前必红**。
  - 失败分支：不 spy `getMediaRefreshGeneration`（真实代次在取数被 mock 的情况下恒定 ⇒ `superseded` 恒 false），第一次 null 第二次成功。断言措辞与修复前逐字相同。**这条修复前就是绿的** —— 它是无红牙的对照，作用是把分叉钉成「只有取代分支变了」，防止把失败分支改成哑巴；诚实标注。
  - **不引入 fake timers**：两条新用例各只等 500 ms，比既有 null 用例（真实 3 s）便宜 6 倍；开 fake timers 必须成对 `useRealTimers()` 收尾，而动共享 `afterEach` 违反「不删改既有测试」，在用例内各写一遍又与 `@testing-library/react` 的 `waitFor`（依赖真实 timer）对撞。
- **验收标准**：`npx vitest run src/renderer/hooks/useRefreshMedia.test.ts` 取代用例先红后绿、对照用例始终绿；`npx eslint src/renderer/hooks/useRefreshMedia.ts` 0 error；`npm run i18n:guard` 绿且未新增键。
- **提交**：`fix(renderer): 被取代的重试日志不再自称加载失败`

### Node 5 — 技术债登记

- **涉及文件**：`docs/debt-registry.json`、`docs/技术债清单.md`
- **输入/输出**：registry 现最大编号 `DEBT-052` ⇒ 新条从 **053** 起连续；清单现最后一节 §20 ⇒ 新增 **§21**，结构照抄 §19（`>` 引块前言交代审查窗口与计划出处，两列表「| 债务 | 说明 |」，说明内嵌 `**本轮不修的原因**` / `**修法**` / `**撤销条件**`）。字段形态照 051/052：`id` / `category` / `section: 21` / `status` / `priority` / `title` / `description` / `files` / `lines` / `issue: false`。
- **条目**：053 被取代路径仍重试 3 次深度整刷（perf）；054 `verify-nikkisync-link.ts:538` 保留 `findAsarUnpacked` 同名副本、写清**分叉方向**（robustness）；055 首屏一次 `GROUP BY file_type` 无组合索引，**必须附 Node 2 实测读数与撤销条件**（perf，不附读数等于凭空挂账）；056 `fetchMediaFromDatabase` 无条件写 `loadingMore:false` 会踩掉在途触底的复位标记（本轮评审新发现的相邻残留，robustness）；057 项 1 交错 ③「弃权式整刷 bump 了代次却没写 store ⇒ 在途触底白弃一页」（concurrency，可选）；058 i18n 护栏为 Literal-only、中文模板串整体逃逸且本轮新增了一条同款（i18n-log，可选）。项 3 若判不修，写「已核图库首屏本不同源、混源仅窄路径、夹取已覆盖」，并留「彻底同源需先解决 `refreshMediaCountCache` 与 `countMedia` 口径不同构」这个前置。
- **格式**：md 表格里任何 `|` 一律转义为 `\|` —— 上一轮 §20 的 DEBT-052 行就是被 `` `| now-ts | ` `` 撞坏的。**本轮不顺手修那一行**（与五项无关，违反最小改动），只在 §21 一律转义并把该既有缺陷记一句留给下轮。
- **验收标准**：两份文件条目数与 §号双侧一致；`npm run docs:links` 退出码 0；`npx tsx scripts/debt/check-debt-fix.ts` 不报异常（它始终 exit 0，只作提醒）。
- **提交**：`docs(debt): 登记计数遗留轮处置后仍不修的若干条账`

### Node 6 — 变更日志收口

- **涉及文件**：`CHANGELOG.md`
- **输入/输出**：本轮修复项搬进 `## [2.5.6]` 既有 `### Fixed`；`[Unreleased]` **只留标题与说明行、不留 `-` 列表项**；文末 compare 链接形态保持不动。
- **验收标准**：`npx tsx scripts/check-changelog-release.ts` 打「✔ [Unreleased] 已收口（无待发布条目）」；`npx vitest run scripts/__tests__/check-changelog-release.test.ts` 全绿。
- **提交**：`docs(release): 计数遗留五项处置登记入 2.5.6 变更日志`
- **硬依赖**：必须在 Node 8 出包之前（该闸门在 `pre-dist-check` 链内）。

### Node 7 — 变异抽查两次 + 六道闸门（必须在出包之前）

1. **M1**：还原被修的实现（项 1 的代次守卫 / 项 2 的三元 / 项 5 的派生调用）⇒ 三条缺陷例应各自回红，证「有牙」。**M2**：项 1 把守卫下移到追加之后 ⇒ 数组断言仍红（证两条断言各自在覆盖内）；项 2 把 `superseded ?` 钉成恒 false ⇒ 取代用例红；项 5 撤掉派生函数的消费点 ⇒ T1 红。
   **每次注入与复原一律用带上下文的定点编辑，不用全局 `sed`**；复原后用 `sha256sum` 证逐字节还原 **且** `git diff --exit-code` 为空。
2. 闸门顺序：`npm run lint` → `npm run typecheck` → `npm run typecheck:e2e` → `npm run i18n:guard` → `npm test` → `npm run test:ci-linux` → `npm run verify`。
   - 比对基线前先确认 @nikkisync 链接状态（链接缺席时 `*.linked` 套件整批跳过，全量数会漂）。上一轮实测 **469 文件 / 7474 通过 / 20 跳过**；`test:ci-linux` 同口径 **7491 通过 / 3 跳过**、总数同为 7494。
   - 若本轮跑过 `npm install` / `npm update`：**立刻** `npm run link:nikkisync` + `npm run link:nikkisync:check`。
   - `tsc -b` 的 emit 必须仍落 `.cache/tsmain`，不得指回 `dist/main`（否则覆写 electron-vite 的 `preload.js`，`sandbox: true` 的 preload 无法 require 兄弟模块，e2e 以 `window.electronAPI` undefined 假失败）。
3. **一票否决**：任一红灯必须先修再进 Node 8；不得 `it.skip`、删改测试、放宽断言、调阈值凑绿（Node 1 的 T5 除外，理由写在用例注释里）。

### Node 8 — 归档 + 重新出包 + 包内取证 + 首屏绝对值手测

- 先把现役 `MeowStarMap-Setup-2.5.6.exe` / `.blockmap` / `latest.yml` / `win-unpacked` 整体移入 `_safe_backup_20261104-<hhmm>/`（该目录被 `.gitignore` 覆盖；安装包在 git 里没有任何副本，属不可再生孤本，先留底再覆盖）。
- 出包前**立刻**再校验一次链接 → `npm run build` → `npx tsx scripts/check-changelog-release.ts` → `npm run pre-dist-check` → **首选直跑 `npm run dist:win`**（2026-11-03 20:50 标准配方一次走通过；本机腾讯电脑管家 `QQPCRTP.exe` 对新解压 `default_app.asar` 的锁是**偶发**）。真死于 `EPERM rename('release\win-unpacked.tmp' -> 'release\win-unpacked')` 才走 `electronDist` 旁路 + `release/build-<标签>`；旁路**跳过** `pre-dist-check` 与 `verify:dist` 两步、必须手工补跑；搬运用 `cp -rf` 而非 `mv`（被锁文件只挡 rename/unlink，允许读与覆盖），并当场 `sha256sum` 证两侧 `app.asar` 全等。切勿用 `rm -rf` 探锁。
- `npm run verify:dist`：本轮**首次真跑改过的原生二进制步**，逐项读数应与上一轮一致，差别只在回显的解包根来源由「readdir 首命中」变成「派生自待审 app.asar」。
- `npm run e2e:smoke`：`[e2e] executable:` 必须打印 `release/win-unpacked/喵星图.exe` 才算验到新树。
- 包内新鲜度取证：用 `@electron/asar` 的 `listPackage` + `extractFile`（**条目名是反斜杠带前导分隔符，只能去前导符、绝不能把 `\` 换成 `/`**，否则必报 `was not found in this archive`）。四条判据：① 渲染 chunk 出现新的代次锚点标识、归档包同位置 0 命中；② `[useRefreshMedia] 加载失败` 对照组新旧各 1 命中；③ 取代措辞新包 1 / 旧包 0；④ `latest.yml` 的 `size` 与 `sha512` **两轴**都不同于归档值（同大小同哈希就是只换 `releaseDate` 的空重跑）。
- 首屏绝对值手测（Node 2 的绝对锚）在新包里跑，5 次取中位。
- **别用文件 mtime 判「包对应哪个提交」**（打包后提交会把 mtime 推到产物之后），按已提交树重打一次才是证据。

### Node 9 — 读数回写 + 收尾提交

把 Node 1–8 的红原文 / 绿读数 / spike 读数表 / EQP / 六道闸门退出码 / 出包与包内取证 / e2e 次序回写进本文件 §10，并回填「属实但本轮不修 / 未做」小节 —— 本轮结束时该节只剩真正未修项，且每项指向一个 DEBT 编号。跑不了的项目写成「前提不成立 + 缺哪一步」，**不得写成通过，也不得静默省略**。每笔提交后 `git status --porcelain` 复核钩子改写残余（pre-commit 会 `eslint --fix` + `prettier --write` 并重新暂存 ⇒ verify 通过 ≠ 提交时文件不变）。**不执行 `git push`、不补 tag。**

## 7. Verification（收尾硬门）

| 门       | 判据                                                                                                                                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项 1     | `mediaStore.test.ts` 先红（实得 `{id:201}` / 1000 条）后全绿；三个邻居套件保持绿；既有的「整刷后正常触底推进游标」用例反证未误伤                                                                                                                                          |
| 项 2     | 取代用例先红后绿、对照用例始终绿；`npx eslint` 对该文件 0 error；`npm run i18n:guard` 绿且未新增键                                                                                                                                                                        |
| 项 3 + 4 | §10 有读数表（命令原文、库行数、Node 版本、采样轮数、两个臂、三条 EXPLAIN QUERY PLAN）与据此做出的取舍结论；判据在测量**之前**已写死；`media-repository.ts` 若未改，DEBT-055 附读数登记在案                                                                               |
| 项 5     | `pre-dist-check.test.ts` 的 T1–T5 全绿；红读数取自「临时 export `findAsarUnpacked` 在合成树里选中诱饵树」的实测；`npm run verify:dist` 对本机真产物全绿；`findAsarUnpacked` 在 `pre-dist-check.ts` 内 0 残留，`verify-nikkisync-link.ts` 的副本仍在位且有 DEBT-054 指着它 |
| 债       | registry 新条目自 053 起连续、清单 §21 存在且表格未被打断；`npm run docs:links` 退出码 0                                                                                                                                                                                  |
| 全量     | `lint` / `typecheck` / `typecheck:e2e` / `i18n:guard` / `npm test` / `test:ci-linux` 六道全绿；`build` / `dist:win` / `verify:dist` / `e2e:smoke` 四项实测读数。**任一红灯未清，本轮不得标记完成**                                                                        |
| 变异     | M1 / M2 各覆盖到三处修复，注入与复原均为定点编辑，每次复原后 `sha256sum` + `git diff --exit-code` 双证                                                                                                                                                                    |
| 提交     | `git log` 按节点拆笔、无空提交、无 `--no-verify` 痕迹；`docs(plans)` 一笔在最前                                                                                                                                                                                           |

## 8. 风险与回滚

1. **覆盖 2026-11-03 20:50 的包**：孤本先移入 `_safe_backup_20261104-*/`，回滚 = 原样移回。
2. **项 5 带来一条运维面行为变更（必须点名）**：改完之后 `checkUnpackedNativeBinaries` 与禁串步**共用同一个选择器** ⇒ 走 `electronDist` 旁路、解包目录名非 `win-unpacked` 时，**必须**显式传 `npm run verify:dist -- --asar=release/<目录>/resources/app.asar`，否则 fail-closed。这不是纯收敛，是行为变更；fail 文案已指路，别让它读起来像闸门坏了。
3. **项 1 的交错 ③ 有误伤**：一轮弃权式整刷 bump 了代次却没写 store 时，在途触底会白弃一页。代价有界（`hasMoreMedia` 仍 true，用户再触底即恢复），收益不对称 —— 选「过弃权」而非「游标身份判据」，因为代次制与 `:607/:620/:643` 同形、可 grep、可做包内取证，而身份制对末页 `null` 游标无判别力。登记 DEBT-057 备查。
4. **项 2 保留的冗余重试**：措辞分叉后，被取代路径仍会重试 3 次。登记 DEBT-053；若下轮要收，判据难点在「别人起了一轮」与「自己也真的失败」在现有信号上不可分。
5. **spike 复制 SQL 的漂移风险**：装置只读，靠字面量自检兜底（不命中即判读数作废）。它的 EXPLAIN 与毫秒数来自 `node:sqlite` 承载的同一 SQLite 引擎，与 better-sqlite3 的差别只在 JS 绑定层 ⇒ 对「多一次 GROUP BY 贵不贵」这个判据可用，但不等于生产读数，故另出手测绝对值。
6. **`npm install` 删 junction**：见 §2，出包前再校验一次。
7. **杀软历史锁**：`EPERM rename` 时走 §Node 8 的旁路并手工补跑两步，别拿「出包成功」代替闸门通过。

## 9. 本轮明确不做

- 不在拿到读数之前动 `media-repository.ts` 的缓存策略；即便超阈，本轮也不加 `(is_deleted, file_type)` 组合索引（要动迁移，属下一轮）。
- 不动 `loadNextAssetPage`（同步面游标与本地 keyset 游标不同构，且本轮判据不经过它）。
- 不改 `useRefreshMedia` 的重试次数、退避间隔或 `while` 条件（用户裁决「只分叉措辞」）。
- 不动 `findAsarUnpacked` 在 `verify-nikkisync-link.ts` 的那份副本（登记为债）。
- 不顺手修 §20 里被管道符撞坏的那行表格渲染；不改 `.gitignore`、CI 配置与 `lint-staged` 键形态。
- 不推送远端、不补 `v2.5.6` tag。

## 10. 执行读数（本轮实测，2026-11-04）

> 本节在 Node 9 回写。开工时留空，**不得预填任何未经实跑的读数**。

### 提交切分（一节点一提交，未推送）

| 节点 | 提交 | 内容                                                 |
| ---- | ---- | ---------------------------------------------------- |
| N0   | 待填 | `docs(plans)` 本计划落仓                             |
| N1   | 待填 | `fix(pre-dist-check)` 解包根派生（红读数入 body）    |
| N3   | 待填 | `fix(store)` 触底代次弃权（红测试与修复同笔）        |
| N4   | 待填 | `fix(renderer)` 重试日志措辞分叉（红测试与修复同笔） |
| N5   | 待填 | `docs(debt)` §21 与 registry 新条目                  |
| N6   | 待填 | `docs(release)` 变更日志收口                         |
| N9   | 待填 | `docs(plans)` 读数回写                               |

### 逐节点红灯 → 绿灯（修复前红读数均为实测）

待填。

### spike 读数与取舍结论（项 3 + 项 4）

待填：命令原文、克隆库行数、Node 版本、两个臂的 min/中位/p95、`S3/(S1+S2+S3)` 占比、三条 EXPLAIN QUERY PLAN、据判据 A/B 做出的结论，以及出包后手测的首屏绝对值。

### 变异抽查（两次，均用 sha256sum 证逐字节还原）

待填。

### 六道闸门（全部实跑，退出码为证）

待填。

### 出包、包内取证与 e2e

待填。

### 属实但本轮仍不修 / 未做（如实记账）

待填 —— 本轮结束时，这里的每一项都必须能指向一个 DEBT 编号。
