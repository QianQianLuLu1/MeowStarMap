# 性能基准回归测试指南

本文档描述项目的性能基准回归防线：场景选择、运行方式、判定规则、结果保存、基线维护与已知限制。

## 1. 定位与设计

性能回归测试基于 **Playwright + 打包产物（`release/win-unpacked`）** 运行，直接测量真实应用
（真实 Electron 运行时、真实 better-sqlite3 ABI、真实 IPC 链路）的关键路径耗时，
而不是 mock 环境下的伪指标。

- 测试入口：`e2e/perf.e2e.ts`（`@perf` 标签，与冒烟 `e2e/smoke.e2e.ts` 共用启动辅助 `e2e/helpers.ts`）
- 共享工具：`e2e/perf-helpers.ts`（数据集生成 / 规则判定 / 结果落盘）
- 入库基线：`e2e/perf-baseline.json`（**v2**：绝对护栏 `hardRules` 全局一份 + 相对基线按环境分段 `environments.dev` / `environments.ci`）
- 基线固化脚本：`scripts/perf-test/save-perf-baseline.ts`（`--env` 选段、`--samples` 多样取中位数）
- 读数回流：`scripts/perf-test/emit-perf-readings.ts`（把实测读数打成 CI 注解，见 §3）
- 结果存档：`.cache/perf/`（gitignore，每次运行生成带时间戳文件 + `latest.json`）

每次运行使用全新临时 `userData`（`.cache/e2e-smoke-*`），保证「首启建库」路径被真实覆盖，
且与本机数据完全隔离。

**为什么要分段**：基线是「机器 + 数据集」的快照。v1 把开发机录的相对基线逐字套在
`windows-latest` 上，比较对象与被测环境不一致——run `39623462678` 的 step 10 因此以 3 条
相对回归判红（扫描入库 1900ms / 重复检测 6906ms / 吞吐量 217.2 项/秒），而**同一份打包产物**
在开发机当日判定「✓ 全部通过」，且三条绝对硬护栏在 CI 上也全部通过。
`platform` 串（`win32-x64`）在两侧字面相同，无法用来区分环境，故环境段由 `resolvePerfEnv()` 判定。

## 2. 场景与指标

数据集默认为 **1500 张占位 JPEG**（最小有效 1x1 图片，与
`scripts/perf-test/generate-dataset.ts` 同构），生成在临时 `userData` 内
（pathGuard 对 userData 目录始终放行，扫描无需额外授权）。可用环境变量
`PERF_DATASET_IMAGES=<数量>` 覆盖规模。

| 指标 ID                      | 场景                                                 | 单位    | 绝对护栏（全局共享） | dev 段基线 × 系数  | ci 段基线 × 系数   |
| ---------------------------- | ---------------------------------------------------- | ------- | -------------------- | ------------------ | ------------------ |
| `cold-start-first-paint`     | 冷启动：应用启动 + 首启建库/迁移 + 首屏渲染          | ms      | ≤ 15000              | 2106.52 × 3        | 1692.94 × 3        |
| `scan-ingest`                | 扫描入库（指定目录全量扫描 1500 张）                 | ms      | ≤ 30000              | 414.29 × 3         | 1900.37 × 3        |
| `scan-throughput`            | 扫描吞吐量                                           | 文件/秒 | ≥ 150                | 3620.64 ÷ 5        | 789.32 ÷ 5         |
| `media-list-page100`         | 媒体列表加载（首页 100 条，预热后 5 次取中位数）     | ms      | ≤ 1000               | 7.8 × 10           | 12.4 × 10          |
| `media-list-page500`         | 媒体列表加载（大页 500 条，预热后 5 次取中位数）     | ms      | ≤ 1000               | 10.3 × 10          | 22.7 × 10          |
| `find-duplicates`            | 重复文件检测（全量 sha256 哈希分组）                 | ms      | ≤ 60000              | 1010.27 × 3        | 5689.25 × 3        |
| `find-duplicates-throughput` | 重复检测吞吐量                                       | 文件/秒 | ≥ 100                | 1484.75 ÷ 3        | 263.66 ÷ 3         |
| `cache-get-stats`            | 缓存统计查询（预热后 5 次取中位数）                  | ms      | ≤ 1000               | 0.7 × 50           | 1.8 × 50           |
| `thumbnail-generate-p50`     | 可视区按需生成延迟 P50（冷缓存抽样 25 张）           | ms      | 观察项               | —                  | —                  |
| `thumbnail-generate-p95`     | 可视区按需生成延迟 P95（同上抽样）                   | ms      | ≤ 8000               | 无基线（仅硬护栏） | 无基线（仅硬护栏） |
| `first-thumbnail-visible`    | 首图显影耗时（重新进入图库，首张 `media://` onLoad） | ms      | ≤ 15000              | 无基线（仅硬护栏） | 无基线（仅硬护栏） |

dev 段是 2026-08-23 开发机实测（v1 原值，本轮分段时**逐字照搬**，未放宽也未收紧）；
ci 段是**三份**真 CI 读数的中位数（run `39623462678` 两份 + run `39772693608` 一份），
`status: "final"`、`sampleCount: 3`、`sourceRuns` 三条可追溯（DEBT-037 已收口）。**两段的 `regressionFactor` 必须逐项相同**——
分段只换比较对象，不换容忍系数；由 `e2e/__tests__/perf-baseline-env.test.ts` 钉住。

2026-10-09 复测（同一台开发机，1500 张占位数据集）：冷启动 841ms、扫描 761ms
（1970 文件/秒）、首页列表 9ms、大页 9ms、重复检测 1375ms（1091 文件/秒）、
缓存统计 0ms、按需生成 P50 1ms / P95 3ms、首图显影 121ms。
**注意**：占位图是 1x1 最小 JPEG，按需生成分位只反映 IPC 往返，不代表真实原图；
真实 3311×1485 / 3840×2160 原图实测单张 12~25ms（读 1MB + hash + sharp 解码缩放编码）。
「切板块要重新等一遍」这类症状在占位数据集上完全测不出来，必须用 §3.1 的真实数据副本套件。

另有处理量门禁：扫描 `filesFound` 必须等于数据集规模（漏扫即失败），
重复检测 `scannedFiles` 必须大于 0。

## 3. 运行方式

前置：`release/win-unpacked` 存在（本地先 `npm run dist:win`，CI 由 build 步骤产出）。

```powershell
# 一键：打包 + 性能回归
npm run dist:win:perf

# 仅性能回归（产物已存在时）
npm run e2e:perf

# 强制按某个环境段判定（默认自动判定，见 §4）
$env:PERF_ENV = "ci"; npm run e2e:perf

# 把最近一次读数打成一行注解正文（本地/CI 通用，只读）
npm run perf:readings

# 调整数据集规模
$env:PERF_DATASET_IMAGES = "3000"; npm run e2e:perf

# 冒烟默认排除 @perf，行为与原冒烟一致
npm run e2e:smoke
```

CI：`build` job（windows-latest）在 E2E 冒烟之后强制执行 `npm run e2e:perf`，
回归即阻断发布链；运行结果（`.cache/perf/**`）始终以 `perf-results` artifact 归档 14 天。
紧随其后还有一步 `if: always()` 的 `npm run perf:readings`：把本次读数压成一行
`::notice title=perf-readings::` 注解。取数原因见 §5——artifact 下载与 step 日志正文都要鉴权，
而 `GET /repos/{owner}/{repo}/check-runs/{jobId}/annotations` 免鉴权可读，
所以固化 ci 段基线所需的多次采样可以零 token 回流；`if: always()` 保证**判红那次也能出数**。

### 3.1 真实数据副本套件（`@perf-real`，手动，本机专用）

占位数据集无法复现「已入库媒体引用缺失」类症状（见 §2 末尾说明），故另有
`e2e/perf-real.e2e.ts`：把本机真实 userData 的 `database/meow_star_map.db*` 克隆到
`.cache/perf-real/user-data-<ts>`，并按副本里 `app_settings.thumbnailCacheDir` 指向的
**真实缓存目录**把缓存内容一并复制进来，让打包产物指向克隆目录——
**真实库全程只读，任何写入（扫描修复、日志、缩略图、Chromium 缓存）都落在副本上**，
跑完删除（`PERF_REAL_KEEP=1` 保留以便翻日志）。

两条必读口径（都是踩过坑后写死的，改动前先读代码注释）：

1. **`--user-data-dir` 本身不构成隔离**。`app_settings` 里的 `logDir` / `crashDir` /
   `backupDir` / `thumbnailCacheDir` 存的是绝对路径，`applyCustomDirectories` 会在启动时
   把它们指回真实目录（实测：副本运行把日志写进 `%APPDATA%` 真实日志目录、把缩略图写进
   用户迁盘的缓存目录）。`beforeAll` 因此必须用 `node:sqlite` 把这四个键改写到副本内部
   （注意不能用 `better-sqlite3`：它按 Electron ABI 编译，在 Playwright 的普通 Node 进程里
   `dlopen` 会报 `NODE_MODULE_VERSION` 不匹配）。
2. **骨架/显影计数只算「已布局」节点**（`getBoundingClientRect().width > 0`）。虚拟网格会
   挂载尚未布局的隐藏卡片，而 `img[loading=lazy]` 对这类元素**根本不发起请求**（`currentSrc`
   为空、resource timing 无对应 URL），混入计数会稳定产出「20~40 张骨架永不归零」的假结论。
   同理，`countLogPattern()` 用 `logLineKey()`（秒级 epoch + 正文）去重，因为 electron-log
   会把同一事件同时写进 `main.log` 与 `main-<日期>.log`，按行数直接数会翻倍。

判据除耗时外还有两条硬assert：各板块切换后「已布局卡片的缩略图骨架必须归零」，以及
每段切换记录**副本缓存目录的文件增量**（渲染层没触发按需生成时该增量恒为 0）。

```bash
npm run dist:win
PERF_REAL_USERDATA="C:/Users/<你>/AppData/Roaming/meow-star-map" \
  npx playwright test --config e2e/playwright.config.ts --grep @perf-real
```

产出不做阈值门禁（数值随个人库规模变化），落 `.cache/perf-real/latest-real.json`，
用于改前/改后对照：R2 首启（冷缓存）首图显影与骨架沉降、R3 逐板块切换、
R3b 直调 `thumbnail:generate` 与 `file:getExif` 的守卫口径对照、R4 二次启动对照、
R4b 副本日志计数（回写失败 / 孤儿清理 / worker 降级）。

该套件不进 CI：未设置 `PERF_REAL_USERDATA` 时整个 describe 自动 skip。
`npm run e2e:smoke` 用 `--grep-invert @perf` 排除（`@perf-real` 命中该子串），不会被冒烟带跑。

## 4. 判定规则

0. **环境选段**：`resolvePerfEnv()` 决定用哪一段相对基线——`PERF_ENV=dev|ci` 显式覆盖优先，
   其次 `GITHUB_ACTIONS=true` / `RUNNER_ENVIRONMENT=github-hosted` 判为 `ci`，否则 `dev`。
   **故意不认裸 `CI=true`**：开发机的 shell / IDE 也可能带它，选错段等于悄悄换了比较口径。
   判定结果写进报告的 `perfEnv` 字段并打印在汇总报告首行（环境段自证）。
1. **绝对阈值（硬护栏）**：取全局 `hardRules`，缺条目时回退 `DEFAULT_HARD_RULES`；
   超过 `maxMs` / 低于 `minThroughput` 无条件失败（任何环境都不可突破）。
2. **基线回归（相对容忍）**：只从所选环境段取 `baselineValue` / `regressionFactor`——
   - 耗时类：实测 > `baselineValue × regressionFactor` → 回归；
   - 吞吐量类：实测 < `baselineValue ÷ regressionFactor` → 回归。
   - 仅当本次数据集规模与基线记录的 `datasetImages` 一致时启用（规模不一致时只跑硬护栏并打印提示）。
3. **环境段缺失**：基线存在但所选段没入库时，判一条 `kind: missing_section` 违规**直接红**，
   不静默退化为「只跑硬护栏」——否则「忘记固化某段」会伪装成「性能没问题」。
4. **执行失败**：任何一步异常（扫描失败、漏扫、IPC 报错、进程崩溃）直接以测试失败上报。

失败时 P10 会在控制台打印汇总报告（各指标实测值 + 违规原因 + 所用环境段），可直接在 CI 日志中定位。

## 5. 基线维护（人工复核流程）

基线是「机器 + 数据集」的快照，**更新基线必须人工复核**，且**只改写所选环境段**
（`hardRules` 与另一段原样保留）。流程：

1. 在稳定环境（关闭无关负载）运行 `npm run e2e:perf`，确认 `判定: 全部通过`；
2. 运行 `npm run perf:save-baseline -- --env dev --dry-run` 预览（新旧对比）；
3. 复核数值是否合理（`baselineValue` 取所选报告的**中位数**、保留两位小数；
   `regressionFactor` 一律沿用该段旧值，缺省 2.0，**不得**为某个环境单独放大）；
4. 确认后去掉 `--dry-run` 运行，将 `e2e/perf-baseline.json` 随代码一并提交，
   提交信息说明基线变更原因（如硬件更换、数据集调整、真实性能优化）。

**ci 段的额外闸门**：`scripts/perf-test/save-perf-baseline.ts` 的 `MIN_CI_SAMPLES = 3` 规定
样本不足 3 份时只能写 `status: "provisional"`（相对判定照常生效，但明确标注未固化），
加 `--final` 而样本不足则直接报错退出。多样本用法：

```bash
npm run perf:save-baseline -- --env ci --dry-run \
  --samples .cache/perf/ci-samples/39623462678#perf-run-…-17-943Z.json \
            .cache/perf/ci-samples/39623462678#perf-run-…-36-367Z.json \
            .cache/perf/ci-samples/<新运行>#perf-run-….json
```

采样读数的取回口径（都是实测踩出来的）：

- 一次 **失败** 的 CI 运行会留下 **两份** 读数：`e2e/playwright.config.ts:19` 的
  `retries: process.env.CI ? 1 : 0` 让 `describe.serial` 整链重跑，产物里就有两个
  `perf-run-*.json`；一次 **成功** 运行只产 1 份。
- 同一 job 内重跑的两份共享 warm 磁盘缓存，不算完全独立样本 ⇒ 第 3 份必须来自**另一次运行**。
- 本机无 token 时 `GET /actions/artifacts/{id}/zip` 是 401、step 日志正文是 404，
  所以用 §3 的 `perf-readings` 注解（免鉴权 annotations 接口）取数。

**何时应更新基线**：应用真实性能优化后（基线收紧）、数据集规模调整后、
或某段样本数补足后转 final。

**禁止**：在未定位劣化根因前通过放宽基线「消音」性能回归；给某个环境单独放大
`regressionFactor`；或在 CI 上关掉相对判定。

## 6. 已知限制

- **硬件敏感已按环境分段收口**：绝对耗时与机器强相关，故相对基线按 `dev` / `ci` 分两段，
  比较对象与被测环境一致；样本不足时以 `status: "provisional"` 明示并挂技术债条目，
  而不是继续放大系数。三份 CI 读数的实测极差比：`scan-ingest` 13.0%、
  `find-duplicates` 22.4%、`media-list-page500` 48.0%、`cache-get-stats` 41.2%——
  都远小于现行 3~50 倍系数，故补样不需要动系数。
- **缩略图后台噪声**：扫描完成后应用会后台生成缩略图（低优先级队列），
  与后续列表/重复检测测量并发。中位数采样与宽松阈值已覆盖常规波动，极端负载下可能出现抖动。
- **占位数据集的边界**：1x1 占位 JPEG 覆盖「扫描入库 / 查询 / 哈希」链路，
  不覆盖真实大图的解码与缩略图生成耗时；视频文件未纳入默认数据集。
  万级数据全量压测仍可用原手工脚本：
  `npx tsx scripts/perf-test/generate-dataset.ts <目录> 10000 5000` 生成数据后，
  在应用 DevTools Console 执行 `scripts/perf-test/perf-baseline.ts` 中的 `runPerfBaseline()`。
- **缩略图生成耗时分位**：P95 只有硬护栏（≤ 8000ms），**没有**相对基线条目（v1 起就未入库，
  本轮分段也未新增，故只受硬护栏约束）；P50 仅观察——
  它依赖 sharp 解码与素材形态，占位图（1x1）下恒为 1ms 量级，作为门禁只会制造假绿。
  真实原图的解码耗时请看 §3.1 套件的 `first-thumbnail-visible` 与骨架沉降计数。
  实测同一 job 两次 P95 读数为 5.4ms / 27.1ms（4 倍抖动），正是它不适合做相对门禁的旁证。
- **单平台**：套件面向 Windows 打包产物（与发布目标一致）；其他平台暂无对照基线。
  环境分段只到 `dev` / `ci` 两类宿主为止，不是按 CPU 型号细分——同一台开发机的硬件变更
  仍需人工重录 dev 段。

## 7. 相关文件

| 文件                                                                          | 职责                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `e2e/perf.e2e.ts`                                                             | 性能回归套件（P1~P10，`@perf` 标签）                                |
| `e2e/perf-real.e2e.ts`                                                        | 真实数据副本套件（`@perf-real`，手动，见 §3.1）                     |
| `e2e/perf-helpers.ts`                                                         | 数据集生成 / 环境选段与规则判定 / 报告与落盘                        |
| `e2e/perf-baseline.json`                                                      | 入库基线 v2（全局 `hardRules` + `environments.dev/ci` 相对基线）    |
| `e2e/__tests__/perf-baseline-env.test.ts`                                     | 环境分段判定守卫（dev 等价性、ci 段生效、段缺失必红）               |
| `scripts/perf-test/save-perf-baseline.ts`                                     | 基线固化脚本（`--env` 选段、`--samples` 多样取中位数、`--dry-run`） |
| `scripts/perf-test/emit-perf-readings.ts`                                     | 把实测读数打成一行 CI 注解（只读，供免鉴权取数）                    |
| `scripts/__tests__/save-perf-baseline.test.ts` / `emit-perf-readings.test.ts` | 上述两个脚本的纯函数与 build.yml 契约守卫                           |
| `scripts/perf-test/generate-dataset.ts`                                       | 万级手工压测数据集生成器                                            |
| `scripts/perf-test/perf-baseline.ts`                                          | T15 手工 DevTools 基线脚本（大规模场景保留使用）                    |
| `.github/workflows/build.yml`                                                 | CI 接入（build job：冒烟后强制执行 + 结果归档）                     |
