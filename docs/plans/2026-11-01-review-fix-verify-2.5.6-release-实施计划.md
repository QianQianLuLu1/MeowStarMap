# 全量审查 → 修复 → 六项验证 → 提交 → 2.5.6 定版 → 重新打包 实施计划

- 日期：2026-11-01
- 范围：未提交的全屏预览修复（topbar-fix + jitter-fix）+ 近期代码提交（搭配码面板 200691f、NikkiSync 账号作用域批次 97555c5…f8d357c）的独立复审收口，以及 2.5.6-beta → 2.5.6 定版与重新打包。
- 前置状态：三路并行审查已完成（全屏未提交改动 / NikkiSync 批次 / 搭配码 200691f + 发布基建盘点），关键发现均经人工复核源码确认。

## 审查结论摘要

| 级别 | 编号 | 位置                                   | 结论                                                                                                                                        |
| ---- | ---- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | F1   | `SlideshowPlayer.tsx:154-157`          | 暂停态改播放间隔被拉回播放（`useSlideshow.start` 依赖 `[interval]`，interval 变化重建引用 → 自动启动 effect 重入强制 `setIsPlaying(true)`） |
| P2   | F2   | `SlideshowPlayer.tsx:159-161`          | `videoEndedRef` 过期标记跨手动导航/暂停残留，暂停态可被视频播完事件无声恢复                                                                 |
| P2   | F3   | `resource-allowlist.ts:79-105`         | 样例缩略图的单条 media:// 授权被并发换 revision 的整表登记 `clear()` 清掉，无补偿 → b4bcd88 修复的 403 裂图间歇性回归                       |
| P3   | F4   | `nikkisync-handler.ts:708-744,770-780` | add/remove-extra-directory 改变作用域但不推 `nikkisync:library-changed`（与 D3 判据不一致，本批同文件顺带修）                               |
| P3   | F5   | `nikkisync-handler.ts:1-2`             | 受保护路径 `@core-change` 历史被整段覆盖，补历史括注（本批触碰该文件时顺带修）                                                              |

登记后续清理（本轮不改，防止改动扩散）：全屏 P3×5（SP 宽高 0 值守卫、FV ref 命中复位 imgError 边缘、jitter④ 末尾断言偏弱、`togglePlay` 依赖整个 slideshow 对象、视频 URL 离屏 probe）；搭配码 A-P2 缓存无容量上限/TTL + A-P3×6（并发同码去重、fetchJson 全量缓冲、IdMap 上下文感知、structured 三处副本、routeKind 判位、负缓存语义）；nikkisync P3-2 preview assetId ∈ samples 纵深校验、P3-4 refreshAccounts 失败遗留陈旧态。

## 1. 依赖声明

- **无新增运行时/开发依赖**。全部修复使用仓库既有 API 与测试装置（vitest、@testing-library/react、现有 FakeImage/uiStore 驱动）。
- 版本号定版仅改声明位字面量，不引入包。

## 2. 启动与运行说明

- 环境准备：本机 Node 26.3.0 / npm 11（无 ABI 问题）；`@nikkisync` 链接经 `npm run link:nikkisync` 建立。
- 开发验证：`npm run verify`（只读：typecheck + eslint 只读 + prettier --check + 相关单测）。
- 全量验证链（六项，按序）：`npm install`（跑完立即恢复，见 §6）→ `npm run build` → `npm run typecheck` → `npm run test` → `npm run e2e:smoke` → `npm run test:ci-linux`。
- 打包：`npm run link:nikkisync:check` → 清 `release/win-unpacked*` 残留 → `npm run dist:win` → 复跑 `npm run e2e:smoke`（S4 断言打包产物版本）。

## 3. 错误处理

- 任一验证步骤失败：当场定位修复并重跑该项，不带病进入下一步；输出以 `[VERIFY]` / `[PRE-COMMIT]` 前缀定位失败阶段。
- `npm install` 已知副作用（定版配方红线）：npm 11 剥离 `package-lock.json` 的 libc 字段、清掉 `node_modules/@nikkisync` 四条 junction。恢复：`git checkout -- package-lock.json`（如有改动）+ `npm run link:nikkisync` + `npm run link:nikkisync:check`（four links in place）。
- TDD 红灯预期失败属正常信号：`check-changelog-release.ts` 在改完 package.json、未补 CHANGELOG 节时必红（exit 1「不存在 [x.y.z] 版本节」），补节后转绿；新增行为测试在修复前必须红。
- 打包残留：`release/win-unpacked*` 过期残壳先删再打（EBUSY 时确认无运行实例）。

## 4. 参数校验

- F1/F2 为渲染层内部状态机修复，无新增入参；不触碰 IPC 契约。
- F3 为主进程纯键表内部逻辑，不新增入参；单条登记仍只收非空字符串（既有 `usablePath` 校验不变），上限 60 条防无界增长。
- F4 复用既有 zod schema 与 `notifyLibraryChanged(event)`，不新增通道、不改通道名与签名（契约稳定性）。
- 版本声明位均为整串字面量替换：`package.json:3`、`package-lock.json` 第 3/9 行（恰两处）、`src/renderer/preview/mock/database-mock.ts:664`、CHANGELOG 节、文档「当前版本」句。

## 5. 基础测试用例（三场景）

每项修复先写红灯用例，修复后转绿；全部落入既有测试文件，复用既有装置。

### F1（SlideshowPlayer.jitter.test.tsx）

- 正常：打开放映自动开始（既有用例保持绿）。
- 异常：空格暂停 → 打开设置改播放间隔 → 仍保持暂停（修复前红）。
- 边界：播放中改间隔 → 计时器以新间隔重启（既有 useSlideshow 语义，不回归）。

### F2（SlideshowPlayer.jitter.test.tsx）

- 正常：放映落在视频 → 自动停表，视频播完 → 翻页并恢复播放（既有用例保持绿）。
- 异常：视频等待置位 → 手动导航离视频 → 播放 → 暂停 → 再遇视频播完 → 保持暂停不复活（修复前红）。
- 边界：末尾视频（loop=false）播完 → 停播不崩溃（既有用例保持绿）。

### F3（resource-allowlist.test.ts）

- 正常：同 revision 分页整表登记为追加、换 revision 整表替换（既有用例保持绿）。
- 异常：单条登记后以**不同 revision** 整表登记 → 单条路径仍放行（修复前红）。
- 边界：`clearNikkiSyncResourcePaths()` 后单条与整表条目一律拒绝；previewPaths 超上限按插入序淘汰。

### F4（nikkisync-handler.test.ts）

- 正常：`add-extra-directory` / `remove-extra-directory` 成功路径 → 渲染层收到 `nikkisync:library-changed` 推送（修复前红）。
- 异常：handler 失败路径不推送（既有用例保持绿）。
- 边界：`rescan` 不推（来源指纹只依赖目录清单，既有语义不变）。

## 6. 子任务分解

### 子任务 A：落盘本计划文档

- 涉及文件：`docs/plans/2026-11-01-review-fix-verify-2.5.6-release-实施计划.md`（本文件）。
- 输入/输出：审查结论 → 可执行计划入库。
- 验收标准：文件存在且随提交 1 入库。

### 子任务 B：F1+F2 全屏播放状态机修复

- 涉及文件：`src/renderer/components/gallery/SlideshowPlayer.tsx`、`src/renderer/components/gallery/SlideshowPlayer.jitter.test.tsx`。
- 输入/输出：`autoStartedRef` 打开门卫（仅 `slideshowOpen` false→true 沿 start 一次）；`togglePlay` 起点清 `videoEndedRef`。状态变更：暂停态改间隔不复播；过期等待标记不再跨会话复活。
- 验收标准：新增用例红→绿；既有 jitter/topbar/transition 测试全绿；`npm run verify` 绿。

### 子任务 C：F3 预览授权跨 revision 存活

- 涉及文件：`src/main/nikkisync/resource-allowlist.ts`、`src/main/nikkisync/resource-allowlist.test.ts`。
- 输入/输出：新增 `previewPaths` 小集合（上限 60）；单条登记双写；换 revision `clear()` 后回填；teardown 全清；模块注释改写为新不变量。
- 验收标准：新增用例红→绿；既有 allowlist 用例全绿。

### 子任务 D：F4+F5 目录变更推送与授权注释

- 涉及文件：`src/main/ipc/handlers/nikkisync-handler.ts`、`src/main/ipc/handlers/nikkisync-handler.test.ts`、`docs/IPC_CONTRACT.md`。
- 输入/输出：add/remove-extra-directory 成功路径补 `notifyLibraryChanged(event)`；IPC_CONTRACT.md 推送源汇总行补列新源；文件头 `@core-change:` 替换为本轮真实原因并补历史括注。
- 验收标准：新增推送用例红→绿；`nikkisync:library-changed` 通道名与载荷不变。

### 子任务 E：验证链与提交

- 涉及文件：无代码改动（运行验证与 git 操作）。
- 输入/输出：六项命令逐项 exit 0 并汇报；随后 3 笔提交（docs(plans) / fix(gallery) / fix(nikkisync)）。
- 验收标准：六项全绿；commitlint 通过；提交后 `git status --porcelain` 无未预期改动。

### 子任务 F：2.5.6 定版

- 涉及文件：`package.json`、`package-lock.json`（第 3/9 行）、`src/renderer/preview/mock/database-mock.ts`、`CHANGELOG.md`、`README.md`、`AGENTS.md`、`ARCHITECTURE(.en).md`、`DEVELOPMENT(.en).md`、`docs/manual-smoke-checklist.md`（核对后定）。
- 输入/输出：版本声明位 2.5.6-beta → 2.5.6；CHANGELOG 新增唯一 `[2.5.6] - 2026-11-01` 节 + 锚点前移；`release/latest.yml` 打包自动生成不手改。
- 验收标准：`npx tsx scripts/check-changelog-release.ts` 先红后绿；CHANGELOG 与被引用计划文档同批 `git add`（md-links 闸门）；`release: 2.5.6 定版` 提交通过 commitlint。

### 子任务 G：重新打包

- 涉及文件：无源码改动（构建产物）。
- 输入/输出：`npm run dist:win` → `release/MeowStarMap-Setup-2.5.6.exe`。
- 验收标准：pre-dist-check 27 项全过、verify:dist 通过、打包后冒烟 S4 断言 `app.getVersion() === '2.5.6'`。

## 7. 执行读数回写

（执行过程中回写：各红灯读数、六项验证结果、提交哈希、打包产物校验值。）
