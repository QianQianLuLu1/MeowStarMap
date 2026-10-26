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
5. 五个原子提交（`fix(i18n)` → `fix(export)` 校验口径 → `fix(export)` 逐文件计数 → `fix(gallery)` 陈旧闭包 → `docs(release)`），逐个过 `.husky/pre-commit`。
6. 全局回归：`npm test`、`npm run typecheck`、`npm run typecheck:e2e`、`npm run i18n:guard`、`npm run i18n:check`、`npm run docs:links`、全量 `prettier --check`（含未跟踪新文件）。
7. `npm run dist:win` 重新打包 + `npm run e2e:smoke` 打包态复验。**打包后闸门读数（pre-dist-check 第⑤项产物 mtime、`--verify-asar` 禁串计数、`latest.yml` 新 `sha512`、e2e 冒烟结果）随第六次提交 `docs(release): 补录…` 一并记入本节之后。**

如实说明两条：`latest.yml` 仍写 `2.5.5` ⇒ 已装 2.5.5 的用户不会收到自动更新提示，需手动安装新包；本轮分支较 `origin/main` 领先 89 个提交且**未 push**（外发动作未被请求）。
