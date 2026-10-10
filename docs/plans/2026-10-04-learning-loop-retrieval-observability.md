# 计划：学习回路可观测性补齐与检索/新鲜度判定记录

> 本文为 2026-10-04 轮次快照，当前口径以主规约文档为准（生命周期/约定见根 AGENTS.md 与 docs/CODING_CONVENTIONS.md；通道见 docs/IPC_CONTRACT.md）。
> 日期：2026-10-04
> 来源：/better-harness 评审发现 `learning-loop-retrieval-decision-undecidable`（报告 `d:\Users\Downloads\WXNN XiangCe（jiu)\.qoder\better-harness\2026-10-03\213222-wxnn-xiangce-jiu\findings.json`）
> 性质：只读复核 + 项目侧记录。不创建新 Agent 资产，不合并/删除任何 Memory，不改动 `src/**`、`package.json`、钩子与既有报告文件
> 说明：本次调用未携带机器回调 `<better-harness-fix-output>`，因此**不执行** `harness record-fix-output`， bound `findings.json`/`canvas.json` 保持原样；修复状态登记走项目侧文档

---

## 0. 已知事实（本轮实测，非假设）

- 源根定义在 `better-harness\scripts\session-analysis\platforms\qoder.mjs` L864-L948：共 7 个根，默认启用 5 个，`qoder-cache-projects` 需 `--include-cache`、`qoder-global-projects` 需 `--include-global-capabilities`。`disabled-source-root` / `missing-optional-root` 由同文件 L810-L832 生成。
- home 解析：`options["qoder-home"] ?? "~/.qoder"`（同文件 L840）。`harness analyze` 与 `harness evidence-bundle` 的参数白名单都含 `qoder-home`，但 `--help` 未列出；`evidence-bundle/index.mjs` L41 与 `evidence-bundle/session-evidence.mjs` L16 **都**把 `<provider>-home` 透传给两条通道。
- 本机目录实测：`C:\Users\45001\.qoder` 仅 `projects`（1 条，非本工作区）存在 → 与报告中"6 个启用根仅 1 个存在 + 0 of 0"完全吻合；`C:\Users\45001\.qoder-cn` 下 `logs\runs`(159)、`logs\sessions`(12)、`projects`(27，含 `d-Users-Downloads-WXNN XiangCe（jiu)`)、`cache\projects`(14) 存在。
- 待复核报告的 lead 通道字段：`canvas.json` → `summary.evidenceBoundary.manifest.selection = {strategy:"all-eligible", eligibleCount:0, analyzedCount:0, confidence:"Low"}`。
- 结论待验证的工作假设：~~两组计数不同源于 lead 那次调用未带 `--qoder-home`（走了 `~/.qoder`），不是两条通道的测量语义天然不可比~~
  **→ 执行时已证伪（见 §8）**：带 `--qoder-home` 重跑后 lead 仍为 `0 of 0`，真实原因是 lead 链路把 kebab 参数转成了 camelCase，平台解析器不认该别名。

## 1. 依赖声明

- 无新增/变更 npm 依赖，无安装动作。
- 外部工具（已确认存在）：
  - `C:\Program Files\nodejs\node.exe`
  - `C:\Users\45001\.qoder-cn\plugins\cache\qoder-bundler\better-harness\scripts\better-harness.mjs`，子命令 `session-analysis sources`、`harness evidence-bundle`、`harness analyze`、`coding-agent-practices asset-integrity`（均经 `commands --json --audience maintainer` 与 `--help` 核实）
  - IDE 内 `SearchMemory`（fetch / search / explore 三种模式）
- 仓库既有命令：`npm run typecheck`、`npm run lint`、`npm test`、`npx prettier --check`。

## 2. 启动说明

- 环境准备：无需构建；所有采集命令为只读，不写文件（`--canvas-out` 一律不使用）。
- 窗口参数（重建值，原值未持久化，记录中须声明此差异）：`--since 2026-09-03T13:32:22.000Z --until 2026-10-03T13:32:22.000Z`，依据为评审运行目录时间戳 `213222`（本地 UTC+8 = 13:32:22Z）与 `--depth normal` 的 30 天窗口规则。
- 输出落地：所有采集 stdout 一律写入 gitignored 的 `.qoder\better-harness-runs\_scratch\`。
  **禁止使用 PowerShell `>` 重定向**（上一轮 `bundle.json` / `141421-...-evidence-bundle.json` 即因此出现字符串内换行污染与 mojibake，不可解析）；改用 `$o = & node ...; [IO.File]::WriteAllText($p, ($o -join "`n"))`。
- 验证方式：见第 6 节各任务的验收标准 + 第 5 节用例表。

## 3. 错误处理

- 命令不可用/参数被拒（`unknown ... argument`）→ 记录实际 `--help` 文本，改用等价的已存在命令；不得凭猜测换参数。
- `evidence-bundle` 返回 `status: failed` 或某 lane `unavailable` → 保留原文与 lane 状态，按发现文本用"individual owner 仅用于诊断具名不可用通道"的约束，只对失败通道跑单条 owner 命令，不做全量重跑。
- JSON 无法解析（历史污染文件）→ 只用当轮新写的干净输出判定；旧文件仅作为"上一轮采集已被污染"的证据，不作为结论输入。
- 兜底：任一命名值无法解析时**停止并报告确切的恢复条件**，不虚构替代产物。
- 日志输出：本计划文件 + `docs/技术债清单.md` §12 即执行记录；原始采集留在 `_scratch/`（gitignored，不入库）。

## 4. 参数校验

- `--workspace`：必填，绝对路径 `d:\Users\Downloads\WXNN XiangCe（jiu)`，须 `Test-Path` 为真；含全角括号，命令中必须整体加引号。
- `--platform`/`provider`：必填，只允许 `qoder`（`qoder-harness` 为非法值，会被 `reportPlatform` 拒绝）。
- `--language`：只允许 `en|zh-CN`（`zh` 为历史错误值，实测出现在旧 bundle 的 `context.language`）。
- `--depth`：`normal`；`--since/--until`：ISO-8601，`since < until`，且 `since` 不早于 2026-01-01（防止把空窗口当成"无活动"）。
- `--qoder-home`：必填于本任务，取值 `C:\Users\45001\.qoder-cn`；非法值 = 目录不存在 → 该次采集作废并记录为参数错误，不得解读为"无会话活动"。
- 越权值：本任务不接受 `--include-memories` 之外的 Memory 权限扩展，不读取 Memory 正文（CLI 侧永不读取）；`--include-cache` 仅在解释"6 个启用根"口径差异时使用，且不用于结论。

## 5. 基础测试用例

| 类型 | 用例                                            | 验收标准                                                                                                           |
| ---- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 正常 | `session-analysis sources` 带 CN home           | 返回 7 根清单；`logs/runs`、`projects/<slug>`、`logs/sessions/<slug>` 至少 2 个 `exists=true`；eligible 会话数 > 0 |
| 正常 | `harness evidence-bundle` 带 CN home + 重建窗口 | `lanes.sessionEvidence.status=available` 且 `lead.status=available`；两条通道 eligible 计数同时 > 0                |
| 正常 | `asset-integrity` 带 `--include-memories`       | 返回 project 作用域 Memory 标题计数、碰撞组数、`scanState`                                                         |
| 异常 | 同参数**去掉** `--qoder-home`                   | 预期两条通道同时归零；若 session 通道仍 > 0 而 lead = 0，则原假设被证伪，改记为"通道口径差异"并保留证据            |
| 异常 | `--language zh` 或 `--platform qoder-harness`   | 命令报错并被记录；不得写入结论                                                                                     |
| 边界 | `--since` 等于 `--until`                        | 计数为 0，须标注"窗口过窄"而非"无学习回路活动"                                                                     |
| 边界 | IDE 概览存在 `N more…` 截断                     | 概览可见计数与 CLI 计数不一致时，判定降为 `needs-more-evidence`，差异写为评审边界                                  |

## 6. 子任务分解（按节点推进，逐节点验收通过才进下一步）

### 任务 A：源根可用性只读复核

- **修改文件**：无（结果暂存 `_scratch\sources-cn.json` / `_scratch\sources-default.json`）
- **输入**：`session-analysis sources --platform qoder --workspace <root> [--qoder-home <cn>] --json`
- **输出**：两遍对照的根清单（id/enabled/exists/path）+ warnings；`~/.qoder` 下"6 启用 1 存在"是否复现
- **验收标准**：两遍均成功返回；表中能一眼指出"存在"根来自哪个 home；默认 home 复现 1 存在 → 假设成立的第一步得证

### 任务 B：同工作区同窗口重跑有界证据采集

- **修改文件**：无（`_scratch\bundle-recheck.json`）
- **输入**：`harness evidence-bundle --platform qoder --workspace <root> --language zh-CN --depth normal --since <A> --until <B> --include-memories --qoder-home <cn> --format json --json`
- **输出**：两个数字及其字段路径 —— `lanes.sessionEvidence.data` 的会话/Episode 选择计数（strategy=all-eligible）与 `lead.data.summaryFacts.evidenceBoundary.manifest.selection` 的 `eligibleCount/analyzedCount/confidence`
- **判定规则**：同基准 = 两值均 > 0 且 strategy 字段可解释差异；否则触发任务 C，并把差异记为评审边界而非结论
- **验收标准**：`status: complete`（或明确列出 incomplete lanes）；两个计数与 JSON 路径逐条抄录进 §12；既有 `.qoder\better-harness\**` 报告文件零改动（`Get-ChildItem` 时间戳不变）

### 任务 C：控制实验（仅当 B 判定为不一致时执行）

- **修改文件**：无
- **输入**：与 B 完全同参数，仅去掉 `--qoder-home`
- **输出**：带/不带 home 的 4 个计数矩阵
- **验收标准**：能明确归因到"调用参数遗漏"或"通道适配器差异"其中之一，并写出证据行号/字段路径

### 任务 D：可重复执行的只读检索 + 新鲜度检查

- **修改文件**：无
- **输入**：`coding-agent-practices asset-integrity qoder --workspace <root> --include-memories --qoder-home <cn> --json` + `SearchMemory`（explore 取分类树、fetch 按概览标题逐条取回、search 兜底）
- **输出**：三个可复制数字（CLI 标题总数 / 概览可见叶子标题数 / fetch 命中数）+ 碰撞组数与 `scanState`
- **四要素（写入 §12）**：
  - 触发条件：learning-capture 维度判定前，或 Memory 新增/合并后一个工作日内
  - 期望结果：CLI 计数 ≥ 概览可见计数；请求标题 fetch 全部命中；`0` 组同作用域精确碰撞、`2` 组近似、`scanState=scanned-present`
  - 判定规则：全部满足 → `clean`；CLI 有计数但 fetch 取不到 / `scanState` 非 `scanned-present` → `gap`；概览因 `N more…` 截断或窗口内 Episode 无 `checks` → `needs-more-evidence`
  - 停止条件：三步跑完即停；一旦发现需要处置近似重复组，立即停止并索取单独授权
- **验收标准**：整套检查在**不授权任何 Memory 改动**的前提下跑通并可再次复现（第二次执行数字一致）

### 任务 E：写入评审记录

- **修改文件**：`docs/技术债清单.md`（追加 §12，沿用 §11 段落风格）
- **输入**：任务 A–D 的实测输出
- **输出**：§12 = 源根对照表、两组计数与口径说明、"重复需求"的 `clean/gap/needs-more-evidence` 判定及证据、检索检查四要素、授权边界（近似组处置需单独授权）
- **验收标准**：`Select-String docs/技术债清单.md -Pattern "源根|needs-more-evidence|scanned-present"` 命中 ≥ 3 行；段落编号连续、无空占位；不新建第二份平行文档

### 任务 F：回归与全局校验

- **修改文件**：无
- **输入**：`npx prettier --check docs/技术债清单.md docs/plans/2026-10-04-learning-loop-retrieval-observability.md`、`npm run typecheck`、`npm run lint`、`npm test`
- **输出**：通过/失败清单
- **验收标准**：与"改动前基线"逐项对比，**零新增失败**；工作区既存的其他未提交改动导致的失败逐条标注"先于本次改动存在"并原样列出，不弱化
- **注意**：`docs/**` 不在 lint-staged/prettier 闸门作用域内（见 `AGENTS.md`「verify 与 pre-commit 闸门的差异」），故格式只作自查，不以此判定闸门通过

## 7. 红灯 / 绿灯映射（诚实声明，不伪造测试）

本任务是观测边界补齐，无产品代码缺陷可被单元测试复现，因此**不新增测试文件**。可判定回路改由命令承担：

- 红灯（可复现的既有状态）：`.qoder\better-harness\2026-10-03\213222-wxnn-xiangce-jiu\canvas.json` 中 lead 选择为 `0 of 0`，与同报告 session 通道 `113 会话 / 343 Episode` 不同基准。
- 绿灯（本次目标）：任务 B 的两次计数均 > 0 且基准字段可解释；或任务 C 明确归因后，§12 留下一条口径一致/差异说明。
- 若两者都达不到 → 判定停在 `needs-more-evidence`，并记录缺失的确切观测项，不得写成"回路有效"。

## 8. 执行结果（2026-10-04）

| 任务          | 结果             | 关键实测                                                                                                                                                                                                                                                                 |
| ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A 源根复核    | ✓                | CN home：5 启用根 / 2 存在 / 120 会话；默认 `~/.qoder` + global caps：6 启用根 / 1 存在 / 0 会话（逐字复现报告描述）                                                                                                                                                     |
| B 同窗口重跑  | ✓ 但假设被证伪   | 带 `--qoder-home` 的 bundle：`sessionEvidence.eligibleSessions=112` vs `lead...selection=0 of 0`，`bundle.status=complete`                                                                                                                                               |
| C 归因        | ✓ 确定性根因     | `report-run.mjs:159` 把 `qoder-home` 转成 `qoderHome`；`task-loop-source.mjs:1070-1082` 原样传递；`platforms/qoder.mjs:840` 只读 `home`/`qoder-home` → lead 永远落在默认 home                                                                                            |
| D 检索/新鲜度 | ✓ 发现第三个分叉 | 同一工作区两份 Memory 标题存储：IDE 活目录 105 条（最新 2026-10-04T01:42Z）vs CLI slug 命中的旧目录 63 条（最新 2026-10-02T14:51Z）；仅靠 `QODER_HOME` 时 `asset-baseline` 报 `scanned-empty / titleCount 0`；`SearchMemory fetch` 5/5 命中（含今日上一会话写入的 2 条） |
| E 记录        | ✓                | `docs/技术债清单.md` §12（含判定 `gap` 与可重复检查的触发/期望/判定/停止四要素）                                                                                                                                                                                         |

最终判定：**重复需求 = `gap`**（Agent 侧检索可用 = clean；Harness 观测通道失真 = gap；历史 Episode 是否发生过检索 = 仍为 needs-more-evidence）。完整证据见 §12。
