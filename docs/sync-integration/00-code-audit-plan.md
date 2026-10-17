# 同步集成 · 阶段 0：代码探查计划（00-code-audit-plan）

> 路径作用域：本文为阶段计划/审计报告快照，文中 `src/xxx`、`scripts/xxx` 形式的路径混指本仓与上游 NikkiSync 仓；属上游或当时设计未落地的项按原文保留、不覆写，读者请勿默认它们能在本仓解析。

> 状态：已批准并执行
> 对应交付物：工作区根 `00-code-audit-report.md`（唯一真相源），本目录留存副本。
> 本阶段为只读探查 + 环境准备，不修改两个项目的任何源码、配置或既有测试。

## 1. 目标

完成 WXNN XiangCe（NikkiGallery）与 NikkiSync 集成前的环境准备与深度代码探查，输出可指导后续所有阶段的《代码探查报告》，回答 10 个既定问题（运行时/工具链、协议层、数据模型、PC 服务端、WXNN 数据库层、媒体类型、扫描器、IPC 与设置页、可复用工具、测试组织）。

## 2. 依赖声明

- **外部依赖**：
  - Node.js ≥ 24（本机实测 v26.3.0，同时满足 WXNN engines ≥22.12 与 NikkiSync engines ≥24）
  - npm ≥ 11（本机 11.16.0）、git（本机 2.55.0.windows.2）
- **仓库依赖**：
  - WXNN XiangCe：node_modules 已存在（827 项，electron 41.10.6 / better-sqlite3 12.11.1 / vitest 5.0.3 / @playwright/test 1.62.1 已实装）；本阶段执行 `npm install` 幂等确认
  - NikkiSync：node_modules 此前不存在；本阶段执行 `npm install` 全新安装（npm workspaces，无原生模块，仅需 typescript/esbuild/qrcode 等）
- **本阶段新增依赖**：无（验证脚本仅用 Node 内置 `node:test` / `node:assert/strict` / `node:fs` / `node:path`）

## 3. 启动 / 验证方式

| 动作                  | 命令                                                                    | 期望                                       |
| --------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| NikkiSync 装依赖      | `cd NikkiSync && npm install`                                           | 退出码 0，node_modules 出现且含 typescript |
| WXNN 幂等装依赖       | `cd "WXNN XiangCe" && npm install`                                      | 退出码 0，无新增变更                       |
| 红灯校验              | `node --test docs/sync-integration/verify-audit.mjs`（WXNN 根目录执行） | 报告未写时**必须失败**（红灯）             |
| 绿灯校验              | 同上（报告写完后重跑）                                                  | 全部断言通过（绿灯）                       |
| 回归门禁（WXNN）      | `npm test`、`npm run typecheck`、`npm run lint`                         | 无新增失败                                 |
| 回归门禁（NikkiSync） | `npm test`、`npm run db:validate`                                       | 无新增失败                                 |

## 4. 错误处理策略

1. **断言失败即停**：verify-audit.mjs 用 `node:assert/strict`，任一断言失败输出“失败断言名 + 实际值 + 期望值”，不吞错、不降级跳过。
2. **安装失败**：npm install 非零退出时先读完整 stderr；engines 不满足则升级/切换 Node，网络镜像问题参照 WXNN 既有 `.npmrc` 与 `docs/troubleshooting-npm-audit-mirror.md` 的处理方式；解决前不进入下一步。
3. **回归失败甄别**：本阶段不触碰 src/，若 `npm test` / `typecheck` / `lint` 出现失败，先用 `git stash` 验证失败在改动前即存在（预先存在的基线失败记录进报告“风险清单”，不视为新增失败）；无法甄别则修复后重跑。
4. **脚本自身出错**（如源文件被移动导致读不到）：按断言失败处理并修正脚本路径清单，禁止放宽断言来“变绿”。

## 5. 参数校验规则

- verify-audit.mjs 启动时先校验两个项目根目录存在（`package.json` 可读且 name 符合预期：`wxnn-photo-manager` / `nikkisync`），否则直接失败。
- 版本比较统一用 semver 三段数字比较，不信任字符串比较：`nodeMajor >= 24` 边界判断取 `process.versions.node` 与 electron 实测输出。
- 文件存在性校验一律用绝对路径 + `fs.existsSync`，路径清单硬编码在脚本内（与报告“关键文件清单”一一对应）。
- 内容校验（DDL/路由/错误码）用精确子串匹配锚定行，避免宽松正则误判（如 `sha256` 列检测必须排除注释与 `phash` 干扰：匹配建表语句块而非全文件）。

## 6. 基础测试用例

验证脚本 `verify-audit.mjs`（node:test，顶层 test() 函数）：

**正常用例**

- T1 两项目 package.json 可读，name/engines 与预期一致
- T2 WXNN：node_modules/electron 实装版本 = package.json 声明的 41.10.6；`ELECTRON_RUN_AS_NODE` 实测内置 Node 主版本 ≥ 24
- T3 WXNN：connection.ts 中 media_files 建表语句块包含全部 19 个基础列名，且该块中不出现 `sha256` 列定义（`phash TEXT` 存在于 safeEnsureColumn 调用中）
- T4 NikkiSync：packages/protocol/src/index.ts 包含 12 条 API_ROUTES、9 个 API_ERROR_CODES、4 个 X-NikkiSync-* 认证头
- T5 NikkiSync：`npm install` 后 node_modules/typescript、node_modules/qrcode 存在
- T6 报告存在（根 + docs 副本）且报告中声明的全部关键文件路径真实存在

**异常用例**

- T7 报告文件缺失 → 断言失败并输出缺失路径（红灯状态的预期失败原因）
- T8 关键路径清单中任一文件不存在 → 失败并列出全部缺失项（一次收集，不逐个中断）

**边界用例**

- T9 Node 版本边界：24.0.0 视为满足（≥），23.x 不满足
- T10 NikkiSync engines `>=24.0.0` 与本机 Node 26.3.0 的满足性判断

## 7. 需修改/新增文件及输入输出

| 路径（绝对）                                                                      | 操作 | 输入 → 输出                                                          |
| --------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------- |
| `D:\Zcode项目\WXNN YD\WXNN XiangCe\docs\sync-integration\00-code-audit-plan.md`   | 新建 | 本计划内容                                                           |
| `D:\Zcode项目\WXNN YD\WXNN XiangCe\docs\sync-integration\verify-audit.mjs`        | 新建 | 读两项目源码/package.json/路径清单 → node:test 断言结果（红灯/绿灯） |
| `D:\Zcode项目\WXNN YD\00-code-audit-report.md`                                    | 新建 | 探查结论（最终交付物，唯一真相源）                                   |
| `D:\Zcode项目\WXNN YD\WXNN XiangCe\docs\sync-integration\00-code-audit-report.md` | 新建 | 根目录报告副本（入 git 跟踪，注明真相源位置）                        |

不修改任何 `.ts/.tsx/.json/.cjs` 源码与配置；NikkiSync 仓库本阶段零改动（依赖安装产物已被 .gitignore 覆盖），故不建分支、不提交。

## 8. 可判定的验收标准（阶段收尾时已全部验证通过）

1. [x] 报告中 10 个问题每问均有明确答案，全文无“待确认”字样
2. [x] 报告列出的文件路径全部真实存在（T8 断言通过，100 条路径）
3. [x] 明确结论：WXNN XiangCe 的 Electron 内置 Node = 24.18.0，≥ 24（T2 通过，实测）
4. [x] 明确结论：media_files 表无 sha256 字段，仅有 phash 感知哈希列（T3 通过）
5. [x] 两个项目 `npm install` 退出码 0（NikkiSync 新装 75 包；WXNN 幂等确认）
6. [x] 红灯→绿灯流程已执行（红灯：仅 T6 报告缺失失败；绿灯：9/9 通过）
7. [x] WXNN `npm test`（338 文件/5356 测试全过）/ `typecheck` / `lint`（0 error，11 个存量 warning）与 NikkiSync `npm test`（131/131）/ `typecheck` / `db:validate` 无新增失败；详见报告“附：验证记录”
8. [x] WXNN XiangCe 在独立分支 feature/sync-integration-00-audit 上完成 Conventional Commits 提交

## 9. 分支与提交

- WXNN XiangCe：`git checkout -b feature/sync-integration-00-audit`，阶段结束时一次 commit：`docs(sync-integration): 阶段0代码探查计划与验证脚本、探查报告副本`
- NikkiSync：无源码改动，留在 main；后续阶段的源码改动将按纪律在独立分支进行
