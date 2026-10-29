# AGENTS.md — `scripts/`（构建工具链与开发辅助脚本）

本文件为 Agent 与新协作者提供 **脚本模块级** 速览与约定。顶层项目速览见根目录 [`AGENTS.md`](../AGENTS.md)；四条硬性编码约定与校验/提交口径见 [`docs/CODING_CONVENTIONS.md`](../docs/CODING_CONVENTIONS.md)（唯一真相源；IDE 的 always-on 规则文件仅为它的本地镜像）。本文件只补 **本目录内** 的脚本分类、调用方式与编码约定。

## 模块概述

构建工具链与开发辅助脚本集合，覆盖 **打包前后校验、i18n 治理、性能基线、技术债管理、环境诊断、数据生成** 等开发全流程自动化任务。所有脚本通过 `tsx` 直接执行 TypeScript，由 `package.json` 的 npm scripts 统一调度。

## 目录结构

68 个入仓代码文件（另有 1 个本 AGENTS.md；**9 个 `.ps1` 辅助脚本不入仓**，见下「语言与执行」），按功能分为以下子域：

### 打包与构建

| 文件                         | 调用方式                                         | 职责                                                                                                 |
| ---------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `pre-dist-check.ts`          | `npm run pre-dist-check` / `npm run verify:dist` | **打包前产物校验闸门**（13+ 项：产物存在性/时间戳/修复点/ABI 一致性/crossorigin/协议实现等）         |
| `after-pack-vc-runtime.cjs`  | `package.json` `build.afterPack` 自动调用        | electron-builder `afterPack` 钩子，将 VC++ 2015-2022 运行库 DLL 随包分发                             |
| `check-doc-versions.ts`      | `npm run pre-dist-check` 内部调用                | 校验 README 中 Electron 版本与 package.json 一致                                                     |
| `check-changelog-release.ts` | `npm run pre-dist-check` 内部调用                | 校验 CHANGELOG.md 已收口（package.json 版本有对应节、`[Unreleased]` 无待发布条目），未收口即阻断打包 |
| `reset.ts`                   | `npm run reset`                                  | 全量清理 dist/cache/.vite/tsbuildinfo                                                                |
| `electron-browser-stub.js`   | 构建配置引用                                     | Vite resolve.alias 目标，将渲染进程残留的 `import 'electron'` 替换为空 stub                          |

### i18n 治理（`i18n/`）

| 文件                       | 调用方式                       | 职责                                                     |
| -------------------------- | ------------------------------ | -------------------------------------------------------- |
| `i18n/_shared.ts`          | 被其他 i18n 脚本 import        | i18n 工具公共层（白名单解析/ESLint lint/值反查表），只读 |
| `i18n/guard.ts`            | `npm run i18n:guard`           | CI 守卫（白名单只减不增 + 清零必移除 + key 对齐）        |
| `i18n/codemod.ts`          | `npm run i18n:codemod`         | i18n 自动改写 codemod（dry-run 预览 / `--apply` 落地）   |
| `i18n/extract-i18n.ts`     | `npm run i18n:extract-legacy`  | 提取中文硬编码修复建议（只读）                           |
| `i18n/prune-whitelist.ts`  | `npm run i18n:prune-whitelist` | 白名单自动瘦身（移除违规清零文件）                       |
| `i18n/whitelist-status.ts` | `npm run i18n:status`          | 白名单现状分析报告（控制台/JSON/Markdown）               |
| `check-i18n-keys.ts`       | `npm run i18n:check`           | 对比所有 locale 文件与 zh-CN.json 的 key 对齐            |

### 技术债管理（`debt/`）

| 文件                           | 调用方式              | 职责                                               |
| ------------------------------ | --------------------- | -------------------------------------------------- |
| `debt/check-debt-fix.ts`       | `npm run debt:check`  | PR 变更文件命中技术债时输出 CI 提醒（始终 exit 0） |
| `debt/create-github-issues.ts` | `npm run debt:issues` | 批量创建技术债 GitHub Issue 并回填 issue 号        |

### 性能测试（`perf-test/`）

| 文件                              | 调用方式                     | 职责                                                                                  |
| --------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| `perf-test/generate-dataset.ts`   | 手动 CLI                     | 生成万级占位媒体文件用于性能压测                                                      |
| `perf-test/perf-baseline.ts`      | 运行时注入                   | 性能基线测试（扫描/列表/查询/去重/缓存），在 DevTools Console 运行                    |
| `perf-test/save-perf-baseline.ts` | `npm run perf:save-baseline` | 将实测报告固化为入库基线的**某一个环境段**（`--env` / `--samples` / `--dry-run`）     |
| `perf-test/emit-perf-readings.ts` | `npm run perf:readings`      | 把最近一次读数打成一行 `::notice title=perf-readings::` CI 注解（只读；免鉴权取数用） |

### 数据生成

| 文件                                | 调用方式                                                           | 职责                                       |
| ----------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ |
| `copy-resonance-thumbnails.ts`      | `npx tsx scripts/copy-resonance-thumbnails.ts --source <dir>`      | 从外部仓库拷贝卡池缩略图并生成 import 索引 |
| `generate-resonance-names.ts`       | `npx tsx scripts/generate-resonance-names.ts --source <dir>`       | 从外部仓库提取多语言实体名称包             |
| `generate-resonance-static-data.ts` | `npx tsx scripts/generate-resonance-static-data.ts --source <dir>` | 从外部仓库提取共鸣录静态数据               |

### 同步 E2E 联调（`sync-e2e/`）

| 文件                        | 调用方式                                                                                 | 职责                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `sync-e2e/launch-server.ts` | `ELECTRON_RUN_AS_NODE=1 electron --import tsx scripts/sync-e2e/launch-server.ts`（手动） | 进程内启动真实同步服务端（SQLite/TLS 身份/配对/事件汇）+ 本地控制端口，供跨仓库驱动测试（NikkiSync 侧） |
| `sync-e2e/launch-args.ts`   | 被 `launch-server.ts` import                                                             | CLI 参数解析纯函数（`--port` 0–65535 校验、未知参数拒绝、`--serve` no-op）                              |

### 诊断与校验

| 文件                       | 调用方式                                                  | 职责                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doctor.ts`                | `npm run doctor`                                          | 环境健康诊断（Node 版本/原生模块/DLL/数据库）                                                                                                                                                                                                                                                                                     |
| `e2e-usage.ts`             | `npm run e2e`                                             | **e2e 误输入守卫**：裸 `npm run e2e`（含 `e2e : smoke` 这类把冒号两侧打成空格的笔误）列出真实子命令并以退出码 1 结束，替代 npm 的 Missing script 报错                                                                                                                                                                             |
| `verify-changes.ts`        | `npm run verify` / `npm run verify:staged`                | **变更后只读验证闸门**（typecheck + eslint 无 `--fix` + prettier `--check` + 相关单测）；铁律：只读，绝不写文件。typecheck 的 `tsc -b` 产物落点已隔离到 `.cache/tsmain`，不再覆写 `dist/main`（原因见 `docs/plans/2026-10-19-fix-e2e-smoke-dist-pollution.md`，落点由 `scripts/__tests__/typecheck-emit-isolation.test.ts` 守护） |
| `verify-format-scope.ts`   | 被 `verify-changes.ts` import                             | 从 `package.json` 的 `lint-staged` 键推导钩子格式作用域（纯函数，只读）                                                                                                                                                                                                                                                           |
| `check-preview-drift.ts`   | `npm run preview:check`                                   | preview.html 与源码的 10 项漂移检测                                                                                                                                                                                                                                                                                               |
| `check-md-links.ts`        | `npm run docs:links`                                      | **被跟踪 Markdown 的引用完整性守护**（只读）：抽取 `[x](path)` 与行内反引号路径，按 tracked 集合判定 ok / ignored-local / annotated-gone / upstream-scope / artifact / dead；死引用退出码 1                                                                                                                                       |
| `verify-nikkisync-link.ts` | `npm run verify:nikkisync`                                | **NikkiSync 依赖与装载面只读诊断**（依赖图是否自包含/`node_modules/@nikkisync/*` 链接/NikkiSync `dist/` 产物/`migrations` 可读/主进程产物未把 ESM 折叠成 `require()`/打包态 unpacked 含 schema），`--json` 可切结构化输出；未链接为 warn 不阻断                                                                                   |
| `link-nikkisync.ts`        | `npm run link:nikkisync` / `npm run link:nikkisync:check` | **NikkiSync 开发机链接器**：在候选根（`NIKKISYNC_ROOT` → `../NikkiSync` → `vendor/NikkiSync`）中建/校 `node_modules/@nikkisync/*` junction（幂等；`--check` 只读）；无可用根时退出码 1 并逐项给出拒绝原因                                                                                                                         |
| `generate-icon.js`         | 手动执行                                                  | 主源 PNG → 四档圆角 ICO 图标生成（导出 `radiusFor` / `roundedRectCoverage` 等纯函数，由 `__tests__/app-icon.test.ts` 覆盖）                                                                                                                                                                                                       |

### 测试

| 文件                                        | 覆盖范围                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `__tests__/audit-config.test.ts`            | 审计配置契约测试（audit-ci.jsonc/package.json/build.yml/.npmrc 一致性）                                    |
| `__tests__/lock-advisory-floor.test.ts`     | lock 解析版本下限闸门（读真实 package-lock.json，不联网）+ 与 audit-ci.jsonc 豁免清单的互斥断言            |
| `__tests__/logger-escape-ledger.test.ts`    | logger 落盘逃逸台账闸门（静默/真写盘两张封闭集 + `logger.ts` 的 fire-and-forget 与四条告警形状的反遮蔽锁） |
| `__tests__/core-path-gate.test.ts`          | 核心路径闸门：PROTECTED_GLOBS 与 eslint 配置一致性 + 占位文案守护                                          |
| `__tests__/find-related-tests.test.ts`      | 源文件 → 相关测试匹配的共享规则纯函数单测                                                                  |
| `__tests__/verify-format-scope.test.ts`     | 格式检查作用域纯函数单测 + 与真实 `lint-staged` 配置的契约测试                                             |
| `__tests__/check-changelog-release.test.ts` | 变更日志收口闸门：纯函数单测（正常/异常/边界）+ 真实仓库结构契约测试                                       |
| `__tests__/verify-nikkisync-link.test.ts`   | NikkiSync 诊断纯函数单测（不触磁盘，无链接环境也能跑）                                                     |
| `__tests__/link-nikkisync.test.ts`          | 链接器纯函数单测（候选根解析/链接动作计划/子路径逃逸校验）                                                 |
| `__tests__/self-contained-deps.test.ts`     | 真实 package.json 的**依赖图自包含契约**：无仓库外 `file:`/`workspace:` 依赖 + 打包面保留 `@nikkisync`     |
| `__tests__/path-semantics-guard.test.ts`    | 路径语义三分法登记表（PINNED / DIALECT / HOST_IO）与 CI 复现装置、electron 别名的存在性守卫                |
| `__tests__/sync-e2e-launch-args.test.ts`    | sync-e2e 启动器参数解析纯函数单测（默认值/校验/边界）                                                      |
| `__tests__/pre-dist-check.test.ts`          | 打包前校验闸门纯函数单测（校验项判定与聚合）                                                               |
| `__tests__/check-md-links.test.ts`          | Markdown 引用守护纯函数单测 + **真实仓库契约**：被跟踪文档的死引用数必须为 0                               |
| `__tests__/save-perf-baseline.test.ts`      | 基线固化脚本纯函数单测：`--env`/`--samples` 校验、跨报告中位数、只改写所选段、ci 段样本不足拒绝 final      |
| `__tests__/emit-perf-readings.test.ts`      | 读数注解纯函数单测（workflow 命令转义）+ **build.yml 契约**：必须有 `if: always()` 的 `perf:readings` 步骤 |
| `i18n/__tests__/i18n-scripts.test.ts`       | i18n 脚本纯函数单测（prune/codemod/guard/_shared）                                                         |

## 编码约定

### 语言与执行

- 68 个入仓代码文件里 63 个为 TypeScript（`.ts`：35 个非测试脚本 + 28 个 `__tests__` 单测），统一使用 `tsx` 直接执行，无需编译步骤。
- 其余 5 个：3 个 `.cjs`（`after-pack-vc-runtime.cjs` 是 electron-builder 钩子、`build-recycle-helper.cjs` 是 K8 回收 helper 构建器、`simulate-gpu-crash.cjs` 是 GPU 崩溃复现脚本），2 个 `.js`（Vite stub 和图标生成）。
- **口径纠正**：另有 9 个 `.ps1` PowerShell 辅助脚本**只在开发机本机存在、不入仓**——`scripts/mimosa-*.ps1`（4 个）、`scripts/fix-harness-memory-path.ps1`、`scripts/write-bridge-report.ps1` 由 `.gitignore` 的 `/scripts/mimosa-*.ps1`、`/scripts/fix-harness-memory-path.ps1`、`/scripts/write-bridge-report.ps1` 三条规则显式排除，`scripts/archive/` 下 3 个由 `/scripts/archive/` 整目录排除（行号会随 `.gitignore` 增长漂移，故按规则文本引用）。此前把 `.ps1` 计入「代码文件总数」会使新克隆的协作者按目录数不到它们；引用这些脚本时须写明「未纳入版本控制」。
- 项目 `"type": "module"`，所有 TS 脚本使用 `import.meta.url` 推导 `__dirname`。

### 错误处理与退出

- 统一 `process.exit(1)` 表示失败，`process.exit(0)` 表示通过。
- 关键脚本有 try-catch 包裹，错误信息输出到 stderr。

### 输出格式

- 结构化控制台输出，使用 Unicode 符号（✓/✖/⚠/✅/❌）和 ANSI 颜色码。
- 支持多种输出格式时通过 CLI 参数切换：`--json` / `--md <path>`。

### 安全操作模式

- **Dry-run 默认**：修改型脚本（codemod/prune-whitelist 等）默认只读预览，`--apply` 才落地。
- **幂等设计**：数据生成脚本（resonance 相关）均设计为幂等可重复执行。
- **铁律注释**：只读脚本在文件头标注"铁律：本脚本只读，绝不 writeFile 改源码"。

### CLI 参数约定

- `--source <dir>` — 外部数据源目录
- `--apply` — 落地修改（对应默认 dry-run）
- `--dry-run` — 只读预览
- `--json` — JSON 格式输出
- `--md <path>` — Markdown 输出到文件
- `--files-from <file>` — 从文件读取变更列表（CI 集成）
- `--base` / `--head` — Git 比较基准

### 纯函数导出

- 关键逻辑导出为纯函数供单测复用（如 `removeFromWarnBlock`、`applyEdits`、`evaluateGuard`）。
- 脚本入口与业务逻辑分离：入口负责 CLI 解析和流程编排，核心逻辑导出为可测试函数。

## npm scripts 速查

| 命令                           | 说明                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `npm run reset`                | 全量清理构建产物                                                                 |
| `npm run pre-dist-check`       | 打包前产物校验                                                                   |
| `npm run verify:dist`          | 打包后 asar 校验                                                                 |
| `npm run verify:nikkisync`     | NikkiSync 依赖与装载面只读诊断（自包含 / 链接 / dist 产物 / schema）             |
| `npm run link:nikkisync`       | 为开发机建立 `node_modules/@nikkisync/*` junction（未链接是默认态）              |
| `npm run link:nikkisync:check` | 只读预览上述链接现状                                                             |
| `npm run doctor`               | 环境健康诊断                                                                     |
| `npm run e2e`                  | e2e 误输入守卫：列出真实子命令并以退出码 1 结束                                  |
| `npm run verify`               | 变更后只读验证（工作区 vs HEAD）                                                 |
| `npm run verify:staged`        | 仅暂存文件的只读验证（检查集对齐 pre-commit，但不改写文件）                      |
| `npm run i18n:check`           | i18n key 对齐检查                                                                |
| `npm run i18n:guard`           | CI i18n 守卫                                                                     |
| `npm run i18n:status`          | 白名单现状报告                                                                   |
| `npm run i18n:extract-legacy`  | 提取硬编码中文                                                                   |
| `npm run i18n:prune-whitelist` | 白名单瘦身                                                                       |
| `npm run i18n:codemod`         | i18n 自动改写                                                                    |
| `npm run preview:check`        | preview.html 漂移检测                                                            |
| `npm run docs:links`           | 被跟踪 Markdown 的死引用守护（只读，死引用即退出码 1）                           |
| `npm run debt:check`           | 技术债 CI 检查                                                                   |
| `npm run debt:issues`          | 批量创建技术债 Issue                                                             |
| `npm run perf:save-baseline`   | 保存性能基线（`--env dev\|ci` 选段、`--samples` 多样取中位数、`--dry-run` 预览） |
| `npm run perf:readings`        | 把最近一次性能实测读数打成一行 CI 注解（只读；供免鉴权取回 ci 段采样）           |

## 注意事项

- **禁止** 在脚本中直接 `import` 主进程模块（`src/main/`）——脚本运行在 Node 环境，无 Electron 上下文。例外一：`copy-resonance-thumbnails.ts` 等数据生成脚本动态导入 `src/renderer/utils/` 中的纯函数。例外二（记录在案）：`sync-e2e/launch-server.ts` 静态 import 8 个 `src/main/` 模块以装配**真实**同步服务端（不复制装配逻辑，见 `docs/sync-integration/06-e2e-plan.md` §8 的有意决策），运行方式为 `ELECTRON_RUN_AS_NODE=1 electron --import tsx`——原生 better-sqlite3 是 Electron ABI，plain Node 不可加载，Electron 的 Node 侧无渲染进程上下文问题。
- 修改 `pre-dist-check.ts` 的校验项时需同步更新 `npm run dist:win` 的 CI 预期。
- i18n 脚本链（`_shared.ts` → `guard.ts` / `codemod.ts` / `prune-whitelist.ts`）有内部依赖，修改 `_shared.ts` 需回归测试全部消费方。
- `after-pack-vc-runtime.cjs` 是 CommonJS 格式（electron-builder 钩子要求），不得改为 ESM。
- `doctor.ts` 的诊断结果会被 CI 和 `npm run verify` 引用，修改输出格式需评估下游。
- 修改 `package.json` 的 `lint-staged` 键**形态**（不只是内容）时必须同步 `verify-format-scope.ts`，否则新增键会被跳过格式检查；`__tests__/verify-format-scope.test.ts` 中的配置契约测试会先失败（不可解析键另在 `npm run verify` 输出 `[VERIFY] ⚠`）。
- 测试配对率偏低：35 个非测试脚本中 11 个有同名配套单测（`X.ts` ↔ `__tests__/X.test.ts`，≈31%；2026-10-22 性能基线分段轮把 `save-perf-baseline.ts` / `emit-perf-readings.ts` 补齐了同名配套）；且 `scripts/**` 不在 `vitest.config.ts` 的 `include: 'src/**'` 覆盖率统计范围内，本目录**没有行覆盖率读数**，历史写的「约 8%」无法复现，已改为可实测的文件配对口径。新增脚本时建议将核心逻辑导出为纯函数并补充单测。
