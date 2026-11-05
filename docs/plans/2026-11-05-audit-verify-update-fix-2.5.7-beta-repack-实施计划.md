# 未打包改动审查 → 修复 → 全绿 → 提交 → 重打包 2.5.7-beta（2026-11-05）

> 本轮是**审查轮**：对「尚未纳入打包的改动」做白盒复核、修掉查出的缺陷、跑全套闸门、提交并重打包。
> 计划先经会话内批准（`jade-beacon-gudgeon`），再按本仓惯例把计划与实测读数落盘为本文件。
> 被审查的实现轮见 `docs/plans/2026-11-05-fix-update-check-network-busy-misreport.md`（该文件是实现轮的
> 出处，本轮只在其之外追加修正，不回写它的红绿分账）。

## Context（为什么改）

**范围取证（实测，不是推断）**

| 判据           | 读数                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作区         | `git status` 仅 26 个**已暂存**文件（+1836 / −24）；`git diff` 空、无未跟踪文件、无 stash 涉及本批                                                                      |
| 打包基线       | `release/MeowStarMap-Setup-2.5.7-beta.exe` 与 `release/win-unpacked/resources/app.asar` 均为 11:42–11:43                                                                |
| HEAD 时间      | `c265a9c` 提交于 11:38:37 ⇒ **早于打包** ⇒ 所有已提交改动都在包里（asar 内可搜到 `cdn-user-agent`，搜不到 `updateSourceUnavailable`）                                   |
| 待审源文件时间 | `update-error-class.ts` 16:00、`locales/zh-CN.json` 16:11 ⇒ **全部晚于打包**                                                                                            |
| 结论           | **尚未纳入打包的提交 = 0 个**；待审对象 = 这批未提交的「检查更新误报」修复                                                                                              |
| 版本           | `package.json` / lock 根 / `packages[""]` / `src/renderer/preview/mock/database-mock.ts:664` / `release/latest.yml` 五处均已是 `2.5.7-beta` ⇒ **本轮不做 bump，只确认** |

## 一、依赖声明

**零新增依赖、零版本变更。** `electron-updater` 已是 `^6.8.9` 生产依赖；分类器与夹具服务只用 stdlib（`node:crypto` / `node:http` / `node:fs`）与现有 dev 工具链（`tsx`、`vitest`）。本轮改动后 `package-lock.json` 的 blob 哈希与 HEAD 逐字节相同（见 §五 读数 1），确认安装动作未改写依赖面。

## 二、启动与运行说明

```bash
# 0) 依赖面（含本机装载链的已知破坏性，见 §六 风险 R-nik）
npm run link:nikkisync:check      # 改前取证
npm install                       # 会把 @nikkisync 四条 junction 判为 extraneous 剪掉
npm run link:nikkisync            # 复原（需同级 ../NikkiSync 仓在位）
npm run verify:nikkisync          # 装载链闭包取证

# 1) 单节点（本轮唯一代码缺陷的 TDD 闭环）
npx vitest run src/main/app/auto-update.test.ts

# 2) 闸门与全局回归
npm run build
npm run typecheck && npm run typecheck:e2e && npm run lint
npm run i18n:guard && npm run docs:links
npm test && npm run test:coverage && npm run test:ci-linux
npm run verify                    # 只读五项
npm run e2e:smoke

# 3) 重打包（终点含本轮新增的发布闸门）
npm run dist:win
```

## 三、错误处理

- **F1 的修复方向**：`downloadUpdate()` 的 catch **不再推送**，只做带 `errorKind` 的 `logger.error`；推送唯一由 `autoUpdater.on('error')` 负责。依据是上游 `AppUpdater.downloadUpdate` 的 `errorHandler` 先 `dispatchError(e)` 再 `throw e`（`node_modules/electron-updater/out/AppUpdater.js:650-672`），两条路都会到达本模块。与同文件 `checkForUpdates()` 的 catch 同口径（`auto-update.ts` 那句「error 事件通常已触发；此处仅补一道日志，不重复推 error」）。
- 归类结果只进日志与载荷字段，UI 不渲染原始英文 `errorMessage`（约定 §2「技术细节留日志」）。
- 未初始化（dev 未开假源）经 `AppError.preconditionFailed` → `wrapHandler` → `IPC_PRECONDITION_FAILED` → 渲染层 `about-sections` 的 catch 跳官网；`details` 不放路径。
- 发布闸门 `checkUpdateFeedArtifacts()` 的三类磁盘读取失败（`release/` 不可读 / `latest.yml` 不可读 / `package.json` 不可读）各自 `fail()` 并终止该项，不改判成通过。

## 四、参数校验

- `classifyUpdateError(err: unknown)`：入参形状不受限，`null` / `undefined` / 裸字符串 / 无字段对象 ⇒ 兜底 `source`，**永不抛错**。
- `checkForUpdates()`：`!initialized` ⇒ 抛 `AppError.preconditionFailed`，且**必须在 `pushUpdate({stage:'checking'})` 之前**（否则 UI 先闪「正在检查更新…」再无声收场）。
- `verifyUpdateFeedArtifacts({files, feedYml, appVersion})`：`appVersion` 不匹配 `^\d+\.\d+\.\d+(-[\w.]+)?$` ⇒ 直接 `['bad-app-version']` 且不再往下判；`feedYml === null` 或 `files === []` ⇒ `missing-feed`；缺 `version` 或 `path` ⇒ `feed-unparsable`；`files` 或 `files[]` 里任一条 url 不在清单 ⇒ `missing-payload`。
- `parseServeFeedArgs`：`--port` 必须 1024–65535 整数、缺值或值以 `--` 开头即拒；`--version` 必须合法 semver；未知参数即拒；`--dir` 归一后命中 `/[\\/]release([\\/]|$)/i` 即拒。

## 五、实施节点与红绿读数（本轮唯一代码缺陷）

| 节点         | 涉及文件                                                                                                                                 | 输入 → 输出                                                                                                                                                                                                                                                        | 验收标准与实测读数                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **F1 红灯**  | `src/main/app/auto-update.test.ts`                                                                                                       | 把 download 用例的 mock 改按上游真实形状：调用时先 `emit('error', err)` 再 `throw err`；断言末条推送 `errorKind:'network'` **且** `stage==='error'` 恰 1 条 → `Tests 1 failed \| 16 passed (17)`，失败原文 `expected [ Array(2) ] to have a length of 1 but got 2` | 红灯达成（修复前必红），未新增跳过、未改弱任何断言                                                            |
| **F1 绿灯**  | `src/main/app/auto-update.ts`                                                                                                            | `downloadUpdate()` 的 catch 删 `pushUpdate`，保留分类日志 → `Tests 17 passed (17)`                                                                                                                                                                                 | 局部回归 `npx vitest run src/main/app src/main/ipc/handlers/app-handler.test.ts` = **31 文件 / 572 例全通过** |
| **F2 注释**  | `src/main/ipc/handlers/app-handler.ts`（顶部 `@core-change` **替换** + 通道注释订正）、`src/main/app/lifecycle.ts`（两处「仅生产环境」） | 陈明 dev 两态与 `IPC_PRECONDITION_FAILED` 现实 → 零语义改动                                                                                                                                                                                                        | `npx tsx scripts/core-path-gate.ts` = `✓ 核心路径授权闸门通过（1 个受保护文件）`；`npm run lint` 退出 0       |
| **F2c 指引** | `src/main/app/AGENTS.md`                                                                                                                 | `auto-update.ts` 行改「生产/dev 假源两态」、补 `update-error-class.ts` 行、计数由「27 源文件 / 23 有同名测试」订正为「29 / 26」（实测：无同名套件的只剩 `app-context.ts`、`cleanup.ts`、`renderer-bridge.ts`）                                                     | `npx prettier --check --end-of-line auto` 绿；`npm run docs:links` 退出 0                                     |
| **F3 登记**  | `CHANGELOG.md` 的 `[2.5.7-beta]` 节                                                                                                      | Added 1 条、Fixed 3 条（含 F1）、Changed 3 条；取证只写 commit 短哈希 `5edb719`，**不新增 `docs/plans/**` 快照引用**                                                                                                                                               | `npx tsx scripts/check-changelog-release.ts` 退出 0；`npx prettier --check` 绿                                |

## 六、全局校验读数（本轮实跑，全部退出码 0）

| 项                                    | 读数                                                                                                                                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install`                         | 退出 0，`removed 4 packages in 1s`（即被剪的 `@nikkisync` 四条 junction）；`package-lock.json` 的 worktree / index / HEAD blob 哈希同为 `3937f07…` ⇒ **内容零改写**（`git status` 的 ` M` 只是 mtime 造成的 stat 缓存，`git diff --quiet` 判无差异） |
| 装载链复原                            | `npm run link:nikkisync` = `done (4 link(s) written)`；`npm run verify:nikkisync` = `OK (blocking failures: 0)`（含 53 模块闭包、外部依赖 qrcode/dijkstrajs/pngjs 已解包）                                                                           |
| `npm run build`                       | 退出 0                                                                                                                                                                                                                                               |
| `npm run typecheck` / `typecheck:e2e` | 退出 0 / 退出 0                                                                                                                                                                                                                                      |
| `npm run lint`                        | 退出 0（`eslint .` 全量）                                                                                                                                                                                                                            |
| `npm run i18n:guard`                  | `✅ 白名单只减不增、清零必移除、key 已同步`                                                                                                                                                                                                          |
| `npm run docs:links`                  | `✅ 无死引用（另有 189 处提醒）`                                                                                                                                                                                                                     |
| `npm test`                            | **475 文件全通过 / 7638 passed \| 20 skipped**，56.69s                                                                                                                                                                                               |
| `npm run test:coverage`               | 退出 0；All files **71.93 / 63.48 / 65.08 / 73.53**（阈值 66 / 58 / 59 / 68）；`main/app` 84.43 / 75.56 / 72.87 / 85.91                                                                                                                              |
| `npm run test:ci-linux`               | **475 文件 / 7655 passed \| 3 skipped**，44.15s（新测试在 ubuntu 宿主语义下同样成立）                                                                                                                                                                |
| `npm run verify`                      | `[VERIFY] 总计: 5 项, 0 失败`（typecheck / lint / core-gate / format / test 全 ✓；⚠ 一条为 `src/shared/types/electron-api.ts` 无同名套件，属纯类型文件的既有现状）                                                                                   |
| `npm run e2e:smoke`                   | 重打包**前** 19 passed（37.6s，跑的是 11:42 的旧包）；重打包**后** 19 passed（38.2s，跑的是 18:09 的新包）                                                                                                                                           |
| `npm run dist:win`                    | 退出 0；`[pre-dist-check] ✅ 全部校验通过，可以执行打包。` + `✅ 解包产物校验通过。`，共 49 条 `✔`；新闸门行 `✔ 更新元数据自洽：latest.yml version=2.5.7-beta 且安装包在列`                                                                          |
| 产物                                  | `MeowStarMap-Setup-2.5.7-beta.exe` 18:09，**184,899,418** 字节（上轮 184,943,020，少 43,602）；`release/latest.yml` `version: 2.5.7-beta`                                                                                                            |
| 入包取证                              | 新 `app.asar` 内 `updateSourceUnavailable` 命中 25、`updaterNotInit` 命中 25 ⇒ 本轮改动确已出货（对照：11:42 的包两处均为 0）                                                                                                                        |
| 提交                                  | `5edb719 fix(app): 检查更新按 errorKind 分流，dev 未初始化抛 PRECONDITION_FAILED`，28 files changed / +1858 / −32；pre-commit 三步全 PASSED（lint-staged、core-gate、`tsc -b`）；提交后 `git status --porcelain` 无钩子残留                          |
| 归档                                  | 上一轮同版本产物（exe / blockmap / latest.yml / builder-debug.yml / win-unpacked）整体移入 `release/build-20261105-updatefix/`；`release/` 被 gitignore，`git status --porcelain release/` 为空                                                      |

**无残留取证**：`%LOCALAPPDATA%\meow-star-map-updater-dev` 不存在（本轮未起假源）；`.cache/dev-update-feed` 未生成；生产更新缓存 `%LOCALAPPDATA%\meow-star-map-updater\installer.exe` 仍停在 11:43（本轮未点下载，未被改写）。

## 七、审查判定：实现轮做对了什么（独立复核，非照抄）

- **R2 的机理成立**：`GitHubProvider.js:51-93` 在 `allowPrerelease=true` 且当前版本带预发布段时，逐条 `semver.valid(hrefTag)` 筛 feed、历史 tag 全被跳过；`false` 才走 `getLatestTagName()` → `/releases/latest`。
- **不设 `channel` 是对的**：`AppUpdater.js:33-45` 的 setter 连带置 `allowDowngrade = true`，会打开降级面。
- **分类顺序是关键且被测试钉住**：`getLatestTagName` 会把 DNS 失败包装进 `ERR_UPDATER_LATEST_VERSION_NOT_FOUND` 的 message，故传输层信号必须先于 `ERR_UPDATER_` 前缀；兜底取 `source`。
- **契约与规范面**：`docs/IPC_CONTRACT.md` §17 补齐了此前完全未登记的 `app:update*` 四条通道；`errorKind` 为可选字段（约定 §1 向后兼容）；12 语包两枚新键均为真实译文、无空串；索引与工作区 `i/lf w/lf`、零 BOM（约定 §5）；新发布闸门只在 windows-latest 的 build job 执行且对当前 `release/` 自洽 ⇒ 不会把现有 CI 打红。
- **测试有效性**：无 `it.skip`、无弱化断言；`UpdateDialog.test.tsx` 从源码字符串断言升级为 render 型分流；`serve-dev-update-feed.test.ts` 不触端口、不落盘。

## 八、记账不修（评估后代价/风险大于收益，逐条交代）

| #   | 事实                                                                                                                                                             | 为何不改                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `downloadUpdate()` 在 `!initialized` 时静默 `return`，而 handler 仍返回 `{downloading:true}`（与已修的 check 侧不对称）                                          | 下载按钮仅在 `available` 事件后可达，而 `available` 前提就是已初始化；改成抛错反而把「无反馈」变成「报错」，语义收益为负                   |
| 2   | `initAutoUpdater` 无重入守卫（重复调用会二次注册 `error` 监听 ⇒ 真双推）                                                                                         | 全仓唯一调用点是 `lifecycle.ts` 阶段 6.5，无重入路径；加守卫属防御性冗余                                                                   |
| 3   | 未监听 `update-cancelled`                                                                                                                                        | 应用内无取消下载的入口（`later` 只关闭模态，token 从不取消）                                                                               |
| 4   | `feedScalar` 的行尾锚 `$` 依赖 LF                                                                                                                                | 实测 `release/latest.yml` 零 CRLF；仓库 git 索引恒 LF（约定 §5），CRLF 形态会被 prettier 闸门先行拦下                                      |
| 5   | GitHub 403（限流）归入 `source`                                                                                                                                  | 判据表明文「其余 4xx ⇒ 源内容问题」；文案已不再冤网络，改判据需同批改判据表与测试，超出本轮范围                                            |
| 6   | 夹具服务每请求两次 `readFileSync`（Content-Length 与正文各一次）；`--no-yml` 会在磁盘留一枚空 `latest.yml`                                                       | dev-only、假包仅 4KB、产物目录被 `.gitignore` 的 `.cache/` 覆盖                                                                            |
| 7   | `RELEASE_SEGMENT` 按串形态拒绝「任何名为 release 的目录段」，若仓库被克隆到 `D:\release\…` 会拒绝默认目录                                                        | 判据是 fail-closed（宁多拒不误放），且仓库实际路径不含该段；改成 ROOT 比对需重做 4 条边界用例                                              |
| 8   | `UpdateDialog` 在缺省 `errorKind` 时走「网络繁忙」，与实现轮计划文档正文写的方向相反                                                                             | 代码注释与 §17 契约均已声明该取舍，并有「旧事件不带 errorKind 仍按网络繁忙」的回归锁钉住；实现轮文档正文按原文保留不改（改了等于销毁取证） |
| 9   | `src/main/app/AGENTS.md` 的表格此前就缺 `cdn-user-agent.ts` / `gpu-preference.ts` / `gpu-status.ts` / `nikkisync-runtime-setup.ts` / `sync-server-setup.ts` 五行 | 属更早轮次的文档漂移，不在本轮改动面；本轮只补自己新增的 `update-error-class.ts` 与被证伪的表述                                            |

## 九、交付后仍需发布人执行的一步（代码无法代做）

真实环境目前仍不会出现「发现新版本」弹窗：GitHub 上 10 个 Release 无一携带 `latest.yml`。修复后该情形如实显示「未获取到可用的更新信息」，但要进入下载链路，须任选 ①编辑 Release 把 `release/latest.yml` 与 `.exe` 同批上传，或 ②推 `v<semver>` 形式的 tag 让 CI 的 `Publish GitHub Release`（glob `release/*.exe + release/latest*.yml`）代传；且 feed 上需存在**严格高于装机版本**的 release。另注：本轮产物版本仍为 `2.5.7-beta`，已装同版本的客户端再检查得到「当前已是最新版本」（`allowDowngrade` 默认 false，不降级），这是正确结论。
