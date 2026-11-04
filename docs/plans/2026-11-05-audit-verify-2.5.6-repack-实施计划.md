# 审查 → 修复 → 六闸全绿 → 提交 → 2.5.6 重打包（qrcode 解包缺陷轮 · 2026-11-05）

> 承接 `docs/plans/2026-11-04-fix-nikkisync-unpacked-external-deps-实施计划.md`。那份计划把缺陷查清并落了实现，
> 但实现留在工作区未提交、未出包；本轮是**对那批未提交改动做全面复查**，修掉复查发现的缺陷，跑六道闸门，按节点提交，
> 确认版本 2.5.6，并重新出包让「包里 = 源码里」。

## 一、Context（为什么做这件事）

最后一次出包是 `release/MeowStarMap-Setup-2.5.6.exe`（2026-11-04 07:04，源码树 `eb392ae`）；HEAD 之后的 `f2ec28f` 是纯 docs 提交。
⇒ **代码侧「尚未纳入打包」的范围就是当时那 8 个未提交路径**：`package.json`、`scripts/` 新纯函数层与两份测试、
`pre-dist-check.ts` 新闸门段、同步图库页与其用例（加本计划与上一轮计划的订正）。

装机实锤（`logs/main.log`）：

```
[NIKKISYNC] nikkisync runtime assembly failed: Cannot find package 'qrcode' imported from
  ...\app.asar.unpacked\node_modules\@nikkisync\pc-companion\dist\src\wechat\GalleryRuntime.mjs
```

机制：`@nikkisync` 经 `asarUnpack` 解到 `app.asar.unpacked` 分支，其外部纯 JS 依赖只进 asar 内部的 `node_modules`；
而 Node ESM 从 unpacked 文件**向上走真实目录树**，`app.asar` 是旁支文件，永远够不到里面的 node_modules ⇒ 装配必抛 ⇒
同步图库「扫描游戏相册」与「照片目录」两个症状同根。既有打包闸门只跟随**相对** import 边，bare import 不可见 ⇒ 闸门全绿、产物带病。

## 二、审查范围与结论（10 条，逐条取证）

| #   | 站点                                                                                                                | 结论                                                                                                                                                                                                                                                                                                                                       | 处置                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 1   | `package.json` 的 `build.asarUnpack` 新增 `**/qrcode/**`、`**/dijkstrajs/**`、`**/pngjs/**`                         | **正确且不多不少**：真实 junction 下跑判定链得 `scannedFiles=105`、`seed=["qrcode"]`、`closure=["dijkstrajs","pngjs","qrcode"]`；三包目录均在 `node_modules` 下位                                                                                                                                                                          | 保留                                                                                                   |
| 2   | 新纯函数层（`nikkisync-external-deps.ts`）                                                                          | 三层过滤（相对/内建/`@nikkisync/*` ⇒ bare 内建 ⇒ 包名形态）+ 主入口可达图 BFS + fail-safe 覆盖判定；零 I/O、可单测，符合 `scripts/AGENTS.md` 的「判定核导出为纯函数」                                                                                                                                                                      | 保留                                                                                                   |
| 3   | `scripts/pre-dist-check.ts` 新增「外部依赖在解包树内可解析」闸门                                                    | **真红灯已实测**：带病旧树报 `✖ @nikkisync 外部依赖 qrcode 未随包解到 app.asar.unpacked/node_modules`、EXIT=1；判定核复用 `missingPackedCapabilityArtifacts`，未另抄真相源                                                                                                                                                                 | 保留                                                                                                   |
| 4   | 同段 skip 分支只看 `externalClosure.length === 0`                                                                   | **判据失真**：「dist 扫到了、只是零 bare 依赖」也会打成「解包树无 dist 可扫」                                                                                                                                                                                                                                                              | **N2 修**：按 `nikkisyncDistSources.length` 分流                                                       |
| 5   | `src/renderer/pages/sync-gallery/SyncGalleryPage.tsx:99-104` catch 弹 `showMessage(extractUserMessage(e), 'error')` | **新引入的规范缺陷**：`AppError.preconditionFailed`（`src/shared/errors/app-error.ts:116`）不设 `userMessage` ⇒ `extractUserMessage`（:339-343）退化到 `message`；该 message 由 `src/main/nikkisync/runtime-manager.ts:261` 拼进装配失败原文（含绝对安装路径）⇒ 用户看到未翻译英文 + 本地路径，违反约定 §2；配套用例还把这一形状固化成断言 | **N1 修**：改用既有键 `toast.scanFailed`，详情只留 `console.error`                                     |
| 6   | 走 `useGlobalToast` 而非 `useErrorToast`                                                                            | **不算违规**：`BannerWishButton.tsx:31` 是先例；`useErrorToast` 基于 `useToast` 的本地 `messages`，需页面自挂 Toast 宿主。`showMessage` 是 `useCallback`（稳定），依赖数组加它正确                                                                                                                                                         | 不改                                                                                                   |
| 7   | `scripts/__tests__/pre-dist-check.test.ts` 新增 7 例                                                                | 接线契约 4 例在本轮改动缺席时必红；两条 mkdtempSync 虚拟树行为例（三包齐 / 删 qrcode）有判别力；「空树」例三值全 `[]`，钉的是 skip 形状，**不算回归红例**                                                                                                                                                                                  | 保留，覆盖面如实记账                                                                                   |
| 8   | 上一轮计划节点 4                                                                                                    | **计划与实现分叉**：原文写「行内提示条 + 12 语新增键」，实现走了全局 Toast 且未加键                                                                                                                                                                                                                                                        | 已在原文件加订正行，原文不覆写                                                                         |
| 9   | `node_modules/@nikkisync` 内两个点号重复树（09:01 npm 中断残留，各含完整 `dist`/`migrations`）                      | `build.files` 的对象式整目录拷贝可能把副本带进包并解到 unpacked；现役 07:04 包里 `@nikkisync` 恰为四包，可反证这是新出现的污染                                                                                                                                                                                                             | 出包前清掉（`node_modules` 不入 git、`npm run link:nikkisync` 可重建，可逆），包内断言 unpacked 恰四包 |
| 10  | `CHANGELOG.md`                                                                                                      | 本轮 qrcode 修复**尚未登记**；`check-changelog-release.ts` 要求 `[2.5.6]` 节唯一、`[Unreleased]` 无列表项，否则 `dist:win` 硬失败                                                                                                                                                                                                          | **N4 补录**到既有 `[2.5.6] ### Fixed` 首位                                                             |

**复用证据（第 5 条为什么不新增 12 语键）**：`toast.scanFailed` 已存在（zh-CN「扫描失败」/ en "Scan failed"），其余 10 语该键为空串；
`src/renderer/i18n/index.ts:128-137` 配 `fallbackLng: 'zh-CN'` + `returnEmptyString: false`（注释明写「空串视为未译、回退」）
⇒ 全 locale 都有可读文案，**零语言包改动**。既有消费点是 `ScanButton.tsx:27`、`ScanProgress.tsx:123`，
但**不照抄**它们 `${t(...)}: ${detail}` 的拼接形态——那会继续把路径铺进 UI。单测的 i18n 是真实初始化的
（`tests/setup.ts:20` 导入渲染层 i18n，zh-CN 基准），断言可直接写「扫描失败」。

**属实不修（N3 登记为 DEBT-060）**：`resolveMainEntry` 只读 `package.json` 的 `main`、不读 `exports` ⇒ 未来只用 `exports` 的包会漏报（假绿方向）；
`relativeCandidates` 缺 `.json` 与 `/index.mjs`、`/index.cjs`；`missingUnpackCoverage` 的 `pattern.includes(dep)` 对短名有子串误覆盖风险
——但它只服务开发态配置测试，出货闸门走 `existsSync`。当前三包均有 `main`、实测闭包正确 ⇒ 不改代码，登记一条 debt 而非三条。

## 三、节点划分（涉及文件 / 输入输出 / 验收标准）

### N1 扫描失败可见化改本地化（src 节点，红 + 绿合并一次提交）

- 涉及文件：`src/renderer/pages/sync-gallery/SyncGalleryPage.tsx`、`src/renderer/pages/sync-gallery/SyncGalleryPage.test.tsx`
- 输入：`handleScan` catch 收到的 `unknown`；输出：Toast 文本 = `t('toast.scanFailed')`，`console.error('[sync-gallery] startScan failed', detail)` 保留诊断链；`useCallback` 依赖数组补 `t`
- 红灯（只翻断言、不动实现时）：`npx vitest run src/renderer/pages/sync-gallery/SyncGalleryPage.test.tsx` ⇒ 期望 `received 'NikkiSync runtime is not ready'` / `expected '扫描失败'`
- 绿灯验收：同命令全绿；`npx eslint` 两文件 0 error
- 提交切分原因：本仓 `.husky/pre-commit` 的 lint-staged 对 `src/**/*.{ts,tsx}` 跑匹配套件 ⇒ 刻意留红的 src 提交会被自家闸门拒；
  **不用 `--no-verify`**，改为红测试与修复合并一次提交，并把修复前的红读数写进 commit message 留痕
- 提交：`fix(sync-gallery): 扫描失败改弹本地化文案，英文原文与安装路径只留日志`

### N2 打包闸门 skip 判据分流 + 变异抽查（scripts 节点）

- 涉及文件：`scripts/pre-dist-check.ts`（新段末节）、`package.json`、两份 `scripts/` 新文件（首次入仓）
- 输入/输出：`nikkisyncDistSources.length === 0` ⇒ `skip('解包树无 @nikkisync dist 可扫…')`；`> 0` 且闭包空 ⇒ `pass('@nikkisync 产物无外部 bare 依赖（扫描 N 个产物）')`
- 红灯保持：`npx tsx scripts/pre-dist-check.ts --verify-asar` 对带病旧树仍报 `✖ … qrcode 未随包解到`、EXIT=1（不得削弱判据）
- 变异抽查两次：M1 撤 `package.json` 的 `**/qrcode/**` ⇒ 开发态契约测试当场点名 `qrcode`（补证节点 1 未留下的红灯）；
  M2 撤 `pre-dist-check.ts` 对 `collectRuntimeDepClosure` 的调用 ⇒ 接线契约用例红（证新夹具真在被覆盖）。两次后各以 `sha256sum` 证逐字节还原
- 验收：`npx vitest run scripts/__tests__/nikkisync-unpacked-external-deps.test.ts scripts/__tests__/pre-dist-check.test.ts` 全绿；`npm run typecheck` 无错
- 提交：`fix(pre-dist-check): 外部依赖步按产物扫描数分流，skip 不再冒充「无外部依赖」`

### N3 DEBT-060 登记

- 涉及文件：`docs/debt-registry.json`（`items` 追加一条 + `updatedAt`）、`docs/技术债清单.md`（新增一节，沿用「非 i18n 追加项（日期·轮次）」标题格式）
- 输入/输出：三条判据边界合为一条，含「本轮不修的原因」
- 验收：JSON 可解析且 `items.length === 60`；`npm run debt:check` 正常执行（该脚本恒 exit 0）
- 提交：`docs(debt): 登记外部依赖闭包判据三条边界为 DEBT-060`

### N4 CHANGELOG 补录

- 涉及文件：`CHANGELOG.md`（既有 `## [2.5.6] - 2026-11-01` 节的 `### Fixed` 首位追加一条）
- 输入/输出：根因 + 三包 unpack + 两道闸门 + 装机复现 + 两处复查修复，引用两份计划文档
- 验收：`npx tsx scripts/check-changelog-release.ts` 三条 ✔（版本节存在且唯一、`[Unreleased]` 已收口）；`npm run docs:links` 退出码 0
  （依赖 N0 已把计划文档 `git add` 进 tracked 集——`check-md-links.ts` 判存在用 `git ls-files`，不用 `fs.existsSync`）
- 提交：`docs(release): qrcode 解包缺陷轮处置登记入 2.5.6 变更日志`

### N5 六道闸门 + 重打包（第四节时间线）

### N6 读数回写

- 涉及文件：本文件（补齐红绿矩阵、六道闸门实测读数、包内取证、旁路与否实况）
- 验收：文档读数与命令输出逐条对得上；提交后 `git status --porcelain` 只剩工具链抖动（须还原）
- 提交：`docs(plans): 回写审查读数、六道闸门实测与 2.5.6 重打包取证`

## 四、六项闸门与重打包执行时间线（串行，不可并行）

1. `npm install` ⇒ 判绿：退出码 0。随即 `git status --porcelain package-lock.json`：本机 Node v24.18.0 与 CI 钉的 22 不同源，
   历史上会重写 lock（删 ffmpeg-static/ffprobe-static 的 `libc` 字段）⇒ 按既定口径**还原、不提交**（该文件本轮开工前不在改动集内，无用户工作可失）。
2. `npm run link:nikkisync && npm run link:nikkisync:check` ⇒ install 会**静默剪掉**四条 junction（后果是包缺整个内嵌运行时、少约 608KB，
   由 `verify:dist` 的 `nikkiSyncPackedVerdict` 拦），必须在此重链；同时清掉审查发现第 9 条的两个点号残留。判绿：四包链接与 `dist` 产物在位、无 blocking failure。
3. `npm run typecheck`（`tsc -b` + `tsc -p tsconfig.scripts.json`）→ `npm test` → `npm run build`。判绿：退出码 0；
   `npm test` 报文件数/通过数/跳过数，与基线做「总数差 == 新增例数」核对（链接在否会让 `*.linked` 套件通过数漂移约 ±39，比对前先报 check 状态）。
4. `npm run e2e:smoke`（第一次，验现役包无回归）与 `npm run test:ci-linux`（只读诊断，补齐宿主身份四轴）。
   判绿：smoke 打印 `[e2e] executable: release/win-unpacked/喵星图.exe` 且用例全过；`test:ci-linux` 退出码 0。
5. `npm run pre-dist-check` → 归档现役三包到 `_safe_backup_20261105-qrcodefix`（`release/` 不入 git，不备份即不可再生）→ `npm run dist:win`。
   - 失败分支（本机历史必现的 `EPERM rename('release\\win-unpacked.tmp' -> 'release\\win-unpacked')` / `EBUSY unlink`）：
     从官方 electron 缓存解一份排除 `resources/default_app.asar` 与 `version` 到 `.cache/electron-dist-clean`，跑
     `npx electron-builder --win --publish never --config.electronDist=<该目录> --config.directories.output=release/build-20261105-qrcode`，
     再用 **`cp -rf`（不是 `mv`——被锁文件只挡 rename/unlink，读取与就地覆盖允许）** 把 `win-unpacked` 建回 `release/`，
     并把 exe / blockmap / `latest.yml` 搬回标准布局。判绿：`npm run verify:dist` **不带参数**裸跑全绿，禁串步回显待审的是新树。
   - 长步骤走后台执行时，判定成败读日志里的内层 `EXIT=` / `⨯` 行，不信通知摘要（包装层退出码不可信）。
6. `npx tsx scripts/pre-dist-check.ts --verify-asar`（新树）⇒ 判绿：外部依赖步转 `✔ @nikkisync 外部依赖闭包 3 包已在解包树内可解析（dijkstrajs, pngjs, qrcode）`、EXIT=0。
   这条是本轮缺陷的产物级收口。
7. 包内取证三条固定判据：① unpacked 的 `@nikkisync` 恰为 core/database/protocol/pc-companion 四项（证第 9 条已清）；
   ② 用 `@electron/asar` 的 `listPackage` + `extractFile` 取包内主入口，与盘上 `dist/main/main/app/index.js` 逐字节 `equals`
   （条目名是**反斜杠带前导 `\`**，只能去前导分隔符，绝不能把 `\` 换成 `/`）；③ 新旧 `latest.yml` 的 `size` 与 `sha512` **两轴都不同**（防空重跑）。
8. `npm run e2e:smoke`（第二次，验新包）→ `npm run typecheck:e2e` → `npm run lint` → `npm run i18n:guard` → `npm run test:ci-linux` 复跑 → `npm run verify`。判绿：全部退出码 0。
9. N6 回写并提交，使「包里 = 源码里」。

**版本号 2.5.6：零编辑。** 判据：`package.json:3` 已是 `"2.5.6"`，`check-changelog-release.ts` 的「版本节存在且唯一」✔，
本轮无版本变更 ⇒ 不为凑任务造改动。`scripts/check-doc-versions.ts` 只管 README 的 Electron 版本，与应用版本无关。

## 五、依赖声明 / 错误处理 / 参数校验 / 测试用例

- **依赖声明**：零新增依赖。`qrcode ^1.5.4` 已在根 `dependencies`；`dijkstrajs`、`pngjs` 是其已安装的传递依赖（自身零依赖）。
  不引入 minimatch——覆盖判据沿用仓内既有 `pattern.includes(name)` 同款（`scripts/AGENTS.md` 记的判据同源约定）。
- **启动与运行**：`npm run dev` 开发态；`npm run dist:win` 出包（`build:recycle-helper` → `build` → `pre-dist-check` → `electron-builder` → `verify:dist`）；
  `npm run verify:dist` 打包后 asar 校验；`npm run verify` 变更后只读验证集。全部命令已在本仓 `package.json` 实测存在。
- **错误处理**：闸门对「事实不可得」不放行——`collectModuleTree` 读不动的文件如实跳过，但判定核是「多扫更严」方向；
  `nikkiSyncPackedVerdict` 的 skip/fail/pass 三分支不变（空壳仍 fail，不降级成 skip）；无 `unpackedRoot` 时 `fail` 不 `skip`。
  渲染层 catch 保留 `console.error` 诊断链（渲染层错误上报依赖它），UI 只出本地化文案。主进程不改——`runtime-manager` / handler 已如实落日志与状态快照。
- **参数校验**：`missingUnpackCoverage(deps, asarUnpack)` 遇非数组 / 非字符串 / 空串条目一律判「未覆盖」（fail-safe，宁误拦不放过）；
  `packageRootOf` 对空串、相对路径、`node:`/`bun:`、bare 内建，以及 esbuild/browserify 产物里 `from ", "` 这类误命中串
  （形态校验 `^[@A-Za-z][@A-Za-z0-9/._-]*$`）一律返回 `undefined`；`relativeCandidates` 按 CJS 扩展解析序；`resolveMainEntry` 坏 JSON 回落 `index.js`（只少扫、不误报）。
- **测试用例三类**：正常（三包齐 ⇒ 闭包钉住三包且 `missing=[]`；成功扫描不弹错误 Toast）；
  异常（删 `qrcode` 目录 ⇒ 判定链点名 `qrcode`，即缺陷本体复现；`startScan` reject ⇒ 弹本地化失败 Toast）；
  边界（解包树无 dist ⇒ 种子/闭包/缺失三段皆空、不点名；`collectNikkiSyncExternalDeps` 对空文件集与非字符串 content 返回空集）。

## 六、红线自查

不 skip、不删改测试、不弱化断言、不 `--no-verify`；命令与文件均先在 `package.json` / 仓库中确认存在（不存在 `npm run install`，用的是 `npm install` 本身）；
预期读数与实测不符时在文档里显式订正、保留原句，而不是改计划迁就实际；全量回归有一项不绿即不标记完成。

## 七、风险与如实声明

1. 本机实时防护可能锁死标准配方（历史上 `QQPCRTP.exe` 对新解压的 `default_app.asar` 毫秒级抓句柄并长时间持有）。已备好第 5 步旁路，
   **旁路不改任何配置文件**；若连旁路也失败，如实报「前提不成立 + 唯一剩余动作」，不伪造成功。
2. `npm install` 与出包强耦合：install 拆链 ⇒ 忘重链接就会出一个「静默缺内嵌运行时」的包。第 2 步是硬约束，不可挪。
3. 点号残留清理只落 `node_modules`（gitignore 内、可经 `link:nikkisync` 重建），不触碰任何被跟踪文件；判据在第 7 步用包内目录项数实测，不靠推断。
4. `e2e:smoke` 是打包态入口（读 `release/win-unpacked/*.exe`），第一次跑验的是**旧包**——它的绿只证明旧包无回归；本轮修复的验收在第 8 步的第二次。
5. `findAsarUnpacked` 取 readdir 首命中且无显式选择参数（既有弱点，不因环境清干净就从遗留清单里划掉）。

## 八、执行读数（2026-11-05 回写，全部为实测）

### 8.1 六道闸门（按任务书顺序）

| 命令                    | 退出码        | 关键读数                                                                                                                                                                                                          |
| ----------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install`           | 0             | 输出 `removed 4 packages` ⇒ 即四条 `@nikkisync` junction 被剪（本机既定现象，非真依赖）。随即 `npm run link:nikkisync` 重建四条 + `npm run link:nikkisync:check` 报 `check OK (all four links in place)`          |
| `npm run build`         | 0             | `✓ built in 5.28s`；主/渲染/preload 产物全出                                                                                                                                                                      |
| `npm test`              | 0             | **Test Files 470 passed (470)**，**Tests 7516 passed \| 20 skipped (7536)**，72.96s；链接态 `sync-server.linked.test.ts` 14 例**实跑**（最长单例 23.0s）⇒ 未降级为 skip                                           |
| `npm run typecheck`     | 0             | `tsc -b` + `tsc -p tsconfig.scripts.json` 两步皆无输出                                                                                                                                                            |
| `npm run e2e:smoke`     | 0（**两次**） | 各 **19 passed**（41s 级）。第一次对 07:04 旧包（只证现役包无回归）；第二次对 11:14 新包，打印 `[e2e] executable: …/release/win-unpacked/喵星图.exe`，打包态 S1–S8 + 未打包 NikkiSync N1–N4 + 照片目录 G1–G3 全过 |
| `npm run test:ci-linux` | 0             | **Test Files 470 passed**，**Tests 7533 passed \| 3 skipped (7536)**，56.26s（与全量口径的差异来自装置下宿主门控的分配，两侧文件集一致）                                                                          |

另附：`npm run typecheck:e2e` 0、`npm run i18n:guard` ✅（本轮未新增 i18n 键）、`npm run lint`（全量 `eslint .`）0、`npm run verify` ✅（0 项 0 失败——此时源码已全部提交，工作树无变更，如实记为空集而非跳过）。

**`package-lock.json` 实况订正**：计划第 1 步预留了「本机 npm 重写 lock ⇒ 还原不提交」的分支，实测 `git hash-object package-lock.json` == `git rev-parse HEAD:package-lock.json`（同 `d72cad39…`）⇒ **内容零变化**，` M` 只是 `core.autocrlf` 的 stat 抖动 ⇒ 本轮无抖动可还原，也不为此造提交。

### 8.2 红→绿矩阵

| 节点               | 修复前（红灯原文）                                                                                                                                                                                                                                                                                                                         | 修复后                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| N1 扫描失败文案    | 只翻断言、未动实现：`AssertionError: expected "vi.fn()" to be called with arguments: [ '扫描失败', 'error' ]` / received `+ "NikkiSync runtime is not ready (Cannot find package 'qrcode' imported from D:\\App\\resources\\app.asar.unpacked\\node_modules\\@nikkisync\\pc-companion\\dist\\x.mjs)"` ⇒ `Tests 1 failed \| 11 passed (12)` | `Tests 12 passed (12)`；eslint 0、prettier `All matched files use Prettier code style!`                                                    |
| N2 skip 判据分流   | 新增接线契约用例：`AssertionError: expected '…' to match /nikkisyncDistSources\.length === 0/` ⇒ `Tests 1 failed \| 59 passed (60)`                                                                                                                                                                                                        | 两测试文件合跑 `Tests 73 passed (73)`                                                                                                      |
| 缺陷本体（产物级） | `npx tsx scripts/pre-dist-check.ts --verify-asar` 对 07:04 带病树：`✖ @nikkisync 外部依赖 qrcode 未随包解到 app.asar.unpacked/node_modules…`，EXIT=1，`❌ 解包产物校验失败，禁止发布`                                                                                                                                                      | 新树：`✔ @nikkisync 外部依赖闭包 3 包已在解包树内可解析（dijkstrajs, pngjs, qrcode）`，`npm run verify:dist` EXIT=0，`✅ 解包产物校验通过` |

### 8.3 变异抽查两次（含一处把推断升级为实测）

- **M2**（撤调用）：把 `collectRuntimeDepClosure(externalSeed, unpackedPort)` 改成 `externalSeed` ⇒ `× 接线契约：须对种子求运行时传递闭包（修复前必红）`，且**只有这一条红**（行为两例照绿）⇒ 证新增夹具真在被判据覆盖、也证「只靠行为例不够」。还原 `sha256 = fa1aab3ee6de2c0061a9…` 与变异前全等，复跑 73 passed。
- **M1**（撤覆盖）分两步才做对：先把 `**/qrcode/**` 改成 `**/qrcode-MUTATION-PROBE/**` ⇒ **测试不红**（`pattern.includes('qrcode')` 仍命中）；再改成 `**/qr-code/**` ⇒ `AssertionError: 以下 @nikkisync 外部依赖未被 build.asarUnpack 覆盖…：qrcode；expected [ 'qrcode' ] to deeply equal []`。还原 `sha256 = 203f60f8a4ff05f1…` 全等，复跑 13 passed。
- **由此把 DEBT-060 的第 ③ 条从「可能有子串误覆盖」升级为「已复现」**，措辞已同步 registry 与清单 §23。

### 8.4 出包实况：标准配方被打断，旁路交付到标准位置

1. 归档现役三包到 `_safe_backup_20261105-qrcodefix/`（exe 184,745,991 B / sha512 `sB80bljpqjVc…` / releaseDate 2026-11-03T23:04Z）——`release/` 不入 git，不归档即不可再生。
2. `npm run dist:win` **INNER_EXIT=1**：`⨯ EPERM: operation not permitted, rename '…\release\win-unpacked.tmp' -> '…\release\win-unpacked'`（栈在 `app-builder-lib/src/util/electronGet.ts:249`，即 builder 已成功删掉旧 `win-unpacked`、红在把**刚解压好**的 tmp 改名过去）⇒ 本机杀软对每次新解压主动加锁的既有实况，不是仓库缺陷。同轮 `pre-dist-check` 前置 27+ 项、`@electron/rebuild`、Electron 解压全绿。
3. 旁路（不改任何配置文件）：从官方缓存 `…/electron/Cache/5d86dd63…/electron-v41.10.6-win32-x64.zip`（与另一缓存项 sha256 全等 `5447c50d…`）解到 `.cache/electron-dist-clean`，排除 `resources/default_app.asar` 与 `version`（解后实测连 `resources/` 都不存在，与既定口径一致）；`npx electron-builder --win --publish never --config.electronDist=<该目录> --config.directories.output=release/build-20261105-qrcode` ⇒ EXIT=0。
4. **`cp -rf`（不是 `mv`）** 把 `win-unpacked` 建回 `release/`，再把 exe/blockmap/latest.yml 搬回标准布局；`cp` 等价性当场证：两侧 `app.asar` sha256 全等 `8a36aa3652d7fae0…`。
5. `npm run verify:dist` **不带参数**裸跑 EXIT=0，且禁串步回显待审对象是 `release\win-unpacked\resources\app.asar`（新树，32 条禁串 / 73,078,028 字节）⇒ 陈旧树假绿路径未复现（DEBT-054 已把解包根改为由待审 asar 派生，`findAsarUnpacked` 在 `scripts/` 内 0 命中）。

### 8.5 包内取证五判据

1. `app.asar.unpacked/node_modules/@nikkisync` 目录项 = `["core","database","pc-companion","protocol"]`（**恰四包**）⇒ 计划第 9 条担心的点号重复树没有进包。**订正**：那两个 `.{database,pc-companion}-*` 残留并非需要手工删除——`npm install` 的收敛 + `link:nikkisync` 重链已把它们带走（实测 `ls -a` 只剩四包），故清污动作取消、判据改由本条包内实测承担。
2. `qrcode`（version 1.5.4）、`dijkstrajs`、`pngjs` 三者目录与其 `main` 入口文件在 unpacked 内均实测存在。
3. 包内 `dist\main\main\app\index.js`（`@electron/asar` `listPackage` + `extractFile`，条目名只去前导分隔符、未把 `\` 换成 `/`）sha256 前缀 `bb114f69cda21d53` 与盘上 `dist/main/main/app/index.js` **逐字节 equals=true**。
4. 渲染层修复确在包里：asar 内 `toast.scanFailed` 命中 **3**；`dist/renderer/assets/SyncGalleryPage-Cb9XeQ30.js` 内命中新键、旧形状 `showMessage(extractUserMessage` 命中 **0**（全仓唯一残留在 `ResonanceRecordsPage` chunk，属他页既有用法，不在本轮范围）。
5. 防「空重跑」两轴都不同：`size` 184,745,991 → **184,895,319**（+149,328 B，即三包解出带来的落盘差）；`sha512` `sB80bljpqjVc…` → **`iHqt4SDsGvl9…`**。

### 8.6 版本号

**2.5.6 零编辑**：`package.json:3` 本就是 `"2.5.6"`；`npx tsx scripts/check-changelog-release.ts` 三条 ✔（解析到 15 个版本节，最新 2.5.6 与 package.json 一致 / `[2.5.6]` 存在且唯一 / `[Unreleased]` 已收口）。本轮无版本变更，不造改动凑任务。

### 8.7 提交切分实况

`8a49e02`(N0 计划落仓) → `daaa49d`(N1) → `c9bfcd3`(N2) → `9ace93c`(N3) → `297ab5c`(N4) → 本提交(N6 回写)；未 push（沿用裁决）、未补 `v2.5.6` tag。

### 8.8 现场残留

`release/` = 本轮新包三件 + `win-unpacked`（新树）+ `build-20261105-qrcode`（旁路整树留底，其 `win-unpacked` 与标准名树 `app.asar` 哈希全等）+ 历史 7 棵 `build-*` + `win-unpacked.tmp`（标准配方失败时的半成品，被杀软句柄占住，删不动 ⇒ 如实留置，不谎称已清）。旧包三件在 `_safe_backup_20261105-qrcodefix/`。

**订正（同日 11:22，用户要求清掉 `win-unpacked.tmp`）**：`fs.rmSync(recursive,force,maxRetries:10,retryDelay:2000)`
**已成功清光该树除一颗 asar 外的全部内容**（143MB → 116K，`du -sh` 实测），余 `resources/default_app.asar` 一颗；
对它「就地截断到 0 字节」**成功**（`truncateSync` 可行，印证被锁文件只挡 rename/unlink、允许就地覆盖），
但 `unlink` 连续 7 次 `EBUSY`、同目录改名与整目录改名 `EPERM`、自底向上 `rmdir` `ENOTEMPTY` ⇒ **句柄仍在且不带 delete 共享**。
早先「独占打开报 FREE」的判据**不可信**：libuv `openSync` 无法指定 share 模式（默认 READ|WRITE 不含 DELETE），
它只证明「无人独占」不证明「可删」——判可删要直接用 `unlink`/同目录改名本身。本机 RestartManager 不可用（`rmcore.dll` 缺失），
历史两批同形句柄一批 1.5–2h 自释、一批不自释 ⇒ **唯一确定清法是重启后 `rm -rf release/win-unpacked.tmp`**。
影响面如实限定：该残壳已**不含 `app.asar.unpacked`**（`find` 实测 0 命中），不会被 `findAsarUnpacked` 当成待审目标、不干扰 `verify:dist`；
但下次裸跑 `npm run dist:win` 会死在 builder 自己那句 `fs.rm`（`force` 只吞 ENOENT 不吞 EBUSY）⇒ 重启后先清，或继续走旁路。
