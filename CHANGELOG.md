# Changelog | 变更日志

All notable changes to this project will be documented in this file.
本项目所有重要变更都将记录在此文件中。

The format is based on [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/spec/v2.0.0.html).
本文件格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
并遵循 [语义化版本](https://semver.org/lang/zh-CN/spec/v2.0.0.html) 规范。

---

## [Unreleased] | 未发布

新增、即将在下个版本发布的功能或修复。

### Changed | 变更

- **提交前指引与实际闸门对齐**：`scripts/verify-changes.ts`（`npm run verify` / `verify:staged`）新增只读格式检查（`prettier --check`，行尾不参与判定），检查集与 `.husky/pre-commit` 对齐但仍不改动任何文件；新增 `scripts/verify-format-scope.ts`（从 `package.json` 的 `lint-staged` 键推导钩子格式作用域）及其单测（含配置契约测试）
- `AGENTS.md`「变更后验证工作流」新增「verify 与 pre-commit 闸门的差异」表（钩子会 `eslint --fix` / `prettier --write` 改写并重新暂存，verify 只读且单测范围为超集），`.qoder/rules/project-conventions.md`「校验与提交」同步口径；本地钩子与 CI 的既有拦截均未放宽
- 根目录 `AGENTS.md` / `CHANGELOG.md` 的表格列宽按 lint-staged 的 `*.{ts,js,json,md}` → `prettier --write` 规则归一（该规则在暂存这两个文件时本来就会改写它们，提前清偿以免提交时静默变动）
- **编码约定真相源入仓**：新增 `docs/CODING_CONVENTIONS.md`（纳入版本控制）承接四条硬约定与「校验与提交」口径；`.qoder/rules/project-conventions.md` 降级为它的本地镜像（IDE `trigger: always_on` 注入用，仍随 `.gitignore` 的 `.qoder/` 不入库）。`AGENTS.md`、`commitlint.config.cjs`、`.gitmessage`、`.husky/commit-msg`（含提交被拒时打印给用户的文案）与 `eslint.config.js` 的段注释全部改指 docs 真相源，并订正章节名「提交校验流程」→「校验与提交」
- 6 个模块级 `AGENTS.md`（`scripts/`、`src/main/{app,database,media-worker,thumbnail,utils}/`）随根 `AGENTS.md` 作为同一提交单元入仓，消除导航表指向仓库外文件；全部 12 个模块级 `AGENTS.md` 首段的“见 always-on 规则 `project-conventions.md`”改指 `docs/CODING_CONVENTIONS.md`（含 `scripts/AGENTS.md` 顶层链接相对层级写错为 `../../AGENTS.md` 的修正），`scripts/__tests__/verify-format-scope.test.ts` 去掉「干净克隆下不存在则跳过」的 `it.skipIf`，改为对 docs 真相源强制断言，并新增三项守护：被跟踪指引（含从导航表动态解析的模块级 `AGENTS.md`）断链拦截、导航表逐行可解析、镜像正文区与真相源逐字一致。本次未新增也未放宽任何 CI 或钩子拦截
- **根目录文档一致性修正（2026-10-06 全仓 md 盘点）**：README 中英段浏览模式「4 种」→「5 种（补瀑布流）」与基础调整「12 项」→「14 项」，ARCHITECTURE(.en) 文档版本元数据与 preload「29 个命名空间」→「30」，DEVELOPMENT(.en) 的 HTML 预览工作流改为 `npm run build:preview` → 打开根目录 `preview.html`（订正 `npm run preview` 实为 electron-vite 生产预览）、克隆路径与安装包版本示例、删除不存在的 `docs/screenshots/` 引用；`THUMBNAIL_OPTIMIZATION_PLAN.md`（根目录）与 `docs/plans/` 中 2 份「已实施」计划归档出仓（本地留档 `docs/archive/plans/`，不入仓）

---

## [2.5.3] - 2026-10-01

### Added | 新增

- 通用 UI 组件族落地 common 层（Button/Checkbox/Drawer/FloatingActionBar/FormField/PageHeader/Progress/SegmentedControl/Select/Switch/ToastProvider/Tooltip）及零依赖 `cn` 类名工具，均附带行为级测试与 Storybook stories
- 外观设置新增「氛围颗粒纹理」与「漂浮几何体」独立开关（`display.ambientGrain` / `display.ambientShapes`，12 种语言文案同步）
- 动效预设新增列表级联入场 `staggerContainer` / `staggerItem`

### Changed | 变更

- 页面接入通用组件：Duplicates/RecycleBin 底部操作栏统一为 FloatingActionBar，ResonanceRecords 页签改用 SegmentedControl，设置页 Select/Toast 全面迁移
- Tailwind 圆角/阴影/字体/动画/缓动令牌与 globals.css CSS 变量完全对齐，全项目统一圆角与阴影体系；状态栏样式收敛至 CSS 层
- 无障碍增强：SegmentedControl 补方向键导航与 roving tabindex，Tooltip 补 aria-describedby 关联与 Escape 退出，全局 focus-visible 焦点描边

### Fixed | 修复

- 修复底部操作栏层级过高（z-60）遮挡全局 Toast 与任务进度浮层的回归
- 修复 Drawer 硬编码标题 id 导致双抽屉并开时 aria-labelledby 串号
- 修复 FormField 错误态下 aria-describedby 悬空指向未渲染的 helper 文案
- 预览 mock 的 uiTheme 写入改为与 zustand persist 同构 JSON，消除主题设置回滚隐患

---

## [2.5.2] - 2026-09-30

### Added | 新增

- 图库新增骨架屏组件族，外观设置新增「液态玻璃」风格选项
- 图库缩略图分级加载（低/中/高档位）与滚动邻居预取，长列表浏览更流畅

### Changed | 变更

- decryption-worker 接入构建产物与打包前检查；npm audit 豁免清单迁移至 `audit-ci.jsonc`，统一本地与 CI 审计口径

### Fixed | 修复

- 重构图片预览与导出链路，消除编辑器预览与导出模糊
- 修复全屏预览过渡动画卡顿与掉帧，并完善换源卡顿与关闭登记
- 修复图库 VirtualImageGrid 与大数据数组展开求值两处栈溢出崩溃
- 修复收藏切换与撤销对 IpcResponse 的错误解包
- 修复回收站永久删除误弹错误 Toast 及清空回收站后条目残留
- 删除媒体时同步清理关联缩略图档位与原生 LQ，避免孤儿文件
- 修复第三方平台 Ctrl+V 无法粘贴分享文件；分享图标更换为 Lucide share-2 并加固触发器防压缩
- 修复打包版视频缩略图缺失与 spawn EFTYPE 弹窗：ffmpeg/ffprobe 增加 Windows PE 魔数预检与 spawn 错误诊断落盘
- 修复打包版缩略图加载慢：引入 ETag 协商缓存并完善档位回退链
- 统一五视图缩略图源，修复半截写入、失败覆写、损坏误标与孤儿误删
- 按需缩略图生成结果回写数据库，修复缓存命中回填与视频封面裂图
- 统一启动诊断日志路径，修复诊断包导出卡死，并在启动扫描、索引与场景分析阶段插入精细打点

### Security | 安全

- 升级 sharp 与 @xmldom/xmldom 修复高危漏洞，lockfile 全量切回 registry.npmjs.org 官方源

### Documentation | 文档

- 全量文档与代码库一致性同步：`ARCHITECTURE.md` / `ARCHITECTURE.en.md`（§4 目录树、utilityProcess 五 worker、preload 29 命名空间、UID 正则、services/stores/pages/hooks/icons 计数、§11 构建脚本与 electron.vite.config.ts、asarUnpack 10 项、附录 C 测试规模）、`DEVELOPMENT.md` / `DEVELOPMENT.en.md`（.npmrc 现状、日志/数据库/崩溃 dump 实际路径、门禁基线实测、asarUnpack、USER_GUIDE 死链）、`README.md`（clone 目录名、目录结构去除已移除的 `src/common`）、`AGENTS.md`（handler 域数量）、`docs/PLUGIN_API.md`（插件 IPC facade 实际暴露面、死链清理）、`docs/i18n/fix-sop.md`（补历史标记）
- 统一提交规范文档引用至 `.qoder/rules/project-conventions.md`；登记 Electron 40 EOL 供应链通告债务并立案升级专项
- 新增多份实施计划与诊断文档（缩略图持久化闭环、spawn EFTYPE、全屏过渡、编辑器预览模糊、剪贴板分享等）

---

## [2.5.1] - 2026-09-08

### Fixed | 修复

- 修复图库非网格视图在条目数较多（约 500 条）时的展示异常，并补充过滤后条目计数测试（`useFilteredMediaFiles` 及新增 `useFilteredMediaFiles.count.test.ts`）

---

## [2.5.0] - 2026-09-06

### Added | 新增

- 「共鸣录」板块正式实装（仅离线，断网 100% 可用；逻辑复用自开源项目 gongeo.us-nikki-tracker，MIT License，已获原作者授权）：
  - 共鸣记录：73 个卡池的记录浏览（本地缩略图、品质色点、该抽跨度、垫抽提示）、手动补录 / 修改补录时间 / 删除，长列表虚拟滚动
  - 我的衣橱：部件 / 妆容 / Momo / 道具 / 共鸣色五分类拥有状态管理，套装聚合进度（已集齐 / 集齐中 / 未收集）、名称搜索、拥有状态与稀有度筛选、批量勾选、「从共鸣记录推断」一键推断（纯文字模式，不依赖任何物品图片）
  - 导入数据：本地 JSON 文件导入（解析预览 → 新增/重复/无效计数与逐条定位 → 分批事务提交，进度可视 + 可取消 + 断点幂等）、版本不兼容时提供「兼容导入 / 放弃」双选项、gongeo.us 旧版导出格式兼容；数据导出（内容勾选 + 系统保存对话框）；清空全部（危险二次确认）
  - 个人统计：总览卡（总抽数 / 4★5★ 部件 / 平均出货 / 已获套装）、欧非百分位与档位（静态快照，UI 标注来源与生成日期，缺失时自动隐藏）、SVG 出货分布直方图、按卡池累计曲线、按卡池明细表
  - 数据层：SQLite 新增 5 张共鸣表（幂等迁移，纳入既有整库备份/恢复）；9 个 IPC 通道全部经 zod schema 校验（导入文件按不可信输入同等强度守卫，单文件 ≤64MB、总记录 ≤20 万）
  - 静态数据：图鉴目录 11 片 + 卡池/套装/百分位快照 + 12 语言实体名称包 + 73 张卡池缩略图（约 7.1MB，全部本地打包资源，零外链）
  - i18n：共鸣录全部词条补齐 12 语言；设置 → 致谢与开源协议新增 gongeo.us-nikki-tracker（MIT）条目
  - 离线守护：新增离线断言测试（核心流程零网络调用打桩断言 + 全部新增源码静态扫描 + 反向用例防假绿）

### Changed | 变更

- 测试同步：ipc-setup 契约测试更新为 39 个 registerXxxHandlers、preload 装配测试更新为 reportReady + 29 个命名空间（共 30 键，随共鸣录接入而新增）

### Fixed | 修复

- 测试修复：`GalleryStackOverflow` 边界用例适配 React 19.2「并发渲染出错中止并同步恢复」语义（props 驱动抛错替代闭包计数器，stub 全局 `reportError` 静默恢复上报），消除用例失败与 vitest 未处理错误；`path-safety` 「只读目录」用例改为模拟 `fs.accessSync` 的 W_OK 拒绝（Windows 上 `chmod 0o444` 对目录不生效导致的环境依赖失败），全量 4476 用例稳定全绿
- 修复手动补录成功提示缺失翻译：`AddRecordDialog` 改用 `resonance.toast.added` 并补齐 12 语言包（原 `resonance.records.toastAdded` 不存在于任何语言包，运行时显示原始 key）

### Removed | 移除

- 移除 Python 扫描器原型：`main.py`、`src/path_resolver.py`、`src/album_scanner.py`、`src/index_builder.py` 及其实施计划 `infinity_nikki_album_scanner_implementation_plan.md`。该原型仅由一次提交引入，全仓无任何 TS / 脚本 / CI 引用，其路径定位、UID 隔离、原生缩略图复用能力已由 `src/main/scanner/` 下的 TS 扫描器完整覆盖

### Documentation | 文档

- `ARCHITECTURE.md` / `ARCHITECTURE.en.md`：补齐 2.5.0 共鸣录章节（5 张共鸣表、9 个 IPC 通道与导入上限、随包静态数据、离线守护）与 §12.15 工程不变量（扫描通道编排、游标分页 keyset、读流生命周期、IPC 读路径守卫、Worker 句柄释放、相册类型解析、图库栈溢出防护、导航 / preload 双层防线、原生依赖与启动早期可观测性）；附录 B 补齐共鸣录与新增模块路径；版本号统一为 2.5.0
- `DEVELOPMENT.md` / `DEVELOPMENT.en.md`：修正打包序列（原 `npm run build:main` / `npm run build:renderer` 两个脚本早已移除，改为 `npx electron-vite build` → `npm run pre-dist-check` → `npx electron-builder --win --publish never` → `npm run verify:dist`），修正项目路径示例与原生模块重建命令（`npx @electron/rebuild`），补充安装程序文件名（`NikkiGallery-Setup-<version>.exe`）与质量门禁基线；版本号分别由 2.3.5 / 2.3.0 统一为 2.5.0
- `README.md`：版本徽章同步为 2.5.0，中英文段各补一条共鸣录特性，项目结构补充共鸣录静态数据目录

---

## [2.3.5] - 2026-08-01

聚焦于打包发布后的核心问题修复——解决打包后图库空白、白屏、属性面板解析失败等阻塞级缺陷，同时强化扫描器的缓存图片过滤能力、搜索索引稳定性，以及数据库迁移系统的健壮性。

### Added | 新增

- 自定义游戏目录配置：设置页新增「游戏目录」配置区，支持手动添加/删除自定义游戏安装路径，扫描时优先搜索并跳过耗时的全盘签名搜索，大幅缩短首次扫描时间
- 扫描失败可视化反馈：扫描失败时通过 Toast 弹窗展示失败原因，「未找到游戏目录」时追加手动指定路径的引导提示，避免静默失败
- 打包前产物校验脚本（`pre-dist-check`）：校验 `dist/main` 与 `dist/renderer` 产物时间戳差 ≤5 分钟、关键修复点已编入产物、Git 工作区干净，任一失败即阻止打包
- 启动诊断日志系统（`diagLog`）：独立写入 `userData/diag.log`，替代分散的 `_diag` 函数（原实现使用 `process.cwd()`，打包后双击启动时 cwd 无写入权限导致日志静默丢失）
- 搜索索引 `schema_hash` 校验：字段配置指纹 + 采样数据特征，字段级变更时自动触发全量重建，避免旧索引与新代码不兼容

### Changed | 变更

- 属性面板 IPC 优化：`PropertiesDialog` 将 `useGameParams` 提升到 Dialog 层级统一调用，5 个子面板经 props 注入复用结果，消除 5 次冗余 IPC 请求
- 数据库迁移系统升级：`safeAddColumn` → `safeEnsureColumn`（列已存在时回填旧记录 NULL 值）；迁移标记从命名模式升级为版本号模式（`schema_migrations.version`），旧库自动回填并保持向后兼容
- 默认视图媒体来源策略调整：图库默认视图从仅显示 `game` 改为 `game + cloud`，排除 `launcher` 缓存，由后端 `buildListWhereClause` 统一构建 `media_source != 'launcher'` 条件
- FlexSearch 索引重建方式：`clear()` 改为 `recreateSearchIndex()` 创建全新实例（flexsearch 0.8.x 的 `clear()` 破坏内部注册表），并用容器对象替代 `export let` 避免打包后丢失 live binding
- 插件运行时加载方式：`pluggable-electron/renderer` 从静态 import 改为动态 `import()`，避免 sandbox + contextIsolation 环境下模块加载失败导致整包崩溃（白屏）
- 解密服务 UID 降级处理：`uid='default'` 或缺失时尝试从文件路径重新提取 UID，避免解密直接失败
- 构建配置统一：`directories.output` 改为 `release`；`clean` 脚本同时清理 `dist/main`；outDir 改用绝对路径
- 国际化文案更新：12 个语言文件同步更新，新增扫描路径配置、扫描失败提示、EXIF 游戏照片提示、备份恢复提示等文案

### Fixed | 修复

- 修复打包版本「图库」板块不显示应扫描媒体的问题（自定义路径与自动发现双集合拆分、悬空缩略图重建，详见归档计划文档）
- 修复「指定目录」扫描成功但图库不显示的问题（扫描成功时登记 `import_roots`）
- 修复启动后索引死锁与索引浮窗长期停在 0% 的问题（索引链与扫描解耦、worker 真实进度归一显示、批次超时兜底）
- 修复编辑器画布被 CORS 污染（tainted）的问题（匿名请求 + 消费方替换）
- 修复全屏浏览/幻灯片播放时标题栏遮挡内容的问题（`env(titlebar-area-*)` 避让）
- 修复「打开文件所在位置」的路径白名单绕过问题
- 修复缺失文件默认显示干扰浏览的问题（默认隐藏，提供「仅显示缺失」开关）

### 工程与文档

- 清理 45,000+ 行历史开发计划文档，更新 README、ARCHITECTURE、DEVELOPMENT 等核心文档
- 新增 `pending_renames` 表用于批量重命名失败补偿（R2），新增乐观锁字段 `updated_at` / `snapshot_updated_at`（R8），新增 `phash_mtime` / `phash_file_size` 检测文件外部编辑后 phash 失效（R7）
- 测试覆盖增强：新增 `repair-legacy-data-v1.test.ts`、`worker-entry.test.ts`、`search-service.test.ts`、`GalleryPage.test.tsx`、`ScanProgress.test.tsx`、`uiStore.test.ts` 等测试文件

---

## [2.3.0] - 2026-07-30

聚焦于扫描定位能力的全面强化、媒体来源的智能识别，以及退出稳定性和界面性能的深度打磨。

### Added | 新增

- 媒体来源智能识别：新增 `media_source` 字段，自动区分 game / launcher / cloud 三类媒体来源，图库可按来源快速过滤
- 游戏目录自动定位增强：新增 Steam 注册表查询 + `libraryfolders.vdf` 解析、Epic Games 注册表查询、用户数据目录检测，采用「浅层搜索 → 深度扫描」两级策略
- 全盘媒体签名扫描：新增 `fullScan` 模式，不依赖游戏可执行文件，直接在所有磁盘搜索媒体签名文件夹，支持多盘符并发扫描，首次启动自动执行
- 桌面快捷方式自动补建：应用启动时主动检查并补创建桌面快捷方式，解决 NSIS 覆盖安装等场景下快捷方式缺失的问题
- 诊断包一键导出：设置 → 诊断中新增一键导出诊断包功能，包含日志、崩溃报告与系统环境信息，改用 `tar.exe` 打包

### Changed | 变更

- 扫描可靠性优化：跳过系统目录与云同步目录（OneDrive、iCloudDrive、Dropbox、Google Drive），ScreenShot 文件夹检测增加路径上下文校验，启动时自动修复旧数据
- 进程退出稳定性重构：`before-quit` 加入 2 秒超时保护，关键清理步骤使用 `Promise.race()` 超时兜底，诊断日志改用同步写入，单实例锁在所有清理完成后立即释放
- 界面性能优化：页面切换 FPS ≥ 55，改用轻量淡入动画（8px 右移 + 淡入，220ms），移除整页 View Transitions API，毛玻璃效果优化（移除 `soft-pink-luxury` 主题的 `saturate` 滤镜）
- 数据库优化：扫描 SQL 预编译语句缓存，`character_profiles` 昵称列新增索引，`operation_history` 启动时自动清理 30 天前记录

### Fixed | 修复

- 修复进程退出时异步 I/O 阻塞事件循环导致进程挂起的问题
- 修复 `soft-pink-luxury` 主题 `saturate` 滤镜导致动画结束后画面仍模糊的问题
- 修复 800ms 等待竞态条件
- 修复僵尸进程持有单实例锁导致新实例启动失败的问题
- 进程检测由已弃用的 `wmic` 切换为 PowerShell `Get-CimInstance`，回退分支排除当前 PID 避免自杀
- 修复 PowerShell `Compress-Archive` 执行策略拦截与 `-LiteralPath` 通配符失效导致的诊断包导出失败

---

## [2.2.0] - 2026-07-10

聚焦于系统稳定性提升、分享可靠性增强，以及数据与诊断能力的全面升级。

### Added | 新增

- 分享系统全面重构：支持一键分享到微信、QQ、vivo 办公套件，采用 4 层回退检测链（注册表 → 卸载入口枚举 → 常见目录扫描 → 进程路径反查），检测结果缓存，三态 UI（运行中 / 已安装未运行 / 未安装）
- 崩溃报告系统：独立 `crash-service.ts` 模块处理崩溃信息收集与存储，自动生成崩溃 dump 文件（保留最近 20 个），设置页新增崩溃诊断可视化组件
- 日志管理系统：双格式存储（常规日志文本 + 故障日志 JSONL），按日期自动滚动，总容量限制 5GB，异步文件操作避免主线程阻塞，严格过滤隐私数据
- 数据管理工具箱：设置页新增数据库手动备份、缓存管理（查看与清理）、一键清除所有数据功能

### Changed | 变更

- 视频体验增强：支持 HTTP Range 请求（206 Partial Content）实现流畅拖拽，视频缩略图直接通过 img 元素渲染，视频元数据提取增加 15 秒超时防止扫描器挂起
- 底层架构优化：原生二进制依赖（ffmpeg-static、ffprobe-static、better-sqlite3、sharp 等）通过 `asarUnpack` 解包，新增 `native-path.ts` 自动替换 asar 路径，自定义并发控制工具替代 p-limit 避免 ESM 兼容问题
- 单实例锁优化：启动时自动清理陈旧进程持有的锁
- 扫描器可靠性：扫描进程结束时强制发射 `scanner:complete` 事件，进程检测使用精确进程名匹配

### Fixed | 修复

- 修复 koa-connect 包装器导致的 ctx 泄露问题，中间件改用原生 Koa 实现
- 修复 Windows 下无法执行 asar 包内的二进制可执行文件的问题
- 修复 CommonJS 主进程中 ESM-only 模块（如 p-limit v7）导致的 `require()` 错误
- 修复 `app.whenReady()` 之前调用 `app.getPath('userData')` 导致配置写入异常的问题

---

## [2.1.0] - 2026-06-15

在 v2.0.0 基础上的增量更新，新增插件系统与搜索能力。

### Added | 新增

- 插件系统：基于 pluggable-electron 的扩展架构，支持插件加载、权限校验、扩展点注册
- 全文搜索：基于 FlexSearch 的搜索索引，支持快速检索媒体文件
- 备份恢复：自动定时备份 + 手动备份，5 份 LRU 保留策略
- 游戏参数解密：通过 koffi 调用 nuan5_decryption.dll 解密游戏参数

### Changed | 变更

- 搜索索引与图库联动优化
- 多项性能与稳定性改进

---

## [2.0.0] - 2026-05-20

重大版本升级，从 v1.0.0 核心功能扩展为全功能相册管理工具。

### Added | 新增

- 视频处理：缩略图提取、裁剪、调速（0.25x - 4.0x）、格式转换、Apple Live Photo 导出
- 水印系统：批量水印、水印模板、自定义位置与样式
- 重复检测：精确 SHA256 + 感知哈希（pHash）双重检测、4 维智能评分
- 智能分组：按相册类型 / 场景分类 / 场景时段 / 套装 / 文件类型等 6 维度聚合
- 角色档案：多账号管理、按 UID 隔离、跨档案转移、统计图鉴
- 国际化：12 种语言，含「跟随系统」选项
- 主题系统：默认主题 + 柔粉轻奢主题，CSS 变量驱动
- 高级图片编辑：HSL 调色盘（8色独立调整）、色调曲线（RGB/红/绿/蓝多通道）、色调分离、滤镜预设（8种）
- 全屏浏览与幻灯片播放
- 活动时间轴视图：按游戏活动聚合展示
- 套装图鉴页

### Changed | 变更

- 架构全面升级，引入多进程架构（主进程 + 渲染进程 + utilityProcess 工作进程）
- 数据库层引入 worker 子进程处理写操作
- 缩略图生成、pHash 计算、重复检测迁移至独立子进程

---

## [1.0.0] - 2026-03-01

首个正式版本。首个对外发布的稳定版本。

### Added | 新增

- 项目初始化，完成 NikkiGallery 相册管理应用核心功能
- 实现 Steam / Epic / 默认路径 / 全盘签名多级游戏目录定位
- 实现图片、视频媒体扫描与缩略图索引（better-sqlite3 + sharp + ffmpeg）
- 实现 Windows 11 Fluent Design 风格 UI，毛玻璃卡片 + 圆角 + 轻阴影

### Changed | 变更

- 采用 Electron + TypeScript + React 技术栈，统一主进程与渲染层架构

### Fixed | 修复

- 修复单实例锁未释放导致二次启动失败的问题

---

## 版本类型说明 | Version Types

遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/spec/v2.0.0.html)：

- **主版本号（MAJOR）**：不兼容的 API 修改。示例：`1.0.0` → `2.0.0`
- **次版本号（MINOR）**：向下兼容的新增功能。示例：`1.0.0` → `1.1.0`
- **修订号（PATCH）**：向下兼容的问题修复。示例：`1.0.0` → `1.0.1`

## 变更分类说明 | Change Categories

| 分类       | 中文含义 | 使用场景                         |
| ---------- | -------- | -------------------------------- |
| Added      | 新增     | 新增功能、特性、API、配置项      |
| Changed    | 变更     | 对已有功能的修改、重构、性能优化 |
| Deprecated | 弃用     | 当前可用但即将移除的功能         |
| Removed    | 移除     | 本版本已删除的功能               |
| Fixed      | 修复     | Bug 修复                         |
| Security   | 安全     | 安全漏洞修复或安全加固           |

## 编写规范 | Writing Guidelines

1. 每个版本以 `## [版本号] - YYYY-MM-DD` 格式标题，未发布版本使用 `## [Unreleased]`。
2. 每个分类以 `### 分类名` 作为子标题，分类顺序保持 Added → Changed → Deprecated → Removed → Fixed → Security。
3. 条目使用 `-` 列表，简明描述「做了什么」与「为什么」，避免无意义提交信息。
4. 关联 Issue / PR 时，在条目末尾附加 `(#123)` 链接。
5. 破坏性变更以 `**BREAKING:**` 前缀标注，并说明迁移方式。
6. 发布版本时，将 `[Unreleased]` 区块整体复制为新区块并填入发布日期，清空 `[Unreleased]`。
7. 旧版本仅保留必要摘要，详细历史可归档至 `CHANGELOG-archive.md`。

## 链接定义 | Link References

<!-- 在文件末尾维护版本号锚点链接，便于自动跳转 -->

[Unreleased]: https://github.com/QianQianLuLu1/NikkiGallery/compare/v2.5.3...HEAD
[2.5.3]: https://github.com/QianQianLuLu1/NikkiGallery/compare/v2.5.2...v2.5.3
[2.5.2]: https://github.com/QianQianLuLu1/NikkiGallery/compare/v2.5.1...v2.5.2
[2.5.1]: https://github.com/QianQianLuLu1/NikkiGallery/compare/v2.5.0...v2.5.1
[2.5.0]: https://github.com/QianQianLuLu1/NikkiGallery/compare/v2.3.5...v2.5.0
[2.3.5]: https://github.com/QianQianLuLu1/NikkiGallery/releases/tag/v2.3.5
[2.3.0]: https://github.com/QianQianLuLu1/NikkiGallery/releases/tag/v2.3.0
[2.2.0]: https://github.com/QianQianLuLu1/NikkiGallery/releases/tag/v2.2.0
[2.1.0]: https://github.com/QianQianLuLu1/NikkiGallery/releases/tag/v2.1.0
[2.0.0]: https://github.com/QianQianLuLu1/NikkiGallery/releases/tag/v2.0.0
[1.0.0]: https://github.com/QianQianLuLu1/NikkiGallery/releases/tag/v1.0.0

---

## English Version | 英文说明

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

### How to update

1. Add new entries under `## [Unreleased]` as you develop.
2. On release, copy the `[Unreleased]` block to a new `## [x.y.z] - YYYY-MM-DD`
   block, then clear `[Unreleased]`.
3. Keep category order: Added → Changed → Deprecated → Removed → Fixed → Security.
4. Use `-` bullet lists; describe both **what** and **why**.
5. Reference issues/PRs with `(#123)` suffix.
6. Prefix breaking changes with `**BREAKING:**` and provide migration notes.
7. Update the link references at the bottom for the new release tag.

### Category reference

- **Added** for new features.
- **Changed** for changes in existing functionality.
- **Deprecated** for soon-to-be removed features.
- **Removed** for now removed features.
- **Fixed** for any bug fixes.
- **Security** for vulnerability fixes and hardening.

## 开发者信息 / 作者与社交平台

- **抖音**：纤璐不会玩摄影 ([主页链接](https://v.douyin.com/Dx67wYkw48A/))
- **小红书**：纤璐不会玩摄影 ([主页链接](https://www.xiaohongshu.com/user/profile/69270bb200000000370092db))
- **哔哩哔哩**：纤璐不会玩摄影 ([主页链接](https://b23.tv/zCR5oGE))
- **GitHub**：[QianQianLuLu1](https://github.com/QianQianLuLu1)
- **CSDN博客**：[QianQian-LuLu](https://blog.csdn.net/2604_96788940)
- **作者官网**：https://ppebv9al.qwenwork.host/
