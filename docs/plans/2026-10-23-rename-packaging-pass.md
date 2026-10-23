# 阶段 4 执行记录：打包、构建与流水线配置更名（喵星图 / Meow Star Map）

> **状态**：已交付，并已在本次真实跑出 `release/MeowStarMap-Setup-2.5.5-beta.exe` 与
> `release/win-unpacked/喵星图.exe`。诊断目录名与 `%TEMP%` 日志名（N2）、数据库与备份文件名前缀链（N3）、
> 同步面可见标识（N4）**未在本轮执行**。
> **日期**：2026-10-23
> **上游计划**：[`2026-10-23-project-rename-meow-star-map.md`](./2026-10-23-project-rename-meow-star-map.md)
> （§1.1 名称映射表为唯一取值依据，§1.2 为禁改清单；本轮执行其中的 N1 与 N7 的打包/流水线部分）
> **前置记录**：[`2026-10-23-rename-docs-pass.md`](./2026-10-23-rename-docs-pass.md)（阶段 2 文档与署名层）、
> [`2026-10-23-rename-ui-i18n-pass.md`](./2026-10-23-rename-ui-i18n-pass.md)（阶段 3 界面文字层）

本轮范围 = 由构建配置决定的对外名称：npm 包名与 `%APPDATA%` 数据根、NSIS 的 appId / productName /
artifactName / shortcutName（⇒ exe 文件名、任务管理器进程名、快捷方式名、卸载显示名、默认安装目录名）、
CI 上传产物名，以及构建脚本与开发自检脚本里的产品自称。执行约束沿用阶段 1：只改名称值，不动逻辑、
URL、目录结构与依赖清单；一把锁一个提交；绿灯判据取「残留逐字等于台账」而非命中数上限。

## 一、本轮边界（用户逐项确认）

| #   | 决策点                                                           | 结论                                                                                             |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | CI 宿主装置的 `/home/runner/work/NikkiGallery/NikkiGallery` 四处 | **改**，7 处字面同 commit（推翻 2026-10-21 记录的「登记观察项，本轮不改」）                      |
| 2   | `docs/sync-integration/verify-audit.mjs:39` 的包名断言           | **同批改为新包名**（可执行断言属代码，不属叙述；同文件 `:179-196` 的 `WXNN XiangCe` 目录名不动） |
| 3   | 只影响测试 / 预览 mock 的假路径                                  | **全改**（含 `e2e/perf-real.e2e.ts:15` 的示例注释）                                              |
| 4   | 阶段 3 登记的 `preview-worker-<hash>.js` 工装缺口                | **本阶段顺带修**；实测发现 ESLint 9 不读 `.gitignore` ⇒ 同时补 `eslint.config.js` 的 ignores     |
| 5   | 是否真跑 Windows 打包                                            | **跑完整 `npm run dist:win`**（含 `verify:dist`）；实测通过，未采用「跳过 verify:dist」的退路    |

## 二、本轮是真红：先实测再说

阶段 3 的教训是「语包已被阶段 2 改完，若宣称红灯就是假交付」。本轮开工前先跑扫描与守卫，确认红灯成立：

| 判据           | 命令                                                                                                                                                               | 红灯读数（改动前）                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| 域内旧名扫描   | `git grep -n -F -f .cache/rename-scan/old-names-stage3.txt -- package.json package-lock.json .github scripts e2e tests docs/sync-integration/verify-audit.mjs src` | **271 行 / 71 文件**（`red-stage4.txt`） |
| 打包身份六字段 | `npx vitest run scripts/__tests__/pack-identity-name.test.ts`                                                                                                      | **9 failed / 13 passed（22）**           |
| userData 根组  | 同上（加断言后）                                                                                                                                                   | **9 failed / 22 passed（31）**           |
| 装置四站点组   | 同上                                                                                                                                                               | **4 failed / 32 passed（36）**           |
| doctor 横幅组  | 同上                                                                                                                                                               | **1 failed / 36 passed（37）**           |

旧名模式清单**无需新增条目**：`NikkiGallery-Setup-`、`NikkiGallery-win-x64-nsis`、
`/home/runner/work/NikkiGallery`、`nikki-gallery-test` 这些字面形态都被既有的 `NikkiGallery` /
`nikki-gallery` / `wxnn-photo-manager` 吃掉；本轮真正缺的是**扫描域**（阶段 2 扫文档、阶段 3 扫
`src` + `plugins-samples`，都没扫配置与 CI 面）。

## 三、提交清单（一把锁一个提交）

| #   | SHA       | 内容                                                                                                         | 站点数           |
| --- | --------- | ------------------------------------------------------------------------------------------------------------ | ---------------- |
| 1   | `d556a2a` | `refactor(pack-identity)`：package.json 六字段 + lock 两处 + build.yml 产物名 + verify-audit 断言 + 新守卫   | 10 改 + 1 新文件 |
| 2   | `216c20c` | `refactor(userdata-root)`：logger / e2e helpers / simulate-gpu-crash / perf-real 示例 / 四处测试与 mock 夹具 | 18 改            |
| 3   | `bf311dc` | `test(guard)`：守卫补 userData 根与假路径两组（9 条）                                                        | 1 文件           |
| 4   | `7a460fa` | `test(ci-rig)`：装置工作区根 7 处同批 + 守卫自身宿主漂移修正                                                 | 7 改             |
| 5   | `7ce73d4` | `refactor(doctor)`：诊断横幅自称与新名，按显示宽度配平                                                       | 1 改             |
| 6   | `83652b3` | `chore(tooling)`：`.gitignore` + `eslint.config.js` 各一行（纯配置，无名称）                                 | 2 改             |
| 7   | `f35b1fc` | `fix(guard)`：补 `PackageJson.version` 字段（`npm run typecheck` 抓出）                                      | 1 改             |
| 8   | 本次      | `docs(plans)`：本执行记录 + 阶段 1/3 指向更新                                                                | —                |

改动面合计 **20 个文件**，逐行改动经 `.cache/rename-scan/apply.mjs` 锚定落地
（`edits-stage4-c1.json` … `edits-stage4-c4.json`），未使用任何全局替换。

第 3 笔是对第 2 笔的补写而非新节点：第 2 笔按路径暂存时漏掉了守卫文件，**HEAD 处不存在红灯**
（当时守卫是 C1 的 22 条，全绿），只是「锁与源码」被分在两笔，已在此如实交代。

## 四、取值与决定关系（本轮实际生效的因果链）

- `build.productName` = `喵星图` ⇒ **exe 文件名** `喵星图.exe`（`appInfo.js:56-57`：`executableName`
  未配置时取 `sanitizedProductName`）、**卸载显示名**（`NsisTarget.js:473` 默认
  `${productName} ${version}`）、**默认安装目录名**。
- `build.nsis.shortcutName` = `喵星图` ⇒ 开始菜单快捷方式名（`NsisTarget.js:461` 的 `SHORTCUT_NAME`）；
  与阶段 3 已改的运行时 `.lnk` 文件名归一，闭合阶段 3 偏差 2。
- `name` = `meow-star-map` ⇒ **userData 根** `%APPDATA%\meow-star-map` 与 `updaterCacheDirName`。
- `artifactName` = `MeowStarMap-Setup-${version}.${ext}` ⇒ 安装包文件名与 `latest.yml` 的 `path:` 字段。
- 阶段 1 §C 的关键结论本轮得到实测确证：从产出的 `app.asar` 里取出的 `package.json`
  `name = meow-star-map` 且 **不含 `productName`** ⇒ userData 根跟随 `name` 而非 `productName`。

## 五、闸门读数

| 命令                                                          | 结果                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                    | **432 files passed / 3 skipped，6632 passed / 51 skipped**；较阶段 3 末（431 / 6595）恰为 +1 文件 +37 用例 = 新守卫自身                                                                                                         |
| `npx vitest run scripts/__tests__/pack-identity-name.test.ts` | **37 passed**，且 default / `vitest.posix-host.config.ts` / `vitest.ci-linux.config.ts` **三种 profile 下同为 37 passed**                                                                                                       |
| `npm run verify:staged`（逐节点）                             | 每节点 5 项全 ✓（typecheck / lint / core-gate / format / test）                                                                                                                                                                 |
| `npm run lint`                                                | 0 error（且在 `preview-worker-*.js` 实体存在的状态下复跑，见第七节反向取证）                                                                                                                                                    |
| `npm run typecheck` / `npm run typecheck:e2e`                 | 通过。typecheck 抓出守卫自身的 TS2339（接口漏 `version`），已修；`scripts/**` 不在 `tsc -b` 覆盖面内，**只有全量 typecheck 能收到**                                                                                             |
| `npx tsx scripts/core-path-gate.ts`                           | `⊘ 本次变更不涉及核心路径受保护文件，跳过`——本轮 20 个文件全部不在 `PROTECTED_DIRS` 内 ⇒ 无需 `@core-change`                                                                                                                    |
| `npm run i18n:guard` / `npm run i18n:check`                   | ✅（本轮未动语包）                                                                                                                                                                                                              |
| `npm run docs:links`                                          | ✅ 无死引用（153 处提醒，与阶段 1/2/3 基线同值）                                                                                                                                                                                |
| `npm run test:ci-linux`                                       | 26 failed / 406 passed / 3 skipped；**失败文件集与阶段 3 台账逐字相同（去 ANSI 后 26 文件，`diff` 为空）**，根因仍是本机缺 Linux 原生绑定与装置伪造 cwd 下的 git 依赖型守卫，与本轮改动文件交集为空                             |
| `npm run doctor`                                              | 横幅三行框线对齐，5 项检查全 OK                                                                                                                                                                                                 |
| 编码（20 个改动文件逐一取首 3 字节）                          | 全部无 BOM；未混入单行 CRLF                                                                                                                                                                                                     |
| 锁文件同步取证                                                | `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` 后 `git diff --numstat -- package-lock.json` = **2 增 2 删**、`-U0` 的 4 行全部是 `"name"` 行、`"libc"` 字段计数仍为 **16**（未产生历史多轮那种 churn） |

### 两条「拆半必红」取证（证明锁真实存在，不是事后追认）

1. `src/renderer/utils/thumbnail-src.test.tsx` 只改第 15 行（反斜杠夹具）不改第 17 行（正斜杠期望值）⇒
   该套件 **1 failed / 5 passed**（`media://` URL 的 `path` 参数按 `Object.is` 判等）；还原后两行同批改，转绿。
2. 装置只改 `tests/ci-linux.setup.ts` 两行、把 `CI_ROOT` 留在旧值 ⇒
   `npx vitest run --config vitest.ci-linux.config.ts src/main/utils/ci-linux-emulation.test.ts` 报
   **轴 3（cwd / homedir / tmpdir）与轴 4b（经 cwd 拼出的工作区路径）各 1 条红**（2 failed / 10 passed）；
   补齐 7 处后 12 passed。

`scripts/__tests__/path-semantics-guard.test.ts` 的 PINNED / DIALECT / HOST_IO 三张登记表**无需同步**：
实测它对本装置只断言「文件存在 + 七轴 token 在场 + `pkg.scripts['test:ci-linux']` 指向复现配置」，
不钉 `CI_ROOT` 字面值。故 2026-10-21 记录里「改它需同步 path-semantics-guard 登记表」那句在今天已不成立。

## 六、打包实测（本轮拿到的真实产物证据）

前置修复：本机 `node_modules/@nikkisync/*` 四条曾退化成**空目录**（`readdirSync` 返回 0 项、
`core/package.json` 不存在），`npm run link:nikkisync` 重建后 `npm run verify:nikkisync` 报
`OK (blocking failures: 0)`，才具备跑完整 `dist:win` 的条件。链接目标是
`../NikkiSync/apps/pc-companion`（不是 `packages/pc-companion`，我最初查错了目录）。

`npm run dist:win` **退出码 0**：build → pre-dist-check → electron-builder --win → verify:dist 全过，
`verify:dist` 18 项全 ✔（better-sqlite3 / sharp / libvips / koffi 四个原生二进制、四个 VC++ 运行库、
`@nikkisync` 四包入口 + `0001_initial.sql` + `LocalSyncServer.js` + `GalleryRuntime.mjs` +
`requestedExecutionLevel=asInvoker`）。

| 证据                   | 实测读数                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装包文件名           | `release/MeowStarMap-Setup-2.5.5-beta.exe`，**183,331,907** 字节，12:50；旧包 `NikkiGallery-Setup-2.5.5-beta.exe`（183,331,537 / 10-20 21:34）并存未覆盖                                                                                                                                                    |
| exe 文件名             | `release/win-unpacked/喵星图.exe`，223,764,992 字节                                                                                                                                                                                                                                                         |
| `latest.yml`           | `path: MeowStarMap-Setup-2.5.5-beta.exe`（`files[0].url` 同值）                                                                                                                                                                                                                                             |
| userData 根跟随 `name` | 从产出的 `app.asar` 取出 `package.json` ⇒ `name = meow-star-map`、`productName` **缺席**                                                                                                                                                                                                                    |
| 打包态冒烟             | `npx playwright test --config e2e/playwright.config.ts --grep-invert @perf` ⇒ **9 passed / 1 failed / 5 did not run**：S1–S7 与「userData 隔离校验」全过；唯一红是 NikkiSync 的 N1（归因见第八节）                                                                                                          |
| NSIS 生效配置快照      | `release/builder-debug.yml` mtime 12:50（本次刷新）                                                                                                                                                                                                                                                         |
| PE 资源元数据          | builder 日志明示 `executable resource editing and code signing skipped — signAndEditExecutable is false` ⇒ **exe 内的 ProductName/FileDescription 不随 productName**，只有文件名随。任务管理器读文件名，故阶段 2 偏差 3 / 阶段 3 偏差 3 的「进程名指称」闭合；但「右键属性 → 详细信息」仍是 Electron 默认值 |
| **不可作为反证的一处** | `release/builder-effective-config.yaml` 里 appId / productName / artifactName / shortcutName **全是旧值**——其 mtime 是 **2026-09-14 20:07**，本次构建并未刷新该快照，属陈旧产物而非配置未生效                                                                                                               |

## 七、一个由我自己的取证命令造成的假象（如实交代）

跑完打包链后我发现根 `package.json` 被覆写成「仅生产依赖」形态（`keywords` / `scripts` /
`devDependencies` / `build` 四段消失，`git diff --stat` = 1 增 217 删），一度判为打包链的副作用。
逐步二分（每步后取 `md5sum package.json`）的结果是**每一步都无罪**：`npm install --package-lock-only`、
`npm run link:nikkisync`、`npm run pre-dist-check`、`npm run build`、`npx electron-builder --dir`、
`npx tsx scripts/pre-dist-check.ts --verify-asar`，以及单独跑的
`npx electron-builder --win --config.directories.output=release/bisect-nsis`（含 NSIS 打包、签名、blockmap）
全都不改 `package.json`。

真因是我的取证命令写错了：`npx asar extract-file <app.asar> package.json` 我在**仓库根**执行，该子命令
不写 stdout 而是把归档内的 `package.json` **落到当前目录**，于是覆盖了仓库的 `package.json`
（这也是当时 `npm run e2e:smoke` 报 `Missing script: "e2e:smoke"` 的原因）。正确做法是先离开仓库根
——第二次取证 `cd` 到仓外临时目录后取到的内容正是 `name = meow-star-map` / `productName` 缺席。
已 `git restore -- package.json` 无损还原（当时更名改动均已提交，还原后 `git status` 为空），
被覆写的版本存档为 `.cache/rename-scan/package-json-STRIPPED-by-dist-win.json`。

**结论：打包链本身没有剥 `package.json` 的缺陷，本轮不虚报这一条技术债。**

bisect 期间写到 `release/bisect-nsis/` 的临时产物已整体删除：它含
`win-unpacked/resources/app.asar.unpacked`，而 `scripts/pre-dist-check.ts` 的 `findAsarUnpacked()` 取
**首个**字典序命中，`bisect-nsis` 排在 `win-unpacked` 之前，留着会让后续 `verify:dist` 校验错树
（同一 hazard 见 `docs/archive/plans/2026-10-19-e2e-guards-review-commit-2.5.5-beta-repack.md`（已归档，不入仓）对 `alt-stage` 的处置）。
删除后复跑 `npm run verify:dist` ⇒ ✅ 通过。

## 八、e2e 的两类环境性红（都不是更名造成）

1. `ELECTRON_RUN_AS_NODE=1` 是我这侧 shell 的既有环境变量。带上它时 exe 按**纯 Node** 运行
   （实测 `喵星图.exe --version` 打出 `v24.18.0` 而非应用版本），Chromium 开关被判
   `bad option: --remote-debugging-port=0` / `--user-data-dir=…` ⇒ S 套件全红。`unset` 之后
   S1–S7 与 userData 隔离校验 **9 passed**。属取证环境，不写入代码规避。
2. 唯一残留红是 `e2e/nikkisync-runtime.e2e.ts` 的 N1，报错原文：
   `Cannot find package '…\NikkiSync\node_modules\@nikkisync\database\index.js' imported from …\NikkiSync\apps\pc-companion\dist\src\index.js`
   ⇒ 上游 `NikkiSync` 检出**自己没有安装 workspace 依赖**，`pc-companion` 编译产物里的裸
   `@nikkisync/database` 说明符无法解析。修法是到 `../NikkiSync` 跑 `npm install`（可能还要
   `npm run build`），属改动另一个仓库，超出本轮授权范围，故记为未验证项而非就地处理。
   这条只在 `launchBuiltApp()`（仓内 electron + 变量式动态 import）路径上暴露；打包态的 S 套件能过，
   是因为 `@nikkisync` 已按 `build.files` / `asarUnpack` 真实入包，与 `verify:dist` 的 18 项 ✔ 互相印证。

## 九、已知偏差（本轮不修，逐项交代去向）

1. **`e2e/perf-real.e2e.ts` 同文件分叉**：`:15` 的示例 userData 根已取 `meow-star-map`，而同文件
   `:36`、`:335`、`:356`、`:430` 的 `wxnn_photo_manager.db` 仍是旧前缀（属 N3 的锁 B）。守卫里显式
   断言「库名仍为 4 处」，N3 交付时该条随批翻转。⇒ 由 N3 关闭。
2. **诊断目录名与 `%TEMP%` 日志名仍是旧名**：`PRODUCT_DIAG_DIRNAME = 'NikkiGallery'` 及
   `startup-diagnostic` / `early-crash-guard` 的日志名（阶段 3 台账 67 行里的诊断相关部分 + 11 条断言）。
   弹窗文字（阶段 3）与诊断横幅（本轮）已是新名，但弹窗内插值出的路径仍指旧目录。⇒ 由 N2 关闭。
3. **手机端同步标识仍是旧名**：`SYNC_SERVER_DEFAULT_NAME = 'NikkiGallery'`（mDNS 实例名）、
   `DEFAULT_SERVER_NAME = 'WXNN XiangCe'`（落库服务器名）、TLS 证书 CN `WXNN Photo Manager Local`
   （改它要重签证书、已配对手机需重连）。⇒ 由 N4 / 单独评估关闭。
4. **数据库与备份文件名前缀链整条仍是旧名**（N3，爆炸半径最大：13 处源码 + 约 56 处断言）。
5. **`ui-brand-name.test.ts` 在 `test:posix-host` profile 下装载失败**（`path` 被钉成 posix 后
   `path.dirname` 对 Windows 路径返回 `.` ⇒ ENOENT）。属阶段 3 遗留的潜在缺陷；本轮只把新守卫改成
   `new URL(rel, import.meta.url)` 形态规避（三种 profile 下同判据），未顺手扩面改它。已登记。
6. **exe 的 PE 资源元数据不随 productName**（`win.signAndEditExecutable: false`）：见第六节末行。
   若要「右键属性」也显示新名，须改构建配置（`signExecutable: false` 保资源编辑），属逻辑/配置变更，
   不在本轮名称范围。⇒ 记为后续可选项。

## 十、未验证项（本机无法执行，如实记录）

1. **真实安装后的开始菜单/桌面快捷方式显示名、卸载项显示名、默认安装目录名**：本轮只出包未安装
   （`nsis.shortcutName` / `UNINSTALL_DISPLAY_NAME` 的生效链由 `NsisTarget.js:461/473` 读源码确认）。
2. **`%APPDATA%\meow-star-map` 是否真的被创建**：包内 `package.json` 的 `name` 已实测为
   `meow-star-map` 且无 `productName`，属强证据；但「起一次新包看目录是否出现」未做
   （会写用户机器并触发首启全量扫描）。
3. **NSIS 就地升级与 electron-updater 行为**：`appId` + `productName` 同时变更，需新旧两版共存才测得出
   （阶段 1 §十已登记为「不发布带更名的 tag，发布前先出搬迁公告」）。
4. **`npm ci` 与改名后 lock 的一致性**：本机跑会清掉 `@nikkisync` 链接并重建原生模块 ABI，超出范围；
   确定性证据只能来自 CI 的 `lint-typecheck` job。本轮的替代取证是 `git diff --numstat` = 2 增 2 删
   且改的都是 `"name"` 行、`"libc"` 计数仍为 16。
5. **真实 ubuntu-latest 的分片与 Coverage job**：`npm run test:ci-linux` 只是复现装置。
6. **`node --test docs/sync-integration/verify-audit.mjs`** 与 **NikkiSync 的 e2e N 套件**：
   同受第八节 2 的上游前置阻塞。

## 十一、改名后首启的行为变化（必须告知使用方）

`name` 变更 ⇒ userData 根切到 `%APPDATA%\meow-star-map`。首次运行新包或新 `npm run dev` 时相册为空，
这是**预期而非缺陷**：本轮禁止新增自动迁移逻辑。人工搬迁清单见上游计划
[`2026-10-23-project-rename-meow-star-map.md`](./2026-10-23-project-rename-meow-star-map.md) §八
（含 DB 改名、备份改名、缩略图/索引/插件/同步证书原样搬、以及不得同时运行新旧两版的原因）。
控制面板会出现新旧两个应用条目、桌面并存 `无限暖暖相册管理工具.lnk` 与 `喵星图.lnk`、
`%APPDATA%\wxnn-photo-manager` 与 `…-updater` 成孤儿，均只作手工说明，不加清理代码。

## 十二、本轮工装（`.cache/rename-scan/`，被 gitignore，git 里查不到）

- `red-stage4.txt` / `green-stage4.txt` — 红基线 271 行 / 71 文件；绿灯 259 行。Δ 的构成必须解释清楚，
  否则「绿灯还有 259 行」会被误读成漏改：本轮消掉 **36 处**旧名站点，而守卫自身为了「禁改项逐字锁」
  **新增 24 行含旧名字面量**（`OLD_PACK_TOKENS`、URL 计数、`NikkiGallery` 磁盘键、N2 常量等），
  净减 12 行。逐文件差值全部落在预期清单上：配置/CI/脚本/装置/夹具侧**归零**，剩下的只有
  `verify-audit.mjs` 的 41 行 `WXNN XiangCe`（本机目录名，禁改）、`perf-real.e2e.ts` 的 5 行
  （4 处 `wxnn_photo_manager.db` = N3，1 处 `D:\NikkiGallery缓存` = 磁盘真实名），以及 N2/N3/N4 与
  URL / 磁盘键 / `@nikkisync` 面。
- `edits-stage4-c1.json` … `edits-stage4-c4.json`，外加 `edits-stage4-c2-lockproof.json` /
  `edits-stage4-c2-revert.json` / `edits-stage4-c3-half.json` / `edits-stage4-c3-rest.json`
  四份专用于拆锁取证与还原。
- `old-names-stage3.txt` — 本轮直接复用阶段 3 的 29 条模式，未新增条目（见第二节）。
- `cilinux-stage4-full.txt`、`s3-files.txt` / `s4-files.txt` — 装置失败集与阶段 3 台账的逐字对比。
- `dist-win-stage4.log`、`nsis-bisect.log`、`build-only.log`、`dir-only.log`、`e2e-smoke-stage4.log`、
  `n1.log`、`red-guard-c*.txt`、`package-json-STRIPPED-by-dist-win.json` — 打包与取证原始读数。
