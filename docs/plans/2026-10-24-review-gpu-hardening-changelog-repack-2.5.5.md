# 近期提交审查收口 + gpu-status 超时兜底 + CHANGELOG 补录 + 2.5.5 重打包

> 状态：已确认（2026-10-24）｜背景：对近期 GPU 硬件加速系列（`17f31ee…bbb2ddf`，共 8 个提交）与工作区未提交改动做全面审查后的收口轮。

## 0. 审查结论（探索已闭环）

- 逐行审过 `gpu-fallback.ts`（崩溃升级分级 / 版本级重试状态机）、`gpu-preference.ts`（独显注册表）、`gpu-status.ts`（探针聚合）、`app-handler.ts` / `preload/api/app.ts` / `settings-handler.ts`（IPC 面）、`diagnostics-sections.tsx`（GPU 状态卡）、`index.ts` / `window-manager.ts`（启动集成）、e2e S8 / P9b 及各测试文件——**未发现逻辑错误**。
- 「版本升级仅重试一次」「`markBootSuccess` 保留 `fallbackActive`」是被 `gpu-fallback.test.ts` v1–v5 用例明确钉住的刻意设计（本轮不动）。
- 三个受保护路径文件均带 `@core-change` 授权注释；i18n / 主题变量 / 路径语义全部合规；GPU 轮自身红绿证据与全量回归见 `docs/plans/2026-10-24-gpu-hwaccel-optimization.md` §8。

**本轮修复的两个缺口**：

| #   | 缺口                                                                                                                                                                                                              | 严重度 | 处置          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------- |
| 1   | `gpu-status.ts` 降级查询 `getGPUInfo('basic')` 无超时——complete 有 3s 超时兜底，但若 basic 也挂起，`app:gpu-status` 探针永久挂起（诊断卡永远 loading），违背模块自述「挂起时降级 null」契约                       | P3     | TDD 红-绿修复 |
| 2   | `CHANGELOG.md` `[2.5.5]` 节未补录 2026-10-24 GPU 优化轮——该节宣称"不引入新的功能性变更"，但当日重打包的 2.5.5 产物已含 GPU 行为变更；仓库惯例每轮出货必须追加条目（`check-changelog-release` 只查节存在，不会拦） | 规范   | 手工补录      |

## 1. 依赖声明

零新增 npm 依赖；全程**禁止 `npm install` / `npm ci`**（node 26/npm 11 会剥离 lock 的 libc 字段并清掉 `node_modules/@nikkisync` 四条 junction）。仅复用既有设施：`withTimeout`（gpu-status.ts 既有私有函数）、`GpuStatusDeps.gpuInfoTimeoutMs`（既有注入参数）、仓库既有脚本（`verify` / `test` / `dist:win` / `e2e:smoke` / `link:nikkisync:check`）。

## 2. 启动与运行说明

环境已就绪（node_modules 在位，2026-10-24 刚完成过同链路打包）。执行序：T0 复核 → T1 计划落档 → T2 红绿修复 → T3 CHANGELOG → T4 验证与全量回归 → T5 提交 → T6 版本位核验 → T7 重打包 + e2e → T8 安全扫描 → T9 执行记录 + 收尾提交。

## 3. 错误处理

- verify / lint / typecheck 红：当场修复重跑，不累积。
- pre-commit 钩子可能改写文件重新暂存：每次提交后 `git status --porcelain` 复核。
- `dist:win` 红：按四段链输出定位（build / 27 项 pre-dist-check / electron-builder / verify:dist fail-closed），修复后整链重跑。
- e2e 红：读 `test-results/` 与归集 diag 日志；S4 断言打包产物 `app.getVersion()` === 2.5.5。
- 清理 `release/win-unpacked*` 遇 EBUSY：重试；仍锁死则如实上报（唯一确定解法是重启系统，禁止旁路打包树凑成功）。
- 全量回归出现与本轮无关的既有失败：对照 2026-10-24 基线（6785 passed / 12 skipped / 0 failed），以"无新增失败"为一票否决线并如实报告。

## 4. 参数校验

本轮不新增任何 IPC 通道、入参面或设置键。修复复用既有注入参数 `gpuInfoTimeoutMs`（默认 3000ms）；CHANGELOG 与本计划文档为纯内容变更；红绿测试按 `GpuStatusDeps` 接口注入依赖，无真实 Electron 调用。

## 5. 子任务分解（三要素 + 验收标准）

### T0 前置复核（只读）

- 文件：无改动。输入/输出：`git status --porcelain`、`git log --oneline`、版本声明位 grep。
- 验收：工作区 clean；四处声明位 + 文档惯例位实测均为 2.5.5。

### T1 计划落档（本文件）

- 验收：文件入 `docs/plans/`（未被 .gitignore 排除，随 T9 入仓）。

### T2 修复 gpu-status basic 超时兜底（严格红-绿）

- 文件：`src/main/app/__tests__/gpu-status.test.ts`（新增用例）、`src/main/app/gpu-status.ts`（1 行；`src/main/app/` 非受保护路径，无需 `@core-change`）。
- 红灯：注入 `getGpuInfo`：complete 立即 reject、basic 永不 resolve、`gpuInfoTimeoutMs: 20`；`Promise.race`（1s `'__hang__'` 哨兵）包裹 `collectGpuStatus`，断言非哨兵且 `gpus`/`activeGpu` 为 null。修复前跑必须失败。
- 绿灯：basic 调用包 `withTimeout(getGpuInfo('basic'), timeoutMs)`；该测试文件全绿（含既有 complete 超时降级 basic 成功用例）。
- 测试三类覆盖：正常（complete 成功，既有）/ 异常（complete 拒绝→basic 成功，既有；complete 拒绝+basic 永挂→有限时间收敛 null，新增）/ 边界（超时路径与拒绝路径复用同一 withTimeout 机制，同用例覆盖）。
- 验收：新用例修复前红、修复后绿，红绿读数记入执行记录。

### T3 CHANGELOG 补录

- 文件：`CHANGELOG.md`。在 `[2.5.5]` 节最后一个 `> 2026-10-23 追加` 条目后新增 `> 2026-10-24 追加：「GPU 硬件加速系统性优化」…` 条目（内容见批准计划），文风与既有追加条目一致。
- 验收：`npx tsx scripts/check-changelog-release.ts` 仍绿。

### T4 验证与全量回归

- 命令：`npm run verify` → `npm test` → `npm run lint` → `npm run typecheck` → `npm run typecheck:e2e`。
- 验收：全部通过、零新增失败（基线 6785/12/0，本轮 +1 新用例）。

### T5 提交修复

- `fix(gpu): GPU 状态探针 basic 兜底查询补超时防永久挂起`（同批携带测试与 CHANGELOG 追加；规避 Mimosa「动词：路径」误报措辞；subject ≤72 字符）。提交后 `git status --porcelain` 复核。

### T6 版本声明位核验

- 输出：四处声明位 + 文档惯例位（README 徽章 / AGENTS / ARCHITECTURE(.en) / DEVELOPMENT(.en)）实测值清单；`dist:win` 的 `check-doc-versions` 闸门一并背书。全部 2.5.5 → 无需改动，留证。

### T7 重打包（四段链）

1. `npm run link:nikkisync:check`（四条 junction 在位）
2. `rm -rf release/win-unpacked*`（清过期残壳防 EBUSY）
3. `npm run dist:win`（build → pre-dist-check → electron-builder NSIS → verify:dist）
4. `npm run e2e:smoke`（S4 版本一致 + S8 GPU 探针）

- 验收：四步全过；`release/latest.yml` version=2.5.5、安装包 `MeowStarMap-Setup-2.5.5.exe`。

### T8 安全扫描

- mimosa 扫描（normal 深度，focus：`src/main/app/gpu-status.ts` 与其测试）。验收：改动文件零新增发现。

### T9 执行记录 + 收尾提交

- 本文件追加执行记录（红绿读数、回归与打包读数、版本位核验清单）；提交 `docs(plans): GPU 轮审查收口、超时兜底修复与 2.5.5 重打包执行记录`；提交后复核工作区 clean。

## 6. 风险与回退

- T2 仅在既有 fail-open 降级链上补一层超时，不改正常路径行为；回退：revert 单提交。
- T3 纯文档；回退：git revert。
- 已知遗留（本轮不动，与记忆一致）：`gallery-scroll-frame-p95` 无硬护栏待基线固化；GPUInfo `gpuDevice` 清单 vendor/device 为 null 显示 `?/?`；混合显卡笔记本独显优先略增耗电。

## 7. 执行记录

全部按批准计划顺序执行（2026-10-24）。

### T0/T6 前置复核与版本声明位核验（只读）

- `git status --porcelain` 为空（工作区 clean）；GPU 系列实测为 **8 个提交**（`17f31ee` → `6a6d644` → `aa65399` → `1d7f1df` → `570b492` → `1a05780` → `6970ec4` → `bbb2ddf`）。
- 版本声明位实测清单（全部 2.5.5，**一处未改**，"设定为 2.5.5"以核验留证方式满足）：

| 声明位                                                                                   | 实测值                    |
| ---------------------------------------------------------------------------------------- | ------------------------- |
| `package.json:3`                                                                         | 2.5.5                     |
| `package-lock.json:3` / `:9`                                                             | 2.5.5                     |
| `src/renderer/preview/mock/database-mock.ts:664` getVersion                              | '2.5.5'                   |
| `CHANGELOG.md` `[2.5.5]` 节                                                              | 存在且唯一（闸门绿）      |
| `release/latest.yml`                                                                     | 2.5.5（重打包后自动再生） |
| `README.md:10` 徽章 / `AGENTS.md:7` / `ARCHITECTURE(.en).md:5` / `DEVELOPMENT(.en).md:5` | 2.5.5                     |

### T1 计划落档

本文件创建并入 `docs/plans/`（未被 .gitignore 排除，随 T9 入仓）。

### T2 gpu-status basic 超时兜底（红-绿读数）

- **红灯**：`gpu-status.test.ts` 新增 s7 用例（complete 立即 reject + basic 返回永不 resolve 的 Promise + `gpuInfoTimeoutMs: 10`，`Promise.race` 1s 哨兵）。修复前运行：**1 failed / 8 passed**——s7 以 `collectGpuStatus 永久挂起：basic 降级查询缺超时兜底` 失败（哨兵 1004ms 先到），精准复现缺陷。
- **绿灯**：`gpu-status.ts` basic 降级查询包既有 `withTimeout(getGpuInfo('basic'), timeoutMs)`（1 行 + 1 行注释）。重跑同文件：**9 passed / 9**（含 s3/s4/s5 既有降级用例不破）。

### T3 CHANGELOG 补录

- `[2.5.5]` 节在 2026-10-23 追加条目之后新增 `> 2026-10-24 追加：「GPU 硬件加速系统性优化」…` 条目（崩溃分级 / 版本级重试 / 独显优先注册表 / 可观测性四件事 + 本轮 basic 超时兜底 + 重新构建说明）。
- `npx tsx scripts/check-changelog-release.ts`：✔ 13 个版本节、✔ `[2.5.5]` 存在且唯一、✔ Unreleased 已收口。

### T4 验证与全量回归

- `npm run verify`：5 项全绿（typecheck / lint / core-gate / format / test）。
- `npm test` 全量：**6786 passed / 12 skipped / 0 failed**（基线 6785 + 本轮新增 s7 一例，零新增失败）。
- `npm run lint`、`npm run typecheck`、`npm run typecheck:e2e`：全部通过。

### T5 提交修复

- `c8112ff fix(gpu): GPU 状态探针 basic 兜底查询补超时防永久挂起`（同批携带测试、修复与 CHANGELOG 追加）；提交后 `git status --porcelain` 仅余本计划文档（untracked，符合预期），钩子无残留改动。

### T7 重打包（四段链）

1. `npm run link:nikkisync:check`：四条 junction 在位 ✔
2. 清理 `release/win-unpacked*` 残壳 ✔（无 EBUSY）
3. `npm run dist:win`：build → pre-dist-check（含 changelog / doc-versions 闸门）→ electron-builder NSIS → verify:dist **全链通过**；产物 `MeowStarMap-Setup-2.5.5.exe`（183,352,577 字节），`latest.yml` version=2.5.5、releaseDate `2026-10-24T09:48:40Z`（17:48 本地，含 c8112ff 的新构建）
4. `npm run e2e:smoke`：**16 passed**——S4 断言打包产物 `app.getVersion()` === 2.5.5 ✔，S8 GPU 探针结构齐备且硬件加速默认开启 ✔

### T8 mimosa 安全扫描

- 扫描 `normal` 深度，focus `src/main/app/gpu-status.ts` 与 `__tests__/gpu-status.test.ts`。
- scan ID：`scan-2026-10-24T10-56-21.997Z-6fa3c40eb0fa`；seal：`sha256:217e2c9902b20330447ade8607c68cdac9a9548a0a3a2936a65063e5cb7d10e4`（产物目录 `~\.mimosa\security-scans\project-2be0875f9af48500fd91355e\scan-2026-10-24T10-56-21.997Z-6fa3c40eb0fa`）。
- findings.json 共 398 项静态发现，**与本轮同日 GPU 轮基线（398 项）持平**，其中 `gpu-status` 字面零命中——本轮改动文件零新增发现。
- 依赖面：1342 个包完成扫描；离线通告命中 2 包 / 13 条 advisory（均为需人工确认数据流的静态提示，与改动文件无关）。

### T9 收尾

执行记录补录完成后以 `docs(plans)` 提交本文件；提交后复核工作区 clean。
