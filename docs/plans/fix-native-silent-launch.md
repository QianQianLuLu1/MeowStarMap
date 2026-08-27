# 修复原生模块静默启动失败 — 实施与验证手册

> 对应计划：`fix-native-module-silent-launch`
> 适用：NikkiGallery（Electron 40.10.6，Windows x64，最低兼容 Win10 1803+）

## 背景与根因

开发机可正常启动，但打包后在干净 Windows 双击无响应、无弹窗。项目依赖多个 C/C++ 原生模块：

- `better-sqlite3`（node-gyp / VS2022 编译）
- `koffi`（FFI，预编译 `@koromix/koffi-win32-x64`）
- `sharp` / libvips（`@img/sharp-win32-x64`、`@img/sharp-libvips-win32-x64`）

四类根因方向：

1. **原生模块与 Electron ABI/架构不匹配** → 已由既有 `checkNativeAbiConsistency` 闸门覆盖（electron 精确版本 + `npmRebuild` + `asarUnpack`）。
2. **VC++ 运行库缺失（本方案主解）** → `better-sqlite3`/`koffi`/libvips 动态链接 `vcruntime140.dll`/`vcruntime140_1.dll`/`msvcp140.dll`/`concrt140.dll`，干净 Win10 缺之即 `LoadLibrary` 失败，进程静默退出。
3. **asar 压缩吞掉 .node 二进制** → 已由 `asarUnpack` + `checkUnpackedNativeBinaries` 覆盖。
4. **安装路径含特殊字符** → `verifyCriticalNativeModules` 在启动期检测并提示（现代 Windows 多可加载，仅提示不阻塞）。

此外，原 `src/main/index.ts` 的 FATAL 弹窗文案依赖 `t()`（i18n）。若原生模块在 i18n 初始化前加载失败，`t()` 二次抛错 → 对话框本身崩溃 → **正是“无弹窗”**。本方案改为不依赖 i18n 的同步 `dialog.showErrorBox`。

---

## 依赖声明

| 类型             | 名称                                                                         | 版本/来源                                                     | 说明                                                                             |
| ---------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 系统 DLL（随包） | `vcruntime140.dll` / `vcruntime140_1.dll` / `msvcp140.dll` / `concrt140.dll` | 构建机 `%SystemRoot%\System32`（VC++ 2015-2022 x64 可再发行） | 经 `afterPack` 复制到与 `electron.exe` 同级；符合微软再分发许可                  |
| 构建钩子         | `scripts/after-pack-vc-runtime.cjs`                                          | 新增，CommonJS                                                | 不引入 npm 依赖，仅用 Node 内置 `fs`/`path`                                      |
| npm 依赖         | 无新增                                                                       | —                                                             | 沿用 `electron`/`electron-builder`/`electron-vite`/`vitest` 现有版本，不升不降   |
| 既有闸门         | `scripts/pre-dist-check.ts`                                                  | 扩展                                                          | 追加 VC++ DLL 断言 + afterPack 配置断言，不改动既有 ABI/解包逻辑                 |
| 运行时预检       | `src/main/app/native-load-guard.ts`                                          | 新增                                                          | 纯函数 + 可注入依赖，复用 `electron.dialog.showErrorBox` 与 `startup-diagnostic` |

---

## 启动说明（构建与运行）

### 受限环境构建序列（避开 Safe-Delete 网关，禁止 `npm run build` 的 clean 步）

```powershell
# 1) 构建前端/主进程产物（不触发 clean）
npx electron-vite build

# 2) 写 dist/main/package.json {type:commonjs} 标记（electron-vite 已带该插件，此处为显式兜底）
node -e "require('fs').writeFileSync('dist/main/package.json', JSON.stringify({type:'commonjs'}))"

# 3) 打包前闸门（ABI 一致 + VC++ 随包钩子已接线）
npx tsx scripts/pre-dist-check.ts

# 4) 打包（electron-builder 会自动执行 afterPack 复制 4 个 VC++ DLL）
npx electron-builder --win --publish never

# 5) 解包后闸门（断言 .node 与 VC++ DLL 均存在）
npx tsx scripts/pre-dist-check.ts --verify-asar
```

等价一键脚本：`npm run dist:win`（其 clean 步在受限环境可能触发 EPERM；如遇 EPERM，改用上面的分步序列）。

### afterPack 行为

- 仅当 `electronPlatformName === 'win32'` 时复制 4 个 DLL 到 `appOutDir` 根（与 `electron.exe` 同级）。
- 非 win 平台直接跳过，不影响其他流程（本项目仅发 win）。
- 任一 DLL 在构建机缺失 → `afterPack` 抛错，**中断打包**，杜绝“漏带运行库”被发版。

### 运行时 guard 触发时机

`app.whenReady()` 回调内、首个 `await import('./app/application')` 之前，同步执行 `verifyCriticalNativeModules()`：

- 全部加载成功 → 继续初始化；`application.initialize()` 完成后写 `userData/boot-ok.marker`。
- 任一失败 → `dialog.showErrorBox`（同步、无需窗口、不依赖 i18n）给出双语指引 + 写 `startup-errors.log` + `app.exit(1)`。

### 开发调试

- `NIKKI_SKIP_NATIVE_GUARD=1` 可跳过预检（仅严格等于 `'1'` 才生效），不影响 `npm run dev`。

---

## 错误处理

四类分支（均用 `dialog.showErrorBox`，同步、无需窗口、不依赖 i18n；同时 `startup-errors.log` 落盘）：

| 类别             | 触发关键字                                                                      | 标题                             | 正文要点                                                     |
| ---------------- | ------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------ |
| 缺 VC++ 运行库   | `The specified module could not be found` / `DLL initialization routine failed` | 无法启动：缺少 Visual C++ 运行库 | 下载安装 VC++ 2015-2022 可再发行 (x64) + 官方链接 + 日志路径 |
| ABI 不匹配       | `NODE_MODULE_VERSION` / `compiled against a different`                          | 原生模块版本不兼容               | 重新安装/更新官方最新版本                                    |
| 原生模块文件缺失 | `Could not locate the bindings file` / `Cannot find module`                     | 原生模块文件缺失                 | 重新安装或联系支持                                           |
| 特殊字符路径     | `process.execPath` 含非 ASCII                                                   | 安装路径含特殊字符               | 建议纯英文路径（仅提示，不阻塞）                             |
| 未知/兜底        | 其他                                                                            | 启动失败                         | 展示 `err.message` + 日志路径                                |

FATAL 兜底（`index.ts` catch）：改用 `showFatalStartupErrorBox`（不依赖 i18n 的常量文案），杜绝 `t()` 二次抛错导致无弹窗。

---

## 参数校验

- 预检模块名列表为硬编码常量 `['better-sqlite3','koffi','sharp']`，无外部输入。
- 注入依赖 `requireImpl`/`showErrorBox`/`getExecPath`/`getEnv`/`log` 缺省取真实实现；测试注入 mock。
- 跳过开关 `NIKKI_SKIP_NATIVE_GUARD`：仅当 `process.env.NIKKI_SKIP_NATIVE_GUARD === '1'`（严格全等，忽略大小写/空白/其他值）才跳过，防误触。
- 特殊字符检测：扫描 `process.execPath` 每个字符码点 `> 127` 即判为非 ASCII；边界为“报告 + 提示 + 不阻塞”。
- `afterPack` 校验：`electronPlatformName === 'win32'` 且 `fs.existsSync` 目标 DLL 存在；缺失即 `throw` 中断打包（参数校验 + 构建硬闸门）。

---

## 基础测试用例

### 1. pre-dist-check（tsx，本机可跑）

- `--verify-asar` 新增断言 `appOutDir` 根存在 `vcruntime140.dll`/`vcruntime140_1.dll`/`msvcp140.dll`/`concrt140.dll`；缺失则退出码 1。
- 打包前模式新增 `checkVcRuntimeAfterPackConfigured()`：断言 `build.afterPack` 指向的钩子脚本存在。
- 既有 `checkNativeAbiConsistency` 与 `checkUnpackedNativeBinaries` 仍通过（不回归）。

验收：`npx tsx scripts/pre-dist-check.ts` 与 `npx tsx scripts/pre-dist-check.ts --verify-asar` 在带 release 产物时均 0 失败。

### 2. vitest 单测（CI/正常环境跑）`src/main/app/native-load-guard.test.ts`

- `classifyNativeLoadError`：ABI 文案 → `abi-mismatch`；`The specified module could not be found` → `missing-vc-runtime`；`Could not locate the bindings file` → `bindings-missing`；随机 → `unknown`。
- `verifyCriticalNativeModules`：注入 `requireImpl` 抛 `missing-vc-runtime` → `showErrorBox` 含「VC++」且返回 false；抛 `abi-mismatch` → 含「不兼容」；全成功 → 不调用 `showErrorBox` 且返回 true。
- 跳过开关：`NIKKI_SKIP_NATIVE_GUARD='1'` → 不调用 `showErrorBox` 且返回 true；`'true'` → 仍拦截。
- 特殊字符：`execPath` 含中文 → `showErrorBox` 含「特殊字符」且仍返回 true（继续启动）。

验收：`npx vitest run src/main/app/native-load-guard.test.ts` 全绿（本机 vitest 损坏，须在 CI 或正常环境跑；本机以 `tsc -b` + `eslint` 兜底）。

### 3. 纯净系统复现与负向验证（交付③）

**正向（修复后应通过）**

1. 准备 Win10 1803+ 干净虚拟机（无 VS、无 Node、未安装 VC++ 2015-2022 可再发行组件）。
2. 在开发机执行上面的受限环境构建序列，得到 `release/NikkiGallery-Setup-<ver>.exe`。
3. 拷入虚拟机安装（建议默认 Program Files 英文路径）。
4. 双击启动 → 主窗口出现；`%APPDATA%\无限暖暖相册管理工具\boot-ok.marker` 存在且内容为 `ok`。

**负向（验证“不再静默崩溃”）**

1. 在上述已安装目录的程序文件夹（`...\<应用名>-x64\`）中，临时将 `vcruntime140_1.dll` 改名（模拟运行库缺失）。
2. 双击启动 → 应弹出「无法启动：缺少 Visual C++ 运行库」对话框，而非静默退出。
3. `startup-errors.log` 含 `native-load-guard: better-sqlite3 failed (missing-vc-runtime)`。
4. 恢复文件名后再次启动 → 窗口正常出现，证明修复有效。

**E2E 接入（可选增强）**：复用 `e2e:smoke`（Playwright 针对已安装应用），断言启动后 `boot-ok.marker` 生成，作为 CI 中“干净环境可启动”的自动化证据。

---

## 实现注意事项（防回归）

- 仅改动：`scripts/after-pack-vc-runtime.cjs`（新）、`scripts/pre-dist-check.ts`、`package.json`（`afterPack`）、`src/main/app/native-load-guard.ts`（新）、`src/main/app/native-load-guard.test.ts`（新）、`src/main/index.ts`。
- 不触碰 `MasonryView.tsx`/`BatchActions.*`/`globals.css`/`ShareMenuButton.tsx` 等无关改动。
- `index.ts` 改动保持既有 `uncaughtException`/`unhandledRejection` 注册顺序与 `startup-diagnostic` 落盘路径不变。
- 提交遵循 conventional commits 且 subject ≤ 72 字符，pre-commit lint-staged 通过。
