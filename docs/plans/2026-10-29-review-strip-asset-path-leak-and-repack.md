# 全面审查 → 修复委托层绝对路径泄漏 → 2.5.6-beta 重打包（2026-10-29）

> 任务形态：「审查近期提交与未提交代码 → 修缺陷 → 提交 → 版本号设为 2.5.6-beta → 重新打包」。
> 本文是该轮的**实施计划**（会话内计划不算交付物，故先落仓）；执行读数回写在 §7。
> 上一轮（NikkiSync 上游同步阶段一~四）见 `2026-10-29-nikkisync-upstream-sync-03-执行记录.md` §10，其末段把收尾移交本轮。

## 0. 开工核对读数（全部本机实跑，改代码之前）

| 判据                   | 命令                                                                    | 实测                                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作树                 | `git status --porcelain`                                                | 仅 `?? release-sync/`（未跟踪且**不在** `.gitignore`，10-27 打包残壳）⇒ 无待提交代码改动                                                                                                                                |
| 版本号四处声明         | `node -e "require('./package.json').version"`                           | `meow-star-map 2.5.6-beta`；`package-lock.json` 根与 `packages[""]`、`src/renderer/preview/mock/database-mock.ts`、`release/latest.yml` 全部同值 ⇒ 「设为 2.5.6-beta」是**零编辑**                                      |
| 最后一次出包           | `ls -la release/`                                                       | `MeowStarMap-Setup-2.5.6-beta.exe` 184,427,991 B @ 10-27 22:49，对应 HEAD ≈ `59b40a4`（10-27 20:54）                                                                                                                    |
| 审查范围               | `git log --since="2026-10-27 22:00"`                                    | `59b40a4..HEAD`（HEAD `85a7553`）= 28 个提交 / 37 文件 / +3803 −141 ⇒ **审查对象不是 `git diff`，而是最后一次出包之后的提交**                                                                                           |
| 包与源码的两条新鲜度轴 | `git diff --stat 59b40a4..HEAD -- src/`；`npm run link:nikkisync:check` | ① 本仓侧 `1e11c0e` 改了 `src/main/nikkisync/runtime-manager.ts`（进 `app.asar`）；② 外部侧经 junction 引入的 `../NikkiSync` 由 `b422193` → `b397e0e`。两条都晚于出包 ⇒ **重打包有实质内容差异，不是只换 `releaseDate`** |
| 链接在位               | `npm run link:nikkisync:check`                                          | 4 条 `ok`、`check OK (all four links in place)`、exit 0                                                                                                                                                                 |
| 单文件基线             | `npx vitest run src/main/nikkisync/runtime-manager.test.ts`             | 1 file / **74 passed** / 0 skipped，exit 0                                                                                                                                                                              |
| 域基线                 | `npx vitest run src/main/nikkisync`                                     | 16 files / **282 passed** / **0 skipped** / 23.45s，与上轮 §10.1 读数**逐位相同**（收口未漂移）                                                                                                                         |

## 1. 审查结论：一个真实缺陷 + 一处断言盲区 + 两处卫生漂移

### 1.1 缺陷（HIGH，进安装包，本轮必修）：委托层 `stripAssetPathFields` 在共享对象身份上退回原件

站点：`src/main/nikkisync/runtime-manager.ts:785-808`（本轮 `1e11c0e` 引入，故**不在任何已出货包里**，但已在 `main` 上）。

机制：该函数用 `seen = new WeakSet()` 记「**已访问**」，命中即 `return value` —— 返回的是**未裁剪的原件**。它把上游 `mapAssetSummary` 新增的 `sourcePath` / `sourceFolder`（本机绝对路径与其父目录）从查询响应里剔掉，而**同一对象在一次响应里出现第二次时，第二处原样漏给渲染层**，正是这段代码要防的事。

现场复现（`node -e`，两个聚合共享同一个 `asset` 对象身份）：

```
s1.asset = {"assetId":"a1"}
s2.asset = {"assetId":"a1","sourcePath":"D:/game/photos/Photo_1.jpg","sourceFolder":"D:/game/photos"}
LEAK? true
```

可达性取证（读实际装载的产物，不采信注释）：

| 事实                                                                                  | 证据                                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两键由上游 `mapAssetSummary` 产出，且**成对**（仅在有 `sourcePath` 时给出）           | `node_modules/@nikkisync/pc-companion/dist/src/server/row-mappers.js:108`、`:121-122`、`:135`                                                                           |
| 同一份 `{ asset: mapAssetSummary(...) }` 每张照片只建一次，随后**按引用**塞进多个聚合 | `LocalSyncServer.js:341`；本仓同构复刻在 `src/main/nikkisync/runtime-facade.ts:467-470`                                                                                 |
| 一张照片命中 N 件服装 ⇒ 同一 `asset` 对象出现在 N 个聚合里                            | `ClothingSearchIndex.js:79` `aggregate.photos.push({ asset: searchable.asset })`（在逐服装循环内）；`SuitSearchIndex.js:145` 同理（在逐套装循环内）                     |
| 三条被包裹的委托中，`listAssets` 单响应内不重复                                       | `LocalSyncServer.js:315` 逐行 `pageRows.map`，`assets` 表按 `asset_id` 唯一 ⇒ 每身份一次                                                                                |
| 生效前提：`dressing.clothes` 须为**字典富化后的对象形态**                             | 两个索引都以 `objectOf(rawClothing)` 起判；裸 id 数字形态被丢弃，实测索引产出 `items: []`（`src/main/nikkisync/metadata-resolver.linked.test.ts:251-266` 已钉住该反例） |

⇒ 影响面如实写：**开启元数据在线解析且字典有值的库**会泄漏，不是每个库都泄漏。不夸大为「必然」。

同根因的另外两条泄漏面（一并由同一修法关闭）：真环形引用的回边、被共享或成环的**数组**（`value.map()` 无法「先登记后填充」）。

不需改动且已取证的对偶面：

- `getAssetDetail` —— `row-mappers.js:62`/`:105`（`mapAssetRow`/`mapAssetDetail`）两键皆无 ⇒ 不裁是对的；
- `listChanges` —— `mapChangeRow`（`row-mappers.js:147-154`）只发 `revision/type/assetId/occurredAt` 四个标量 ⇒ 不裁是对的；
- `profileStats` —— `ProfileStatsIndex.js:48-56` 只计数、不下发 `searchable.asset` ⇒ 不需要第四个包裹点，不要「顺手补」；
- `getResource` / `listResourceRecords` 的 `mode:'path'` —— `media://` 授权的唯一出口（`registerNikkiSyncResourcePaths` 靠它建表），**刻意不裁**，既存边界用例继续钉住。

文档侧：`docs/IPC_CONTRACT.md:389-403` 已把三条通道都写成裁剪 ⇒ 声明无需修改，**修复后那句话才第一次为真**（本轮修复前它是过度声明）。

### 1.2 断言盲区（MEDIUM，与缺陷同批修）：`searchClothing` 的裁剪零断言

`runtime-manager.ts:853-854` 裁了，`runtime-types.ts:487-489` 与 `IPC_CONTRACT.md:390-392` 都声明裁了，上游确实会在该通道嵌资产行（`ClothingSearchIndex.js:79`）——但：

- 单测夹具 `src/main/nikkisync/runtime-manager.test.ts:307` 的 `searchClothing` 返回 `{ items: [] }` ⇒ 裁了个空数组，断言空转；
- 真上游 N4 套件 `runtime-facade.linked.test.ts:346-388` 只驱 `listAssets`。

⇒ 契约声明建立在推断上而非行为上，这也是 1.1 的泄漏没被现有测试抓到的直接原因。修法：夹具改为符合 `ClothingSearchIndex.js:67-92` 的嵌套真实载荷（`clothingId/name/category/suitId/suitName/photoCount/photos:[{asset}]`，**不含** `matchedParts`——那是套装索引独有字段），并按既有 `assetPage`/`suitPage` 同构新增 `FakeSessionPlan.clothingPage`。

### 1.3 卫生漂移（LOW，两处各 1 行，经用户批准随本轮附带）

| 站点                    | 陈述                                                                                         | 实测                                                                                                                                                                                 | 处置                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/AGENTS.md:107` | 「68 个入仓代码文件里 **62** 个为 TypeScript（`.ts`：35 个非测试 + **27** 个 `__tests__`）」 | `git ls-files scripts` = 70 = **63 `.ts`** + 3 `.cjs` + 2 `.js` + 1 `.json` + 1 `.md`；63 个 `.ts` 里 35 非测试 + **28** `__tests__` ⇒ 63+3+2 = 68 正确，但 TS 数与测试数各漏 1      | 订正为 `63 … 28 …`。漂移来自 `127158d` + `0bb84a4` 一次加了两个测试文件而只抬了总数（`0bb84a4` 当时确实改过本文件）                                                                                                                                                                                                                                                    |
| `.gitignore`            | 不含 `release-sync/`                                                                         | 它是 10-27 打包旁路留存的解包副本（内含 `app.asar`），**今天独占打开仍为 LOCKED** ⇒ 删不掉；反复污染 `git status`，近三天的计划文档被迫反复记载「必须按文件名 `git add`、禁止 `-A`」 | 在 `release-new/` 之后加 `/release-sync/`。已确认全仓**无任何测试读 `.gitignore`**（`grep` 只命中三处散文注释），且 `scripts/__tests__/old-name-ledger.json` 的 `roots`（src/tests/scripts/e2e/.storybook/plugins-samples/docs/tools/.github）与 `rootFiles` 白名单都不含 `.gitignore`、也不含 `release-sync` ⇒ 不触发台账守卫。「句柄释放后应删除该目录」记入 §7 遗留 |

### 1.4 本轮明确不修（如实记账，不假装干净）

| 项                                                                         | 证据                                                                                                                                                                                                                                                                                                       | 不修的理由                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify-nikkisync-link.ts` 在半链接时 chain 项打印 `present: …` 的空转表述 | `:439-452` 四条产物循环都只在 `name === '@nikkisync/pc-companion'` 分支内跑；缺该 junction 时 `chainArtifactsMissing` 恒空 ⇒ 该项判绿                                                                                                                                                                      | `:215-224` 的 `builtArtifacts` 检查（无 `level: 'warn'`）**会硬失败**，整条链不是静默口子；这是 `SYNC_SERVER` / `METADATA` / `CAPABILITY` 三张同族表共有的既有措辞问题，非本轮新引入。修它要动 `evaluateNikkiSyncLink` 纯函数与配套用例，超出最小化改动 |
| `connection.test.ts` 把 `fs.promises.readdir` 桩成覆盖 122 例的宽桩        | `src/main/database/connection.test.ts:672`；`services/backup-service.ts:212` 用 `fsp.readdir`，但当前无用例对其断言                                                                                                                                                                                        | 今天不削弱任何判据，属未来风险；挂账不改                                                                                                                                                                                                                |
| N4 真上游链路补 `searchSuits`/`searchClothing` 断言                        | 现有夹具 `runtime-facade.linked.test.ts:75-76,96-128` 写 10 字节 JPEG / 16 字节 MP4（刻意绕开原生参数信封解析分支）⇒ `assets.metadata_json` 恒 NULL；`runtime-facade.ts:467-470` 的 `String(null) === 'null'` 让索引不跳过，但 `objectOf(JSON.parse('null'))` → `undefined` → `clothes = []` → `items: []` | 直接加断言就是 N4 反空转用例（`:347-365`）所禁止的**空转绿**。要做必须先播种字典富化形态的服装元数据（≈45 行、走 `createSession` DI 缝、并注意 `searchSource()` 按 revision 缓存的建表时机）。用户裁决本轮不做，列为后续项                              |

## 2. 依赖声明

**零新增依赖、零版本变更、`package-lock.json` 本轮不动**（`git diff -- package-lock.json` 为空）。

**禁止**执行 `npm install` / `npm update` / `npm ci` / `npm audit fix`：它们按锁文件收敛 `node_modules`，会静默剪掉 `npm run link:nikkisync` 建的 4 条 junction（识别信号是输出里的 `removed 4 packages`，那 4 个「包」就是 junction），后果不是报错而是**安装包缺整个内嵌同步运行时**（体积掉约 608,615 B）。开工与收尾各跑一次 `npm run link:nikkisync:check` 自证。

## 3. 启动与运行说明

```bash
git status --porcelain                                   # 期望：仅 ?? release-sync/（N6 后为空）
npm run link:nikkisync:check                             # 期望：check OK (all four links in place)
npx vitest run src/main/nikkisync/runtime-manager.test.ts # 红 → 绿 两次读数都跑这一条
npx vitest run src/main/nikkisync                         # 域内 0 failed / 0 skipped
npm run verify:nikkisync                                 # 期望 exit 0、blocking failures: 0
npm run verify                                           # 只读检查集，[VERIFY] 无 ✗
npm run lint && npm run typecheck && npm run typecheck:e2e && npm run i18n:guard
npm test                                                 # 全量回归
npm run docs:links                                       # 期望 exit 0
npm run dist:win                                         # 出包（N7，先归档旧包）
npm run verify:dist                                      # 产物闸门，须读回显路径
npm run dist:win:smoke                                   # 打包态冒烟
```

长耗时步骤（全量 `npm test` ≈ 55s、`dist:win` ≈ 8–15min）用后台任务跑，**判定成败读日志里的内层 `EXIT=` / `⨯` 行**，不信通知摘要的 exit code（包装层会把 npm 的 exit 1 报成 0）。

## 4. 错误处理与兜底

- **红灯撞自家闸门**：`.husky/pre-commit` 的 lint-staged 对 `src/**/*.{ts,tsx}` 键跑 `test:precommit` ⇒ 刻意留红的 `src/` 提交会被拒。处置是把红测试与修复**合并成一次提交**、把修复前的失败断言原文写进 commit message 留痕。**禁止 `--no-verify`**。`scripts/**`、`docs/**` 不触发 `test:precommit`，可独立提交。
- **打包锁**：`app-builder-lib/out/electron/ElectronFramework.js:222` → `util/electronGet.js:116-192`：`tmpDir = appOutDir + '.tmp'` → `fs.rm(tmpDir,{recursive,force})`（`force` 只吞 ENOENT，**不吞 EBUSY/EPERM**）→ 对既有 `release/win-unpacked` 整树 `fs.rm`（`:186`）→ `fs.rename(tmpDir, dir)`（`:187`）。⇒ `release/win-unpacked` 不必缺席但必须可整树删除。出包前先跑独占打开探针（只探测、不改内容）判三处：`release/win-unpacked.tmp/resources/default_app.asar`、`release/win-unpacked/resources/app.asar`、`release/win-unpacked/resources/default_app.asar`。10-29 实测三处 **FREE**、仅 `release-sync/win-unpacked/resources/app.asar` LOCKED ⇒ 走标准配方。
- **兜底旁路**（仅当标准配方抛 `EBUSY … win-unpacked.tmp …` 或 `EPERM rename(win-unpacked.tmp → win-unpacked)`）：
  `npx electron-builder --win --publish never --config.electronDist="<仓根绝对路径>/.cache/electron-dist-clean" --config.directories.output=release/build-20261029-stripfix`，随后 `npm run verify:dist -- --asar=release/build-20261029-stripfix/win-unpacked/resources/app.asar`。
  两个坑必须同时避开：① 输出目录留在 `release/` 下（`checkUnpackedNativeBinaries` 只走 `release/**`，指到外面会 fail-closed 报「未找到 `release/**/resources/app.asar.unpacked`」）；② **必须带 `--asar=` 并读回显路径**——禁串审计 `resolveVerifyAsarTarget` 默认硬编码 `release/win-unpacked/resources/app.asar`，而原生二进制那侧走 `findAsarUnpacked` 的 readdir 首命中（`build-*` 排在 `win-unpacked` 之前），不带参数就是「原生二进制验新树 + 禁串验 10-27 旧树」的混合审计假绿。
- **`docs:links` 反噬**：本文档在 `git add` 前不在 tracked 集，`check-md-links` 的「被跟踪文档不留死引用」用 `git ls-files` 判存在 ⇒ 顺序固定为「文档落盘 → `git add` → 再提交引用它的 CHANGELOG」，且文档内的路径一律用行内代码而不是链接。
- 任何实测与预期读数不符，**先取证再改判据**；禁止 `it.skip`、放宽断言、调低阈值换取绿灯。

## 5. 参数校验

本轮不新增 IPC 通道、不改 zod schema、不动 `wrapHandler` 与 `IpcResponse` 形状，`docs/IPC_CONTRACT.md` §8.1 的通道清单逐字不变（渲染层入参校验零改动）。改动落在**出站响应面的键集合**上：

- 入参 `unknown`；非对象与 `null` 原样返回；
- 命中判定 `memo.get(value) !== undefined`（登记表只写对象/数组副本，永不写 `undefined`）；
- `depth >= MAX_STRIP_DEPTH(8)` 时只停「下钻」，**当层两键照旧剔**（宁少不漏，不因兜底而漏键）；
- 非纯对象（Date/Map/Set/类实例）会被展开成 `{}`：这是修复前后一致的既有行为，依赖是「上游 DTO 各键都经 `String()`/`Number()` 包裹（`row-mappers.js:47-146`），今天载荷里没有这类值」；出现即按空对象透出，在新注释里如实写成**依赖**而不是新风险。

## 6. 子任务与基础测试用例

| #   | 涉及文件                                                                                                                                  | 输入 → 输出                                                                        | 验收标准                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | 本文档                                                                                                                                    | 会话计划 → 仓内文档                                                                | `git ls-files docs/plans \| grep -c "2026-10-29-review-strip"` = 1；`npm run docs:links` exit 0；单独一次 `docs(plans)` 提交                                                                                                |
| N2  | `src/main/nikkisync/runtime-manager.test.ts`（夹具 `:307` + 新增 3 例）、`runtime-manager.ts`（`FakeSessionPlan.clothingPage?: unknown`） | 只改测试面 → 复现泄漏                                                              | `npx vitest run src/main/nikkisync/runtime-manager.test.ts` → **2 failed                                                                                                                                                    | 75 passed**，失败原文含 `to not have property "sourcePath"` 与 `JSON.stringify` 仍含 `sourcePath`；既存 4 例（正常 `:693`/`:704`、边界 `:717`/`:728`）保持绿 |
| N3  | `runtime-manager.ts:785-808` 函数体与其上方注释段                                                                                         | 访问集 → 身份登记表（副本先登记后下钻；数组先登记空数组再 `push`；深度注释 4 → 5） | 同一命令 → 全绿（77 passed）；`npx vitest run src/main/nikkisync` → 0 failed / 0 skipped；`npm run verify:nikkisync` exit 0                                                                                                 |
| N4  | 临时回退 `runtime-manager.ts`（不落盘提交）                                                                                               | 还原 WeakSet 版 → 跑测试                                                           | 新增 3 例红、其余绿（证明判据落在真实行为上）；恢复后 `sha256sum` 与绿灯版逐字节一致；两次读数写入 commit message                                                                                                           |
| N5  | 上述两文件 + `CHANGELOG.md`                                                                                                               | 修复 → 红绿合并一次提交                                                            | `npm run verify` 无 ✗；`lint`/`typecheck`/`typecheck:e2e`/`i18n:guard`/全量 `npm test` 全部 exit 0；全量测试的文件数/通过数与 §7 基线对比满足**总数差 == 新增例数**；`git status --porcelain` 提交后仅剩 `?? release-sync/` |
| N6  | `scripts/AGENTS.md:107`、`.gitignore`                                                                                                     | 计数订正 + 忽略残壳                                                                | 两条计数与 `git ls-files scripts` 逐项对上；`git status --porcelain` **完全为空**；`git check-ignore -v release-sync/win-unpacked/resources/app.asar` exit 0                                                                |
| N7  | `release/` 产物                                                                                                                           | 修复后的 HEAD → 安装包                                                             | 旧包三件归档到 `_safe_backup_20261029-pre-stripfix/`；`npm run dist:win` 日志末 `EXIT=0`；`npm run verify:dist` 全 ✓ 且 `✔ 产物无旧仓库链接与失效占位` 回显指向**本轮新树**；`npm run dist:win:smoke` 通过                  |
| N8  | 本文 §7                                                                                                                                   | 全部读数 → 仓内留痕                                                                | 每步读数（含 not-run 项与 §1.4 三项挂账）逐条可追溯到一条命令；收尾 `git status --porcelain` 为空                                                                                                                           |

提交分三批（Conventional Commits）：`docs(plans)`（N1）→ `fix(nikkisync)`（N2+N3+N4+N5）→ `docs(scripts)` 与 `chore(gitignore)`（N6，可同批）。

### 6.1 三类用例（正常 / 异常 / 边界）

| 类别      | 用例                                                                                                                                                                                                                                                                                 | 判据                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常      | 既存 `:693`（`listAssets` 不透两键、其余键与 `libraryRevision` 原样）、`:704`（`searchSuits` 嵌套 `items[].photos[].asset` 同样裁、`matchedParts` 不被改写）+ 新增 `searchClothing` 嵌套基本覆盖                                                                                     | 泄漏键不存在，结构不被改写，夹具字段值逐项 `toBe`（这一例是 1.2 的补测，构造上不依赖缺陷修复）                                               |
| 异常/缺陷 | 新增两例：`searchSuits` 与 `searchClothing` 各构造**两个聚合并用同一 `asset` 对象身份**（生产形态，`SuitSearchIndex.js:145` / `ClothingSearchIndex.js:79` 的按引用塞入），逐处 `not.toHaveProperty('sourcePath'/'sourceFolder')` + `not.toBe(原件)` + 整树 `JSON.stringify` 不含两键 | 修复前必红（第二处退回原件），修复后转绿。刻意**不**断言「两处是同一副本」——那是 memo 的实现机制，写死会把另一种正确实现（路径集）误判成假红 |
| 边界      | 既存 `:717`（`mode:'path'` 仍给绝对路径原值）、`:728`（副本而非就地删键，原件两键仍在）；新增用例内同样要求 `sharedAsset` 原件两键保留                                                                                                                                               | `media://` 出口不被过裁；上游对象身份不被污染（缓存与统计面共享它）                                                                          |

## 7. 执行记录与读数（随执行回写）

### 7.1 N1 计划落仓

提交 `f6a139b`（`docs(plans)`，1 file / +152）。pre-commit 三步：lint-staged ✓（`*.{ts,js,json,md}` 键命中，`prettier --write` 重排本文表格）、core-gate ⊘、tsc ⊘（无 TS/TSX）。`npm run docs:links` exit 0（177 处既存提醒、无死引用）。落盘后复核：无 BOM、无 CR、29,129 B。

### 7.2 N2 红灯（修复前取证）

改动面：`runtime-manager.test.ts:307` 夹具换成 `ClothingSearchIndex.js:67-92` 形态的嵌套载荷 + 新增 3 例；`runtime-manager.ts` 加 `FakeSessionPlan.clothingPage?: unknown`（测试面入口，非修复本体）。

```
npx vitest run src/main/nikkisync/runtime-manager.test.ts
 Test Files  1 failed (1)
      Tests  2 failed | 75 passed (77)
FAIL ... > 缺陷：同一 asset 身份被两个套装聚合共享时两处都必须是已裁键副本（上游按引用塞入 ⇒ 第二处曾退回原件）
AssertionError: expected { assetId: 'asset_1', …(2) } not to be { assetId: 'asset_1', …(2) } // Object.is equality
    at src/main/nikkisync/runtime-manager.test.ts:848:33   ← expect(photo.asset).not.toBe(sharedAsset)
FAIL ... > 缺陷：searchClothing 的同一 asset 跨服装聚合共享 ⇒ 两处都裁键（一张照片命中 N 件服装即 N 份引用）
AssertionError: expected { assetId: 'asset_1', …(2) } not to be ...  at :895:33
```

`…(2)` 即第二处拿到的就是带 `sourcePath`/`sourceFolder` 的原件 ⇒ 缺陷被精准复现，且基线 74 例保持绿（`2 failed | 75 passed` 中 75 = 74 既存 + 1 条不依赖共享身份的回归补测）。

### 7.3 N3 绿灯

| 命令                                                        | 修复前                            | 修复后                                                              |
| ----------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| `npx vitest run src/main/nikkisync/runtime-manager.test.ts` | 2 failed / 75 passed (77)         | **77 passed**                                                       |
| `npx vitest run src/main/nikkisync`                         | 16 files / 282 passed / 0 skipped | 16 files / **285 passed** / 0 skipped（+3 == 新增例数，逐位可对上） |
| `npm run verify:nikkisync`                                  | 13 行全 ✓ / blocking 0            | 13 行全 ✓ / `OK (blocking failures: 0)` / exit 0                    |
| `npm run verify`                                            | —                                 | typecheck / lint / core-gate / format / test **5 项 0 失败**        |

### 7.4 N4 判别力（两次变异抽查）

计划表 §6 的 N4 行原写「新增 3 例红」——**预期写宽了，按实况订正**：回归补测例不构造共享身份，`WeakSet` 旧实现下本就绿，故第一次变异的真实读数是 2 红。判别力由「两条缺陷例 + 第二条变异」共同承担。

| 变异                                      | 期望                                         | 实测      |
| ----------------------------------------- | -------------------------------------------- | --------- |
| M1 还原 `WeakSet` 访问集版函数            | 恰好两条跨聚合缺陷例红                       | `2 failed | 75 passed (77)`，失败原文与 §7.2 逐字一致，其余 75 绿                                           |
| M2 把 `searchClothing` 改回薄委托（不裁） | 恰好两条服装相关例红（证明回归补测不是空转） | `2 failed | 75 passed (77)`，红的是「回归：searchClothing 的嵌套…」与「缺陷：searchClothing 的同一 asset…」 |

两次恢复后 `sha256sum src/main/nikkisync/runtime-manager.ts` = `af57b0302a5a9315c48d3c740b6237b33b2df6cf47f3c4a0f0cb733e0a457678`，与绿灯版**逐字节一致**；提交后钩子（`eslint --fix` + `prettier --write`）未改写该文件（同一哈希复验），且对提交后的内容复跑仍 77 passed。

### 7.5 N5 全量回归与提交

- 静态门全绿：`lint` / `typecheck` / `typecheck:e2e` / `i18n:guard` / `docs:links` 五条命令 `EXIT=0`。
- 全量 `npm test`：**453 files passed / 7080 passed | 12 skipped (7092) / 71.98s**，`EXIT=0`。
  口径说明：与 CHANGELOG 里 2026-10-28 的「453 / 7063 / 12」不可直接相减——其间有 5 个提交新增过用例，非同等基线；本轮的「总数差 == 新增例数」在**文件级（74→77）与域级（282→285）**两处等式都成立，全量只用于判「无新增失败项」。
- 提交 `1353cd0`（`fix(nikkisync)`，3 files / +176 −9），pre-commit Step 1/3、2/3、3/3 全过；提交后 `git status --porcelain` 仅 `?? release-sync/`。
- CHANGELOG 补录 bullet 追加在既有 `## [2.5.6-beta]` 节 `### Fixed | 修复` **首位**（未写进 `[Unreleased]`）：`npx tsx scripts/check-changelog-release.ts` → 解析到 14 个版本节、`[2.5.6-beta]` 唯一、`[Unreleased]` 已收口、exit 0。

### 7.6 N6 卫生修正

提交 `b0e39ba`（`docs(scripts)`，2 files / +3 −1）。

- 计数复核：`git ls-files scripts` = 70 = 63 `.ts` + 3 `.cjs` + 2 `.js` + 1 `.json` + 1 `.md`；63 个 `.ts` 中 35 非测试 + 28 `__tests__` ⇒ 文档现与实测逐位对上（63 / 35 / 28）。
- 忽略残壳：`git check-ignore -v release-sync/win-unpacked/resources/app.asar` → `.gitignore:15:/release-sync/`，exit 0；`git status --porcelain` 由 `?? release-sync/` 转为**完全为空**。
- 复跑 `npm run docs:links` exit 0（`scripts/AGENTS.md` 改动不引入死引用）。

### 7.7 N7 出包

**出包前**：`npm run link:nikkisync:check` 四条 ok；独占打开探针七处——`release/win-unpacked.tmp/resources/default_app.asar`、`release/win-unpacked/resources/app.asar`、`release/win-unpacked/resources/default_app.asar`、旧 Setup 三件均 **FREE**，仅 `release-sync/.../app.asar` **LOCKED**；`Get-Process` 里工作区内**零进程**。旧包四件（exe 184,427,991 B / blockmap 190,888 B / latest.yml / builder-debug.yml）已 `mv` 到 `_safe_backup_20261029-pre-stripfix/`（该前缀被 `.gitignore:167` 覆盖），`git status` 复核为空。

**标准配方失败**：`npm run dist:win` → `EXIT=1`，死在 `app-builder-lib/out/util/electronGet.js` 的 rename 步：

```
⨯ EPERM: operation not permitted, rename '...\release\win-unpacked.tmp' -> '...\release\win-unpacked'
    at extractArchive (electronGet.ts:249)  at unpack (ElectronFramework.ts:254)
```

失败点之前的各环节全部走完：`build:recycle-helper` ✓、`build`（electron-vite）✓、`pre-dist-check` 27 项 ✓、`check-doc-versions` ✓、`check-changelog-release` ✓、`@electron/rebuild`（better-sqlite3 x64）✓、Electron 下载与解压 ✓。
判据取证（区分「历史孤本被占」与「新解压被主动加锁」）：老 `release/win-unpacked`（10-27 树）**被 builder 成功删除**（`fs.rm` 未报错），失败发生在把**刚写好的** `.tmp` 改名过去；随后手工探针 `mv release/win-unpacked.tmp release/win-unpacked` → `Permission denied`，且 23:39 独占打开新产 `release/build-*/win-unpacked/resources/app.asar` 亦为 **LOCKED**（落地一分钟内）。⇒ 结论是**实时防护对新写入解包树主动加锁**（本机既有记录的同型现象），不是本仓配置或本轮改动引入的回归，也不是残留句柄。

**旁路出包**（仅替换 unpack 机制，输入完全相同：同一 `dist/`、同一 junction 拉入的 `@nikkisync`、同一 `build` 配置）：

```
npx electron-builder --win --publish never \
  --config.electronDist="<仓根>/.cache/electron-dist-clean" \
  --config.directories.output=release/build-20261029-stripfix
→ EXIT=0
```

`electronDist` 指目录时走 `copying unpacked Electron source=... destination=release\build-20261029-stripfix\win-unpacked`（`emptyDir` + `copyDir`，无 `.tmp`、无 rename），`.cache/electron-dist-clean` 为官方缓存 zip 的完整 41.10.6 解包（19 项、`electron.exe` 223,764,992 B，刻意不含标准流程 `cleanupAfterUnpack` 会删的 `resources/default_app.asar` 与 `version`）。日志里 `file signing skipped — signAndEditExecutable is false` 是仓内既有配置（`package.json` 的 `build.win.signAndEditExecutable`），**不是旁路引入的差异**。

**产物闸门**（带显式目标，杜绝混合审计）：`npm run verify:dist -- --asar=release/build-20261029-stripfix/win-unpacked/resources/app.asar` → **21 项全 ✔、exit 0**，其中

- `✔ @nikkisync/pc-companion 装载链传递依赖 3 项已全部解包`（`a90a7cf` 新增的 `CHAIN_REQUIRED_ARTIFACTS` 闸门第一次在真产物上被走到）；
- `✔ @nikkisync 四个包入口 + 深入口 row-mappers.js + LocalSyncServer.js + GalleryRuntime.mjs 已解包`（运行时未静默缺失）；
- `✔ 产物无旧仓库链接与失效占位：release\build-20261029-stripfix\win-unpacked\resources\app.asar（32 条禁串、73987071 字节）` ⇒ 回显路径确实是本轮新树，没有偷偷去审 10-27 旧壳。

**回到标准布局**：Setup 四件 `mv` 到 `release/`（FREE，成功）；解包树 `mv` 因新 `app.asar` 被锁而 `Permission denied` ⇒ 改用 `cp -rf release/build-20261029-stripfix/win-unpacked release/win-unpacked`（被锁文件允许读取与就地覆盖、只挡 rename/unlink），标准名下树重建成功（`resources/app.asar` 73,987,071 B + `app.asar.unpacked` + `喵星图.exe` 224,013,312 B）。

**包内字节级验收（「包 == 修复后的源码」的直接判据）**：用 `@electron/asar` 取数（注意坑：`listPackage` 的条目名带反斜杠且有前导分隔符，喂 `extractFile` 前**只能去前导分隔符、不能把反斜杠换成正斜杠**，否则 `was not found in this archive`——本轮第一次就踩了这个）：

| 判据                                                    | 读数                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 标准名 vs 旁路树 `app.asar`                             | sha256 前缀 `2624aa103e35a63f` **两侧全等** ⇒ `cp` 未改内容                                                                                                                                                                                           |
| 包内 `dist\main\main\app\runtime-facade.js`（45,362 B） | `new WeakMap` = **1**、`new WeakSet` = **0**，函数体为 `function stripAssetPathFields(value, depth = 0, memo = new WeakMap()) { ... const remembered = memo.get(value); if (remembered !== void 0) return remembered; ... }` ⇒ **修复真的进了安装包** |
| 包内主入口 vs 盘上 `dist/main/main/app/index.js`        | sha256(16) 均 `57a46bb5ed434f1c`、41,022 B、`MAIN ENTRY MATCH: true` ⇒ 产物树与包内容同一份                                                                                                                                                           |
| 全包 `sourceFolder` 命中文件                            | 2 个：上游 `row-mappers.js`（生产者，本该有）与 `runtime-facade.js`（裁剪者）⇒ 无第三处来源                                                                                                                                                           |

**新包标识**：`release/latest.yml` → `version: 2.5.6-beta`、`size: 184634077`、`sha512: WeL7deJ2euK5q4hvNrpWixhfRjif0fxuWmPdqBqw2nAc2jzAE+HEK739c/bkJi1rr9dVNeOgnsjfGH4z2V9l5A==`、`releaseDate: '2026-10-29T15:38:18.396Z'`；与被归档的旧包（184,427,991 B / `3MlmxC3O…`）在大小与 sha512 两条轴上都不相同 ⇒ 不是「只换 releaseDate」的空重跑。体积 +206,086 B 与「`1e11c0e` 起的本仓改动 + 上游 `b397e0e` 的 `@nikkisync` 产物」一致，且远高于「运行时缺失」的 182,722,373 B 形态。

### 7.8 打包态冒烟（跑在**本轮新产**的标准名树上）

`npm run e2e:smoke` → **16 passed (25.2s)**、`EXIT=0`，取数到的 `[e2e] executable: .../release/win-unpacked/喵星图.exe` 证明起的是新树（不是 `node_modules/electron`）。与本轮修复直接相关的三条：

| 用例                                                                                            | 读数      | 为什么算这条判据                                                                                                  |
| ----------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| S3 preload 注入：`contextBridge` 四个全局对象齐备                                               | ok (7ms)  | 旁路产物与标准产物在桥暴露面上无差异（`window.electronAPI` 完整，历史踩过的 `tsc -b` 覆写产物树那类假失败未出现） |
| N3 查询：协议 DTO 原样透传（含 motion 聚合与**资源绝对路径**）                                  | ok (45ms) | 裁剪**没有过界**：`mode:'path'` 出口在真实会话里仍给绝对路径原值，`media://` 授权链未被本修复打断                 |
| N1/N2/N3b/N3c/N4 六条（真实主进程内起上游 LocalSyncServer、证书真校验、退出链无 `stop failed`） | 全 ok     | 旁路 `electronDist` 换的只是 unpack 机制，装载链与退出链行为等价                                                  |

另有两条既存防线在日志里留痕：`[e2e] stripped ELECTRON_RUN_AS_NODE=1（宿主 shell 泄漏…）`（`60cfe96` 引入的启动环境闸门在本机真实生效，否则整套冒烟会以其症状假失败）；`[DIAG] consoleErrors=[] pageErrors=[]`（全屏诊断用例无 Error 级日志）。`gameRoot=H:\InfinityNikki Launcher\InfinityNikki` 为本机真机库，S7 首装自动扫描 ok。

### 7.9 not-run 与遗留

| 项                                                                                                     | 状态                                  | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 标准配方 `npm run dist:win` 全绿                                                                       | **未成立**（EPERM rename）            | 前提是本机实时防护不给新解压树加锁；根治只有两条：给工作区目录加排除项（加完不必重启）或重启清内核侧句柄。本轮改走旁路出包，产物已用 §7.7 的字节级判据证明等于源码                                                                                                                                                                                                                                                                                                                                                                                                                |
| 渲染层 UI 肉眼验证                                                                                     | **not-run**                           | 该环境无法看屏；冒烟只验协议加载与窗口存在，不覆盖「搜索页响应体里到底还有没有绝对路径」的目视确认。功能判据由 §7.2/§7.4 的单元级红绿与包内字节取数承担                                                                                                                                                                                                                                                                                                                                                                                                                           |
| N4 真上游链路补搜索面断言                                                                              | 本轮不做（用户裁决）                  | 见 §1.4 第 3 行；现有夹具 `metadata_json` 恒 NULL ⇒ 直接加断言是空转绿，须先播种字典富化元数据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `verify-nikkisync-link.ts` 半链接空转表述 / `connection.test.ts` 宽 `readdir` 桩                       | 挂账未改                              | 见 §1.4 第 1、2 行，都有「今天不构成静默口子」的证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `release/build-20261029-stripfix/`（旁路解包残壳）与 `release/win-unpacked.tmp/`（失败的标准流程残留） | 只剩一枚被锁 `.asar`，留在 `release/` | 二者都在 `.gitignore` 的 `release/` 内、不入仓。本轮末态试过清（`rm -rf`）：**除被锁的 `.asar` 外全部删净**，四枚 asar（含新产的标准名树）此刻都探到 LOCKED ⇒ 只挡 rename/unlink，读取与就地覆盖允许。原先担心的 `findAsarUnpacked` readdir 首命中风险被**物理消掉**——`build-*` 侧的 `app.asar.unpacked` 已随残壳其余部分一起消失，闸门不可能再验到它；证据见本节末「裸跑收口」。仍待办：句柄释放后把这两枚孤立 asar 与 `release-sync` 一并删净（`rm -rf release/build-20261029-stripfix release/win-unpacked.tmp release-sync`），否则 `release/` 长期挂着两个只剩一个文件的空壳 |

**裸跑收口（本轮末态判据）**：`npm run verify:dist` **不带任何参数**复跑 → 21 项全 ✔、exit 0，禁串步回显 `产物无旧仓库链接与失效占位：release\win-unpacked\resources\app.asar（32 条禁串、73987071 字节）`。⇒ 末态是「标准位置 + 裸跑闸门自己变绿」，不是靠 `--asar=` 撑着才绿；标准名树 24 项齐（`喵星图.exe` 224,013,312 B + `resources/app.asar` + `resources/app.asar.unpacked`）。

### 7.10 结案：本轮交付与判据

| 交付           | 落点                                                                                                                                          | 客观判据                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 缺陷修复       | `1353cd0` `fix(nikkisync)`（`src/main/nikkisync/runtime-manager.ts` + `runtime-manager.test.ts` + `CHANGELOG.md`，3 files / +176 −9）         | 修复前 2 failed（失败原文在 §7.2）、修复后 77 passed；两次变异抽查各打中恰好 2 例；恢复后 sha256 逐字节一致                                                |
| 审查计划与取证 | `f6a139b` `docs(plans)` + 本节                                                                                                                | `git ls-files docs/plans` 命中本文；`docs:links` exit 0                                                                                                    |
| 卫生修正       | `b0e39ba` `docs(scripts)`（`scripts/AGENTS.md:107` 计数 + `.gitignore` 忽略残壳）                                                             | 计数与 `git ls-files scripts` 逐位对上；`git status --porcelain` 完全为空                                                                                  |
| 新版本安装包   | `release/MeowStarMap-Setup-2.5.6-beta.exe` 184,634,077 B / `latest.yml`（sha512 `WeL7deJ2…`）；旧包归档 `_safe_backup_20261029-pre-stripfix/` | `verify:dist` 21 项全 ✔；包内 `runtime-facade.js` 为 `new WeakMap` 且 `new WeakSet` 计数 0；主入口 sha256 与盘上产物全等；`e2e:smoke` 16 passed 跑在新树上 |
| 版本号         | **零编辑**（四处声明位本就全是 2.5.6-beta）                                                                                                   | `node -e` 读 `package.json`；`check-changelog-release` 三条 ✔                                                                                              |

**下轮准入提示**：① 若想拿「标准配方自己变绿」，先给工作区目录加实时防护排除项（不必重启）或重启，再裸跑 `npm run dist:win`；② `release/` 里剩两枚删不动的孤立 `.asar`（`build-20261029-stripfix/win-unpacked/resources/` 与 `win-unpacked.tmp/resources/`）加 `release-sync/`，句柄释放后 `rm -rf` 三者即可；本轮**裸跑 `verify:dist` 已实测全绿且回显打在新树**，所以它们不再构成闸门指向错树的隐患，只是磁盘空壳；③ §1.4 的三项挂账与 §7.9 的 N4 真上游断言是本轮明确留下的工作项，不是已完成项。
