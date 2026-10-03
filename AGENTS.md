# AGENTS.md

本文件为 Agent 与新协作者提供项目速览。修改项目结构或脚本时请同步更新。

## 项目概述

**wxnn-photo-manager**（无限暖暖相册管理工具，v2.5.3）——面向《无限暖暖》玩家的本地桌面相册管理器：扫描、浏览、编辑、整理、分享游戏照片。目标平台 Windows x64。

技术栈：Electron 40 + React 19 + TypeScript 5.9（strict）+ Zustand + Tailwind CSS 3 + better-sqlite3 + sharp + fluent-ffmpeg + i18next。构建工具为 electron-vite + electron-builder。

## 核心架构

Electron 三层分层（注意：**preload 位于 `src/main/` 下，没有独立的 `src/preload` 目录**）：

- **主进程**：入口 `src/main/index.ts`，负责窗口、IPC、数据库、扫描与后台 worker。
- **Preload**：入口 `src/main/preload.ts`（另有 `src/main/preload-logger.ts`），通过 `contextBridge.exposeInMainWorld` 暴露 `window.*` 桥（含对不受信任文档的门控）。IPC 契约（通道名/方法签名）必须保持稳定，详见 `docs/IPC_CONTRACT.md`；装配与门禁的模块级约定见 `src/main/preload/AGENTS.md`。
- **渲染进程**：入口 `src/renderer/main.tsx` + `src/renderer/index.html`；另有预览入口 `src/renderer/preview-entry.tsx`（经 `vite.preview.config.ts` 构建）。

**IPC 模式**：主进程在 `src/main/ipc/handlers/*.ts` 中按领域一个文件注册 `ipcMain.handle`，配套共享的 `handler-context.ts`、输入校验 `validator.ts` 与 `media-read-guard.ts`；渲染层一律经 `window.*` 桥调用；主/渲染共享的类型与错误定义在 `src/shared/`。

**构建产物**：electron-builder（NSIS win x64）输出到 `release/`；打包入口为 `dist/main/main/app/index.js`。

## 关键模块导航

### 嵌套 AGENTS.md（模块级速览，改动对应模块前先读）

| 模块               | 文件                                                                 | 覆盖内容                                                                                                                              |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 渲染进程           | [`src/renderer/AGENTS.md`](src/renderer/AGENTS.md)                   | 函数式组件约定、Zustand 状态管理、主题 CSS 变量、i18n、IPC 调用侧                                                                     |
| IPC handler 注册层 | [`src/main/ipc/handlers/AGENTS.md`](src/main/ipc/handlers/AGENTS.md) | `registerXxxHandlers` 模式、`wrapHandler` 家族、zod `schemas`、路径安全、契约稳定性                                                   |
| Preload 桥装配层   | [`src/main/preload/AGENTS.md`](src/main/preload/AGENTS.md)           | `contextBridge` 暴露模式、`exposeIfTrusted` origin 门禁、`call<T>()`/`subscribe()` 语义、依赖白名单、插件面收窄                       |
| 扫描流水线         | [`src/main/scanner/AGENTS.md`](src/main/scanner/AGENTS.md)           | 主进程薄壳 ↔ utilityProcess worker 拓扑、`WorkerCommand`/`WorkerEvent` 协议、扫描阶段序列、崩溃恢复与心跳、WAL 并发、E001–E005 诊断码 |
| 共享契约层         | [`src/shared/AGENTS.md`](src/shared/AGENTS.md)                       | 跨进程类型定义约定、AppError 错误体系、设置键白名单、纯函数工具约束、禁止 Node/Electron 依赖                                          |
| 业务服务层         | [`src/main/services/AGENTS.md`](src/main/services/AGENTS.md)         | 服务设计模式（class vs 函数模块）、依赖注入、handler 边界、原生模块惰性加载、文件安全与磁盘空间校验                                   |

其余模块（`src/main/database` 等）尚无模块级 AGENTS.md，跨模块任务需自行探索结构。新增嵌套指引时请同步本表。

### `src/main/`（主进程）

- `app/` — 应用引导
- `ipc/` — IPC 基础设施与 `handlers/`（app、backup、cache、category、data、dialog、duplicate、resonance 等约 40 个域文件）
- `preload/` — preload 桥命名空间模块（入口在 `src/main/preload.ts`），详见其 AGENTS.md
- `database/` — better-sqlite3 连接与仓储（media、resonance、import-root 等）
- `services/` — 备份、崩溃、解密、缩略图/pHash、视频、水印、XMP、分享等业务服务
- `scanner/`、`thumbnail/`、`scheduler/` — 照片扫描与缩略图流水线；`scanner/` 详见其 AGENTS.md
- `media-worker/`、`decryption-worker/` — 后台 worker；解密依赖 koffi + `nuan5_decryption.dll`
- `video-editor/`、`plugins/`、`i18n/`、`types/`、`utils/`

### `src/renderer/`（渲染进程）

- `pages/` — Gallery、Detail、Editor、Duplicates、Categories、OutfitGallery、RecycleBin、ResonanceRecords、Settings
- `stores/` — Zustand 状态（mediaStore、resonanceStore、uiStore、themeStore 等）
- `components/`（common/editor/gallery/layout/resonance/scanner/video）、`hooks/`、`search/`、`i18n/`、`plugins/`、`preview/`

### `src/shared/`（主/渲染共享契约）

- `types/`、`errors/`、`utils/`、`settings-keys.ts`、`scene-category.ts`、`dimension.ts`

其他：`docs/`（含 `IPC_CONTRACT.md`、`PLUGIN_API.md`）、`e2e/`（Playwright）、`scripts/`、`plugins-samples/`。

## 常用命令

```bash
npm run dev          # electron-vite dev 开发启动
npm run build        # 清理 + electron-vite build
npm run dist:win     # 打包 Windows 安装包（含预检查与产物校验）

npm test             # vitest run（变体：test:watch / test:coverage / test:main / test:renderer / test:db）
npm run typecheck    # tsc -b
npm run lint         # eslint .（lint:fix 自动修复）
npm run format       # prettier

npm run e2e:smoke    # Playwright 冒烟测试（perf 为性能用例）
```

## 编码约定

- TypeScript `strict: true`；主进程与脚本有独立 tsconfig。
- ESLint 9 flat config（`eslint.config.js`）+ Prettier。
- 提交信息遵循 Conventional Commits，经 husky（commit-msg 钩子）+ commitlint 校验；规范详情见 `.qoder/rules/project-conventions.md` 的「提交校验流程」节。
- 单元测试与源码同目录，命名 `*.test.ts(x)`（Vitest）。
- 代码注释与文档以中文为主；UI 文案走 i18next（zh/en），勿硬编码用户可见文本。
- 详细编码约束（IPC 白名单、AppError 错误分类、CSS 变量主题、React 组件模式、提交校验流程等）见 `.qoder/rules/project-conventions.md`。
