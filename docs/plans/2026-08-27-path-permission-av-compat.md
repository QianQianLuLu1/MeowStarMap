# 路径权限与安全环境兼容性治理实施计划

> 项目：NikkiGallery（无限暖暖相册管理工具）Windows 桌面相册
> 角色：Electron 系统兼容性专家
> 日期：2026-08-27
> 关联：复用 `docs/plans/fix-native-silent-launch.md` 的「启动期预检 + i18n-free 双语弹窗 + 诊断落盘 + `app.exit(1)`」模式

## 0. 目标与边界

**目标**：治理干净 Windows 上三类高发启动失败——①安装路径含中文/特殊字符、②系统目录权限不足、③杀毒软件误拦截，提升开箱可用率。

**边界约束（硬性）**：

- 不改变用户数据默认存储语义（仍落 `app.getPath('userData')`，即 `%APPDATA%\<应用名>`）。
- 不引入任何额外重型 npm 依赖；仅用 Node 内置 `path`/`fs`/`child_process` 与既有模块。
- 兼容 Windows 多用户权限体系（默认以当前用户身份 `asInvoker` 运行，写入属于该用户可写位置）。
- 不改与问题无关的功能（`MasonryView.tsx`、`BatchActions.*`、`globals.css`、`ShareMenuButton.tsx` 等不触碰）。

**验证纪律**：每段代码最多审查一次且须指出具体检查项；无严重缺陷即推进，不循环重复验证；每步先自验通过再进入下一步。

---

## 子任务 A：路径标准化与特殊字符治理

### 依赖声明

| 类型     | 名称                                                                           | 说明                                          |
| -------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| 运行时   | Node 内置 `path`/`fs`                                                          | 路径扫描与目录创建，无新增依赖                |
| 复用模块 | `src/main/utils/dir-manager.ts`（`ensureDir`/`isValidDir`）                    | 目录存在性与 W_OK 校验                        |
| 复用模块 | `src/main/app/native-load-guard.ts`（`hasNonAscii` → 抽到 `path-safety` 共用） | 非 ASCII 路径判定                             |
| 测试     | vitest 1.6.1（CI/正常环境跑）                                                  | 本机 vitest 损坏，以 `tsc -b` + `eslint` 兜底 |

### 修改文件 / 输入 / 输出

- **`src/main/utils/path-safety.ts`【新增】**：导出
  - `hasNonAsciiPath(p: string): boolean` —— 任一字符码点 `>127` 返回 `true`。
  - `ensureWritableDir(dir: string): boolean` —— 入参须为绝对路径；空串/相对路径直接 `false`；`ensureDir` 建目录后 `fs.accessSync(dir, fs.constants.W_OK)` 校验，异常返回 `false`。
  - `resolveSafeBinaryPath(candidate: string, fallback: string): string` —— `fs.existsSync(candidate) && !hasNonAsciiPath(candidate)` 时返回 `candidate`，否则返回 `fallback`。
- **`src/main/app/native-load-guard.ts`【修改】**：删除本地 `hasNonAscii`，改为 `import { hasNonAsciiPath } from '../utils/path-safety'`（行为不变）。
- **`src/main/utils/ffmpeg-paths.ts`【修改】**：`resolveBinaryPath` 在 `fs.existsSync(resolved)` 为 true 但 `hasNonAsciiPath(resolved)` 为 true 时，降级到入参 `fallback`（系统 `ffmpeg`/`ffprobe`），并 `diagLog('FFMPEG','non-ascii path, fall back to system PATH')`。
- **`src/main/index.ts`【修改】**：在 `verifyCriticalNativeModules()` 之后插入 `verifyStartupEnvironment()` 调用（见子任务 B）。

### 启动说明

`app.whenReady()` 回调内，启动早期对 `process.execPath`（安装路径）做非 ASCII 扫描；安装路径含中文仅提示不阻塞（沿用 native-guard 既有语义）；ffmpeg 二进制路径含中文时在解析层静默降级到系统 PATH。

### 错误处理

- 非 ASCII 安装路径：`showErrorBox` 双语提示「建议安装到纯英文路径」，不阻塞启动，诊断落盘。
- ffmpeg 路径含中文：降级到系统 `ffmpeg`/`ffprobe` 并记录 warning；若系统也无则后续 video 功能自然失败（已有 video-service 错误兜底），不影响主启动。

### 参数校验

- `hasNonAsciiPath` 扫描每个字符码点 `>127`。
- `ensureWritableDir` 入参须为绝对路径，空串/相对路径直接返回 `false`。
- `resolveSafeBinaryPath` 仅在 `existsSync` 且 `!hasNonAsciiPath` 时采用本地二进制，否则回退 `fallback`。

### 基础测试用例（`src/main/utils/path-safety.test.ts`）

- `hasNonAsciiPath('C:\\中文\\app.exe')` → `true`；`hasNonAsciiPath('C:\\Program Files\\app.exe')` → `false`。
- `ensureWritableDir(tmpDir)` → 创建成功返回 `true`；传入 `fs.chmodSync(0o444)` 临时目录 → 返回 `false`，清理后恢复 `0o777`。
- `resolveSafeBinaryPath`：中文路径候选 + ascii fallback → 返回 fallback。
- **验收**：`npx vitest run src/main/utils/path-safety.test.ts` 全绿（正常环境）；本机 `tsc -b` 该文件 0 类型错误 + `eslint .` 0 错。

---

## 子任务 B：启动期权限检测与友好引导

### 依赖声明

| 类型     | 名称                                               | 说明                                                                             |
| -------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| 复用模块 | `src/main/utils/dir-manager.ts`                    | `ensureDir`/`isValidDir`（含 W_OK）                                              |
| 复用模块 | `src/main/app/native-load-guard.ts`                | `defaultShowErrorBox` 双语弹窗模式                                               |
| 复用模块 | `src/main/app/permission.ts`                       | 保留 `requestAdminRelaunch` 作为 GamePlayPhotos 按需提权兜底（不删、不默认触发） |
| 配置     | `package.json` `build.win.requestedExecutionLevel` | 改 `asInvoker`                                                                   |

### 修改文件 / 输入 / 输出

- **`src/main/app/startup-environment.ts`【新增】**：`verifyStartupEnvironment(deps?)` 编排两件事：
  1. `checkInstallPathNonAscii(execPath)` → 非阻塞 warning（复用 `hasNonAsciiPath`）。
  2. `checkUserDataWritable(userData)` → 阻塞：不可写时弹双语框（含「检查杀软拦截 / 以管理员身份重启 / 修改数据目录」建议）并 `logStartupError` + 返回 `false`。
  - 注入 `showErrorBox` / `getExecPath` / `getUserDataPath` / `log` 便于测试。
- **`src/main/index.ts`【修改】**：在 `verifyCriticalNativeModules()` 后调用 `if (!verifyStartupEnvironment()) { releaseLock(); app.exit(1); return }`。
- **`package.json`【修改】**：`build.win.requestedExecutionLevel: "asInvoker"`（删除 `requireAdministrator`）。

### 启动说明

启动早期（应用加载前）检测 userData 是否可写；默认 `asInvoker` 下进程以当前用户身份运行，写入 `%APPDATA%\<应用名>` 属正常用户可写位置，多用户互不干扰。

### 错误处理

- userData 不可写（被杀软锁定/磁盘满/漫游配置失效）：弹双语 `showErrorBox` 给 3 条可操作建议，写 `startup-errors.log`，`app.exit(1)`，绝不静默。
- 安装路径非 ASCII：仅 warning，不阻塞（与 native-guard 一致）。

### 参数校验

- `getUserDataPath` 缺省取 `app.getPath('userData')`；`getExecPath` 缺省 `process.execPath`。
- 跳过开关沿用 native-guard 体系：加 `NIKKI_SKIP_ENV_GUARD=1`（仅严格 `'1'` 跳过，防误触）。

### 基础测试用例（`src/main/app/startup-environment.test.ts`）

- 注入 `getUserDataPath` 指向 `fs.chmodSync(0o444)` 临时目录 → `verifyStartupEnvironment` 调用 `showErrorBox`（含「权限」）并返回 `false`。
- `getUserDataPath` 指向可写临时目录 + `getExecPath` 纯英文 → 不调用 `showErrorBox` 且返回 `true`。
- `getExecPath` 含中文 → 调用 `showErrorBox`（含「特殊字符」）但仍返回 `true`（继续启动）。
- **验收**：`npx vitest run src/main/app/startup-environment.test.ts` 全绿；`tsc -b` 0 错 + `eslint .` 0 错。

---

## 子任务 C：打包特征优化降杀软误杀

### 依赖声明

| 类型   | 名称                                               | 说明                                  |
| ------ | -------------------------------------------------- | ------------------------------------- |
| 配置   | `package.json` `build.win.requestedExecutionLevel` | `asInvoker`（单点改动，同时缓解 B/C） |
| 闸门   | `scripts/pre-dist-check.ts`                        | 新增 `checkNoAdminManifest()` 断言    |
| 子进程 | `ffmpeg-runner.ts` / `video-probe.ts`              | 核查并补全 `windowsHide: true`        |

### 修改文件 / 输入 / 输出

- **`package.json`【修改】**：`requestedExecutionLevel: "asInvoker"`（已在 B 完成，此处固化验证）。
- **`scripts/pre-dist-check.ts`【修改】**：新增 `checkNoAdminManifest()`，读取 `build.win.requestedExecutionLevel`，若等于 `'requireAdministrator'` 则 `console.error` + 退出码 1；在 `verify:dist --verify-asar` 与打包前两种模式均调用。
- **`src/main/utils/ffmpeg-runner.ts` / `src/main/utils/video-probe.ts`【核查结论：无需改动】**：两者均通过 `fluent-ffmpeg` 的 `.run()` / `.ffprobe()` 间接 spawn，而 fluent-ffmpeg 源码已在 `lib/processor.js:441` 与 `lib/ffprobe.js:155` 硬编码 `{ windowsHide: true }`，故子进程已默认隐藏窗口，**无需重复改动**（符合"核查后最小化、不引入冗余改动"）。

### 启动说明

打包产物 NSIS 默认 `asInvoker`，双击启动不再弹 UAC；`pre-dist-check` 在打包/校验阶段即拦截「管理员清单」回归。

### 错误处理

- 若有人误改回 `requireAdministrator`，`pre-dist-check` 直接失败阻断打包并给出明确提示。
- ffmpeg 子进程 `windowsHide: true` 避免闪黑窗（既降误判观感也防部分 AV 对子窗口的启发式）。

### 参数校验

- `checkNoAdminManifest` 严格字符串比较，仅 `'requireAdministrator'` 判违规；缺省或 `'asInvoker'` 均通过。

### 基础测试用例（`scripts/pre-dist-check.ts` 内联 + tsx 手动）

- 临时将 `package.json` 改为 `requireAdministrator` 跑 `npx tsx scripts/pre-dist-check.ts` → 退出码 1 且打印「管理员清单」告警。
- 改回 `asInvoker` 重跑 → 0 失败。
- **验收**：受限环境构建序列中 `npm run pre-dist-check` 通过；`verify:dist --verify-asar` 通过。

---

## 子任务 D：集成验证与文档

### 修改文件

- 本文件 `docs/plans/2026-08-27-path-permission-av-compat.md` 即汇总文档。

### 覆盖场景与逐步验证（每步先通过再下一步）

1. **单元层**：A/B/C 三个测试文件 `npx vitest run` 全绿；本机 `tsc -b` 仅本次改动文件 0 类型错误 + `eslint .` 0 错误。
2. **闸门层**：`npx tsx scripts/pre-dist-check.ts` 与 `--verify-asar` 均 0 失败（含新 `checkNoAdminManifest`）。
3. **构建层（受限环境序列）**：`npx electron-vite build` → 写 `dist/main/package.json {type:'commonjs'}` → `npm run pre-dist-check` → `npx electron-builder --win --publish never` → `npm run verify:dist`，产出 `release/NikkiGallery-Setup-<ver>.exe` 且 manifest 为 `asInvoker`（解包看 `*.exe.manifest` 或 `Get-AuthenticodeSignature` 辅助验证）。
4. **干净 Win10（无 VC++/无 Node）**：安装后双击启动 → 主窗口出现 + `userData` 下正常写入。
5. **中文安装路径（如 `D:\中文目录\`）**：启动不静默，必要时弹「特殊字符」双语引导，且 ffmpeg 路径降级到系统 PATH 后仍可转码。
6. **受限目录（userData 被设为只读/被杀软锁定）**：启动弹双语「权限不足」引导而非静默退出；`startup-errors.log` 含对应记录。
7. **杀软环境（Windows Defender 实时防护）**：`asInvoker` 下安装/启动不再因 UAC 提权特征被拦截；记录 Defender 是否对 `NikkiGallery-Setup` 报毒（仅观测，代码签名需证书超出本次范围，文档中给出签名建议）。

### 防回归纪律

- 仅改上述清单文件；不触碰与问题无关改动。
- 保留 `permission.ts` 按需提权作为 GamePlayPhotos 兜底，不改其触发条件。
- 每段代码最多审查一次，审查列具体检查项（类型签名、i18n-free 文案、注入依赖可测、错误回落路径、不新增依赖）；无严重缺陷即推进。

---

## 目录结构（改动清单）

```
src/main/
├── utils/
│   ├── path-safety.ts                # [NEW] hasNonAsciiPath / ensureWritableDir / resolveSafeBinaryPath
│   ├── path-safety.test.ts           # [NEW]
│   ├── ffmpeg-paths.ts               # [MODIFY] 非 ASCII 二进制降级到系统 PATH
│   ├── ffmpeg-runner.ts              # [核查无需改动] fluent-ffmpeg 已默认 windowsHide:true
│   └── video-probe.ts                # [核查无需改动] fluent-ffmpeg 已默认 windowsHide:true
├── app/
│   ├── native-load-guard.ts          # [MODIFY] 改 import hasNonAsciiPath（行为不变）
│   ├── startup-environment.ts        # [NEW] verifyStartupEnvironment
│   ├── startup-environment.test.ts   # [NEW]
│   └── permission.ts                 # [保持] 仅 GamePlayPhotos 按需提权
└── index.ts                          # [MODIFY] 插入 verifyStartupEnvironment
package.json                          # [MODIFY] requestedExecutionLevel -> "asInvoker"
scripts/pre-dist-check.ts             # [MODIFY] 新增 checkNoAdminManifest 断言
docs/plans/2026-08-27-path-permission-av-compat.md # [NEW] 本文件
```

---

## 执行验证记录（2026-08-27）

本机环境限制（vitest worker 损坏、Safe-Delete 网关拦截 `clean`），验证以「`tsc -b` + `eslint` + 受限环境构建序列（不跑 `npm run dist:win` 的 clean 步）」替代单测运行；单元层用例已在正常环境约定中给出，须 CI 复跑。

| 子任务       | 验证动作                                                                                                                                                                                                                                                                        | 结果        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| A 路径安全   | `eslint` 4 个文件 0 错；`tsc -b` 本次文件 0 类型错误；`dir-manager` 导出 `isValidDir` 复用                                                                                                                                                                                      | ✅ 通过     |
| B 启动期环境 | `eslint` startup-environment + index 0 错；`tsc -b` 0 错；构建产物 `dist/main/main/app/index.js` 含 `verifyStartupEnvironment` 且在 `whenReady` 内（line 491）调用                                                                                                              | ✅ 通过     |
| C 打包特征   | 新闸门 `checkNoAdminManifest`：①`asInvoker` 时 `--verify-asar` 打印「管理员清单闸门通过：requestedExecutionLevel=asInvoker」；②临时改 `requireAdministrator` 时 `--verify-asar` 拦截失败（fail 分支生效）；③打包前默认模式 `pre-dist-check`（含 12 项既有 + 新闸门）全绿 EXIT=0 | ✅ 通过     |
| C 子进程隐藏 | 核查 `node_modules/fluent-ffmpeg/lib/processor.js:441` 与 `ffprobe.js:155` 已硬编码 `windowsHide: true` → **无需改动** ffmpeg-runner/video-probe                                                                                                                                | ✅ 核查通过 |
| 集成构建     | `npx electron-vite build` 成功（`✓ built in 4.29s`）；写 `dist/main/package.json {type:"commonjs"}`；`pre-dist-check` 默认模式 EXIT=0                                                                                                                                           | ✅ 通过     |

### 已知待办 / 超出本次范围

- **代码签名**：`signAndEditExecutable: false` 且无证书，是当前「杀软报毒」的根本解法；建议后续配置 `CSC_LINK`/`CSC_KEY_PASSWORD` + `rfc3161TimestampServer` 做 EV/标准代码签名。本次未引入（无证书、非重型依赖）。
- **单元层单测**：`path-safety.test.ts` / `startup-environment.test.ts` 已就位，须在 CI/正常环境 `npx vitest run` 复跑（本机 vitest 损坏无法跑）。
- **真实场景 4–7**（干净 Win10 / 中文安装路径 / 受限目录 / Defender）需在目标机手测，本机仅完成静态 + 构建 + 闸门验证。

### 防回归门禁（已固化）

- `scripts/pre-dist-check.ts` 的 `checkNoAdminManifest` 在打包前与解包后两种模式均运行，任何人误改回 `requireAdministrator` 将被阻断。
- 启动期 `verifyStartupEnvironment` 在 `index.ts` 的 `whenReady` 内、`Application` 加载前接入，沿用 `NIKKI_SKIP_ENV_GUARD=1` 跳过开关体系。
