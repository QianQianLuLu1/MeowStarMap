# 2026-10-27 修复 `npm run test` 报错并全绿（Node 26 环境迁移收口）

> 状态：已执行完毕，五项终验全绿。本文档为实施计划 + 执行记录（读数见 §六）。

## 一、诊断结论（只读定位，执行阶段以实测基线为准）

### 根因 1（主因，依赖环节）：better-sqlite3 原生二进制与 Node 26 ABI 不匹配

- 本机 Node 已是 **v26.3.0**（实测 `node --version`），但今日早前工作记录（`docs/plans/2026-10-27-*.md`）显示当时还是 Node 22——本机 Node 在今日测试跑完之后被升级过。
- `package-lock.json` 于今日 22:07 被重写（-48 行，全是可选依赖的 `libc` 字段），属新版 npm 的锁文件规范化，佐证「Node 升级后跑过 npm install」。
- `node_modules/better-sqlite3/build/Release/better_sqlite3.node` 时间戳仍是 **2026-10-09**（Node 22 ABI 下编译）。npm install 不会因宿主 Node 升级而重建未变版本的原生包。
- better-sqlite3 是全仓**唯一**绑定 V8 ABI 的原生模块（已排查：@rollup、@oxc-parser、@oxc-resolver 为 N-API；koffi、@img/sharp 为 N-API/独立二进制，均跨 ABI 稳定）→ Node 26 下 `require('better-sqlite3')` 抛 `ERR_DLOPEN_FAILED`（NODE_MODULE_VERSION 不匹配）→ 所有真实 sqlite 套件（`src/main/database` 等）连坐报红。
- 脚本环节无问题：`npm run test` = `vitest run`（package.json:49），vitest 5.0.3 engines 为 `^22.12.0 || ^24.0.0 || >=26.0.0`，Node 26 兼容。

### 根因 2（测试用例环节，历史失败现已自然消解，无需改代码）

- 今日文档记录的唯一基线失败：`src/main/nikkisync/probe.test.ts:176` 断言「本地宿主 Node 主版本 ≥ 24」，在当时 Node 22 下红。当前宿主 26.3.0，断言自然满足；且 `@nikkisync` 链接在位（node_modules/@nikkisync 四包齐全），describe 块会真实运行并转绿。
- 立场：**不回退 Node、不改弱该断言**。回退 Node 22 会让它重新变红，唯一出路是跳过/弱化测试，与「不得跳过、不得弱化」约束直接冲突；Node 26 是唯一能让全部约束同时成立的路径。

### 环境面（与测试无关，如实报告不动手）

- `release-sync/win-unpacked` 为打包产物残留（未跟踪），不属本轮范围。
- `package-lock.json` 的 -48 行 libc 变更为环境所致，保留现状、如实报告，不擅自还原或顺手提交。

## 二、实施计划（节点制，每节点红灯→绿灯闭环）

### 节点 0：计划落盘

- 修改文件：`docs/plans/archive/2026-Q4/2026-10-27-fix-test-suite-under-node26.md`（本文件）
- 验收：文件存在且内容与本计划一致

### 节点 1：基线红灯（复现）

- 无文件修改；只运行：
  1. `node -e "require('better-sqlite3')"` — 预期 exit≠0，报 NODE_MODULE_VERSION 不匹配（最小复现）
  2. `npm run test` 全量 — 捕获失败清单（文件级 + 用例级）
- 输出：失败清单，逐条归因为「依赖装载 / 测试逻辑 / 环境」三类
- 验收：失败项与诊断一致。清单外失败逐项开新节点沿用同流程；若 require exit 0（预判推翻），以全量套件真实失败清单为准。

### 节点 2：修复（首选零代码改动）

- 无源码修改；执行 `npm rebuild better-sqlite3`（重跑 install 脚本 `prebuild-install || node-gyp rebuild --release`；better-sqlite3 12.11.1 engines 官方支持 26.x）
- 转绿验证（顺序）：
  1. `node -e "require('better-sqlite3')"` exit 0
  2. `npx vitest run src/main/database` 全绿
  3. `npm run test` 全量 exit 0、0 failed
- 错误处理（兜底链，按序降级，逐级留日志）：
  a. prebuild-install 网络失败 → node-gyp 本地编译（需 MSVC）
  b. 编译失败 → `npm ci` 全量重装（npm cache 已有今日 22:07 包体）
  c. 仍失败 → 停下如实报告，提出替代方案供确认（不擅自弱化测试凑绿）

### 节点 3：终验五连（按指定顺序，逐项记录结果）

| #   | 命令                | 验收标准                                                                                                                                                        |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `npm install`       | exit 0；记录 lockfile 是否再变化                                                                                                                                |
| 2   | `npm run build`     | exit 0（clean + electron-vite build + dist/main/package.json 写入）                                                                                             |
| 3   | `npm run test`      | exit 0，0 failed                                                                                                                                                |
| 4   | `npm run typecheck` | exit 0                                                                                                                                                          |
| 5   | `npm run e2e:smoke` | 预期 10 passed / 6 skipped / 0 failed（沿用今日 dist:win 产出的 2.5.6-beta 产物；本轮零产品代码改动，产物仍有效；第 2 步已刷新 dist/main，dist-guard 判据满足） |

- 任一项失败 → 就地修复（同红灯-绿灯流程）后从该项重跑，不得跳过。

### 节点 4：收尾

- 回写本文档的执行结果段落（各节点读数）。
- 仅提交计划文档（Conventional Commits：`docs(plans): ...`）；提交前跑 `npm run verify` 确认只读四项干净；环境性变更（lockfile）单独说明、不混入提交。提交后 `git status --porcelain` 复核钩子未留残物。

## 三、计划必备五要素

1. **依赖声明**：零新增、零变更。better-sqlite3 保持 `^12.11.1`（engines 含 26.x），仅按 Node 26 重建二进制；兜底 `npm ci` 也不改任何版本号。
2. **启动说明**：环境 = Windows x64 + Node v26.3.0（当前 PATH 实测）+ 现有 node_modules；无需启动任何服务；验证方式 = 五条终验命令 + `node -e` 装载探针。
3. **错误处理**：节点 2 兜底链 a→b→c；全程逐步留输出日志；任何失败不掩盖、不弱化、不跳过。
4. **参数校验**：探针判定 = 进程 exit code；单测判定 = vitest 汇总行（Test Files / Tests / failed 三数）；e2e 判定 = playwright 汇总行（passed / skipped / failed 三数）；typecheck/build/install 判定 = exit 0。
5. **基础测试用例**：正常（require 成功 + `src/main/database` 套件绿）/ 异常（修复前 require 抛 NODE_MODULE_VERSION 错，红灯固化于节点 1）/ 边界（prebuild 缺失时 node-gyp 兜底路径可走通）。

## 四、改动范围与纪律

- 预计**零源码改动**（纯环境修复）；若节点 1 暴露清单外逻辑失败，逐项最小修复，不做顺手重构/格式化。
- 不动 `release-sync/`；不还原 `package-lock.json`；本轮所有提交仅含计划文档与必要的清单外修复。

## 五、子任务一览

| 子任务   | 文件                                                                 | 输入/输出                      | 验收标准                           |
| -------- | -------------------------------------------------------------------- | ------------------------------ | ---------------------------------- |
| 计划落盘 | docs/plans/archive/2026-Q4/2026-10-27-fix-test-suite-under-node26.md | 本计划 → MD 文档               | 文件存在、内容一致                 |
| 红灯复现 | 无                                                                   | 运行探针 + 全量测试 → 失败清单 | 清单与诊断一致                     |
| ABI 修复 | 无（node_modules 二进制）                                            | npm rebuild → 二进制重建       | require exit 0；全量 test 0 failed |
| 终验五连 | 无                                                                   | 五命令依次执行 → 结果记录      | 五项全绿、逐项说明                 |
| 收尾提交 | docs/plans/archive/2026-Q4/2026-10-27-fix-test-suite-under-node26.md | 回写结果 + commit              | verify 干净、工作区无意外残物      |

## 六、执行记录（2026-10-27 深夜回写）

### 结论先行

`npm run test` 的报错**已不再复现**：全量套件在 Node v26.3.0 下 451 文件全过、0 failed。两条历史报错均已被环境变化消解，本轮**零源码改动**，五项终验全绿。

### 节点 0：计划落盘 ✅

本文件创建，内容与批准计划一致。

### 节点 1：基线红灯（复现）——预判推翻，套件本就全绿 ✅

| 命令                                  | 结果                                                                                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node -e "require('better-sqlite3')"` | **exit 0**（`LOAD-OK`）——「ABI 不匹配」预判被推翻：better-sqlite3 12.11.1 的二进制在 Node 26 下可正常装载（10-09 产物未过时，或该版本已走 N-API 兼容面）       |
| `npm run test`（全量）                | **exit 0**：`451 passed (451)` 文件、`7026 passed \| 12 skipped (7038)` 用例，74.25s；12 skipped 为既有基线（链接门控/平台条件跳过），与今日文档记录的规模一致 |

归因落定：

- `probe.test.ts:176`（断言宿主 Node ≥ 24）：历史红发生在本机 Node 22 时代；现宿主 26.3.0，断言自然满足，**无需改代码**。
- better-sqlite3 装载：实测无碍。诊断中的「ABI 连坐」假设不成立，节点 2 的 `npm rebuild` 不执行（避免无谓变更）。

### 节点 2：修复——判定不需要 ✅

无源码改动；rebuild 未执行（理由见上）。

### 节点 3：终验五连（全绿）✅

| #   | 命令                | 结果                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `npm install`       | exit 0；`git diff --stat package-lock.json` 与安装前**完全一致**（仍是既有的 -48 行 libc 规范化，无新增变化）。**副作用**：npm 把 lockfile 之外的 `node_modules/@nikkisync/*` junction 当 extraneous 清空（目录 mtime 23:33），导致链接门控套件整批 skip（448 文件 passed / 3 skipped、56 用例 skipped）→ 用仓内 `npm run link:nikkisync` 重建 4 个 junction 恢复 |
| 2   | `npm run build`     | exit 0（clean + electron-vite build + dist/main/package.json，6.72s）                                                                                                                                                                                                                                                                                             |
| 3   | `npm run test`      | 链接重建后 exit 0：`451 passed (451)` 文件、`7026 passed \| 12 skipped (7038)` 用例，70.91s，0 failed                                                                                                                                                                                                                                                             |
| 4   | `npm run typecheck` | exit 0（`tsc -b` + `tsc -p tsconfig.scripts.json`）                                                                                                                                                                                                                                                                                                               |
| 5   | `npm run e2e:smoke` | exit 0：**16 passed (24.6s)**，0 failed——优于计划预期的「10 passed / 6 skipped」；S4 读到 2.5.6-beta 产物、S8 GPU 探针通过（RTX 5070，D3D11 硬件加速开启）                                                                                                                                                                                                        |

### 节点 4：收尾 ✅

- 本节读数已回写；`npm run verify` 提交前确认（读数见提交记录）；仅提交本计划文档。
- 工作区遗留：`package-lock.json` 既有 -48 行（环境所致，不混入提交）、`release-sync/`（打包残留，不动）。

### 经验沉淀（给后续轮次）

1. **`npm install` 会清掉 `@nikkisync` 手工链接**：每次 npm install 后必须补跑 `npm run link:nikkisync`，否则链接门控套件（probe / sync-server.linked 等 3 文件 44 用例）静默转 skip——exit 0 不代表套件跑全了，核对 Test Files 数（应 451 全 passed 而非 448+3 skipped）。
2. 本机 Node 已是 v26.3.0（今日从 22 升级）；CI 仍按 `.node-version`=22 跑，probe 的 `>=24` 断言靠「CI 无链接 → skipIf」维持两侧行为一致，勿在 CI 建立该链接。
