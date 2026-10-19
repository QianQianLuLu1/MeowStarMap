# 整合 · 阶段 1：NikkiSync 依赖链接计划（01-dependency-link-plan）

> 路径作用域：本文为阶段计划/审计报告快照，文中 `src/xxx`、`scripts/xxx` 形式的路径混指本仓与上游 NikkiSync 仓；属上游或当时设计未落地的项按原文保留、不覆写，读者请勿默认它们能在本仓解析。

> 状态：已批准（2026-10-12）｜ 目标：把 NikkiSync 变成 WXNN XiangCe 可直接 import 的内部依赖，并在主进程完成四包 import 验证
> 基线提交：`WXNN XiangCe` = `9815e68`（分支 `feat/gallery-runtime-embed`）、`NikkiSync` = `b2eb337`（分支 `feat/gallery-runtime-embed`）
> 前置阅读：[`00-nikkisync-pc-audit-report.md`](./00-nikkisync-pc-audit-report.md)（Phase 0+ 运行时嵌入盘点，本计划的兼容性结论直接引用其 §4/§11）
> 核心原则：**直接复用 NikkiSync 代码，不重写、不复制源码到 WXNN XiangCe 目录**

## 0. 与既有 01…07 号文档的关系

`docs/sync-integration/` 下的 `01-protocol-port-plan.md` … `07-bidirectional-sync-plan.md` 属于**协议移植轨道**：把上游协议/服务逐字移植进 `src/shared/sync/`、`src/main/sync/`、`src/main/database/sync-*-repository.ts`。

本文件开启的是**直接依赖链接轨道**（整合阶段 1）。两者的并存是本阶段的既定结果，不是遗漏：

- `src/shared/sync/protocol.ts` 是已冻结的跨进程契约，本阶段**禁改、不删、不动**，也不去重。
- 收敛策略（哪一侧成为唯一真相源、移植面如何退役）当时登记为延后项（见 §14 R4）；
  **已于阶段 9 定案**：vendored `src/shared/sync/protocol.ts` 为唯一真相源，
  见 [`09-legacy-debt-remediation-plan.md`](./09-legacy-debt-remediation-plan.md) §5。

## 1. 目标与范围

**做**：

1. 建立 `WXNN XiangCe → NikkiSync` 的包级链接关系，使 `@nikkisync/{core,database,protocol,pc-companion}` 在主进程可解析。
2. 处理 Node.js 版本与 SQLite 驱动兼容（结论：无需处理，见 §4）。
3. 打通 TypeScript 类型解析与 Electron 主进程构建管线。
4. 交付一个最小 import 验证探针，在**本地 Node** 与 **Electron 内置 Node** 两种宿主下均通过，逐项确认导出非 `undefined`。

**不做**（超出本阶段即视为越界）：

- 不修改 NikkiSync 任何源码/配置（业务逻辑、package.json、tsconfig 一律不动）。
- 不启动 Runtime 的 scanner / LAN 服务 / mDNS / TLS 监听（规避 Phase 0 风险 R2 与端口副作用）。
- 不做双向同步功能、不退役移植面、不接入渲染进程。
- 不跑 `dist:win` 全量打包（按用户选择只验证到 `npm run build` + Electron 探针，见 §9 步 6-7）。

## 2. 探查结论（计划依据）

所有条目均为本阶段只读实测，不含假设：

| 项                                             | 值                                                                                                                   | 证据                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| XiangCe Electron 声明                          | `41.10.6`（精确锁，非 `^`）                                                                                          | `WXNN XiangCe/package.json:173`                                                     |
| Electron 内置 Node                             | **24.18.0**（≥ 24 满足 NikkiSync `engines`）                                                                         | Phase 0 §11.1 探针 P1                                                               |
| Electron 内 `node:sqlite`                      | **可用**（建表/插入/查询通过）                                                                                       | Phase 0 §11.1 探针 P2                                                               |
| XiangCe `@types/node` 实装                     | 22.20.1，**已自带 `sqlite.d.ts`**                                                                                    | `node_modules/@types/node/sqlite.d.ts` 存在（本阶段实测）                           |
| NikkiSync 产物 d.ts 是否静态引用 `node:sqlite` | 否，grep 零命中                                                                                                      | `packages/*/dist/src/*.d.ts`、`apps/pc-companion/dist/src/*.d.ts`                   |
| `@nikkisync/*` 能否从 registry 获取            | **不能**，`npm view @nikkisync/core` → 404                                                                           | 本阶段实测（且四包均 `private: true`）                                              |
| 工作区根 `d:\Zcode项目\WXNN YD`                | **非 git 仓库、无 package.json**                                                                                     | `.git` 不存在；根目录仅 `.zcodeignore` + 两份 md                                    |
| XiangCe 主进程产物形态                         | Vite lib **CJS**（`formats: ['cjs']`）+ node_modules 全外部化 + `dist/main/package.json {type:commonjs}`             | `electron.vite.config.ts:94`、`:61-64`、`:46-54`、`package.json:35`                 |
| NikkiSync ESM 图硬约束                         | 含 top-level await ⇒ `require()` 抛 `ERR_REQUIRE_ASYNC_MODULE`                                                       | `packages/database/src/database-manager.ts:15`；Phase 0 探针 P4                     |
| `DatabaseManager.initialize()` 定位 SQL        | `new URL('../../migrations/0001_initial.sql', import.meta.url)`                                                      | `packages/database/src/database-manager.ts:48`                                      |
| `@nikkisync/pc-companion` 无 `types` 字段      | 但 `dist/src/index.d.ts` 实际存在 ⇒ node10/bundler 回落 `main` 均可命中                                              | `apps/pc-companion/package.json:6`；`Test-Path` 为 True                             |
| NikkiSync 运行时第三方依赖                     | 仅 `qrcode@1.5.4`（两侧同版本），**无原生模块**                                                                      | `apps/pc-companion/package.json:13-20`                                              |
| CI 形态                                        | 5 个 job 均在**只 checkout 本仓库、Node 22** 的环境执行 `npm ci` / `npm test` / `npm run build` / `npm run dist:win` | `.github/workflows/build.yml:29-51`、`:122-130`、`:177-193`、`.node-version` = `22` |
| ESLint 关键护栏                                | `no-explicit-any: error`；`no-restricted-syntax` 中文硬编码 = error（`src/**`）                                      | `eslint.config.js:99`、`:116`                                                       |

**基线红灯（阶段 7 未提交 WIP 所致，本阶段不修、不掩盖，仅作比对基准）**：

| 门禁                 | 基线实测                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`  | 退出码 2；2 错：`src/main/database/sync-read-repository.ts(125,26) TS2503`、`(231,5) TS2322`                                           |
| `npm run lint`       | 退出码 1；`12 problems (1 error, 11 warnings)`，error 为 `sync-read-repository.ts:6:8 'AssetDetailResponse' is defined but never used` |
| `npm run test:main`  | 退出码 1；`Test Files 5 failed / 183 passed (188)`、`Tests 17 failed / 3484 passed / 2 skipped (3503)`                                 |
| NikkiSync `npm test` | 见 §15 执行记录（Phase 0 记录为 131/131 通过）                                                                                         |

## 3. 整合方案选型

| 方案                 | 做法                                                        | 判定                  | 理由                                                                                                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. npm workspace     | 在工作区根建 workspace，XiangCe 按包名引用                  | **否**                | 根目录不是任何仓库、无 package.json ⇒ 需造一个不受 git 跟踪的第三个"根"；同时把两侧 node_modules 提升合并，牵动 `better-sqlite3`/`sharp`/`koffi` 的重编译与 NikkiSync 自有 workspace（`apps/*`/`packages/*`/`tools/*`），违背"最小改动 + NikkiSync 测试不受影响" |
| B. `file:` 依赖      | XiangCe `dependencies` 写 `file:../NikkiSync/...`           | **采用**              | npm 原生 link 形态，无需新机制；TS/Node 经 `node_modules/@nikkisync/*` 正常解析；electron-builder 会把 `@nikkisync/*` 认作生产依赖纳入打包（这是 symlink 脚本做不到的）；两侧仓库保持独立，NikkiSync 零改动                                                      |
| C. 独立子进程        | Runtime 独立 Node 24 进程 + IPC/HTTP                        | **否**                | 任务书限定"仅在 Node 版本无法统一时采用"，前提不成立（§4）；代价还要重做 mDNS 组播归属、TLS 私钥跨进程边界、崩溃重启语义                                                                                                                                         |
| D. 手工 symlink 脚本 | `scripts/link-nikkisync.mjs` 建 junction，不写 package.json | **作为 §10 降级路径** | CI/lockfile 完全不受影响，但 electron-builder 不认它（需额外 `build.files` 显式补），且 `npm install` 会把 junction 当外物清除，需重跑脚本                                                                                                                       |

选 B 的已知代价：`npm ci` 在拿不到 `../NikkiSync` 的环境（XiangCe CI、他人克隆）会失败 —— 用户已明确接受并选择"本阶段不动 `build.yml`"，处置候选登记在 §14 R1。

补充机制（B 的必要配套，非新方案）：因 NikkiSync ESM 图含 TLA 且 XiangCe 主进程产物为 CJS，运行时取值只能走**变量式 `await import()`**。这是 ESM/CJS 互操作的标准写法，不引入任何自定义模块加载器；类型面走 `import type`（编译期擦除，不产生 `require`）。

## 4. Node.js / SQLite 兼容性处理：什么都不做（附证据）

| 路线                                                | 是否需要   | 判定依据                                                                                                                                                                      |
| --------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 升级 Electron 至内置 Node ≥ 24                      | **不需要** | 实装 41.10.6 已含 Node 24.18.0；升级反而触发 `build.npmRebuild` 下的 better-sqlite3/sharp/koffi 重编译                                                                        |
| 在 `packages/database` 做 better-sqlite3 驱动抽象层 | **不需要** | 探针 P2 证明 Electron 内 `node:sqlite` 可建表/查询；且改驱动层要牵动 131 个测试全量回归                                                                                       |
| 独立子进程跑 Runtime                                | **不需要** | 探针 P3 证明整个 Runtime 在 Electron 进程内 `import()` → `start()` → `stop()` 可跑通                                                                                          |
| 升 `@types/node` 到 `^24`                           | **不需要** | 22.20.1 已含 `sqlite.d.ts`，且 NikkiSync 产物 d.ts 未静态引用 `node:sqlite`（`database-manager.ts` 用变量式 `await import(sqliteModuleName)` + 本地 `SqliteConnection` 类型） |

⇒ **零妥协**：不改 Electron、不改 SQLite 驱动、不改 `@types/node`、不起子进程。唯一保留的硬约束是"运行时必须 `await import()`"，由 §7 的装载缝固化。

## 5. 依赖声明（新增 / 变更）

**新增（`WXNN XiangCe/package.json` → `dependencies`，按字母序插入）**：

```json
"@nikkisync/core": "file:../NikkiSync/packages/core",
"@nikkisync/database": "file:../NikkiSync/packages/database",
"@nikkisync/pc-companion": "file:../NikkiSync/apps/pc-companion",
"@nikkisync/protocol": "file:../NikkiSync/packages/protocol"
```

**变更**：`package-lock.json`（由 `npm install` 自动写入 link 条目，随本次提交）。

**复用既有依赖**：`qrcode@^1.5.4`（两侧同版本，NikkiSync 侧解析走 `NikkiSync/node_modules`）、`@types/qrcode@^1.5.6`、`typescript@5.9.3`（两侧实装同版本）、`vitest@^5.0.3`（测试宿主）。

**对 NikkiSync 的依赖**：读取其 `dist/` 编译产物（不是 `.ts` 源），运行时依赖其 `node_modules` 的 workspace 软链闭合内部依赖边。

**不新增**：不改 `engines`（`>=22.12.0` 保留；本阶段不在 Node 22 下跑集成路径，CI 影响见 §14 R1）、不新增任何 npm 公开包、不改 `overrides`。

> **阶段 9 回写**：上述四条 `file:` 声明已从 `dependencies` 移出（CI 只 checkout 本仓时 `npm ci` 必红），
> 改由 `npm run link:nikkisync` 在开发机建 junction；类型面 `import type` 锚点同步退役。
> 完整理由、命令与验收见 [`09-legacy-debt-remediation-plan.md`](./09-legacy-debt-remediation-plan.md)。

**前置条件**：NikkiSync 必须已有编译产物 —— `NikkiSync/` 下 `npm run build`（本工作区已有 `dist/`）。探针与 `npm run verify:nikkisync` 都会在缺失时给出可执行提示而非晦涩报错。

## 6. TypeScript 配置

- **不需要 `paths`**。`file:` 安装后 `WXNN XiangCe/node_modules/@nikkisync/*` 存在：
  - `src/main/tsconfig.json`（`module: commonjs` ⇒ 默认 node10 解析）经 `types`/`main` 命中 `dist/src/index.d.ts`；`@nikkisync/pc-companion` 无 `types` 时回落 `main` 同名 `.d.ts`（实测存在）。
  - 根 `tsconfig.json`（`moduleResolution: bundler`）走 `exports.types`；本阶段渲染层不引用 NikkiSync，仅在被 import 图拉入时生效。
- 因此 `WXNN XiangCe/tsconfig.json` 与 `WXNN XiangCe/src/main/tsconfig.json` 本阶段**均不改**。
- `.ts` 源文件不参与 XiangCe 编译：XiangCe 只消费 NikkiSync 的 `dist/` 产物（`.js` + `.d.ts`），产物由 NikkiSync 自己的 `npm run build` 生成，职责边界清晰。
- 约定：类型面一律 `import type`（被擦除，不产生运行时 `require`）；值面一律经 §7 装载缝的动态 import。该约定由 §8 的 ESLint 护栏固化为静态检查。
- 若后续 NikkiSync 侧补充 `exports.types`，XiangCe 解析路径不变（node10 忽略 `exports`，bundler 优先 `types` 条件），无需回改本仓配置。

## 7. 运行时嵌入缝（新增目录 `src/main/nikkisync/`）

不复用 `src/main/sync/`：其 `AGENTS.md` 规定"只依赖 node 内置 + `shared/sync` + `database` 仓储、不 import Electron"，新增外部包依赖会突破该白名单。也不落在 `src/main/services/**`（受"核心路径保护"两层闸门约束）。新目录 `src/main/nikkisync/` 为后续所有 NikkiSync 消费的唯一入口。

| 文件                | 职责                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime-loader.ts` | 唯一装载缝：常量 specifier 表 + 变量式 `await import()`（带 `/* @vite-ignore */`）；`unknown` 收窄取值（禁 `any`）；缺包/缺导出/构建产物缺失分别给出可诊断英文错误；`isNikkiSyncLinked()` 供测试与探针做存在性预判                                                                                                                                                                                                                    |
| `probe.ts`          | `runNikkiSyncLinkProbe()`：对四包做导出存在性断言，返回结构化报告；额外 `new DatabaseManager(':memory:')` + `initialize()` + 查询 `sqlite_master` + `close()`，顺带验证 `import.meta.url` 相对定位 `migrations/0001_initial.sql` 是否成立。**不实例化任何服务器/scanner**。另导出 `formatNikkiSyncLinkProbeReport()`（报告 → 人读行序列）与 `isNikkiSyncProbeErrorLine()`（stdout/stderr 分流判据）两个纯函数，使输出形态可被单测固定 |
| `probe-cli.ts`      | 入口薄壳（实测 10 条语句）：只跑探针 → 按行分流 stdout/stderr → 定退出码（任一缺失置 `process.exitCode = 1`）；文本内容全交给 `probe.ts` 的纯函数                                                                                                                                                                                                                                                                                     |
| `AGENTS.md`         | 模块级约定（禁静态值 import、装载缝唯一入口、不调 `runtime.start()` 的原因、英文字符串约束）                                                                                                                                                                                                                                                                                                                                          |

## 8. 需修改 / 新增文件（完整路径 + 输入输出）

| 路径                                                            | 操作                   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WXNN XiangCe/docs/sync-integration/01-dependency-link-plan.md` | 新增                   | 本计划 + §15 执行记录                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `WXNN XiangCe/package.json`                                     | 修改                   | `dependencies` 四条 `file:`；`scripts.verify:nikkisync`；`build.asarUnpack` 追加 `"**/@nikkisync/**"`                                                                                                                                                                                                                                                                                                                                                                                                          |
| `WXNN XiangCe/package-lock.json`                                | 修改（npm 生成）       | `node_modules/@nikkisync/*` link 条目                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `WXNN XiangCe/src/main/nikkisync/runtime-loader.ts`             | 新增                   | 装载缝（§7）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `WXNN XiangCe/src/main/nikkisync/runtime-loader.test.ts`        | 新增                   | Vitest node project 测试（§11 用例 1-7）；链接缺失时整套件 skip                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `WXNN XiangCe/src/main/nikkisync/probe.test.ts`                 | 新增                   | 探针测试共 6 例：3 例纯函数（报告格式化 / 错误行分流 / n-a 降级，不依赖链接）+ 3 例跟完整装载链（本地 Node >= 24，与 Electron 侧共用同一实现）                                                                                                                                                                                                                                                                                                                                                                 |
| `WXNN XiangCe/vitest.config.ts`                                 | **不改**（已实测否定） | 曾一度加入 `coverage.exclude: 'src/main/nikkisync/probe-cli.ts'`，后按 §10 口径量化实测后撤销（`git diff -- vitest.config.ts` 为空）：仓内 `src/**/*.ts` 语句基数 20474，`probe-cli.ts` 仅 10 条未覆盖语句，稀释 0.0341pp，而基线 69.94% 对阈值 69 的余裕为 0.94pp ⇒ 不跌，因此不改配置，`probe-cli.ts` 作为 0% 入口壳计入报告                                                                                                                                                                                 |
| `WXNN XiangCe/src/main/nikkisync/probe.ts`                      | 新增                   | 探针主体（§7）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `WXNN XiangCe/src/main/nikkisync/probe-cli.ts`                  | 新增                   | 独立探针入口                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `WXNN XiangCe/src/main/nikkisync/AGENTS.md`                     | 新增                   | 模块约定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `WXNN XiangCe/AGENTS.md`                                        | 修改                   | 嵌套 AGENTS.md 导航表新增一行（`src/main/nikkisync/`）                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `WXNN XiangCe/electron.vite.config.ts`                          | 修改                   | `main.build.lib.entry` 追加 `'nikkisync-probe': 'src/main/nikkisync/probe-cli.ts'`，使探针经**同一条 CJS 管线**产出 `dist/main/main/app/nikkisync-probe.js`                                                                                                                                                                                                                                                                                                                                                    |
| `WXNN XiangCe/scripts/verify-nikkisync-link.ts`                 | 新增                   | 只读检查（dry-run 默认）：NikkiSync `dist/` 存在性、四条 link 指向、Electron 版本、`node:sqlite` 可用性、结论汇总                                                                                                                                                                                                                                                                                                                                                                                              |
| `WXNN XiangCe/eslint.config.js`                                 | 修改                   | 两层护栏（均经临时探针文件实测）：`no-restricted-imports` 用 `patterns:[{group:['@nikkisync/*'],allowTypeImports:true}]` 拦静态 import/export 且放行 `import type`；`no-restricted-syntax` 补 `ImportExpression[source.value=/^@nikkisync\//]` 拦字面量 `import()`，并重新展开 `i18nGuardSelectors` 以免削弱 `src/**` 原有护栏。**注**：本仓库 ESLint 9.39.5 的核心 `no-restricted-imports` **不接受 `importKind`**（写上即 config 校验失败、`npm run lint` 退出码 2），因此用 `allowTypeImports` 达到同一语义 |
| `WXNN XiangCe/src/main/index.ts`                                | 修改                   | `app.whenReady()` 内、`application.initialize()` 之后，插入 `process.env.NIKKI_NIKKISYNC_PROBE === '1'` 门控的探针调用，结果同时写 `diagLog` 与 `electronLogger`（本机 `diag.log` 的 INDEX 行停在 2026-09-18，只靠 diagLog 不可观测），`try/catch` 吞掉（默认关闭，不影响打包态与 e2e）                                                                                                                                                                                                                        |

**NikkiSync 侧：零文件改动**（本阶段确认后仍为零）。

## 9. 启动 / 验证方式（命令表，分步门禁：每步通过才进下一步）

| 步  | 动作                                | 命令（目录）                                                                                                                    | 通过判据                                                                                                                                                                 |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | 基线快照                            | `npm run typecheck` / `npm run lint` / `npm run test:main`（XiangCe）、`npm test`（NikkiSync）                                  | 与 §2 基线红灯集合逐条一致                                                                                                                                               |
| 1   | **红灯**                            | `npx vitest run src/main/nikkisync`（XiangCe，建链前）+ `npx tsx -e` 直调装载缝                                                 | 直调必现 `Cannot find package '@nikkisync/core'`（由 `NikkiSyncLoadError` 携带修复提示）；测试文件本身按用例 7 把装载套件整体 skip，所以红灯证据取自直调输出而非套件报红 |
| 2   | 建链                                | `npm install --dry-run` → `npm install`（XiangCe）                                                                              | `node_modules/@nikkisync/{core,database,pc-companion,protocol}` 存在且为指向 `NikkiSync/...` 的 link（Windows junction，无需管理员/开发者模式）                          |
| 3   | **绿灯**                            | `npm run test:main -- nikkisync`（XiangCe）                                                                                     | 用例全通过（本地 Node 26.3.0 宿主）                                                                                                                                      |
| 4   | 类型回归                            | `npm run typecheck`（XiangCe）                                                                                                  | 错误集合与步 0 **完全相同**（阶段 7 的 2 错仍在，零新增）                                                                                                                |
| 5   | Lint 回归                           | `npm run lint`（XiangCe）                                                                                                       | 仍为 `12 problems (1 error, 11 warnings)`                                                                                                                                |
| 6   | 构建 + 折叠检查                     | `npm run build` 后 `Select-String dist/main/main/app/nikkisync-probe.js -Pattern 'require\("@nikkisync'`（XiangCe）             | 构建成功且该 grep **零命中**（动态 import 未被折叠成 require）                                                                                                           |
| 7   | Electron 宿主探针                   | `$env:ELECTRON_RUN_AS_NODE='1'; & ".\node_modules\electron\dist\electron.exe" dist\main\main\app\nikkisync-probe.js`（XiangCe） | 退出码 0；打印宿主 `node=24.18.0`；四包导出逐项非 `undefined`                                                                                                            |
| 8   | dev 启动                            | `$env:NIKKI_NIKKISYNC_PROBE='1'; npm run dev`（XiangCe）                                                                        | 启动日志无 `ERR_MODULE_NOT_FOUND` / `ERR_REQUIRE_ASYNC_MODULE`，探针行出现且 `boot-ok.marker` 生成                                                                       |
| 9   | NikkiSync 回归                      | `npm test` / `npm run typecheck` / `npm run db:validate` / `git status --short`（NikkiSync）                                    | 全量测试通过、退出码 0、`schema OK`、工作区无源码改动                                                                                                                    |
| 10  | 改动面核对（提交按 §13 的决定延后） | `git status --porcelain`（XiangCe）、`npm run verify:nikkisync`、`npm run test:coverage`                                        | 改动面恰为 §8 清单且未混入阶段 7 WIP；`verify:nikkisync` 退出码 0；全量测试失败集合不超出基线（WIP 的 5 个文件）。本阶段不执行 `git commit`（理由与前置条件见 §13）      |

## 10. 错误处理与降级路径（预先定案，不临场发挥）

| 触发                                                                                                           | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 步 2 `npm install` 报 E404/ERESOLVE（`@nikkisync/database` 内部 `@nikkisync/core@0.0.1-m0` 边被送去 registry） | 降级为方案 D：从 `dependencies` 撤回四条，改 `WXNN XiangCe/scripts/link-nikkisync.mjs` 用 `fs.symlink(target, path, 'junction')` 建同名链接并接入 `prepare`；同时 `build.files` 显式追加 `"node_modules/@nikkisync/**/*"` 补回打包面。步 3-9 判据不变（两种落点对 TS/Node 解析等价），并在 §15 记录实测结论与偏差原因                                                                                                                                                                                                                                            |
| 步 6 grep 命中 `require("@nikkisync`                                                                           | 打包器折叠了动态 import：装载缝改用单一出口 `const dynamicImport = new Function('s', 'return import(s)')`，并在 §15 记录                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 步 7 报 `migrations/0001_initial.sql` 读不到（`ENOENT`/`ERR_MODULE_NOT_FOUND`）                                | 探针打印实际解析 URL；处置为对 `initialize(schemaSql?)` **显式传** SQL 文本（由 XiangCe 侧解析绝对路径后读入），不改 NikkiSync 源码；打包态路径登记为 §14 R3 遗留项                                                                                                                                                                                                                                                                                                                                                                                              |
| `npm install` 清掉手工 junction（仅走降级方案 D 时相关）                                                       | 重跑 `npm run link:nikkisync`；`npm run verify:nikkisync` 会明确报"link 缺失"而非晦涩解析错误                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| NikkiSync 无 `dist/`（新克隆/刚 `clean`）                                                                      | 装载缝抛出带修复指令的错误：`Run "npm run build" in NikkiSync first`；`verify:nikkisync` 同点提示                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 覆盖率门控（`npm run test:coverage`，阈值 69/80/68/69）因新增壳文件回落                                        | **未触发（已用实测否定，并据此不改配置）**：全量阈值在本树不可评定（见 §14 R9），改用可计算的稀释口径：`src/**/*.ts` 语句基数 20474，入口壳 `probe-cli.ts` 仅 10 条 0% 语句 ⇒ 稀释 0.0341pp，远小于余裕 0.94pp。按本行前半句的口径（“若不跌则不改”），`vitest.config.ts` **保持零改动**（中途一度加入的 `coverage.exclude` 已撤销，`git diff -- vitest.config.ts` 为空）。同时把输出逻辑从入口壳抽成 `formatNikkiSyncLinkProbeReport()` / `isNikkiSyncProbeErrorLine()` 两个纯函数并补单测：`probe.ts` 覆盖率 69/81 = 85.18%，`runtime-loader.ts` 34/37 = 91.89% |
| 探针意外产生副作用（端口/句柄泄漏）                                                                            | 探针只允许 `:memory:` 库 + 类型/函数存在性断言；测试结束断言 `DatabaseManager.close()` 已调用，且不触碰 `runtime.start()`、`LocalSyncServer`、`MdnsAdvertiser`                                                                                                                                                                                                                                                                                                                                                                                                   |

## 11. 基础测试用例（红灯 → 绿灯）

| #   | 用例                      | 断言                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 装载缝存在性              | 四个 specifier 均能 `await import()`，返回模块对象非 `undefined`                                                                                                                                                                                                                                     |
| 2   | `@nikkisync/core`         | 值：`AssetResolver`（function）、`ASSET_RESOLVER_VERSION`、`ASSET_TYPES`、`RESOURCE_ROLES`、`toPathKey`（function）非 `undefined`；`NikkiAsset`/`MediaResource` 是 interface（无运行时值），改以 `import type` + 上述常量做运行时等价断言 —— 此取舍在本文件 §11 末尾显式记录，探针打印的仍是可判定项 |
| 3   | `@nikkisync/database`     | `DatabaseManager` 可 `new`（`:memory:`）；`initialize()` 后 `sqlite_master` 中 `type='table'` 实测 **13** 个（12 业务表 + `sqlite_sequence`），全部对象实测 **38** 个（含 17 个索引/autoindex）；`close()` 不抛                                                                                      |
| 4   | `@nikkisync/protocol`     | `PROTOCOL_VERSION === 1`；`API_ROUTES` 为对象且键数 12；`buildPairingUri` 为 function；DTO 类型（`AssetDetailResponse` 等）经 `import type` 可解析                                                                                                                                                   |
| 5   | `@nikkisync/pc-companion` | `createPcCompanionContext()` 返回含 `database` 与 `protocolVersion`；`typeof PcCompanionRuntime === 'function'`；测试结束无残留句柄（未监听任何端口）                                                                                                                                                |
| 6   | 负例                      | 不存在的 specifier ⇒ 抛可诊断错误，且不返回半初始化的模块图                                                                                                                                                                                                                                          |
| 7   | 链接缺失容错              | `node_modules/@nikkisync` 不存在 ⇒ 整个测试文件 `skip`（不把环境缺失伪装成逻辑失败，并便于 CI 恢复前的分片噪声控制）                                                                                                                                                                                 |

## 12. 可判定验收标准

1. **import 验证**：步 3（本地 Node 26.3.0）与步 7（Electron 内置 Node 24.18.0）双宿主均通过，导出清单逐项打印且非 `undefined`，退出码 0。
2. **类型检查**：`npm run typecheck`（XiangCe）错误集合与 §2 基线**逐条相同**（零新增；阶段 7 的 2 错如实保留）。
3. **构建**：`npm run build`（XiangCe）成功产出 `dist/main/main/app/nikkisync-probe.js`，且该产物中无 `require("@nikkisync`。
4. **开发模式**：`npm run dev` 正常启动，日志无 `ERR_MODULE_NOT_FOUND` / `ERR_REQUIRE_ASYNC_MODULE`。
5. **NikkiSync 不受影响**：`npm test` 全量通过、`npm run typecheck` 退出码 0、`npm run db:validate` 输出 `schema OK`、`git status --short` 无源码改动。
6. **文档**：本文件完整记录选型理由、兼容性结论（含"无需改 Electron/驱动/子进程"的证据引用）、依赖声明、命令表、错误处理与降级路径、测试用例、验收标准、执行记录。
7. **Lint**：`npm run lint` 相对基线零新增 error。
8. **覆盖率闸门归因**：`npm run test:coverage` 的失败集合不得超出基线（阶段 7 WIP 的 5 个文件），新增代码自身真实覆盖。

## 13. 分支与提交

- `NikkiSync/`：保持 `feat/gallery-runtime-embed`（Phase 0 自 `b2eb337` 切出），本阶段**零改动 ⇒ 零提交**（实测 `git status --short` 仍只有 `?? .mimosa/`、`?? .zcode/`）。
- `WXNN XiangCe/`：保持 `feat/gallery-runtime-embed`（HEAD `9815e68`）。
- **本阶段不提交（用户 2026-10-13 决定，选最保守路径）**。原因：`.husky/pre-commit` 第 3 步无条件跑 `npx tsc -b`，而工作区携带的阶段 7 未提交 WIP 带 2 个类型错误（`sync-read-repository.ts(125,26) TS2503`、`(231,5) TS2322`），任何提交必被闸门拦下；计划 §12 已明确该基线"不修、不掩盖、不顺手修"。因此本阶段交付物全部留在工作区，**未使用 `--no-verify`**，未绕过任何闸门。
- 恢复提交的前置条件（任一成立即可正常提交）：
  1. 阶段 7 WIP 先完成/提交，使 `tsc -b` 转绿；或
  2. 先 `git stash push -u` 隔离阶段 7 WIP 后提交本阶段（注意本阶段与 WIP 文件集不重叠，pop 回还无冲突），提交后 `git stash pop`；或
  3. 用户明确授权 `--no-verify` 并记录被跳过的闸门。
- 提交时的建议信息（待上述前置成立后直接使用）：`feat(sync-integration): link NikkiSync packages as file: dependencies for main-process embedding`（受 commitlint 约束）。不得将阶段 7 WIP 混入同一笔；`.tmp-phase1-*` 与 `dist/` 均为 gitignore 覆盖的本地产物，不入仓。

## 14. 已识别风险与延后项

| #   | 风险 / 延后项                                                                                                                                                                                                                                                           | 严重度                        | 说明与处置                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **XiangCe CI 会红**：`build.yml` 5 个 job 在只 checkout 本仓库、Node 22 的环境执行 `npm ci`，`file:../NikkiSync/...` 无法解析                                                                                                                                           | ~~高~~ → **已处置**（阶段 9） | 候选处置①②③ 均未采用：阶段 9 改为**自包含方案**——四条 `file:` 声明从 `dependencies` 移出，链接由 `npm run link:nikkisync` 在开发机建 junction，未链接为受支持默认态（测试 skip + 诊断 warn）。防回归由 `scripts/__tests__/self-contained-deps.test.ts` 承担，详见 [`09-legacy-debt-remediation-plan.md`](./09-legacy-debt-remediation-plan.md) §4                                                                     |
| R2  | lockfile 记录指向仓库外的 link ⇒ 其他克隆必须保持 `WXNN XiangCe` 与 `NikkiSync` 同级布局                                                                                                                                                                                | 中 → **已缓解**               | 自包含方案后 lockfile 不再记录仓库外 link；同级布局仍为建链的首选候选（`NIKKISYNC_ROOT` → `../NikkiSync` → `vendor/NikkiSync`），`verify:nikkisync` 给出可执行提示                                                                                                                                                                                                                                                    |
| R3  | 打包态（asar × ESM × `migrations` 相对路径）未在本阶段实证                                                                                                                                                                                                              | 中 → **部分收敛**（阶段 9）   | 除 `asarUnpack: ["**/@nikkisync/**"]` 外，阶段 9 补齐：`build.files` 加 `node_modules/@nikkisync/**/*`（自包含后不再靠声明依赖自动入包）、装载缝的 unpacked 路径回退、探针改传显式 `schemaSql`，并把折叠校验固化为 `verify:nikkisync` 检查项。真实 `electron-builder --dir` + 产物内探针仍列在 [`09-legacy-debt-remediation-plan.md`](./09-legacy-debt-remediation-plan.md) §4「待链接复验清单」（需 NikkiSync 就位） |
| R4  | 双真相源并存：移植面 `src/shared/sync/protocol.ts` 与 `@nikkisync/protocol`                                                                                                                                                                                             | 中 → **已收敛**（阶段 9）     | 定案：vendored `src/shared/sync/protocol.ts`（含 `domain-types.ts` / `protocol-extension.ts`）为唯一真相源；`@nikkisync/protocol` 退出类型锚点与依赖声明，仅作链接态漂移比对对象（`src/main/nikkisync/protocol-contract.ts` + `protocol-drift.test.ts`）。口径见 `src/shared/sync/README.md`                                                                                                                          |
| R5  | XiangCe `engines.node >= 22.12.0` 与 NikkiSync `>= 24.0.0` 不一致；CI Node 22 下 `node:sqlite` 属实验特性                                                                                                                                                               | 中                            | 本阶段所有 NikkiSync 执行都在 Electron（Node 24.18）或本地 Node 26 下；CI 恢复时须一并对齐 Node 版本面（与 R1 同批处置）                                                                                                                                                                                                                                                                                              |
| R6  | `src/main/nikkisync/` 与既有 `src/main/sync/`（移植轨道）职责边界                                                                                                                                                                                                       | 低                            | 由 `src/main/nikkisync/AGENTS.md` + 根 AGENTS 导航表固化：`nikkisync/` = 外部包装载缝，`sync/` = 移植面服务层                                                                                                                                                                                                                                                                                                         |
| R7  | 探针若误调 `runtime.start()` 会触发 scanner 硬前置并起 LAN/mDNS                                                                                                                                                                                                         | 低                            | §10 末行硬性禁止；测试用例 5 断言无端口副作用；实测探针后 NikkiSync 目录下未出现 `nikkisync.sqlite`（`probe.test.ts` 第 3 例常驻守护）                                                                                                                                                                                                                                                                                |
| R8  | 嵌套 AGENTS.md 导航表是受测试守护的契约：`scripts/__tests__/verify-format-scope.test.ts` 逐行要求表内指引文件必须引用 `docs/CODING_CONVENTIONS.md`                                                                                                                      | 低（已触发并修正）            | 本阶段新增导航行后该断言真实失败过一次（全量 `Test Files 6 failed`），已按仓库惯例在新 AGENTS.md 首部补入真相源引用 → 回到基线 `5 failed`                                                                                                                                                                                                                                                                             |
| R9  | 全量覆盖率阈值在本工作区**结构性不可评定**（不是“暂时尚未跑”）：只要存在失败测试文件，vitest 就不产出任何覆盖率输出——实测三种手段均无效：默认 reporter、`--coverage.all=false` 定向、阈值归零 + `--coverage.reporter=json-summary`（后两者连 `coverage/` 目录也不生成） | 中（归因已举证）              | 改用**可计算的替代口径**（见 §10 覆盖率行）：以 `--coverage.all=true --coverage.include=src/**/*.ts` 先测得仓内语句基数 20474，再测得 `probe-cli.ts` 仅 10 条 0% 语句，稀释 0.0341pp < 余裕 0.94pp ⇒ 得出“不需改 `vitest.config.ts`”的确定结论（并据此撤销已加的 exclude）；阶段 7 WIP 转绿后闸门可正常评定                                                                                                           |
| R10 | `verify:nikkisync` 的路径基准必须以链接 realpath 为准                                                                                                                                                                                                                   | 低（本阶段已修）              | 第一版把包目录按 XiangCe 目录解析（少一级 `../`），对已就绪的 `dist/` 误报“四包未编译 / schema 缺失”并退出码 1；现改为 `fs.realpathSync(node_modules/@nikkisync/<name>)`，仅链接缺失时才回落到声明路径。今后新增链接形态（如 vendor checkout）仍适用此口径                                                                                                                                                            |
| R11 | `src/**` 的 i18n 护栏同时禁 `console.log/info/debug`                                                                                                                                                                                                                    | 低（已成永久约束）            | CLI 型入口在 `src/main` 下必须用 `process.stdout.write`（失败行可用仍被允许的 `console.error`），否则 `npm run lint` 直接报 error；已在 `probe-cli.ts` 落实并在其文件头注释写明原因                                                                                                                                                                                                                                   |
| R12 | npm 对 `file:` 依赖的内部依赖边可本地闭合（实测）                                                                                                                                                                                                                       | 低（结论型）                  | `@nikkisync/database` 声明的 `@nikkisync/core@0.0.1-m0`（private + registry 404）在 `npm install --dry-run` 与正式安装均未报 E404：arborist 从根树的同名 link 节点解析该边。因此 §10 的方案 D 降级在本仓库形态下不需保留为常规步骤（仍作为应急路径存档）                                                                                                                                                              |
| R13 | `npm install` 不会清除 `file:` 产生的 junction                                                                                                                                                                                                                          | 低（结论型）                  | 本阶段多次 `npm install` 后 `node_modules/@nikkisync/*` 四条 link 仍存在且 Target 不变；与“手工 junction 会被当外物剪枝”的方案 D 风险不同，因此正式采用 `file:` 后无需接入 `prepare` 重链脚本                                                                                                                                                                                                                         |

## 15. 执行记录

执行窗口：2026-10-12 23:30 → 2026-10-13 19:20（本地 Node v26.3.0 / npm 11.16.0；宿主实装 Electron 41.10.6）。执行时基线提交：XiangCe `9815e68`、NikkiSync `b2eb337`，两侧均在 `feat/gallery-runtime-embed`。本阶段 NikkiSync 侧零改动。

### 步 0 基线快照

| 命令（目录）                   | 实际输出原文                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`（XiangCe） | 退出码 2；`src/main/database/sync-read-repository.ts(125,26): error TS2503: Cannot find namespace 'Database'.`；`src/main/database/sync-read-repository.ts(231,5): error TS2322: Type '{ asset: NikkiAsset & { annotations?: AssetAnnotations; }; }' is not assignable to type 'ExtendedAssetDetail'.` |
| `npm run lint`（XiangCe）      | 退出码 1；`12 problems (1 error, 11 warnings)`；error = `6:8 'AssetDetailResponse' is defined but never used`                                                                                                                                                                                          |
| `npm run test:main`（XiangCe） | 退出码 1；`Test Files 5 failed                                                                                                                                                                                                                                                                         | 183 passed (188)`；`Tests 17 failed | 3484 passed | 2 skipped (3503)` |
| `npm test`（NikkiSync）        | `# tests 131` / `# pass 131` / `# fail 0` / `# cancelled 0`                                                                                                                                                                                                                                            |

### 步 1 红灯（建链前）

- `npx vitest run src/main/nikkisync`（未建链）⇒ 纯函数面 `4 passed`，装载面 8 例按用例 7 `skipped`（`Test Files 1 passed`）。**偏差点**：首个红灯实际由实现缺陷（标识符拼成 `NIKKEISYNC_PACKAGES`，多一个 `E`）以 `ReferenceError` 暴露；修正后按下方直调得到预期红灯。
- 直调装载缝取真实红灯原文（`npx tsx -e`）：

```
EXPECTED-FAIL name=NikkiSyncLoadError
EXPECTED-MSG Failed to load @nikkisync/core as core: Cannot find package '@nikkisync/core'
imported from D:\Zcode项目\WXNN YD\WXNN XiangCe\src\main\nikkisync\runtime-loader.ts
| hint: the @nikkisync/* link is missing or NikkiSync has no compiled dist; run
`npm install` in WXNN XiangCe and `npm run build` in NikkiSync, then
`npm run verify:nikkisync` for the full diagnosis
```

### 步 2 建链

- `npm install --dry-run` ⇒ `added 4 packages in 673ms`，**无 E404/ERESOLVE** ⇒ §10 的方案 D 降级未被触发（`@nikkisync/database` 内部对 `@nikkisync/core@0.0.1-m0` 的边由本地树闭合，未去 registry）。
- `npm install` ⇒ 退出码 0；`Get-ChildItem node_modules\@nikkisync` 四条 link 的实际 Target：

```
core         -> D:\Zcode项目\WXNN YD\NikkiSync\packages\core
database     -> D:\Zcode项目\WXNN YD\NikkiSync\packages\database
pc-companion -> D:\Zcode项目\WXNN YD\NikkiSync\apps\pc-companion
protocol     -> D:\Zcode项目\WXNN YD\NikkiSync\packages\protocol
```

- `git status --porcelain -- package.json package-lock.json` ⇒ ` M package.json`、` M package-lock.json`（Windows 下为 junction，未要求管理员/开发者模式）。

### 步 3 绿灯

- `npx vitest run src/main/nikkisync` ⇒ `Test Files 1 passed (1)`、`Tests 12 passed (12)`。
- `npx tsx src/main/nikkisync/probe-cli.ts`（本地 Node 26.3.0）⇒ `[result  ] OK`（完整导出清单与下表同形态）。
- `npm run verify:nikkisync` ⇒ 退出码 0，六项判定全 ✓（首版曾误报“四包未编译”，原因见下方偏差 D4）。

### 步 4-5 类型与 Lint 回归

- `npm run typecheck` ⇒ 退出码 2，错误集合与步 0 **逐字相同**（仍为阶段 7 WIP 那 2 条）⇒ **零新增错误**。同时反证四个包的 `.d.ts` 均已被 node10 解析命中（未出现 TS2307/TS2503 新增项），因此§6 “不需 `paths`”成立。
- `npm run lint` 迭代过程（三轮均为真实失败，非假设）：
  1. 退出码 2：本仓库 ESLint 9.39.5 的核心 `no-restricted-imports` **不接受 `importKind`**（`Unexpected property "importKind"`，config 直接崩）⇒ 改用 `allowTypeImports: true`。
  2. 实测发现核心规则**不拦字面量 `import('@nikkisync/protocol')`**⇒ 补 `no-restricted-syntax` 选择器 `ImportExpression[source.value=/^@nikkisync\//]`，并重新展开 `i18nGuardSelectors`（否则会静默削弱 `src/**` 的中文/console 护栏）。
  3. 实测发现 `src/**` 禁 `console.log`（`i18nGuardSelectors` 第 3 条）⇒ `probe-cli.ts` 改用 `process.stdout.write`，失败行保留允许的 `console.error`。
- 护栏三层行为已用临时文件 `src/main/nikkisync/guard-probe.tmp.ts` 实测并随即删除：静态值导入 ⇒ `no-restricted-imports` error；字面量 `import()` ⇒ `no-restricted-syntax` error；`import type` ⇒ 放行。
- `npm run lint` 终态 ⇒ 退出码 1，`12 problems (1 error, 11 warnings)`，与基线逐条一致（唯一 error 仍是 `sync-read-repository.ts:6:8`）。

### 步 6 构建与折叠校验

- `npm run build` ⇒ 退出码 0；产物含 `dist/main/main/app/nikkisync-probe.js`，装载缝被拆到共享 chunk `dist/main/main/app/probe.js`。
- **判据修正**：计划原判只 grep 入口文件，实测会漏判 ⇒ 改为全 chunk 检索：`Select-String dist\main\main\app\*.js -Pattern 'require\(.@nikkisync'` 命中 **0**；`await import(` 命中 **3** ⇒ 变量式动态 import 未被折叠。
- 附带发现：将产物副本放到无 `dist/main/package.json {type:commonjs}` shim 的目录，立即报 `require is not defined in ES module scope` ⇒ 反向印证 `writeCommonjsShim()` 是打包态可加载的前提（`electron.vite.config.ts:46-54`）。

### 步 7 Electron 宿主探针（含正/负例）

PowerShell 的 `&` 不填 `$LASTEXITCODE`、`Start-Process -RedirectStandardOutput` 在本机报“拒绝访问”⇒ 改用 cmd 延迟展开取退出码：

```powershell
cmd /v:on /c "set ELECTRON_RUN_AS_NODE=1&& node_modules\electron\dist\electron.exe dist\main\main\app\nikkisync-probe.js 1>.tmp-phase1-probe-out.txt 2>.tmp-phase1-probe-err.txt & echo PROBE_EXIT=!errorlevel!"
```

输出原文（stdout 共 20 行，stderr 0 字节）：

```
PROBE_EXIT=0
[nikkisync-probe] host node=24.18.0 electron=41.10.6
[package ] @nikkisync/core ok=true exports=9
[package ] @nikkisync/database ok=true exports=9
[package ] @nikkisync/pc-companion ok=true exports=18
[package ] @nikkisync/protocol ok=true exports=16
[export  ] core.ASSET_RESOLVER_VERSION typeof=number value=number 1
[export  ] core.AssetResolver typeof=function value=function AssetResolver
[export  ] database.DatabaseManager typeof=function value=function DatabaseManager
[export  ] pcCompanion.PcCompanionRuntime typeof=function value=function PcCompanionRuntime
[export  ] pcCompanion.createPcCompanionContext typeof=function value=function createPcCompanionContext
[export  ] protocol.API_ROUTES typeof=object value=object(12 keys)
[export  ] protocol.PROTOCOL_VERSION typeof=number value=number 1
[database] ok=true tables=13 objects=38 error=none
[companion] ok=true protocolVersion=1 error=none
[result  ] OK
```

- 必需导出共 **12** 项（core 6 + database 1 + pcCompanion 2 + protocol 3），逐项 typeof 符合预期 ⇒ 计划早期估的 11 项修正为 12。
- 退出码不是恒 0（负例对照）：把产物副本拷到 `dist/tmp-negative/`（含 shim）并将必需导出改名为 `PROTOCOL_VERSION_MISSING` ⇒ `NEG_EXIT=1`、`[fail    ] @nikkisync/protocol.PROTOCOL_VERSION_MISSING: Expected export ... is undefined; the loaded NikkiSync artifact is missing or stale`、`[result  ] FAILED (1 issue(s))`。对照目录已删除。

### 步 8 dev 模式启动

- `$env:NIKKI_NIKKISYNC_PROBE='1'; npm run dev`，electron-log 命中行：

```
19:02:10.874 > [NIKKISYNC] nikkisync link probe ok=true host=node 24.18.0 (electron=41.10.6) packages=4 exports=12 dbTables=13 failures=none
```

- 全 dev 日志检索 `ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ASYNC_MODULE|FATAL ERROR in startup|Cannot find module|Cannot find package` ⇒ 命中 **0**。
- `boot-ok.marker`（`%APPDATA%\wxnn-photo-manager`）存在，mtime `2026-10-13T19:02:10`，与探针行同秒。
- **偏差 D5**：本机 `diag.log` 的 `[INDEX]` 行历史停在 2026-09-18（`diagLog` 的 `fs.appendFileSync` 被自身 try/catch 吞掉，落盘静默失败），仅靠 `diagLog` 不可判定 ⇒ 钩子同时走 `electronLogger.info`（与本文件既有 `gpuFallbackActive` 日志同口径）。
- 收尾：仅关闭本会话启动的 9 个 `electron.exe`（按 Path 过滤确认后再杀）；残留的两个 node 进程经命令行核对属 IDE 的 codegraph 服务，**未误杀**。

### 步 9 NikkiSync 回归

- `npm test` ⇒ 退出码 0，`# tests 131` / `# pass 131` / `# fail 0` / `# cancelled 0`（与基线一致）。
- `npm run typecheck` ⇒ 退出码 0。`npm run db:validate` ⇒ 退出码 0，`schema OK`；`foreign_key_check: ok`；`quick_check: ok`；表清单 13 个对象。
- `git status --short` ⇒ 仅 `?? .mimosa/`、`?? .zcode/` ⇒ 本阶段 NikkiSync 侧**零文件改动**（§3 选型约束成立）。

### 步 10 改动面核对与全量回归

- `npm run test:coverage`（全量）终态：`Test Files 5 failed | 358 passed (363)` —— 5 个失败文件与阶段 7 WIP 完全一致；本阶段新增 3 个测试文件（`runtime-loader.test.ts` 12 例 + `probe.test.ts` 6 例 + `verify-nikkisync-link.test.ts` 4 例）全绿。
- **偏差 D6（真实回归，已修）**：新增根 AGENTS 导航行后，`scripts/__tests__/verify-format-scope.test.ts` 的契约断言（“导航表内每个指引文件必须引用 `docs/CODING_CONVENTIONS.md`”）失败，全量一度 `6 failed`；按仓库惯例在新 AGENTS.md 首部补入真相源引用 ⇒ 回到基线 `5 failed`。
- 覆盖率：本工作树**无法产出全量覆盖率报告**（实测：只要存在失败测试文件，vitest 既不打印也不写 `coverage/`；默认 reporter、`--coverage.all=false`、阈值归零 + `json-summary` 三种手段均无效）⇒ 改用可计算口径：`--coverage.all=true --coverage.include=src/**/*.ts` 测得语句基数 **20474**；入口壳 `probe-cli.ts` 实测 **10** 条 0% 语句 ⇒ 稀释 **0.0341pp** < 余裕 **0.94pp**（基线 69.94% 对阈值 69）⇒ 结论“不改 `vitest.config.ts`”，已撤销中途加入的 exclude 条目（`git diff -- vitest.config.ts` 为空）。同时把报告文本生成抽成纯函数并补 3 例单测，使本阶段真实覆盖率为：`runtime-loader.ts` 34/37 = 91.89%、`probe.ts` 69/81 = 85.18%（`probe-cli.ts` 10 条壳语句计入报告，不排除）。
- 改动面核对 `git status --porcelain` ⇒ 排除阶段 7 WIP 后剩 **11 条**（其中 `src/main/nikkisync/` 按目录计 1 条，实含 6 个文件）：
  - 修改 7 条：`AGENTS.md`、`electron.vite.config.ts`、`eslint.config.js`、`package.json`、`package-lock.json`、`scripts/AGENTS.md`、`src/main/index.ts`
  - 新增 4 条：`docs/sync-integration/01-dependency-link-plan.md`、`scripts/verify-nikkisync-link.ts`、`scripts/__tests__/verify-nikkisync-link.test.ts`、`src/main/nikkisync/`（`runtime-loader.ts` / `runtime-loader.test.ts` / `probe.ts` / `probe.test.ts` / `probe-cli.ts` / `AGENTS.md`）
  - 即按文件展开为 16 项产出；`vitest.config.ts` 零改动。阶段 7 WIP 的 8 项保持原样未被混入；`.tmp-phase1-*`、`dist/`、`node_modules/` 均为 gitignore 覆盖。
- **未执行 `git commit`**（用户决定，理由与恢复提交前置条件见 §13）；全程未使用 `--no-verify`，未绕过任何闸门。

### 执行期间发现并修复的真实缺陷

| #   | 缺陷                                                                                         | 表现                                                                               | 修复                                                                                                         |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| D1  | `specifierFor` 将常量名写成 `NIKKEISYNC_PACKAGES`（声明为 `NIKKISYNC_PACKAGES`，多一个 `E`） | 运行时 `ReferenceError: NIKKEISYNC_PACKAGES is not defined`，vitest 2 例失败       | 改回正确标识符，全仓 `grep NIKKEISYNC` 命中 0                                                                |
| D2  | ESLint 护栏用了核心规则不支持的 `importKind`，且核心规则不拦字面量 `import()`                | `npm run lint` 退出码 2（config 校验失败）；护栏可被 `import('@nikkisync/x')` 绕过 | `allowTypeImports: true` + `no-restricted-syntax` 的 `ImportExpression` 选择器（两层均实测行为）             |
| D3  | `probe-cli.ts` 用 `console.log` 输出                                                         | `src/**` 护栏报 6 个 error                                                         | 改 `process.stdout.write`（失败行保留 `console.error`）                                                      |
| D4  | `verify-nikkisync-link.ts` 把包目录按 XiangCe 目录解析（少一级 `../`）                       | 误报“四包未编译 / schema 缺失”，退出码 1                                           | 改为**以链接 realpath 为准**（回落才用声明路径），`EXPECTED_LINKS` 同时修正为 `../NikkiSync/...`；现退出码 0 |
| D5  | 探针结果仅写 `diagLog`，而本机 `diag.log` 已停更                                             | dev 模式无法断言探针结果                                                           | 钩子补走 `electronLogger.info`（与既有启动日志同口径），保留 `diagLog`                                       |
| D6  | 新增嵌套 AGENTS.md 未引用约定真相源                                                          | 全量测试新增 1 个失败文件                                                          | 补 `docs/CODING_CONVENTIONS.md` 引用（该契约由仓内守护测试强制）                                             |

### 与计划的主要偏差汇总

1. §8 的 ESLint 行形态与实际实现不同（见 D2），已回写 §8。
2. §9 步 6 的 grep 范围从“入口文件”扩为“全 chunk”；步 7 的退出码捕获命令换为 `cmd /v:on` 延迟展开；步 8 的断言渠道从 `diag.log` 改为 electron-log 标准输出。
3. §11 用例 3 的对象计数按实测回写：`type='table'` 共 13，全部对象 38。
4. 必需导出项数从 11 修正为 **12**。
5. §10 两条降级路径（方案 D junction、`new Function` 逃生箱）**均未触发**；`migrations` 路径在 dev/构建/Electron 三种形态下均可读，无需给 `initialize()` 显式传 `schemaSql`。
6. §13 提交按用户决定改为“本阶段不提交”，已补写原因与恢复前置条件。

### 终态复核（对当前工作区重跑全部门禁，不依赖过程记忆）

| 门禁                     | 命令                                                                                                                                       | 实测结果                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 构建                     | `npm run build`                                                                                                                            | 退出码 0                                                                                                                                             |
| 折叠校验                 | `Select-String dist\main\main\app\*.js -Pattern 'require\(.@nikkisync'` / `'await import\('`                                               | 命中 **0** / **3**                                                                                                                                   |
| Electron 探针            | `cmd /v:on /c "set ELECTRON_RUN_AS_NODE=1&& ...electron.exe dist\main\main\app\nikkisync-probe.js ... & echo PROBE_EXIT=!errorlevel!"`     | `PROBE_EXIT=0`；stdout 21 行（含 12 行 `[export  ]`）、stderr 0 字节；`host node=24.18.0 electron=41.10.6`、`tables=13 objects=38`、`[result  ] OK`  |
| dev 钩子存在性           | `Select-String src/main/index.ts -Pattern 'NIKKI_NIKKISYNC_PROBE'` 与 `dist\main\main\app\index.js -Pattern 'NIKKISYNC'`                   | 源码 L204 命中；当前产物 index.js 命中 7 处（证明钩子已编入本次产物）                                                                                |
| 类型 / Lint / 主进程测试 | `npm run typecheck` / `npm run lint` / `npm run test:main`                                                                                 | 退出码 2/1/1，错误集合与基线逐条相同（2 错 / `12 problems (1 error, 11 warnings)` / `Test Files 5 failed                                             | 185 passed (190)`，失败文件均为阶段 7 WIP） |
| 本阶段测试               | `npx vitest run src/main/nikkisync scripts/__tests__/verify-nikkisync-link.test.ts scripts/__tests__/verify-format-scope.test.ts`          | `Test Files 4 passed (4)`、`Tests 57 passed (57)`（含入口壳抽函数后新增的 3 例纯函数断言）                                                           |
| 链接诊断                 | `npm run verify:nikkisync`                                                                                                                 | 退出码 0，六项全 ✓                                                                                                                                   |
| NikkiSync 回归           | `npm test` / `npm run typecheck` / `npm run db:validate`                                                                                   | 退出码均 0；`tests 131 / pass 131 / fail 0`；`schema OK` + `foreign_key_check: ok` + `quick_check: ok`（13 对象）                                    |
| 覆盖率（替代口径）       | `npx vitest run src/main/nikkisync --coverage --coverage.all=true --coverage.include=src/**/*.ts ...` 与同作用于 nikkisync 目录            | 语句基数 20474；`probe-cli.ts` 10 条 0% 语句 ⇒ 稀释 0.0341pp < 余裕 0.94pp；`runtime-loader.ts` 91.89%、`probe.ts` 85.18%；`vitest.config.ts` 零改动 |
| 零污染                   | `git -C NikkiSync status --short`；`Test-Path dist\tmp-negative`；`Test-Path src\main\nikkisync\guard-probe.tmp.ts`；`.tmp-cov-*` 目录清理 | NikkiSync 仅 `?? .mimosa/`、`?? .zcode/`；两个临时验证产物均为 False；三个定向覆盖率输出目录已删除（`git status` 无遗留）                            |

⇒ §12 的 8 条验收标准已逐条取得直接证据；唯一未执行项为 §13 记录的“本阶段不提交”（用户决定，非遗漏）。
