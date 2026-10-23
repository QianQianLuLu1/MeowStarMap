# 执行记录：反馈弹窗群号修复 + 产物内容禁串闸门 + 2.5.5-beta 重新打包（2026-10-23 第二轮）

> **状态**：已交付。两项修复各自先红后绿；全量静态门与全量测试通过；新安装包
> `release/MeowStarMap-Setup-2.5.5-beta.exe`（183,331,805 B）已产出并逐项验尸。
> **第三轮（18:48–18:52）补充**：标准配方 `npm run dist:win` 与裸跑 `verify:dist` **仍未走通**，
> 原因已实测定位（防护服务对新建 `app.asar` 同样持锁），读数与解锁动作见第十二节。
> **第四轮（19:45–20:45）补充**：审查与版本两侧改用**逐文件 sha256** 闭合——现役包等于当前 HEAD 的构建输出
> （`dist/` 四件主产物 + 74 个 renderer asset 全等，包内 `@nikkisync` 四包与 migration 等于 `../NikkiSync` 现状），
> 全量回归 437 / 6737 / 12 与本轮逐项相等；标准配方走到 `fs.rm(release\win-unpacked)` 才红（前面 27 项校验与
> 345 MB Electron 解压全绿），红因是 15:55 / 16:00 两棵过期残壳里 `app.asar` 的残留句柄——三种频率共 106 次
> 探针未见释放窗口。裸跑 `verify:dist`、标准位置产物复算与打包态 `e2e:smoke` 三项因该句柄仍未执行（不是跳过），
> 续做序与唯一剩余动作见 13.7。清场期间把现役包短暂归档到 `_safe_backup_20261023-1949/bypass-build-1827/`，
> **收尾已原样移回 `release/`**（不因我的清场让用户手上反而没有可用交付物）；归档区只剩上一轮旁路整树——
> 为不复活 13.2 那条 `findAsarUnpacked` 字典序假绿，它不回 `release/`。读数见第十三节。
> **日期**：2026-10-23
> **上游计划**：本次会话计划文件 `iron-ravine-starling`（批准于 18:00 前后），任务原文为
> 「审查未提交代码 → 修复 → 提交 → 版本号定为 2.5.5-beta → 重新打包」；第四轮沿用同一条任务模板，
> 会话计划文件为 `lucid-cliff-pintail`。
> **前置记录**：[`2026-10-23-rename-repo-url-stage7.md`](./2026-10-23-rename-repo-url-stage7.md)（阶段 7 仓库 URL 换名，本轮缺陷的来源提交）、
> [`2026-10-23-rename-packaging-pass.md`](./2026-10-23-rename-packaging-pass.md)（阶段 4 打包层更名）
> **本机路径说明**：文中凡落在 `release/`、`_safe_backup_20261023-1825/`、`_safe_backup_20261023-1949/`、
> `.cache/` 下的路径
> （含 `release/build-20261023-1825`、`release/*.exe`、`release/latest.yml`、
> `_safe_backup_20261023-1825/bypass-build-1827`、`_safe_backup_20261023-1949/build-20261023-1825`、
> `_safe_backup_20261023-1949/bypass-build-1827`、`.cache/electron-dist-clean`）
> 均为 gitignored 的本机产物与留底，不入仓、不属仓库结构声明，也不应有死链判定落在其上。

## 一、审查范围：工作树是干净的，「未提交代码」为空

开工前实测，不是推断：

| 判据           | 命令                                              | 读数       |
| -------------- | ------------------------------------------------- | ---------- |
| 工作区与暂存区 | `git status --porcelain`                          | **空输出** |
| 未暂存改动     | `git diff --stat`                                 | 空         |
| 已暂存改动     | `git diff --cached --stat`                        | 空         |
| untracked      | `git status --porcelain --untracked-files=normal` | 空         |

⇒ **没有可审查、可提交的未提交代码**，按「确实无问题时不虚构改动」的口径如实记录，**不造空提交**。

形式上唯一「未提交」的东西是 2026-10-13 停放的 `stash@{0}`（`phase7-wip-parked`，
`feature/sync-integration-07-bidirectional-sync`，已跟踪 6 文件 +972 行 / 未跟踪 4 文件 +1004 行）。
经与用户确认：**本轮不弹出、不改动**——`src/shared/sync/protocol-extension.ts` 等文件在 main 里从未落地，
属独立大功能，弹出即与最小化改动冲突。

审查范围因此改为用户批准的**「已提交但还没进过任何安装包」**的 `0a13c6b..HEAD`：

| 提交      | 内容                                                    | 是否进包                                                    |
| --------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| `44ab983` | `fix(dist-check)`：`nikkiSyncMissingDiagnosis` 分档诊断 | 否（`scripts/**` 不在 `build.files`）                       |
| `18723e4` | `fix(brand)`：仓库 URL 换成 MeowStarMap，21 文件        | **是**（`UpdateDialog.tsx`、`about-sections.tsx`、12 语包） |
| `32aca09` | `docs(plans)` 阶段 7 记录                               | 否                                                          |

## 二、本轮是真红：过期安装包已被实测钉死

最后一个安装包出在 16:01，而 `18723e4` 提交在 17:21:38 —— 会进包的渲染层文件晚于出包。
对包内 `app.asar` 直接 `grep -a` 取字面量计数（asar 内文件体是连续字节，该法与内容扫描等价）：

| 判据（在 `release/win-unpacked-full/resources/app.asar` 上） | 读数                                |
| ------------------------------------------------------------ | ----------------------------------- |
| `grep -a -o 'github.com/QianQianLuLu1/NikkiGallery'`         | **4 处**（源码侧实测为 0）          |
| `grep -a -o 'github.com/your-repo/issues'`                   | **24 处**（`18723e4` 之前的占位值） |
| `grep -a -o 'QQ Group: 123456789'`                           | **20 处**（10 语包 × 2）            |
| `grep -a -o 'QQ群: 123456789'`                               | **4 处**（zh-CN / zh-TW × 2）       |

⇒ 重新打包不是空转，是修一个已出货缺陷。

## 三、审查结论：`18723e4` 自身无 blocker，但查出两处

逐条复核（非「看过 diff 即算审」）：

- 12 语包的 `common.feedbackDialog.githubValue` 取值逐字节一致，`/issues` 后缀齐全，`your-repo` 在 `src/` 内已归零。
- `old-name-ledger.json` 收窄豁免后，守卫计数与台账**精确相等**（170 == `expectedTotal`，0 未登记、0 逐文件偏差）。
- URL 仅用于展示与 `shell.openExternal`；更新检查走主进程 `electron-updater`（不破「渲染层不直连 HTTP」约定），
  产物内 `app-update.yml` 已是 `owner: QianQianLuLu1 / repo: MeowStarMap`。
- `src/renderer/pages/sync-gallery/SyncGalleryToolbar.test.tsx` 只改注释，断言未被弱化。

两处缺陷（用户逐项批准后修）：

**A. 假群号会随包出货。** `src/renderer/components/common/FeedbackDialog.tsx:189` 把整条
`t('common.feedbackDialog.qqGroupValue')` 原样交给剪贴板，而 12 个语包该键一直是占位 `123456789`；
真实群号的另一份副本在 `src/renderer/pages/settings/about-sections.tsx:18`（`const QQ_GROUP = '635492596'`）。
`18723e4` 修了同一组的兄弟键 `githubValue`，漏了这一项。

**B. 闸门缺位（本事故的根因）。** 常驻旧名守卫 `scripts/__tests__/old-name-ledger.test.ts` 的 `skipDirs`
明含 `dist` 与 `release`（只管源码，按设计如此），而 `verify:dist`（`pre-dist-check.ts --verify-asar`）
只查原生二进制与管理员清单，**两侧都看不见产物内容** —— 于是「`npm test` 全绿」与「包里带 4 处旧地址」
可以同时成立。

## 四、修复 A：12 语包群号转真实值（红-绿）

| 步骤             | 命令                                                     | 读数                            |
| ---------------- | -------------------------------------------------------- | ------------------------------- |
| 红灯（改源码前） | `npx vitest run scripts/__tests__/ui-brand-name.test.ts` | **13 failed / 30 passed（43）** |
| 绿灯（改源码后） | 同一命令                                                 | **43 passed**                   |

- 判据落在既有守卫 `scripts/__tests__/ui-brand-name.test.ts`（该文件本就遍历 `LOCALES` 与语包 JSON，属同类判据的家），
  新增 12 条 `%s` 用例 + 1 条**跨源等值**用例：从 `about-sections.tsx` 文本抽 `const QQ_GROUP = '(\d+)'`，
  断言每个语包的串以该值结尾。两处副本谁单独漂移都红。
- **否决「引入共享常量」**：那要求把 12 条串改成插值并在渲染层新增模块导入，属结构性改动；
  跨源等值断言以零结构代价拿到同一保证。
- 前缀逐语包原样保留（实测 12 包只有 `"QQ群: "` 与 `"QQ Group: "` 两种形态），改动面 = 12 文件各 1 行、
  `deltaLen=0`（等长替换），无 BOM、LF 保持。
- `npm run i18n:guard` 复跑绿：它只管 key 奇偶与白名单单调性，不查值，故值改写不触发它——这也说明
  该修复必须靠用例，不能指望 i18n 工具链。

## 五、修复 B：`verify:dist` 增加产物内容禁串闸门

新增在 `scripts/pre-dist-check.ts` 的 `--verify-asar` 分支第 3 步（即 `npm run dist:win` 的终点）：

| 导出件                                          | 职责                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `artifactBannedStrings(patterns, owner, extra)` | 台账 `patterns` 逐条拼 `github.com/<owner>/<pattern>`，并入 `extra`；owner 空 ⇒ 只回 extra；剔空串、去重                     |
| `scanBufferForBanned(bytes, banned)`            | 产物字节流逐禁串**字面量**非重叠计数，只回 `count > 0` 项、按次数降序；空 Buffer / 空清单 ⇒ `[]`                             |
| `resolveVerifyAsarTarget(argv, releaseDir)`     | 待审对象优先级：`--asar=<path>` ⇒ `release/win-unpacked/resources/app.asar` ⇒ 拒绝任何 `*.tmp` 目录段；解析不到返回 `reason` |

三个设计决定，都写进了代码注释：

1. **fail-closed**：解析不到待审 asar 一律 `fail`，不 `skip`。`skip` 等于把「静默发布过期包」的口子重开，
   与 `44ab983` 把 `nikkiSyncPackedVerdict` 的降级改成 fail 是同一口径。
2. **不复用 `findAsarUnpacked`**：它取 `release/**` 里 readdir 的首个 `app.asar.unpacked`。本机 `release/`
   同时躺着上次成功的、失败残留的、解压中途的三棵树，那判据随残留漂移。本轮刻意**不改**它（最小化改动，
   且清空 `release/` 从源头消除歧义），只让新闸门自带选择逻辑。
3. **禁串清单的唯一出处是台账 JSON**：`old-name-ledger.json` 新增 `artifactBanned: { owner, extra }`。
   旧名字面量一个都不写进 `scripts/*.ts` —— `scripts/` 在该守卫的 `roots` 内，而 `pre-dist-check.ts` 不在
   `skipPaths` 内，写实名会立刻让它转红（未登记文件 + 总数漂移）；台账 JSON 本身在 `skipPaths` 内，允许承载。
   未来再改名只动这一处，`patterns` 会自动派生新的 URL 形态。

| 步骤                 | 命令                                                                                                  | 读数                                                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单测                 | `npx vitest run scripts/__tests__/pre-dist-check.test.ts`                                             | **34 passed**（较基线 +17，正常/异常/边界三类齐）                                                                                                                                                                     |
| 真红（对现存过期包） | `npx tsx scripts/pre-dist-check.ts --verify-asar --asar=release/win-unpacked-full/resources/app.asar` | **exit 1**，原文：`产物 release\win-unpacked-full\resources\app.asar 含 4 类禁串共 52 处："github.com/your-repo/issues"×24、"QQ Group: 123456789"×20、"github.com/QianQianLuLu1/NikkiGallery"×4、"QQ群: 123456789"×4` |
| 计数等价性           | 闸门读数 vs 独立 `grep -a`                                                                            | **逐条对齐 24 / 20 / 4 / 4**，证明 `Buffer.indexOf` 与 `grep -a` 同判据                                                                                                                                               |
| 未破坏既有守卫       | `npx vitest run old-name-ledger path-semantics-guard source-encoding`                                 | **24 passed**（`scripts/` 不在 posix 漂移扫描面，新代码不钉 win32 ⇒ 无需登记表条目）                                                                                                                                  |

用例里禁串一律用合成 token（`github.com/someone/LegacyName`、`测试群: 000111`），
避免把真实旧名写进受扫描的 `.ts`。

## 六、版本号：核验为「零编辑」

`package.json:3` 是唯一真相源，运行期经 `app:getVersion` → `app.getVersion()`，无硬编码。逐处实测：

| 声明位                                           | 读数                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `package.json:3`                                 | `"version": "2.5.5-beta"`                                            |
| README 徽章                                      | `version-2.5.5--beta`                                                |
| `AGENTS.md:7`                                    | `v2.5.5-beta`                                                        |
| `src/renderer/preview/mock/database-mock.ts:664` | `getVersion: async () => '2.5.5-beta'`                               |
| `CHANGELOG.md`                                   | `^## [2.5.5-beta]` 全文件唯一（1 处），`[Unreleased]` 无 `- ` 列表项 |
| 旧包 `release/latest.yml`（已留底）              | `version: 2.5.5-beta`                                                |

两道 release 闸门的真实语义（易读错名字踩坑，此处钉明）：`scripts/check-doc-versions.ts` **只管 README 里的
Electron 版本**（41.10 vs `package.json` 的 41.10.6）；应用版本的闸门是 `scripts/check-changelog-release.ts`
（唯一 `## [2.5.5-beta]` 节 + `[Unreleased]` 无条目）。二者本轮**当前即满足**，实测输出：

```
✔ 解析到 12 个版本节（最新：2.5.5-beta，package.json：2.5.5-beta）
✔ [2.5.5-beta] 版本节存在且唯一
✔ [Unreleased] 已收口（无待发布条目）
✔ README 中所有 Electron 版本均为 41.10，与 package.json (41.10.6) 一致
```

⇒ 「把版本号设为 2.5.5-beta」= **一处未改**。本轮改动会进包（语包运行期取值），故补录一条
`> 2026-10-23 追加：…` blockquote 进 `## [2.5.5-beta]` 节 —— 用 blockquote 而非 bullet，
因为该脚本的条目判定只在 `[Unreleased]` 节内数 `- `/`* ` 行。

## 七、全量回归（一票否决）

| 闸门                    | 结果                                         |
| ----------------------- | -------------------------------------------- |
| `npm run lint`          | **exit 0**                                   |
| `npm run typecheck`     | **exit 0**                                   |
| `npm run typecheck:e2e` | **exit 0**                                   |
| `npm run i18n:guard`    | **exit 0**                                   |
| `npm test`              | 首轮 **1 failed / 6736 passed / 12 skipped** |

首轮的 1 例失败**是本轮自己引入的真问题**，不放过：`scripts/__tests__/check-md-links.test.ts` 的
「`runCheck()` 的死引用数为 0」红——我在 `CHANGELOG.md` 里引用了本文件 `docs/plans/2026-10-23-qqgroup-fix-and-dist-gate-repack-pass.md`，
而它当时还不存在。该守卫用 `git ls-files` 的 tracked 集合判存在（**不用 `fs.existsSync`**，
因为被 gitignore 的文件对全新克隆不可用），故本文件落盘并随同批次暂存后方解。
这恰好证明：写悬空引用会被拦下——**它是对本轮改动生效的第二道判据**。

用例增量核对：6737（= 6736 passed + 1 failed）− 基线 6707 = **+30**，与本轮新增（修复 A 13 例 + 修复 B 17 例）
逐一对上，无既有用例被吞。

## 八、打包：标准配方失败点与旁路

> **时间限定**：本节读数取自 18:21–18:35 那一轮，事实未被推翻；同日 18:48–18:52 的第三轮续做实测见
> 第十二节——**标准配方至今仍未走通**，且本轮实测判明「仅重启不够，必须加白名单」。

`npm run build` 与 `npm run pre-dist-check`（打包前 11 项）**全部通过**，`dist/` 实测已是修复后产物
（旧地址 0、新地址 28、`635492596` 在 i18n chunk 内、`123456789` 归零）。失败发生在 electron-builder 的解压步：

```
⨯ EBUSY: resource busy or locked, unlink 'release\win-unpacked.tmp\resources\default_app.asar'
```

即腾讯电脑管家实时防护（`QQPCRTP.exe` 在跑）仍持有句柄。实测处置：

| 动作                                                                                   | 结果                                                                                          |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `mv release/*.exe *.blockmap latest.yml builder-debug.yml _safe_backup_20261023-1825/` | **成功**（唯一现存安装包 183,330,988 B 完整留底，未删除）                                     |
| `mv release/_quarantine-20261023-1555-missing-nikkisync`                               | 成功                                                                                          |
| `rm -rf release/win-unpacked` / `.tmp` / `-full`                                       | **失败**：各自 `resources/*.asar` Device or resource busy（残留内容被清，仅锁住的 asar 留下） |
| `mv release/win-unpacked{,-tmp,-full}`                                                 | 失败：Permission denied                                                                       |

⇒ 标准目录名 `release/win-unpacked` 被陈旧残壳占死且不可移、不可删。改用**不改任何仓内配置文件**的 CLI 覆盖：

```bash
npx electron-builder --win --publish never \
  --config.electronDist="<仓库绝对路径>/.cache/electron-dist-clean" \
  --config.directories.output=release/build-20261023-1825
# BUILDER_EXIT=0；再把 exe / blockmap / latest.yml 移回 release/ 根
```

`electronDist` 指目录时走 `emptyDir` + `copyDir`，**没有 rename**，故不撞锁；输出改到 `release/` 下的新子目录，
是为了让 `verify:dist` 的原生二进制步仍能指向新树（见下）。产物链完整：日志第 11 行
`appOutDir=release\build-20261023-1825\win-unpacked`，第 22 行 NSIS 从同一 `appOutDir` 打出 exe。

一处需澄清的疑点已排除：日志里 `executable resource editing and code signing skipped — signAndEditExecutable is false`
是仓内既有配置（`package.json` 的 `build.win.signAndEditExecutable: false`，溯到基线提交 `a89d1e4`），
**不是旁路引入的差异**。

## 九、打包后验收读数

| #   | 判据                                     | 读数                                                                                                                             |
| --- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 新 `app.asar`（71,494,094 B）旧仓库链接  | **0**（过期包为 4）                                                                                                              |
| 2   | 失效占位 `github.com/your-repo/issues`   | **0**（过期包为 24）                                                                                                             |
| 3   | 假群号（`QQ Group:` / `QQ群:` 两种形态） | **0 / 0**（过期包为 20 / 4）                                                                                                     |
| 4   | 正面读数：新仓库链接 / `635492596`       | **31 / 25**                                                                                                                      |
| 5   | 新闸门指向新树                           | **exit 0**：`✔ 产物无旧仓库链接与失效占位…（32 条禁串、71494094 字节）`                                                          |
| 6   | `npm run verify:dist` 原生二进制步       | 全部 ✔，且路径实测落在 `build-20261023-1825\win-unpacked\...`（新树），含 4 个 `@nikkisync` 入口与 `migrations/0001_initial.sql` |
| 7   | 安装包体积判据                           | **183,331,805 B**（> 183,000,000；缺 `@nikkisync` 的老失败态为 182,722,373）                                                     |
| 8   | `release/latest.yml`                     | `releaseDate 2026-10-23T10:27:42Z` 晚于构建起点 18:21；`sha512 S+hfFFBWLXV…` 与留底 `GNJ6bSgo8DX…` **不同**；`size 183331805`    |
| 9   | 产物内 `app-update.yml`                  | `owner: QianQianLuLu1 / repo: MeowStarMap / updaterCacheDirName: meow-star-map-updater`                                          |

**未做的验收**：装包后的界面路径（反馈弹窗复制群号、关于页、更新弹窗外链）未在本机做装机实测——
证据止于产物字节内容与打包链完整性。不谎称 UI 已验。

## 十、遗留与需用户处理项

| #   | 项                                                        | 说明与去处                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`release/` 三个残壳删不掉**                             | 管家的 15:47 / 15:55 句柄仍未释放。请给工作区目录加实时防护白名单，或重启后再 `rm -rf release/win-unpacked*`。**在此之前 `npm run verify:dist` 裸跑必红**（新闸门默认指向 `release/win-unpacked`，那里是过期包）——这是刻意的 fail-closed，不是回归；旁路打包时需带 `--asar=<新树路径>`。 **第三轮订正（18:52 实测）**：句柄并不只针对 15:47 / 15:55 的旧文件——**连 18:27 新建的 `app.asar` 同样被持锁**（`rm -f` 报 Device or resource busy），所以「重启后再删」不能根治，**必须给工作区加实时防护白名单**，否则重启后第一次构建就会重新锁上。判据见第十二节。 **第四轮订正（19:45–20:30 实测，见第十三节 13.1）**：本条的成因已**部分失效**——`QQPCRTP.exe` 这次确实从 Session Services 消失，且**新写入与新解压完全不被锁**（本轮构建解出的 345 MB 全新 Electron 运行时可整树 `rm -rf`）；18:25 / 18:27 那批句柄也已自行释放（旁路树可自由搬动）。仍然卡着的只有 15:55 / 16:00 两棵残壳里的那两个 `app.asar`（`unlink` / 同目录 `rename` 一律 `EBUSY`，已持续 4.6 小时），而且它们不再属于「防护在跑」：`WinDefend` Stopped、`WSearch` Disabled、`Get-CimInstance Win32_Process` 里**没有任何进程的 `ExecutablePath` 落在工作区内**——即残留句柄不在任何可枚举的用户态进程里。所以本条从「必须加白名单」收窄成「等残留句柄自行释放，或重启系统清掉它」。 |
| 2   | 标准配方本轮未被走通                                      | `npm run dist:win` 的前段（build + pre-dist-check）已实测通过，仅 builder 步被外部锁打断；残壳清掉后标准配方应可原样跑通，无需改任何配置文件。 **第三轮复核（18:48–18:52）**：该前提至今未成立——`mv release/win-unpacked{,.tmp,-full}`、`mv release`、`mv release/build-20261023-1825` 四处探针**全部 Permission denied**，标准位置腾不出来，标准配方与裸跑 `verify:dist` 两项仍悬空（第十二节）。 **第四轮（20:16–20:20 实测，见 13.4）**：又往前走完整整一段，但仍差最后一步——`npm run build`、27 条 `pre-dist-check`（含 `✔ git status clean` 与三条版本节闸门）、`@electron/rebuild` 原生依赖、Electron 下载与 **345 MB 全新运行时完整解压到 `release\win-unpacked.tmp`** 全绿，红点收缩到唯一一处：`app-builder-lib/out/util/electronGet.js:186` 的 `fs.rm(release\win-unpacked)` 撞 `EBUSY`（于是 `:187` 的 `fs.rename(tmpDir, dir)` 走不到）。`win-unpacked.tmp` 这一棵本轮已腾开并删净，卡住标准名的只剩 15:55 那棵树里的一个历史文件。                                                                                                                                                                                                                                                                                                           |
| 3   | 复制群号仍带 `QQ群: ` 前缀                                | `FeedbackDialog` 复制整条语包串 ⇒ 用户拿到的是「QQ群: 635492596」而非纯号码，粘进 QQ 搜索框会失败。改它属行为变更（要去前缀或改插值），本轮按最小化改动**只登记不修**。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | `findAsarUnpacked` 的 readdir 偶然顺序                    | 既有弱点，本轮未改（清空 `release/` 从源头消除歧义）；若将来再出现多树并存，应给它显式选择参数。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 5   | `build.publish: [{provider: github}]` 无显式 `owner/repo` | 现经 `repositoryInfo` 从 `repository.url` 派生，今日正确；`--publish never` 下不参与判定。建议显式钉住以解耦，属配置变更，本轮未做。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6   | `resources/` 不在旧名守卫扫描域内                         | 它经 `build.files` 进包但不在 `roots`。当前该目录仅图标与一个 DLL，实测干净 ⇒ 潜在而非现存缺陷。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 7   | `package-lock.json` 工具链抖动                            | 本机 `node v26 + npm 11` 会重写它（删 `ffmpeg-static`/`ffprobe-static` 的 `libc` 字段），CI 钉 `.node-version=22`。按既有口径**还原不入仓**。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## 十一、提交边界

| 提交                                                                | 范围                                                                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `fix(i18n): 反馈弹窗 QQ 群号占位值改为真实群号 635492596`           | 12 语包 + `scripts/__tests__/ui-brand-name.test.ts`                                                               |
| `feat(dist-check): verify:dist 增加产物内容禁串闸门`                | `scripts/pre-dist-check.ts`、`scripts/__tests__/pre-dist-check.test.ts`、`scripts/__tests__/old-name-ledger.json` |
| `docs(plans): 入库群号修复、产物闸门与 2.5.5-beta 重新打包执行记录` | 本文件                                                                                                            |
| `docs(changelog): 2.5.5-beta 补录群号修复与产物闸门`                | `CHANGELOG.md`                                                                                                    |

`scripts/**` 不在 `build.files`（`dist/**/*` + `resources/**/*` + 对象式 nikkisync 项）范围内，
故修复 B 不要求额外重打包；修复 A 改了语包 ⇒ 必须重打包，已做。版本号未变，`package.json` 零改动。
第三轮（第十二节）只补记录与实测，未改任何仓内文件 ⇒ 提交边界仅增一条 `docs(plans)`。
第四轮（第十三节）同样**只改这一份文档**：审查结论是「未提交代码为空、现役包逐文件等于 HEAD」，
没有 Bug 被证实 ⇒ **本轮不新增测试、不做假的红-绿闭环**（第十二节那两项修复才是真红真绿），
版本号与 `CHANGELOG.md` 也都零改动 ⇒ 提交边界只再增一条 `docs(plans)`。

## 十二、第三轮续做实测：用户关闭管家后仍被锁，判据已查明

用户报告「已关掉腾讯电脑管家」后开工，目标是把第十节遗留 #1 / #2 真正关闭（腾出标准位置 →
零覆盖跑通 `npm run dist:win` → 裸跑 `npm run verify:dist` 转绿）。**结论：未达成，原因已实测定位。**（**第四轮补注**：本节 12.1 的七条探针读数是当时真实发生的外部约束，仍然有效、不作废；
但「必须加白名单否则重启也不根治」这条推论的作用域已被第十三节收窄——第四轮防护服务确实退出，
新解压不再被锁，标准配方一路走到 `fs.rm(release\win-unpacked)` 才红，红点只剩 15:55 / 16:00 两个历史 `app.asar` 的残留句柄。
本节的 EBUSY 记录与第十三节的收窄并不矛盾：同一把锁在不同时间、对不同文件的状态不同，两处都按原文留档。）

### 12.1 探针读数（全部原文记录，不推测）

| #   | 探针                                                                                  | 读数                                                                       | 判语                                                                                                                    |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | `tasklist \| grep -i QQPCRTP`                                                         | **`QQPCRTP.exe` PID 2296（Session Services）仍在运行**，仅 `QQPCTray` 消失 | 关掉的是主程序界面，**实时防护服务没退**                                                                                |
| 2   | `tasklist /v \| grep -i '喵星图\|electron\|MeowStarMap'`                              | **0 个进程**                                                               | 排除「某个从该目录起过、活着占住自己 `app.asar` 的应用实例」这一竞争假设 ⇒ 占用者确实是防护服务                         |
| 3   | `mv release/win-unpacked` / `.tmp` / `-full` → 留底区                                 | 三处 **`Permission denied`**                                               | 三棵残壳（各自只剩一个 asar）仍腾不出标准名                                                                             |
| 4   | `mv release → _safe_backup…/old-release/release-pre-1848`                             | **`Permission denied`**                                                    | 锁阻塞的是**整条祖先目录链**，连「把整个 `release/` 改名、新建空 `release/`」这条不动配置也能零覆盖跑标准配方的路都不通 |
| 5   | `mv release/build-20261023-1825`                                                      | **`Permission denied`**                                                    | **决定性**：被锁的不止历史残壳                                                                                          |
| 6   | `rm -f release/win-unpacked/resources/app.asar`（15:55）                              | `Device or resource busy`，文件仍在                                        | 旧锁未放                                                                                                                |
| 7   | `rm -f release/build-20261023-1825/win-unpacked/resources/app.asar`（**18:27 新建**） | `Device or resource busy`，文件仍在                                        | **新 asar 同样被持锁 ⇒ 单重启不够，必须加白名单**；重启后第一次构建就会重新锁上                                         |

探针 7 有破坏性风险，事后已复验无损：该 `app.asar` 仍为 `71,494,094 B @18:27:14`，
`release/MeowStarMap-Setup-2.5.5-beta.exe` 仍为 `183,331,805 B @18:27:38`，
闸门复跑 `--asar=` 指向该树 **exit 0**（`✔ 产物无旧仓库链接与失效占位…（32 条禁串、71494094 字节）`）。

### 12.2 现场已恢复，未留下「因清场反而没包可用」的中间态

清场时一度把 18:27 的 `exe` / `.blockmap` / `latest.yml` 移入 `_safe_backup_20261023-1825/bypass-build-1827`，
标准配方确认跑不通后**已全部移回 `release/`**。两份包现已明确区分、不可混淆：

| 位置                                                          | 体积                 | 身份                                                     |
| ------------------------------------------------------------- | -------------------- | -------------------------------------------------------- |
| `release/MeowStarMap-Setup-2.5.5-beta.exe`                    | 183,331,805 B @18:27 | **现役可用**（三项禁串归零，第十二节探针 7 后复验）      |
| `_safe_backup_20261023-1825/MeowStarMap-Setup-2.5.5-beta.exe` | 183,330,988 B @16:01 | 第十/十一节所述**过期包**留底（含 4 处旧地址），仅供追溯 |

### 12.3 本轮未做的项与解锁后的确切动作

R2（零覆盖 `npm run dist:win`）、R3（标准位置产物复算）、R4（裸跑 `verify:dist` 转绿）、
R5（`e2e:smoke` 打包态取证）**全部未执行**，因为它们的前提「标准名 `release/win-unpacked` 可腾出」被探针 3/4 判否。
**不做**的事：不改回 `--config.electronDist` 旁路去凑一个「成功」（那只会再产一棵新树并被同样锁住，
且本轮要拿的恰是标准配方跑通这件事）、不杀软、不重启用户机器、不动仓内配置、不 `skip` 判据。

需你在管家里做**一次**动作（任选其一，推荐前者）：

1. **给工作区目录加实时防护白名单/排除项**：`D:\Workbuddy 项目\WXNN YD - 副本\WXNN XiangCe`
   （含其下 `release`），加完**不必重启**即可让我续做；
2. 或彻底退出防护模块（托盘菜单里的退出，而非关窗口）后再续做。

解锁后按会话计划文件 `iron-ravine-starling` 的 R1→R5 续做，顺序要点两个：先确认
`mv release/win-unpacked*` 能动（锁真放开的判据），再把 `release/build-20261023-1825` **一并移出 `release/`**——
`checkUnpackedNativeBinaries` 用的 `findAsarUnpacked` 取 readdir 首个命中，而 `build-*` 字典序排在
`win-unpacked` **之前**，留着它会让 `verify:dist` 的二进制步验到上一轮旁路树，形成假绿。

## 十三、第四轮续做实测（19:45–20:45）：锁只对历史残壳残留，标准配方跑到最后一步才红

第四轮仍接同一套任务模板。**开工实测的审查结论仍然是「未提交代码为空」**，且这一次连「版本号」与
「包是否过期」两项都用直接读数关闭了，所以本轮的全部剩余价值集中在「标准配方本身能不能走通」。

### 13.0 审查与版本：四项实测全部为空操作

| 判据           | 命令                                                                                                   | 读数                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 未提交代码     | `git status` + `git ls-files -m` + `git ls-files --others --exclude-standard` + `git diff HEAD --stat` | **四者全空**（仓库无 `.gitattributes`，`git ls-files -m` 不受 lfs clean/smudge 影响，是绕开内容过滤器的交叉验证）                                                        |
| 版本号         | `node -e require('./package.json').version`                                                            | `meow-star-map 2.5.5-beta` ⇒ **零编辑**                                                                                                                                  |
| 版本闸门       | 本轮 `npm run dist:win` 内 `check-changelog-release` 实跑                                              | `✔ 解析到 12 个版本节（最新：2.5.5-beta，package.json：2.5.5-beta）`、`✔ [2.5.5-beta] 版本节存在且唯一`、`✔ [Unreleased] 已收口（无待发布条目）`                         |
| 现役包是否过期 | 对 18:27 旁路包 `app.asar` 逐 needle 计数（见 13.2 留底读数）                                          | `github.com/QianQianLuLu1/MeowStarMap`×**31**、`635492596`×**25**，四类禁串全 **0** ⇒ 18:36/18:37 两次提交（语包群号 + `scripts/**` 闸门）的内容**已在包里**，包并不过期 |

⇒ 按「确实无问题时不虚构改动」：**不造空提交**；本轮唯一仓内改动就是本节文档。
`18:27` 之后进入 HEAD 的三个提交里，`a8318e1` 只动 `scripts/**`（不在 `build.files`），
`3f71af9` / `98feced` / `4e52ad4` 只动 `CHANGELOG.md` 与 `docs/plans/`，均不进包。

**包与源码的一致性这次用逐文件哈希钉死，而不是只数 needle**。本轮 20:16 的 `npm run build` 已从
HEAD（干净树，见 13.4 的 `✔ git status clean`）全量重建 `dist/`，把它与 18:27 包内同路径文件做 sha256 对照
（`@electron/asar` 的 `extractFile`，脚本落 `.cache/r4-asar-compare2.cjs`）：

| 判据                                      | 读数                                                                                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dist/main/main/app/index.js`             | `407c25e229b5fa93…` **两侧相同**                                                                                                                                                         |
| `dist/main/main/preload.js`               | `146f3e1d35d19e95…` **两侧相同**                                                                                                                                                         |
| `dist/main/main/app/scanner-worker.js`    | `bf5261daae367ac5…` **两侧相同**                                                                                                                                                         |
| `dist/renderer/index.html`                | `40f1d6c8243f734a…` **两侧相同**                                                                                                                                                         |
| `dist/renderer/assets/*.js` 名称集        | **74 个文件，两侧名称集完全相同**（哈希文件名随内容变，同名即同内容）                                                                                                                    |
| `dist/renderer/assets/*.js` 逐文件 sha256 | **0 处不一致**                                                                                                                                                                           |
| 包内含 `635492596` 的文件                 | **25 个文件各命中 1 次** = 主进程 12 个语包（`dist/main/main/app/{de,en,es,fr,ja,ko,pt,ru,th,vi,zh-CN,zh-TW}.js`）+ 渲染层 12 个 `i18n-<locale>-*.js` chunk + `SettingsPage-DOWNGpsP.js` |

⇒ **现役包 = 当前 HEAD 的构建输出（逐文件字节相同）**，所以「重新打包」这件事在本轮的实质
不是「换内容」，而是 13.4 那条**把产物放进标准位置、让裸跑闸门自己变绿**；同源码重复构建只会变
`latest.yml` 的 `releaseDate` 与 `sha512`。这条结论替代了第二轮「数 needle 判过期」的间接取证。

**还有一条没人查过的过期轴**：`build.files` 里对象式的 `from: node_modules/@nikkisync` 经 junction
取的是**兄弟仓 `../NikkiSync` 的当前构建产物**——上游若在本轮之前重新 build 过，包里那部分就过期了，
而这不会体现在本仓 HEAD 上。逐文件 sha256 对照（脚本落 `.cache/r4-nikkisync-compare.cjs`）：

| 包内文件（`app.asar.unpacked/node_modules/@nikkisync/…`） | 包内                | 上游 `../NikkiSync` 现状 | 判       |
| --------------------------------------------------------- | ------------------- | ------------------------ | -------- |
| `core/dist/src/index.js`                                  | `ae3bf1bbd5956d18…` | 同值                     | **SAME** |
| `database/dist/src/index.js`                              | `3ce16de5fd98da2e…` | 同值                     | **SAME** |
| `protocol/dist/src/index.js`                              | `95f677dd03dba242…` | 同值                     | **SAME** |
| `pc-companion/dist/src/index.js`                          | `9fecd61ab57b664f…` | 同值                     | **SAME** |
| `database/migrations/0001_initial.sql`                    | `4f9cdcc0b14bb253…` | 同值                     | **SAME** |

⇒ 同步运行时这一侧也没有过期。**审查结论就此闭合**：现役包在「本仓源码」与「外链运行时」两条轴上都等于当前状态，
本轮不存在「需要修复的未提交代码」，也不存在「因源码变更而必须重建包内容」的情形。

### 13.1 复探针：防护服务确实退了，但 15:55 / 16:00 两个历史 `app.asar` 的句柄仍卡着

| #   | 探针                                                                                                                                                                       | 读数                                                                                    | 判语                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `tasklist \| grep -i QQPC`                                                                                                                                                 | **无 `QQPCRTP.exe`**（第三轮 18:48 它还在 Session Services 常驻）                       | 第十二节那条「关掉界面≠退出防护」的原因已被解决：这次防护服务真的没了                                                                                                                    |
| 2   | `Get-Service WinDefend,WSearch,Sense`                                                                                                                                      | `WinDefend` Stopped(Manual)、`WSearch` **Stopped(Disabled)**、`Sense` Stopped(Disabled) | 没有别的实时防护或内容索引器在跑 ⇒ 不能把锅推给 Defender/Search                                                                                                                          |
| 3   | `Get-CimInstance Win32_Process` 且 `ExecutablePath -like 'D:\Workbuddy*'`                                                                                                  | **0 个进程**                                                                            | 占用者不是任何用户态进程——尤其不是「从该目录起过、还活着占住自己 `app.asar`」的应用实例（第三轮探针 2 的那个竞争假设，这次用 Unicode 路径重验，避开 `tasklist` 对中文名 GBK 截断的盲区） |
| 4   | 19:4x：`mv release/win-unpacked.tmp`、`mv release/win-unpacked`（均在 `release/` 内改名）+ `renameSync` 两个历史 `app.asar`（同目录）                                      | **四处全部成功并原样移回**                                                              | 那一刻锁确实放开过                                                                                                                                                                       |
| 5   | 20:15 起复测：`mv release/win-unpacked → _safe_backup_20261023-1949/stale-shells/`                                                                                         | **`Permission denied`**；`mv release`（整目录改名）同报 Permission denied               | 探针 4 是**瞬时窗口**，不是稳态                                                                                                                                                          |
| 6   | 20:20 / 20:24：`unlinkSync` `release/win-unpacked/resources/app.asar`（71,380,514 B @15:55:17）与 `release/win-unpacked-full/resources/app.asar`（71,493,714 B @16:00:48） | **两个都 `EBUSY`**；`rm -rf` 对应目录 `EPERM`；同目录 `renameSync` 也 `EBUSY`           | 这两个历史 asar 的句柄已持续 4.6 小时未放（对比：第三轮记为 EBUSY 的 18:27 `app.asar` 本次可自由整树搬动 ⇒ 那批句柄约 2 小时内自释）                                                     |
| 7   | 20:2x：`rm -rf release/win-unpacked.tmp`（本轮构建刚解出的 **345 MB 全新 Electron 运行时**，含 `electron.exe` 与全部 pak/dll）                                             | **整树删除成功**                                                                        | **决定性**：新写入与新解压**完全不再被锁**                                                                                                                                               |

⇒ 对第十二节结论的**订正性收窄**（原句保留，不改写当时读数）：锁的范围已从第二/三轮的
「对每次新解压主动加锁」缩小为「只剩 15:55 / 16:00 那两个过期残壳里的 2 个 `app.asar` 被残留句柄占死」。
探针 3 说明该句柄不在任何用户态进程里，能枚举到的实体均已排除；能让它消失的动作只有句柄自行释放或重启系统，
二者都不是我可以代做的（不重启用户机器、不杀软）。

### 13.2 清场与留底（R1，已完成关键三项）

| 去向                                                           | 内容                                     | 落位读数                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_safe_backup_20261023-1949/bypass-build-1827/`                | 18:27 现役包三件                         | `MeowStarMap-Setup-2.5.5-beta.exe` **183,331,805 B @18:27:38**、`.blockmap` 188,050 B、`latest.yml` 366 B（`sha512: S+hfFFBWLXV…`、`releaseDate: '2026-10-23T10:27:42.176Z'`）                            |
| `_safe_backup_20261023-1949/build-20261023-1825/win-unpacked/` | 上一轮旁路整树（本轮之前唯一的验收依据） | `app.asar` **71,494,094 B** 完整；`app.asar.unpacked/node_modules/@nikkisync/` 下 `core` / `database` / `pc-companion` / `protocol` 四包齐；逐 needle：四类禁串 **0/0/0/0**，新地址 **31**、真群号 **25** |
| `_safe_backup_20261023-1949/stale-shells/`                     | 计划用来接三棵残壳                       | **实际为空**——只有 `win-unpacked.tmp` 一度被腾出（随后又被本轮构建的失败重新填充，见 13.4），`win-unpacked`(15:55) 与 `win-unpacked-full`(16:00) 被 13.1 探针 6 的 EBUSY 留在原地                         |

清场后 `git status --porcelain` 仍为空，确认这些路径全在 gitignore 内、未惊动任何被跟踪文件。
**收尾现状订正**：13.7 判定本轮不再出第 4 棵树之后，`_safe_backup_20261023-1949/bypass-build-1827/` 里那三件
已**原样移回 `release/`**（体积与 mtime 未变：exe `183,331,805 B @18:27:38`、blockmap `188,050 B`、
`latest.yml` `366 B`），归档区此后只留 `build-20261023-1825` 那棵旁路树。即 `release/` 里现在是
「现役包三件 + 两棵卡住的过期残壳」，与开工前相比只是少了 `win-unpacked.tmp` 与旁路树，交付物一件没少。

**字典序陷阱这次拿到了更硬的取证**：旁路树移出 `release/` 后裸跑 `npm run verify:dist`，
第一条 ✖ 变成 `✖ 未找到 release/**/resources/app.asar.unpacked，请先执行 electron-builder 打包`——
上一轮那 18 个打在旧树上的 ✔ 就此消失。**假绿路径被物理堵死，不再依赖「人记得传 `--asar=`」**。
同一次裸跑的 `✖ 产物 release\win-unpacked\resources\app.asar 含 4 类禁串共 52 处`
（`your-repo/issues`×24、`QQ Group: 123456789`×20、`NikkiGallery`×4、`QQ群: 123456789`×4）与我对该文件
逐 needle 的直接计数完全一致（`grep -a -o … | wc -l` 同读数），再次确认这道闸门 fail-closed 判的是**包内字节**；
`win-unpacked-full`(16:00) 那棵的同类计数也是 4/24/20/4。两棵残壳都只剩一个 `app.asar`、无 `app.asar.unpacked`，
即除禁串形状外它们本来就不是完整产物树。

### 13.3 R2 全量静态门 + 全量测试（HEAD `4e52ad4`，源码零改动，排在打包前）

| 门                      | exit | 读数                                                  |
| ----------------------- | ---- | ----------------------------------------------------- |
| `npm run lint`          | 0    | `eslint .` 无输出                                     |
| `npm run typecheck`     | 0    | `tsc -b` + `tsc -p tsconfig.scripts.json`             |
| `npm run typecheck:e2e` | 0    | `tsc --noEmit -p e2e`                                 |
| `npm run i18n:guard`    | 0    | `✅ 白名单只减不增、清零必移除、key 已同步，守卫通过` |
| `npm test`              | 0    | `Test Files 437 passed (437)` / `Tests 6737 passed    | 12 skipped (6749)`/`Duration 44.67s` |

与第十一节所载上一轮读数**逐项相等**（437 / 6737 / 12），本轮无源码改动 ⇒ 既无既有用例被吞也无新增；
比对前提是先确认 `npm run link:nikkisync:check` 为 `check OK (all four links in place)`（链不在位时基线会漂到 434 / 6665 / 51）。

### 13.4 R3 标准配方：本次是**跑到最后一步才红**，红点只有一个文件

`20:16` 起 `npm run dist:win`（**零 `--config` 覆盖**），`BUILD4_END=2026-10-23T20:20:36+0800`，
内层 **`EXIT=1`**（判定读日志内层 `EXIT=`，不读后台通知摘要）。逐段读数：

1. `npm run build`：`clean` 只删 `dist/main` 与 `dist/renderer/assets`，**不碰 `release/`**；产物 mtime
   `dist/main/main/app/index.js` = `2026-10-23T12:20:26.549Z`、`dist/renderer/index.html` = `2026-10-23T12:20:32.250Z`。
2. `npm run pre-dist-check`：**27 条 ✔、0 条 ✖**，含 `✔ git status clean`、
   `✔ 原生模块 ABI 闸门通过：electron=41.10.6，npmRebuild=true，asarUnpack 已覆盖 better-sqlite3/koffi/sharp/@img`、
   `✔ 管理员清单闸门通过：requestedExecutionLevel=asInvoker`，以及 13.0 那三条版本节闸门。
3. `electron-builder --win --publish never`：`@electron/rebuild` 原生依赖就位（`better-sqlite3 ✔`）→
   `• packaging platform=win32 arch=x64 electron=41.10.6 appOutDir=release\win-unpacked` →
   `• downloaded label=electron progress=100%`，**345 MB 全新 Electron 运行时完整解到 `release\win-unpacked.tmp`**
   （第二/三轮在同一条链上 3 秒内就 `EPERM rename` / `EBUSY unlink default_app.asar` 死掉）。
4. 终局红点（原文）：
   `⨯ EBUSY: resource busy or locked, unlink 'D:\Workbuddy 项目\WXNN YD - 副本\WXNN XiangCe\release\win-unpacked\resources\app.asar'`
   —— 落点是 `node_modules/app-builder-lib/out/util/electronGet.js:186` 的
   `await fs.rm(dir, { recursive: true, force: true })`（`force` 只吞 ENOENT，**不吞 EBUSY**），
   下一步 `:187` 才是 `await fs.rename(tmpDir, dir)`。

⇒ **本轮的失败与第二/三轮不是同一件事**：那两轮红在「新解压被主动加锁」，本轮红在
「标准名 `release/win-unpacked` 被一个 4.6 小时未放的历史句柄占死，builder 腾不出这个名字」。
构建链、27 项打包前校验、原生依赖重建、Electron 下载与解压**全绿**——这是四轮里标准配方走得最远的一次。
`executable resource editing and code signing skipped` 依旧是仓内既有配置（`build.win.signAndEditExecutable=false`），
与本轮无关。失败后的 `release/` 只有 13.1 那两棵锁壳（本轮重新填出的 `win-unpacked.tmp` 已整树删净，见探针 7）。

### 13.5 判据口径修正：打包态冒烟到底用哪个启动函数（第九节与 `iron-ravine-starling` 都记错了这一处）

第十一节与上游计划里写的「`e2e:smoke` 经 `launchBuiltApp()` 启 `release/win-unpacked/*.exe`」把两个函数弄反了。
本轮逐文件核对 `e2e/`：

| 启动函数           | 定义                                                                                                                        | 实际启什么                                                                                        | 谁在用                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `launchApp()`      | `e2e/helpers.ts:54` → 内部调 `findUnpackedExe()`（`helpers.ts:20` 的 `glob('release/win-unpacked/*.exe')`，取不到即 throw） | **打包态**：`release/win-unpacked` 里 builder 解出的那个 exe                                      | `e2e/smoke.e2e.ts:51`（8 条）、`e2e/fullscreen-diagnose.e2e.ts:35`（1 条）、`e2e/perf.e2e.ts:111`、`e2e/perf-real.e2e.ts:438/596` |
| `launchBuiltApp()` | `e2e/helpers.ts:147`                                                                                                        | **未打包态**：用仓内 `node_modules/electron` 直接加载 `dist/`，`e2e/dist-guard.ts` 只在这一侧生效 | 仅 `e2e/nikkisync-runtime.e2e.ts:323`（6 条）                                                                                     |

⇒ 两点后果按原文留档：① 打包态取证本来就不经过 `dist-guard`，所以「`tsc -b` 覆写产物树导致 `window.electronAPI` 缺失」
那一类假失败**不会**污染 `smoke` / `fullscreen` 的读数，但**会**污染 nikkisync 那 6 条；
② 因此 `e2e:smoke` 的入口判据是 `release/win-unpacked/*.exe` 是否存在——本轮标准名被 13.1 的锁占着、
里面只有 15:55 的 `resources/app.asar` 而无 exe，**这一条不是被我跳过，而是前提不成立**（跑它只会得到
`未找到 release/win-unpacked/*.exe，请先执行 npm run dist:win` 这一句 throw）。

### 13.6 句柄释放窗口取证：三种频率轮询 106 次，全程未出现

13.1 那次「19:45 四处探针全成功、20:15 同一批又变忙」说明句柄**存在放开过的时刻**，所以本轮按三种频率轮询，
想在窗口出现的瞬间抢下标准名（脚本落 `.cache/r4-poll-and-build.sh` 与 `.cache/r4-tight-poll.sh`，
探针是**同目录 `renameSync(app.asar → app.asar.gone)`**——这正是 `fs.rm` 需要的 DELETE 权限，探针成功即可就地清树）：

| 轮次 | 频率与窗口             | 探针次数 | 读数                                                       |
| ---- | ---------------------- | -------- | ---------------------------------------------------------- |
| 1    | 每 45 s，20:23–20:28   | 7        | 全部 `LOCKED EBUSY`                                        |
| 2    | 每 180 s，20:28–20:31  | 2        | 全部 `LOCKED EBUSY`（为提高命中率提前停掉，改跑高频轮）    |
| 3    | 每 8 s，20:32:30–20:45 | 97       | 末行 `WINDOW_NOT_SEEN 20:45:32 共 97 次探针，句柄全程未放` |

轮询全程未改动 `release/` 里的任何内容；收尾复验那棵 15:55 的 `app.asar` 仍是
`71,380,514 B @15:55:17.890`，反复探针没有把它改坏。

### 13.7 本轮净结论与剩余唯一动作

**净结论四条（每条都有上面的原始读数支撑）**：

1. **审查**：未提交代码为空；现役包逐文件等于当前 HEAD（含外链 `@nikkisync` 运行时）⇒ **没有可修的 Bug，也没有该提交而未提交的改动**。按口径不造空提交、不新增测试——本轮没有真红可复现，做假红-绿反而是违规。
2. **版本**：`2.5.5-beta` 零编辑，并由 `dist:win` 自带的三条版本闸门实跑作证。
3. **回归**：五条静态门 + 全量测试全绿，437 / 6737 / 12 与上一轮逐项相等。
4. **打包**：标准配方四轮以来走得最远——红点从「每次新解压」收窄成「15:55 / 16:00 两个历史 `app.asar` 的残留句柄」这一处；`build` → 27 项 `pre-dist-check` → 原生依赖 → Electron 下载与 345 MB 解压**全绿**，只差 `fs.rm(release\win-unpacked)`。

**为什么本轮不再用旁路出第 4 棵树**：13.0 的哈希对照已证明旁路包与 HEAD 内容逐文件相同，
再走一次 `--config.electronDist` + 新输出目录只会多产一棵**同样会被锁**的树、把 `latest.yml` 的
`releaseDate` 与 `sha512` 换掉，而本轮要拿的恰是「产物落标准位置 + 裸跑闸门自己变绿」这件事本身；
第十二节 12.3 那条「不改回旁路凑成功」的纪律本轮继续遵守。

**剩余唯一动作（用户侧，二选一）**：

| 选项                    | 动作                                                                                                                                                            | 之后可立刻续做的                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A（推荐，一次搞定）** | **重启系统**。13.1 探针 3 已排除一切可枚举的用户态持有者（`WinDefend` Stopped、`WSearch` Disabled、无进程从工作区运行），残留句柄只在内核侧，重启是唯一确定清法 | 重启后回来说一句「继续第四轮」即可：`rm -rf release/win-unpacked*` → `npm run dist:win`（零覆盖）→ R4 九项复算 → 裸跑 `npm run verify:dist` 转绿 → `npm run e2e:smoke` 打包态取证 → 读数补进第十三节，随同一次 `docs(plans)` 提交 |
| B（不打断当前工作）     | 继续等句柄自行释放——18:25 / 18:27 那批约 1.5–2 小时自释，但 15:55 / 16:00 这批已持续 4.8 小时、106 次探针未见窗口                                               | 同 A，只是起始时间不确定                                                                                                                                                                                                          |

**续做时的覆盖边界**：选项 A 跑起来后，`release/` 根上那三件（18:27 现役包）会被同名产物覆盖。
这是可接受的：13.0 已证明新包与它逐文件等价，覆盖只改 `latest.yml` 的 `releaseDate` 与 `sha512`，
而 18:27 那件的 `sha512: S+hfFFBWLXV…` 与体积已在 13.2 留底表里落档，身份可追溯。
真正不可再生的孤本（2.5.3）另在 `_safe_backup_release-2.5.3-20261010/`，本轮未触碰。

**顺带查清的一条历史弱点**：把上一轮旁路树移出 `release/` 之后，裸跑 `verify:dist` 的第一条 ✖
变成「未找到 `release/**/resources/app.asar.unpacked`」（13.2 记了形状）——
即 §10 遗留 #4（`findAsarUnpacked` 靠 readdir 偶然顺序）在**环境侧**已被物理消除，
但**代码侧那条弱点仍在**（它没有显式选择参数），遗留 #4 不因本轮清场而关闭。
