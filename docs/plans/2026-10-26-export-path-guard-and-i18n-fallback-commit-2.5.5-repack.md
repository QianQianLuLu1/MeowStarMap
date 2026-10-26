# 2026-10-26 导出修复批次：审查收口、提交与 2.5.5 重打包

本轮范围：工作区里一条未提交的「导出修复」批次（25 改 + 2 新增）的独立复核、唯一代码质量缺陷的清偿、回归有效性的变异证实、原子提交，以及据此重新打包 `MeowStarMap-Setup-2.5.5.exe`。

批次起点是两条用户报障：

- 「导出无法使用，选目录导出与导出到默认都不行」
- 「批量导出到一半就断、文件还不全」

## 一、前提取证（台账）

执行前逐条验证请求自带的状态假设，命令一律只读。

| 前提（请求的假设） | 取证命令                                                                                                                                            | 现场读数                                                                                                                                                       | 判定                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 存在未提交代码     | `git status --porcelain=v1`                                                                                                                         | 25 个 `M` + 2 个 `??`                                                                                                                                          | **成立**                                                   |
| 版本号待改为 2.5.5 | `grep -n '"version"' package.json package-lock.json`；`grep -n getVersion src/renderer/preview/mock/database-mock.ts`；`head -1 release/latest.yml` | `package.json:3` = `2.5.5`；`package-lock.json:3` 与 `:9` = `2.5.5`；`database-mock.ts:664` `getVersion: async () => '2.5.5'`；`latest.yml:1` `version: 2.5.5` | **不成立**：四处声明位无一例外，本轮版本号**一处未改**     |
| 产物需重打包       | `ls -l release/*.exe src/main/services/file-service.ts src/renderer/i18n/locales/en.json`                                                           | exe `10-26 19:31`；源码 `20:21 / 20:33 / 20:35`                                                                                                                | **成立**：包内不含这批修复                                 |
| 暂存区/搁置区遗留  | `git diff --cached --stat`、`git stash list`                                                                                                        | 暂存区空；`stash@{0}: On feature/sync-integration-07-bidirectional-sync: phase7-wip-parked`                                                                    | 不成立；该 stash 属另一分支 WIP，**全程未动**              |
| 分支状态           | `git status -sb`、`git log --oneline origin/main..HEAD \| wc -l`                                                                                    | `main...origin/main [ahead 89]`                                                                                                                                | 成立，但本轮**不 push**（未被请求，属外发动作）            |
| 产物是否入仓       | `grep -n "release\|dist" .gitignore`                                                                                                                | `.gitignore:6` `dist/`、`:7` `release/`                                                                                                                        | 被忽略 ⇒ `git status` 永远不显示产物，不能据此判「已提交」 |
| NikkiSync 链接态   | `npm run link:nikkisync:check`                                                                                                                      | `check OK (all four links in place)`，exit 0                                                                                                                   | 已建链 ⇒ 打包含 `@nikkisync/*`，e2e 的 N 套件不被门控跳过  |

现场真值（改动前）：`npm run verify` 5 项 0 失败；`npm test` **446 文件 / 6971 通过 / 12 跳过**，exit 0；`npx eslint <全部改动文件>` exit 0；`npx tsc -b` exit 0；`i18n:guard` / `i18n:check` / `preview:check` / `docs:links` / `check-changelog-release` / `check-doc-versions` 均 exit 0。

## 二、依赖声明

零新增依赖、零版本变更。不引入 npm 包，不改 `package.json` / `package-lock.json` / electron 钉；`@nikkisync/*` 四条 junction 沿用现状，本轮不重建。

## 三、启动与运行说明

工作目录为仓库根，Shell 为 Git Bash。本轮用到的真实命令（均核实存在于 `package.json` scripts）：

```bash
npm run verify              # 只读闸门集：tsc -b + eslint(无 --fix) + core-gate + prettier --check + 相关单测
npx vitest run <文件...>     # 定向套件
npm test                    # 全量单测
npm run i18n:guard          # 语言包键同步守卫
npm run dist:win            # build:recycle-helper → build → pre-dist-check → electron-builder → verify:dist
npm run e2e:smoke           # 打包态冒烟
```

## 四、受影响 IPC 通道清单

本轮**未新增/改名任何通道，未改任何入参 schema 与返回形状**，只订正六条通道的源路径前置校验口径；已按契约同步义务登记在 `docs/IPC_CONTRACT.md` §13。

| 通道               | 源路径校验                                     | 目标目录校验               | 变化     |
| ------------------ | ---------------------------------------------- | -------------------------- | -------- |
| `file:export`      | `assertFileReadPath` → `assertMediaAccessPath` | `assertFileWritePath` 不变 | 口径订正 |
| `file:saveAs`      | 同上                                           | 同上                       | 口径订正 |
| `file:copy`        | 同上                                           | 同上                       | 口径订正 |
| `file:move`        | 同上                                           | 同上                       | 口径订正 |
| `file:rename`      | 同上                                           | 无目标目录参数             | 口径订正 |
| `file:batchRename` | 同上                                           | 无                         | 口径订正 |

i18n 新增 3 个键：`main.file.error.noFilesToExport`、`main.file.message.exportedWithFailures`、`main.file.log.exportItemFailed`（12 语包全部落值，`npm run i18n:guard` 与 `i18n:check` 通过）。

## 五、审查判定：根因与修复（不再改动，仅登记依据）

| #   | 根因                                                                                                                                                                                                                                                                                                                                                                  | 修复落点                                                                            | 复核依据                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 源图读校验用裸 `assertFileReadPath`，且**先于**目标目录写校验执行 ⇒ 两种导出方式以同一 `IPC_PATH_FORBIDDEN` 失败；官方启动器默认装在 `C:\Program Files\InfinityNikki Launcher\...` 命中 `isSensitivePath`，而 `isAllowed` 判定顺序为「黑名单先于 roots」（`src/main/ipc/validator.ts:320` 早于 `:337`），登记扫描根也不放行；`media://` 无此闸门 ⇒ 图库看得见、导不出 | `file-export-handler.ts:49/117`、`file.ts:47`、`file-rename-handler.ts:121/146/174` | `assertMediaAccessPath` 早已存在于 `media-read-guard.ts:109`，`editor-metadata-handler.ts` / `watermark.ts` / `thumbnail-handler.ts` / `file:delete` 为同族先例，非本轮新造                                              |
| 2   | `export.defaultDir` 只在写入时校验，而 `roots` 与 `userPicked` 均为进程内存态、重启即空；导出时该值从设置读出、不再经过对话框 ⇒ 默认目录不在家盘/扫描根下时重启后必失败                                                                                                                                                                                               | `src/main/app/media-update.ts:85-95`（新增第 4 类恢复源）                           | 键在白名单（`src/shared/settings-keys.ts:66`）；写入端 `export-pref-handler.ts:32` 先过 `assertFileWritePath`；`op` 参数只影响文案、读写共用同一 `isAllowed` ⇒ 登记后判定范围不变，非自助扩权                            |
| 3   | `exportFiles` 整个 for 循环包在单一 `try` 里 ⇒ 第 N 个文件抛错即中断其余、只回一条泛化消息、不报已成功数                                                                                                                                                                                                                                                              | `src/main/services/file-service.ts:363-426`                                         | 逐文件 `try/catch` 形态照抄同服务 `batchRename`（`:311-322`）；计数走文案而非新增返回字段（`FileOpResult` 受 DEBT-011 冻结）                                                                                             |
| 4   | 渲染层 `getSelectedFilePaths` 读订阅值，而 `GalleryPage.tsx:475-476` 在同一次事件回调里先写选中态、再同步调用批量操作 ⇒ 闭包持有上一轮集合，**静默导出错的图并回报成功**                                                                                                                                                                                              | `src/renderer/hooks/useBatchOperations.ts:108-114`                                  | 时序真实可达；`DuplicatesPage.tsx:454` 走独立单图路径，不受影响                                                                                                                                                          |
| 5   | 服务层纵深防御：空数组回报成功；「是否转码」与「目标扩展名」绑定 ⇒ `.mp4` 转 `jpg` 产出扩展名自称 jpg 的原始字节文件                                                                                                                                                                                                                                                  | `file-service.ts:333-337`、`:376-377`                                               | 非用户报障成因（UI 只传 `{}` / `{useDefaultDir:true}`），刻意保留为防御                                                                                                                                                  |
| 6   | i18next 默认 `returnEmptyString: true` 把空串当有效译文 ⇒ `fallbackLng` 永不触发，非中文界面导出入口/toast/成功提示全部渲染成空白                                                                                                                                                                                                                                     | `src/main/i18n/index.ts:51-54`、`src/renderer/i18n/index.ts:133-137`                | 实测空串叶子数：zh-CN **0**（故不会退化成显示原始 key），其余 11 包各 2256–2346（与注释宣称「约 2.4k」一致）；12 语包 × 16 个导出相关键经脚本核验无缺失、无空串，`{{count}}` / `{{success}}` / `{{failed}}` 插值全数保留 |

## 六、本轮抓出的缺陷与清偿

### D-1 新增测试文件不符合 prettier（唯一代码质量缺陷，已修）

- 现象：`src/main/ipc/handlers/file-export-handler.test.ts` 有 3 处违规（`:145` 单行超长应拆参数、`:279-281` 三行应合并、`:287-288` 两行应展开）。
- 为什么既有闸门拦不到：`npm run verify` 的目标集取自 `git diff HEAD`，**未跟踪文件根本进不了目标集**，故「verify 5 项 0 失败」从未检查过它的格式——与 2026-10-19 那轮 `e2e/__tests__/nikkisync-guard.test.ts` 是同一个盲区。入仓后会被 lint-staged 的 `prettier --write` 静默改写，属「提交时文件被钩子改掉」。
- 清偿：`npx prettier --write` 该文件。
- 证据：`--check` → `All matched files use Prettier code style!`（exit 0）；去空白归一后前后内容逐字节相同（长度 8471 = 8471，比对结果 `true`）⇒ **断言一字未改**；该文件 12 tests 重跑全绿；文件仍无 BOM（首三字节 `2f 2a 2a` = `/**`）。

### D-2 / D-3 文档欠账（本轮补齐）

CHANGELOG 无本轮条目、`docs/plans/` 无本批次记录，已分别补录（`docs/IPC_CONTRACT.md` §13 随批次已在）。`check-changelog-release.ts` 只强制「`[Unreleased]` 无 `- ` 条目」与「版本节唯一」，`>` 补录行对闸门中性 ⇒ 这两项是**规范欠账而非闸门红灯**。

### D-4 本轮自身的操作失误（如实登记）

补 CHANGELOG 时首次 Edit 误把上一轮条目（`:63`）的行首当作可替换串，导致该条目正文被接到新行之后。已用脚本重排修复，并核实**修复后该行与 `git show HEAD:CHANGELOG.md` 的第 63 行逐字节相同**；最终 `git diff --numstat -- CHANGELOG.md` 为 `2 0`（只增 2 行、删 0 行），LF 行尾、无 BOM、prettier 通过。

## 七、回归有效性：变异抽查（红-绿读数）

批次自带的 20 条新增/改写用例在修复已就位的工作区里必然全绿，故按「测试有效性硬性要求」逐条做变异抽查：临时撤掉对应的生产修复 ⇒ 目标用例必须转红 ⇒ 用 `%TEMP%` 备份还原并断言 `sha256sum -c` 逐字节一致。这批文件都是**未提交的工作区改动**，全程禁用 `git checkout` / `git restore` / `git stash`。

| 变异 | 撤掉的修复                                                                                                               | 红（用例名与计数）                                                                                                                                                                                                   | 还原校验                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| M1   | `file-service.ts:376` `isImageExt(ext) && format !== 'original'` → `format !== 'original'`（「是否转码」重新绑回扩展名） | `exportFiles > P3 非图片源在要求转码格式时保持源扩展名，不产出改了名的原始字节` → **1 failed / 50 passed**（仅目标用例红）                                                                                           | `sha256 570181fe…898ace: OK`                                  |
| M2   | `media-update.ts:88` `roots.push(defaultExportDir)` 注释掉（默认导出目录不再进恢复源）                                   | `refreshPathGuardRoots > 6. export.defaultDir 为非空字符串时注册为恢复根（修复前红）` → **1 failed / 18 passed**                                                                                                     | `sha256 435ed24a…c89aadd: OK`（注：完整值见文件，此处为前缀） |
| M3   | `useBatchOperations.ts:108-114` 还原为读订阅值的旧闭包实现                                                               | `handleBatchExport > 选中态在调用前刚被同步改写时，导出最新选中集而非渲染闭包里的旧值` → `AssertionError: expected "vi.fn()" to be called with arguments: [ [ '/a.jpg' ], '/target', {} ]`，**1 failed / 29 passed** | `sha256 7f701000…a4bedd: OK`                                  |
| M4   | `media-read-guard.ts:111` 去掉媒体白名单快路径（回到「源路径只认 PathGuard」的旧口径）                                   | **11 failed / 16 passed**：`E1` `E2` `E5` `S1` `C1` `M1` `R1` `B1`（本批新用例）+ `D1` `D4` `D5`（`D1/D4` 属既有删除通道用例，因 `assertMediaDeletePath` 委托同一守卫，一并转红符合预期）                            | `sha256 02f21d01…45c36: OK`                                   |

四条变异的关键附带读数：M4 期间负向边界用例 `E3` / `S2` / `X1` / `E4` **保持绿色** ⇒ 它们钉的是「未入库且未授权仍被 `IPC_PATH_FORBIDDEN` 拒绝」与「PathGuard 兜底仍在」，不依赖白名单放行，放宽面确实有界。

全部还原后：`git diff --stat` 回到变异前的 `25 files changed, 508 insertions(+), 190 deletions(-)`，`npm run verify` 5 项 0 失败，定向 5 个套件 **127 tests 全绿**。

## 八、审查过但明确不修（最小化改动，只登记）

| #   | 观察                                                                                                                                                                                                | 判定与理由                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1 | `src/renderer/components/sync/PairingQrDialog.tsx:99-104` 的 1 秒 tick 没有「在途」标志：`getPairingCode` 若**挂起** N 秒，N 个 tick 仍会并发发出 N 次请求                                          | 不修。报障现象（每秒弹一次错误 toast）已由 `:65-73` 的 catch 分支（同步作废 `offerRef`）闭环，且 `generationRef` 保证只有一条结果落地、不会连弹；补在途标志要新增状态位，超出「止住重试风暴」的最小修复面 |
| R-2 | `src/main/ipc/handlers/__tests__/nikkisync-handler.test.ts:197` 的 `beforeEach` 不重置 `pathGuard` 单例（`validator.ts` 无 reset 方法），`:950` / `:1029` 的 `registerUserPickedDir` 泄漏给后续用例 | 不修。当前全绿，负向用例恰好靠「无人登记 `D:\ForgedPhotos`」成立；属可维护性债务而非缺陷，动它需给 `PathGuard` 加 reset API（受保护路径）                                                                 |
| R-3 | `useBatchOperations.ts:168` `handleBatchMove` 仍用渲染闭包里的 `selectedMediaIds`，与已改读 store 的 `getSelectedFilePaths` 构成新旧混用                                                            | 不修。`handleBatchMove` 只被批量工具栏调用（`GalleryPage.tsx:785`），不存在「写完选中态立刻同步调用」的时序，混用不可达                                                                                   |
| R-4 | `file-service.ts:387` 无扩展名源文件在 `convert === false` 时会拿到 `.` 后缀                                                                                                                        | 不修。`format: 'original'` 下改前改后完全一致（非本轮引入），且游戏截图恒带扩展名、UI 从不传非 original 格式                                                                                              |

## 九、执行记录

1. `npx prettier --write src/main/ipc/handlers/file-export-handler.test.ts` → 清偿 D-1，读数见第六节。
2. 变异抽查 M1–M4 → 读数见第七节，四次还原 `sha256sum -c` 全部 `OK`。
3. `CHANGELOG.md` 补录本轮条目 → `git diff --numstat` = `2 0`；`npx tsx scripts/check-changelog-release.ts` → `✅ 变更日志收口校验通过`（exit 0）。
4. 本文件落档 → `npm run docs:links`、`npx vitest run scripts/__tests__/old-name-ledger.test.ts` 读数见下。
5. 五个原子提交（`2970925` `fix(i18n)` → `b496870` `fix(export)` 校验口径 → `9288c33` `fix(export)` 逐文件计数 → `b77d754` `fix(gallery)` 陈旧闭包 → `695a058` `docs(release)`），逐个过 `.husky/pre-commit` 三步（lint-staged / core-gate / `tsc -b`）；core-gate 在 `b496870` 计 3 个受保护文件、`9288c33` 计 1 个，提交后 `git status --porcelain=v1` 为空。
6. 全局回归：`npm test` **446 文件 / 6971 通过 / 12 跳过**、`npm run typecheck`、`npm run typecheck:e2e`、`npm run i18n:guard`、`npm run i18n:check`、`npm run docs:links`、全量 `eslint`、全域 `prettier --check`（含未跟踪新文件）——全部 exit 0，与改动前基线一致、无新增失败项。
7. `npm run dist:win` 重新打包 + `npm run e2e:smoke` 打包态复验 → 读数见第十节。

## 十、重新打包与打包态复验读数

### 10.1 `npm run dist:win`（链尾自带 `verify:dist`），整链 exit 0

- `pre-dist-check`：`✅ 全部校验通过，可以执行打包`。其中 **`✔ git status clean`** 成立（正是先提交再打包的顺序）；第⑤项「产物 mtime ≥ 最新 src mtime」转绿——旧包（19:31）早于本批源码（20:21–20:35），这条机械判据此前正是「包里没有这批修复」的证据；ABI 闸门 `electron=41.10.6 / npmRebuild=true / asarUnpack 已覆盖 better-sqlite3|koffi|sharp|@img`；`afterPack` 随包 `vcruntime140.dll`、`vcruntime140_1.dll`、`msvcp140.dll`、`concrt140.dll`；管理员清单 `requestedExecutionLevel=asInvoker`。
- `electron-builder`：`target=nsis file=release\MeowStarMap-Setup-2.5.5.exe archs=x64`，产物 **21:52:54 / 183,641,784 字节**（上一轮 19:31 为 183,631,854 ⇒ +9,930 字节，与「本批改运行期校验与文案」相符）。
- `--verify-asar`：`✅ 解包产物校验通过`，其中 **`✔ 产物无旧仓库链接与失效占位：app.asar（32 条禁串、71766277 字节）`** ⇒ 禁串命中数为 0（fail-closed 判据，解析不到 asar 也会判失败）；`@nikkisync` 四包入口 + `migrations/0001_initial.sql` + `row-mappers.js` + `LocalSyncServer.js` + `GalleryRuntime.mjs` + 能力深入口 7 项全部解包。
- `release/latest.yml`：`version: 2.5.5`、`sha512: 4SrEmn/T+2gKzQjf19Qso/np53r+qR1uA2Lak7ZGLPxOQNhEBNbWFyZ0lVFNmrtzaNN5BRw+AdtGKKMiotW1Lg==`、`size: 183641784`、`releaseDate: 2026-10-26T13:52:58.634Z`；本机 `certutil -hashfile … SHA512` 得 `e12ac49a7fd3fb68…`，与该 base64 同值 ⇒ yml 与实际包一致，不是陈旧登记。

### 10.2 产物内容实证（不靠「闸门过了」推断「内容在里面」）

对 `release/win-unpacked/resources/app.asar` 的字节做字面量计数，本批改动的标记确在包内：

| 标记                   | 命中 | 标记                                 | 命中 |
| ---------------------- | ---- | ------------------------------------ | ---- |
| `exportedWithFailures` | 25   | `export.defaultDir`（第 4 类恢复源） | 10   |
| `noFilesToExport`      | 25   | `isUserPicked`（三级校验入口）       | 8    |
| `exportItemFailed`     | 25   | `returnEmptyString`                  | 29   |

中文串须按 **utf8** 解码再探：`导出单个文件失败` 2、`部分导出完成：成功` 2、`未选择要导出的文件` 2。按 latin1 解码时这三条恒为 0——那是探针自身的编码问题，**不得据此判「中文文案没进包」**。

### 10.3 `npm run e2e:smoke`：16 passed (25.8s)，exit 0

S1–S8 全部跑在 `release/win-unpacked/喵星图.exe` 上；N1–N4 因 `@nikkisync` 已建链（`linkGate=run`）按原断言执行、未被门控跳过。关键读数：`[DIAG] gridReady=true gridcellCount=20`、`media://` 17 次响应全 200、`consoleErrors=[]` 与 `pageErrors=[]`；S8 `[gpu] reason=default`、活动显卡为 `NVIDIA GeForce RTX 5070`、`2d_canvas / gpu_compositing / opengl / rasterization / video_decode / video_encode / webgl / webgpu` 全 enabled。

### 10.4 两条必须如实登记的判读陷阱（都在本轮真实踩到）

1. **管道尾命令吞掉闸门状态**。第一次跑 e2e 用的是 `npm run e2e:smoke 2>&1 | tail -35`，后台任务据此报 **exit code 0**，而真实状态是 **REAL-EXIT=1、11 failed / 5 did not run**——`$?` 取到的是 `tail` 的状态。这是本仓 `CHANGELOG.md` 与只读取证流程反复警告过的假绿形态，本轮仍踩了一次，改为「重定向到文件 + 直接取退出码」后才拿到真值。
2. **`ELECTRON_RUN_AS_NODE=1` 会让打包态 e2e 全线倒在启动前，且症状看起来像产品回归**。本 agent 的 shell 导出该变量，`喵星图.exe` 因此按**纯 Node 解释器**启动，把 `--remote-debugging-port=0` 与 `--user-data-dir=…` 判为 `bad option`、`exitCode=9`，于是 S1「app:// 协议加载成功」连同 S2–S8、N1 一起失败——没有一条是断言失败。判据不是猜的：同一个 exe 带该变量复现 `bad option`、`unset` 后消失；`unset` 后同一产物 16 例全绿。**后续任何在本机跑的打包态 e2e，都必须显式 `unset ELECTRON_RUN_AS_NODE`（或以 `env -u ELECTRON_RUN_AS_NODE` 起）**，否则会把环境问题报成产品缺陷。

另登记一次自纠：`env -u … npm run e2e:smoke > /tmp/e2e-fixed.log` 那一轮返回 exit 0，但日志 0 字节、`test-results/` 时间戳未变 ⇒ 该轮根本没有执行 Playwright，退出码不可信；改写入仓内 `.cache/` 路径重跑才拿到 44 行真实日志。教训与陷阱 1 同源：**闸门结论必须落在现场读数上，不能落在「命令返回 0」上**。

### 10.5 出货口径

版本号本轮**一处未改**（`package.json:3` / `package-lock.json:3,:9` / `src/renderer/preview/mock/database-mock.ts:664` / `release/latest.yml:1` 实测均已是 `2.5.5`，且无脚本校验这四处、属手工口径）。`latest.yml` 仍写 `2.5.5` ⇒ 已装该版本的用户不会收到自动更新提示，需手动安装新包。本轮共 6 个提交（含本文件所在的补录提交），分支较 `origin/main` 领先 95 个提交且**未 push**——外发动作未被请求。

如实说明两条：`latest.yml` 仍写 `2.5.5` ⇒ 已装 2.5.5 的用户不会收到自动更新提示，需手动安装新包；本轮分支较 `origin/main` 领先 89 个提交且**未 push**（外发动作未被请求）。
