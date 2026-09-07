# 开发指南 DEVELOPMENT.md

> 面向零基础开发者的「无限暖暖相册管理工具」上手文档。
> 所有命令均可直接复制到 PowerShell 终端运行。
> 项目代号：`wxnn-photo-manager` / 应用名：NikkiGallery / 当前版本：2.5.0 / 平台：Windows x64

---

## 目录

- [一、环境要求](#一环境要求)
- [二、安装与启动命令](#二安装与启动命令)
- [三、目录说明](#三目录说明)
- [四、调试方法](#四调试方法)
- [五、代码规范](#五代码规范)
- [六、排错方案](#六排错方案)
- [七、打包流程](#七打包流程)
- [八、组件文档（Storybook）](#八组件文档storybook)

---

## 一、环境要求

### 1.1 必备软件

| 软件        | 版本          | 说明                                                     |
| ----------- | ------------- | -------------------------------------------------------- |
| **Node.js** | 20.x（LTS）   | 项目根目录 `.node-version` 锁定为 `20`，低于 20 无法启动 |
| **npm**     | 10+           | 随 Node.js 安装，无需单独装                              |
| **Git**     | 任意版本      | 用于版本控制，建议安装                                   |
| **Windows** | 10 1803+ / 11 | 打包目标平台；macOS 与 Linux 不支持                      |

### 1.2 推荐工具（可选）

- **Visual Studio Code**：编辑器，安装后建议加装以下扩展
  - ESLint
  - Prettier - Code formatter
  - Tailwind CSS IntelliSense
- **Trae IDE / Cursor**：AI 辅助开发环境

### 1.3 验证环境

```bash
node -v
```

预期输出：`v20.x.x`。

```bash
npm -v
```

预期输出：`10.x.x` 以上。

> 若 `node -v` 报错或版本低于 20，请到 [nodejs.org](https://nodejs.org/zh-cn) 下载 LTS 版本安装。

---

## 二、安装与启动命令

### 2.1 克隆或定位项目

项目根目录即本文件所在目录。命令均假设你在项目根目录下执行。

```bash
cd "h:\<username>\Documents\WXNN XiangCe2"
```

### 2.2 安装依赖（首次运行必做）

```bash
npm install
```

> 项目 `.npmrc` 当前仅含注释、无有效配置；Electron 与 electron-builder 的国内镜像通过环境变量注入
> （`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`，见 [6.1](#61-npm-install-失败)）。

### 2.3 重建原生模块（首次安装或切换 Node 版本后必做）

```bash
npx @electron/rebuild
```

> 原生模块：`better-sqlite3`、`sharp`、`koffi`。
> 不重建会出现 `Module not found` 或 `.node` 文件加载失败错误。
> 打包阶段由 `package.json` 的 `build.npmRebuild: true` 自动重建，本地只在切换 Node/Electron 版本后需要手动执行。

### 2.4 开发模式启动（exe 程序）

```bash
npm run dev
```

该命令由 `electron-vite dev` 驱动：

1. 编译主进程 TypeScript 到 `dist/main/`
2. 启动 Electron 桌面程序，渲染层由 Vite dev server 提供热更新

> 每次修改 `src/main/` 下代码后需重启 `npm run dev`；
> 修改 `src/renderer/` 下代码可使用 Vite HMR 热更新（需要单独运行 `vite`，见 [4.2](#42-前端热更新)）。

### 2.5 HTML 预览版（快速预览，无需启动 Electron）

```bash
npm run preview
```

打开浏览器访问 `http://localhost:5173/` 查看渲染层界面。

### 2.6 构建产物（不打包安装程序）

```bash
npm run build
```

包含清理、主进程编译、渲染进程打包三步，产物位于 `dist/` 目录。

> 本机 npm 有 Safe-Delete 网关，`npm run build` 的 clean 步骤删除 `dist/` 时可能触发 EPERM。
> 遇到时改用等价的分步命令：
>
> ```bash
> npx electron-vite build
> node -e "require('fs').writeFileSync('dist/main/package.json', JSON.stringify({ type: 'commonjs' }))"
> ```
>
> （`electron-vite build` 已自动写入 `dist/main/package.json`，第二步仅为保险。）

### 2.7 打包安装程序

```bash
npm run dist:win
```

详见 [七、打包流程](#七打包流程)。

### 2.8 打包产物冒烟测试（E2E）

对 `release/win-unpacked/` 产物做运行时冒烟（Playwright `_electron.launch`）：
验证启动不白屏、`app://` 协议加载、preload 注入、IPC/SQLite 探针、启动稳定性。

```bash
# 前置：release/win-unpacked 已存在（本地先 npm run dist:win）
npm run e2e:smoke

# 一键：打包 + 冒烟
npm run dist:win:smoke
```

- 用例与配置：`e2e/smoke.e2e.ts` / `e2e/playwright.config.ts`；方案见 `docs/archive/plans/e2e-smoke-playwright.md`
- CI 在 build job 打包后自动执行，失败时上传截图与主进程日志（artifact `e2e-smoke-failure`）
- 发布前还需按 `docs/manual-smoke-checklist.md` 人工清单逐项验证（扫描/解密/编辑等依赖真实样本的项）

---

## 三、目录说明

```
WXNN XiangCe/
├── src/
│   ├── main/                  # Electron 主进程（Node 环境）
│   │   ├── index.ts           # 主入口（早期防护 + 协议注册 + 启动 Application）
│   │   ├── preload.ts         # 预加载脚本入口：装配各命名空间并暴露 electronAPI（2026-08 拆分重构）
│   │   ├── preload-logger.ts  # preload 专用零依赖日志（禁止引入主进程 logger/i18n/app）
│   │   ├── preload/           # preload 拆分模块（按功能域命名空间化）
│   │   │   ├── ipc.ts               # IpcError 类 + call<T> 解包 + subscribe 事件订阅
│   │   │   ├── plugin-bridge.ts     # 插件能力桥（window.pluginAPI）+ i18n.t 注入点
│   │   │   └── api/                 # electronAPI 各命名空间（scanner/file/editor/... 共 29 个文件，每文件导出 <key>API 对象）
│   │   ├── app/               # 应用生命周期管理（23 个源文件）
│   │   │   ├── application.ts       # 应用主类
│   │   │   ├── lifecycle.ts         # 生命周期管理
│   │   │   ├── cleanup.ts           # 退出清理
│   │   │   ├── startup-tasks.ts     # 启动任务
│   │   │   ├── window-manager.ts    # 窗口管理
│   │   │   ├── desktop-shortcut.ts  # 桌面快捷方式
│   │   │   ├── error-handlers.ts    # 错误处理
│   │   │   ├── ipc-setup.ts         # IPC 注册编排
│   │   │   ├── media-protocol.ts    # media:// 协议
│   │   │   └── ...                  # media-update/recovery/theme 等
│   │   ├── database/          # SQLite 数据库管理
│   │   │   ├── connection.ts        # 数据库连接与表结构初始化
│   │   │   ├── media-repository.ts  # 媒体文件 CRUD
│   │   │   ├── resonance-repository.ts # 共鸣录 Repository（2.5.0）
│   │   │   ├── import-root-repository.ts # 导入根目录 Repository
│   │   │   └── worker/             # 数据库写操作进程拆分（utilityProcess）
│   │   ├── scanner/           # 文件扫描器
│   │   │   ├── index.ts             # 扫描器薄壳管理器
│   │   │   ├── scanner-worker-bridge.ts  # 与子进程通信桥
│   │   │   └── path-classifier.ts   # 路径分类（游戏/启动器/云相册等）
│   │   ├── media-worker/      # 缩略图/pHash/重复检测子进程
│   │   ├── scheduler/         # 分级任务调度队列
│   │   ├── services/          # 业务服务层（文件/视频/水印/分享/备份...）
│   │   ├── thumbnail/         # 缩略图生成器（基于 sharp）
│   │   ├── ipc/handlers/      # IPC 通道处理函数（按业务分文件，约 40 个）
│   │   ├── plugins/           # 插件宿主（plugin-host/permission-guard）
│   │   ├── video-editor/      # 视频编辑器子进程（bridge/filter-builder/watermark-builder）
│   │   ├── i18n/              # 主进程国际化
│   │   ├── utils/             # 主进程工具函数（logger/ffmpeg-paths/concurrency 等）
│   │   ├── types/             # 主进程专用类型声明
│   │   └── tsconfig.json      # 主进程 TypeScript 配置
│   │
│   ├── renderer/              # 渲染进程（浏览器环境，React 应用）
│   │   ├── App.tsx            # 根组件，路由切换
│   │   ├── main.tsx           # React 入口，挂载到 #root
│   │   ├── preview-entry.tsx  # 预览版入口
│   │   ├── index.html         # HTML 模板
│   │   ├── components/        # UI 组件
│   │   │   ├── common/             # 通用组件（Spinner/BaseDialog/Toast 等）
│   │   │   ├── editor/             # 图片编辑器组件
│   │   │   ├── gallery/            # 图库视图组件
│   │   │   ├── layout/             # 布局组件（AppShell/Sidebar/TitleBar）
│   │   │   ├── resonance/          # 共鸣录视图组件（2.5.0）
│   │   │   ├── scanner/            # 扫描进度组件
│   │   │   └── video/              # 视频播放器
│   │   ├── pages/             # 页面组件
│   │   │   ├── GalleryPage.tsx     # 图库主页
│   │   │   ├── DetailPage.tsx      # 详情页
│   │   │   ├── EditorPage.tsx      # 编辑器页
│   │   │   ├── SettingsPage.tsx    # 设置页
│   │   │   ├── CategoriesPage.tsx  # 分类管理
│   │   │   ├── DuplicatesPage.tsx  # 重复检测
│   │   │   ├── RecycleBinPage.tsx  # 回收站
│   │   │   ├── OutfitGalleryPage.tsx # 套装图鉴页
│   │   │   ├── ResonanceRecordsPage.tsx # 共鸣录（2.5.0）
│   │   │   └── settings/           # 设置页各分块
│   │   ├── hooks/             # 自定义 React Hooks
│   │   ├── stores/            # Zustand 状态管理
│   │   ├── i18n/              # 国际化（12 种语言）
│   │   ├── styles/            # 全局样式与主题
│   │   ├── plugins/           # 插件运行时（plugin-runtime.ts）
│   │   ├── search/            # 全文搜索索引（FlexSearch）
│   │   ├── preview/           # 预览版 mock 数据
│   │   ├── icons/             # SVG 图标统一管理
│   │   ├── utils/             # 渲染层工具函数
│   │   └── assets/            # 静态资源（服装/搭配名称 JSON）
│   │
│   ├── shared/                # 跨进程共享代码（主进程与渲染进程共用）
│   │   ├── types/             # 共享类型定义
│   │   ├── errors/            # 统一错误码与 AppError 类
│   │   ├── utils/             # 跨进程共享纯函数（concurrency/taskStages）
│   │   ├── settings-keys.ts   # 渲染层可写偏好 key 白名单
│   │   ├── dimension.ts       # 智能分组维度定义
│   │   └── scene-category.ts  # 场景分类定义
│   │
├── resources/                 # 应用资源
│   ├── icons/                 # 应用图标（.ico/.svg）
│   └── nuan5_decryption.dll   # 游戏内照片参数解密库
│
├── scripts/                   # 辅助脚本
│   ├── check-i18n-keys.ts     # i18n 键值完整性检查
│   ├── check-preview-drift.ts # 预览版与源码漂移检查
│   ├── generate-icon.js       # 图标生成
│   └── perf-test/             # 性能测试
│
├── docs/                      # 文档目录
│   ├── plans/                 # 进行中的修复/功能计划
│   ├── archive/               # 已完成的历史计划与报告
│   └── screenshots/           # 截图
│
├── tests/                     # 测试 setup
├── package.json               # 依赖与脚本定义
├── tsconfig.json              # 渲染层 TypeScript 配置
├── tsconfig.scripts.json      # 脚本 TypeScript 配置
├── electron.vite.config.ts    # 主/preload/renderer 三段式构建配置（renderer 端口 5173，根目录 src/renderer）
├── vite.preview.config.ts     # 单文件预览版构建配置
├── vitest.config.ts           # Vitest 测试配置
├── eslint.config.js           # ESLint 规则
├── .prettierrc                # Prettier 格式化规则
├── tailwind.config.ts         # Tailwind CSS 配置
├── postcss.config.cjs         # PostCSS 配置
└── ARCHITECTURE.md            # 架构文档（详细版）
```

### 关键约定

- **路径别名**：
  - `@/*` → `src/renderer/*`
  - `@main/*` → `src/main/*`
  - `@common/*` → `src/common/*`（`src/common` 已移除，该别名仅在配置中保留为历史遗留，新代码不要使用）
- **进程隔离**：主进程代码不能直接 import 渲染层，反之亦然；共享代码放 `src/shared/`
- **HTML 预览版**：`preview.html` 与 exe 程序**同步迭代**，界面/功能必须保持一致

---

## 四、调试方法

### 4.1 启动主进程调试

```bash
npm run dev
```

启动后 Electron 主进程日志会输出在终端窗口中。主进程代码修改后需要重启命令。

### 4.2 前端热更新（独立 Vite 服务）

```bash
npm run preview
```

浏览器访问 `http://localhost:5173/`，修改 `src/renderer/` 下代码可热更新。
**注意**：预览版无法调用 IPC（无 Electron 主进程），所有 `window.electronAPI` 调用会返回 `undefined`。

### 4.3 打开 Chrome DevTools

在运行中的 Electron 程序窗口中按 `Ctrl+Shift+I` 打开 DevTools，可查看：

- Console：渲染层日志
- Network：网络请求
- Application：localStorage / IndexedDB
- React DevTools（需自行安装扩展）

### 4.4 查看主进程日志

应用启动后，日志位于：

```
%APPDATA%\wxnn-photo-manager\logs\
```

PowerShell 直接打开：

```powershell
explorer "$env:APPDATA\wxnn-photo-manager\logs"
```

主要日志文件：

- `main.log`：应用运行日志
- `faults-YYYY-MM-DD.jsonl`：故障记录（10 类 FaultType，按日期滚动）
- `startup-errors.log`：启动错误日志（位于 userData 根目录或 `用户文档\NikkiGallery\Diagnostics\`，100KB 滚动）

### 4.5 查看数据库

数据库文件位于：

```
%APPDATA%\wxnn-photo-manager\database\wxnn_photo_manager.db
```

推荐使用 [DB Browser for SQLite](https://sqlitebrowser.org/) 打开查看。

### 4.6 类型检查

```bash
npm run typecheck
```

整个项目跑一遍 TypeScript 类型检查，不输出文件。

### 4.7 Lint 检查

```bash
npm run lint
```

自动修复可修复的问题：

```bash
npm run lint:fix
```

### 4.8 代码格式化

```bash
npm run format
```

仅检查不修改：

```bash
npm run format:check
```

### 4.9 运行单元测试

```bash
npm test
```

监听模式（文件改动自动重跑）：

```bash
npm run test:watch
```

生成覆盖率报告：

```bash
npm run test:coverage
```

> 覆盖率报告位于 `coverage/` 目录，浏览器打开 `coverage/index.html` 查看。

### 4.10 i18n 键值检查

```bash
npm run i18n:check
```

检查 12 种语言的翻译键是否齐全。

### 4.11 预览版漂移检查

```bash
npm run preview:check
```

检查 `preview.html` 与 `src/renderer/` 是否存在关键漂移（导航项、CSS 变量、i18n 覆盖率）。

### 4.12 VS Code 调试配置（可选）

在项目根目录创建 `.vscode/launch.json`：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Electron: Main",
      "type": "node",
      "request": "launch",
      "cwd": "${workspaceFolder}",
      "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron",
      "windows": {
        "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron.cmd"
      },
      "args": ["."],
      "preLaunchTask": "npm: build",
      "sourceMaps": true,
      "outFiles": ["${workspaceFolder}/dist/main/**/*.js"]
    }
  ]
}
```

可在主进程代码中打 `breakpoint` 进行断点调试。

---

## 五、代码规范

### 5.1 Prettier 格式

配置文件：`.prettierrc`

| 规则         | 值                    |
| ------------ | --------------------- |
| 缩进         | 2 空格                |
| 行宽         | 100 字符              |
| 分号         | 不使用                |
| 引号         | 单引号                |
| 尾随逗号     | 不使用                |
| 箭头函数参数 | 总是加括号 `(x) => x` |
| 换行符       | LF                    |

提交前请先运行：

```bash
npm run format
```

### 5.2 ESLint 规则

配置文件：`eslint.config.js`

关键规则（2026-08-22 起，以下质量规则均为 `error` 级别，提交与 CI 阶段硬性阻断）：

- `@typescript-eslint/no-explicit-any`：`error`（禁止显式 `any`，必须补充明确类型定义；确实无法确定时用 `unknown` + 类型收窄）
- `@typescript-eslint/no-unused-vars`：`error`（未使用变量直接报错；有意保留的参数/捕获错误以下划线 `_` 前缀命名）
- `react-hooks/exhaustive-deps`：`error`（Hooks 依赖数组必须完整，禁止遗漏或冗余）
- `no-empty`：`error`（空块禁止；空 catch 允许但必须加注释说明或进行处理）
- `@typescript-eslint/no-unsafe-function-type` / `@typescript-eslint/no-require-imports`：`error`（禁止 `Function` 类型和 `require()` 导入）
- `react/react-in-jsx-scope`：`off`（React 17+ JSX 转换无需 import React）
- `no-restricted-syntax`：`error`（i18n 护栏：禁止硬编码中文与调试用 console 调用，2026-08-22 起硬阻断。历史上的 legacy 白名单已于 2026-08-23 全量清偿并从 `eslint.config.js` 删除；测试文件整体豁免——断言/fixture 合法包含中文）

提交前请先运行并确保 **0 error**：

```bash
npm run lint
```

### 5.3 TypeScript 规范

- 严格模式：`strict: true`
- 未使用局部变量：报错
- 未使用参数：报错
- 路径别名：`@/` `@main/` `@common/`
- 共享类型放 `src/shared/types/`
- 跨进程通信类型必须定义在 `src/shared/types/ipc-types.ts`

### 5.4 命名约定

| 类型           | 风格                  | 示例                         |
| -------------- | --------------------- | ---------------------------- |
| 文件名（组件） | PascalCase.tsx        | `BaseDialog.tsx`             |
| 文件名（工具） | kebab-case.ts         | `file-utils.ts`              |
| 文件名（Hook） | camelCase 以 use 开头 | `useToast.ts`                |
| 文件名（测试） | 原文件名.test.ts      | `file-utils.test.ts`         |
| 类 / 接口      | PascalCase            | `ScannerManager`             |
| 函数 / 变量    | camelCase             | `generateThumbnail`          |
| 常量           | UPPER_SNAKE_CASE      | `MAX_SIGNATURE_SEARCH_DEPTH` |
| CSS 类         | kebab-case            | `.icon-btn`                  |
| React 组件     | PascalCase            | `<BaseDialog />`             |

### 5.5 代码组织原则

- **复用优先**：动手前先查 `src/shared/utils/` 与 `src/renderer/components/common/` 是否已有实现
- **小步快走**：每次只改一个功能点，跑测试验证后再继续
- **只解决当前问题**：不为未来投机设计，不为不存在的需求写代码
- **函数要小**：参数少、嵌套浅，大了就拆
- **Guard Clauses**：异常情况提前 return，主线逻辑不被层层包裹
- **错误必须处理**：要么返回有意义的值，要么向上抛，不静默吞掉
- **资源用完就关**：监听器、定时器、连接等

### 5.6 注释规范

- 只写「为什么」，不写「是什么」
- 代码本身读不懂时，先重构代码，不要靠注释解释
- 复杂业务逻辑或踩坑记录必须写注释

### 5.7 提交前必做检查

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run format:check
```

```bash
npm test
```

四项全绿才可提交。

---

## 六、排错方案

### 6.1 `npm install` 失败

**现象**：安装依赖报错或卡住。

**步骤**：

1. 切换到 npm 镜像：

   ```bash
   npm config set registry https://registry.npmmirror.com
   ```

2. 清理缓存重装：

   ```bash
   rm -rf node_modules
   rm package-lock.json
   npm cache clean --force
   npm install
   ```

3. 若 `electron` 下载失败，确认已配置国内镜像环境变量（不要写入项目 `.npmrc`，否则 npm 会报 `Unknown project config` 警告）。可设为用户级环境变量：

   ```
   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
   ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
   ```

### 6.2 启动报 `Module not found: ... .node`

**原因**：原生模块未编译或 Node 版本不匹配。

**解决**：

```bash
npx @electron/rebuild
```

若仍失败：

```bash
rm -rf node_modules
npm install
npx @electron/rebuild
```

### 6.3 `npm run dev` 启动后白屏

**步骤**：

1. 在程序窗口按 `Ctrl+Shift+I` 打开 DevTools 查看 Console 错误
2. 检查 `dist/main/` 与 `dist/renderer/` 目录是否生成：若无，运行：

   ```bash
   npx electron-vite build
   ```

### 6.4 TypeScript 类型报错

**全量类型检查**：

```bash
npm run typecheck
```

**常见错误**：

- `Cannot find module '@/components/...'`：路径别名未生效，检查 `tsconfig.json` 的 `paths`
- `Property 'xxx' does not exist on type ...`：接口未定义字段，到 `src/shared/types/` 添加
- `Type 'undefined' is not assignable to ...`：变量可能为 undefined，加判空或 `??` 默认值

### 6.5 单元测试失败

**单个文件调试**：

```bash
npx vitest run src/main/utils/file-utils.test.ts
```

**详细输出**：

```bash
npx vitest run --reporter=verbose
```

**常见问题**：

- jsdom 环境缺 API：到 `tests/setup.ts` 补齐 mock
- `window.electronAPI is undefined`：`tests/setup.ts` 已注入占位对象，按需 mock 具体方法

### 6.6 应用启动后无图片

快速排查：

1. 确认游戏已生成截图（`...\InfinityNikki\Saved\ScreenShot\` 等目录有文件）
2. 在程序「设置 → 扫描」点击「立即扫描」
3. 手动添加游戏目录到自定义扫描路径
4. 查看 `%APPDATA%\wxnn-photo-manager\logs\main.log` 是否有错误

### 6.7 应用崩溃闪退

崩溃 dump 位于（应用启动时已重定向到用户文档目录，避免藏在 AppData）：

```
%USERPROFILE%\Documents\NikkiGallery\Diagnostics\
```

PowerShell 打开：

```powershell
explorer "$env:USERPROFILE\Documents\NikkiGallery\Diagnostics"
```

> 崩溃文件保留最近 10 份且超过 30 天自动清理。

### 6.8 应用启动失败（启动对话框报错）

**步骤 1**：点击对话框「打开日志目录」按钮，查看 `startup-errors.log`

**步骤 2**：清理可能的损坏文件：

```powershell
explorer "$env:APPDATA\wxnn-photo-manager"
```

删除以下文件（**注意：先备份**）：

- `wxnn_photo_manager.db-wal`
- `wxnn_photo_manager.db-shm`
- `wxnn_photo_manager.db-journal`

**不要删除** `wxnn_photo_manager.db`（这是你的媒体数据库）。

**步骤 3**：重置配置（最后手段）：将 `config.json` 重命名为 `config.json.bak`，重启程序。

### 6.9 单实例锁冲突

**现象**：弹出「应用已在运行中」对话框。

**解决**：

1. 检查任务栏托盘是否有本程序图标
2. 点击对话框「清理并重启」按钮
3. 失败时点击「手动处理」，在任务管理器结束所有名为「无限暖暖相册管理工具」的进程

PowerShell 强制结束：

```powershell
Get-Process | Where-Object { $_.ProcessName -like '*wxnn*' -or $_.ProcessName -like '*无限暖暖*' } | Stop-Process -Force
```

### 6.10 更多排障

- 崩溃与启动问题：见上方 6.6 - 6.9 节
- 日志位置：`%APPDATA%\wxnn-photo-manager\logs\`（`main.log` 常规日志、`faults-*.jsonl` 故障记录；`startup-errors.log` 启动错误）
- 崩溃 dump：`%USERPROFILE%\Documents\NikkiGallery\Diagnostics\`
- 诊断包导出：设置 → 诊断 → 一键导出诊断包

---

## 七、打包流程

### 7.1 前置检查

打包前必须全绿：

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run format:check
```

```bash
npm test
```

**门禁基线（改动后以此为参照，判断是不是自己引入的问题）**：

| 命令                   | 基线结果                                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`    | **exit 0，零错误**                                                                                                                                                                              |
| `npm run lint`         | exit 1，但仅 16 个问题且全部落在 `.cache/`、`e2e/fullscreen-diagnose.e2e.ts`、`scripts/after-pack-vc-runtime.cjs` 三处历史文件；若只报这三处即视为通过（2026-08 基线，未随 2.5.0 文档同步复测） |
| `npm run format:check` | exit 0；注意 lint-staged 会对根目录 `*.md` 跑 `prettier --write`，改完大文档建议单独 `npx prettier --check <file>`                                                                              |
| `npm test`             | 全量 263 文件 / 4476 用例，**全绿**（2026-09-06 实测；历史基线中的 `path-safety.test.ts` 与 `GalleryStackOverflow.test.tsx` 两个环境性失败已在 2.5.0 修复）                                     |

### 7.2 完整打包命令

```bash
npm run dist:win
```

该命令依次执行：

1. `npm run build`：`clean` → `electron-vite build` → 写入 `dist/main/package.json`（`{"type":"commonjs"}`）
2. `npm run pre-dist-check`：产物时间戳差、关键修复点、Git 工作区，以及 README 中 Electron 版本与 `package.json` 一致
3. `electron-builder --win --publish never`：打包 Windows NSIS 安装程序
4. `npm run verify:dist`：校验 asar 内 VC++ 运行库等原生依赖已随包

### 7.3 分步执行（用于排错）

**只编译主进程 + 打包渲染层**（等价 `electron-vite build`）：

```bash
npx electron-vite build
```

**只打包安装程序（需先 build）**：

```bash
npx electron-builder --win --publish never
```

> 完整的发布序列（含产物校验，推荐发布时使用）：
>
> ```bash
> npx electron-vite build
> npm run pre-dist-check   # 产物时间戳差、关键修复点、Git 工作区，以及 README 中 Electron 版本与 package.json 一致
> npx electron-builder --win --publish never
> npm run verify:dist      # 校验 asar 内 VC++ 运行库等原生依赖已随包
> ```
>
> `npm run dist:win` 等价于上述四步（第一步为 `npm run build`，在本机可能因 Safe-Delete 网关失败，见 [2.6](#26-构建产物不打包安装程序)）。

### 7.4 产物位置

打包完成后，安装程序位于：

```
release/
├── NikkiGallery-Setup-2.5.0.exe       # NSIS 安装程序（artifactName: NikkiGallery-Setup-${version}.${ext}）
└── builder-effective-config.yaml             # 打包配置快照
```

### 7.5 打包配置（`package.json` 的 `build` 字段）

| 字段                           | 值                              | 说明                     |
| ------------------------------ | ------------------------------- | ------------------------ |
| `appId`                        | `com.qianlu.wxnn-photo-manager` | 应用唯一标识             |
| `productName`                  | `无限暖暖相册管理工具`          | 显示名称                 |
| `directories.output`           | `release`                       | 产物输出目录             |
| `files`                        | `dist/**/*`、`resources/**/*`   | 包含文件                 |
| `asarUnpack`                   | 见下表                          | 不进入 asar 的原生依赖   |
| `win.target`                   | `nsis` x64                      | Windows NSIS 安装程序    |
| `win.icon`                     | `resources/icons/icon.ico`      | 应用图标                 |
| `nsis.oneClick`                | `false`                         | 非一键安装，允许选择目录 |
| `nsis.createDesktopShortcut`   | `always`                        | 始终创建桌面快捷方式     |
| `nsis.createStartMenuShortcut` | `true`                          | 创建开始菜单快捷方式     |

**asarUnpack 列表**（原生二进制必须解包，否则无法加载）：

```
**/ffmpeg-static/**
**/ffprobe-static/**
**/better-sqlite3/**
**/bindings/**
**/file-uri-to-path/**
**/sharp/**
**/@img/**
**/koffi/**
**/@koromix/**
**/nuan5_decryption.dll
```

### 7.6 重新生成应用图标

若修改了 `resources/icons/icon.svg`，需重新生成 `.ico`：

```bash
node scripts/generate-icon.js
```

### 7.7 安装与测试

1. 双击 `release\NikkiGallery-Setup-2.5.0.exe` 安装
2. 安装完成后从开始菜单或桌面快捷方式启动
3. 首次启动会触发全盘扫描定位游戏目录（首次扫描较慢，请耐心等待）
4. 程序会自动在桌面创建快捷方式（若已存在则跳过）
5. 发布前先跑自动化冒烟：`npm run e2e:smoke`（需先 `npm run dist:win`）
6. 再按 `docs/manual-smoke-checklist.md` 人工冒烟清单逐项勾选（扫描/缩略图/解密/编辑导出等）

### 7.8 发布版本号管理

- **不要随意修改版本号**，除非用户明确要求
- 版本号定义在 `package.json` 的 `version` 字段（同时决定安装程序文件名：`NikkiGallery-Setup-<version>.exe`）
- 当前版本：`2.5.0`
- 改版本号后，`README.md` 的版本徽章、`ARCHITECTURE.md` / `ARCHITECTURE.en.md` 的「当前版本」、本文档头部版本号需同步修改

修改版本号示例（仅在用户要求时执行）：

```bash
npm version 2.4.0 --no-git-tag-version
```

### 7.9 HTML 预览版与 exe 同步原则

每次修改 exe 程序后，必须同步修改 `preview.html`（若存在），确保：

- 界面布局一致
- 配色方案一致
- 功能菜单层级一致
- 交互逻辑一致
- 视觉风格一致

漂移检查：

```bash
npm run preview:check
```

#### 7.9.1 同步检查清单

修改 `src/renderer/` 以下文件后，必须同步修改 `preview.html` 并通过 `npm run preview:check`：

| 修改的 exe 文件                                                          | 必须同步的 preview.html 内容                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------ |
| `components/layout/Sidebar.tsx`                                          | `SIDEBAR_NAV_ITEMS` 数组 + 角色档案切换器 + 底部统计区 |
| `components/layout/TitleBar.tsx`                                         | 标题栏结构 + 拖拽区                                    |
| `pages/GalleryPage.tsx`                                                  | 工具栏 + 视图模式 + 批量操作                           |
| `pages/DetailPage.tsx`                                                   | 详情页布局 + EXIF 面板 + 键盘导航                      |
| `pages/EditorPage.tsx` + `components/editor/*`                           | EditorToolbar + EditorTabs + 直方图                    |
| `pages/SettingsPage.tsx`                                                 | 设置项 + 子页面                                        |
| `pages/CategoriesPage.tsx` / `RecycleBinPage.tsx` / `DuplicatesPage.tsx` | 对应页面                                               |
| `styles/globals.css` + `styles/themes/*.css`                             | `:root` 与 `.soft-pink-luxury` CSS 变量                |
| `i18n/locales/zh-CN.json`                                                | 中文文案（preview 硬编码）                             |
| `package.json` dependencies                                              | preview CDN 引用版本                                   |

#### 7.9.2 提交前必跑

```bash
npm run preview:check    # 必须 PASS 或仅 WARN
npm run typecheck        # TypeScript 类型检查
npm run lint             # ESLint 检查
```

> 治理方案与检测维度详见 `npm run preview:check` 命令输出与 `scripts/check-preview-drift.ts` 源码。

---

## 八、组件文档（Storybook）

渲染层组件文档站基于 Storybook 10（`@storybook/react-vite`），提供每个组件的 Props 说明、
状态示例与无障碍面板。使用与编写规范见 `docs/Storybook使用指南.md`。

### 8.1 启动与构建命令

启动本地文档站（默认端口 **6006**，支持源码 / stories / i18n 热更新，可与 `npm run dev` 并行）：

```bash
npm run storybook
```

构建静态站点（产物位于 `storybook-static/`，可直接部署；CI 在 `storybook` job 中构建并上传同名 artifact）：

```bash
npm run build-storybook
```

### 8.2 目录约定

| 位置                                                 | 约定                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `.storybook/`                                        | 配置根目录：`main.ts`（故事发现）/ `preview.ts`（全局装饰与 `window.electronAPI` 桩）/ `decorators/` / `mocks/` |
| `src/renderer/components/**/*.stories.tsx`           | stories 与组件源码**同置**（同名同目录），修改组件时顺手维护故事                                                |
| `docs/storybook/`                                    | 文档站内的 MDX 指南页（无障碍指引 / 设计令牌 / electronAPI mock 说明）                                          |
| `docs/Storybook使用指南.md` / `docs/组件文档规范.md` | 仓库内的使用说明与编写规范                                                                                      |

### 8.3 编写与维护约定（摘要）

- 新增 / 重大修改组件必须随提交附带故事（`docs/组件文档规范.md` §6 增量规则）；
- 组件在 story 中应保持真实状态，不得硬造假数据掩盖缺陷；源码级问题登记 `docs/技术债清单.md`；
- 验收基线：带故事的组件在 addon-a11y 面板中零 `serious`/`critical` 违规（实测记录见 `docs/storybook/accessibility.mdx`）。

---

## 附录：常用命令速查

| 任务                  | 命令                            |
| --------------------- | ------------------------------- |
| 安装依赖              | `npm install`                   |
| 重建原生模块          | `npx @electron/rebuild`         |
| 开发模式启动 exe      | `npm run dev`                   |
| 启动 HTML 预览        | `npm run preview`               |
| 类型检查              | `npm run typecheck`             |
| Lint 检查             | `npm run lint`                  |
| Lint 自动修复         | `npm run lint:fix`              |
| 代码格式化            | `npm run format`                |
| 运行单元测试          | `npm test`                      |
| 测试监听模式          | `npm run test:watch`            |
| 测试覆盖率            | `npm run test:coverage`         |
| i18n 键检查           | `npm run i18n:check`            |
| 预览版漂移检查        | `npm run preview:check`         |
| 构建产物              | `npm run build`                 |
| 打包 Windows 安装程序 | `npm run dist:win`              |
| 重新生成图标          | `node scripts/generate-icon.js` |
| 启动组件文档站        | `npm run storybook`             |
| 构建组件文档静态站点  | `npm run build-storybook`       |

---

## 附录：相关文档

- [README.md](README.md)：项目简介与功能特性
- [ARCHITECTURE.md](ARCHITECTURE.md)：架构文档（详细版）
- [docs/tutorial/用户使用教程.md](docs/tutorial/用户使用教程.md)：用户使用指南
- [docs/IPC_CONTRACT.md](docs/IPC_CONTRACT.md)：IPC 契约规范
- [docs/PLUGIN_API.md](docs/PLUGIN_API.md)：插件 API 参考
- [docs/技术债清单.md](docs/技术债清单.md)：技术债台账
- [docs/Storybook使用指南.md](docs/Storybook使用指南.md)：组件文档站使用说明
- [docs/archive/项目架构全景.md](docs/archive/项目架构全景.md)：项目架构全景（零基础导读）

---

## 开发者信息 / 作者与社交平台

- **抖音**：纤璐不会玩摄影 ([主页链接](https://v.douyin.com/Dx67wYkw48A/))
- **小红书**：纤璐不会玩摄影 ([主页链接](https://www.xiaohongshu.com/user/profile/69270bb200000000370092db))
- **哔哩哔哩**：纤璐不会玩摄影 ([主页链接](https://b23.tv/zCR5oGE))
- **GitHub**：[QianQianLuLu1](https://github.com/QianQianLuLu1)
- **CSDN博客**：[QianQian-LuLu](https://blog.csdn.net/2604_96788940)
- **作者官网**：https://ppebv9al.qwenwork.host/

---

## 许可证

MIT License
