# 全面审查 → 修复 M1/M2/M3 → 提交 → 版本 2.5.6-beta 零编辑 → 重新打包（2026-10-30）

> 仓库根：`D:\Workbuddy 项目\WXNN YD - 副本\WXNN XiangCe`（下文路径均相对此根，除非绝对路径）。
> 计划文件路径：`C:\Users\45001\.workbuddy\plans\electric-cascade-lovelace-ArIcd45n.md`。
> 执行前须先落一份入仓副本到 `docs/plans/2026-10-30-review-repack-2.5.6-beta.md`（见步骤 0）。

## 0. 已确认的决策与前置事实（本机只读取证，不臆造）

| 项         | 决策 / 事实                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前分支   | `main`，HEAD=`32543c4`，领先 `origin/main` **15 个未推送提交**（`c45e3f4..HEAD`），暂存区空                                                                                                                                                 |
| 未提交改动 | 仅 3 个文件，是一个已完成且接线正确的修复单元：`src/renderer/styles/globals.css`（未暂存 +19 行）、`src/renderer/styles/app-drag-region.test.ts`（未跟踪 86 行/9 用例）、`docs/plans/2026-10-29-fix-window-drag-region.md`（未跟踪 401 行） |
| 版本处置   | 用户确认**零编辑**：`package.json:3`、`package-lock.json:3,9`、`src/renderer/preview/mock/database-mock.ts:664`、`release/latest.yml` 四处当前**已全是 `2.5.6-beta`**；本步只以当前源码重打包                                               |
| 审查范围   | 用户确认：15 提交**逐条重审** + 未提交改动                                                                                                                                                                                                  |
| 审查结论   | **无当前可复现的 HIGH 真 Bug**。15 提交里的 WeakMap 裁剪修复（`1353cd0`）经 node 内存复现 + 上游真实产物/git 历史独立验证正确；未提交的窗口拖拽修复经 `TitleBar.tsx:9` 实测确含 `app-drag` 类、修复方向正确                                 |
| 发现的问题 | M1/M2/M3（MEDIUM，用户裁决**全修**）、L1/L2（LOW，**仅登记技术债**）                                                                                                                                                                        |
| 提交范围   | 用户确认：**仅本地 `git commit`，不 push**；15 个未推送提交保持原样不动                                                                                                                                                                     |
| 验收红线   | 用户确认：基线对比法（`git stash -u` 回基线证明既有失败与本次改动无关）+ 打包遇 EPERM 清理残壳重试                                                                                                                                          |
| 打包验证   | 用户确认：完整 `npm run dist:win` + 产物版本核对；GUI Playwright 冒烟列 **not-run** 并如实声明                                                                                                                                              |

**已知环境障碍（如实纳入，两处非本次改动引入）：**

- 全量 `npm test` 基线即 `1 failed | 452 passed`，唯一失败 `src/main/nikkisync/probe.test.ts` 断言宿主 Node ≥24（本机 v22.22.2）。
- `sync-server.linked.test.ts` 曾出现一次 60s 超时（真起 TLS 的时序敏感用例），单独重跑可通过，判 flaky。
- 本机 `dist:win` 曾因实时防护占用 `release/win-unpacked.tmp` / `release-sync/` 残壳报 EPERM。

## 1. 依赖声明

- **新增 npm 依赖：无**；**变更依赖版本：无**。不修改 `package.json` 依赖段、不执行 `npm install/update/ci/audit fix`（后者会按锁文件收敛 `node_modules`，剪掉 `npm run link:nikkisync` 建的 4 条 junction）。
- 复用既有（均已在 `devDependencies`）：`vitest@^5`（`npm test` = `vitest run`）、`tsx`（`pre-dist-check`/闸门脚本）、`@electron/asar`（产物核对，electron-builder 传递依赖）、`eslint`/`prettier`/`typescript`。
- 复用既有纯函数/常量，不新造：`scripts/verify-nikkisync-link.ts` 已导出的 `SYNC_SERVER_REQUIRED_ARTIFACTS`、`METADATA_REQUIRED_ARTIFACTS`、`missingPackedCapabilityArtifacts`（`scripts/pre-dist-check.ts:608`）。
- 前置链路自检：开工与收尾各跑一次 `npm run link:nikkisync:check`，须 4 条 `ok` + `check OK`、exit 0。

## 2. 启动与运行说明

- 环境：Windows x64，Node v22.22.2（< 24 是既有失败项根因，**不升 Node、不放宽断言**），npm 脚本原样可用。
- 所有命令 cwd = 仓库根；含空格/中文路径一律加双引号；git 统一 `git -C "D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe" ...`。
- **不启动 dev server / 不跑 GUI**（headless 环境）；验证以 CLI + 单测 + 静态检查 + 产物字节核对为主。
- 关键命令（均抄自 `package.json scripts`，非臆造）：
  - 单文件测试 `npx vitest run "<文件路径>"`；全量 `npm test`
  - 类型 `npm run typecheck`；Lint `npm run lint`
  - 打包预检 `npm run pre-dist-check`；打包后校验 `npm run verify:dist`
  - 完整打包 `npm run dist:win`（`build:recycle-helper && build && pre-dist-check && electron-builder --win --publish never && verify:dist`）
  - 安全 `npm run audit`；聚合只读 `npm run verify` / `npm run verify:staged`
  - 闸门 `npx tsx scripts/core-path-gate.ts --staged`

## 3. 分步实施（TDD 红→绿，每步本地实跑验证后才进下一步）

### 步骤 0 · 落计划 + 基线取证（前置，不改业务代码）

- **涉及文件**：新增 `docs/plans/2026-10-30-review-repack-2.5.6-beta.md`（本计划入仓副本）。
- **输入/输出**：输出该 md；随后记录基线。
- **操作**：
  1. `git status --porcelain` 确认改动面 = 上述 3 个未提交文件 + 被 `.gitignore` 忽略的残壳/日志。
  2. 基线全量：`npm test` → 记录 `1 failed | 452 passed`，失败项为 `probe.test.ts`（`expected 22 to be >= 24`）。**这是"既有失败"的锚点，不是本次新增**。
  3. `npm run link:nikkisync:check` → 4 条 ok。
- **验收标准**：基线读数留痕；链接自检 exit 0。

### 步骤 1 · M1 红→绿：移除 `stripAssetPathFields` 深度上限 fail-open

- **涉及文件**：
  - `src/main/nikkisync/runtime-manager.ts`（业务，非受保护路径，无需 `@core-change`）
  - `src/main/nikkisync/runtime-manager.test.ts`（红灯测试）
- **问题**：`:808 MAX_STRIP_DEPTH=8` + `:827 if (depth >= MAX_STRIP_DEPTH) return copy`。深度≥9 的子对象两键 `sourcePath/sourceFolder` 残留，破坏函数自述"按形状递归、宁少不漏"。当前真实 payload 最深第 5 层故不触发，属未来隐患。WeakMap 已"副本先登记后下钻"解决环与共享，深度上限不再必要。
- **输入/输出**：输入 = `listAssets()` 返回的深嵌套页（≥9 层，最深层带两键）；输出 = 返回值 JSON **不含** `sourcePath`/`sourceFolder`，其余键与 `libraryRevision` 原样保留（证明是裁剪副本而非空对象）。
- **红灯（先写测试，确认失败）**：在 `runtime-manager.test.ts` strip describe 末尾（第 903 行 `})` 前，第 858 用例之后）插入一条用例：`assetPage = { items: [deep], libraryRevision: 1 }`，`deep` 由 `{sourcePath,sourceFolder}` 外层包 10 个 `{nested: ...}`（含两键对象落在 depth12）；调 `manager.listAssets({limit:10})`，断言 `JSON.stringify(page)` 不含两键 + `libraryRevision===1`。跑 `npx vitest run "src/main/nikkisync/runtime-manager.test.ts"` → **必须 1 failed**（失败指向新增用例的 `not.toContain('sourcePath')`），既存 7 例保持绿。若修复前就绿 = 测试无效，必须重写。
- **绿灯（最小 diff）**：删 `depth` 参数（签名变 `(value, memo = new WeakMap())`）、删 `MAX_STRIP_DEPTH` 常量及其上"深度上限"注释、删第 827 行提前 return、两处递归实参 `stripAssetPathFields(item, depth+1, memo)`→`(item, memo)`、`(child, depth+1, memo)`→`(child, memo)`；第 871/882/884 行单参调用不动。移除后 depth/常量/提前 return 全部成为死代码，故一并删除才是真正最小无残留。`memo` 防环 ⇒ 不引入栈风险（真实载荷有界，JS 同步栈可承受 10⁴ 量级）。
- **重跑确认**：同单文件命令 → **全绿**（strip describe 8 passed）；再 `npx vitest run "src/main/nikkisync"` 域级 → **0 failed / 0 skipped**，域总数较基线 +1。
- **验收标准**：红灯态真实失败留痕 → 绿灯态单文件与域级均 0 failed。

### 步骤 2 · M3 红→绿：打包态产物检查复用两组清单

- **涉及文件**：
  - `scripts/pre-dist-check.ts`（非受保护）
  - `scripts/__tests__/pre-dist-check.test.ts`（红灯测试）
- **问题**：`:738-751` 硬编码 `syncArtifacts` 只查 `LocalSyncServer.js`/`GalleryRuntime.mjs`，**缺** METADATA 深入口检查；开发态 `verify-nikkisync-link.ts:440-452` 查 4 组 → 覆盖面漂移（判定核 `missingPackedCapabilityArtifacts` 复用正确，非两套真相源）。
- **输入/输出**：输入 = 真实 `pre-dist-check.ts` 源码文本 + 虚拟化解包树探针；输出 = 接线契约断言结果 + 缺件点名清单。
- **红灯（先写测试，确认失败）**：在 `pre-dist-check.test.ts` 第 18 行 import 补 `SYNC_SERVER_REQUIRED_ARTIFACTS, METADATA_REQUIRED_ARTIFACTS`；文件末尾追加 3 条用例：① 源码须含 `missingPackedCapabilityArtifacts(\s*SYNC_SERVER_REQUIRED_ARTIFACTS`；② 须含 `...METADATA_REQUIRED_ARTIFACTS` 且从 `'./verify-nikkisync-link'` import；③ 虚拟树缺 `GalleryRuntime.mjs`/`Nuan5CompatibleResolver.js` 时两组各自点名。跑 `npx vitest run "scripts/__tests__/pre-dist-check.test.ts"` → **必须 2 failed**（接线契约 ①②，当前源码无 `metadata` 字样）+ 1 passed（行为用例③恒绿）。若修复前全绿 = 测试无效，必须重写。
- **绿灯（最小 diff）**：`pre-dist-check.ts` 第 14 行 import 补两常量；把 `const pcCompanionRoot`（原 :756）上移到 :735 注释处，删原 :756 声明避免重复；把 :735-751 硬编码块整体替换为对 `SYNC_SERVER_REQUIRED_ARTIFACTS`、`METADATA_REQUIRED_ARTIFACTS` 各一次 `missingPackedCapabilityArtifacts` 打包态断言（风格对齐现有 capability/chain 块，文案区分"同步服务器/元数据解析"）；capability 块（原 753-773）与 chain 块（775-794）不动。无新 export、无新依赖。
- **重跑确认**：同单文件命令 → **全绿**；`npx vitest run "scripts/__tests__/verify-nikkisync-link.test.ts"` 绿；`npm run pre-dist-check` exit 0 且新增"同步服务器产物 2 项已全部解包""元数据解析深入口产物 2 项已全部解包"回显。
- **验收标准**：红灯态真实失败留痕 → 绿灯态三处命令均 exit 0 / 0 failed。

### 步骤 3 · M2：订正失真/过度断言注释（纯注释，零行为）

- **涉及文件**：
  - `src/main/ipc/handlers/nikkisync-handler.ts`（**受保护路径**）
  - `src/main/nikkisync/runtime-facade.ts`（非受保护）
- **问题**：`nikkisync-handler.ts:32` 仍写"`fullResyncRequired` 判据照抄上游 `LocalSyncServer.listChanges`（`after < minimum - 1`）"，但上游 b397e0e 已加 `after < accounts.revision()` 一支，本仓刻意不跟随（本仓 `:434` 单参构造 `SyncReadRepository` ⇒ 作用域恒 `1=1`，无 `accounts.revision()` 来源）。`runtime-facade.ts:550` 把后果写成"必然卡增量游标"，经代码路径追踪当前不可复现（手机 LAN 客户端走上游自带完整判据；渲染层 `GalleryPage.tsx:275-278` 被"changes 非空"兜住），属过度断言。
- **输入/输出**：纯注释文本变更，运行时行为零变更。
- **改动**：
  1. handler.ts:31-32 改为"判据沿用上游 `after < minimum - 1` 一支；上游 b397e0e 另增 `after < accounts.revision()` 一支，本仓刻意不跟随（作用域恒 1=1）"。
  2. facade.ts:550 改为"接入账号作用域时须同步补上这一支；当前架构下手机 LAN 走上游完整判据、渲染层有『changes 非空』兜底，不跟随不会让客户端停在增量游标上"。
  3. **handler.ts 顶部第 1-5 行现有 `@core-change`（旧原因"订正 get-pairing-code 括号笔误"）整块替换**为本次真实原因的新注释（至多一条、前 5 行内、中文、非批量占位文案），旧历史罗列删除、旧原因不复用。
- **闸门硬约束（已读 `scripts/core-path-gate.ts:154-204` 实测，非推测）**：第 32 行是**普通注释行**，其增删被 `analyzeProtectedDiff` 计 `substantive=true`，`evaluateGate` 要求同批 `addedAuthReasons.length>0` 否则报 `missing-auth` exit 1。故**必须随批替换 `@core-change`，否则提交被拦**。
- **验收标准**：暂存后 `npx tsx scripts/core-path-gate.ts --staged` exit 0；`npx vitest run "src/main/nikkisync/runtime-facade.test.ts"` 绿；`npx eslint "src/main/ipc/handlers/nikkisync-handler.ts"` 0 error。

### 步骤 4 · L1/L2 技术债登记（仅登记，不改代码）

- **涉及文件**：`docs/debt-registry.json`（+ 同步 `docs/技术债清单.md`）。
- **输入/输出**：新增 DEBT-042/043 两条；`updatedAt` 由 `2026-10-29` 改为 `2026-10-30`。
- **取证来源**：本次独立审查（非臆造）。延续现有最大编号 DEBT-041、`section` 沿用 17、`category` 用现有枚举、`status:"open"`、`priority:"low"`、`issue:false`。
  - **DEBT-042（L1）**：`src/main/nikkisync/runtime-manager.ts:824` 的 `{...value}` 浅拷贝把 Date/Map/Set/类实例展开成 `{}` 静默丢数据。当前上游 DTO 各键经 `String()`/`Number()` 包裹、metadata 经 JSON.parse，不产生这类值（注释已自陈"是依赖不是新风险"）。修法/撤销条件：上游若引入非纯对象，改为 `Object.prototype.toString.call(value)` 判定后原样透传 + `warn` 日志。
  - **DEBT-043（L2）**：同 `:824/:828` 浅拷贝触发 getter 求值（副作用，实测 getterCalls=1）、`Object.keys` 不遍历 Symbol 键导致 Symbol 值里的路径残留。当前上游 DTO 无 getter/Symbol、结构化克隆不支持 Symbol，不触发。修法/撤销条件：需要严防时用 `Reflect.ownKeys` + 属性描述符判断。
- **验收标准**：`node -e "JSON.parse(require('fs').readFileSync('docs/debt-registry.json','utf8'))"` 解析成功；`DEBT-042/043` 存在且字段齐全；`check-debt-fix.ts` 若介入相关文件不误报（跑 `npm run verify` 覆盖）。

### 步骤 5 · 全局回归（一票否决）

严格按序，每步达标才进下一步；任一新增失败即停下修复，不跳过、不弱化。

1. `npm run typecheck` → exit 0，无 TS 错误（`tsc -b` emit 落 `.cache/tsmain`，由 `src/main/tsconfig.json` 隔离，不回写 `dist/main`）。
2. `npm run lint` → exit 0，0 error / 0 warning。
3. `npm test` 全量 + **基线对比法**：
   - 3a `git stash -u`（把全部未提交改动 stash，回 HEAD 基线）→ `npm test` → 记录 `1 failed | 452 passed`，失败项 `probe.test.ts`。
   - 3b `git stash pop` 恢复。
   - 3c 改动后 `npm test` → **无新增失败**；唯一失败项与 3a 逐字相同；passed 增量 == 新增用例数 **4**（M1 +1、M3 +3、M2 +0）。
   - `sync-server.linked.test.ts` 若 60s 超时，单独 `npx vitest run "<该文件绝对路径>"` 重跑通过判 flaky，留痕。
4. `npm run audit` → exit 0（`audit-ci.jsonc` 既有豁免项在 allowlist）。
5. `npm run verify` 与 `npm run verify:staged` → `[VERIFY]` 无 `✗`；核心路径授权闸门对 M2 handler.ts 判定通过。
6. `npm run pre-dist-check` → exit 0（含 M3 新增两组断言 + 文档/CHANGELOG 版本校验）。

- **验收标准**：以上每步 exit 0 或符合基线判据；`npm test` 无新增失败项。

### 步骤 6 · 提交（仅本地 commit，不 push）

- **暂存纪律**：逐个 `git add <具体文件路径>`，**禁止 `git add -A`/`git add .`**（避免 `release-sync/` 等残壳混入，上一轮教训）；每 commit 后 `git status --porcelain` 复核钩子未意外改写。
- **提交闸门**：`.husky/pre-commit` = lint-staged（`src/**` 跑 `test:precommit`；`scripts/**` 只 `prettier`）→ `core-path-gate --staged` → `tsc -b`；`.husky/commit-msg` = commitlint（Conventional Commits）。**红测试留痕期不进暂存区**（`git add` 前始终保持工作区），M1 红测试+修复合并为一次提交。
- **分组（5 个 commit，均本地）**：

| #   | 文件                                                                                                                                | commit message                                                      | 闸门要点                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | `src/renderer/styles/globals.css`、`src/renderer/styles/app-drag-region.test.ts`、`docs/plans/2026-10-29-fix-window-drag-region.md` | `fix(renderer): 修复无边框窗口拖拽热区并钉住 CSS 契约`              | 含 `src/**/*.ts` → 跑 `test:precommit`（已绿）        |
| 2   | `src/main/nikkisync/runtime-manager.ts`、`.test.ts`                                                                                 | `fix(nikkisync): 移除路径裁剪深度上限，杜绝深层嵌套漏键`            | 红+绿合并一次提交；提交时为绿版                       |
| 3   | `src/main/ipc/handlers/nikkisync-handler.ts`、`src/main/nikkisync/runtime-facade.ts`                                                | `docs(ipc): 订正 listChanges/fullResyncRequired 判据的本仓豁免表述` | handler.ts 受保护，随批替换 `@core-change` 过闸门     |
| 4   | `scripts/pre-dist-check.ts`、`scripts/__tests__/pre-dist-check.test.ts`                                                             | `fix(gate): 打包态产物检查复用同步服务器/元数据两组清单`            | `scripts/**` 只 prettier；`npm run verify` 跑相关单测 |
| 5   | `docs/debt-registry.json`、`docs/技术债清单.md`                                                                                     | `docs(debt): 登记路径裁剪健壮性技术债 DEBT-042/043`                 | json 走根键 prettier                                  |

- **验收标准**：5 个 commit 全部成功、commitlint 通过；`git log --oneline -5` 可见；`git status --porcelain` 仅剩被忽略的残壳/日志；**全程不 `git push`**，15 个未推送提交保持原样。

### 步骤 7 · 版本零编辑核对 + 完整打包 + 产物核对

- **7.1 打包前核对四处源码版本**：`node -e` 读 `package.json.version` + `package-lock.json` 根与 `packages[""].version`；`grep` `database-mock.ts`、`release/latest.yml`。判据：四处全 `2.5.6-beta`，lock 两处同值。**零编辑，不改任何版本文件**。
- **7.2 完整打包**：`npm run dist:win` → 判据日志末 `EXIT=0`；内含三道 `pre-dist-check` 闸门 + NSIS + `verify:dist`。
  - **EPERM 兜底**：若死于 `EPERM rename(release/win-unpacked.tmp → release/win-unpacked)`，先确认无占用进程 → 清 `release/win-unpacked.tmp/`、`release-sync/` 残壳 → 重跑。
  - **仍失败→旁路**：`npx electron-builder --win --publish never --config.directories.output=release/build-20261030-...`（输出必须留在 `release/` 下，否则 `findAsarUnpacked` fail-closed），再 `cp -rf` 重建回标准名 `release/win-unpacked/`，**必须**用显式 `--asar=<实际路径>` 跑 `verify:dist`（默认硬编码路径会审到旧树假绿）。
  - **旁路也失败**：如实声明 `dist:win` 与产物核对 **not-run**，不得写"已打包"；交付物仅到"源码修复+提交+单测/静态门全绿"。
- **7.3 产物版本核对**：`@electron/asar` 读 `release/win-unpacked/resources/app.asar` 内 `package.json.version`；读 `release/latest.yml` 的 `version:`。判据：两者 === `2.5.6-beta`，与源码一致。`npm run verify:dist` 逐项 ✔（含 M3 新增两条"已全部解包"）。
- **7.4 not-run 如实声明**：① GUI Playwright 冒烟（`e2e:smoke`/`dist:win:smoke`）headless 环境无法目视确认，列 not-run，功能判据由 M1 单测红绿 + 包内字节取数承担；② 基线 `probe.test.ts` 的 1 failed 用 3a/3b stash 对比法证明"既有、与本次无关"，不得记为新增、不得 skip；③ flaky 超时单独重跑留痕。
- **验收标准**：源码四处 + 产物两处版本均 `2.5.6-beta`；`dist:win` 链路 exit 0（或按兜底如实降级）；`verify:dist` 全 ✔。

## 4. 错误处理（异常分支 / 兜底 / 日志规范）

- **M1**：`typeof value !== 'object' || value === null` 提前返回（Guard Clause）；`memo` 先登记后下钻处理环与共享；移除深度上限后无显式上限，真实载荷有界 + 环由 memo 收敛 ⇒ 不引入栈风险。对非纯对象当前按空对象透出（L1 已挂账），不静默吞错、不改判据语义。
- **M2**：纯注释，零异常分支。闸门若报 `missing-auth` → 说明 `@core-change` 未随批替换，回到步骤 3.3 补齐再提交，不改闸门配置。
- **M3**：`missingPackedCapabilityArtifacts` 对空清单返回 `[]`（不误报）；缺件逐项 `fail()` 点名并给"上游跑完整 `npm run build` 后重打包"的修复指引；复用同一判定核，不新增第二套真相源。
- **测试 flaky / 基线失败**：严格用 `git stash -u` 基线对比法区分"既有失败"与"本次新增失败"，禁止 skip、禁止注释测试、禁止弱化断言、禁止伪造通过。
- **打包 EPERM**：清理残壳重试 → 旁路出包（显式 `--asar=`）→ 仍失败则 not-run 如实声明，逐级降级，不谎报成功。
- **链接被剪**：不执行任何 npm 安装/收敛命令；开工/收尾 `link:nikkisync:check` 自证 4 条 junction 在位。
- **日志规范**：沿用仓库既有 `pass()`/`fail()`/`[VERIFY]`/`[clean]` 前缀；新增断言文案用中文、点名文件与修复动作；不改变既有日志级别约定。

## 5. 参数校验（入参 / 边界 / 非法值）

- **M1 `stripAssetPathFields`**：`unknown` 入参；`typeof !== 'object' || null` 提前返回；数组先登记空数组再按序 push（保序、保稀疏长度）；对象浅拷后 `delete` 两键再递归子键；`memo.get !== undefined` 命中判定（登记表只写对象/数组副本、永不写 `undefined`，前提恒成立）。新增红灯覆盖边界：深度 12（> 旧上限 8）的深嵌套对象必被裁；`libraryRevision` 保留证明是副本；`Date/Map/Set`（L1）、`getter`/`Symbol`（L2）经复现确认当前不触发并挂账。
- **M3 清单断言**：常量为 `readonly string[]`；探针 `(relative)=>boolean` 虚拟化解包树；空清单返回 `[]` 不误报；缺件精确点名到相对路径；接线契约用例用正则锚定真实源码（防恒绿）。
- **版本校验**：`package.json`/`package-lock.json` 用 `JSON.parse` 读字段（类型错误会抛，不静默）；`latest.yml` 用 `match(/version:\s*(\S+)/)`；产物用 `@electron/asar.extractFile` 取包内 `package.json` 再 `JSON.parse`。任一步解析失败即报错，不回落默认。
- **提交闸门**：`@core-change` 至多一条、前 5 行内、原因非空、非批量占位文案（`local/core-path-guard` 校验）；handler.ts 普通注释增删计 `substantive`，必须同批带授权。

## 6. 基础测试用例（正常 / 异常 / 边界 三类，均为新增红灯测试）

| 场景                | 用例                                                                                          | 修复前                              | 修复后      |
| ------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------- | ----------- |
| M1 异常（触发隐患） | deep 嵌套 ≥9 层、最深层带两键 → `listAssets` 返回不含两键                                     | **红**（旧上限 8 提前 return 残留） | 绿          |
| M1 正常             | `libraryRevision===1` 保留 + 既存 7 例（listAssets/searchSuits/searchClothing/共享身份/环形） | 绿                                  | 绿          |
| M1 边界             | 深度恰好 8/9 的分界；环/共享/空数组/null/基本类型                                             | 绿（既存）                          | 绿          |
| M3 异常（接线缺失） | 源码须含两组常量的打包态断言 + 从 verify 模块 import                                          | **红**（当前无 `metadata` 字样）    | 绿          |
| M3 正常             | 虚拟树全存在 → 两组各空清单；`npm run pre-dist-check` 新增两条回显                            | 绿（行为用例恒绿）                  | 绿          |
| M3 边界             | 虚拟树缺 `GalleryRuntime.mjs`/`Nuan5CompatibleResolver.js` → 各自点名 1 项；空清单不误报      | 绿                                  | 绿          |
| M2                  | 无新增测试（纯注释）；回归 `runtime-facade.test.ts` + `core-path-gate --staged`               | —                                   | 绿 / exit 0 |

**测试有效性硬性要求**：M1、M3 的新增回归测试在修复代码前**必须处于失败状态**（红灯态留痕）；若修复前即通过，说明未覆盖该问题，必须重写直至准确暴露，再修复。窗口拖拽单元（步骤 6 commit 1）的既有 9 用例已绿且经实测接线正确，作为既有回归纳入全量。

## 7. 关键文件清单（改动/新增）

| 文件（相对根）                                                                                                    | 动作                         | 受保护 |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------ |
| `docs/plans/2026-10-30-review-repack-2.5.6-beta.md`                                                               | 新增（本计划入仓副本）       | 否     |
| `src/main/nikkisync/runtime-manager.ts` / `.test.ts`                                                              | 改（M1 实现 + 红灯测试）     | 否     |
| `scripts/pre-dist-check.ts` / `scripts/__tests__/pre-dist-check.test.ts`                                          | 改（M3 实现 + 红灯测试）     | 否     |
| `src/main/ipc/handlers/nikkisync-handler.ts`                                                                      | 改注释 + 替换 `@core-change` | **是** |
| `src/main/nikkisync/runtime-facade.ts`                                                                            | 改注释                       | 否     |
| `docs/debt-registry.json` / `docs/技术债清单.md`                                                                  | 改（DEBT-042/043）           | 否     |
| `src/renderer/styles/globals.css` / `app-drag-region.test.ts` / `docs/plans/2026-10-29-fix-window-drag-region.md` | 既存未提交，随 commit 1 入库 | 否     |
| `package.json` / `package-lock.json` / `database-mock.ts` / `release/latest.yml`                                  | **零编辑**（已 2.5.6-beta）  | —      |

## 8. 一票否决

未通过全部回归测试（`npm test` 无新增失败）、`typecheck`、`lint`、`audit`、`verify`、`pre-dist-check` 及打包链路（或按 G 如实降级并声明 not-run）前，任务**不得标记为完成**。禁止跳过测试、禁止注释/删除测试、禁止伪造或弱化失败结果、禁止臆造不存在的命令/文件/脚本。
