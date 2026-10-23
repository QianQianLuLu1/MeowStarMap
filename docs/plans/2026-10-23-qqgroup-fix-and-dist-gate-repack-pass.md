# 执行记录：反馈弹窗群号修复 + 产物内容禁串闸门 + 2.5.5-beta 重新打包（2026-10-23 第二轮）

> **状态**：已交付。两项修复各自先红后绿；全量静态门与全量测试通过；新安装包
> `release/MeowStarMap-Setup-2.5.5-beta.exe`（183,331,805 B）已产出并逐项验尸。
> **日期**：2026-10-23
> **上游计划**：本次会话计划文件 `iron-ravine-starling`（批准于 18:00 前后），任务原文为
> 「审查未提交代码 → 修复 → 提交 → 版本号定为 2.5.5-beta → 重新打包」。
> **前置记录**：[`2026-10-23-rename-repo-url-stage7.md`](./2026-10-23-rename-repo-url-stage7.md)（阶段 7 仓库 URL 换名，本轮缺陷的来源提交）、
> [`2026-10-23-rename-packaging-pass.md`](./2026-10-23-rename-packaging-pass.md)（阶段 4 打包层更名）
> **本机路径说明**：文中 `.cache/electron-dist-clean`、`release/build-20261023-1825`、
> `_safe_backup_20261023-1825` 均为 gitignored 的本机工作目录，不入仓、不属仓库结构声明。

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

| #   | 项                                                        | 说明与去处                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`release/` 三个残壳删不掉**                             | 管家的 15:47 / 15:55 句柄仍未释放。请给工作区目录加实时防护白名单，或重启后再 `rm -rf release/win-unpacked*`。**在此之前 `npm run verify:dist` 裸跑必红**（新闸门默认指向 `release/win-unpacked`，那里是过期包）——这是刻意的 fail-closed，不是回归；旁路打包时需带 `--asar=<新树路径>`。 |
| 2   | 标准配方本轮未被走通                                      | `npm run dist:win` 的前段（build + pre-dist-check）已实测通过，仅 builder 步被外部锁打断；残壳清掉后标准配方应可原样跑通，无需改任何配置文件。                                                                                                                                           |
| 3   | 复制群号仍带 `QQ群: ` 前缀                                | `FeedbackDialog` 复制整条语包串 ⇒ 用户拿到的是「QQ群: 635492596」而非纯号码，粘进 QQ 搜索框会失败。改它属行为变更（要去前缀或改插值），本轮按最小化改动**只登记不修**。                                                                                                                  |
| 4   | `findAsarUnpacked` 的 readdir 偶然顺序                    | 既有弱点，本轮未改（清空 `release/` 从源头消除歧义）；若将来再出现多树并存，应给它显式选择参数。                                                                                                                                                                                         |
| 5   | `build.publish: [{provider: github}]` 无显式 `owner/repo` | 现经 `repositoryInfo` 从 `repository.url` 派生，今日正确；`--publish never` 下不参与判定。建议显式钉住以解耦，属配置变更，本轮未做。                                                                                                                                                     |
| 6   | `resources/` 不在旧名守卫扫描域内                         | 它经 `build.files` 进包但不在 `roots`。当前该目录仅图标与一个 DLL，实测干净 ⇒ 潜在而非现存缺陷。                                                                                                                                                                                         |
| 7   | `package-lock.json` 工具链抖动                            | 本机 `node v26 + npm 11` 会重写它（删 `ffmpeg-static`/`ffprobe-static` 的 `libc` 字段），CI 钉 `.node-version=22`。按既有口径**还原不入仓**。                                                                                                                                            |

## 十一、提交边界

| 提交                                                                | 范围                                                                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `fix(i18n): 反馈弹窗 QQ 群号占位值改为真实群号 635492596`           | 12 语包 + `scripts/__tests__/ui-brand-name.test.ts`                                                               |
| `feat(dist-check): verify:dist 增加产物内容禁串闸门`                | `scripts/pre-dist-check.ts`、`scripts/__tests__/pre-dist-check.test.ts`、`scripts/__tests__/old-name-ledger.json` |
| `docs(plans): 入库群号修复、产物闸门与 2.5.5-beta 重新打包执行记录` | 本文件                                                                                                            |
| `docs(changelog): 2.5.5-beta 补录群号修复与产物闸门`                | `CHANGELOG.md`                                                                                                    |

`scripts/**` 不在 `build.files`（`dist/**/*` + `resources/**/*` + 对象式 nikkisync 项）范围内，
故修复 B 不要求额外重打包；修复 A 改了语包 ⇒ 必须重打包，已做。版本号未变，`package.json` 零改动。
