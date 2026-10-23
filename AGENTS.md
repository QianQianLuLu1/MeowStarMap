# AGENTS.md

本文件为 Agent 与新协作者提供项目速览。修改项目结构或脚本时请同步更新。

## 项目概述

**meow-star-map**（喵星图，v2.5.5）——面向《无限暖暖》玩家的本地桌面相册管理器：扫描、浏览、编辑、整理、分享游戏照片。目标平台 Windows x64。

技术栈：Electron 41 + React 19 + TypeScript 5.9（strict）+ Zustand + Tailwind CSS 3 + better-sqlite3 + sharp + fluent-ffmpeg + i18next。构建工具为 electron-vite + electron-builder。

## 核心架构

Electron 三层分层（注意：**preload 位于 `src/main/` 下，没有独立的 `src/preload` 目录**）：

- **主进程**：入口 `src/main/index.ts`，负责窗口、IPC、数据库、扫描与后台 worker。
- **Preload**：入口 `src/main/preload.ts`（另有 `src/main/preload-logger.ts`），通过 `contextBridge.exposeInMainWorld` 暴露 `window.*` 桥（含对不受信任文档的门控）。IPC 契约（通道名/方法签名）必须保持稳定，详见 `docs/IPC_CONTRACT.md`；装配与门禁的模块级约定见 `src/main/preload/AGENTS.md`。
- **渲染进程**：入口 `src/renderer/main.tsx` + `src/renderer/index.html`；另有预览入口 `src/renderer/preview-entry.tsx`（经 `vite.preview.config.ts` 构建）。

**IPC 模式**：主进程在 `src/main/ipc/handlers/*.ts` 中按领域一个文件注册 `ipcMain.handle`，配套共享的 `src/main/ipc/handler-context.ts`、输入校验 `src/main/ipc/validator.ts` 与 `src/main/ipc/media-read-guard.ts`（三者位于 handlers/ 上一级目录）；渲染层一律经 `window.*` 桥调用；主/渲染共享的类型与错误定义在 `src/shared/`。

**构建产物**：electron-builder（NSIS win x64）输出到 `release/`；打包入口为 `dist/main/main/app/index.js`。

## 关键模块导航

### 嵌套 AGENTS.md（模块级速览，改动对应模块前先读）

| 模块               | 文件                                                                 | 覆盖内容                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 渲染进程           | [`src/renderer/AGENTS.md`](src/renderer/AGENTS.md)                   | 函数式组件约定、Zustand 状态管理、主题 CSS 变量、i18n、IPC 调用侧                                                                                                          |
| IPC handler 注册层 | [`src/main/ipc/handlers/AGENTS.md`](src/main/ipc/handlers/AGENTS.md) | `registerXxxHandlers` 模式、`wrapHandler` 家族、zod `schemas`、路径安全、契约稳定性                                                                                        |
| Preload 桥装配层   | [`src/main/preload/AGENTS.md`](src/main/preload/AGENTS.md)           | `contextBridge` 暴露模式、`exposeIfTrusted` origin 门禁、`call<T>()`/`subscribe()` 语义、依赖白名单、插件面收窄                                                            |
| 扫描流水线         | [`src/main/scanner/AGENTS.md`](src/main/scanner/AGENTS.md)           | 主进程薄壳 ↔ utilityProcess worker 拓扑、`WorkerCommand`/`WorkerEvent` 协议、扫描阶段序列、崩溃恢复与心跳、WAL 并发、E001–E005 诊断码                                      |
| 共享契约层         | [`src/shared/AGENTS.md`](src/shared/AGENTS.md)                       | 跨进程类型定义约定、AppError 错误体系、设置键白名单、纯函数工具约束、禁止 Node/Electron 依赖                                                                               |
| 业务服务层         | [`src/main/services/AGENTS.md`](src/main/services/AGENTS.md)         | 服务设计模式（class vs 函数模块）、依赖注入、handler 边界、原生模块惰性加载、文件安全与磁盘空间校验                                                                        |
| 应用生命周期编排层 | [`src/main/app/AGENTS.md`](src/main/app/AGENTS.md)                   | Application 协调者 + AppContext 依赖注入、8 阶段启动流程、退出清理链、GPU 自愈、自定义协议（media:// / app://）、导航授信、早期弹窗约束                                    |
| 主进程核心工具层   | [`src/main/utils/AGENTS.md`](src/main/utils/AGENTS.md)               | 工具分类（叶子层/日志/安全/FFmpeg/媒体分析/进度）、依赖分层、fail-open 错误策略、i18n 分层、Windows 特化                                                                   |
| 构建工具链与脚本   | [`scripts/AGENTS.md`](scripts/AGENTS.md)                             | 打包校验闸门、i18n 治理工具链、技术债管理、性能基线、数据生成、dry-run 默认、纯函数导出、npm scripts 速查                                                                  |
| 数据库连接与仓储层 | [`src/main/database/AGENTS.md`](src/main/database/AGENTS.md)         | 读写分离架构（同步读/async 写经 worker bridge）、WAL 并发约束、Repository 模式、schema 迁移、FakeDb 测试约定                                                               |
| 批量媒体 worker    | [`src/main/media-worker/AGENTS.md`](src/main/media-worker/AGENTS.md) | 缩略图/pHash/重复/相似检测批量任务、Manager 薄壳 ↔ utilityProcess worker 拓扑、四类任务独立取消、BK-tree 相似检索、崩溃恢复与批量让位                                      |
| 单文件缩略图生成   | [`src/main/thumbnail/AGENTS.md`](src/main/thumbnail/AGENTS.md)       | ThumbnailGenerator 类（缓存 LRU/并发信号量/视频抽帧/降级策略）、单文件 worker 化、三档参数同步约束、损坏文件标记                                                           |
| NikkiSync 移植面   | [`src/main/sync/AGENTS.md`](src/main/sync/AGENTS.md)                 | 移植面服务层与 `server/`（认证/配对/TLS 身份/自研 HTTPS+WS）；与装载面的分工、以及移植面服务「已交付但默认不自启」的口径                                                   |
| NikkiSync 装载缝   | [`src/main/nikkisync/AGENTS.md`](src/main/nikkisync/AGENTS.md)       | 外部 `@nikkisync/*` 包的唯一入口：变量式动态 import 的原因与护栏、不引用上游类型（协议真相源在 `shared/sync`）、探针禁止启动任何服务、链接由 `npm run link:nikkisync` 建立 |

其余模块尚无模块级 AGENTS.md，跨模块任务需自行探索结构。新增嵌套指引时请同步本表。

### 核心路径保护（两层闸门：ESLint 格式护栏 + 提交面 diff 闸门）

以下路径定义了跨进程契约的核心接口，任何实质变更都需携带与本次改动关联的显式授权（避免恒真的存在性检查）：

| 受保护路径                      | 保护原因                                                | 闸门             |
| ------------------------------- | ------------------------------------------------------- | ---------------- |
| `src/main/preload/api/**/*.ts`  | Preload API 命名空间，定义渲染层对外暴露的 IPC 契约接口 | 两层闸门（见下） |
| `src/main/ipc/handlers/**/*.ts` | IPC handler 注册层，定义主进程通道注册与参数校验        | 两层闸门（见下） |
| `src/main/services/**/*.ts`     | 业务服务层，承载主进程核心业务逻辑                      | 两层闸门（见下） |
| `src/shared/errors/**/*.ts`     | AppError 错误体系，定义跨进程统一错误基类与错误码       | 两层闸门（见下） |

两层闸门分工：

1. **ESLint 静态格式护栏**（`local/core-path-guard`）：不强制要求授权注释存在；一旦存在 `// @core-change:` 行注释（文件顶部前 5 行内），则校验「至多一条、原因非空、不得为批量占位文案」，违规即 lint 报错。
2. **提交面 diff 闸门**（`scripts/core-path-gate.ts`，接入 `.husky/pre-commit` 与 `npm run verify`）：对本次 diff（pre-commit 为暂存区，verify 为工作区）判定——受保护文件存在实质改动（授权注释行之外的增删）时，必须**同批新增**一行含真实原因的授权注释，否则拦截。删除文件、纯注释增删不触发。

**变更流程**：修改受保护路径中的文件时，在文件顶部（前 5 行内）放置**至多一条** `// @core-change: <本次真实中文原因>`（如 `// @core-change: 新增 media:cleanup 清理通道`），并随同一批改动提交；下次改动需**替换**该注释为新原因，旧原因不复用。测试文件（`*.test.ts` / `*.spec.ts` / `__tests__/`）与 handlers 下 `_` 前缀共享文件豁免。

**范围同步守护**：`scripts/__tests__/core-path-gate.test.ts` 校验闸门的 `PROTECTED_GLOBS` 与 eslint.config.js 中 `core-path-guard` 各块的 files 并集一致（双侧漂移即测试失败），并守护受保护目录中不得残留「核心路径保护规则初始化」批量占位文案。

### `src/main/`（主进程）

- `app/` — 应用引导、生命周期编排（详见其 AGENTS.md）
- `ipc/` — IPC 基础设施与 `handlers/`（app、backup、cache、category、data、dialog、duplicate、resonance 等 47 个域文件，其中 4 个为 `_` 前缀辅助与 `set-dir-handler` 工厂、43 个 `registerXxxHandlers`）；`handlers/` 详见其 AGENTS.md
- `preload/` — preload 桥命名空间模块（入口在 `src/main/preload.ts`），详见其 AGENTS.md
- `database/` — better-sqlite3 连接与仓储（media、resonance、import-root 等）
- `services/` — 备份、崩溃、解密、缩略图/pHash、视频、水印、XMP、分享等业务服务（详见其 AGENTS.md）
- `scanner/`、`thumbnail/`、`scheduler/` — 照片扫描与缩略图流水线；`scanner/`、`thumbnail/` 详见其 AGENTS.md
- `media-worker/`、`decryption-worker/` — 后台 worker；`media-worker/` 详见其 AGENTS.md；解密依赖 koffi + `nuan5_decryption.dll`
- `sync/`、`nikkisync/` — 同步能力的两面：`sync/` 为 NikkiSync 协议的**移植面**服务层（auth/pairing/identity），`nikkisync/` 为直接复用 NikkiSync 包的**外部包装载缝**（两者分工见各自 AGENTS.md）
- `video-editor/`、`plugins/`、`i18n/`、`types/`
- `utils/` — 主进程核心工具层（详见其 AGENTS.md）

### `src/renderer/`（渲染进程）

- `pages/` — Gallery、Detail、Editor、Duplicates、Categories、OutfitGallery、RecycleBin、ResonanceRecords、Settings
- `stores/` — Zustand 状态（mediaStore、resonanceStore、uiStore、themeStore 等）
- `components/`（common/editor/gallery/layout/resonance/scanner/video）、`hooks/`、`search/`、`i18n/`、`plugins/`、`preview/`

### `src/shared/`（主/渲染共享契约）

- `types/`、`errors/`、`utils/`、`settings-keys.ts`、`scene-category.ts`、`dimension.ts`

其他：`docs/`（含 `IPC_CONTRACT.md`、`PLUGIN_API.md`）、`e2e/`（Playwright）、`scripts/`（详见其 AGENTS.md）、`plugins-samples/`。

## 常用命令

```bash
npm run dev          # electron-vite dev 开发启动
npm run build        # 清理 + electron-vite build
npm run dist:win     # 打包 Windows 安装包（含预检查与产物校验）

npm test             # vitest run（变体：test:watch / test:coverage / test:main / test:renderer / test:db）
npm run test:ci-linux # 在开发机上按 CI（ubuntu-latest）的宿主语义跑同一批用例（path 绑定/平台/cwd 与家目录/根不可写/electron 未装）；只读诊断，不进 CI
npm run typecheck    # tsc -b（src 层，emit 落在 .cache/tsmain，不写 dist/main）+ tsc -p tsconfig.scripts.json（scripts/ 工具层）；local verify/pre-commit 只跑前者，CI 跑全量
npm run typecheck:e2e # tsc --noEmit -p e2e（e2e/ 层）；上面两者都收不到 e2e/，CI 的 lint-typecheck job 也跑它，不得折进 typecheck（TS6310）
npm run lint         # eslint .（lint:fix 自动修复）
npm run format       # prettier
npm run verify       # 变更后只读验证（typecheck + eslint 只读 + prettier --check + 相关单测；不改动文件）

npm run e2e:smoke    # Playwright 冒烟测试（perf 为性能用例）
npm run e2e          # 误输入守卫：冒号两侧被打上空格时列出真实子命令并以 1 退出
```

## 变更后验证工作流（Agent 必读）

**每次代码变更后必须运行验证**，确保 typecheck + lint + 格式 + 相关单测通过后再提交。`verify` 系列命令**只读**，绝不改动你的文件。

### 一键验证命令

```bash
npm run verify          # 验证所有变更文件（typecheck + lint + 格式 + 相关单测，只读）
npm run verify:staged   # 仅验证暂存文件（检查集与 pre-commit 对齐，但仍只读：不会替你改写文件）
```

### 验证闭环说明

| 时机            | 触发方式                                            | 验证内容                                                                                       | 输出标记       |
| --------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------- |
| Agent 变更后    | `npm run verify`                                    | typecheck + eslint（无 `--fix`）+ 核心路径授权闸门 + prettier `--check` + 相关单测             | `[VERIFY]`     |
| `git commit` 前 | `.husky/pre-commit`                                 | lint-staged（`eslint --fix` + `prettier --write` + `test:precommit`）+ 核心路径闸门 + `tsc -b` | `[PRE-COMMIT]` |
| 手动指定文件    | `npx tsx scripts/verify-changes.ts path/to/file.ts` | 同 `npm run verify`（只读）                                                                    | `[VERIFY]`     |

### verify 与 pre-commit 闸门的差异（必读）

两者**不等价**：`verify` 只做只读检查，pre-commit 会改写文件。

| 维度         | `npm run verify` / `verify:staged`                                                                                             | `.husky/pre-commit`（lint-staged）                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 是否改动文件 | 否：`eslint` 不带 `--fix`、格式只用 `prettier --check`                                                                         | 是：`eslint --fix` + `prettier --write` 改写工作区并自动重新暂存   |
| 目标文件来源 | `verify` = `git diff HEAD`（工作区，含未暂存改动）；`verify:staged` = `git diff --cached`；手动模式 = 指定路径                 | 暂存区文件，由 `package.json` 的 `lint-staged` glob 按路径匹配     |
| 格式检查     | `prettier --check --end-of-line auto`，作用域取自 lint-staged 中含 `prettier` 任务的键                                         | 同一作用域，但用 `--write` 直接改写（因此几乎不会因格式阻止提交）  |
| lint 严格度  | 更严：可自动修复的问题也判为 ✗                                                                                                 | 自动修复后静默通过，仅不可修复问题阻止提交                         |
| 相关单测     | 超集：对所有变更 TS 文件按 `scripts/find-related-tests.ts` 匹配并运行（含 `scripts/`、`.storybook/`、`e2e/` 下的 `*.test.ts`） | `test:precommit` 仅由 `src/**/*.{ts,tsx}` 键触发，其他路径不跑测试 |
| typecheck    | 目标含 `.ts/.tsx` 时 `tsc -b`                                                                                                  | 暂存含 `.ts/.tsx` 时 `tsc -b`                                      |

必须记住的四点：

1. **verify 通过 ≠ 提交时文件不变**：钩子仍可能修复格式与可自动修复的 lint 问题并重新暂存；提交后用 `git status --porcelain` 复核。
2. **格式检查范围 = 钩子格式范围**：逐字取自 `package.json` 的 `lint-staged` 中含 `prettier` 任务的键（当前为 `src/**/*.{ts,tsx}`、`.storybook/**/*.{ts,tsx}`、`e2e/**/*.{ts,tsx}`、`src/**/*.{js,jsx,json,css,md}`、`scripts/**/*.{ts,js}`、仓库根 `*.{ts,js,json,md}`）。`docs/**`、`.qoder/rules/*.md`、`scripts/AGENTS.md` 不在闸门格式范围内，verify 也不会因此判失败；`scripts/__tests__/verify-format-scope.test.ts` 会同时守护"配置键形态"与"本文件列举的作用域"，两侧漂移即失败。
3. **行尾不参与判定**：本机 `core.autocrlf=true` 时工作区为 CRLF、提交内容为 LF，故格式检查传 `--end-of-line auto` 避免假失败（钩子改写行尾不会改变提交内容）。
4. **`tsc -b` 的 emit 与产物树隔离**：落点由 `src/main/tsconfig.json` 的 `outDir`（现为 `.cache/tsmain`）决定，不得指回 `dist/main`。被引用的 composite 项目不能禁 emit（`tsc -b --noEmit` 会报 TS6310），所以只能迁 outDir；一旦写回 `dist/main`，electron-vite 的 `preload.js` 会被覆写成 per-file CJS，`sandbox: true` 的 preload 无法 require 兄弟模块，走 `launchBuiltApp()` 的 e2e 用例（如 NikkiSync N1）便以 `window.electronAPI` undefined 假失败。防线两处：`e2e/dist-guard.ts` 在启动前拦截并提示先 `npm run build`，`scripts/__tests__/typecheck-emit-isolation.test.ts` 守护落点不回搬。

本地闸门只做增量检查：全量 `npm run lint`、`npm run typecheck`、`npm run typecheck:e2e`、`npm run i18n:guard` 与全量 `npm test` 由 CI 保障。`e2e/` 必须单独走 `typecheck:e2e`——`tsc -b` 只看根 tsconfig（include 为 `src/renderer` 与 `src/common`、reference 为 `src/main`），`tsc -p tsconfig.scripts.json` 只收 `scripts/`，两者都覆盖不到 `e2e/**`；该覆盖面由 `scripts/__tests__/typecheck-emit-isolation.test.ts` 的「闸门覆盖面」用例钉住。

### Agent 工作流

1. 修改代码文件后，立即运行 `npm run verify`
2. 查看输出中的 `[VERIFY]` 或 `[PRE-COMMIT]` 标记行定位失败阶段
3. 若 `format` 或 `lint` 失败，自行落地修复（`npm run format` / `npx prettier --write <文件>`、`npm run lint:fix`），再重跑 `npm run verify`
4. 全部通过后再 `git add` 并 `git commit`（pre-commit 钩子会再次确认，并可能改写文件）
5. 提交后运行 `git status --porcelain`，确认钩子没有留下未预期的改动

### 输出诊断格式

验证脚本输出以固定前缀标记，便于 Agent 解析：

- `[VERIFY] ▶` — 开始执行某步骤
- `[VERIFY] ✓` — 步骤通过
- `[VERIFY] ✗` — 步骤失败（汇总行步骤名：`typecheck` / `lint` / `core-gate` / `format` / `test`）
- `[VERIFY] ⊘` — 步骤跳过（无相关文件）
- `[VERIFY] ⚠` — 非阻断提示（源文件缺少匹配套件、无法解析的 lint-staged 键）
- `[PRE-COMMIT]` — pre-commit 钩子输出，格式同上

## 编码约定

- TypeScript `strict: true`；主进程与脚本有独立 tsconfig。
- ESLint 9 flat config（`eslint.config.js`）+ Prettier。
- 提交信息遵循 Conventional Commits，经 husky（commit-msg 钩子）+ commitlint 校验；规范详情见 [`docs/CODING_CONVENTIONS.md`](docs/CODING_CONVENTIONS.md) 的「校验与提交」节。
- 单元测试与源码同目录，命名 `*.test.ts(x)`（Vitest）。
- 代码注释与文档以中文为主；UI 文案走 i18next（12 个 locale 包，zh-CN 为基准静态加载、其余 11 种动态加载，另有「跟随系统」auto），勿硬编码用户可见文本。
- 详细编码约束（IPC 白名单、AppError 错误分类、CSS 变量主题、React 组件模式、源文件编码 UTF-8 无 BOM 与行尾 LF、路径语义三分法「比较层钉 win32 / IO 层保宿主 / 混合输入走方言」、校验与提交等）见 [`docs/CODING_CONVENTIONS.md`](docs/CODING_CONVENTIONS.md)，该文件是唯一真相源。路径语义的落档由 `scripts/__tests__/path-semantics-guard.test.ts` 登记并守卫（PINNED / DIALECT / HOST_IO 三张表；新文件引入 win32 钉或方言引用而未登记 ⇒ 守卫红）。
- 版本控制边界：根与模块级 `AGENTS.md`、`docs/CODING_CONVENTIONS.md` 均入仓，本文件导航表列出的每个路径都必须能解析到已跟踪文件；`.qoder/` 目录与 `.mimosa/`、`.trae/`、`.zcode/`、`.codebuddy/`、`.workbuddy*/`、`.codegraph/` 一样保持本地化（`.gitignore` 排除），其下的 IDE 规则文件仅作 `docs/CODING_CONVENTIONS.md` 的逐字镜像、skills 仅作本地装配，不得作为任何被跟踪指引的出处。
