# 统一 .qoder/skills/*/SKILL.md 引用基准

> 本文为 2026-10-03 轮次快照，当前口径以主规约文档为准（生命周期/约定见根 AGENTS.md 与 docs/CODING_CONVENTIONS.md；通道见 docs/IPC_CONTRACT.md）。

## Summary

- 范围严格锁定 6 个 `SKILL.md`（`app-error-guide` / `component-scaffold` / `css-theme-guide` / `database-repository` / `ipc-handler` / `preload-namespace`）；不动 `references/*.md`、`README.md`、`VALIDATION_REPORT.md`、流程正文、示例代码与检查清单。
- 两类改动合并为一次归一：**文件相对路径 + 正确层级**。
  - `../../../../<root-rel>` → `../../../<root-rel>`（从 skill 目录到仓库根为 3 级）。
  - frontmatter 中 `.qoder/rules/project-conventions.md`（仓库相对） → `../../rules/project-conventions.md`（2 级文件相对，与正文已有写法对齐）。
- 正文已正确形式的 `../../rules/project-conventions.md`、`references/*.md`、`../app-error-guide/SKILL.md` 保持不变，只统一"错误形式"到"正确形式"。
- 无链接校验脚本 owner：`scripts/` 中现有 `check-doc-versions.ts` / `check-i18n-keys.ts` / `check-preview-drift.ts` 均非 markdown dead-link 校验；`.qoder/**` 在 `eslint.config.js` L453 被整体忽略。按用户"没有则不新增平行 owner"要求，**不新增脚本、不新增 npm script、不新增 vitest 用例**。

## Key Changes

### Step 0：写入计划文件

- 新建：`docs/plans/2026-10-03-unify-skill-reference-paths.md`（本文件）。
- 命名对齐 `docs/plans/` 现有 `YYYY-MM-DD-<slug>.md` 规则。

### Step 1：红灯复现（一次性 `Test-Path`，不入库）

- 逐条测试 15 处旧路径是否解析成功，输出全部应为 `False`（11 处越级 + 4 处仓库相对）。
- 目的：证明修复前"引用不解析"这一 bug 客观存在，符合用户"每个回归测试在修复前必须处于失败状态"的硬性要求。

### Step 2：修改 6 个 SKILL.md（共 15 处）

按文件分组，每处只改路径字符串，后续行内容一字不动。

**`preload-namespace/SKILL.md`（4 处）**

- L5 `- .qoder/rules/project-conventions.md` → `- ../../rules/project-conventions.md`
- L6 `- ../../../../src/main/preload/AGENTS.md` → `- ../../../src/main/preload/AGENTS.md`
- L7 `- ../../../../src/main/preload/ipc.ts` → `- ../../../src/main/preload/ipc.ts`
- L60 正文 `[Preload AGENTS.md](../../../../src/main/preload/AGENTS.md)` → `[Preload AGENTS.md](../../../src/main/preload/AGENTS.md)`

**`ipc-handler/SKILL.md`（4 处）**

- L5 `- .qoder/rules/project-conventions.md` → `- ../../rules/project-conventions.md`
- L6 `- ../../../../src/main/ipc/handlers/AGENTS.md` → `- ../../../src/main/ipc/handlers/AGENTS.md`
- L7 `- ../../../../src/main/ipc/validator.ts` → `- ../../../src/main/ipc/validator.ts`
- L75 正文 `[handlers/AGENTS.md](../../../../src/main/ipc/handlers/AGENTS.md)` → `[handlers/AGENTS.md](../../../src/main/ipc/handlers/AGENTS.md)`

**`css-theme-guide/SKILL.md`（3 处）**

- L5 `- .qoder/rules/project-conventions.md` → `- ../../rules/project-conventions.md`
- L6 `- ../../../../tailwind.config.ts` → `- ../../../tailwind.config.ts`
- L7 `- ../../../../src/renderer/styles/themes/soft-pink-luxury.css` → `- ../../../src/renderer/styles/themes/soft-pink-luxury.css`

**`app-error-guide/SKILL.md`（2 处）**

- L5 `- .qoder/rules/project-conventions.md` → `- ../../rules/project-conventions.md`
- L6 `- ../../../../src/shared/errors/app-error.ts` → `- ../../../src/shared/errors/app-error.ts`

**`component-scaffold/SKILL.md`（1 处，无仓库相对混用）**

- L5 `- ../../../../src/renderer/AGENTS.md` → `- ../../../src/renderer/AGENTS.md`

**`database-repository/SKILL.md`（1 处，无仓库相对混用）**

- L5 `- ../../../../src/main/database/media-repository.ts` → `- ../../../src/main/database/media-repository.ts`

不改动的正确形式（说明为何保留原样）：

- 正文 `[project-conventions.md §N](../../rules/project-conventions.md)`（已正确，2 级）。
- 正文 `references/*.md`（同 skill 目录内，正确）。
- `ipc-handler` L216 `[app-error-guide](../app-error-guide/SKILL.md)`（跨 skill 同级，正确）。

### Step 3：绿灯复验（一次性 `Test-Path`，不入库）

- 对 15 处新路径逐一 `Test-Path`，全部应返回 `True`。
- 顺带覆盖用户 validation 第三条：抽查一处 `src/main/ipc/validator.ts` 打开并核对内容与 Skill 描述（`wrapHandler` / `schemas` / `assertFile*Path` 等）一致。

### Step 4：全局回归

- `npm run lint`（用户 validation 第二条要求）——`.qoder/**` 已在 ESLint ignore，此次改动不会引入 lint 失败。
- `npm test`——SKILL.md 未被任何代码/测试引用（`Grep type=ts` 0 命中），全量应无变化。
- `npm run typecheck`——不受影响。
- 硬性要求：本次不引入任何 vitest 用例，`npm test` 前后计数一致；`npm run lint` 前后计数一致。

## Test Plan（对应"基础测试用例：正常 / 异常 / 边界"）

- **正常**：Step 3 逐条 `Test-Path` 15 处新路径 → 全部 `True`。
- **异常**：Step 1 `Test-Path` 15 处旧路径 → 全部 `False`（红灯证据）。
- **边界**：
  - 长度边界：`component-scaffold` / `database-repository` 只有 1 处越级、无仓库相对 → 只改 1 行，验证不会被"统一"逻辑误改。
  - 混用消除：修改后 `Grep` 6 个 SKILL.md 内不再出现 `../../../../`；frontmatter 不再出现以 `.qoder/` 开头的仓库相对项。
  - 引用一致性：抽查 `src/main/ipc/validator.ts` 打开后确有 Skill 描述的 `wrapHandler` / `schemas.filePath*` / `assertFile*Path` 导出。

## Assumptions

- Qoder Skill 的 `references:` 字段按文件目录（skill dir）解析（用户"从 skill 目录到仓库根为 3 级"的表述即此含义）。
- 计划落盘位置选 `docs/plans/` 与既有 `2026-10-01-fix-thumbnail-review-fixes.md` 同层同规则；`.qoder/specs/` 已被 `.gitignore` 覆盖，不满足"写入仓库"要求。
- 不新增链接校验 owner 的具体边界：不加 `scripts/check-doc-links.ts`、不加 `package.json` script、不加 `*.test.ts` 用例；一次性 `Test-Path` 输出仅打印到控制台，不写入仓库。
- Step 1/3 的 `Test-Path` 输出以 `True/False` 逐行方式给出，作为红灯/绿灯可判定证据。

## 依赖 / 启动 / 错误处理 / 参数校验（对齐 plan 模板 5 项）

- **依赖声明**：0 新增；仅使用仓库现有 Node/PowerShell + `npm run lint` / `npm test` / `npm run typecheck`。
- **启动说明**：无进程启动。验证 = `Test-Path` 逐条 + `npm run lint` + `npm test`（`npm run verify` 覆盖范围不含 markdown，跳过）。
- **错误处理**：
  - 若 Step 3 出现任一 `False` → 停止，重新读取实际路径后修正，重跑 Step 2/3；不得强行提交。
  - 若 Step 4 `npm run lint` / `npm test` 出现与本次改动无关的既有失败 → 记录 baseline 与当次输出对比，仅在"新增失败项"存在时阻断。
- **参数校验**：本次无 CLI 入参。SearchReplace 严格匹配"层级修正"字符（`../../../../` → `../../../`；`.qoder/rules/project-conventions.md` → `../../rules/project-conventions.md`），不做通配；每处唯一命中。

## 每个子任务的验收标准（可判定）

| 节点   | 输入                         | 输出                                                   | 验收标准                                                                                                                   |
| ------ | ---------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Step 0 | 本 plan 全文                 | `docs/plans/2026-10-03-unify-skill-reference-paths.md` | 文件存在；`git check-ignore` 不命中；命名符合 `docs/plans/` 现有 `YYYY-MM-DD-*.md` 格式                                    |
| Step 1 | 15 处旧路径                  | `Test-Path` 输出 15 行 `False`                         | 输出中不含 `True`；作为红灯证据                                                                                            |
| Step 2 | 6 个 SKILL.md 完整路径与行号 | 15 处 SearchReplace 全部成功                           | `Grep '.qoder/skills' -Pattern '\.\./\.\./\.\./\.\./'` 结果为空；frontmatter 不再出现以 `.qoder/` 开头的仓库相对项         |
| Step 3 | 15 处新路径                  | `Test-Path` 输出 15 行 `True`                          | 全部为 `True`；抽查 `src/main/ipc/validator.ts` 打开可见 `wrapHandler` / `schemas` / `assertFile{Read,Write}Path` 三项导出 |
| Step 4 | `npm run lint` / `npm test`  | 与改动前相同的通过/失败计数                            | `npm run lint` exit 0；`npm test` 通过数与失败数与 Step 2 前 baseline 一致                                                 |
