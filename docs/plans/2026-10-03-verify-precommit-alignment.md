# 提交前指引与实际闸门对齐（verify ↔ pre-commit）

- 日期：2026-10-03
- 方案：方案二（补齐只读格式检查 + 文档口径统一），非纯文档方案
- 状态：**已实施并全量回归通过**
- 关联：根 `AGENTS.md`「变更后验证工作流」、`.qoder/rules/project-conventions.md`「校验与提交」、`.husky/pre-commit`、`package.json` 的 `lint-staged`

## 1. 问题与结论

指引声称 `npm run verify:staged` "与 pre-commit 钩子等效"，实测不成立：

| 维度      | `.husky/pre-commit` 真实闸门                     | 改动前的 `npm run verify` / `verify:staged`     |
| --------- | ------------------------------------------------ | ----------------------------------------------- |
| 格式      | `prettier --write`，**改写文件并自动重新暂存**   | 完全不跑 prettier，纯格式问题也报"可以安全提交" |
| lint      | `eslint --fix`，可自动修复项被静默修掉           | `eslint` 只读，同样问题判 ✗                     |
| 单测      | `test:precommit` 仅由 `src/**/*.{ts,tsx}` 键触发 | 对所有变更 TS 文件跑 `findRelatedTests`（超集） |
| typecheck | 暂存含 TS/TSX 时 `tsc -b`                        | 同（一致）                                      |

结论：给 `verify` 补上**只读**格式检查，把"提交时会被改写"这件事提前暴露；剩余不对称用文档逐项写清。**钩子、`lint-staged` 配置、CI 一律不动，拦截只增不减。**

## 2. 依赖声明

- 新增/变更依赖：**0**。`prettier` ^3.9.5、`eslint`、`tsx`、`vitest`、`lint-staged` 均已在 `devDependencies`。
- 不修改 `package.json` / `package-lock.json` / `.prettierrc` / `.npmrc`；无需 `npm install`。

## 3. 启动说明

无进程启动。验证命令：

```bash
npx vitest run scripts/__tests__/verify-format-scope.test.ts   # 新增纯函数 + 契约 + 文档守护
npm run verify:staged                                          # 只读四步闸门
npm run typecheck ; npm run lint ; npm test ; npm run i18n:guard
```

## 4. 错误处理

| 分支                                 | 策略                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `package.json` 读取/JSON 解析失败    | 输出 `[VERIFY] ✗` 并 `exit 1`，**不静默降级为跳过**（避免假绿）                                                  |
| `package.json` 无 `lint-staged` 配置 | `[VERIFY] ⊘ 无格式化闸门，跳过格式检查`（与钩子行为一致）                                                        |
| lint-staged 键形态不受支持           | `[VERIFY] ⚠ 无法解析 lint-staged 键：<key>`，该键不纳入检查；契约测试会先失败，强制同步 `verify-format-scope.ts` |
| 无文件命中格式作用域                 | `[VERIFY] ⊘ 无命中钩子格式范围的变更文件，跳过格式检查`                                                          |
| prettier 报差异                      | `[VERIFY] ✗ 格式检查`，汇总行步骤名 `format`，提示改用 `npm run format` 自行落地                                 |
| 铁律                                 | 脚本全程只读：`prettier --check`（无 `--write`）、`eslint`（无 `--fix`），不产生任何文件写入                     |

## 5. 参数校验

- `parseFormatScopeKey(key: string)`：非字符串 / 空串 / 以 `!` 开头（否定 glob）/ 无 glob 的字面路径 / 花括号未闭合 → 返回 `null`。
- 仅接受四种形态：`<dir>/**/*.{a,b}`、`<dir>/**/*.a`、`*.{a,b}`、`*.a`；`dir` 支持多级与以点开头的目录名（`.storybook`）。
- `getPrettierKeys(cfg)`：任务为字符串或数组均支持；空对象/非对象 → `[]`。
- `selectFormatTargets(files, keys)`：`\` → `/` 归一化；去重且保持输入顺序；根作用域键要求路径不含 `/`；无扩展名路径不匹配。
- 行尾差异不参与判定：CLI 传 `--end-of-line auto`（本机 `core.autocrlf=true`，工作区 CRLF、提交内容 LF，按 `.prettierrc` 的 `endOfLine:"lf"` 直检工作区会系统性假失败，而钩子改写行尾并不改变提交内容）。**这是相对原计划在实现细节上的一处加强，语义与目的不变。**

## 6. 改动清单与验收

| 节点    | 文件（完整路径）                                                                        | 输入 → 输出                                                     | 验收标准                                                                                |
| ------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| N1 红灯 | `scripts/__tests__/verify-format-scope.test.ts`（新增）                                 | 目标模块不存在 → 用例失败                                       | `Error: Failed to load url ../verify-format-scope`，`Test Files 1 failed`（非语法错误） |
| N2 绿灯 | `scripts/verify-format-scope.ts`（新增）                                                | `files[]` + `lintStagedKeys[]` → 命中格式作用域的文件列表       | 上述单测全绿（现 32 用例）                                                              |
| N3 接线 | `scripts/verify-changes.ts`                                                             | 变更文件列表 → 四步检查（typecheck / lint / **format** / test） | 格式问题暂存文件由"通过"变 `✗ 格式检查` 且 `exit 1`；运行前后工作区与暂存 blob 哈希一致 |
| N4 文档 | `AGENTS.md`、`.qoder/rules/project-conventions.md`、`scripts/AGENTS.md`、`CHANGELOG.md` | 钩子与 lint-staged 配置事实 → 与之一致的口径                    | 文档守护测试通过；`AGENTS.md` 不再出现"与 pre-commit 钩子等效"                          |
| N5 回归 | —                                                                                       | —                                                               | `typecheck` exit 0；全量 `eslint .` exit 0；`npm test` 全绿；`i18n:guard` exit 0        |

## 7. 实测结果留档

- 场景 1（只含格式问题的暂存文件 `src/__verify_probe__.ts`）
  - 改前：`verify:staged` **exit 0**，输出"✓ 全部通过 — 可以安全提交"；`npx --no-install lint-staged` exit 0 且把 `probeFormat  = 1` 改写为 `probeFormat = 1` 并重新暂存。
  - 改后：`verify:staged` **exit 1**，`✗ 格式检查 (prettier --check, 1 个文件)`；运行前后 `git hash-object` 与 `git rev-parse :path` 同为 `bee8ada…`，`git status` 仅 `A `（无 ` M`）→ 只读语义成立。
- 场景 2（只含可自动修复 lint 问题 `src/__verify_probe2__.ts`，`@typescript-eslint/no-extra-non-null-assertion`）
  - `verify:staged` ✗ lint（提示 potentially fixable）；`lint-staged` ✓ 且 `input!!` → `input!` 改写重暂存 → 与文档"lint 严格度"行一一对应。
- 边界：仅 `docs/IPC_CONTRACT.md` → `⊘ 跳过格式检查`；暂存区为空 → 四步全 `⊘`，exit 0。
- 文档守护负向对照：HEAD 版 `AGENTS.md` 缺失 6/6 个 prettier 键且无「verify 与 pre-commit 闸门的差异」小节（即该测试在本次改动前必然失败）；工作区版 0 缺失。
- 回归：`tsc -b` exit 0；`eslint .` exit 0（零输出）；`npm test` 321 文件 / 5109 用例全绿；`npm run i18n:guard` exit 0；新单测 32 passed。
- 工作区无损：`git status` 快照 121 → 125 行，差异仅本次真实改动，无原有未提交改动被改变；探针与临时文件已删除，暂存区与 `git stash list` 均空。
- 未能通过（非本次引入）：`npm run audit` 因 `registry.npmjs.org/-/npm/v1/security/advisories/bulk` 请求失败（环境网络不可达）；本次 0 新增依赖，未触碰 `package.json` / lock / `audit-ci.jsonc`。CI 的 Security audit 步骤不受影响。

## 8. 不变量

- `.husky/pre-commit`、`package.json` 的 `lint-staged`、`.github/workflows/build.yml` 未被修改（mtime 早于本次改动）。
- `verify` 永远只读；需要落地修复时由开发者显式执行 `npm run format` / `npm run lint:fix`。
- 修改 `lint-staged` 键形态时必须同步 `scripts/verify-format-scope.ts`，否则契约测试与文档守护测试会先失败。
