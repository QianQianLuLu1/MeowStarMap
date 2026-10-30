---
title: NikkiSync 上游同步 · 03 执行记录（阶段三：按 02 计划逐节点真跑）
date: 2026-10-29
plan: 2026-10-29-nikkisync-upstream-sync-02-实施计划.md
assessment: archive/2026-Q4/2026-10-29-nikkisync-upstream-sync-01-影响评估.md
---

# NikkiSync 上游同步 · 03 执行记录

> 执行日期：2026-10-29 · 起点本仓 `main` @ `c45e3f4` · 上游锚点 `b397e0e`（tag `v1.0.27-public-beta.1`）
> 口径：每条读数都是本机实际执行的结果，未执行的显式记 `not-run`，不以推断代替读数。
> 上游零改动铁律：本轮全程未修改 `../NikkiSync` 任何被跟踪文件，执行前 / 上游自测后 `git -C ../NikkiSync status --porcelain | wc -l` 均为 **0**。

## 0. 前置与授权

- 02 计划经批准后，用户指令为「按计划开始执行，不要等我逐条裁决」⇒ §11 的七项待确认按其**推荐值**执行，逐条落点见本文 §7。
- 环境自检（执行前）：`git -C ../NikkiSync rev-parse HEAD` = `b397e0eb6ca1b4748f13a72f13bb1702a549410e`；`tag --points-at HEAD` = `v1.0.27-public-beta.1`；`npm run link:nikkisync:check` = `check OK (all four links in place)`；`npm run verify:nikkisync` = `OK (blocking failures: 0)`。
- 全程未执行 `npm install` / `npm update`（AGENTS.md 硬约束 6 / 评估 R1：会剪掉四条 junction，把链接态证据降级为 skip）。

## 1. N0 · 文档落盘与双锚点（提交 `8aea3fd`）

| 项       | 读数                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 动作     | 01 评估追加 `§10.1 裁决结论`（含对 §4-A/§10-Q3 的事实订正）；02 计划全文落盘 `docs/plans/`                                                               |
| 验收     | `git commit` 后 2 文件入库、`727 insertions(+)`；`npm run docs:links` 退出 **0**（`✅ 无死引用`，另有 177 处既存提醒）                                   |
| 提交规范 | `docs(plans): 落盘本轮 NikkiSync 同步的影响评估与实施计划并记双锚点`（subject 长度符合 `subject-max-length: 72`、不以 `。` 收尾）                        |
| 风险控制 | 仅按文件名 `git add`，未用 `-A`：`release-sync/` 未跟踪且不在 `.gitignore`（内含 `app.asar`），提交后 `git status --porcelain` 仍只有 `?? release-sync/` |

## 2. N1 · K3 日历断言改为从产物派生（提交 `33f75b7`）

**修复前红灯（真红，非制造）**

```
npx vitest run src/main/nikkisync
  AssertionError: expected '2.11' to be '2.10'   runtime-facade.linked.test.ts:408:47
  Test Files  1 failed | 15 passed (16)
  Tests       1 failed | 275 passed (276)
```

**修复内容**（只改测试，未动生产代码：`GameVersionCalendarSurface` 早已声明 `getGameVersionReleases(): unknown[]`）

- 取最新行：`effectiveAt` 最大值（`reduce` 比 `Date.parse`），不用 `[0]`；
- 未来时刻：`new Date(Date.parse(newest.effectiveAt) + 1000).toISOString()`，不用固定年份、不用 `new Date()`；
- 新增降序不变式 `expect(stamps).toEqual([...stamps].sort((a,b)=>b-a))` 与非有限时间戳守卫 `Number.isFinite`；
- 历史边界 `1.4 / 含等号 / 1.3 / 早于 1.0` 与 `undefined / 'not-a-date'` 四支原样保留；
- `实测表（b422193）` 原句保留并加时间限定，写明最新项自 `b397e0e` 起改为派生。

**为什么不钉「当下时刻」**：上游 `2.11` 行是 `tentative`，`uncertainFrom=2026-10-29T19:49Z`、`effectiveAt=2026-10-30T07:00Z`；`inferInfinityNikkiGameVersion` 在 `uncertainFrom ≤ t < effectiveAt` 区间**返回 `undefined`**（实读上游 `GameVersionCalendar.ts:57-64`），钉「现在」就是时点炸弹。

**修复后**：`Test Files 16 passed (16)`、`Tests 276 passed (276)`、**0 skipped**（用例总数不变，未新增 `it`）；`npm run verify` 五项全过（含 format，经 `prettier --write` 归一后复验）。

## 3. N2 · 判据同源表述订正（提交 `a1f361c`，零行为变更）

**阅读性红灯（替代失败用例——裁决禁止行为变更，故无可写用例）**

```
repo     runtime-facade.ts:551  const fullResyncRequired = minimum !== undefined && after < minimum - 1
upstream LocalSyncServer.ts:457 const fullResyncRequired = after<this.accounts.revision() || minimum !== undefined && after < minimum - 1
```

两处不同而四处文案宣称「逐字同上游/照抄不作改」⇒ 自相矛盾，即本节点闭合的红。同时订正既存失真：原注释引用的上游行号 `:439` 在基线 `b422193` 实际是 `:453`，本轮漂到 `:457`，从未对上任何一侧。

四处落点：`runtime-facade.ts` 的 `listChanges` 注释、`src/main/nikkisync/AGENTS.md` 的 `runtime-facade.test.ts` 职责行、`runtime-types.ts` 的 `listChanges` 文档块、`docs/IPC_CONTRACT.md` §8.1.1 `get-changes` 行。

**验收**：`grep -n "（:439）" src/main/nikkisync/runtime-facade.ts` → 0 命中；`grep -rn "逐字同上游\|判据照抄上游" …` → 0 命中（全部改为带 `b422193 时点` 限定）；`npx vitest run src/main/nikkisync/runtime-facade.test.ts` → **38 passed**（行为未变）；`npm run verify` 五项全过；`docs:links` 退出 0。

## 4. N3 · 装载链共享清单与阻断检查（提交 `f4fd565` 测试 + `a90a7cf` 生产）

**红灯先行成立且环境无关**（纯函数注入，不需建链、不需上游在场）

```
npx vitest run scripts/__tests__/verify-nikkisync-link.test.ts scripts/__tests__/pre-dist-check.test.ts
  修复前：Test Files 2 failed (2)；Tests 7 failed | 65 passed (72)
  修复后：Test Files 2 passed (2)；Tests 72 passed (72)
```

七条红全部指向缺失的 `CHAIN_REQUIRED_ARTIFACTS` 导出与对应检查项；「事实字段缺省时整条检查缺席」这条边界守卫按设计前后皆绿。

**清单覆盖 3 个模块**（比评估 Q3 原记的 1 个多两个，实测依据）：`row-mappers.js → MediaFingerprint.js`、`LocalSyncServer.js → AccountSyncSettings.js`、`runtime.js → NativeMediaOperations.js`（后者在桶导出 `index.js:4` 闭包内）。闭包实测：装载链 50 模块、34 个未被点名，本轮新增缺口即这 3 个 ⇒ 余下 31 个记为 **DEBT-040**。

**打包态复用同一真相源**：`pre-dist-check.ts` 仅 `import { CHAIN_REQUIRED_ARTIFACTS }` 并复用既有纯函数 `missingPackedCapabilityArtifacts`（与清单内容无关），未新增第二个判定核、未内联字面量路径。

**开发态读数**（`npm run verify:nikkisync`，由 12 行增至 13 行）

```
  ✓ @nikkisync/pc-companion ships the load-chain static dependency artifacts — present:
    dist\src\server\MediaFingerprint.js, dist\src\server\AccountSyncSettings.js, dist\src\organizer\NativeMediaOperations.js
[verify:nikkisync] OK (blocking failures: 0)     exit 0
```

**顺带订正**：`runtime-facade.ts:217`/`:267` 的「第 12 项检查」序号本就失效（实测 capability 项在第 7 位），新增项落在第 8 位 ⇒ 改为按清单名指代，`grep -c "第 12 项" runtime-facade.ts` → **0**。

**其他**：`npm run typecheck`（`tsc -b` + `tsc -p tsconfig.scripts.json`）退出 **0**；合并口径 `20 files / 365 tests` 全绿、0 skipped。

## 5. N4 · 委托层裁剪 `sourcePath`/`sourceFolder`（提交 `1e11c0e` 测试+修复 + `2f9ccc8` 文档）

**提交边界偏离（必须记账）**：计划原定 `test → fix → docs` 三段。本仓 `.husky/pre-commit` 的 lint-staged 会对 `src/**` 暂存文件跑匹配套件，**刻意留红的提交被自家闸门拒绝**（Step 1 FAILED）。按约定不使用 `--no-verify` 绕闸门，改为 `test+fix` 合并一次提交、`docs` 单独一次；两条红读数写入 message 留痕。`scripts/**` 下的 N3 不受此影响（`test:precommit` 仅由 `src/**` 键触发），故 N3 的红/绿两段拆分得以保留。

**修复前红灯**

```
npx vitest run src/main/nikkisync/runtime-manager.test.ts
  Tests 3 failed | 71 passed (74)
npx vitest run src/main/nikkisync/runtime-facade.linked.test.ts
  Tests 1 failed | 14 passed (15)
  AssertionError: expected '{"items":[{"assetId":"asset_2f471aa80…' not to contain 'sourcePath'
```

同批新增的**反空转取证**用例「raw 查询面确实产出两键」实测为绿 ⇒ 证明上游真实扫描夹具确实产出 `sourcePath`/`sourceFolder`，裁剪用例不是因为「上游没产出」而空转。

**实测泄漏面（决定裁哪几处）**：只有 `mapAssetSummary` 产出两键（`row-mappers.ts:120`，且 `sourceFolder` 由 `sourcePath` 剥尾段得到 ⇒ 成对出现）；到渲染层的通道只有 `listAssets`（顶层）、`searchSuits`/`searchClothing`（**嵌套** `items[].photos[].asset`，上游 `SuitSearchIndex.ts:163` 按引用塞入）。`getAssetDetail` 走 `mapAssetRow` 不带路径；`profileStats` 不吐 asset 对象；`organizer*` 的 `files` 已被上游 `basename` 化。

**三条硬约束落地**

1. **copy-on-write**：`createQuerySurface().searchSource()` 按 revision 缓存资产行并与 `profileStats` 共享对象引用 ⇒ 就地 `delete` 会污染缓存。为此在 `FakeSessionPlan` 增 `assetPage`/`suitPage` 两个身份稳定注入缝，用例断言裁剪后**原件两键仍在**。
2. **按形状递归下钻**（非硬编码响应结构），深度上限 8、`WeakSet` 防环；超限只停下钻、当层两键照样剔（宁少不漏）。
3. **刻意不裁** `getResource` / `listResourceRecords` 的 `mode:'path'`——那是 `media://` 授权的唯一出口（`registerNikkiSyncResourcePaths`），并有专门用例钉住「仍返回绝对路径原值」。

**未加运行时开关**（与「默认关闭」口径的偏离，理由写入 02 计划 §4·N4 与契约）：被裁两键在本仓零消费点、vendored `AssetSummary` 刻意不扩面；而 CI 恒未建链、链接态用例整件 skip，开关的「开」这一支将永久无证据。

**修复后**

```
npx vitest run src/main/nikkisync/runtime-manager.test.ts src/main/nikkisync/runtime-facade.linked.test.ts
  Test Files 2 passed (2)；Tests 89 passed (89)
npx vitest run src/main/nikkisync src/main/ipc/handlers/nikkisync-handler.test.ts src/renderer/utils src/renderer/stores
  Test Files 64 passed (64)；Tests 1009 passed (1009)
```

handler 的 27 通道有序 `toEqual` 与 6 条身份 `toBe` 钉测**零改动通过** ⇒ 委托层落点未触碰「handler 不加工返回值」这条既有契约。文档面：契约 §8.1 增「一处刻意例外」（含覆盖边界：本仓渲染层已闭合，上游 LAN 服务对已配对设备仍照常下发 ⇒ 不得写成泄漏已全闭）；`assetViewModel.ts` 头部「不含任何绝对路径」原句保留加时点限定。

## 6. N5 · 全量回归读数

| 命令                           | 读数                                                                                                          | 结论                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `npm test`                     | `Test Files 453 passed (453)`；`Tests 7077 passed \| 12 skipped (7089)`                                       | 全绿                               |
| `npm run typecheck`            | 退出 0（`tsc -b` + `tsconfig.scripts.json`）                                                                  | 绿                                 |
| `npm run typecheck:e2e`        | 退出 0                                                                                                        | 绿                                 |
| `npm run lint`                 | 退出 0（`eslint .` 全量）                                                                                     | 绿                                 |
| `npm run i18n:guard`           | `✅ 白名单只减不增、清零必移除、key 已同步，守卫通过`                                                         | 绿（本轮零新 key，与计划预期一致） |
| `npm run verify:nikkisync`     | 13 行、`OK (blocking failures: 0)`、exit 0                                                                    | 绿                                 |
| `npm run link:nikkisync:check` | `check OK (all four links in place)`                                                                          | 绿                                 |
| `npm run docs:links`           | 退出 0                                                                                                        | 绿                                 |
| `npm run test:coverage`        | 见 `05-结案报告` §3（阈值门控读数单列）                                                                       | 见结案                             |
| `npm run test:ci-linux`        | **exit 1**：`Test Files 32 failed \| 421 passed (453)`；`Tests 59 failed \| 6909 passed \| 61 skipped (7029)` | 本轮**未引入**，见下               |

**`test:ci-linux` 的红是既有宿主语义现象，不是本轮回归**（不进 CI，AGENTS.md 明写「只读诊断」）。归因证据：

1. 两类根因，均与本轮 14 个改动文件无因果：`Error: Could not load the "sharp" module using the linuxnull-x64 runtime`（装置伪造 linux 平台 ⇒ sharp 原生二进制解析不到，波及所有 import sharp 的套件）；`Error: unable to open database file`（装置把容器根置为不可写 ⇒ `DatabaseManager` 开不了库）。
2. 同文件同因：`runtime-facade.linked.test.ts` 在装置下有 10 条红，其中 **8 条是本轮未触碰的既有用例**，且最先失败的 `会话创建` 正是源头（`git diff c45e3f4..HEAD` 对该文件的增删行中提及 `会话创建` 的条数 = **0**）。本轮新增 2 条因同一次 `createRuntimeSession` 失败而连带失败。
3. 本轮新增用例在装置下**未新增红**：`pre-dist-check.test.ts` 的失败项是既有的 `resolveVerifyAsarTarget`，不含新加的链上清单三例；`verify-nikkisync-link.test.ts`、`runtime-manager.test.ts`、`assetViewModel.test.ts` 均未出现在失败清单。
4. 结论与处置：不在本轮修复（属路径语义/装置面，非本轮上游差异引出）；已在结案登记为已知现象，并保留原读数。

## 7. 七项待确认的执行落点

| #   | 采纳值              | 落点与证据                                                                                                                                     |
| --- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Q-a | 不重打包            | 未跑 `npm run dist:win` / `verify:dist`（新块在未建链时 `skip`）⇒ M2 记 `not-run`                                                              |
| Q-b | 另起 03 + 05        | 本文件 + `2026-10-29-nikkisync-upstream-sync-05-结案报告.md`                                                                                   |
| Q-c | 登记技术债          | **DEBT-040**（命名清单 ≠ 装载链闭包；34 未点名，本轮补 3）写入 `docs/debt-registry.json` 与清单 §17                                            |
| Q-d | 不清理无关失效序号  | 未动 `pre-dist-check.ts:905`「11 项」与 `runtime-facade.ts:450` 引用的不存在测试文件 `library-paging.linked.test.ts`；仅在结案 §5 记为已知失真 |
| Q-e | 补上游自测取证      | 已跑，**上游 exit 1 / 1 条确定性红** ⇒ 登记 **DEBT-041**，详见结案 §2                                                                          |
| Q-f | K8 真机删除尽量取证 | **not-run**：需已配对手机 + 会真删用户文件，无自动化缝（K8 套件刻意不进 `executing` 态）；不做破坏性试验，理由见结案 §4                        |
| Q-g | 评估入仓            | 已随 N0 提交 `8aea3fd`                                                                                                                         |

## 8. 提交清单

| SHA       | 主题                                                                                       | 节点 |
| --------- | ------------------------------------------------------------------------------------------ | ---- |
| `8aea3fd` | `docs(plans): 落盘本轮 NikkiSync 同步的影响评估与实施计划并记双锚点`                       | N0   |
| `33f75b7` | `test(nikkisync): K3 日历断言改为从上游产物表派生最新项，闭合同步红灯`                     | N1   |
| `a1f361c` | `docs(nikkisync): 订正增量变更判据的同源表述并锚定上游行号与作用域豁免理由`                | N2   |
| `f4fd565` | `test(守卫): 为装载链新增产物建立封闭清单闸门（修复前红灯取证）`                           | N3   |
| `a90a7cf` | `chore(gate): 新增 CHAIN_REQUIRED_ARTIFACTS 清单与阻断检查，pre-dist 复用同一真相源`       | N3   |
| `1e11c0e` | `fix(nikkisync): 委托层裁剪上游新增的 sourcePath/sourceFolder，保住渲染层无绝对路径的姿态` | N4   |
| `2f9ccc8` | `docs(ipc): 登记资产响应路径裁剪与 path 模式按设计保留`                                    | N4   |
| （N5）    | `docs(plans): 回写执行记录与结案报告并登记 DEBT-040/041`                                   | N5   |

本轮改动文件共 14 个，全部落在 `src/main/nikkisync/**`、`scripts/**`、`src/renderer/utils/assetViewModel.ts`、`docs/**`；未触碰核心路径受保护 glob ⇒ 全程无 `// @core-change:` 需求（`core-path-gate` 四次均 `⊘ 跳过`，实测一致）。

## 9. 收口复验（阶段三终局 · 2026-10-29 二次下发任务时复跑）

**为什么本节存在**：任务再次以「执行已批准计划中的兼容性收敛节点」下发，开工核对实测出该前提已不成立——上游 `origin/main` 与全部 tag 仍停在 `b397e0e`（本轮已采纳锚点，无新差异），本仓 HEAD `31d59cc` 即 N5 结案提交，且本阶段相关子集全绿（无可制造的真实红灯）。就此提问后裁决为「**做收口复验，不改代码**」。本节把 02 计划 §8 验证矩阵完整重跑一遍并与 §5/§6 与 `05-结案报告` §1 已记读数逐条交叉复核；**唯一改动文件是本文件**，`src/**`、`scripts/**`、契约、债账零触碰。

### 9.1 开工核对（复验起点）

| 项             | 命令                                                                | 实测读数                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上游锚点       | `git -C ../NikkiSync rev-parse HEAD` / `tag --points-at HEAD`       | `b397e0eb6ca1b4748f13a72f13bb1702a549410e` / `v1.0.27-public-beta.1`                                                                                          |
| 上游洁净度     | `git -C ../NikkiSync status --porcelain \| wc -l`                   | **0**（复验前；收尾再取一次）                                                                                                                                 |
| 远端是否更前进 | `ls-remote origin refs/heads/main HEAD` / `ls-remote --tags origin` | 两行均 `b397e0e`；tag 最新 `v1.0.27-public-beta.1` ⇒ **无新锚点**                                                                                             |
| 连接状态       | `npm run link:nikkisync:check`                                      | `check OK (all four links in place)`                                                                                                                          |
| 连接诊断       | `npm run verify:nikkisync`                                          | 13 行全 ✓、`OK (blocking failures: 0)`、exit 0；第 8 行仍点名装载链 3 件产物（`MediaFingerprint.js` / `AccountSyncSettings.js` / `NativeMediaOperations.js`） |
| 本仓工作区     | `git status --porcelain`                                            | 仅 `?? release-sync/`（10-27 遗存的 `win-unpacked`，未被 `.gitignore` 覆盖，非本轮引入）                                                                      |
| 受保护改动规则 | `git diff --name-only c45e3f4..HEAD` × 四条 `PROTECTED_GLOBS`       | 命中 **0**；提交面共 18 个文件，扣除 4 篇计划文档 = **14** ⇒ 与本文 §8「改动文件共 14 个」逐位吻合                                                            |

### 9.2 四个交付节点的静态复核（只读定位，不改）

| 节点          | 复验判据（命令）                                                                                                                                                                                                                                                                                                                | 读数                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| N1 派生断言   | 域内套件                                                                                                                                                                                                                                                                                                                        | `16 files / 282 passed`、**0 skipped** ⇒ 满足结案「≥276→≥280」，判据不再钉时点    |
| N2 文案订正   | `grep -n "（:439）" src/main/nikkisync/runtime-facade.ts`；`grep -rn "逐字同上游\|判据照抄上游" src/main/nikkisync docs/IPC_CONTRACT.md`                                                                                                                                                                                        | **0 命中 / 0 命中**（订正未被回退）                                               |
| N3 单一真相源 | `grep -c "第 12 项"` → 0；`CHAIN_REQUIRED_ARTIFACTS` 定义位与消费位：`verify-nikkisync-link.ts:95`（导出）`:290`/`:450`（消费）、`pre-dist-check.ts:14`（import）、`:780`/`:784`（复用 `missingPackedCapabilityArtifacts`）                                                                                                     | 序号失真 0 命中；打包态确实复用同一表与同一判定核，**无第二判定核、无内联字面量** |
| N4 隐私裁剪   | `stripAssetPathFields` 定义 `runtime-manager.ts:792`，委托调用点 `:844`（`listAssets`）/ `:855`（`searchSuits`）/ `:857`（`searchClothing`）；刻意不裁的 path 模式由 `runtime-manager.test.ts:717` + handler `:401`/`:642` 钉住；契约「一处刻意例外」在 `IPC_CONTRACT.md:389-399`；视图模型时点限定在 `assetViewModel.ts:10-13` | 三处裁剪点 + 两处「保留绝对路径原值」用例全绿；文档三处登记在位                   |

### 9.3 验证矩阵复跑（对照本文 §5/§6 与结案 §1）

| 命令                                                                              | 原记读数                                                                         | 复验读数                                                  | 判定                                                     |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| `npx vitest run src/main/nikkisync`                                               | 276 passed / 0 skipped（N1 时点）                                                | **16 files / 282 passed / 0 skipped**，22.84s             | ✅ 红未复现；+6 条为 N4 新增用例                         |
| 评估 §5.4 同口径合并（域 + 3 个 scripts 套件）                                    | `1 failed \| 319 passed (320)`                                                   | **19 files / 331 passed / 0 skipped**，23.38s             | ✅ 唯一红已闭；+11 条来自 N3/N4 新增                     |
| 扩展合并口径（上表 + `pre-dist-check` + handler + `assetViewModel`）              | 未记同口径                                                                       | **22 files / 448 passed / 0 skipped**                     | ✅ 本节建立为新基准                                      |
| `npx vitest run scripts/__tests__/{verify-nikkisync-link,pre-dist-check}.test.ts` | 72 passed（§4）                                                                  | **72 passed**                                             | ✅ 逐位相同                                              |
| `npm test`                                                                        | 453 files；`7077 passed \| 12 skipped`                                           | **453 files；`7077 passed \| 12 skipped (7089)`**，69.98s | ✅ 逐位相同，一票否决项无漂移                            |
| `npm run typecheck` / `typecheck:e2e`                                             | exit 0 / exit 0                                                                  | **0 / 0**                                                 | ✅                                                       |
| `npm run lint`（`eslint .`）                                                      | exit 0                                                                           | **0**                                                     | ✅                                                       |
| `npm run i18n:guard`                                                              | 白名单只减不增、key 已同步                                                       | 同文案，exit 0                                            | ✅ 仍零新 key                                            |
| `npm run docs:links`                                                              | exit 0，另 177 处提醒                                                            | exit 0，另 177 处提醒                                     | ✅ 逐位相同                                              |
| `npm run verify:nikkisync` / `link:nikkisync:check`                               | 13 行 blocking 0 / `check OK`                                                    | 13 行 blocking 0 / `check OK`                             | ✅ 无阻断项                                              |
| `npm run test:ci-linux`（两次复跑）                                               | `32 failed \| 421 passed (453)`；`59 failed \| 6909 passed \| 61 skipped (7029)` | **两次均为同一读数**                                      | ✅ 相对开工基线**无新增红**（既有装置现象，归因仍见 §6） |
| `npx tsx scripts/core-path-gate.ts`                                               | 四次 `⊘ 跳过`                                                                    | `⊘ 本次变更不涉及核心路径受保护文件，跳过`                | ✅ 复验面同样不触闸门                                    |
| `npm run test:coverage`                                                           | exit 0，All files `70.02 / 61.42 / 62.78 / 71.64`                                | **not-run**（见 §9.5 第 1 条）                            | ⚠ 以盘上产物 + 阈值对照替代                              |
| `npm run verify`                                                                  | 四项全过（N1–N4 各次）                                                           | **not-run**（见 §9.5 第 2 条）                            | ⚠ 构成项已逐一独立跑绿                                   |
| `npm run dist:win` / `verify:dist`                                                | not-run（裁决 Q-a）                                                              | not-run                                                   | 维持结案 §4                                              |

### 9.4 skip 台账：`npm test` 的 12 条逐条归因

先取计数（`npm test` = 12 skipped），再用 `--reporter=verbose` 点名，全部落到仓库已记载的受支持降级语义：

| #      | 用例                                                                                                                                                    | 条件                                                                                         | 语义出处与本轮证明                                                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1–10   | `src/main/utils/ci-linux-emulation.test.ts` 轴 1、2、3、4、4a、4b、4c、4d、4e、4f（装置四轴自检）                                                       | `it.skipIf(!ACTIVE)`，`ACTIVE = globalThis.__wxnnCiLinuxEmulation !== undefined`（`:26-27`） | 文件头第 2 行明写「`npm run test:ci-linux` 专用；普通 `npm test` 与 CI 下整件 skip」；证明：`npx vitest run <本文件> --config vitest.ci-linux.config.ts` → **12 passed / 0 skipped**（装置态真实执行并通过） |
| —      | 同文件的轴 5 与「装置未激活时本文件必须整件跳过」                                                                                                       | 不 skip（`DUAL_PROFILE_TITLES` `:30-35` 显式豁免）                                           | 已执行且绿 ⇒ 哨兵本身在 `npm test` 里有效，不属 12 条                                                                                                                                                        |
| 11–12  | `src/main/sync/identity-service.test.ts:125`「私钥文件权限最小化（POSIX 0600；Windows 继承 userData 每用户 ACL）」、`:186`「Ed25519 私钥文件权限 0600」 | `it.skipIf(process.platform === 'win32')`                                                    | 断言体是 `fs.statSync(key).mode & 0o777 === 0o600`，POSIX 权限位在 NTFS 不成立；属规则 6 允许的「平台专属动作」判定，不是路径语义开关                                                                        |
| 关联   | 同一文件在装置（`vitest.ci-linux.config.ts`）下这两条会执行且**失败**（本机扮 linux、宿主仍是 NTFS ⇒ 装置局限）                                         | —                                                                                            | 已包含在 ci-linux 的 `32 files / 59 tests` 基线内（§9.5 第 4 条的完整清单可核）                                                                                                                              |
| 兼容面 | 域内与合并口径**0 skipped**                                                                                                                             | `hasNikkiSyncLink()` 为真                                                                    | 链接态集成真实执行（评估 §5.4 第 4 条判据），不存在「用 skip 掩盖未跑」                                                                                                                                      |

### 9.5 差异账与 not-run（显式记账，不当作已通过）

1. **`npm run test:coverage` not-run**：权限层拦截（判定「覆盖率采集要写 `./coverage/`，与本轮只读复验冲突」）。替代证据：盘上 `coverage/coverage-summary.json`（本轮 N5 于 21:23 自跑产出）`total` = `70.02 / 61.42 / 62.78 / 71.64`，与结案 §1 记录**逐位相同**；`vitest.config.ts:103-106` 阈值为 `66 / 58 / 59 / 68`，四项均高于阈值 ⇒ 门控结论不变。但「本次复跑阈值门控」缺证，若要补需授权该命令。
2. **`npm run verify` not-run**：同一权限层拦截；另需在干净工作区上 `git diff HEAD` 为空 ⇒ 本就应记 `⊘ 跳过`。替代：其构成项逐一独立跑绿（`tsc -b` + `tsconfig.scripts.json` = 0、`typecheck:e2e` = 0、`eslint .` = 0、`prettier --check --end-of-line auto` 对本文件通过、`core-path-gate` ⊘、相关单测由 §9.3 三行套件覆盖）。
3. **打包面维持 not-run**：`dist:win` / `verify:dist` / M2 依裁决 Q-a 不变；本轮也未跑 `npm install` / `npm update` / `link:nikkisync`（写操作，且会剪链）。
4. **明细缺口（非新增红）**：`test:ci-linux` 的 32 个失败**文件集合**本轮完整捕获（scanner 16、scripts 6、nikkisync 3、media-worker 2、utils 2、ipc/handlers/cache 1、sync/identity-service 1）。其中 `identity-service`、`metadata-resolver.linked`、`sync-server.linked` 三件本文 §6 未点名（原记只举 `runtime-facade.linked` 与两类根因）；两次复跑计数与 §6 逐位相同 ⇒ 属**归因明细不全**，不是回归。根因面另补一类：NTFS 不还原 POSIX mode 位（第 9.4 条关联行）。
5. **用例总数增长**：域 276→282、评估同口径合并 320→331，与 N3（+7 条闸门用例）、N4（+6 条裁剪与反空转用例）一致；本文 §4/§5 未记「阶段一同口径复跑值」，本节补齐该坐标。
6. **`release-sync/` 遗存**：未跟踪且不在 `.gitignore`，内含 `win-unpacked`（10-27）；本节提交仍按文件名 `git add`，不纳入它。

### 9.6 终局判定与下一阶段准入

- 三条收口判据达标：① 只读闸门相对 §5/§6 与结案 §1 **零漂移**（`npm test` 逐位相同、域内 0 failed / 0 skipped、诊断 13 行 blocking 0）；② 契约/漂移守护面 §9.2 四项复核全部在位且绿；③ 装置面失败集合不新增（32/59 两次复跑同读数）。
- **阶段三收口**：已批准计划内无待执行兼容节点，也不存在可复现的兼容型红灯。
- 下一阶段准入需二者之一：(a) 上游新锚点（当前 `origin/main` = `b397e0e` ⇒ 无差异可评，须先有 `> b397e0e` 的 release）；(b) 对挂账四项的解禁裁决——DEBT-040 装载链闭包化闸门、R5 vendored 契约形状漂移登记、M3 闸门负向端到端取证（需上游检出副本）、结案 §5 三处已知失真。能力接入（评估 §6 可选 7 项）另需先补阶段一/二。本节不代替后续阶段开工。

## 10. 阶段四跳过说明（2026-10-29 · 新能力节点接入 · 判定不成立）

> 任务以「上游同步 · 阶段四（新能力节点接入，条件性阶段）」下发。该阶段的成立前提是**已批准计划里存在被裁决「接入」的能力节点**；开工核对的结论是一个都没有，故本阶段**零代码改动**，本节即跳过说明本体，写仓后移交收尾阶段。同类先例见本文 §9（阶段三二次下发时判定「前提已不成立」，同样以单文件 docs 提交入库，提交 `664ec3b`）。

### 10.1 准入核对读数（全部本机实跑）

| 准入条件               | 命令                                                                              | 实测读数                                                                                                                                                                                                | 判定                                                      |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 上游版本锚点与计划一致 | `git -C ../NikkiSync rev-parse HEAD` / `git -C ../NikkiSync tag --points-at HEAD` | `b397e0eb6ca1b4748f13a72f13bb1702a549410e` / `v1.0.27-public-beta.1` ⇒ 与 02 计划首部双锚点（裁决 Q5）**逐字一致**                                                                                      | ✅ 成立                                                   |
| 上游工作区零脏         | `git -C ../NikkiSync status --porcelain \| wc -l`                                 | **0**（本阶段全程未碰 `../NikkiSync`）                                                                                                                                                                  | ✅ 成立                                                   |
| 兼容层已收口且绿灯     | `npx vitest run src/main/nikkisync`                                               | `Test Files 16 passed (16)`；`Tests 282 passed (282)`；**0 skipped**；Duration 23.76s ⇒ 与本文 §9.3 收口复验读数**逐位相同**                                                                            | ✅ 成立（收口未漂移）                                     |
| 装载链闸门             | `npm run verify:nikkisync`                                                        | 13 行全 ✓、`OK (blocking failures: 0)`、exit 0；第 11 项为 `skipped (links already in place; candidate root is irrelevant)` ⇒ 02 计划 §3.2 记载的**受支持语义**，不记为失败                             | ✅ 成立                                                   |
| 本仓工作区洁净         | `git status --porcelain`（HEAD `664ec3b`）                                        | 仅 `?? release-sync/`（10-27 遗存的 `win-unpacked`，非本轮引入，不在 `.gitignore`）                                                                                                                     | ✅ 成立                                                   |
| 待确认项已有明确裁决   | 01 评估 §10.1「阶段二追加的七项默认裁决」＋本文 §7                                | Q-a…Q-g 七项全部按推荐值落账并有执行落点；**无一项为能力接入**                                                                                                                                          | ✅ 成立                                                   |
| 上游是否已出现新锚点   | `git ls-remote origin refs/heads/main`（第 2 次加 `-c http.version=HTTP/1.1`）    | 三次均 `fatal: unable to access 'https://github.com/ToStardust/NikkiSync/': Failed to connect to github.com:443 after 21094/21076/21069 ms: Could not connect to server` ⇒ 本轮**新鲜远端取证 not-run** | ⚠ 不影响判定（见下），替代证据取本文 §9.1 今日读数与 §2.2 |

**not-run 的替代证据与它为什么不影响判定**：本文 §9.1 于今日（同一锚点日）记录 `ls-remote origin refs/heads/main` 与 `HEAD` 两行均为 `b397e0e`、`ls-remote --tags origin` 最新为 `v1.0.27-public-beta.1`；评估 §2.2 记录 fetch 时 `origin/main` 即 `b397e0e`。网络形态与结案 R2 / 评估附录「`github.com:443` 间歇不通、重试才通」一致，属可达性抖动而非离线判据。**但阶段四成立与否只取决于「有无被裁决接入的能力节点」，与上游是否前进无关**——即便真出现新锚点，那也属下一轮阶段一/二的准入（§9.6 原文），不是把本轮阶段四补上。

### 10.2 判定：阶段四不成立（逐条引用裁决条目）

| #   | 出处                                            | 记载的裁决事实（原文要点）                                                                                                                                                                                                                | 对阶段四的含义                                                           |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | 02 计划 §1.1 纳入节点表                         | 纳入节点仅 N0–N5，分类为「收尾（前置）/ 兼容性收敛 / 兼容性收敛 / 兼容性收敛 / 隐私卫生 / 收尾」                                                                                                                                          | 批准计划从未把任何能力节点列为纳入项                                     |
| 2   | 02 计划 §1.2 不做项 第 1 行                     | 「接入 `AccountSyncSettings` 账号作用域（评估 §6#1/#12）」判为「零对应面（可选接入项）」，§7 归入「阶段 4（可选能力接入）」；理由「接入会新增设置键 + UI + 作用域语义，非本轮差异所迫」                                                   | 唯一的强相关能力被显式列为不做                                           |
| 3   | 02 计划 §1.2 不做项 第 2 行                     | 「接入 `DeletionQueue.dismiss()`（#5）、`ExtraScanDirectories.setSource`/来源标注（#6）、`VersionRelease.tentative` 展示口径（#8）」理由「同上，评估 §7『阶段 4』；且 #6 的 `state().directories[].source` 只是契约新增可选键，透传无害」 | 其余三个候选全部同样列为不做                                             |
| 4   | 01 评估 §10.1 Q2（Q1–Q5 全部按建议采纳）        | 「**仅订正文档**，不动 `runtime-facade.ts:548` 行为；四处同源表述加时间限定与豁免理由」                                                                                                                                                   | 跟随 `accounts.revision()` 判据是接入作用域的**前半程**，该半程已被否    |
| 5   | 01 评估 §10.1 Q4                                | 「显式过滤 `sourcePath`/`sourceFolder` ……`sizeBytes`/`*Sha256`/`fullPreviewResourceId`/`mediaFingerprint` **不过滤也不登记**，保持 vendored `AssetSummary` 不扩面」                                                                       | 「不扩声明面」＝不接入；落点 N4 做的是**裁剪**而非暴露                   |
| 6   | 01 评估 §10.1 阶段二追加七项默认裁决（Q-a…Q-g） | Q-a 不重打包、Q-c 登记 DEBT-040、Q-d 不清理无关失真、Q-e 补上游自测取证（结果转为 R12/DEBT-041）、Q-f K8 真机删除尽力取证（已记 not-run）、Q-g 评估入仓                                                                                   | 七项全落账，无一项的内容是「接入某能力」                                 |
| 7   | 05 结案报告 §3 R8 与 §6 第 4 条                 | R8 明写「**本轮未接入新能力**；实测 4 次提交 `core-path-gate` 均跳过」；§6 第 4 条只规定「若产品要接入 `sourcePath`，顺序应是先登记 `src/shared/sync/protocol.ts` 与契约，再撤 `stripAssetPathFields`」                                   | 结案面确认零接入；§6 那条是**未来顺序指引**，不是本轮裁决                |
| 8   | 本文 §9.6 末段                                  | 「能力接入（评估 §6 可选 7 项）另需先补阶段一/二」                                                                                                                                                                                        | 即便今天下发接入裁决，也必须先有独立评估与批准计划，不得直接进阶段三流程 |

**结论**：阶段四在本轮**没有可执行节点**，任务 §1 的跳过分支生效——不改代码、不落红灯、不新增测试、不做计划外架构改动；移交收尾阶段。

### 10.3 代码侧零接入实证（不止引用文档）

| 候选能力（评估 §6 编号）                  | 判据位置 / 命令                                                                                                                                 | 实测事实（本轮取数）                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DeletionQueue.dismiss()`（#5）           | `src/main/nikkisync/runtime-types.ts:150-162`                                                                                                   | `DeletionQueueLike` 仍只声明 `list/decide/approveMany/activity/stop` 五法，无 `dismiss`；:151 注释自陈「五个公开方法逐字对齐上游签名」                                                                                                                                                                                                |
| `ExtraScanDirectories.setSource`（#6）    | `src/main/nikkisync/runtime-types.ts:164-176`                                                                                                   | `ExtraScanDirectoriesLike` 仍只 `state/inspect/add/remove/rescan`，且 `inspect(selected: string)` **未接**上游新增的可选第 2 参；`setSource`/`onSourcesChanged` 在 `src/**` 的命中经逐条甄别为 `mediaStore.setSource`、`ImportWizard` 的 `setSourceDir` 等本仓自有同名异物（与评估 §6#6 的甄别口径一致）                              |
| `AccountSyncSettings` 作用域（#1/#12）    | `grep -rn "AccountSyncSettings" src/ --include="*.ts"`                                                                                          | `src/` 唯一命中 `src/main/nikkisync/runtime-facade.ts:549`，内容是否定式注释「单参构造 `SyncReadRepository` ⇒ 作用域恒 `1=1`，不存在 `accounts.revision()` 取值来源（**不构造 AccountSyncSettings**）」；`sourceGroups(` 零命中                                                                                                       |
| `VersionRelease.tentative` 展示口径（#8） | `grep -rn "tentative" src/ --include="*.ts" --include="*.tsx"`                                                                                  | 仅 `runtime-facade.linked.test.ts:450` 与 `:473` 两处注释，作用是说明 N1 的派生断言为何不可钉「当下时刻」（上游 `uncertainFrom..effectiveAt` 区间返回 `undefined`）；无任何展示面消费 `tentative`                                                                                                                                     |
| `AssetSummary` 新键（#9）                 | `grep -rn "sourceFolder\|thumbnailSha256\|mediaFingerprint\|fullPreviewResourceId" src/shared/sync` → **0 命中**；`src/renderer/**` 仅 1 处命中 | 渲染层唯一命中是 `src/renderer/utils/assetViewModel.ts:11` 的**时点限定注释**（N4 文档订正项，原句保留），非消费代码；其余命中全部位于 N4 的裁剪实现与其守卫用例（`runtime-manager.ts:774`/`:788`、`runtime-manager.test.ts`、`runtime-facade.linked.test.ts`）⇒ 契约面登记的仍是裁剪（`docs/IPC_CONTRACT.md:389-399`），不是新增通道 |

### 10.4 三类测试覆盖为何为空

任务 §3.1 的「红灯先行」挂在**单能力节点标准流程**上，本阶段节点数为 0 ⇒ 不存在被测行为变更，也就没有可写的真实红灯。按本仓纪律（无缺陷/无节点时**不新增测试、不编造假红灯**），本节如实记为 **0 红 / 0 绿 / 0 改**，并以实跑数据反向自证判定与现状自洽：

- `npx vitest run src/main/nikkisync` → `16 files / 282 passed`、**0 skipped**：「未接入任何能力」这一判定没有打红任何既存用例。
- 门控语义按 02 计划 §3.2 三态复核：本机为**已建链开发机**，链接态套件（`runtime-facade.linked` / `sync-server.linked` / `metadata-resolver.linked` / `.isolation` / `probe` / `protocol-drift`）真实执行，`0 skipped` 即证据；`verify:nikkisync` 第 11 项的 `skipped` 是环境态的受支持降级，**未被记成失败**；本阶段不存在常驻用例误挂门控的情形。
- 不新增测试 ⇒ 本阶段无「三类用例（正常/异常/边界）」可交；用例总数坐标沿用 §9.3 已建的基准（域 282、评估同口径合并 331、扩展合并口径 448），下轮直接对照即可。

### 10.5 移交收尾阶段：准入结论与完整变更面清单

| 面                      | 本阶段新增           | 与文档/守卫的对账要求                                                                       |
| ----------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| IPC 通道（新增/改签名） | **0**                | `docs/IPC_CONTRACT.md` 本轮未触碰 ⇒ 无新条目需登记，无「桥暴露面」测试需对账                |
| 配置项 / 设置键白名单   | **0**                | `src/shared/settings-keys.ts` 未触碰 ⇒ 白名单守卫无新增项                                   |
| i18n key                | **0**                | `npm run i18n:guard` 无新增项需对账；读数维持 §6/§9.3（白名单只减不增、key 已同步、exit 0） |
| 模块装载点 / 装配点     | **0**                | `src/main/app/nikkisync-runtime-setup.ts` 与 `runtime-facade.ts` 装载链未触碰               |
| 代码提交                | **0**                | 受保护 glob 命中 0 ⇒ 无需 `// @core-change:`；`core-path-gate` 本阶段仍 `⊘ 跳过`            |
| 文档                    | **1 个文件**（本节） | 收尾阶段可直接引用本节，不必重跑上述取证                                                    |
| 上游                    | **0 改动**           | porcelain 仍为 0（§10.1 第 2 行）                                                           |

**收尾准入结论**：可以进入收尾，且收尾面只剩「登记本节的跳过判定」这一件事——无代码变更面需汇总，无悬空文档需要对账。若收尾要把「阶段四未执行」写进 05 结案报告，请以 §10.2 的八条出处为准，并把 §10.1 末行的 `not-run` 一并带入结案 §4 的 not-run 清单（新条目：上游新鲜远端取证，原因 `github.com:443` 三次不通）。

**阶段四成立的前提**（二者都要先有独立评估与批准计划，不得直接进执行）：

1. (a) 上游出现 `> b397e0e` 的新锚点 ⇒ 那是**新一轮的阶段一/二**，与本轮阶段四是两件事。
2. (b) 用户对评估 §6 可选 7 项（#1/#5/#6/#8 为其中四项）逐项下发**解禁裁决** ⇒ 需另起「02 计划」形态的节点设计（设置键、UI、通道、契约登记、i18n 各面齐备），且接入 #1 时**必须同步**跟随 `GET /v1/changes` 的 `after < accounts.revision()` 判据（01 评估 Q2 的显式条件，本仓 `runtime-facade.ts:551` 目前仍是旧判据）。
