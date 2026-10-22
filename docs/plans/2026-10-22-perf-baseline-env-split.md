# 2026-10-22 性能基线按运行环境分设 dev / ci 两段

> 承接 `docs/plans/2026-10-21-fix-ci-smoke-timeout-and-clear-warnings.md` §10.11 的远端验证补录：那一轮把冒烟红点收口后，障碍下移到 step 10 性能基准回归。本轮处理该障碍，并把 §10.11 一并入库。

## 1. Context

run `39623462678`（head `7c6926f`，build job id `119304554037`）里，`.github/workflows/build.yml:217` 的「Performance baseline regression」（GitHub 侧编号 step 10）历史上首次被执行，随即以 3 条**相对回归**违规判红（断言点 `e2e/perf.e2e.ts:416`）。同一份打包产物在开发机当日 `npm run e2e:perf` 判定「✓ 全部通过」，且 CI 上三条**绝对硬护栏**全部通过（`maxMs` 30000/60000、`minThroughput` 100）⇒ 产品性能契约未破，破的是比较口径。

根因（已实证，非推断）：`e2e/perf-baseline.json` 是**开发机单次读数**，却被逐字套在 `windows-latest` 上；`PerfBaseline.environment`（`e2e/perf-helpers.ts:94`）是自由文本且**只写不读**，没有任何代码按环境选段。本轮从 CI 产物取到的两份报告 `platform` 均为 `win32-x64`、node `v22.23.3`，与开发机字面相同 ⇒ 平台串无法区分环境，必须显式按 CI 信号选段。这与本仓已收口的「宿主语义漂移」同族，只是发生在性能维度。

目标：`evaluateSamples` 依运行环境选段，使**比较对象与被测环境一致**；两个环境各自保留回归发现能力，**任何一方都不放宽**。

## 2. 已确认决策

| 决策      | 内容                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI 段取值 | 先用真 CI 读数播种 `status: "provisional"`（相对判定立即按 CI 硬件生效，`regressionFactor` 沿用 dev 段不放宽），补样到 ≥3 后取中位数改 `status: "final"`         |
| 回流通道  | `build.yml` 新增 `if: always()` 一步，把 `.cache/perf/latest.json` 的读数打成 `::notice title=perf-readings::` 注解（免鉴权 annotations 接口可读，绿态也能取数） |
| 采样次数  | **不改** `perf.e2e.ts` 的单次采样，靠跨运行多次采样压噪声                                                                                                        |

禁止项（沿用 `docs/CODING_CONVENTIONS.md` §6 与本轮约束）：放宽 `regressionFactor`、CI 上关掉相对判定、`it.skip`、调低阈值、伪造或弱化失败结果。

## 3. 依赖声明

**零新增依赖。** 复用仓内既有件：

| 需要                      | 来源                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 执行 TS 脚本              | `tsx`（`scripts/` 统一执行方式，见 `scripts/AGENTS.md`）                                                                                                                                                                  |
| 解析 build.yml 做契约测试 | `yaml`（`scripts/__tests__/ci-action-runtime.test.ts:5` 在用）                                                                                                                                                            |
| 中位数语义                | `e2e/perf-helpers.ts:146` `median()`；固化脚本按该文件既有惯例（自带局部 interface）**内联同款 3 行**，不跨目录 import `e2e/`——`tsconfig.scripts.json` 只 include `scripts/**`，且 `perf-helpers.ts` 顶层读 `process.env` |
| CI 步骤契约守卫           | `scripts/__tests__/ci-action-runtime.test.ts`（只看带 `uses` 的 step）、`scripts/__tests__/audit-config.test.ts`（build.yml 字符串契约，需回归）                                                                          |
| 失败自报注解              | `e2e/playwright.config.ts:26` 的 Playwright `github` reporter                                                                                                                                                             |

安装方式不变（`npm ci`），不新增 `.npmrc` 项，不新增 `.gitattributes`。

## 4. 设计

### 4.1 基线 v2（绝对护栏全局共享，相对基线按环境分段）

```jsonc
{
  "version": 2,
  "datasetImages": 1500,
  "hardRules": {
    // 8 条，逐字取自 v1 的 maxMs / minThroughput
    "cold-start-first-paint": { "maxMs": 15000 },
    "scan-ingest": { "maxMs": 30000 },
    "scan-throughput": { "minThroughput": 150 },
    "media-list-page100": { "maxMs": 1000 },
    "media-list-page500": { "maxMs": 1000 }, // 保留 v1 事实：覆盖 DEFAULT_HARD_RULES 的 3000
    "find-duplicates": { "maxMs": 60000 },
    "find-duplicates-throughput": { "minThroughput": 100 },
    "cache-get-stats": { "maxMs": 1000 }
  },
  "environments": {
    "dev": {
      "recordedAt": "2026-08-23T14:59:05.625Z",
      "environment": "win32-x64（本地开发机实测）",
      "status": "final",
      "sampleCount": 1,
      "sourceRuns": ["perf-run-2026-08-23T14-59-05-625Z"],
      "metrics": {/* 8 条 baselineValue + regressionFactor 逐字照搬 v1 */}
    },
    "ci": {
      "recordedAt": "2026-10-21T15:21:36.367Z",
      "environment": "windows-latest（GitHub Actions，Windows Server 2025 / runner 2.330.0 / node v22.23.3）",
      "status": "provisional",
      "sampleCount": 2,
      "sourceRuns": [
        "39623462678#perf-run-2026-10-21T15-21-17-943Z",
        "39623462678#perf-run-2026-10-21T15-21-36-367Z"
      ],
      "metrics": {/* 下表「两次中位数」列；regressionFactor 照搬 dev 段同项 */}
    }
  }
}
```

硬要求：`hardRules` 与 dev 段相对值必须与 v1 **逐字相等**（开发机判定既没放宽也没收紧）；`environments.ci.metrics[*].regressionFactor` **必须逐项等于 dev 段**；`thumbnail-generate-p50/p95`、`first-thumbnail-visible` 不进 `hardRules`（v1 无条目 ⇒ 继续落 `DEFAULT_HARD_RULES`，与今天一致）；**不写 v1→v2 迁移代码**（仓库约定不做兼容垫片），`loadBaseline()` 改为校验 `version === 2` 且 `hardRules`/`environments` 为对象，否则走既有「stdout 告警 + 返回 `null`」降级分支。

### 4.2 播种依据（真 CI 读数，原始精度）

| 指标                         | CI pass1  | CI pass2  | 两次中位数       | 离散度 | dev 段值（不动） |
| ---------------------------- | --------- | --------- | ---------------- | ------ | ---------------- |
| `cold-start-first-paint`     | 1692.9402 | 1839.7084 | **1766.32**      | 8.7%   | 2106.52          |
| `scan-ingest`                | 1945.9098 | 1900.3672 | **1923.14**      | 2.4%   | 414.29           |
| `scan-throughput`            | 770.85    | 789.32    | **780.09**       | 2.4%   | 3620.64          |
| `media-list-page100`         | 11.1000   | 12.4000   | **11.75**        | 11.7%  | 7.8              |
| `media-list-page500`         | 29.6000   | 22.7000   | **26.15**        | 30.4%  | 10.3             |
| `find-duplicates`            | 5642.3720 | 6906.1963 | **6274.28**      | 22.4%  | 1010.27          |
| `find-duplicates-throughput` | 265.85    | 217.2     | **241.53**       | 22.4%  | 1484.75          |
| `cache-get-stats`            | 1.7000    | 2.4000    | **2.05**         | 41.2%  | 0.7              |
| `thumbnail-generate-p50`     | 3.1       | 5.1       | 观察项（无基线） | 64.5%  | —                |
| `thumbnail-generate-p95`     | 5.4       | 27.1      | 仅硬护栏 8000    | 401.9% | —                |
| `first-thumbnail-visible`    | 513.4359  | 865.0233  | 仅硬护栏 15000   | 68.5%  | —                |

两份读数的来源与独立性：run `39623462678` 因 `e2e/playwright.config.ts:19` 的 `retries: process.env.CI ? 1 : 0`，`describe.serial` 套件整链重跑一次，产物里留下 15:21:17 与 15:21:36 两份 `perf-run-*.json`（step 总耗时 37s）。**注意**：成功运行不会重跑 ⇒ 一次绿运行只产 1 份样本；且这两份来自同一 runner 实例，共享 warm 磁盘缓存，非完全独立 ⇒ 第 3 份必须来自另一次运行。

幂等自检（播种后这两份读数必须 0 违规）：`scan-ingest` 上限 1923.14×3=5769>1946 ✓；`find-duplicates` 6274.28×3=18823>6906 ✓；`find-duplicates-throughput` 下限 241.53÷3=80.5 < 硬护栏 100 ⇒ 硬护栏主导，217.2>100 ✓；`cold-start` 5299>1840 ✓；`scan-throughput` 下限 156.0（硬护栏 150）✓；`page100` 117.5>12.4 ✓；`page500` 261.5>29.6 ✓；`cache` 102.5>2.4 ✓。

### 4.3 环境键与判定

```ts
export type PerfEnvKey = 'dev' | 'ci'
export function resolvePerfEnv(env: NodeJS.ProcessEnv = process.env): PerfEnvKey {
  if (env.PERF_ENV === 'ci') return 'ci'
  if (env.PERF_ENV === 'dev') return 'dev'
  // 不信裸 CI：开发机 shell/IDE 也可能带 CI=true，选错段等于悄悄换比较口径
  return env.GITHUB_ACTIONS === 'true' || env.RUNNER_ENVIRONMENT === 'github-hosted' ? 'ci' : 'dev'
}
```

`evaluateSamples(samples, baseline, envKey)` 第三参数**必填**（默认参数会在 vitest 里继承宿主信号，判定随环境漂移）。调用点唯一：`e2e/perf.e2e.ts:394`（`perf-real.e2e.ts` 只 import `countLogPattern`/`logLineKey`，不受影响）。

1. 绝对规则：`hardRule = baseline?.hardRules?.[id] ?? DEFAULT_HARD_RULES[id] ?? {}` —— 与 v1 的 `??` 整对象替换等价。
2. 相对规则：取自所选段 `environments[envKey].metrics[id]`，仍受 `datasetMatches`（全局 `datasetImages === DATASET_SIZE`）约束。
3. 所选段缺失 ⇒ 追加一条 `kind: 'missing_section'` 违规（每次运行一条，不静默退化为「只跑硬护栏」）；`status: 'provisional'` **照常参与相对判定**（播种不是关闭）。

### 4.4 报告、固化脚本、注解通道

- `PerfRunReport` 增必填 `perfEnv: PerfEnvKey`；`e2e/perf.e2e.ts` 的 P10 report（`:395-403`）与 `afterAll` 部分报告（`:83-91`）都写入；`printPerfSummary` 增一行 `环境段: ci (provisional, 2 样) | 数据集: 1500`。
- `scripts/perf-test/save-perf-baseline.ts`：新增 `--env <dev|ci>`、`--samples <f1> <f2> …`（缺省退回 `latest.json` 单文件）；导出纯函数 `aggregateSamples(reports)`（按指标跨报告取中位数）与 `planSection(...)`；只写所选段，`hardRules` 与另一段原样保留；`regressionFactor` 沿用旧值；闸门见 §6。
- 新脚本 `scripts/perf-test/emit-perf-readings.ts`：导出纯函数 `buildPerfReadingsAnnotation(report)` → 单行 `::notice title=perf-readings env=ci,status=provisional,samples=2::scan-ingest=1900;…`；`main()` 读 `.cache/perf/latest.json`。`package.json` 加 `"perf:readings": "tsx scripts/perf-test/emit-perf-readings.ts"`。
- `build.yml`：在 `Performance baseline regression` 之后、`Upload perf results` 之前插入 `if: always()` 的一步跑 `npm run perf:readings`。

## 5. 启动说明（环境准备 / 命令 / 验证方式）

```bash
# 前置：确认 HEAD 绿，避免红灯信号失真
npm run i18n:check
npx vitest run e2e/__tests__ scripts/__tests__/ci-action-runtime.test.ts scripts/__tests__/audit-config.test.ts

# 逐节点：新守卫必须手动指名跑（只改 JSON/文档时本地闸门零测试）
npx vitest run e2e/__tests__/perf-baseline-env.test.ts scripts/__tests__/save-perf-baseline.test.ts scripts/__tests__/emit-perf-readings.test.ts

# 本地实跑（预期 dev 段仍「✓ 全部通过」）
npm run e2e:perf
npm run perf:readings
npm run perf:save-baseline -- --env dev --dry-run
npm run perf:save-baseline -- --env ci --samples .cache/perf/ci-39623462678/perf-run-2026-10-21T15-21-17-943Z.json .cache/perf/ci-39623462678/perf-run-2026-10-21T15-21-36-367Z.json --dry-run

# 远端复验（免鉴权）
# GET /repos/QianQianLuLu1/MeowStarMap/actions/runs/{run}/jobs            → step 结论与时长
# GET /repos/QianQianLuLu1/MeowStarMap/check-runs/{jobId}/annotations     → perf-readings 注解正文
```

全量收口（全部节点后必跑，不得有新增失败项）：`npm run verify`、`npm run typecheck`、`npm run typecheck:e2e`、`npm run lint`、`npm run i18n:guard`、`npm test`、`npm run test:coverage`、`npm run docs:links`。

## 6. 错误处理（异常分支 / 兜底 / 日志输出）

| 分支                                                                  | 行为（必须可观察，不静默）                                                                                                                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 基线文件缺失 / JSON 解析失败 / `version !== 2` / 结构不合             | 沿用 `loadBaseline` 既有降级：stdout `[perf] 警告：基线文件解析失败，本次仅执行绝对阈值判定：…` + 返回 `null`（⇒ 只跑 `DEFAULT_HARD_RULES`）；**新增**：结构校验失败与段缺失都要在 `printPerfSummary` 显式成行 |
| 所选环境段缺失                                                        | `evaluateSamples` 追加 `kind: 'missing_section'` 违规 ⇒ P10 判红，消息内写明补齐命令                                                                                                                           |
| `--env ci` 样本数 `<3`                                                | 写入 `status: "provisional"` 并 stdout 打印「ci 段样本数 N<3，标记 provisional，待补样」；显式要求 `final` 时退出码 1 并给出补样命令                                                                           |
| `--samples` 指向的文件不存在 / 非 `PerfRunReport` 形态 / 无 `samples` | stderr 逐项报因 + 退出码 1（与脚本现有「未找到 latest.json」同风格）                                                                                                                                           |
| 多样报告里指标 id 不一致                                              | 以并集聚合；某 id 样本不足时 dry-run 表标 `（样本不足）`，段状态按最小样本数判定                                                                                                                               |
| `PERF_DATASET_IMAGES` 偏离 1500                                       | 沿用现状：相对判定整体不启用并打印提示；此时**不得**报 `missing_section`（避免与「规模不一致」混因）                                                                                                           |
| `npm run perf:readings` 无 `latest.json`                              | stderr 报「先跑 npm run e2e:perf」+ 退出码 1；CI 那步 `if: always()` 保证红态也能出读数                                                                                                                        |

## 7. 参数校验（入参类型 / 必填 / 边界 / 非法值）

- `--env <value>`：只接受 `dev` / `ci`；非法值 ⇒ stderr 列出合法值并退出码 1（照 `scripts/sync-e2e/launch-args.ts` 的拒绝风格）；缺省按 `resolvePerfEnv` 判据从 `process.env` 解析。
- `PERF_ENV`：仅 `'dev' | 'ci'` 生效，其他值忽略（环境变量宽容）；`GITHUB_ACTIONS` / `RUNNER_ENVIRONMENT` 只在 `PERF_ENV` 缺失时参与判定。
- `--samples`：≥1 个路径；相对路径按仓库根解析，绝对路径直用；`--env ci` 只给 1 份 ⇒ 合法但必然 `provisional`。
- 基线 JSON 字段边界：`baselineValue > 0`（≤0 视为无相对规则，沿用 `perf-helpers.ts:186` 现有判定）；`regressionFactor > 0`（缺省 `2.0`）；`maxMs` / `minThroughput` 必须为正数，非数字 ⇒ 结构校验失败走 `null` 降级；`sampleCount` 为非负整数；`status` 只允许 `'final' | 'provisional'`；`sourceRuns` 为非空字符串数组（播种必须可追溯到真实运行）。
- 写面：固化脚本只写 `e2e/perf-baseline.json`（沿用常量 `:22`），不新增写目标；`--dry-run` 分支必须早于任何 `writeFile`。

## 8. 基础测试用例（正常 / 异常 / 边界）

### 8.1 `e2e/__tests__/perf-baseline-env.test.ts`（新建）

| 用例                                                                                                                                                                  | 期望                                                                                         | 修复前是否真红                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常：两份 CI 读数各选 `ci` 段                                                                                                                                        | 均 `toEqual([])`                                                                             | **真红**（HEAD 忽略环境、套 dev 段 ⇒ 各 3 条回归）                                                                                           |
| 反向：同批 CI 读数选 `dev` 段                                                                                                                                         | 恰 3 条 `regression`，metricId 序列 `scan-ingest,find-duplicates,find-duplicates-throughput` | 真红（旧码无第三参；用字面量数组锁定）                                                                                                       |
| 正常：今日 dev 读数（909/636/2358.7/13/8/1122/1336.6/0）选 `dev` 段                                                                                                   | `toEqual([])`，且先断言 `loadBaseline()` 非 null                                             | 等价性表征用例 ⇒ 用**临时变异**证判别力（抬高 dev 段某项 `baselineValue` 或放大 factor，必须只有它变红），随后逐字还原 + `grep` 确认变异清零 |
| 边界：`hardRules` 8 条 + dev 段 8 条相对值逐字等于 v1 快照（字面量表）                                                                                                | `toEqual({…})`                                                                               | 真红（HEAD 文件 `version:1`、无 `hardRules`/`environments`）                                                                                 |
| 边界：ci 段每项 `regressionFactor` === dev 段同项                                                                                                                     | 遍历断言                                                                                     | 真红                                                                                                                                         |
| 异常：删掉 `environments.ci`                                                                                                                                          | 恰 1 条 `missing_section`，且硬护栏照常跑                                                    | 真红（旧码无该 kind）                                                                                                                        |
| 边界：`provisional` 段仍参与相对判定（构造超阈读数）                                                                                                                  | 长度 1                                                                                       | 真红                                                                                                                                         |
| 正常：`resolvePerfEnv` 优先级表（`PERF_ENV=ci`/`dev` 覆盖、`GITHUB_ACTIONS=true`、`RUNNER_ENVIRONMENT=github-hosted`、裸 `CI=true` **必须**仍是 `dev`、全空 ⇒ `dev`） | 逐条 `toBe`                                                                                  | 真红（函数不存在）                                                                                                                           |
| 边界：`loadBaseline()` 对 `version:1` / 缺 `environments` / 带 BOM 的 v2 三种输入                                                                                     | 前两者 `null` + stdout 告警；第三者正常返回                                                  | 真红（HEAD 会把 v1 当合法基线）                                                                                                              |
| 契约：`DEBT-037` 与 `environments.ci.status` 耦合（provisional ⇒ `open`；final ⇒ `done`）                                                                             | 双分支断言                                                                                   | 真红（HEAD 无该债条目）                                                                                                                      |

### 8.2 `scripts/__tests__/save-perf-baseline.test.ts`（新建）

`aggregateSamples`：正常（2 份⇒中位数、3 份⇒中位数）／异常（id 并集、单份缺项）／边界（1 份⇒`provisional`、3 份⇒允许 `final`、`--env dev` 单份⇒允许 `final` 且不动 ci 段与 `hardRules`）；`resolveEnvKey(argv, env)` 三类；全部纯函数不触磁盘（照 `scripts/__tests__/verify-nikkisync-link.test.ts` 口径）。

### 8.3 `scripts/__tests__/emit-perf-readings.test.ts`（新建）

`buildPerfReadingsAnnotation`：正常（11 项顺序稳定、含 `env=`/`status=`/`samples=`）／异常（空 `samples` ⇒ 报因串）／边界（含 `%`、换行、`:` 的文本必须转义成单行：`%`→`%25`、`\n`→`%A`、`\r`→`%D`，title 内 `,`→`%2C`、`=`→`%3D`）；真实契约：`build.yml` 必须存在调 `npm run perf:readings` 的 step 且其 `if` 为 `always()`（`yaml` 解析，复用 `ci-action-runtime.test.ts:102` 的 `readJobs` 思路）。

**硬性纪律**：每个节点先亲眼看到红灯再改码；无法先红的等价性用例用临时变异证明判别力并还原清零。不得 `it.skip`、不得放宽断言、不得调低阈值。

## 9. 节点分解与验收

| #   | 节点              | 文件                                                                                                                                     | 输入 → 输出                                                  | 验收标准                                                                                                                                          |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | 计划入仓          | `docs/plans/2026-10-22-perf-baseline-env-split.md`                                                                                       | 本文件                                                       | `npx prettier --write` 后无二次改动；同批 `git add` 后 `npm run docs:links` exit 0                                                                |
| 1   | 落盘 CI 样本      | `.cache/perf/ci-39623462678/`（gitignore）                                                                                               | `perf-results.zip` → 3 份 JSON                               | 两份 archive 均可 `JSON.parse`；三条数值与注解互证                                                                                                |
| 2   | 分段判定逻辑      | `e2e/perf-helpers.ts`、`e2e/__tests__/perf-baseline-env.test.ts`                                                                         | v1 判定 → v2 分段判定                                        | 先红后绿：`npx vitest run e2e/__tests__/perf-baseline-env.test.ts` 全绿 + `npm run typecheck:e2e` exit 0                                          |
| 3   | 基线 v2 化 + 播种 | `e2e/perf-baseline.json`                                                                                                                 | v1 + 两样本 → v2                                             | `node -e` 断言 `hardRules`/dev 段逐字等于 v1；ci 段等于中位数表且 factor 逐项等于 dev；`loadBaseline()` 非 null；两份 CI archive 选 `ci` ⇒ `[]`   |
| 4   | 调用点与报告字段  | `e2e/perf.e2e.ts`                                                                                                                        | 采样值 → 带 `perfEnv` 报告                                   | `npm run typecheck:e2e` exit 0；`npx vitest run e2e/__tests__` 全绿（含 `timeout-budget.test.ts`）                                                |
| 5   | 固化脚本分段+聚合 | `scripts/perf-test/save-perf-baseline.ts`、`scripts/__tests__/save-perf-baseline.test.ts`                                                | `--env`/`--samples` → 段内基线                               | 先红后绿；`npm run typecheck` exit 0；`--env ci --samples <两份> --dry-run` 打印值逐项等于中位数表；单样本 dry-run 显示 `status=provisional`      |
| 6   | 读数注解通道      | `scripts/perf-test/emit-perf-readings.ts`、`scripts/__tests__/emit-perf-readings.test.ts`、`package.json`、`.github/workflows/build.yml` | `latest.json` → `::notice::`                                 | 先红后绿；三个测试文件全绿；本地对 dev 与两份 CI archive 各跑一次，输出行首为 `::notice title=perf-readings` 且单行                               |
| 7   | 文档与债登记      | `docs/perf-regression.md`、`scripts/AGENTS.md`、`docs/技术债清单.md`、`docs/debt-registry.json`、`docs/plans/2026-10-21-…md`             | 新语义 → 文档                                                | `npm run docs:links` exit 0；`check-md-links.test.ts` 绿；`npm run debt:check` exit 0；删除「容忍系数已按跨环境放宽」旧口径                       |
| 8   | 提交 A + 远端复验 | —                                                                                                                                        | 节点 2-7 → `feat(e2e): 性能基线按运行环境分设 dev / ci 两段` | pre-commit 三步全过、无 `--no-verify`/无 amend；远端 step 10 `success`、注解出现 `title=perf-readings env=ci`（即样本 #3）、四道上游 job 无新增红 |
| 9   | 转 final          | `e2e/perf-baseline.json`、`docs/debt-registry.json`、`docs/技术债清单.md`、本文件                                                        | 样本 #1/#2/#3 → `--env ci --samples` 三份                    | ci 段 `status: "final"`、`sampleCount: 3`、`sourceRuns` 三条；`DEBT-037` 改 `done`；远端 step 10 仍 `success` 且注解 `status=final`               |

提交编排：提交 A = 节点 2-7 + 上一轮遗留的 `docs/plans/2026-10-21-…md` §10.11；提交 B = 节点 9。

## 10. 风险

1. **CI 噪声**：实测离散度 `cache-get-stats` 41.2%、`media-list-page500` 30.4%、`find-duplicates` 22.4%、`thumbnail-generate-p95` 4 倍。factor 未变（3/5/10/50）且播种取两份中位数 ⇒ 容忍区间仍远大于噪声；若仍假红，处置是补第 4 份样本重取中位数，**不是**调 factor。
2. **同 runner 相关性**：样本 #1/#2 来自同一 job 的两次整链重跑，共享 warm 磁盘缓存 ⇒ 第 3 份必须来自另一次运行。
3. **build.yml 字符串契约**：`scripts/__tests__/audit-config.test.ts` 可能对步骤集合有断言 ⇒ 节点 6 显式回归；若需同步期望值，属同步义务并写明理由，不是放宽拦截。
4. **闸门盲区**：只改 JSON/文档时 `npm run verify` 一个测试都不跑（`scripts/find-related-tests.ts` 只认 `.ts/.tsx`；`lint-staged` 无 `docs` 键、prettier glob 不含 `docs/**` 与 `e2e/*.json`）⇒ 节点 3、7 必须手动指名跑守卫与 `npm run docs:links`；被跟踪文档引用本轮新增文件须与代码同批 `git add` 后再跑，否则提交那一刻才转红。

交付定义：远端一次运行同时满足 ① step 10 `success`；② `perf-readings` 注解可读且 `env=ci`；③ 四道上游 job 无新增红；④ 最终态 ci 段 `status: "final"`、`sampleCount: 3`、`DEBT-037 = done`。任一未达 ⇒ 如实保留红态并说明，不弱化。

## 11. 执行记录

| 时间             | 动作              | 读数 / 结果                                                                                                                                                                                                                                                     |
| ---------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-22 18:32 | HEAD 基线绿灯确认 | `npm run i18n:check` ⇒ 12 locale 全对齐（3939 keys）；`npx vitest run e2e/__tests__ scripts/__tests__/ci-action-runtime.test.ts scripts/__tests__/audit-config.test.ts` ⇒ 5 文件 / 59 用例全绿，538ms                                                           |
| 2026-10-22 18:32 | 匿名 API 探测     | `GET /actions/runs/39623462678/artifacts` ⇒ HTTP 200（`perf-results` id `12355729227`、3726B、`expires_at 2026-11-04`）；`GET /actions/artifacts/12355729227/zip` ⇒ **HTTP 401** `Requires authentication`                                                      |
| 2026-10-22 18:44 | 登录态取产物      | 经用户已登录的 Edge（Computer Use）下载成功。正确的产物页 URL 形态：`https://github.com/{owner}/{repo}/actions/runs/{runId}/artifacts/{artifactId}`；猜测的 `/commit/{sha}/checks/{jobId}/artifacts/{id}/download` 与 `/actions/artifacts/{id}/download` 均 404 |
| 2026-10-22 18:56 | 节点 1 落盘       | `.cache/perf/ci-39623462678/` 内 3 份 JSON 均可解析：`samples=11`、`violations=3`、`platform=win32-x64`、`node=v22.23.3`；两份 archive 时间戳 15:21:17.943 / 15:21:36.367（`latest.json` == 后者）                                                              |

### 11.1 红绿读数（逐节点）

| 节点                   | 修复前（必须红）                                                                                                                                                                                                                         | 修复后（必须绿）                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 2+3 分段判定 + 基线 v2 | `npx vitest run e2e/__tests__/perf-baseline-env.test.ts` ⇒ **14 failed / 3 passed (17)**，红点含「两次 CI 读数选 ci 段均 0 违规」（实得 3 条回归）、「resolvePerfEnv」四例（函数不存在）、「version 非 2 判结构不合」（v1 被当合法基线） | 同命令 ⇒ **17 passed**；`npm run typecheck:e2e` 0 错误                                                           |
| 4 调用点               | 第三参数缺失即 TS 报错（`tsc --noEmit -p e2e`）                                                                                                                                                                                          | `npm run typecheck:e2e` 0 错误；`npx vitest run e2e/__tests__` 全绿（`timeout-budget.test.ts` 9 例未受影响）     |
| 5 固化脚本             | 新测试对 HEAD ⇒ **模块链接失败，0 例可执行**（导出全不存在）；顺带证实：缺 `isMain` 守卫时导入脚本模块会**执行 main() 并覆写基线**，故守卫为必需                                                                                         | **17 passed**；`npm run typecheck` 0 错误                                                                        |
| 6 注解通道             | 新测试对 HEAD ⇒ 模块不存在，0 例可执行                                                                                                                                                                                                   | **10 passed**；`build.yml` 契约 3 例绿，`ci-action-runtime` / `audit-config` 未因新增步骤变红（计划风险 3 关闭） |

### 11.2 等价性用例的判别力证明（临时变异，跑完逐字还原）

三条「修复前即绿」的表征用例无法靠先红自证，改用变异：把 `e2e/perf-baseline.json` 改成正向该断言
会失效的写法，确认目标用例确实变红，再把文件还原为逐字一致（脚本末行自检 `还原=逐字一致`）。

| 变异                                      | 目标用例                           | 结果                                                                               |
| ----------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| dev 段 `scan-ingest` 系数 3 → 1.2（收紧） | 「开发机读数选 dev 段 0 违规」     | ✓ 变红（连带：dev 逐字快照例、factor 逐项相等例）                                  |
| dev 段 `scan-ingest` 系数 3 → 5（放宽）   | 「CI 读数选 dev 段恰命中三条回归」 | ✓ 变红（scan-ingest 不再被拦 ⇒ 只剩 2 条；连带 missing_section 例的 dev 对照断言） |
| 删 `hardRules['scan-ingest']`             | 「绝对护栏与环境段无关」           | ✓ 变红（回退到 `DEFAULT_HARD_RULES` 的 120000，threshold 判定消失）                |

对照组（未变异）红点 1 条 = `DEBT-037` 尚未登记那条 ⇒ 证明「红点 0 条」不是解析失效造成的假信号。

### 11.3 端到端与全量闸门读数

| 检查                   | 命令                                                                       | 读数                                                                                                                                                                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本地性能套件（dev 段） | `npm run e2e:perf`                                                         | 10 passed / 8 skipped；报告首行 `环境段: dev（final, 1 样, 记录于 2026-08-23T14:59:05.625Z）`，`判定: ✓ 全部通过`；新存档 `perfEnv=dev`、`passed=true`                                                                                                                                                    |
| 本地性能套件（ci 段）  | `PERF_ENV=ci npm run e2e:perf`                                             | 10 passed；`环境段: ci（provisional, 2 样, 记录于 2026-10-21T15:21:36.367Z）`、`判定: ✓ 全部通过`、存档 `perfEnv=ci`                                                                                                                                                                                      |
| 注解通道               | `npm run perf:readings`                                                    | dev 存档 ⇒ `env=dev status=final samples=1 …`；CI 存档 ⇒ `env=ci status=provisional …`；**本轮之前的旧存档无 `perfEnv` 字段 ⇒ `env=unknown status=missing`**（实测发现并被守卫用例钉住：不得冒充 dev，否则 CI 样本会被误读成开发机样本）                                                                  |
| 只读闸门               | `npm run verify`                                                           | 5 项 0 失败（typecheck / lint / core-gate / format / test）。首轮 lint 红 1 条（测试文件里为剥 BOM 写的裸 BOM 字符触发 `no-irregular-whitespace`，tracked 文件本就无 BOM，故删除该 replace）、format 红 3 个文件（`prettier --write` 后复跑）                                                             |
| 类型 / 静态 / i18n     | `npm run typecheck`、`typecheck:e2e`、`npm run lint`、`npm run i18n:guard` | 首轮 typecheck 红 2 条：`RunReportLike` 缺 `violations` 字段、`replaceAll` 不在 scripts 的 lib target 内（改 `replace(/x/g)`）；修后三面 0 错误、lint 0 error 0 warning、i18n ✅                                                                                                                          |
| 全量测试               | `npm test`                                                                 | **433 files / 6602 passed / 12 skipped，0 失败**                                                                                                                                                                                                                                                          |
| 覆盖率门控             | `npm run test:coverage`                                                    | EXIT=0，`All files 69.32 / 60.58 / 61.81 / 70.93`（阈值 66/58/59/68）                                                                                                                                                                                                                                     |
| 文档链接               | `npm run docs:links`                                                       | ✅ 无死引用（153 处提醒均为本机留存区/已交代去向的历史路径）                                                                                                                                                                                                                                              |
| 装置（CI 语义）        | `npm run test:ci-linux`                                                    | 11 files / 54 failed / 422 passed。与既有基线 **10 files / 53 failed** 逐文件对照，多出的 1 个是 `scripts/__tests__/source-encoding.test.ts`(1)，失败原文 `Error: spawnSync git ENOENT`（装置既有「git 子进程不可用」限制类，非本轮引入；同一文件在真宿主 `npm test` 里绿 ⇒ 新文件零 BOM 已被真宿主证明） |

### 11.4 执行中的三处口径订正

1. **测试文件名改按仓内「同名配套」惯例**：`perf-save-baseline.test.ts` → `save-perf-baseline.test.ts`、
   `perf-readings.test.ts` → `emit-perf-readings.test.ts`（`X.ts` ↔ `__tests__/X.test.ts`）。
2. **`scripts/AGENTS.md` 的文件计数按实测订正**：入仓代码文件 48 → **58**、TypeScript 44 → **54**
   （34 非测试 + 20 单测）、同名配套 7/32 → **11/34**。原口径在本轮之前已漂移（HEAD 实测即 33/9）。
3. **宿主环境陷阱**：本机 Qoder 宿主 shell 带 `ELECTRON_RUN_AS_NODE=1`，会让任何 Electron 产物
   按 Node 解析命令行 ⇒ `npm run e2e:perf` 在 `electron.launch` 处报
   `bad option: --remote-debugging-port=0` / `Process failed to launch!`。
   本轮所有打包态 e2e 均在 `unset ELECTRON_RUN_AS_NODE` 后执行；这不是产品缺陷，
   也不得靠改用 `it.skip` 之类绕过。
4. 本地 `npm run e2e:perf` 用的仍是 2026-10-20 21:34 的 `release/win-unpacked`（`src/` 最后一次改动
   是 10-21 的 BOM 清偿，无行为变化）；本轮验证的是**判定机制**而非产物性能，故不重打包。

### 11.5 提交 A 的远端复验：被一个与本轮无关的 audit 红点连坐

`e9a78f8` 推送后（run `39771228817`），lint job 的 **step 6 `Security audit (audit-ci, fail on high/critical)`**
判失败，`npm run lint` / `typecheck` / commitlint / i18n / test / coverage / **build（含 step 10）** 全部
`skipped` ⇒ 本轮改动**没有拿到 step 10 的远端读数**。逐 step 结论取自免鉴权
`GET /actions/runs/39771228817/jobs`（annotations 只有 `Process completed with exit code 1`，无正文）。

本地复现归因（`npx audit-ci --config ./audit-ci.jsonc`）：

```
Found vulnerable advisory paths:
GHSA-f2ph-cmg5-wxc8|storybook
Failed security audit due to critical vulnerabilities.
```

新披露 critical 告警 `GHSA-f2ph-cmg5-wxc8`（"Storybook: Missing origin validation in Storybook preview
allows code injection from malicious websites"）覆盖 `storybook` **10.0.0 - 10.6.1**，本机装的是
`storybook@10.5.10`，上游已发修复版 10.6.2 / 10.6.3 ⇒ **与本轮改动无关**（上一次运行还没有这条告警）。
因为存在官方修复版，把它塞进 `audit-ci.jsonc` 豁免清单等于弱化安全闸门，故选择升级：
`storybook` / `@storybook/react-vite` / `@storybook/addon-docs` / `@storybook/addon-a11y`
四个包必须同版本，`^10.5.x → ^10.6.3`（minor），单独成提交 `e5a4bff`（`fix(deps)`）。

升级后的本机验证：`audit-ci` ⇒ `Passed npm security audit`（critical 归零）；
`npm run build-storybook` ⇒ `completed successfully`（连跑两次 EXIT=0；首跑构建**成功之后**
出现 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) … exit 127`，
是 Windows libuv 进程退出竞态，不是 10.6.3 回归）；`npm test` ⇒ **433 files / 6602 passed / 12 skipped**，
与升级前逐字一致；`test:coverage` ⇒ `All files 69.32 / 60.57 / 61.81 / 70.92`，门控 EXIT=0。

**踩到一条新的本机坑（已写进 commit 正文）**：`npm install` 会把 `node_modules/@nikkisync/*`
四个 junction 当 extraneous 剪掉（它们不是声明依赖，见 `src/main/nikkisync/AGENTS.md`），
于是 3 个 linked 套件静默转 skip，全量读数变成 `430 passed | 3 skipped` / `6563 passed | 51 skipped`。
这不是升级引入的回归，但**长得像**：跑全量前必须先 `npm run link:nikkisync` 复原，
再用 `npm run link:nikkisync:check` / `npm run verify:nikkisync` 确认（复原后读数回到 433 / 6602 / 12）。

### 11.6 提交 `e5a4bff` 的远端复验：step 10 转绿，注解通道回出第三份样本

run `39772693608`（build job id `119805620581`），逐 step 结论取自免鉴权
`GET /actions/runs/39772693608/jobs`：

| 判据                                        | 期望               | 读数                                                     |
| ------------------------------------------- | ------------------ | -------------------------------------------------------- |
| lint job（含 audit）                        | success            | **success**（step 6 audit 转绿后 16 步全过）             |
| test 十片 + Coverage Gate                   | success            | **10 片全 success + Coverage Gate success**              |
| step 9 E2E smoke                            | success            | success，105s（与上一轮口径一致）                        |
| **step 10 Performance baseline regression** | **success**        | **success，18s** —— 本轮交付的核心判据                   |
| step 11 Emit perf readings annotation       | success + 注解可读 | **success，1s**；注解正文见下                            |
| step 12 / 14（归档、安装包上传）            | 不再被连坐         | success 1s / success 7s（step 13 失败现场采集正常 skip） |

注解原文（`GET /check-runs/119805620581/annotations`，annotation_level=notice）：

```
env=ci status=provisional samples=2 dataset=1500
readings=cold-start-first-paint=1692;scan-ingest=1722;scan-throughput=871.3;media-list-page100=23;
media-list-page500=20;find-duplicates=5689;find-duplicates-throughput=263.7;cache-get-stats=2;
thumbnail-generate-p50=3;thumbnail-generate-p95=6;first-thumbnail-visible=344
```

三条判读：① `env=ci` 证明 `resolvePerfEnv()` 在真 runner 上取到了 ci 段（两侧 `platform` 串都是
`win32-x64`，只有显式信号能区分）；② 18s 且该次 artifact 只有 **一份** `perf-run-*.json`，
印证 §11.5 的「绿运行不重跑 ⇒ 只产一份」；③ 注解取整值与随后下载的真实 artifact **逐字一致**
（注解只把 ms 取整、吞吐量留一位小数），说明这条免鉴权通道可以当作补样口径。

### 11.7 节点 9：三份样本固化为 final（含一处被守卫拦下的缺陷）

第三份样本取自 run `39772693608` 的 `perf-results` artifact（登录态 Edge 走
`/actions/runs/{runId}/artifacts/{artifactId}` 下载），三份中位数固化后：

```
ci: status=final, sampleCount=3, sourceRuns=[39623462678#…-17-943Z, 39623462678#…-36-367Z, 39772693608#…-52-331Z]
cold-start 1692.94 / scan-ingest 1900.37 / scan-throughput 789.32 / page100 12.4 /
page500 22.7 / find-duplicates 5689.25 / find-duplicates-throughput 263.66 / cache 1.8
```

**固化过程中被拦下的真缺陷**：`planSection` 最初按报告的指标并集写段，于是给
`thumbnail-generate-p50` / `thumbnail-generate-p95` / `first-thumbnail-visible` 三个**观察项**
凭空建了 `regressionFactor: 2` 的相对规则。P95 三次读数为 5.4 / 27.1 / 5.7ms，
按中位数 5.7×2=11.4ms 建门禁会在 CI 上稳定假红（`docs/perf-regression.md` §6 明确 P50 仅观察、
P95 只受硬护栏）。修法是让固化只携带「既有各段已定义的指标并集」，缺省即拒绝并逐条告警；
新增用例「异常：只携带受门禁指标集，不得给观察项凭空造出相对规则」**先红后绿**，
另加一条「首次固化无既有指标集时按实测全量建段」钉住 bootstrap 分支不被误伤。

红绿读数：三份样本写入基线后，先看到 3 条守卫红（ci 段字面量表、provisional 参与判定、
DEBT-037 耦合）⇒ 证明这些断言有牙；把字面量与 DEBT-037 状态同步到 final 后
`npx vitest run e2e/__tests__/perf-baseline-env.test.ts` ⇒ **17 passed**；
`scripts/__tests__/save-perf-baseline.test.ts` ⇒ **19 passed**。
「三份 CI 读数选 ci 段均 0 违规」同时构成基线幂等自检。
