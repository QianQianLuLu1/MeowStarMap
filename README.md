<h1 align="center">喵星图 · Meow Star Map</h1>

<p align="center">  
  专为「无限暖暖」玩家打造的本地相册管理软件 — 扫描、浏览、编辑、整理、分享，一站式完成

A local photo album manager for <em>Infinity Nikki</em> players — scan, browse, edit, organize & share
</p>

<p align="center">  
  <img src="https://img.shields.io/badge/version-2.5.5-blue?style=flat-square">  
  <img src="https://img.shields.io/badge/platform-Windows%20x64-success?style=flat-square">  
  <img src="https://img.shields.io/badge/Electron-41.10-blueviolet?style=flat-square">  
  <img src="https://img.shields.io/badge/React-19.2-61dafb?style=flat-square">  
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square">  
</p>

<p align="center">  
  <a href="#中文">中文</a> · <a href="#english">English</a>  
</p>

---

<h2 id="中文">中文</h2>

一款专为「无限暖暖」游戏玩家设计的 **Windows 桌面端** 相册管理软件。自动扫描游戏截图与录屏文件，提供专业的图片浏览、编辑、分类管理和搜索功能。所有数据存储在本地，不上传任何云端。

### 核心特性

- **智能扫描** — 自动定位游戏目录（Steam / Epic 注册表 + 全盘签名扫描），增量扫描，多盘符并发；智能区分游戏截图、启动器缓存与云相册三类来源
- **多视图图库** — 网格、列表、瀑布流、时间线、活动时间轴 5 种浏览模式；全屏查看与幻灯片播放；支持 Ctrl / Shift 多选批量操作
- **专业图片编辑** — 14 项基础调整（亮度 / 对比度 / 饱和度 / 色温等）+ HSL 八色独立调色 + RGB 多通道曲线 + 色调分离 + 滤镜预设；完整撤销 / 重做与批量应用
- **视频处理** — 缩略图提取、视频裁剪、调速（0.25x–4x）、格式转换、Apple Live Photo 导出
- **智能整理** — 系统分类 + 三级自定义分类树（拖拽排序 / 颜色标签），标签管理，5 种智能分组维度（相册类型 / 场景 / 时段 / 套装 / 类型，另含「不分组」）
- **重复检测** — SHA256 精确比对 + 感知哈希（pHash）双重检测，4 维智能评分推荐保留项
- **分享与备份** — 微信 / QQ / vivo 剪贴板分享 + WiFi 局域网传输（PIN 鉴权）；自动定时备份 + 手动备份，5 份 LRU 轮转保留
- **共鸣录（2.5.0 新增）** — 抽卡记录浏览与手动补录、我的衣橱（部件 / 妆容 / Momo / 道具 / 共鸣色）拥有状态与套装收集进度、本地 JSON 导入导出（解析预览 → 分批事务提交 → 可取消、断点幂等）、个人统计（欧非百分位与出货分布）；纯离线运行，静态数据全部随包，零外链
- **设备同步（2.5.5 新增）** — 内置 NikkiSync 协议 v1 服务端，局域网 HTTPS + WebSocket 完成配对与认证，移动端可直接同步本机媒体库；「同步图库」板块独立浏览同步资产（默认关闭，需在设置页显式开启）
- **更多能力** — 12 种语言、双主题（默认 + 柔粉轻奢）、插件系统、角色档案管理（多账号 / UID 隔离）、游戏参数解密、诊断工具

### 技术栈

| 领域     | 技术                              |
| -------- | --------------------------------- |
| 桌面框架 | Electron 41.10                    |
| 前端框架 | React 19.2 + TypeScript 5.9       |
| 状态管理 | Zustand 5.0                       |
| 样式方案 | Tailwind CSS 3.4                  |
| 数据库   | SQLite (better-sqlite3 12.11)     |
| 图片处理 | sharp 0.35                        |
| 视频处理 | ffmpeg-static + fluent-ffmpeg     |
| 构建工具 | Vite 6.4                          |
| 动画库   | Motion 12.42                      |
| 国际化   | i18next 26.3 + react-i18next 17.0 |
| 全文搜索 | FlexSearch 0.8                    |
| FFI 调用 | koffi 3.1                         |
| 参数校验 | zod 4.4                           |
| 测试框架 | Vitest 5.0                        |

### 下载安装

- **GitHub Releases**：前往 [Releases 页面](https://github.com/QianQianLuLu1/MeowStarMap/releases) 获取安装包
- **版本 tag 说明**：仓库已打过 8 个 tag，但**均不带 `v` 前缀**（`2.3.6`、`2.5.0` 与一批以旧项目名开头的 tag），`v2.5.5` 等 `v` 前缀 tag 尚未建立，故 CHANGELOG 中的 compare 链接暂不可用，请以 Releases 页面实际条目为准
- **其他渠道**：抖音 / B站 搜索「纤璐不会玩摄影」获取下载指引

**系统要求**：Windows 10 (1803+) / Windows 11，x64 架构

### 开发

**前提条件**：[Node.js](https://nodejs.org/) >= 22.12.0

```bash
git clone https://github.com/QianQianLuLu1/MeowStarMap.git
cd MeowStarMap
npm install          # 安装依赖
npm run dev          # 启动开发模式
npm run dist:win     # 打包 Windows 安装包
```

常用命令：

```bash
npm run test          # 运行测试
npm run lint          # 代码检查
npm run typecheck     # 类型检查
npm run format        # 格式化代码
npm run storybook     # 启动组件文档站（Storybook，端口 6006）
```

> 详细的开发指南请参阅 [DEVELOPMENT.md](DEVELOPMENT.md)

### 项目结构

```
src/
├── main/          # Electron 主进程（IPC 通信、数据库、扫描器、服务层）
│   ├── app/           # 应用生命周期编排
│   ├── database/      # SQLite + 写入子进程
│   ├── ipc/           # IPC 通道处理（47 个文件：43 个 registerXxxHandlers + 4 个辅助）
│   ├── preload/       # preload 桥命名空间（33 个 api/*.ts）
│   ├── scanner/       # 文件扫描器（含子进程）
│   ├── services/      # 业务服务层（13 个服务）
│   ├── sync/          # NikkiSync 协议移植面（认证 / 配对 / 服务端）
│   ├── nikkisync/     # 外部 @nikkisync/* 包的装载缝
│   ├── thumbnail/     # 单文件缩略图生成
│   ├── media-worker/  # 缩略图 / pHash / 重复检测子进程
│   └── utils/         # 主进程核心工具层
├── renderer/      # 渲染进程（React 前端）
│   ├── components/    # 通用 / 编辑器 / 图库 / 布局 / 共鸣录 / 扫描 / 同步 / 视频组件
│   ├── pages/         # 页面与设置分区（含 settings/ 与 sync-gallery/）
│   ├── stores/        # Zustand 状态管理
│   ├── hooks/         # 自定义 hooks
│   ├── utils/         # 工具函数（含共鸣录 / 分享卡纯函数）
│   ├── data/          # 共鸣录静态数据（图鉴 / 卡池 / 百分位快照 / 12 语言名称 / 卡池缩略图）
│   └── i18n/          # 12 种语言文件
└── shared/        # 跨进程共享类型与错误码
```

> 完整架构说明请参阅 [ARCHITECTURE.md](ARCHITECTURE.md)

### 相关文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — 架构设计文档
- [DEVELOPMENT.md](DEVELOPMENT.md) — 开发指南
- [CHANGELOG.md](CHANGELOG.md) — 变更日志
- [docs/](docs/) — IPC 契约、插件 API、排障手册等
- [docs/Storybook使用指南.md](docs/Storybook使用指南.md) — 组件文档站（`npm run storybook` 启动，端口 6006）
- [docs/tutorial/用户使用教程.md](docs/tutorial/用户使用教程.md) — 面向玩家的图文使用教程

### 开发者信息 / 作者与社交平台

- **抖音**：纤璐不会玩摄影 ([主页链接](https://v.douyin.com/Dx67wYkw48A/))
- **小红书**：纤璐不会玩摄影 ([主页链接](https://www.xiaohongshu.com/user/profile/69270bb200000000370092db))
- **哔哩哔哩**：纤璐不会玩摄影 ([主页链接](https://b23.tv/zCR5oGE))
- **GitHub**：[QianQianLuLu1](https://github.com/QianQianLuLu1)
- **CSDN博客**：[QianQian-LuLu](https://blog.csdn.net/2604_96788940)
- **作者官网**：<https://ppebv9al.qwenwork.host/>

### 许可证

[MIT License](LICENSE)

<p align="right"><a href="#中文">回到顶部</a></p>

---

<h2 id="english">English</h2>

A **Windows desktop** photo album manager designed for _Infinity Nikki_ players. It automatically scans game screenshots and recordings, providing professional browsing, editing, categorization, and search capabilities. All data is stored locally — nothing is uploaded to the cloud.

### Key Features

- **Smart Scanning** — Auto-locates game directories (Steam / Epic registry + full-disk signature scan), incremental scanning, multi-drive concurrency; intelligently distinguishes game screenshots, launcher cache, and cloud albums
- **Multi-View Gallery** — Grid, list, masonry, timeline, and event-timeline views; fullscreen viewer with slideshow; Ctrl / Shift multi-select for batch operations
- **Professional Editing** — 14 basic adjustments (brightness / contrast / saturation / temperature, etc.) + HSL 8-color independent grading + RGB multi-channel curves + split-toning + filter presets; full undo / redo and batch apply
- **Video Processing** — Thumbnail extraction, trimming, speed adjustment (0.25x–4x), format conversion, Apple Live Photo export
- **Smart Organization** — System categories + 3-level custom category tree (drag-sort / color tags), tag management, 5 smart grouping dimensions (album type / scene / time / outfit / file type, plus "no grouping")
- **Duplicate Detection** — SHA256 exact match + perceptual hash (pHash) dual detection, 4-dimensional smart scoring recommends keepers
- **Share & Backup** — WeChat / QQ / vivo clipboard sharing + WiFi LAN transfer (PIN auth); auto scheduled backup + manual backup, 5-copy LRU rotation
- **Resonance Records (new in 2.5.0)** — Browse pull records and add manual entries, manage My Wardrobe (items / makeup / Momo / props / eureka colors) with outfit completion progress, import & export local JSON (parse preview → batched transactions → cancellable and idempotent resume), personal stats (luck percentile and drop distribution); fully offline with all static data bundled, zero external requests
- **Device Sync (new in 2.5.5)** — Built-in NikkiSync Protocol v1 server: LAN HTTPS + WebSocket pairing and authentication let mobile clients sync this machine's media library; a dedicated **Sync Gallery** section browses synced assets (off by default — enable it explicitly in Settings)
- **More** — 12 languages, dual themes (default + soft pink luxury), plugin system, character profiles (multi-account / UID isolation), game parameter decryption, diagnostics

### Tech Stack

| Category   | Technology                        |
| ---------- | --------------------------------- |
| Desktop    | Electron 41.10                    |
| Frontend   | React 19.2 + TypeScript 5.9       |
| State      | Zustand 5.0                       |
| Styling    | Tailwind CSS 3.4                  |
| Database   | SQLite (better-sqlite3 12.11)     |
| Image      | sharp 0.35                        |
| Video      | ffmpeg-static + fluent-ffmpeg     |
| Build      | Vite 6.4                          |
| Animation  | Motion 12.42                      |
| i18n       | i18next 26.3 + react-i18next 17.0 |
| Search     | FlexSearch 0.8                    |
| FFI        | koffi 3.1                         |
| Validation | zod 4.4                           |
| Testing    | Vitest 5.0                        |

### Download

- **GitHub Releases**: Visit the [Releases page](https://github.com/QianQianLuLu1/MeowStarMap/releases) for the installer
- **Version tags**: the repo has 8 tags, but **none carry the `v` prefix** (`2.3.6`, `2.5.0`, and a batch of legacy-project-name-prefixed tags); `v`-prefixed tags such as `v2.5.5` do not exist yet, so the CHANGELOG compare links are unavailable — rely on the actual Releases entries
- **Other channels**: Search "纤璐不会玩摄影" on Douyin / Bilibili for download guides

**Requirements**: Windows 10 (1803+) / Windows 11, x64 architecture

### Development

**Prerequisites**: [Node.js](https://nodejs.org/) >= 22.12.0

```bash
git clone https://github.com/QianQianLuLu1/MeowStarMap.git
cd MeowStarMap
npm install          # Install dependencies
npm run dev          # Start dev mode
npm run dist:win     # Build Windows installer
```

Common commands:

```bash
npm run test          # Run tests
npm run lint          # Lint
npm run typecheck     # Type check
npm run format        # Format code
npm run storybook     # Start the component docs site (Storybook, port 6006)
```

> See [DEVELOPMENT.en.md](DEVELOPMENT.en.md) for the full development guide

### Project Structure

```
src/
├── main/          # Electron main process (IPC, database, scanner, services)
│   ├── app/           # Application lifecycle orchestration
│   ├── database/      # SQLite + write worker
│   ├── ipc/           # IPC channel handlers (47 files: 43 registerXxxHandlers + 4 helpers)
│   ├── preload/       # Preload bridge namespaces (33 api/*.ts)
│   ├── scanner/       # File scanner (with worker)
│   ├── services/      # Business service layer (13 services)
│   ├── sync/          # NikkiSync protocol port (auth / pairing / server)
│   ├── nikkisync/     # Loader seam for the external @nikkisync/* packages
│   ├── thumbnail/     # Single-file thumbnail generation
│   ├── media-worker/  # Thumbnail / pHash / duplicate detection worker
│   └── utils/         # Main-process core utilities
├── renderer/      # Renderer process (React frontend)
│   ├── components/    # Common / editor / gallery / layout / resonance / scanner / sync / video components
│   ├── pages/         # Pages & settings sections (incl. settings/ and sync-gallery/)
│   ├── stores/        # Zustand state management
│   ├── hooks/         # Custom hooks
│   ├── utils/         # Utilities (incl. resonance / share-card pure functions)
│   ├── data/          # Resonance static data (catalog / banners / percentile snapshot / 12-language names / banner thumbnails)
│   └── i18n/          # 12 language files
└── shared/        # Cross-process shared types & error codes
```

> See [ARCHITECTURE.en.md](ARCHITECTURE.en.md) for the full architecture document

### Documentation

- [ARCHITECTURE.en.md](ARCHITECTURE.en.md) — Architecture document
- [DEVELOPMENT.en.md](DEVELOPMENT.en.md) — Development guide
- [CHANGELOG.md](CHANGELOG.md) — Changelog
- [docs/](docs/) — IPC contracts, plugin API, troubleshooting, and more
- [docs/Storybook使用指南.md](docs/Storybook使用指南.md) — Component docs site (`npm run storybook`, port 6006)
- [docs/tutorial/用户使用教程.md](docs/tutorial/用户使用教程.md) — Illustrated user guide (in Chinese)

### Developer Info / Author & Social Platforms

- **Douyin**: 纤璐不会玩摄影 ([profile](https://v.douyin.com/Dx67wYkw48A/))
- **Xiaohongshu (RED)**: 纤璐不会玩摄影 ([profile](https://www.xiaohongshu.com/user/profile/69270bb200000000370092db))
- **Bilibili**: 纤璐不会玩摄影 ([profile](https://b23.tv/zCR5oGE))

- **GitHub**: [QianQianLuLu1](https://github.com/QianQianLuLu1)
- **CSDN Blog**: [QianQian-LuLu](https://blog.csdn.net/2604_96788940)
- **Author Site**: https://ppebv9al.qwenwork.host/

### License

[MIT License](LICENSE)

<p align="right"><a href="#english">Back to top</a></p>
