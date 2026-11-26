# MeowStarMap 自定义安装器（Tauri）

> 目标：替代 electron-builder NSIS 的安装/覆盖升级体验，提供 Web 风格分步向导（参考 SnowLeopard Vision 安装器）。
> 技术栈：**Tauri v2（Rust + 系统 WebView2）+ React 19 + Vite**。
> 位置：仓库 `installer/` 子工程；构建产物不进入主应用 asar，独立发布为 `MeowStarMap-Setup-<ver>.exe`。

## 1. 目标能力

- 首次安装 / 覆盖安装（升级）/ 修复 / 卸载；
- 读取并复用已有安装（NSIS 旧版或自定义安装器安装的目录/卸载项）；
- 安装信息清单 `install-manifest.json`（由应用启动时写入，见 `src/main/app/install-manifest.ts`）；
- 导入自签名根证书（`certutil -user -addstore -f`，失败仅告警）；
- 快捷方式（桌面/开始菜单）、HKCU 卸载项、版本登记；
- 兼容旧客户端更新契约：`--updated` / `--force-run` / `/S`（静默）/ `/D=<dir>` / `--package-file=<path>`；
- 更新元数据 `latest.yml` 由主仓库 `scripts/generate-update-feed.ts` 生成（随安装包上传）。

## 2. 目录结构

```
installer/
├─ src/                     # React 前端（向导 UI）
│  ├─ main.tsx / App.tsx
│  ├─ steps/                # 欢迎 / 安装选项 / 进度 / 完成
│  ├─ api.ts                # invoke 封装
│  └─ types.ts
├─ src-tauri/               # Rust 后端
│  ├─ src/main.rs / lib.rs / commands.rs / platform.rs
│  ├─ tauri.conf.json
│  └─ capabilities/
├─ index.html / vite.config.ts / package.json / tsconfig.json
└─ README.md
```

## 3. 安装器契约（与主应用/更新链对齐）

### 3.1 启动参数

| 参数                    | 含义                                       | 行为                               |
| ----------------------- | ------------------------------------------ | ---------------------------------- |
| `--updated`             | 由更新流程拉起                             | 更新场景，默认静默模式             |
| `--force-run`           | 安装完成后启动应用                         | 安装/升级结束时启动 `喵星图.exe`   |
| `/S`                    | 静默安装（旧 electron-updater 客户端会传） | 无 UI，直接按默认选项安装/升级     |
| `/D=<dir>`              | 指定安装目录                               | 优先于注册表 `InstallLocation`     |
| `--package-file=<path>` | 更新包缓存路径                             | 作为载荷来源（可选，忽略未知参数） |

### 3.2 载荷与安装布局

- 载荷 = `electron-builder --dir` 产出的 `win-unpacked` 目录打成的 zip（保持原目录树）；
- 解压后目录必须与 `win-unpacked` 逐字节一致（`resources/app.asar`、`app.asar.unpacked`、`resources/nikkisync`、VC++ DLL 与 exe 同级等）；
- 用户数据目录 `%APPDATA%\meow-star-map` 永不删除。

### 3.3 安装登记

- HKCU `Software\Microsoft\Windows\CurrentVersion\Uninstall\{GUID}`（与 NSIS 字段兼容：DisplayName/DisplayVersion/InstallLocation/UninstallString/DisplayIcon/Publisher）；
- 卸载器 `Uninstall 喵星图.exe`（由安装器自身以 `--uninstall` 模式提供，或单独生成）；
- 快捷方式：桌面 + 开始菜单（lnk 名称「喵星图」）。

## 4. 开发前置

1. Rust（stable，`x86_64-pc-windows-msvc`）；
2. Visual Studio Build Tools（C++ 工作负载）+ Windows SDK；
3. Node 22+ / pnpm 或 npm；
4. 主仓库已 `npm run build`（保证 `dist/renderer` 等产物存在，用于打载荷）。

> 本机安装方式（2026-11-24）：Rust 用 `rustup-init --no-modify-path` 装到 `%USERPROFILE%\.cargo`，
> **未写入系统/用户 PATH**。运行 `tauri` 前在当前会话临时前置 PATH：
> `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`（bash：`export PATH="$HOME/.cargo/bin:$PATH"`）。
> VS Build Tools 通过 winget 安装（`Microsoft.VisualStudio.2022.BuildTools` + `Microsoft.VisualStudio.Workload.VCTools`）。

## 5. 常用命令

```bash
cd installer
npm install
npm run dev          # tauri dev（开发向导 UI）
npm run build        # tauri build --no-bundle（产出独立 exe）
```

## 6. 当前进度与下一步

- [x] 工程骨架（React 向导 UI + Tauri 后端命令桩）
- [x] 工具链（Rust 1.100 / VS Build Tools 17.14 / Windows SDK 10.0.26100）与 `cargo check` 通过
- [x] 向导 UI 本机启动截图验证（欢迎页/侧边栏步骤）
- [x] `detect_state` 读取旧安装（注册表/install-manifest）
- [x] 载荷 sha256/size 校验（`payload.zip.json` 清单，缺失时跳过并告警）
- [x] 子进程统一 CREATE_NO_WINDOW，安装过程不闪 cmd/控制台窗口
- [x] 安装目录内生成 `Uninstall.exe`（截取安装器 PE 本体，约 10MB），UninstallString 指向它；卸载时先复制到临时目录避免自删失败`n- [x] 关闭按钮走 `close_installer`/app.exit(0)；启动应用成功后约 800ms 自动关闭安装器`n- [x] 进度：sha256 按字节推进、解包/替换分阶段、UI 单调不回退`n- [x] 单文件安装包：payload 追加在 exe 末尾（`[zip][manifest][size][magic]`），不依赖同目录 `payload.zip`
- [x] 缺少载荷视为安装失败（不再“安装完成”并写空目录/注册表）
- [x] staged 解包 + 备份替换 + 失败回滚（`installer-progress` 事件 0→100%）
- [x] 安装命令放到 blocking 线程（2026-11-25 冒烟发现页面卡 0%，已修复）
- [x] 进度事件 + `get_install_progress` 轮询兜底（事件通道不可用时 UI 仍能刷新）
- [x] 静默模式安装完成后直接退出进程（供旧 electron-updater 等待退出码）
- [x] 取消安装：提取/校验阶段可取消（保留旧版本目录、清理 staging）；失败自动回滚
- [x] 替换文件前失败/取消不会修改安装目录；`swap_in` 失败会恢复旧目录
- [x] 版本号回退 payload 清单（`payload.zip.json` 的 version）
- [x] 进程互斥/结束旧应用（taskkill）
- [x] 快捷方式 + HKCU 卸载项 + 证书导入（PS1 加 UTF-8 BOM + 预建目录，修复开始菜单 lnk 缺失）
- [x] `/S`、`--silent`、`-s` 静默检测；静默模式自动安装并在完成后退出
- [x] `/D=` / `--install-dir=` 目录覆盖参数
- [x] `--uninstall` CLI：删除安装目录、桌面/开始菜单快捷方式与 HKCU 卸载项，退出码 0
- [ ] 卸载器“自删除”边界（卸载器位于安装目录内时需先复制到临时目录）——当前 UninstallString 指向安装器 exe
- [ ] 覆盖安装“旧 NSIS 注册表”迁移联调
- [ ] 旧客户端更新联调（2.5.6 实包 → 自定义安装器）
- [ ] 打包流程接入（`dist:win` 产载荷 → 安装器构建 → latest.yml）

## 7. 复测记录（2026-11-25，dev `235ecfc`）

| 用例                 | 结果                                                                               |
| -------------------- | ---------------------------------------------------------------------------------- |
| 全新安装（UIA 点击） | 成功；384 文件 / 659.2 MB；版本 2.5.7；桌面 + 开始菜单 lnk 均生成；28.4s           |
| 覆盖安装（UIA 点击） | 识别「覆盖安装」；28s；384 文件；`已备份旧版本` 步骤出现；staging/backup 无残留    |
| 静默 `/S`            | 35.4s；退出码 0；384 文件；2 个 lnk；版本 2.5.7                                    |
| `--uninstall`        | 退出码 0；安装目录、桌面/开始菜单 lnk、HKCU 卸载项全部清除；无 staging/backup 残留 |
| sha256 篡改          | 被拒；安装目录与注册表均未创建                                                     |
| 进度                 | CDP 轮询读数 0/2/16/78%；UIA 树不暴露百分比文本（仅 API 可读）                     |
| 日志/堆栈            | 安装器 stderr 为空；无崩溃事件                                                     |

已知边界：`payload.zip.json` 缺失时会跳过哈希校验；卸载器自删除（`UninstallString` 指向安装目录内副本时）未处理；UIA 读不到进度百分比属于可访问性限制，不影响 UI 显示。
