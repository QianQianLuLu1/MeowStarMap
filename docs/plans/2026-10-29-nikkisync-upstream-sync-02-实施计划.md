# NikkiSync 上游同步 · 02 实施计划（阶段二：实施计划，经批准后落盘，待逐条裁决执行）

> 生成日期：2026-10-29 · 本仓 `main` @ `c45e3f4`（`meow-star-map 2.5.6-beta`）
> 上游锚点：**双锚点**（裁决 Q5）SHA `b397e0eb6ca1b4748f13a72f13bb1702a549410e` **且** tag `v1.0.27-public-beta.1`（同值）；基线 `b4221933be9714fde0c260b1f19bdaa6d1337fd3` = tag `v1.0.23-public-beta.1`
> 真相源：[01 影响评估](archive/2026-Q4/2026-10-29-nikkisync-upstream-sync-01-影响评估.md)（下称「评估」）· `.qoder/rules/project-conventions.md` · `src/main/nikkisync/AGENTS.md` · `scripts/AGENTS.md` · `docs/IPC_CONTRACT.md`
> 落盘状态：本文于 2026-10-29 落盘于 `docs/plans/`（已检索确认无重名：该目录 35 个入仓文件，本轮此前仅 `-01-影响评估.md`），命名沿用上一轮系列 `01 评估 → 02 计划 → 03/04 执行记录 → 05 结案` 风格。**阶段二到此为止：未改任何业务代码、未做任何 git 提交**；§11 待确认清单 Q-a…Q-g 逐条裁决后，才按 §4 的节点顺序进入执行阶段。

---

## 0. 本轮已裁决的四项（不再讨论，作为约束使用）

| #   | 裁决                                                                                          | 来源                                                                     |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | N1 红灯改为**从上游产物表派生期望**，不钉版本常量、不钉当下时刻                               | 评估 §10-Q1「前者（派生）」+ 本轮确认                                    |
| 2   | N2 判据漂移**仅订正文档**，不动 `runtime-facade.ts:548` 行为                                  | 评估 §10-Q2「留到 #1 接入时一起改，但现在就把 AGENTS.md 表述加时间限定」 |
| 3   | N3 新增**一张共享清单**覆盖**三个**本轮新入链产物（评估只列了一个，实测为三个，见 §0.1）      | 评估 §10-Q3 + 本轮实测订正                                               |
| 4   | N4 **纳入本轮**，在 `runtime-manager.ts` 委托层裁剪 `sourcePath`/`sourceFolder`，不碰 handler | 评估 §10-Q4「先显式过滤」+ 本轮确认                                      |

### 0.1 对评估的一处事实订正（必须先记账）

评估 §4-A / §10-Q3 判定「本轮新进入依赖链的 `server/MediaFingerprint.js`」，把 `AccountSyncSettings.js` 列为「若接入的」才需要入闸门。**实测不成立**：本轮 `b422193..b397e0e` 共新增 **3 条**静态 import 边，把 **3 个全新模块**推进本仓装载链，三者都不在任何闸门清单里：

| 新入链模块                                    | 谁静态 import 它                     | 该 import 方在本仓的地位                                                                                  | 证据                                                                                                             |
| --------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `dist/src/server/MediaFingerprint.js`         | `dist/src/server/row-mappers.js:3`   | 本仓深入口 `ROW_MAPPER_DEEP_ENTRY`（`runtime-facade.ts:232`）                                             | 上游源码 diff：`+import {mediaFingerprint} from './MediaFingerprint.js'`（`row-mappers.ts`）                     |
| `dist/src/server/AccountSyncSettings.js`      | `dist/src/server/LocalSyncServer.js` | 已在 `SYNC_SERVER_REQUIRED_ARTIFACTS[0]`，且经桶导出闭包装载                                              | 上游源码 diff：`+import {AccountSyncSettings} from './AccountSyncSettings.js'`（`LocalSyncServer.ts`）           |
| `dist/src/organizer/NativeMediaOperations.js` | `dist/src/runtime.js`                | 桶导出 `dist/src/index.js:4` `export * from './runtime.js'` ⇒ 探针装载 `@nikkisync/pc-companion` 桶即触发 | 上游源码 diff：`+import {nativePreview,recycleMany} from './organizer/NativeMediaOperations.js'`（`runtime.ts`） |

闭包实测方法（只读，未碰上游工作树）：以 `dist/src/index.js` + 12 个 `*_DEEP_ENTRY` 为根递归解析相对 `import`/`export from`，得 **50 个装载链模块**，其中 34 个不被任何清单点名（33 个属既存缺口、非本轮引入；本轮新增缺口正是上表 3 个）。`VersionAssetPages.js` 与 `desktop/AccountSyncPanel.ts` **不在**闭包内 ⇒ 不入清单（评估 §6#3「不适用」判定成立）。

---

## 1. 目标与范围

**目标**：让本轮上游前进（`b422193` → `b397e0e` / `v1.0.27-public-beta.1`）达到「绿灯基线 + 闸门无盲区 + 渲染层隐私姿态不被上游打破」，并关闭评估 §10 全部待裁决项的账。

### 1.1 纳入节点

| 节点 | 事项                                                            | 评估出处                                                          | 分类         |
| ---- | --------------------------------------------------------------- | ----------------------------------------------------------------- | ------------ |
| N0   | 01 评估与 02 计划落盘入仓 + 双锚点记载                          | §2.2、§10-Q5                                                      | 收尾（前置） |
| N1   | `runtime-facade.linked.test.ts:408` 唯一红灯改为派生断言        | §5.1、§7「阶段 2（必做，唯一被迫项）」、§8-R3、§10-Q1             | 兼容性收敛   |
| N2   | 增量变更判据的「逐字同上游」表述四处订正（零行为变更）          | §4-C、§6#11、§7「阶段 2 同期」、§10-Q2                            | 兼容性收敛   |
| N3   | 装载链产物共享清单 + 阻断检查 + pre-dist 复用                   | §4-D「清单缺口」、§7「阶段 2 闸门补齐」、§8-R4、§10-Q3、本文 §0.1 | 兼容性收敛   |
| N4   | 委托层裁剪 `sourcePath`/`sourceFolder` + 契约与视图模型注释订正 | §4-A 末段、§6#9、§8-R7、§10-Q4                                    | 隐私卫生     |
| N5   | 结案回写（读数、not-run 记账、技术债登记）                      | §9、§11                                                           | 收尾         |

### 1.2 不做项（逐条附理由，避免执行时越界）

| 不做                                                                                                                             | 理由与出处                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 接入 `AccountSyncSettings` 账号作用域（评估 §6#1/#12）                                                                           | 判为「零对应面（可选接入项）」，§7 归入「阶段 4（可选能力接入）」。接入会新增设置键 + UI + 作用域语义，非本轮差异所迫                                            |
| 接入 `DeletionQueue.dismiss()`（#5）、`ExtraScanDirectories.setSource`/来源标注（#6）、`VersionRelease.tentative` 展示口径（#8） | 同上，评估 §7「阶段 4」；且 #6 的 `state().directories[].source` 只是契约新增可选键，透传无害（评估 §6#6 判「已有对应面」）                                      |
| 复刻上游新判据 `after < accounts.revision()`                                                                                     | 裁决 2；本仓不构造 `AccountSyncSettings`，无 `revision()` 取值来源（评估 §10-Q2 右列）                                                                           |
| 装载链**闭包**级闸门（把 34 个未点名产物全纳入）                                                                                 | 属新机制、非本轮差异所迫；`build.files` 的 `filter:['**/*']` + `asarUnpack:**/@nikkisync/**` 今天整树搬运，逐个点名不改变产物内容。登记为 DEBT（N5，待确认 Q-c） |
| 重打包 `npm run dist:win`                                                                                                        | 本轮 N1–N4 无产品功能新增；`verify:dist` 的新块在未建链时 `skip`（`pre-dist-check.ts:684-690`），打包面证据只能来自下一次既有发布计划。**列为待确认 Q-a**        |
| 修改上游任何文件                                                                                                                 | 铁律：上游 `git status --porcelain` 必须持续为 0 行（评估 §1 表「上游工作区」、§9 自检第 3 条）；本轮所有负向取证走**副本**，不碰 `../NikkiSync`                 |
| 顺手重构 `runtime-facade.ts:450` 引用的不存在文件 `library-paging.linked.test.ts`、`pre-dist-check.ts:905` 的「11 项」旧序号     | 非本轮差异引出（禁止夹带）。仅在 N3 内订正**因 N3 本身而失真**的 `runtime-facade.ts:217`/`:267`「第 12 项」两处                                                  |

---

## 2. 依赖声明

**本轮零新增、零变更任何依赖。**

| 项                    | 事实                                                                                                                                         | 证据                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@nikkisync/*` 四个包 | **不在** `package.json` 的 `dependencies`/`devDependencies` 内，靠 `npm run link:nikkisync` 建 junction；本轮沿用该形态，不改                | `scripts/__tests__/self-contained-deps.test.ts:65-69` 断言 `declared).toEqual([])`；`package.json` 内 `@nikkisync` 仅出现在 `build.files`(227-228) 与 `build.asarUnpack`(263) |
| 链接根解析优先级      | `NIKKISYNC_ROOT` → 同级 `../NikkiSync` → `vendor/NikkiSync`；本轮不改                                                                        | `scripts/link-nikkisync.ts:71-86`（`toRootCandidates`）、`verify-nikkisync-link.ts:428-434` 复用同函数（单一真相源）                                                          |
| 上游自身依赖          | 本轮区间根 `package.json`/`tsconfig.base.json`/`scripts/` 变更文件数 **0** ⇒ 上游不需 `npm install`，`npm run build` 一次直跑 `BUILD_EXIT=0` | 评估 §4-D、§1 附证据命令                                                                                                                                                      |
| 本仓 `engines`        | `node >=22.12.0`；本机 shell 实测 `node v26.3.0`、`npm 11.16.0`、`git 2.55.0.windows.2`、`electron 41.10.6`                                  | `package.json:24-26`；评估 §1                                                                                                                                                 |
| 上游 `engines`        | `>=24.0.0`，本机 v26.3.0 同时满足两侧                                                                                                        | 评估 §1                                                                                                                                                                       |
| **禁止**              | 本轮任何步骤**不得**执行 `npm install`/`npm update`——会剪掉四条 junction，使链接态用例集体降级为 `skip`，把 N1/N4 的证据一起抹掉             | `src/main/nikkisync/AGENTS.md` 硬性约定 6；评估 §8-R1                                                                                                                         |

**唯一「依赖形态」变化是闸门的判定面**：`verify:nikkisync` 由 12 项变 13 项（N3）。这是评估 §7 明确要求且裁决 3 批准的，不是擅自改变配置形态。

---

## 3. 启动说明

### 3.1 环境准备（顺序即前置条件）

```bash
# 1) 上游必须处于目标锚点，且工作树零改动
git -C ../NikkiSync rev-parse HEAD          # 期望 b397e0eb6ca1b4748f13a72f13bb1702a549410e
git -C ../NikkiSync tag --points-at HEAD    # 期望 v1.0.27-public-beta.1
git -C ../NikkiSync status --porcelain | wc -l   # 期望 0

# 2) 上游产物（评估 §4-D 已实测 BUILD_EXIT=0；若 dist 缺失或过期才重建）
cd ../NikkiSync && npm run build && cd -

# 3) 本仓四条链在位（绝不先跑 npm install）
npm run link:nikkisync
npm run link:nikkisync:check     # 期望 [link:nikkisync] check OK (all four links in place)
npm run verify:nikkisync         # 期望 12 行 ✓/⚠、OK (blocking failures: 0)、exit 0（N3 之后为 13 行）
```

### 3.2 三种运行态与各自受支持的行为（必须区分，否则会把「环境缺失」误记成「逻辑失败」）

| 运行态                                 | 判定                                                                        | 受支持行为                                                                                                                                    | 对本计划的意义                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **已建链开发机**（本机即此态）         | `hasNikkiSyncLink(projectRoot)` 为真（按包内 `package.json` 可解析判定）    | `*.linked.test.ts` 全部真实执行；`verify:nikkisync` 的三张产物清单为 blocking                                                                 | **N1/N4 的唯一证据来源**；验收必须在此态跑并核对 `0 skipped`                      |
| **未建链开发机 / CI（ubuntu-latest）** | `LINKED` 为假 ⇒ `suite = describe.skip`                                     | 链接态用例整件 skip（受支持）；`verify:nikkisync` 全条目降 `warn`、退出码仍 0；CI 里该步为 warn-only（`.github/workflows/build.yml:204-209`） | CI 的 `npm test` 绿**不能**证明 N1/N4；只证明 N3 的纯函数部分与本仓不依赖链的用例 |
| **打包态（win-unpacked / NSIS）**      | `verify:dist` 走 `checkUnpackedNativeBinaries`，未建链时 `skip` 后 `return` | 深入口经 `resolveDeepEntryUrl` 优先 `app.asar.unpacked`                                                                                       | N3 的新块只在此态生效且仍受建链门控 ⇒ 列为人工验证项 M2，不当作自动化证据         |

### 3.3 功能验证方式（命令全部从 `package.json` 摘录并逐条核实存在）

| 目的                               | 命令                                                                                                                                                                       | package.json 行           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 变更后只读验证闭环                 | `npm run verify` / `npm run verify:staged`                                                                                                                                 | 89 / 90                   |
| 域测试（合并口径，与评估 §5.4 同） | `npx vitest run src/main/nikkisync scripts/__tests__/link-nikkisync.test.ts scripts/__tests__/verify-nikkisync-link.test.ts scripts/__tests__/self-contained-deps.test.ts` | `test` = `vitest run`(49) |
| 闸门体检                           | `npm run verify:nikkisync`(74) / `npm run verify:dist`(73) / `npm run pre-dist-check`(41)                                                                                  |                           |
| 类型三面                           | `npm run typecheck`(48) / `npm run typecheck:e2e`(84)                                                                                                                      |                           |
| 静态与格式                         | `npm run lint`(44) / `npm run format:check`(47)                                                                                                                            |                           |
| 文档链接                           | `npm run docs:links`(70)                                                                                                                                                   |                           |
| CI 宿主语义                        | `npm run test:ci-linux`(56)                                                                                                                                                |                           |
| 覆盖率阈值门                       | `npm run test:coverage`(52)                                                                                                                                                |                           |
| i18n                               | `npm run i18n:guard`(67)                                                                                                                                                   |                           |
| 开发启动                           | `npm run dev`（electron-vite dev）                                                                                                                                         |                           |

本轮 **不新增 IPC 通道、不新增 i18n key** ⇒ `i18n:guard` 预期与本轮前逐字节同结果（三项硬校验：白名单只减不增 / 无滞后 / 11 语言包 key 与 `zh-CN.json` 对齐，见 `scripts/i18n/guard.ts:4-9`）。

---

## 4. 节点设计

依赖图：`N0 → (N1 ∥ N2 ∥ N3 ∥ N4) → N5`。N1–N4 文件互不重叠，**唯一交叠**是 `runtime-facade.ts`（N2 改 `:547`，N3 改 `:217`/`:267`）⇒ **提交边界要求 N2 先于 N3**。所有节点均**不触碰**核心路径受保护 glob（`src/main/preload/api/**`、`src/main/ipc/handlers/**`、`src/main/services/**`、`src/shared/errors/**`）⇒ **本轮无需任何 `// @core-change:` 注释**（`scripts/core-path-gate.ts:37-42` 的 `PROTECTED_GLOBS` 实测不含 `src/main/nikkisync/**` 与 `scripts/**`）。

**提交边界规范**：所有提交经 `.husky/commit-msg` + `commitlint.config.cjs` 硬校验，本文拟用的每条 message 已按实测规则核对——`type-enum` 含 `feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert/i18n/release`（本轮只用到 `test`/`fix`/`chore`/`docs`）、`scope-case: lower-case` 且 `scope-max-length: 24`、`subject-max-length: 72`、`header-max-length: 100`、`subject-full-stop: never '。'`（主标题不得以中文句号收尾）。

### N0 · 落盘两份文档 + 双锚点

- **文件**：`docs/plans/archive/2026-Q4/2026-10-29-nikkisync-upstream-sync-01-影响评估.md`（当前 `?? ` 未跟踪，追加 `§10.1 裁决结论` 块）、`docs/plans/2026-10-29-nikkisync-upstream-sync-02-实施计划.md`（本文，已落盘、待入仓）
- **输入 → 输出**：已批准的四项裁决 + §0.1 订正 → 两份入仓文档，锚点同时记 SHA 与 tag（评估 §10-Q5）
- **验收**：`git ls-files docs/plans | grep -c "2026-10-29-nikkisync-upstream-sync-0[12]"` → `2`；`npm run docs:links` 退出 0；`git status --porcelain` 只剩 `?? release-sync/`
- **提交**：`docs(plans): 落盘本轮 NikkiSync 同步的影响评估与实施计划并记双锚点`
- **注意**：`release-sync/` 未跟踪**且不在 `.gitignore`**（内含 `app.asar`）⇒ 一律**按文件名 `git add`**，禁止 `git add -A`。

### N1 · K3 日历断言改为从产物派生（唯一被迫项）

- **文件**：`src/main/nikkisync/runtime-facade.linked.test.ts`（只改 398–412 那个 `it` 内部）
- **输入**：`surface.gameVersionCalendar.getGameVersionReleases(): unknown[]`（`runtime-facade.ts:147-153` 已声明，**无需改生产代码**）；`infer(capturedAt, releases?)`
- **输出**：该 `it` 内不再有版本字面量期望，最新项期望由表算出；`:402-403` 注释加时点限定
- **派生断言的三条硬要求**（全部实读上游后定为不会腐烂的形态）：
  1. 取最新行用 **`effectiveAt` 最大值**（`reduce` 比较 `Date.parse`），不用 `[0]`；另加一条**降序不变式**断言（相邻两项 `Date.parse(a) >= Date.parse(b)`），因为 `inferInfinityNikkiGameVersion` 靠数组顺序首个命中（`GameVersionCalendar.ts:57-64`），顺序本身就是上游契约的一部分。
  2. 未来时刻用 **`newest.effectiveAt + 1000ms`**，不用 `2027-01-01`、更不用 `new Date()`。理由：`effectiveAt` 之后任意时刻必命中该行，而钉固定年份会在上游继续加版本时重新变红；钉当下时刻在今天就是炸弹——`2.11` 的 `uncertainFrom=2026-10-29T19:49Z`、`effectiveAt=2026-10-30T07:00Z`，落在此区间 `infer` **返回 `undefined`**（上游第 60 行的 uncertain 分支）。
  3. `:404-407` 的历史边界（1.4 / 边界含等号 / 1.3 / 早于 1.0）与 `:409/:411`（`undefined`、非法串）**原样保留**——评估 §5.1 判定只有「未来时刻」这一支会被发版打红。
- **注释订正**：`:402-403` 的「实测表（b422193）」改为带时间限定的表述，保留原句不删（验收口径：失效注释留原句加时间限定）。
- **红灯先行**：修复前即真红，无需制造。取证命令与期望读数：
  ```bash
  npx vitest run src/main/nikkisync 2>&1 | tail -8
  # 修复前：AssertionError: expected '2.11' to be '2.10'  @ runtime-facade.linked.test.ts:408
  #        Test Files 1 failed | 15 passed (16)；Tests 1 failed | 275 passed (276)
  ```
- **验收**：`npx vitest run src/main/nikkisync` → `Test Files 16 passed (16)`、`Tests 276 passed (276)`、**`0 skipped`**（必须核 `0 skipped`，否则「整件 skip」也会给出 0 失败的假绿）；用例总数保持 276 不变（N1 不新增 `it`）。
- **提交**：`test(nikkisync): K3 日历断言改为从上游产物表派生最新项，闭合同步红灯`
- **回滚**：`git revert` ⇒ 红灯立刻重现（可见，不静默）。无运行时与数据影响。

### N2 · 判据漂移的文档订正（零行为变更）

- **文件（四处，全部注释/文档）**：
  1. `src/main/nikkisync/runtime-facade.ts:547`
  2. `src/main/nikkisync/AGENTS.md:33`（「判据**逐字同上游** `GET /v1/changes`」）
  3. `src/main/nikkisync/runtime-types.ts:336-337`（「判据照抄上游不作改」）
  4. `docs/IPC_CONTRACT.md` §8.1.1 `nikkisync:get-changes` 行的同源表述
- **必须写进订正文本的实测事实**：本仓 `:548` 仍是 `minimum !== undefined && after < minimum - 1`；上游 `b397e0e` 为 `after<this.accounts.revision() || minimum !== undefined && after < minimum - 1`（`LocalSyncServer.ts:457`）；**基线 `b422193` 该行实际在 `:453`** ⇒ 原注释引用的 `:439` 从未对上任何一侧，属既存失真，一并订正。豁免理由：`runtime-facade.ts:434` 单参构造 `SyncReadRepository` ⇒ `allowedUids === undefined` ⇒ scope 恒 `1=1`，本仓不存在 `accounts.revision()` 取值来源；**接入账号作用域时必须同步，否则漏发 `fullResyncRequired`**。
- **红灯先行的替代（诚实记账）**：本节点按裁决**禁止行为变更**，因此不存在可写的失败用例；以**阅读性红灯**取证并把两条命令写进 commit message：
  ```bash
  grep -n "fullResyncRequired" src/main/nikkisync/runtime-facade.ts                        # :548 旧判据
  grep -n "fullResyncRequired" ../NikkiSync/apps/pc-companion/src/server/LocalSyncServer.ts # :457 新判据（含 accounts.revision 支）
  # 二者不同，而注释宣称「逐字」⇒ 自相矛盾，即为本节点要闭合的红
  ```
- **验收**：`grep -n "（:439）" src/main/nikkisync/runtime-facade.ts` → 0 命中；`grep -rn "逐字同上游\|判据照抄上游" src/main/nikkisync/AGENTS.md src/main/nikkisync/runtime-types.ts docs/IPC_CONTRACT.md` → 每条命中同行含 `b422193` 或「时点」限定；`npx vitest run src/main/nikkisync/runtime-facade.test.ts` 全绿（行为未变）；`npm run docs:links` 退出 0。
- **提交**：`docs(nikkisync): 订正增量变更判据的同源表述并锚定上游行号与作用域豁免理由`
- **回滚**：`git revert`，纯文本。

### N3 · 装载链产物共享清单（覆盖三个新入链模块）

- **文件**：
  1. `scripts/verify-nikkisync-link.ts`：在 `NIKKISYNC_CAPABILITY_ARTIFACTS`（`:75-83`）之后新增 `export const CHAIN_REQUIRED_ARTIFACTS: readonly string[]`，用**同一 `path.join('dist','src',…)` 形态**列 `server/MediaFingerprint.js`、`server/AccountSyncSettings.js`、`organizer/NativeMediaOperations.js`；新增可选事实字段 `chainArtifactsMissing?: string[]`；在 `collectNikkiSyncLinkFacts()` 的 `if (name === '@nikkisync/pc-companion')` 块（`:401-412`）加同形 `for`；在 capability 检查块（`:245-256`）**之后**加第 13 项检查，`ok`/`level`/`detail` 三态与 capability 完全同形（已链接且缺件 ⇒ blocking；未链接 ⇒ `warn` + `skipped`；齐全 ⇒ `present: …`）
  2. `scripts/pre-dist-check.ts`：`:14` 的 import 追加 `CHAIN_REQUIRED_ARTIFACTS`；在 `@nikkisync` 段末尾（`:773` 之后）**复用既有纯函数** `missingPackedCapabilityArtifacts(artifacts, exists)`（`:608-613`，签名与清单无关，天然可复用）+ 既有 `pcCompanionRoot`（`:757`）做解包树断言。**不得**另写第二个纯函数，**不得**在 pre-dist 里内联字面量清单（`pre-dist-check.ts:604-606` 已立「两侧不得各自抄录」规矩）
  3. `scripts/__tests__/verify-nikkisync-link.test.ts`：新增 `CHAIN_CHECK` 名称常量（挨着 `:30`）；按 `:148-184` 的三态范式补 4 例（已链接缺件硬阻断并点名 / 齐全放行 / 事实缺省时整条缺席 / 未链接降 `warn`）；补一个 `describe` 用**字面 `toEqual`** 钉死 3 项（对齐 `:264-276` 的既有范式）。`:264-276`（capability「恰好 7 个」）**不动**——capability 清单保持 7 项
  4. `scripts/__tests__/pre-dist-check.test.ts`：在 `:181-198` 旁补同形 3 例（全在 → `[]` / 缺 `MediaFingerprint.js` → 点名 / 空清单 → `[]`）
  5. `src/main/nikkisync/runtime-facade.ts:217` 与 `:267`：删掉「第 12 项」这个**已失效的序号**，改为按清单名指代
- **输入 → 输出**：3 条实测静态边（§0.1）→ 一张共享清单 + 一项 blocking 检查 + 开发态与打包态同一真相源
- **红灯先行（纯函数红，任何机器可复现，比 N1 的证据更强——不需建链、不需上游在场）**：先提交测试改动。修复前两种真实红：① `CHAIN_REQUIRED_ARTIFACTS` 未导出 ⇒ 测试文件 import 失败/值为 `undefined` ⇒ 字面 `toEqual` 红；② `find(checks, CHAIN_CHECK)` → `undefined` ⇒ `toContain(CHAIN_CHECK)` 红。禁止用 `it.skip`/放宽断言/降 `warn`（`.qoder/rules/project-conventions.md` §6 禁止项）。
- **验收**：
  ```bash
  npx vitest run scripts/__tests__/verify-nikkisync-link.test.ts scripts/__tests__/pre-dist-check.test.ts   # 全绿、0 skipped
  npm run verify:nikkisync          # 恰好 13 行，新增行 ✓，末行 OK (blocking failures: 0)，exit 0
  grep -c "第 12 项" src/main/nikkisync/runtime-facade.ts    # 0
  grep -n "MediaFingerprint" scripts/pre-dist-check.ts      # 只命中导入的符号名，不命中字面路径
  ```
- **序号事实校正（写进计划以免再错）**：实测 `evaluateNikkiSyncLink` 的 12 条检查顺序为 1 依赖图自包含 / 2 四条链在位 / 3 四包 dist 双存在 / 4 migrations 可读 / 5 sync server 产物 / 6 metadata 产物 / **7 capability 产物** / 8 主进程未折叠 require / 9 unpacked 含 schema / 10 候选根可发现 / 11 `node:sqlite` / 12 electron 版本。⇒ 评估 §5.3 说的「第 10 项」「第 5/6/7 项」是对的；`runtime-facade.ts` 注释里的「第 12 项」是错的。新检查插在 capability 之后 ⇒ 落位 **第 8 项**，其后三条 ordinal 全部失效，所以一律改名为清单名。
- **提交（两段，红灯取证先行）**：仓库既有范式实测为 `0bb84a4 test(守卫): 为 logger 落盘逃逸点建立封闭集台账闸门（修复前红灯取证）` 与 `127158d test(deps): 为 lock 解析版本建立防回归闸门（修复前红灯取证）`，本文沿用同形态：
  1. `test(守卫): 为装载链新增产物建立封闭清单闸门（修复前红灯取证）`
  2. `chore(gate): 新增 CHAIN_REQUIRED_ARTIFACTS 清单与阻断检查，pre-dist 复用同一真相源`
- **回滚**：两段一起 `git revert` ⇒ `verify:nikkisync` 回到 12 行。`src/**` 运行期不读该清单 ⇒ 零产品风险。
- **保护面如实记账**：今天 `build.files` 是 `from node_modules/@nikkisync` + `filter:['**/*']` + `asarUnpack:**/@nikkisync/**`，整树搬运 ⇒ 单文件漏解包在结构上不可能发生。该清单的真实价值是**钉住「上游装载链」与「本仓点名清单」不再各自漂移**（上游改名 / 将来收窄 glob / junction 被剪时的缺件会被闸门先红），文档措辞不得写成「防止漏文件」。

### N4 · 委托层裁剪 `sourcePath`/`sourceFolder`

- **文件**：
  1. `src/main/nikkisync/runtime-manager.ts`：在 `stripDeletionRows`（`:755-762`）旁新增**形状无关的递归裁剪**（不硬编码响应形状）
  2. `src/main/nikkisync/runtime-manager.test.ts`：`:622` 的 `it` 标题「原样返回查询面结果，不做字段包装」改判；`:259` 的 fake 加两键并断言不透出；补 `searchSuits`/`searchClothing` 的**嵌套**用例；补 `getResource(...,'path')` 与 `listResourceRecords(...,'path')` **仍原样返回绝对路径**的用例（护住 `:633` 的 `toBe` 语义不被过度裁剪）
  3. `src/main/nikkisync/runtime-facade.linked.test.ts`：补一条链接态真产物守卫（同一条资产 raw 与 stripped 的键集合差**恰为** `{sourcePath, sourceFolder}`），防止「上游本就不产出该键」的空转绿
  4. `src/main/nikkisync/runtime-types.ts:477-486`：句柄注释区分「委托 + 路径键裁剪」与「薄委托」两类
  5. `src/renderer/utils/assetViewModel.ts:9-11`：订正「协议侧 `AssetSummary` 只有 14 个字段，**且不含任何绝对路径**」——该前提自本轮起在**线上载荷**层面已不成立
  6. `docs/IPC_CONTRACT.md` §8.1（+ §8.1.1 搜索行）：登记裁剪的通道、键名、为何不在 handler 做，并显式写明 `get-resource` / `get-resource-records` 的 `mode:'path'` **按设计仍是绝对路径原值**（该口径 §8.1 现有文字已在，不得反向改动）
  7. `src/main/nikkisync/AGENTS.md`：`runtime-manager.ts` 行（`:36`）职责补「路径键裁剪」
- **泄漏面实测（决定要裁几处、怎么裁）**：上游只有 `mapAssetSummary`（`row-mappers.ts:120`）产出两键，且 `sourceFolder` 由 `sourcePath` 正则剥尾段得到、`...(sourcePath?{sourcePath,sourceFolder:sourceFolder??''}:{})` ⇒ **无 `sourcePath` 时两键同时缺席**（成对裁剪安全）。能到达渲染层的通道只有 3 条，全部经 `runtime-manager.ts`（**实测：`src/main` 非测试代码里 `.queries.` 的调用点只有 `:794-804` 这 9 个委托**）：

  | 委托                                          | 行              | 是否带键           | 形状                                                                                                                                |
  | --------------------------------------------- | --------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
  | `listAssets`                                  | 794             | **是（顶层）**     | `{items:[AssetSummary]}`                                                                                                            |
  | `searchSuits`                                 | 802             | **是（嵌套）**     | `items[].photos[].asset`（上游 `SuitSearchIndex.ts:163` 按引用塞入）                                                                |
  | `searchClothing`                              | 803             | **是（嵌套）**     | 同上（`ClothingSearchIndex.ts:100`）                                                                                                |
  | `getAssetDetail`                              | 795             | 否                 | `{asset: mapAssetRow(...)}`——实测 `mapAssetDetail` **不走** `mapAssetSummary`（`row-mappers.ts:116-118`），无路径键                 |
  | `getResource` / `listResourceRecords`         | 796-800         | **按设计必须保留** | `mode:'path'` 产出 `source_path` 原值并喂 `registerNikkiSyncResourcePaths`（`runtime-facade.ts:540`），是 `media://` 授权的唯一出口 |
  | `listChanges` / `profileStats` / `organizer*` | 801/804/819-821 | 否                 | `mapChangeRow` 4 个标量；`profileStats` 只回统计不吐 asset 对象；`DeletionQueue.ts:131` 的 `files` 已 `basename` 化                 |

- **两条硬设计约束（实读代码得出，违反即引入回归）**：
  1. **必须 copy-on-write，不得原地 `delete`**：`searchSource()` 有按 revision 的缓存（`runtime-facade.ts:454-459`），缓存项与 `profileStats` 共享同一批对象引用；就地删键会污染缓存并影响统计面。范式照抄 `stripDeletionRows` 的 `{...row}` 浅拷 + 递归下钻。
  2. **不碰 handler**：`nikkisync-handler.test.ts` 对 6 条通道用**身份 `toBe`** 钉死（`:635/:680/:691/:725/:728/:755/:798/:894`），handler 侧一旦出现 `{...data}` 立刻红；且 handler 属受保护 glob，改动要背 `@core-change`。委托层裁剪对这两类断言完全不可见（handler 测试 stub 的是 `runtime` 句柄），实测 `get-assets` 的 `toEqual`（`:338-350`）也比对 stub 自身载荷 ⇒ 不破。
- **默认关闭 / 失败即拒绝 / 显式同意口径**：本节点是**移除**字段而非新增能力，且被移除的键在本仓无消费点（实测 `src/renderer/**` 对 `sourcePath` 的全部命中均属 `ImportFilePreview.sourcePath` 等同名异物；`sourceFolder`/`thumbnailSha256`/`previewSha256`/`fullPreviewResourceId`/`fullPreviewSha256`/`mediaFingerprint` 全域零命中），vendored `AssetSummary`（`src/shared/sync/protocol.ts:65-82`）也**刻意不新增**这些键（裁决 4）。⇒ **不加运行时开关**：开关会造出两种载荷形态，而 CI 恒未建链、链接态用例整件 skip，「开」这一支将永久无证据；「默认拒绝敏感字段、不提供开路径」才是 fail-closed 的正确读法。此论证已写入本文，使偏离可读。
- **敏感信息禁记**：不新增任何把这些键写入日志/分享卡片/导出元数据的路径（评估 §8-R7 的裁示前禁令，本轮以「不实现」满足）；`details` 仍禁含完整路径（`docs/CODING_CONVENTIONS.md:59`）。
- **红灯先行（两段式）**：
  - 段 1（不依赖链接，CI 可复现）：`runtime-manager.test.ts` 的 fake `listAssets` 带 `sourcePath: 'D:\\game\\photos\\a.jpg'`，断言 manager 输出序列化后不含该键 ⇒ 修复前 `npx vitest run src/main/nikkisync/runtime-manager.test.ts` → `Tests 2 failed | N passed`（嵌套那条同样红）。
  - 段 2（链接态真产物）：`runtime-facade.linked.test.ts` 新守卫修复前红。**前置实测**（写进执行记录）：先跑一次确认真实扫描夹具的 `session.queries.listAssets` 首条**确实带** `sourcePath`；若夹具无 `source_primary`/`source_high_quality` 资源导致 raw 侧本就不含该键，用例必须**显式失败并提示换夹具**，不得静默通过。
- **验收**：
  ```bash
  npx vitest run src/main/nikkisync src/main/ipc/handlers/nikkisync-handler.test.ts
  # 域用例数由 276 增至 ≥280 且 0 skipped；handler 的 27 通道 toEqual(:202-234) 与全部 toBe 身份钉 0 改动通过
  npx vitest run src/renderer/utils src/renderer/stores        # 视图模型与 store 无回归
  grep -rn "sourceFolder\|thumbnailSha256\|mediaFingerprint" src/renderer src/shared/sync   # 仍零命中（消费面未扩）
  npm run typecheck                                            # 全绿（9 个委托签名已是 Promise<unknown>，无签名漂移）
  npm run docs:links ; npm run i18n:guard
  ```
- **提交（三段）**：`test(nikkisync): 建立资产绝对路径裁剪的红灯取证` → `fix(nikkisync): 委托层裁剪上游新增的 sourcePath/sourceFolder` → `docs(ipc): 登记资产响应路径裁剪与 path 模式按设计保留`
- **回滚**：只 revert `fix` 会让红重现，须 `fix` 与 `test` 同批逆序回退。渲染层无消费点 ⇒ 回滚对 UI 行为中性；无数据落库、无迁移。

### N5 · 结案回写

按 §11 待确认 Q-b 决定的形态，回写每节点「命令 + 实测读数 + 退出码」。`not-run` 显式记账：上游自身 `npm test`（评估 R11）本轮是否补取证待 Q-e；`verify:dist` 新块需建链打包态才咬（M2）。技术债登记见 Q-c。验收：`npm run docs:links` 退出 0、`npx vitest run scripts/__tests__/check-md-links.test.ts` 全绿。

---

## 5. 错误处理（逐新增/变更行为）

| 行为                      | 异常分支                                                                                                                                                                   | 兜底                                                                                                                                                  | 日志                                                                                                                   | 敏感信息                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| N1 派生取最新行           | 表为空 / 行缺 `effectiveAt` / `Date.parse` 为 `NaN`                                                                                                                        | **测试内立即失败**（不 `?? ''` 吞掉）：用 `expect(releases.length).toBeGreaterThan(0)` 前置守卫，`reduce` 内对 `NaN` 显式抛测试信息「上游表形态漂移」 | 无（测试态）                                                                                                           | 不含路径                                            |
| N3 新增检查               | 已链接但缺件 ⇒ `ok:false` 无 `level` ⇒ blocking，退出码 1；未链接 ⇒ `level:'warn'` + `skipped` 文案；事实字段缺省 ⇒ 整条检查缺席（沿用 `:245-256` 三态，**不新增第四态**） | 缺件 `detail` 必须点名文件并给修复动作（`run the full \`npm run build\` in NikkiSync`），与 capability 文案同形                                       | `console.log` 的 `✓/⚠/✖` 行 + 末行汇总（`:487-494`）                                                                   | 只打相对 `path.join` 路径，不打 `D:\` 全路径        |
| N3 `pre-dist-check` 新块  | 解包树缺件 → `fail()` 拉闸，`--verify-asar` 末段 `process.exit(1)`（`:905-917`）；未建链 → 早于新块 `return`（`:684-690`）打 `⊘ skip`                                      | `skip` 不影响退出码，**不得**把「未建链」伪装成「已验证」                                                                                             | `  ✖ / ✔ / ⊘` 前缀                                                                                                     | `path.relative(ROOT, …)` 后再打，避免绝对路径入日志 |
| N4 `stripAssetPathFields` | 入参非对象/非数组 → 原样返回；`null`/`undefined` → 原样返回；**内部抛错 → 返回「已裁剪的部分副本」而非原件**（fail-closed：宁少不漏）                                      | 深度上限 6（`{items:[{photos:[{asset}]}]}` 实测深度 4）+ `WeakSet` 防环                                                                               | 不新增日志（避免把载荷塞进 `diagLog`）；`src/main/app/nikkisync-runtime-setup.ts:218-226` 现有双通道日志不引入路径新键 | 键名本身可打，**值不可打**                          |
| N4 跨态一致               | `getResource`/`listResourceRecords` 的 `mode:'path'` **不得**被裁（裁了 `media://` 当场 403）                                                                              | 由新增的「仍原样返回」用例钉住（含 `:633` 的 `toBe`）                                                                                                 | 同现有 `media-protocol` 判定日志                                                                                       | —                                                   |

统一约束：本轮**不新增 `AppError` 子类、不改 `IpcResponse`/`IpcError` 形状**（评估 §4-A 已证协议零破坏），因此 `docs/IPC_CONTRACT.md` 只需增补「字段被裁剪」的说明，属向后兼容的可选字段减少（渲染层零消费点已实测）。

## 6. 参数校验

本轮不新增 IPC 通道 ⇒ 不新增 zod schema、不改 `schemas`；既有通道入参校验一律不变（`src/main/ipc/validator.ts`）。需要校验的入参只有两处，且**复用仓库既有形态**：

| 入参                            | 类型                                             | 必填 | 边界                              | 非法值                              | 复用点                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------ | ---- | --------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stripAssetPathFields(value)`   | `unknown`                                        | 是   | 深度 ≤6；数组按成员递归           | 非对象原样返回；抛错回退副本        | 上游 DTO 在本仓以 `unknown` 承接是既有约定（`runtime-types.ts:314-344` 全部 `Promise<unknown>`；`src/renderer/vite-env.d.ts:927` 注释「资产业务字段以 unknown 承接」），**不另建类型** |
| `CHAIN_REQUIRED_ARTIFACTS` 元素 | `readonly string[]`，`path.join('dist','src',…)` | 是   | 相对包根、不含 `..`、不含绝对路径 | 由 `evaluateNikkiSyncLink` 缺件点名 | 与 `:46-83` 三张既有清单逐字同形态；子路径逃逸校验的既有纪律参照 `link-nikkisync.ts:89-102` `validateRequiredSubpaths`（**不重复实现**，仅在测试里用字面 `toEqual` 钉死清单内容）      |

单一真相源义务：清单只写一份（`verify-nikkisync-link.ts`），`pre-dist-check.ts` 必须 `import`；否则 `:604-606` 的「两侧不得各自抄录」被破坏。期望值一律用与被测代码**同一 `path.join` 绑定**构造，禁止在测试里手写 `dist\\src\\...` 字符串（`project-conventions.md` §6 例外节：`require('path')` 造期望值会绕过 mock 造成假红）。

## 7. 基础测试用例（正常 / 异常 / 边界 + 是否需要真实连接）

| #   | 节点      | 落点文件                                                                                                 | 正常                                                      | 异常                                                          | 边界                                                                        | 外部连接                                  |
| --- | --------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------- |
| T1  | N1        | `src/main/nikkisync/runtime-facade.linked.test.ts:398-412`                                               | `infer(newest.effectiveAt + 1s) === newest.version`       | 表空 / `NaN` ⇒ 显式失败并提示形态漂移                         | 历史边界 1.4/含等号/1.3/早于 1.0 保持不变；`undefined` 与非法串两支保持不变 | **需真实链接**（读上游产物，非桩）        |
| T2  | N2        | `src/main/nikkisync/runtime-facade.test.ts`（既有用例，零新增）                                          | `listChanges` 旧判据两支行为不变                          | `minimum === undefined` ⇒ `fullResyncRequired=false`          | `after === minimum - 1`                                                     | 不需（假 surface，CI 必跑）               |
| T3  | N3        | `scripts/__tests__/verify-nikkisync-link.test.ts`                                                        | 齐全 ⇒ `present: …`、`failing()` 空                       | 已链接缺件 ⇒ 硬阻断 + 点名 + 提示 `npm run build`             | 事实字段缺省 ⇒ 整条缺席；未链接 ⇒ 降 `warn` 不阻断                          | 不需（纯函数注入）                        |
| T4  | N3        | 同上，新增 `describe`                                                                                    | 字面 `toEqual` 钉死 3 项与顺序                            | —                                                             | 用 `path.join('dist','src',…)` 构造期望值                                   | 不需                                      |
| T5  | N3        | `scripts/__tests__/pre-dist-check.test.ts`                                                               | 谓词全真 → `[]`                                           | 缺 `MediaFingerprint.js` → 长度 1 且点名                      | 空清单 → `[]` 不误报                                                        | 不需（谓词注入）                          |
| T6  | N3 端到端 | 本机 `npm run verify:nikkisync`                                                                          | 13 行、`blocking failures: 0`、exit 0                     | 负向：`NIKKISYNC_ROOT` 指向**副本**并删一个文件 ⇒ exit 1 点名 | 未建链 ⇒ 全 `warn`、exit 0                                                  | 需真实链接（副本法，不碰 `../NikkiSync`） |
| T7  | N4        | `src/main/nikkisync/runtime-manager.test.ts`                                                             | 裁剪后 `{items,libraryRevision}` 其余键原样               | fake 带两键 ⇒ 序列化后不含                                    | **红先行**：修复前 `Tests 2 failed`；嵌套 `photos[].asset` 一支同红         | 不需（fake queries）                      |
| T8  | N4        | 同上                                                                                                     | `getResource(...,'path')` 仍 `toBe('/game/photos/1.jpg')` | 非对象入参原样返回                                            | `sourcePath` 缺席 ⇒ `sourceFolder` 同时缺席（成对）                         | 不需                                      |
| T9  | N4        | `src/main/nikkisync/runtime-facade.linked.test.ts` 新增                                                  | raw 与 stripped 键集差恰为两键                            | 夹具 raw 不含键 ⇒ **显式失败并提示换夹具**                    | 深度 4 的 `searchSuits` 载荷                                                | **需真实链接 + 真实扫描入库**             |
| T10 | 全局      | 既有 `protocol-drift` / `runtime-loader` / `sync-server.linked` / `metadata-resolver.{linked,isolation}` | 全绿、`0 skipped`                                         | —                                                             | —                                                                           | 需真实链接                                |

**红灯先行总安排**：T1（已在 HEAD 真红，`AssertionError: expected '2.11' to be '2.10'`）、T7（fake 驱动，CI 亦可复现）、T9（链接态真产物）三类各一条真红，均在生产改动之前提交；T2 是唯一不造红的节点（裁决禁止行为变更），已用 §4·N2 的阅读性双 `grep` 取证替代并在此如实标注。**反假绿三条纪律**：每次链接态验收必须核对 `0 skipped`；`describe.skip` 与 0 失败不等价；不得用 `it.skip`/放宽断言/降 `warn` 换取绿灯（`project-conventions.md` §6 禁止项）。

---

## 8. 全局验证矩阵

| 命令                                                                                                                 | N1   | N2   | N3             | N4   | 本轮终局                                  | 阻断性                                          |
| -------------------------------------------------------------------------------------------------------------------- | ---- | ---- | -------------- | ---- | ----------------------------------------- | ----------------------------------------------- |
| `npx vitest run src/main/nikkisync`                                                                                  | ✅   | ✅   | ✅             | ✅   | ✅（须 0 failed / 0 skipped / ≥276→≥280） | 本机必须                                        |
| 合并口径 19 files / 320+（评估 §5.4 同口径）                                                                         | ✅   | ✅   | ✅             | ✅   | ✅                                        | 本机必须                                        |
| `npm run verify:nikkisync`                                                                                           | —    | —    | ✅             | —    | ✅（12→13 行，blocking 0）                | 本机必须；CI warn-only                          |
| `npm run link:nikkisync:check`                                                                                       | 前置 | 前置 | 前置           | 前置 | ✅                                        | 每次验证前                                      |
| `npx vitest run scripts/__tests__/{verify-nikkisync-link,pre-dist-check,link-nikkisync,self-contained-deps}.test.ts` | —    | —    | ✅             | —    | ✅                                        | CI（`npm test`）                                |
| `npm run verify` / `verify:staged`                                                                                   | ✅   | ✅   | ✅             | ✅   | ✅                                        | 本机闭环                                        |
| `npm run typecheck`（`tsc -b` + `tsconfig.scripts.json`）                                                            | ✅   | ✅   | ✅             | ✅   | ✅                                        | CI `lint-typecheck`                             |
| `npm run typecheck:e2e`                                                                                              | —    | —    | —              | —    | ✅                                        | CI（不得折进 typecheck，TS6310）                |
| `npm run lint` / `npm run format:check`                                                                              | ✅   | ✅   | ✅             | ✅   | ✅                                        | CI                                              |
| `npm run docs:links`                                                                                                 | —    | ✅   | —              | ✅   | ✅                                        | 本机 + 文档守卫                                 |
| `npm run i18n:guard`                                                                                                 | —    | —    | —              | ✅   | ✅（预期与本轮前同读数：本轮零新 key）    | CI                                              |
| `npm test`（10 分片）                                                                                                | ✅   | ✅   | ✅             | ✅   | ✅                                        | CI 一票否决                                     |
| `npm run test:coverage`                                                                                              | ✅   | ✅   | ✅             | ✅   | ✅                                        | CI（阈值不过 ⇒ 不打入 `build`）                 |
| `npm run test:ci-linux`                                                                                              | ✅   | ✅   | —              | ✅   | ✅                                        | CI 语义装置（本轮不引入路径语义改动，预期零红） |
| `npm run verify:dist`                                                                                                | —    | —    | ⚠ 需建链打包态 | —    | 人工（M2）                                | 仅 `dist:win` 链内                              |

钩子差异必须记住：`.husky/pre-commit` **会改写**文件（`eslint --fix` + `prettier --write` + 重新暂存），`npm run verify` 只读 ⇒ 「verify 绿」不等于「提交后文件不变」；每次提交后 `git status --porcelain` 复核钩子留下的改动并归入同一提交。

## 9. 回滚方案

优先级：**配置开关热关 → 节点逆序回退**。本轮除 N4 外无功能开关。

1. N4 无开关（§4·N4 已论证：开关的另一支在 CI 恒无证据）。逆序回退：`git revert` N4 的 `docs(ipc)` → `fix` → `test` **三连同批**（只回 `fix` 会留红）。数据安全性：不写库、不写文件、不改 `media://` 授权表（`resource-allowlist.ts` 未触碰）⇒ 无迁移、无残留态。
2. N3：`git revert` 两段 ⇒ `verify:nikkisync` 回 12 行。`src/**` 运行期不读清单 ⇒ 产品零影响。已发布安装包不含本轮任何改动 ⇒ 无装机侧回滚。
3. N2 / N1：纯文本 / 纯测试，`git revert` 即完全复原。
4. **数据库面零迁移**（评估 §4-B 已实测）：上游 `initialize()` 无版本门控、SQL 全 `IF NOT EXISTS` ⇒ 老库下次开库自动补 `idx_assets_gallery_order`；回退本轮也不会「留下多余索引」（索引本就在上游 SQL 里，与本仓代码无关）。迁移安全性结论：本轮所有节点均**不改 schema、不写用户库**。
5. 若必须连文档一并撤回：`docs/plans/*-02`/`-05` 可单独 revert，不影响代码闸门。

## 10. 人工验证清单（无法自动化项）

| #   | 项                                                 | 前置                                                                                                          | 步骤                                                                                                                      | 预期读数                                                                                                                                |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | LAN 侧泄漏边界（本轮裁不到的那一面）               | 建链 + `npm run build` + 起 App + `nikkisync.syncServerEnabled=true` + 已配对 1 台设备                        | 配对端请求 `GET /v1/assets` 抓 body；同时在 DevTools 里跑 `window.electronAPI.nikkisync.getAssets()`                      | 上游侧**含** `sourcePath`/`sourceFolder`（本仓不得改上游），本仓渲染层侧**不含** ⇒ 两个读数都要写进结案，避免后人以为本轮已闭合全部泄漏 |
| M2  | 打包态新清单咬合                                   | 建链、上游已 `npm run build`、`npx electron-builder --dir` 出新解包树                                         | `npm run verify:dist`                                                                                                     | 新增块逐项 `✔`（或组级 pass 行）+ 末行 `✅ 解包产物校验通过` + exit 0                                                                   |
| M3  | 新闸门不是装饰（负向对照）                         | 上游检出**副本**一份（禁碰 `../NikkiSync`），副本里删 `apps/pc-companion/dist/src/server/MediaFingerprint.js` | `NIKKISYNC_ROOT=<副本> npm run link:nikkisync && npm run verify:nikkisync`                                                | exit 1、`[verify:nikkisync] FAILED (1 blocking failure(s))`、点名 `dist\src\server\MediaFingerprint.js`；验完恢复四条链                 |
| M4  | 渲染层路径需求未误伤                               | 建链、库内 ≥20 条已扫资产且含 1 个 `motion_photo`                                                             | 打开同步图库翻页一屏 → 开实况照片详情 → 播视频 → 导出/分享 1 张                                                           | 缩略图与实况视频正常（它们吃 `get-resource-records` 的 `mode:'path'`，本轮刻意不裁）、无 `media://` 403、控制台无错                     |
| M5  | 版本边界翻牌（N1 的时点效应）                      | 建链构建；时刻 ≥ `2026-10-30T07:00Z`                                                                          | 看图库版本徽标；对一条落在 `uncertainFrom..effectiveAt` 区间的拍摄时间调 `nikkisync:resolve-game-version`                 | 徽标 `2.10 → 2.11`；区间内拍摄显示 unknown（两键缺省）而**不是空白/崩溃**                                                               |
| M6  | K8 破坏性删除链重基线（评估 R9，本轮无自动化证据） | 建链、**可丢弃的副本库**、回收站先备份                                                                        | 单条批准 → 批量批准 ≤500 → 排队后手改其中一个文件字节 → 观察整批 `authorized:` 与 `recycleMany` 分块                      | 未经 `confirming` 不删任何文件；改动过的批停在 `changed`；上游中文 `message` 不出库（只有 `id/assetId/state/online/files/count`）       |
| M7  | 装依赖后的链卫生                                   | 任何一次 `npm install` 之后                                                                                   | `npm run link:nikkisync && npm run link:nikkisync:check && npm run verify:nikkisync && npx vitest run src/main/nikkisync` | `check OK`、`blocking failures: 0`、**`0 skipped`**、≥276 用例真实执行                                                                  |

## 11. 待确认清单（需逐条裁决，未裁不得写入执行动作）

| #   | 待确认                                                                                                                                                   | 推荐方案                                                                                        | 影响                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Q-a | 本轮是否重打包（`npm run dist:win` + `verify:dist`）                                                                                                     | **不重打包**：N1–N4 无产品功能新增，N3 新块在未建链时 `skip`                                    | 不打包 ⇒ M2 只在本机 `--dir` 解包树上取证；打包面证据推到下一次既有发布计划                                  |
| Q-b | 结案文档形态：并入 `02-实施计划` 回写，还是另起 `…-03-执行记录.md` / `…-05-结案报告.md`（上一轮系列有独立 03/04/05）                                     | 另起 `03-执行记录` + `05-结案报告`，与上一轮系列骨架一致                                        | 文件多两篇，但 `docs:links` 与后续检索能对齐上一轮口径                                                       |
| Q-c | 是否登记 DEBT：`CHAIN_REQUIRED_ARTIFACTS` 是**命名清单**而非闭包（实测装载链 50 模块 / 34 未点名）                                                       | 登记一条新 DEBT（`docs/技术债清单.md` + `docs/debt-registry.json`），判据写「闭包级闸门待授权」 | 不登记 ⇒ 下轮同步仍可能冒出第 4 个未点名产物，重复本轮的取证成本                                             |
| Q-d | 是否顺手清 `runtime-facade.ts:217`/`:267` 之外的失效序号（如 `pre-dist-check.ts:905`「不跑打包前 11 项」、`runtime-facade.ts:450` 引用的不存在测试文件） | **不清**（非本轮差异引出），只在 N5 结案里列为一处已知失真                                      | 清了算夹带；不清 ⇒ 留下一条已记录但不修的失真                                                                |
| Q-e | 上游自测（`../NikkiSync` 的 22 个 pc-companion 测试 + 三包测试，评估 R11 `not-run`）本轮是否补取证                                                       | 补一次只读取证并写入结案（不改上游任何文件，跑完复核 `porcelain` 仍 0）                         | 不补 ⇒ 「上游绿灯」继续是未取证假设；补 ⇒ 若上游自身有红，需决定是否阻断本轮采纳                             |
| Q-f | M6（K8 真机破坏性删除）是否本轮执行                                                                                                                      | **本轮执行**：`DeletionQueue` 本轮 +142/−29，且 `NativeMediaOperations.js` 新入链               | 不执行 ⇒ 破坏性路径继续「单测绿但无可用证据」（评估 §11 明示上一轮 M3/M4/M5 未重跑）                         |
| Q-g | `01-影响评估.md` 目前未跟踪（`??`），是否随 N0 提交入仓                                                                                                  | **入仓**：否则 §10 裁决与本文 §0.1 订正无仓内留痕，下轮无从交叉认定基线                         | 不入 ⇒ 基线锚点只存在于本机；入 ⇒ 注意 `release-sync/` 同样未跟踪且不在 `.gitignore`，必须按文件名 `git add` |

## 12. 待提问项（当前为空）

本轮探索触发的四处「无法单凭评估/指引/代码判定」的提问已闭合：§0 四项裁决 + §0.1 对评估的事实订正已作为**新增证据**呈报并获裁决 3 采纳（闸门覆盖 3 个模块而非 1 个）。执行期间若评估文档与本文出现新冲突，按任务约束停止并提问。

---

## 13. 自检（阶段二停止门）

- [x] **引用命令均实测存在**：`package.json` 内 npm script 与 `npx vitest run <路径>` 全部逐条核实（§3.3 附行号）；关键读数取于 2026-10-29 本机：`verify:nikkisync` 12 项 ✓ / 上游 `porcelain` 0 行 / `BUILD_EXIT=0` / 域测试 `1 failed | 275 passed (276)` 且 `0 skipped`
- [x] **每节点三要素齐备**：N1–N5 各含实测完整路径、输入→输出、以「具体命令 + 具体结果」表述的验收；附依赖图（`N0 → N1∥N2∥N3∥N4 → N5`）与提交边界（`test` / `fix` / `chore(gate)` / `docs(nikkisync)` / `docs(ipc)` / `docs(plans)`，已按 `commitlint.config.cjs` 实测规则核对长度与格式）
- [x] **三类测试与红灯策略明确**：T1–T10 逐条标正常/异常/边界与「是否需要真实连接」；T1/T7/T9 三条真红先行，T2 以阅读性双 `grep` 替代并如实标注；三条反假绿纪律（核对 `0 skipped`、`describe.skip` ≠ 0 失败、禁用 skip/放宽阈值）
- [x] **待确认与待提问无遗漏**：待确认 7 条（各附推荐与影响）、待提问 0 条；评估 §10 的 Q1–Q5 全部落到 §0 裁决或本文节点
- [x] 本轮**不触碰**受保护 glob ⇒ 无需 `// @core-change:`；若执行中新触 `src/main/ipc/handlers/**` 等，按约定替换授权注释并停等确认
- [x] 上游零改动约束贯穿：N3 负向取证用**副本 + `NIKKISYNC_ROOT`**，M2/M3/M5/M6 均要求 `git -C ../NikkiSync status --porcelain` 复核 0 行
- [x] **阶段二到此停止**：本文仅落盘计划文档，未改任何业务代码、未做任何 git 提交（`docs/plans/2026-10-29-nikkisync-upstream-sync-02-实施计划.md` 仍为未跟踪状态，是否入仓由 Q-g 裁决）
