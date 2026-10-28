# 2026-10-28 修复 CI 连续两次失败（依赖审计三条新披露通告：zod / undici / electron）

> 状态：**已执行完毕**（2026-10-28）。五个提交 `e805193` → `127158d` → `2434ffd` → `d2ae917` → `9451efd` → 本节点回写；逐项读数见文末「十一、执行读数」。
> 用户已确认的三项口径：① electron 走「加豁免 + 登记 DEBT-038」，不跨大版本升级；② 本机验证到「静态门 + 全量单测」为止，不打 Windows 包；③ 改完提交并推送 `main` 触发一次真实 CI 复验。

## 一、诊断结论（全部为实测读数，非推测）

### 坏点定位

远端 `QianQianLuLu1/MeowStarMap` 只有 `build.yml` 一条流水线。最近两次运行都红，失败点逐字相同：

| run                          | head_sha   | 结论    | 失败 job / step                                                                           |
| ---------------------------- | ---------- | ------- | ----------------------------------------------------------------------------------------- |
| 22（= 本机 HEAD `df2ab848`） | `df2ab848` | failure | `Lint, Typecheck & Security` / 第 6 步 `Security audit (audit-ci, fail on high/critical)` |
| 21                           | `59b40a42` | failure | 同上、同一步                                                                              |

run 20（`530e9c09`，2026-10-22 12:22Z）为 success；run 18/19 亦 success。更早的 run 8–17 失败已被这三条绿运行作废，本轮不追。

`lint-typecheck` job 的 step 级读数（run 22，共 5 个 job）：

```text
#1  Set up job                                   success
#2  Run actions/checkout@v5                      success
#3  Dependency review (PR only)                  skipped   （push 事件不跑）
#4  Run actions/setup-node@v5                    success
#5  Install dependencies (npm ci --ignore-scripts) success
#6  Security audit (audit-ci, fail on high/critical) FAILURE
#7  Run npm run lint                             skipped
#9  i18n 守卫                                    skipped
#10 Run npm run typecheck                        skipped
#11 Typecheck e2e sources                        skipped
其余 Tech debt / IPC contract check              skipped
→ Test (shard 1..10 / 10) / Coverage Gate / Build & Release (Windows) 三 job 整链 skipped
```

**结论：不能把本轮当成「只有一个坏点」。** 审计步之后的 `npm run lint` / `npm run i18n:guard` / `npm run typecheck` / `npm run typecheck:e2e` 从未在 CI 上取数，`test` / `coverage` / `build` 三个 job 因 `needs: [lint-typecheck]` 整链未跑。本机已实测 `npx eslint .` 退出码 **0**，其余三项须在阶段 B 补验。

### 根因：三条新披露通告撞上未豁免清单

本机复跑与 CI 逐字相同的命令 `npx audit-ci --config ./audit-ci.jsonc` → **退出码 1**，末段原文：

```text
Failed security audit due to high vulnerabilities.
Vulnerable advisories are:
https://github.com/advisories/GHSA-jr5w-w6x2-84p9
https://github.com/advisories/GHSA-mrhx-c7xc-m3w5
https://github.com/advisories/GHSA-xjj6-f33q-929c
```

其余 high/critical 全部命中现有 29 项 allowlist（audit-ci 把它们列在 `Found vulnerable allowlisted advisories`，本轮实测 11 项）。三条未豁免通告的取证：

| GHSA                  | 包       | 漏洞区间                                | first_patched   | published  | 本仓现状                                                                                                                                                              | 可否真修                                   |
| --------------------- | -------- | --------------------------------------- | --------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `GHSA-mrhx-c7xc-m3w5` | zod      | `<4.6.6`                                | 4.6.6           | 2026-10-01 | `package.json` 声明 `^4.4.3`，lock 解析 **4.4.3**（prod 直接依赖，42 个文件 import）                                                                                  | 可：区间内取 4.6.7                         |
| `GHSA-xjj6-f33q-929c` | undici   | `>=6.23.0 <6.29.1` / `>=7.18.0 <7.30.1` | 6.29.1 / 7.30.1 | 2026-10-23 | 两个纯传递节点：`node_modules/undici@7.30.0`（`jsdom@29.1.1` 声明 `^7.25.0`）、`node_modules/node-gyp/node_modules/undici@6.29.0`（`node-gyp@12.4.0` 声明 `^6.25.0`） | 可：均在父包区间内重解析，无需 `overrides` |
| `GHSA-jr5w-w6x2-84p9` | electron | `<42.11.16`（另有 43/44/45 线各自区间） | 42.11.16        | 2026-10-23 | `devDependencies.electron` 精确钉 `41.10.6`；41 线最新只有 `41.10.7`，**41 线无回移补丁**                                                                             | 否（本轮）：需跨大版本 41 → 42             |

### 归因：不是本轮代码改动引入

逐 commit 从 `package-lock.json` 直接取数（`git show <sha>:package-lock.json`），zod 与两条 undici 的版本在 run 20 与 run 22 之间**一字未变**：

```text
530e9c09 => zod=4.4.3 undici=7.30.0 ngypUndici=6.29.0   （run 20，CI 全绿）
5d2408b  => zod=4.4.3 undici=7.30.0 ngypUndici=6.29.0
60cfe96  => zod=4.4.3 undici=7.30.0 ngypUndici=6.29.0
59b40a4  => zod=4.4.3 undici=7.30.0 ngypUndici=6.29.0   （run 21，CI 红）
df2ab84  => zod=4.4.3 undici=7.30.0 ngypUndici=6.29.0   （run 22，CI 红）
```

变的是**通告发布时间**：electron 与 undici 两条 2026-10-23 披露（正好落在 10-22 绿与 10-27 红之间）；zod 那条 10-01 披露、修复版 4.6.6 于 10-11 发布，但直到 10-27 才出现在 npm 审计源的返回里。这解释了「同一条命令、同一份 lock，10-22 绿而 10-27 红」。

### 环境侧既有事实（影响 diff 判定）

- 本机 Node **v26.3.0** / npm **11.16.0**；CI 钉 `.node-version` = `22`。历史上本机 npm 重写 lock 会删掉 ffmpeg-static/ffprobe-static 的 `libc` 字段——该变更已于 `df2ab84` 正式提交，现 lock 里 `"libc"` 计数为 **0**，本轮不再是噪声源；但 npm 版本差异仍可能改写条目顺序，故须做 diff 白名单核对（节点 3 验收 2）。
- 本机 `npm config get registry` = `registry.npmmirror.com`；npmmirror 未实现 `/-/npm/v1/security/*`（见 `docs/troubleshooting-npm-audit-mirror.md`），故 `audit-ci.jsonc` 内置 `"registry": "https://registry.npmjs.org"`，本轮不改这条。
- lock 现状：`node_modules/zod` 的 `resolved` 是 npmmirror 主机，两条 `undici` 是 npmjs 主机（混源）。缺 `integrity` 的条目数 **0**，`lockfileVersion` = 3，`packages` 条目总数 1539。
- 工作树：`git status --porcelain` 仅有未跟踪的 `release-sync/`（打包产物残留，非本轮范围）。

## 二、依赖声明

| 包                      | 现值        | 目标       | 改动位置                      | 安装方式            |
| ----------------------- | ----------- | ---------- | ----------------------------- | ------------------- |
| `zod`                   | lock 4.4.3  | **4.6.7**  | 只改 `package-lock.json`      | `npm update zod`    |
| `undici`（jsdom 侧）    | lock 7.30.0 | **7.30.1** | 只改 `package-lock.json`      | `npm update undici` |
| `undici`（node-gyp 侧） | lock 6.29.0 | **6.29.1** | 只改 `package-lock.json`      | 同上                |
| `electron`              | 41.10.6     | 不动       | `audit-ci.jsonc` allowlist +1 | 无安装动作          |

- **不新增/删除依赖，不改 `package.json` 的版本声明**：`^4.4.3` 已能解析到 4.6.7，把声明抬成 `^4.6.6` 属额外语义变更，本轮不做；防回退由新增的 lock 下限闸门（节点 2）承担。
- **不用 `npm audit fix` / `npm run audit:fix`**：按通告整树批量改，改动面远超这 3 个节点，违反最小化改动。
- **不碰 `overrides`**：两条 undici 都在父包区间内，无需依赖手术（现有 `overrides` 只有 `http-cache-semantics` / `source-map-js`，本轮保持不动）。

## 三、启动与验证说明

```bash
npm run audit                                                  # 复现 CI 第 6 步（须官方源可达）
npx vitest run scripts/__tests__/lock-advisory-floor.test.ts   # 本轮新增回归闸门
npm run link:nikkisync && npm run link:nikkisync:check         # 任何 npm install/update 之后重建 4 条 junction
```

- 所有 `npm update` 一律带 `--registry=https://registry.npmjs.org`，避免把新写入的 `resolved` 主机统一改写成镜像源而放大 lock diff。带该 flag 后 `zod` 一行的主机将由 npmmirror 变为 npmjs，这一行变化在提交信息里点名。
- 长耗时步骤（全量 `npm test` / `test:coverage`）用后台任务跑时，判定成败须读日志内层退出码，不信通知摘要。

## 四、错误处理与兜底

| 异常分支                                            | 判据                                                                                                                         | 兜底动作                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm update` 产生预期外 diff                        | `git diff -U0 -- package-lock.json` 出现非 `version/resolved/integrity` 的变化行，或 `lockfileVersion` 变化                  | `git checkout HEAD -- package-lock.json`（**只还原这一个文件**），改走备选路径：`npm view <pkg>@<ver> dist.integrity dist.tarball` 取数后外科式改 3 个节点，再 `npm install --package-lock-only` 要求其再解析幂等（不再产生新 diff 即自证一致） |
| `npm ci --dry-run --ignore-scripts` 非 0            | 退出码                                                                                                                       | lock 形态被写坏，还原后走备选路径重做；**不得推送**                                                                                                                                                                                             |
| zod 4.4.3 → 4.6.7 引发行为回归                      | `npm test` / `npm run typecheck` 出现新红                                                                                    | 定位到具体 schema 后按红-绿补测试；**不得**把 zod 也塞进豁免清单来消红                                                                                                                                                                          |
| `npm install/update` 静默拆掉 `@nikkisync` junction | `npm run link:nikkisync:check` 报缺链                                                                                        | `npm run link:nikkisync` 重建，再复跑 `npm run verify:nikkisync`                                                                                                                                                                                |
| 新文档未 `git add` 就被 tracked 文档引用            | `npm run docs:links` 死引用 > 0（`scripts/__tests__/check-md-links.test.ts` 用 `git ls-files` 判存在，不用 `fs.existsSync`） | 与引用它的改动同批 `git add`；注意反过来的坑：**文件在 tracked 之前不会被扫描**，本文档自身就在提交后被该测试打回一处错路径                                                                                                                     |
| 推送后审计步之后新出红 step                         | job/step 级 conclusion（日志正文需鉴权，本机取不到）                                                                         | 复现该 step 的本机等价命令 → 定位 → 回到对应节点补修，不留到下一轮                                                                                                                                                                              |
| 本机不可复现的 step                                 | PR-only（dependency-review / commitlint / IPC 契约同步）与 Windows-only（build / dist:win / e2e:smoke / e2e:perf）           | 在交付汇报里显式记为「未本机验证」，不写成已验                                                                                                                                                                                                  |

日志纪律：每个节点的提交信息记实测读数原文——audit-ci 退出码、`Vulnerable advisories are:` 条目数、`Found vulnerable allowlisted advisories` 计数、`git diff --numstat`、`npm test` 的 `Test Files / Tests` 汇总行。

## 五、参数校验（新增回归闸门自带）

- 输入只有 `package-lock.json`（`readFileSync` + `JSON.parse`），**不联网**，CI 与离线环境同语义。
- 表行 `LockFloorRow = { lockPath, minVersion, advisory, reason }`：
  - `lockPath`：`packages` 的键（如 `node_modules/node-gyp/node_modules/undici`）。**不存在即失败**，绝不静默跳过——防依赖树 dedupe 后测试变恒真。
  - `minVersion`：`X.Y.Z` 三段纯数字，不合法即抛错。
  - `advisory`：须匹配 `/^GHSA(-[a-z0-9]{4}){3}$/`，与 `scripts/__tests__/audit-config.test.ts` 的 `GHSA_PATTERN` 同标准。
- 自研 `compareSemver(a, b)`：非法输入抛错，预发布按保守序处理。**不 import `semver`**——它只是传递依赖、未在 `package.json` 声明，CI 的 `npm ci --ignore-scripts` 下形状不稳。
- 互斥断言：`row.advisory` 不得同时出现在 `audit-ci.jsonc` 的 `allowlist` 里（防「为了让测试绿而把可修复的通告塞进豁免清单」）。
- 规模上限：`LOCK_FLOORS.length <= 6`（防这张表长成第二份豁免清单）。

## 六、基础测试用例（`scripts/__tests__/lock-advisory-floor.test.ts`，新建）

| 类别 | 用例                                                      | 修复前 → 修复后                 |
| ---- | --------------------------------------------------------- | ------------------------------- |
| 正常 | 三个 lockPath 在 lock 中都存在                            | 通过 → 通过                     |
| 正常 | 各节点解析版本 ≥ `minVersion`（4.6.6 / 7.30.1 / 6.29.1）  | **失败（本轮红灯来源）** → 通过 |
| 正常 | `compareSemver`：等值 / 三段序 / 预发布 / 补零            | 通过 → 通过                     |
| 异常 | `compareSemver` 收到非法输入 → 抛错                       | 通过 → 通过                     |
| 异常 | floor 表的 advisory 出现在 allowlist → 失败并提示二者互斥 | 通过 → 通过                     |
| 异常 | lockPath 不存在 → 失败（不静默）                          | 通过 → 通过                     |
| 边界 | `LOCK_FLOORS.length <= 6`、advisory 逐行唯一              | 通过 → 通过                     |

脚手架用例（纯函数 / 异常 / 边界）在修复前后都必须绿，使「红灯只可能来自 lock 数据本身」成为可判定结论，而不是测试自己写坏了。

落点取舍：**新建同目录套件**，不扩写 `scripts/__tests__/audit-config.test.ts`——后者身份是「四处配置一致性契约」（audit-ci.jsonc / package.json / build.yml / .npmrc），输入是配置文本；而 DEBT-020 与 DEBT-034 的关闭证据把它钉成「19 例全通过」，往里加例数会让历史读数不可复现。

撤销条件（测试文件头注释 + DEBT-038 正文两处都写）：当 `package.json` 的 `dependencies.zod` 抬到 `^4.6.6` 及以上，或上游把 `jsdom` / `node-gyp` 的 undici 区间抬过修复版且 lock 里对应节点消失 ⇒ 删除该行并复跑本套件。

## 七、实施节点（一节点一提交，Conventional Commits）

推进方式：**阶段 A 只落仓本计划文档并提交，随后停下等用户读过；用户确认后才开始阶段 B。**

### 阶段 A

#### 节点 0 / 1｜计划落仓（本文件）

- 修改文件：`docs/plans/2026-10-28-fix-ci-audit-vulnerable-floors.md`（本文件，仅此一个）
- 输入：上文取证读数；输出：一个只含该文档的提交
- 本阶段不改代码、不动 lock、不动 `audit-ci.jsonc`
- 验收：`npm run docs:links` 死引用 0；`npx vitest run scripts/__tests__/source-encoding.test.ts` 全绿（UTF-8 无 BOM + LF）；`npm run verify` 各步无不适用失败
- 提交：`docs(plans): 记录 CI 审计三条新披露的取证与处置计划`

### 阶段 B

#### 节点 2｜新增回归闸门（必须真红）

- 修改文件：`scripts/__tests__/lock-advisory-floor.test.ts`（新建）、`scripts/AGENTS.md`（`__tests__/` 表加一行，沿用其既有表格格式）
- 输入：`package-lock.json`（只读）；输出：3 条版本下限断言失败、其余用例通过的读数
- 验收：`npx vitest run scripts/__tests__/lock-advisory-floor.test.ts` → **退出码 1，失败恰好 3 例**；`npx vitest run scripts/__tests__/audit-config.test.ts` → 19 例全绿；`npm run typecheck` → 0；`npm run lint` → 0
- 提交：`test(deps): 为 lock 解析版本建立防回归闸门（修复前红灯取证）`

#### 节点 3｜lock 手术：zod + undici ×2

- 修改文件：`package-lock.json`（唯一受跟踪改动）
- 命令序列：
  1. `npm update zod undici --package-lock-only --no-audit --no-fund --registry=https://registry.npmjs.org`
  2. diff 白名单核对（合格才继续；不合格走 §四 备选路径）
  3. 去掉 `--package-lock-only` 真跑一次，使 `node_modules` 与 lock 同步
  4. `npm ci --dry-run --ignore-scripts`
  5. `npm run link:nikkisync` + `npm run link:nikkisync:check`
- 输出：`node_modules/zod` = 4.6.7、`node_modules/undici` = 7.30.1、`node_modules/node-gyp/node_modules/undici` = 6.29.1
- 验收：
  1. `npx vitest run scripts/__tests__/lock-advisory-floor.test.ts` → 退出码 **0**（同一测试、零断言改动，红转绿）
  2. `git diff -U0 -- package-lock.json` 变化行只含 `version` / `resolved` / `integrity`；`lockfileVersion` 行 0 变化；条目总数仍 1539；缺 `integrity` 条目仍 0
  3. `npm ci --dry-run --ignore-scripts` → 退出码 0（CI 的 npm 10 能吃这份 lock 的离线替身）
  4. `npm run audit` → **仍退出码 1，但 `Vulnerable advisories are:` 只剩 electron 1 条**（不许为凑 0 顺手加豁免）
  5. `npm test` 全量 → 全绿（重点：42 处 zod import 与 IPC 校验行为无损）
  6. `npm run link:nikkisync:check` → 4 条 junction 在位
- 提交：`fix(deps): 把 zod 与 undici 重解析到已修复版本，清除 GHSA-mrhx-c7xc-m3w5 与 GHSA-xjj6-f33q-929c`

#### 节点 4｜electron 通告豁免 + DEBT-038 登记（用户已授权放宽）

- 修改文件：`audit-ci.jsonc`（allowlist +1，注释块续写理由 / 跟踪归属 / 撤销条件）、`docs/debt-registry.json`（新增 DEBT-038：`category: supply-chain`、`status: open`、`priority: medium`、`files: [package.json, package-lock.json, audit-ci.jsonc]`）、`docs/技术债清单.md`（§0 索引表加一行 + 新开 `## 16.` 章节；**不改 §9 / §10 历史原文**）
- 必写事实：41 线最新只到 41.10.7，而区间是 `<42.11.16` ⇒ **「升到 41 线最新」是无效动作**，须写进条目以免后来人误关；本仓是否实际发起依赖 eMudhra 链的出站 TLS **本轮未取证**，暴露面按「待评估」记账，不得写成「不影响」。
- 验收：`npx audit-ci --config ./audit-ci.jsonc` → 退出码 **0**，末行 `Passed npm security audit.`；allowlist 计数 **29 → 30**、`Found vulnerable allowlisted advisories` **11 → 12**；`npx vitest run scripts/__tests__/audit-config.test.ts` → 19 例全绿（子集断言，无需改 `MIGRATION_BASELINE`）；`.github/workflows/build.yml` 未被改动
- 提交：`chore(audit): 豁免 GHSA-jr5w-w6x2-84p9 并登记 DEBT-038（electron 41 线无回移补丁）`

#### 节点 5｜文档读数回写

- 修改文件：`ARCHITECTURE.md` 与 `ARCHITECTURE.en.md` 的测试规模读数行（双语同改，取本轮 `npm test` 实跑原文；现记「450 文件 = src 420 + scripts 26 + e2e 4」，实测 `e2e/**/*.test.ts` 已有 5 个，以实跑汇总为准回写）；`CHANGELOG.md`（在既有 `## [2.5.6-beta] - 2026-10-27` 节内补录一行；**严禁写进 `## [Unreleased]`**——该节有列表项会让 `scripts/check-changelog-release.ts` 直接把 `pre-dist-check` / `dist:win` 打死）；复核 `scripts/AGENTS.md` 计数
- 验收：`npx tsx scripts/check-changelog-release.ts` → 0；`npx tsx scripts/check-doc-versions.ts` → 0（本轮不动 Electron 版本徽章，应零改动通过）；`npm run docs:links` → 死引用 0
- 提交：`docs(architecture): 回写本轮测试规模读数与依赖修复补录`

#### 节点 6｜全量门禁复跑 + 推送复验

见 §八；全绿后 `git push origin main`（已授权），随后用 `curl --ssl-no-revoke` 拉 `/actions/runs` 与 `/jobs`，盯新 run 的 job/step 结论；审计步之后若新出红，本轮继续定位修复。

## 八、收尾全量门禁（本机必须全绿）

与 CI 的 `lint-typecheck` / `test` / `coverage` 三个 job 同语义：

```bash
npm run lint            # 已实测 0；新增文件后复跑
npm run i18n:guard      # 审计之后从未在 CI 取数 ⇒ 本轮首次取数
npm run typecheck       # tsc -b + tsc -p tsconfig.scripts.json
npm run typecheck:e2e   # e2e/** 落在 typecheck 两个覆盖面之外
npm test                # 全量；skip 数不得上升（禁止新增 skip）
npm run test:ci-linux   # CI test job 在 ubuntu 上的宿主语义替身
npm run test:coverage   # 阈值门 statements 66 / branches 58 / functions 59 / lines 68
npm run docs:links
npm run verify          # 只读整合闸门（typecheck + eslint 无 --fix + core-gate + prettier --check + 相关单测）
npm run audit           # 最终必须 exit 0
```

本机不跑、如实记账为「仅 CI / Windows job 能验」的：`npm run build`（干净克隆主进程编译）、`npm run dist:win`、`npm run e2e:smoke`、`npm run e2e:perf`，以及 PR-only 的 dependency-review / commitlint / IPC 契约同步检查（本轮按历史惯例直推 `main`，这几层不会触发）。

## 九、明确不做

- 不升 electron。41 → 42 跨大版本需重建 better-sqlite3 的原生 ABI、同步 `README.md` 三处 Electron 版本徽章与 `scripts/check-doc-versions.ts` 闸门、并重固化 `e2e/perf-baseline.json`；按 DEBT-020（40 → 41）先例应立独立专项，不与本轮混装。
- 不清退 `audit-ci.jsonc` 中已不再命中的失效豁免（本轮实测有 18 条落在 `Consider not allowlisting advisories`）。清退属收紧闸门且须同步改 `MIGRATION_BASELINE` 数组，DEBT-020 / DEBT-034 均已把该遗留记为独立一轮。
- 不改 `package.json` 的依赖声明、`overrides`、`.github/workflows/build.yml`、`vitest.config.ts` 阈值；不 skip / 弱化 / 删除任何测试；不为凑提交而虚构改动。

## 十、关键文件

- `package-lock.json` — 唯一生产物改动（3 个节点：`node_modules/zod`、`node_modules/undici`、`node_modules/node-gyp/node_modules/undici`）
- `audit-ci.jsonc` — 豁免清单唯一事实来源（`scripts/__tests__/audit-config.test.ts` 对其取 28 项子集断言）
- `scripts/__tests__/audit-config.test.ts` — 新增套件的写法模板；本轮不改它
- `scripts/__tests__/lock-advisory-floor.test.ts` — 本轮新建的 lock 下限闸门（已落仓）
- `docs/技术债清单.md` + `docs/debt-registry.json` — DEBT-038 登记（登记前 37 项，登记后 38 项）
- `.github/workflows/build.yml` — 失败 step 所在 job 的编排（本轮不改动）

---

## 十一、执行读数（2026-10-28，逐项实测）

### 提交序列

| 提交       | 节点 | 内容                                                                                            |
| ---------- | ---- | ----------------------------------------------------------------------------------------------- |
| `e805193`  | 1    | 本计划文档落仓（仅此一个文件）                                                                  |
| `127158d`  | 2    | `scripts/__tests__/lock-advisory-floor.test.ts` + `scripts/AGENTS.md`（**红灯取证**）           |
| `2434ffd`  | 2 补 | 订正本文档一处错误路径（全量 `npm test` 打回，见下「计划自身缺陷」）                            |
| `d2ae917`  | 3    | `package-lock.json` 9 增 9 删：zod 4.4.3→4.6.7、undici 7.30.0→7.30.1、node-gyp 侧 6.29.0→6.29.1 |
| `9451efd`  | 4    | `audit-ci.jsonc` 豁免 + `docs/debt-registry.json` DEBT-038 + `docs/技术债清单.md` §0/§16        |
| （本提交） | 5    | `CHANGELOG.md` 补录 + `ARCHITECTURE.md` / `ARCHITECTURE.en.md` 读数回写 + 本文档执行读数        |

### 红 → 绿闭环

- 修复前：`npx vitest run scripts/__tests__/lock-advisory-floor.test.ts` → `Tests 3 failed | 16 passed (19)`，退出码 **1**；三条失败恰为 zod / undici / node-gyp-undici 的版本下限断言，失败消息自带当前版本与下限（`node_modules/zod 当前 4.4.3，未达 … 4.6.6`），脚手架用例（`compareSemver`、合成数据、边界）全部通过 ⇒ 红灯归因于 lock 数据本身。
- 修复后：同一命令、**零断言改动** → `Tests 19 passed (19)`，退出码 **0**。

### lock 手术取证

- `git diff --numstat`：**9 增 9 删**；变化行类型白名单核对（只允许 `version` / `resolved` / `integrity`）不合规行数 **0**；`lockfileVersion` 行改动 **0**。
- 结构不变量：`packages` 条目 **1539**（改前同值）；缺 `integrity` 的条目 **0**（改前同值）。
- `npm ci --dry-run --ignore-scripts` 退出码 **0**（CI 的 npm 10 可消费同一份 lock 的离线替身）。
- 意外与恢复：`npm update` 输出「removed 4 packages」正是已知的 `@nikkisync` 4 条 junction 被静默拆除；`npm run link:nikkisync` 重建后 `:check` 报 `check OK (all four links in place)`。
- `zod` 的 `resolved` 主机由 npmmirror 变为 npmjs（`--registry` 官方源所致），已按计划点名。

### 安全审计状态（不自评，按输出原文判读）

| 阶段              | 退出码 | 输出末行                                             | 未豁免集合                      |
| ----------------- | ------ | ---------------------------------------------------- | ------------------------------- |
| 修复前（复现 CI） | 1      | `Failed security audit due to high vulnerabilities.` | 3 条（zod / undici / electron） |
| 节点 3 之后       | 1      | 同上                                                 | 1 条（仅 electron）             |
| 节点 4 之后       | **0**  | **`Passed npm security audit.`**                     | 0 条                            |

allowlist **29 → 30**；`Found vulnerable allowlisted advisories` **10 → 11**；`Consider not allowlisting advisories` 仍 **19** 项（失效豁免清退留待独立一轮）。

### 收尾全量门禁（本机）

| 命令                                         | 读数                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `npm test`                                   | `Test Files 452 passed (452)`、`Tests 7045 passed \| 12 skipped (7057)`，54.93s，退出码 0     |
| `npm run lint`                               | 退出码 0（`eslint .` 无任何输出）                                                             |
| `npm run typecheck`                          | 退出码 0（`tsc -b` + `tsc -p tsconfig.scripts.json`）                                         |
| `npm run typecheck:e2e`                      | 退出码 0                                                                                      |
| `npm run i18n:guard`                         | 退出码 0（白名单只减不增 / 清零必移除 / key 已同步）                                          |
| `npx tsx scripts/check-changelog-release.ts` | 退出码 0（14 个版本节，`2.5.6-beta` 唯一，`[Unreleased]` 已收口）                             |
| `npx tsx scripts/check-doc-versions.ts`      | 退出码 0（README 三处 Electron 仍 41.10，与 `package.json` 一致——本轮未动 electron）          |
| `npm run docs:links`                         | 死引用 0（175 处提醒均为既有「本机留存区/已交代去向」路径）                                   |
| `npm run debt:check`                         | 退出码 0，正确点名 DEBT-038 涉及本次变更的 `package-lock.json` / `audit-ci.jsonc`（预期提醒） |
| `npm run verify:nikkisync`                   | 4 条 junction 在位（`link:nikkisync:check` OK）                                               |

规模读数闭合：上一快照 450 / 7021 + 12（2026-10-27）→ 本轮 452 / 7045 + 12。+2 文件 = 本轮新增 `lock-advisory-floor.test.ts`（+19 例）与 `60cfe96`（2026-10-27）新增但被上一快照静态构成漏计的 `e2e/__tests__/launch-env.test.ts`（+5 例）；7021 + 19 + 5 = 7045 逐项对上，**没有任何既有用例被吞或跳过**（skip 数 12 未变）。

### 计划自身缺陷（如实记账）

节点 1 落仓的本文档把 check-md-links 套件写成少一层 `__tests__` 目录的形式（正确路径是 `scripts/__tests__/check-md-links.test.ts`），被全量 `npm test` 的「真实仓库契约：被跟踪文档不留死引用」用例打回（`发现 1 处死引用`）。值得记的机制是：`check-md-links` 的扫描集取 `git ls-files`，**文件在 tracked 之前不会被扫**——所以节点 1 当时裸跑 `npm run docs:links` 是绿的，提交进 tracked 集之后才红。已在 `2434ffd` 修正，并把这条反向坑补进 §四。

### 本机未验（不写成已验）

`npm run build`（干净克隆主进程编译）、`npm run dist:win`、`npm run e2e:smoke`、`npm run e2e:perf` 只有 Windows job 能验，按用户选择本轮不跑；PR-only 的 dependency-review / commitlint / IPC 契约同步检查因直推 `main` 不触发。这四层的首次真实读数由推送后的 CI 运行给出。
