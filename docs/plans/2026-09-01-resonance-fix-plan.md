# 实施计划：共鸣录 typecheck 与 DDL 防漂移测试修复（2026-09-01）

## 1. 依赖声明

- **新增依赖**：无。
- **变更依赖**：无。
- **安装方式**：无任何 npm 安装操作（本机有 Safe-Delete 网关，禁止 `npm ci`；本次不涉及）。

## 2. 启动说明

本任务为测试与类型层修复，无新服务/进程启动。

- **环境准备**：Node/npm 已就绪（沿用仓库现有 node_modules，零增量安装）。
- **验证命令**（均已在 package.json 中确认存在）：
  - `npm run typecheck` —— 期望 exit 0（修复后）
  - `npx vitest run src/main/database/resonance-repository.test.ts` —— 期望全部通过（修复后）
  - `npx vitest run` —— 全量基线：231 文件 / 4082 用例，仅 2 个既有环境性失败（`path-safety.test.ts`「只读目录返回 false」、`GalleryStackOverflow.test.tsx`）
  - `npm run lint` —— 基线：仅 `.cache/`、`e2e/fullscreen-diagnose.e2e.ts`、`scripts/after-pack-vc-runtime.cjs` 三处历史问题，不得新增

## 3. 错误处理

| 分支                       | 策略                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 修复后防漂移用例仍红       | 说明存在**真实** DDL 漂移（而非引号归一化问题）：逐字比对 connection.ts 迁移数组与 `RESONANCE_DDL_STATEMENTS`，同步两侧 DDL 后重跑；**不得改断言放行** |
| typecheck 出现基线外新错误 | 当场修复（仅限与本次改动直接相关的错误），不得跳过                                                                                                     |
| lint 出现基线外新问题      | 当场修复，不得弱化规则                                                                                                                                 |
| 全量回归出现基线外新失败   | 回滚本次改动定位根因，禁止调整基线                                                                                                                     |

日志输出：全程依赖 vitest / tsc / eslint 自身的 stdout（全量测试走后台重定向 `.x.log` 轮询）。

## 4. 参数校验

本次改动不新增任何运行时入参；两处修改均为编译期/测试期：

- **导入路径**（`src/renderer/preview/mock/resonance-mock.ts:13`）：路径必须解析到真实存在的模块 `src/shared/types/resonance.ts`，由 `tsc -b` 的 TS2307 检查兜底。该文件所需 6 个类型（`ResonanceGetDataResult` / `ResonancePullRow` / `ResonanceEditRow` / `ResonancePearpalRow` / `ResonanceEvoRow` / `ResonanceWardrobeData`）已确认导出。
- **测试行归一化**（`src/main/database/resonance-repository.test.ts` 防漂移用例）：输入为 connection.ts 的源码行（字符串）；边界处理——剥离行首 `['"]`、行尾 `['"]?,?`，覆盖单引号与双引号两种书写（prettier 对含内嵌单引号的字符串强制双引号）；空行/注释行天然不等于任何 DDL，不会误匹配。

## 5. 基础测试用例

### 正常（绿灯判定）

1. `npx vitest run src/main/database/resonance-repository.test.ts` 全部用例通过，含「防漂移：connection.ts 迁移数组内含与本文件一致的 DDL」。
2. `npm run typecheck` exit 0。
3. 全量 `npx vitest run` 与基线一致（仅 2 个既有环境性失败）。

### 异常（红灯留证，修复前必须处于失败状态）

1. 修复前 `npm run typecheck` 报 `TS2307: Cannot find module '../../shared/types/resonance'`（留证后修复）。
2. 修复前 `npx vitest run src/main/database/resonance-repository.test.ts` 防漂移用例失败，失败消息含 `resonance_pulls` 或 `resonance_wardrobe_items` 的 DDL 前缀（留证后修复）。

### 边界（防漂移守卫有效性）

1. 修复后防漂移用例仍能拦截**真实**漂移：若把 connection.ts 中任一条 DDL 行删除或改动，用例必须红（守卫未因本次修复而失效；以归一化逻辑覆盖双引号书写为前提推导，不做破坏性改动入仓）。

## 6. 改动清单（最小化）

| 文件                                             | 操作   | 改动                                                                                                                            |
| ------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `docs/plans/2026-09-01-resonance-fix-plan.md`    | NEW    | 本计划                                                                                                                          |
| `src/renderer/preview/mock/resonance-mock.ts`    | MODIFY | 仅第 13 行：`'../../shared/types/resonance'` → `'../../../shared/types/resonance'`                                              |
| `src/main/database/resonance-repository.test.ts` | MODIFY | 仅防漂移用例行归一化（约 299-303 行）：`replace(/^'/, '').replace(/',?$/, '')` → `replace(/^['"]/, '').replace(/['"]?,?$/, '')` |

## 7. 执行步骤（红灯→改→绿灯闭环）

1. **红灯一**：复跑 `npm run typecheck`，确认 TS2307 留证。
2. **修复一**：改 `resonance-mock.ts:13` 导入路径（局部替换 + 行尾转回 CRLF）。
3. **绿灯一**：重跑 `npm run typecheck` → exit 0。
4. **红灯二**：`npx vitest run src/main/database/resonance-repository.test.ts`，确认防漂移用例失败留证。
5. **修复二**：改行归一化剥离 `['"]`（局部替换 + 行尾转回 CRLF）。
6. **绿灯二**：重跑该测试文件 → 全部通过。
7. **全量回归**：后台全量 vitest + typecheck + lint 基线比对 + `git diff --numstat` 核对改动未被行尾放大。
