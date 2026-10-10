# 性能基准回归测试指南

本文档描述项目的性能基准回归防线：场景选择、运行方式、判定规则、结果保存、基线维护与已知限制。

## 1. 定位与设计

性能回归测试基于 **Playwright + 打包产物（`release/win-unpacked`）** 运行，直接测量真实应用
（真实 Electron 运行时、真实 better-sqlite3 ABI、真实 IPC 链路）的关键路径耗时，
而不是 mock 环境下的伪指标。

- 测试入口：`e2e/perf.e2e.ts`（`@perf` 标签，与冒烟 `e2e/smoke.e2e.ts` 共用启动辅助 `e2e/helpers.ts`）
- 共享工具：`e2e/perf-helpers.ts`（数据集生成 / 规则判定 / 结果落盘）
- 入库基线：`e2e/perf-baseline.json`
- 基线固化脚本：`scripts/perf-test/save-perf-baseline.ts`
- 结果存档：`.cache/perf/`（gitignore，每次运行生成带时间戳文件 + `latest.json`）

每次运行使用全新临时 `userData`（`.cache/e2e-smoke-*`），保证「首启建库」路径被真实覆盖，
且与本机数据完全隔离。

## 2. 场景与指标

数据集默认为 **1500 张占位 JPEG**（最小有效 1x1 图片，与
`scripts/perf-test/generate-dataset.ts` 同构），生成在临时 `userData` 内
（pathGuard 对 userData 目录始终放行，扫描无需额外授权）。可用环境变量
`PERF_DATASET_IMAGES=<数量>` 覆盖规模。

| 指标 ID                      | 场景                                                 | 单位    | 绝对护栏 | 基线容忍  |
| ---------------------------- | ---------------------------------------------------- | ------- | -------- | --------- |
| `cold-start-first-paint`     | 冷启动：应用启动 + 首启建库/迁移 + 首屏渲染          | ms      | ≤ 15000  | 基线 × 3  |
| `scan-ingest`                | 扫描入库（指定目录全量扫描 1500 张）                 | ms      | ≤ 30000  | 基线 × 3  |
| `scan-throughput`            | 扫描吞吐量                                           | 文件/秒 | ≥ 150    | 基线 ÷ 5  |
| `media-list-page100`         | 媒体列表加载（首页 100 条，预热后 5 次取中位数）     | ms      | ≤ 1000   | 基线 × 10 |
| `media-list-page500`         | 媒体列表加载（大页 500 条，预热后 5 次取中位数）     | ms      | ≤ 1000   | 基线 × 10 |
| `find-duplicates`            | 重复文件检测（全量 sha256 哈希分组）                 | ms      | ≤ 60000  | 基线 × 3  |
| `find-duplicates-throughput` | 重复检测吞吐量                                       | 文件/秒 | ≥ 100    | 基线 ÷ 3  |
| `cache-get-stats`            | 缓存统计查询（预热后 5 次取中位数）                  | ms      | ≤ 1000   | 基线 × 50 |
| `thumbnail-generate-p50`     | 可视区按需生成延迟 P50（冷缓存抽样 25 张）           | ms      | 观察项   | —         |
| `thumbnail-generate-p95`     | 可视区按需生成延迟 P95（同上抽样）                   | ms      | ≤ 8000   | 基线 × 2  |
| `first-thumbnail-visible`    | 首图显影耗时（重新进入图库，首张 `media://` onLoad） | ms      | ≤ 15000  | 基线 × 2  |

当前基线值（2026-08-23 本地开发机实测）：冷启动 ≈ 2.1s、扫描 ≈ 0.41s（3620 文件/秒）、
首页列表 ≈ 8ms、大页 ≈ 10ms、重复检测 ≈ 1.0s（1485 文件/秒）、缓存统计 ≈ 1ms。

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

# 调整数据集规模
$env:PERF_DATASET_IMAGES = "3000"; npm run e2e:perf

# 冒烟默认排除 @perf，行为与原冒烟一致
npm run e2e:smoke
```

CI：`build` job（windows-latest）在 E2E 冒烟之后强制执行 `npm run e2e:perf`，
回归即阻断发布链；运行结果（`.cache/perf/**`）始终以 `perf-results` artifact 归档 14 天。

### 3.1 真实数据副本套件（`@perf-real`，手动，本机专用）

占位数据集无法复现「已入库媒体引用缺失」类症状（见 §2 末尾说明），故另有
`e2e/perf-real.e2e.ts`：把本机真实 userData 的 `database/wxnn_photo_manager.db*` 克隆到
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
PERF_REAL_USERDATA="C:/Users/<你>/AppData/Roaming/wxnn-photo-manager" \
  npx playwright test --config e2e/playwright.config.ts --grep @perf-real
```

产出不做阈值门禁（数值随个人库规模变化），落 `.cache/perf-real/latest-real.json`，
用于改前/改后对照：R2 首启（冷缓存）首图显影与骨架沉降、R3 逐板块切换、
R3b 直调 `thumbnail:generate` 与 `file:getExif` 的守卫口径对照、R4 二次启动对照、
R4b 副本日志计数（回写失败 / 孤儿清理 / worker 降级）。

该套件不进 CI：未设置 `PERF_REAL_USERDATA` 时整个 describe 自动 skip。
`npm run e2e:smoke` 用 `--grep-invert @perf` 排除（`@perf-real` 命中该子串），不会被冒烟带跑。

## 4. 判定规则

1. **绝对阈值（硬护栏）**：超过 `maxMs` / 低于 `minThroughput` 无条件失败（任何环境都不可突破）。
2. **基线回归（相对容忍）**：
   - 耗时类：实测 > `baselineValue × regressionFactor` → 回归；
   - 吞吐量类：实测 < `baselineValue ÷ regressionFactor` → 回归。
   - 仅当本次数据集规模与基线记录的 `datasetImages` 一致时启用（规模不一致时只跑硬护栏并打印提示）。
3. **执行失败**：任何一步异常（扫描失败、漏扫、IPC 报错、进程崩溃）直接以测试失败上报。

失败时 P8 会在控制台打印汇总报告（各指标实测值 + 违规原因），可直接在 CI 日志中定位。

## 5. 基线维护（人工复核流程）

基线是「机器 + 数据集」的快照，**更新基线必须人工复核**，流程：

1. 在稳定环境（关闭无关负载）运行 `npm run e2e:perf`，确认 `判定: 全部通过`；
2. 运行 `npm run perf:save-baseline -- --dry-run` 预览将要写入的基线（新旧对比）；
3. 复核派生阈值是否合理（脚本默认：耗时护栏 = 实测 × 3 向上取整到秒，吞吐量下限 = 实测 ÷ 3；
   既往基线中已人工调整过的 `maxMs` / `minThroughput` / `regressionFactor` 会被保留）；
4. 确认后运行 `npm run perf:save-baseline`，将 `e2e/perf-baseline.json` 随代码一并提交，
   提交信息说明基线变更原因（如硬件更换、数据集调整、真实性能优化）。

**何时应更新基线**：应用真实性能优化后（基线收紧）、数据集规模调整后、
以及 CI 环境持续显著慢于基线记录环境时（从 `perf-results` artifact 中提取
`.cache/perf/latest.json` 覆盖本机后重新固化）。

**禁止**：在未定位劣化根因前通过放宽基线「消音」性能回归。

## 6. 已知限制

- **硬件敏感**：绝对耗时与机器强相关。基线在本地开发机采集，容忍系数已按跨环境放宽
  （3~10 倍）；若 CI 上持续误报，应基于 `perf-results` artifact 重新固化基线，而不是继续放宽系数。
- **缩略图后台噪声**：扫描完成后应用会后台生成缩略图（低优先级队列），
  与后续列表/重复检测测量并发。中位数采样与宽松阈值已覆盖常规波动，极端负载下可能出现抖动。
- **占位数据集的边界**：1x1 占位 JPEG 覆盖「扫描入库 / 查询 / 哈希」链路，
  不覆盖真实大图的解码与缩略图生成耗时；视频文件未纳入默认数据集。
  万级数据全量压测仍可用原手工脚本：
  `npx tsx scripts/perf-test/generate-dataset.ts <目录> 10000 5000` 生成数据后，
  在应用 DevTools Console 执行 `scripts/perf-test/perf-baseline.ts` 中的 `runPerfBaseline()`。
- **缩略图生成耗时分位**：P95 已纳入硬护栏（≤ 8000ms）与基线回归判定，P50 仅观察——
  它依赖 sharp 解码与素材形态，占位图（1x1）下恒为 1ms 量级，作为门禁只会制造假绿。
  真实原图的解码耗时请看 §3.1 套件的 `first-thumbnail-visible` 与骨架沉降计数。
- **单平台**：套件面向 Windows 打包产物（与发布目标一致）；其他平台暂无对照基线。

## 7. 相关文件

| 文件                                      | 职责                                             |
| ----------------------------------------- | ------------------------------------------------ |
| `e2e/perf.e2e.ts`                         | 性能回归套件（P1~P10，`@perf` 标签）             |
| `e2e/perf-real.e2e.ts`                    | 真实数据副本套件（`@perf-real`，手动，见 §3.1）  |
| `e2e/perf-helpers.ts`                     | 数据集生成 / 规则判定 / 报告与落盘               |
| `e2e/perf-baseline.json`                  | 入库基线（基线值 + 阈值 + 容忍系数）             |
| `scripts/perf-test/save-perf-baseline.ts` | 基线固化脚本（支持 `--dry-run`）                 |
| `scripts/perf-test/generate-dataset.ts`   | 万级手工压测数据集生成器                         |
| `scripts/perf-test/perf-baseline.ts`      | T15 手工 DevTools 基线脚本（大规模场景保留使用） |
| `.github/workflows/build.yml`             | CI 接入（build job：冒烟后强制执行 + 结果归档）  |
