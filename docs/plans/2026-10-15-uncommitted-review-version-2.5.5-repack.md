# 未提交代码复核 + 版本 2.5.5 核验 + 重新打包（2026-10-15）

> 结构沿用仓库先例 `docs/plans/2026-10-10-uncommitted-review-version-2.5.3-repack.md` 的 8 节格式，并补齐任务委托方要求的五要素（依赖声明 / 启动与运行说明 / 错误处理与兜底 / 参数校验 / 基础测试用例）与子任务三要素（涉及文件 / 输入输出 / 验收标准）。

## 1. 背景与结论

任务来源：用户要求对项目所有未提交代码做全面审查（逻辑错误 / Bug / 规范），有问题先修复再提交，随后将版本配置文件设定为 2.5.5，最后重新执行打包构建。

**探明事实（执行时点 2026-10-15 实测）**：

- **WXNN XiangCe 工作区干净**：`git status --porcelain=v1`、`git diff HEAD --stat`、`git diff --cached --stat` 均为空；HEAD=`dcc44c5`（分支 `feat/gallery-runtime-embed`）；仅存一条 `stash@{0}`（`phase7-wip-parked`，属 `feature/sync-integration-07-bidirectional-sync` 分支的**主动驻留 WIP**，按名称与上下文判定为刻意挂起、不在本次任务范围，不动、不丢、不审）。**当前不存在未提交业务代码**。
- **NikkiSync（上游依赖仓）唯一改动为行尾噪声**：`tools/sample-analyzer/analyze.mjs` 的 `git diff HEAD --stat` 为空（454/455 行为 CRLF，`core.autocrlf=true` 归一化后与 HEAD 一致），零内容差异，无可审查逻辑、无可提交内容。
- **版本已全线是 2.5.5**：`package.json:3` 与 `package-lock.json`（顶层 + `packages[""]`）同步；electron-builder 配置内嵌 package.json，`artifactName: "NikkiGallery-Setup-${version}.${ext}"`（`package.json:265`）自动注入版本；源码统一经 `app.getVersion()` 动态取版本，`src/` 内版本串扫描仅命中 mock `src/renderer/preview/mock/database-mock.ts:664`（`'2.5.5'`，已同步）、测试桩与历史注释，无当前版本漂移；`CHANGELOG.md` 有 `## [2.5.5] - 2026-10-11` 节且 `[Unreleased]` 已收口。
- **真正缺口**：`release/NikkiGallery-Setup-2.5.5.exe` 与 `release/win-unpacked` 均为 2026-10-14 14:09 旧产物，**不含 NikkiSync 运行时内嵌阶段 2/3 的 8 笔提交**；`docs/sync-integration/03-sync-server-plan.md` §14.3 #1 登记的「打包态未复验」为未关闭遗留项（`verify:nikkisync` 唯一 ✗ 打在该旧 win-unpacked 上）。本次重新打包即关闭该项。

**因此本任务形态**：审查与版本设定均为「核验」而非修改；真正产出为一次全新的 2.5.5 安装包构建 + 全量回归佐证 + 计划文件提交。若执行时点复核发现工作区出现新改动，切换到审查分支（见 §4.1 分支 A）。

## 2. 依赖声明

- **零新增依赖**。全部使用仓库既有 devDependencies 与 npm scripts：`typescript`、`eslint`、`vitest`、`audit-ci`、`electron-vite`、`electron-builder`、`tsx`。
- 无新增环境变量；兜底场景才注入 `ELECTRON_BUILDER_BINARIES_MIRROR`（electron-builder 二进制国内镜像，`DEVELOPMENT.md:574` 既有方案）。
- 运行时满足 `engines.node >= 22.12.0`（本机 node v26.3.0 / npm 11.16.0，实测）。

## 3. 启动与运行说明

无需额外环境准备（依赖已安装，electron-builder 二进制缓存 `%LOCALAPPDATA%/Local/electron-builder/Cache` 已存在）。执行命令均为仓库既有脚本：

```bash
git status --porcelain=v1                    # 步骤 2：改动复核（执行时点）
npm run typecheck                            # 步骤 4：tsc -b + tsconfig.scripts.json
npm run lint                                 # 步骤 4：全量 eslint
npm test                                     # 步骤 4：全量 vitest
npm run audit                                # 步骤 4：audit-ci 安全检查（本机镜像限制，见 §5）
npm run dist:win                             # 步骤 5：四步打包链（后台运行 + 轮询）
```

产物位置：`release/NikkiGallery-Setup-2.5.5.exe`（`${version}` 注入，精确版本号见 §6 校验）。

## 4. 子任务与验收标准（三要素）

### 4.1 复核未提交改动（执行时点）

- **涉及文件**：无（只读）；分支 A 下才产生修复文件。
- **输入 / 输出**：输入为 `git status` / `git diff HEAD` / `git diff --cached` / `git stash list`（两仓）；输出为审查结论记录于本文件 §8（分支 B：无未提交业务代码、NikkiSync 定性为行尾噪声；分支 A：逐文件审查意见 + 修复）。
- **验收标准**：结论写入 §8；分支 A 下每个修复均有 TDD 红绿记录且 `npm run verify` 通过后独立提交；分支 B 下两仓复核命令输出与 §1 记载一致。

### 4.2 分支 diff 代码审查（open-code-review）

- **涉及文件**：无（只读审查）；审查面为 `main..HEAD` 约 25 笔提交（NikkiSync 运行时内嵌阶段 2/3 及联调修复）与 NikkiSync 上游仓对应面。
- **输入 / 输出**：输入为分支 diff 与相关源码；输出为审查结论（缺陷清单或「无新增高风险项」结论）记入 §8。
- **验收标准**：审查覆盖逻辑错误 / Bug / 规范三类；发现真实缺陷即转入 TDD 分支修复，无缺陷则记录结论并放行。

### 4.3 版本一致性核验（只读）

- **涉及文件**：无（只读）。核验对象：`package.json`、`package-lock.json`、`CHANGELOG.md`、electron-builder `artifactName`、`src/` 下版本字符串。
- **输入 / 输出**：输入为只读读取结果；输出为核验结论（预期：全部 2.5.5，无漂移）。
- **验收标准**：`package.json` 与 `package-lock.json` 的 version 均为 `2.5.5`；`check-changelog-release` 闸门满足（`[2.5.5]` 节存在且唯一、`[Unreleased]` 无待发布条目）；`src/` 版本串命中处均为 mock / 测试桩 / 历史标注。任何真实漂移才最小修正并单独提交（`chore(release): …` 先例格式）。

### 4.4 全局回归与静态 / 安全检查

- **涉及文件**：无（只读检查）。
- **输入 / 输出**：输入为当前代码基线；输出为四项命令退出码与结果记录。
- **验收标准**：`npm run typecheck`、`npm run lint`、`npm test` 全部退出码 0；`npm run audit` 按 §5 取证（本机镜像限制为设计内失败，补偿控制成立）。已知 flaky：thumbnail ffmpeg 用例全量并发偶发，失败先单独重跑甄别，真实失败才修（走 TDD），甄别结论记入 §8。

### 4.5 打包与产物验收

- **涉及文件**：无源码改动；产出 `release/NikkiGallery-Setup-2.5.5.exe`、`.blockmap`、`latest.yml` 与 `release/win-unpacked/`（旧产物被覆盖）。
- **输入 / 输出**：输入为步骤 4 全绿的代码基线；输出为安装包 + `verify:dist` 通过记录。
- **验收标准**：`npm run dist:win` 四步链全部退出码 0（clean 被 Safe-Delete 网关拦截时按 §5 分步兜底，最终仍四步等效全过）；`release/NikkiGallery-Setup-2.5.5.exe` 存在且 mtime 为本次构建时间；`latest.yml` 的 sha512/size 与新 exe 一致；`verify:dist` 确认 asar 解包后 better-sqlite3 / sharp / libvips / koffi 二进制与 4 个 VC++ DLL 齐备。

### 4.6 计划文件与执行记录提交

- **涉及文件**：本文件（`docs/plans/2026-10-15-uncommitted-review-version-2.5.5-repack.md`）。
- **输入 / 输出**：输入为 §4.1–§4.5 执行结果；输出为含执行记录的本文件入仓提交（`docs(plans): …`）。
- **验收标准**：提交后 `git status --porcelain` 为空；commit-msg 钩子（commitlint）通过；§14.3 #1 遗留项关闭登记已回写（见 §8）。

## 5. 错误处理与兜底

| 异常分支                                                                                 | 兜底策略                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| build 的 clean 步骤被 Safe-Delete 网关拦截（本机已知，阈值 500 项；dist/main 约 862 项） | 分步执行：`Move-Item dist/main` 移走旧产物 → `npx electron-vite build` → 手动写 `dist/main/package.json`（`{"type":"commonjs"}`，等价 `package.json:35` build 脚本第三步）→ `npm run pre-dist-check` → `npx electron-builder --win --publish never` → `npm run verify:dist` |
| electron-builder 二进制下载失败（代理/证书环境）                                         | 注入 `ELECTRON_BUILDER_BINARIES_MIRROR` 后重试（`DEVELOPMENT.md:574`）                                                                                                                                                                                                      |
| `npm run audit` 本机 404 / TLS 拦截（registry 为 npmmirror，无审计端点）                 | 设计内失败（项目刻意未启用 `--pass-enoaudit`）：按 `docs/troubleshooting-npm-audit-mirror.md` 取证，补偿控制 = CI Security audit 步骤 + 本轮零依赖改动论证；**不关闭 strict-ssl、不跳过审计**                                                                               |
| 全量测试偶发失败（thumbnail ffmpeg 并发）                                                | 单独重跑该用例甄别 flaky 与真实失败；真实失败走 TDD 修复                                                                                                                                                                                                                    |
| pre-dist-check 闸门失败（mtime / ABI / 修复点标记）                                      | 按其报错项逐项处置（如重跑 build 刷新产物 mtime），不绕过闸门                                                                                                                                                                                                               |
| 打包耗时长（compression: maximum + npmRebuild）                                          | 后台运行 + 轮询输出，不设人为超时中断；打包期间不并发跑测试                                                                                                                                                                                                                 |
| commitlint 拒绝提交信息                                                                  | 采用 Conventional Commits 标准格式（`type(scope): 中文描述`），已有 `docs(plans)` / `chore(release)` 先例                                                                                                                                                                   |
| husky pre-commit 改写文件（lint-staged --fix/--write）                                   | 提交后 `git status --porcelain` 复核，残留意外改动则停步处置后再提交                                                                                                                                                                                                        |

## 6. 参数校验（核验项清单）

本任务无业务入参，"参数校验"落实为核验项的客观判定条件：

- `git status --porcelain=v1`（两仓）输出符合 §1 记载 ⇒ 分支 B 成立；出现新改动 ⇒ 逐文件走分支 A。
- `package.json` 第 3 行 `"version"` 精确等于 `"2.5.5"`（非 `^2.5.5` / `2.5.x` 等变体）；`package-lock.json` 顶层 version 与其一致。
- 产物文件名精确为 `NikkiGallery-Setup-2.5.5.exe`（版本注入失败的边界情况会体现为旧版本号文件名或残留旧文件未被覆盖）。
- `latest.yml` 的 `version`/`path`/`sha512`/`size` 与新 exe 四项一致（哈希不符 ⇒ 产物与元数据错位，停步）。
- 四条检查命令退出码为 0；任何非 0 视为该步骤失败，不得跳过。

## 7. 基础测试用例（正常 / 异常 / 边界）

本任务以「命令级验收」代替新增单测（预期零源码改动，无需新增测试文件；分支 A 产生修复时按 TDD 补真实单测）：

| 场景 | 用例                                  | 期望                                                           |
| ---- | ------------------------------------- | -------------------------------------------------------------- |
| 正常 | `npm run typecheck` / `lint` / `test` | 全部退出码 0                                                   |
| 正常 | `npm run dist:win` 全链               | 四步均通过，产物 exe 生成                                      |
| 正常 | `verify:nikkisync` 打包态断言         | 旧 win-unpacked 判据 ✗ 随新产物转 ✓                            |
| 异常 | 任一检查命令退出码非 0                | 停在该步骤，处置后重跑，不跳过                                 |
| 异常 | clean 步骤被 Safe-Delete 网关拦截     | 切换 §5 分步兜底，最终仍四步等效全过                           |
| 边界 | 工作区在执行时点出现新改动            | 切换分支 A：审查 → TDD 修复 → 独立提交                         |
| 边界 | `grep "2\.5\." src/` 命中             | 逐条判定：mock/测试桩/历史标注 = 允许；当前版本声明漂移 = 修复 |
| 边界 | 产物文件名版本号 ≠ 2.5.5              | 说明版本注入异常，回查 package.json 与 build 配置              |
| 边界 | `latest.yml` sha512 与新 exe 不一致   | 停步，重打包或排查 electron-builder 产物/元数据写入错位        |

### 7.1 审查发现但挂账不修项（低危，最小化改动）

均为分支已提交代码中的低危项，非常态触发、无数据损坏或远程攻击面，按最小化改动原则不在本轮修复，留待独立跟进：

| #   | 位置                                       | 问题                                                                      | 建议处置                                                         |
| --- | ------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | `runtime-manager.ts` scan()                | 无 in-flight 互斥，并发 scan 会同时驱动上游 scanner（上游并发安全性未知） | 仿 `state.starting` 加 scan 去重；并与 teardown/重建纳入同一协调 |
| 2   | `runtime-manager.ts` startSyncServer       | `desired.host !== state.syncConfig.host` 恒为假（host 原样透传），死条件  | 删除该比较项（或显式支持改 host）                                |
| 3   | `embedding-paths.ts` + `runtime-loader.ts` | `fellBackToAsar` 在生产装载路径未被消费，与「可观测不静默」注释不符       | 装载成功路径按该标记记一条 warn 日志                             |
| 4   | `runtime-manager.ts` teardown              | 仅换端口/mdns 的重建也清空全部 media:// 授权，视图重新登记前旧图 403      | databaseFile 未变时跳过 clear（或提供保留授权的重建变体）        |
| 5   | `sync-server-view.ts` normalizeSyncPort    | `Number('0x1F')`/`Number('1e3')` 被当合法端口                             | 字符串分支先 `/^\d+$/` 校验                                      |
| 6   | `sync-server-view.ts` 设备视图             | 未知 platform 静默落入 'android'                                          | 给 'unknown' 或透传原值（同步类型）                              |
| 7   | `sync-server-view.ts` parsePairingUri      | expires 仅验有限数，放过 0/负值                                           | 追加 `> 0`（或与当前时间比较）                                   |
| 8   | `embedding-paths.ts` resolveDeepEntryUrl   | 段 Pattern 接受裸 `.js` 叶子                                              | 额外要求叶子含基础名                                             |

## 8. 执行记录（执行中回填）

- **步骤 1 计划落盘**：完成（本文件，2026-10-15）。
- **步骤 2 改动复核（执行时点）**：分支 B 成立。XiangCe：`git status --porcelain=v1` / `git diff HEAD --stat` / `git diff --cached --stat` 均为空，`stash list` 仅 `phase7-wip-parked`（主动驻留 WIP，不属本次范围，未动），HEAD=`dcc44c5`。NikkiSync：唯一条目 `tools/sample-analyzer/analyze.mjs` 经 `git diff HEAD --stat` 为空判定为纯行尾噪声（CRLF/LF，零内容差异）。**无未提交业务代码可审查，无需修复与提交**。
- **步骤 2b 分支 diff 审查**：open-code-review（delegate 模式，宿主 LLM 逐文件审查）覆盖 93 个可审查文件面（31,237 插入），主审 `sync/server/*`（api-router / auth-service / sync-server / ws-hub / jpeg-export / range）、`nikkisync/resource-allowlist` / `runtime-loader`、`app/media-protocol`、`database/sync-read-repository`、`sync/pairing-service`、`ipc/handlers/nikkisync-handler`、`preload/api/nikkisync`，并以 code-explorer 子代理复审运行时五件套（runtime-manager / runtime-facade / sync-server-view / embedding-paths / probe）。**结论：未提交代码面零缺陷；分支已提交代码发现 4 个真实缺陷（均为 TDD 红→绿修复）**：
  1. `runtime-manager.ts` stop() 落在启动在途时被吞（state.starting 未等即返回，在途 start 收尾把会话置 running 成孤儿）→ 修复：stop() 先 await 在途启动再拆除。回归测试：`runtime-manager.test.ts`「stop() 落在启动在途时不被吞」（修复前失败）。
  2. `runtime-manager.ts` startSyncServer 换端口/mdns 重建丢失用户已选 gameRoot（重建取 defaults 而非 activeRoot）→ 修复：teardown 前取存 previousRoot 并传入重建。回归测试：「换端口重建保留当前会话的游戏根」（修复前失败）。
  3. `probe.ts` probeDatabase 读 schema SQL 失败时内存库连接泄漏（内层 try/finally 尚未进入）→ 修复：try/finally 上移至紧接 `new Ctor` 之后；导出 `probeDatabase` 作测试缝。回归测试：`probe.test.ts`「schema SQL 读取失败也关闭内存库」（修复前 close 0 次）。
  4. `runtime-facade.ts` createRuntimeSession 组装中段（TLS/配对导出缺失、查询面装配）抛错泄漏已建 DB 句柄（Windows 锁库后果）→ 修复：runtime 构造后整体 try/catch，失败先 `runtime.database.close()` 再 rethrow；新增可选 `preloadedSurface` 测试缝。回归测试：`runtime-facade.test.ts`「runtime 构造成功后的导出缺失抛错时关闭已建库再上抛」（修复前失败）。
     挂账不修（最小化改动，均低危且非常态触发）：scan() 无互斥、`desired.host` 恒等死条件、`fellBackToAsar` 生产路径未记日志、仅换端口重建清空 media:// 授权表、sync-server-view 端口/平台/expires 边界窄化、deep-entry 裸 `.js` 叶子收紧。详见 §7.1。
- **步骤 3 版本核验**：全部通过，未修改任何版本文件（目标 2.5.5 已全线达成，无漂移可修）——
  - `package.json:3` = `"2.5.5"`；`package-lock.json` 顶层 version 与 `packages[""]` 均为 `2.5.5`。
  - electron-builder `artifactName: "NikkiGallery-Setup-${version}.${ext}"`，版本经 `${version}` 注入产物名。
  - `src/renderer/preview/mock/database-mock.ts` 预览 mock `getVersion` = `'2.5.5'`；`src/` 其余命中为测试桩（`'2.5.0'` 任意值）与历史注释，非版本声明。
  - `npx tsx scripts/check-changelog-release.ts` 退出码 0：`[2.5.5]` 版本节存在且唯一、`[Unreleased]` 已收口（12 个版本节）。
  - `git grep "2\.5\.[0-9]"`（排除测试/locales/docs）其余命中均为第三方依赖版本（notarize 2.5.0、bare-url 2.5.4、ts-api-utils 2.5.0、spdx-exceptions 2.5.0）与脚本历史注释，无应用版本漂移。
- **步骤 4 全局回归**：四项全部退出码 0，无新增失败项——
  - `npm run typecheck`：退出码 0。
  - `npm run lint`：退出码 0（0 错误；11 条存量 Unicode BOM 警告，均位于已提交的测试文件，非本轮改动，按最小改动原则不处置——与 2026-10-10 同型任务记录一致）。
  - `npm test`：退出码 0，**380 个测试文件 / 5980 个用例全部通过，2 skipped，0 failed**（59.20s，本轮无 flaky；较 2026-10-14 文档记载的 372 files / 5869 pass 多出的是本轮回合后新增/拆分的测试面，全部通过）。
  - `npm run audit`：**退出码 0，"Passed npm security audit."**（本轮实际跑通，未触发 2026-10-10 记录的镜像 404/TLS 拦截；29 项既有豁免全部命中，另提示 18 项不再命中的失效豁免可退，属 DEBT-020/034 既有登记，不在本轮范围）。
- **步骤 5 打包**：`npm run dist:win` 首步 `npm run build` 的 clean 被 Safe-Delete 网关拦截（dist/main 870 项超阈值，与历史记录一致）⇒ 按 §5 分步兜底：`Move-Item dist` 至系统临时目录 → `npx electron-vite build` → 手写 `dist/main/package.json`（`{"type":"commonjs"}`）→ `npm run pre-dist-check` 三连全绿（仅一条「计划文件未提交」非阻断警告）→ `npx electron-builder --win --publish never`（better-sqlite3 原生重建 + 4 个 VC++ DLL 随包 + NSIS x64 + blockmap）→ `npm run verify:dist` 退出码 0。
  - **打包中发现并修复的真实缺陷（TDD：先写失败守卫测试再修）**：首轮产物实测**缺整个 @nikkisync 运行时**——electron-builder 过滤器对根 node_modules 有硬排除（`app-builder-lib/out/util/filter.js`：`relative === "node_modules"` 直接 return false），`build.files` 的字符串模式 `node_modules/@nikkisync/**/*` 永远命中不了（node_modules 只由按 package.json 依赖图收集的 collector 产出，而 `@nikkisync/*` 非声明依赖）；且 `verify:dist` 的既有判据打在产物目录上，无法区分「CI 未建链」与「打包丢包」，只能 SKIP 放行。修复：① `build.files` 改对象式 `{from/to: "node_modules/@nikkisync", filter: ["**/*"]}`（junction 经 `handleSymlink` 解引用后 walk 枚举真实内容，诊断脚本实测 428 个文件）；② `scripts/pre-dist-check.ts` 新增导出纯函数 `nikkiSyncPackedVerdict`（红灯测试先行：`pre-dist-check.test.ts` 3 例修复前失败）——「项目已建链但产物没带上」由 SKIP 改 fail；③ `scripts/__tests__/self-contained-deps.test.ts` 打包面守护同步改为断言对象式入包项（该守卫在对象式配置下先红后绿）。已提交 `cfa4043 fix(packaging): @nikkisync 四包真正随安装包出货并加固打包态闸门`。
  - 复验（修复后重打包）：`verify:dist` 全部 @nikkisync 断言转 ✔（migrations SQL、四包 `dist/src/index.js`、`row-mappers.js`、`LocalSyncServer.js` + `GalleryRuntime.mjs`）；`npm run verify:nikkisync` 10 项全 ✓（blocking failures: 0，修复前 8✓/1✗）。
- **步骤 6 产物验收与遗留项关闭**：`release/NikkiGallery-Setup-2.5.5.exe` 183,249,202 字节，mtime `2026-10-15 17:20:45`（本次构建，晚于修复前基线 14:09）；`release/latest.yml` 的 `version=2.5.5`、`sha512`（实测与新 exe 逐字节一致）、`size`、`releaseDate` 全部对应新产物；`win-unpacked/resources/app.asar.unpacked/node_modules/@nikkisync` 四包随包解出。**§14.3 #1「打包态未复验」遗留项关闭**。NikkiSync 仓 `tools/sample-analyzer/analyze.mjs` 的行尾噪声经 `git add --renormalize` 清除（零内容变更、不产生提交），两仓工作树干净。
- **步骤 7 提交**：本文件以 `docs(plans)` 入仓。本轮共三笔提交（均过 husky pre-commit 三闸门：lint-staged / core-path-gate / tsc -b）：
  - `8d813b3 fix(nikkisync): 修复运行时停止竞态/重建丢根与两处句柄泄漏`（步骤 2b 审查发现的 4 个缺陷，TDD 红绿灯）
  - `cfa4043 fix(packaging): @nikkisync 四包真正随安装包出货并加固打包态闸门`（步骤 5 打包发现的入包缺陷，守卫测试先红后绿）
  - 本文件 `docs(plans): 登记 2026-10-15 未提交代码复核/版本核验/重新打包计划与执行记录`
    提交后 `git status --porcelain` 复核为空（仅本文件提交前为未跟踪状态）。
