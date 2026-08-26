# 扫描器全链路诊断 + 四个核心坑修复 + 手动目录兜底 实施计划

> 目标：先植入全链路结构化诊断日志定位失效节点，再逐项修复注册表 WOW64 重定向、路径拼接两层校验、原生
> readdir 遍历、管理员权限重试四个核心坑，并强化手动选择目录兜底，使扫描结果与 nikki_albums 100% 对齐。
> 同时复用现有 `SCAN_LOG` 通道与 `custom-dirs` 基础设施，避免重复造轮子。

---

## 0. 现状与基线

### 0.1 现有能力（复用，不重写）

- **诊断日志通道已存在**：`scanner.worker-entry.ts` 通过 `sendScanLog` / `sendScanLogInfo` 发 `SCAN_LOG`
  事件 → `scanner-worker-bridge.ts` 转发到主进程 `logger`（info/warn/error 分级别）。
- **三渠道定位已存在**：`game-directory-discovery.ts` 的 `findGameDirectory()` 已支持
  官方启动器 / Steam / Epic，调用 `findOfficialLauncherGamePaths` / `findSteamGamePaths` / `findEpicGamePaths`。
- **手动目录兜底已存在**：`app/custom-dirs.ts` 提供 `getCustomDirs()` / `addCustomDir()` / `removeCustomDir()`，
  settings 页有「额外扫描目录」。扫描时 `resolveScanRoots` 已并入 custom dirs。
- **权限不足重试基础**：`app/permission.ts` 已有 `requestAdminRelaunch()`。
- **原生遍历能力**：`utils/file-utils.ts` 有 `walkDirectory`，但当前内部用 `fast-glob`。

### 0.2 差距（本次要补）

1. **诊断页只看 faults，不看 SCAN_LOG 全链路**：`diagnostics-sections.tsx` 只展示 `getScanFaults()`，
   没有把 worker 的每步扫描日志结构化展示。
2. **官方启动器定位不符合要求**：当前 `findOfficialLauncherGamePaths` 读 HKLM 32 位视图且未强制 `KEY_WOW64_64KEY`，
   未优先读 HKCU `Software\InfinityNikki Launcher` 的 `InstallPath`，未做 `\InfinityNikki` + `X6Game` 两层校验。
3. **目录遍历用了 fast-glob**：`walkDirectory(file-utils.ts)` 依赖 glob，可能被隐式过滤；要求改用原生
   `fs.promises.readdir` 递归、无 filter、仅以「纯数字字符串」筛 UID。
4. **manifest 未设 requireAdministrator**：`package.json` 的 `build.win` 没有 `requestedExecutionLevel`。
5. **权限不足无自动提示 + 重试重启**：`requestAdminRelaunch` 存在但扫描失败路径未接入。

---

## 1. 总体任务拆分

| #   | 任务                              | 关键文件                                                                             | 验收                                             |
| --- | --------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| T1  | 全链路诊断日志持久化 + 诊断页展示 | `scan-log-store.ts`(新)、`scanner-worker-bridge.ts`、`diagnostics-sections.tsx`、IPC | 诊断页可逐节点查看扫描流程与报错                 |
| T2  | 注册表 WOW64 + HKCU 优先修复      | `game-directory-discovery.ts`                                                        | HKCU 优先；HKLM 加 64KEY；返回结构化诊断         |
| T3  | 路径拼接两层校验                  | `game-directory-discovery.ts`                                                        | 拼接 `\InfinityNikki` 并校验含 `X6Game`          |
| T4  | 原生 readdir 遍历 + UID 筛选      | `utils/file-utils.ts`(`walkDirectory`)、`gameplayphotos-root.ts`                     | 无 filter；纯数字 UID；隐藏目录可读              |
| T5  | 管理员权限重试 + manifest         | `app/permission.ts`、`package.json`、`scan-sections` 接入                            | 权限不足弹提示 + 重启；打包 requireAdministrator |
| T6  | 手动目录兜底强化                  | `app/custom-dirs.ts`、`resolve-scan-roots.ts`、`scan-sections.tsx`                   | 自动扫描失败可手动指定 GamePlayPhotos 根         |
| T7  | 验证：单测 + 诊断日志 e2e 自检    | 各 `*.test.ts`                                                                       | 全量 vitest 通过；诊断日志覆盖全节点             |

---

## 2. T1：全链路诊断日志（先做，否则无法定位）

### 2.1 新增 `src/main/scanner/scan-log-store.ts`

- 职责：在**主进程**持久化最近一次扫描的全链路日志（内存 ring buffer + 落盘 `userData/scan-log.jsonl`）。
- 接口：
  ```ts
  export type ScanLogEntry = {
    ts: number
    stage: string
    level: 'info' | 'warn' | 'error'
    message: string
    detail?: unknown
    kind?: 'path-missing' | 'permission' | 'empty' | 'ok' | 'other'
  }
  export const scanLogStore: {
    startRun(): void // 清空并开始新一次扫描日志
    append(e: Omit<ScanLogEntry, 'ts'>): void
    getEntries(): ScanLogEntry[]
    getEntriesSince(id: number): ScanLogEntry[]
  }
  ```
- 依赖声明：`electron`(app)、`fs`、`path`。无新 npm 依赖。
- 参数校验：stage 非空字符串；level 限三值；detail 仅 JSON-serializable。

### 2.2 改造 `scanner-worker-bridge.ts`

- 在 `case 'SCAN_LOG'` 分支内，除转发 logger 外，**调用 `scanLogStore.append(...)`**，
  把每步 `[扫描启动]/[注册表1]/[配置文件]/[路径拼接]/...` 落库。

### 2.3 新增 IPC（renderer 读日志）

- `src/shared/types/ipc.ts` 增加：`GET_SCAN_LOG`(req:void → ScanLogEntry[])、`CLEAR_SCAN_LOG`。
- `src/main/ipc/scan-log-ipc.ts`(新)：注册 handler，返回 `scanLogStore.getEntries()`。
- preload 暴露 `getScanLog()` / `clearScanLog()`。

### 2.4 改造 `diagnostics-sections.tsx`

- 新增「扫描链路诊断」卡片：轮询/点击刷新 `getScanLog()`，按 stage 分组渲染时间线，
  对 `kind==='path-missing'` 标黄、`kind==='permission'` 标红、`kind==='empty'` 标灰、`kind==='ok'` 绿。
- 保留原有 faults 卡片。

### 2.5 验收（T1）

- 运行一次扫描后，诊断页时间线显示从「扫描启动」到「文件扫描」的每一步结果；
- 模拟路径不存在时，对应节点 `kind='path-missing'` 可见且标黄；
- 新增单测 `scan-log-store.test.ts`：startRun 清空、append 顺序、getEntriesSince 增量正确。

---

## 3. T2 + T3：注册表读取 + 路径拼接（合并实现）

### 3.1 改造 `game-directory-discovery.ts` 的 `findOfficialLauncherGamePaths`

现状伪逻辑（需替换）：

```
HKLM\\SOFTWARE\\InfinityNikki Launcher  (32位视图) → InstallPath
```

改为：

1. **优先 HKCU**（当前用户，无 WOW64 问题）：
   `HKCU\Software\InfinityNikki Launcher` → 读 `InstallPath`（REG_SZ）。
   - 用 `registry` npm 包（`@electron/windows-registry` 或直接 `winreg`）。**复用现有依赖**：项目已用 `registry` 包。
   - 强制 `KEY_WOW64_64KEY`：通过 `winreg` 的 `Registry.DEFAULT_ARCHITECTURE='x64'` 或读 HKLM 时传 `{ hive, key, arch: 'x64' }`。
2. **HKLM 兜底**（强制 64 位视图）：`HKLM\SOFTWARE\InfinityNikki Launcher` 或 `...\WOW6432Node\...` 用 `arch:'x64'` 读取。
3. **两层路径校验**（T3）：
   - `launcherDir = InstallPath`（如 `C:\Program Files\InfinityNikki Launcher`）
   - `gameRoot = path.join(launcherDir, 'InfinityNikki')` ← 禁止直接用 launcherDir 当 gameRoot
   - 校验 `fs.existsSync(path.join(gameRoot,'X6Game'))`；不存在 → `kind='path-missing'` 日志 + 继续下一方式（Steam/Epic）。
4. 最终 `GamePlayPhotos` = `path.join(gameRoot,'X6Game','Saved','GamePlayPhotos')`。
5. 每步用 `scanLogStore.append` 输出 `[注册表1]/[配置文件]/[路径拼接]/[目标路径]/[路径存在性]`。

### 3.2 异常与三类错误区分

- 注册表读不到 → `kind='path-missing'`，记 `message='注册表项不存在'` + 原始 error。
- 路径不存在 → `kind='path-missing'`。
- `fs.access` 抛 EACCES/EPERM → `kind='permission'`。
- 目录存在但 0 个 UID → `kind='empty'`。

### 3.3 验收（T2/T3）

- 单测 `game-directory-discovery.test.ts`：
  - Mock HKCU 返回合法 InstallPath → 得到 `...\InfinityNikki\X6Game\Saved\GamePlayPhotos`；
  - Mock HKCU 不存在 → 回退 HKLM 且标志 `KEY_WOW64_64KEY`；
  - Mock gameRoot 下无 `X6Game` → 返回空、日志 `path-missing`；
  - 强制 64 位读取用 mock 验证 `arch:'x64'` 被传入。

---

## 4. T4：原生 readdir 遍历

### 4.1 改造 `utils/file-utils.ts` 的 `walkDirectory`

- 移除 `fast-glob`，改为：
  ```ts
  async function walkDirectory(root, opts) {
    const out = []
    const stack = [root]
    while (stack.length) {
      const dir = stack.pop()
      let entries
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) }
      catch (e) { scanLogStore.append({stage:'目录遍历', level:'error', kind: classifyFsError(e), message:..., detail:e}); continue }
      for (const ent of entries) {            // 不加任何 filter，含隐藏/系统目录
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) stack.push(full)
        else if (opts.match(full)) out.push(full)
      }
    }
    return out
  }
  ```
- **UID 筛选**在 `gameplayphotos-root.ts` 的 `expandGameScanPaths`：遍历 `GamePlayPhotos` 子目录，
  `if (/^\d+$/.test(name))` 视为 UID（`NikkiPhotos_LowQuality`/`NikkiPhotos_HighQuality` 也用正则/白名单，不依赖 glob）。
- 保留 `fs.readdir` 默认可读隐藏目录的事实（不加 filter 即可）。

### 4.2 验收（T4）

- 单测 `file-utils.test.ts`：构造含隐藏子目录的 fixture，断言 `walkDirectory` 能列出隐藏项；
- `gameplayphotos-root.test.ts`：断言 `expandGameScanPaths` 仅把纯数字名当 UID，非数字被忽略。

---

## 5. T5：管理员权限重试 + manifest

### 5.1 `app/permission.ts` 接入扫描失败路径

- 扫描主流程在 `gameplayphotos-root.ts` 捕获 `kind==='permission'` 时，调用
  `requestAdminRelaunch()`（已在 `app/permission.ts`），并 `dialog.showMessageBox` 提示「权限不足，将请求管理员重启」。
- 增加幂等保护：避免重复弹窗（用 module 级 flag）。

### 5.2 manifest（打包）

- `package.json` `build.win` 增加 `"requestedExecutionLevel": "requireAdministrator"`。
- 同时准备一个 `build/installer.nsh` 或直接在 `win` 字段声明（electron-builder 支持 `win.requestedExecutionLevel`）。

### 5.3 验收（T5）

- 单测 `permission.test.ts`：模拟 EPERM → 触发 relaunch 请求（mock `app.relaunch`/`shell`）。
- 构建产物 `release/NikkiGallery-Setup-*.exe` 经 `corflags`/manifest 检查含 `requireAdministrator`
  （用 `powershell Get-AuthenticodeSignature` 或检查内嵌 manifest；手工验证一步，不进单测）。

---

## 6. T6：手动目录兜底强化

### 6.1 `app/custom-dirs.ts` 扩展

- 新增 `getManualGamePlayPhotosRoots()`：返回用户在 settings 手动添加的「GamePlayPhotos 根目录」列表
  （与现有 extra 扫描目录区分，专用于兜底）。
- `resolve-scan-roots.ts` 的 `resolveScanRoots()` 把 manual roots 与自动发现结果合并；
  **自动发现为空时，仅用 manual roots 并打 `kind='empty'` 诊断**。

### 6.2 UI：`scan-sections.tsx` 增加「手动指定游戏相册目录」选择器

- 调用 `dialog.showOpenDialog({ properties:['openDirectory'] })` → `addManualRoot()`。
- 列表展示 + 删除；保存后触发一次扫描。

### 6.3 验收（T6）

- 单测 `custom-dirs.test.ts`：addManualRoot/getManualGamePlayPhotosRoots/remove 正确；
- 手动行为：自动扫描失败 → 用户指定 `...\GamePlayPhotos` → 扫描成功且 UID 分类正确。

---

## 7. 验证纪律（每段最多审查一次）

1. 每完成一个 T，立即跑对应 `*.test.ts`（`npx vitest run <file>`），全绿再进下一 T。
2. T1–T6 完成后，跑 `npx vitest run src/main/scanner src/main/utils src/main/app`（全量相关单测）。
3. 用 `npm run dev` 启动 → 触发扫描 → 打开诊断页确认时间线完整（人工验证一步）。
4. 不循环指派新成员反复验证同一产出；审查须指向具体检查项（如「assert HKCU 优先于 HKLM」「assert readdir 无 filter」）。

---

## 8. 依赖声明

- **无新增 npm 依赖**：复用现有 `registry`/`winreg`、`electron`(app/dialog)、`fs`、`path`。
- 如 `registry` 包缺失则仅用 Node 原生 + `child_process` 调 `reg query`（兜底，不优先）。

## 9. 启动 / 运行说明

- 开发：`npm run dev` → 设置页「扫描」触发；诊断页看链路。
- 测试：`npx vitest run`（单测）；`npm run build` 构建（注意本机 Safe-Delete 网关：用 `npx electron-vite build`）。
- 打包：`npm run dist`（已含 requireAdministrator manifest）。

## 10. 错误处理总表

| 错误         | kind         | 处理                     |
| ------------ | ------------ | ------------------------ |
| 注册表项缺失 | path-missing | 日志 + 回退下一渠道      |
| 路径不存在   | path-missing | 日志 + 放弃该根          |
| EACCES/EPERM | permission   | 日志 + 提示 + 管理员重启 |
| 目录为空     | empty        | 日志 + 走 manual root    |
| 读取异常     | other        | 日志 + 跳过该目录继续    |

## 11. 参数校验

- `stage`: 非空 string；`level`: enum；`detail`: JSON-safe。
- `expandGameScanPaths` 入参 `root`: 绝对路径且存在，否则抛 `kind='path-missing'`。
- `addManualRoot`: 校验是目录且存在。

## 12. 基础测试用例清单

- `scan-log-store.test.ts`：startRun/append/getEntriesSince。
- `game-directory-discovery.test.ts`：HKCU 优先 / 64KEY / 两层校验 / 三类错误。
- `file-utils.test.ts`：隐藏目录可读 / 无 filter。
- `gameplayphotos-root.test.ts`：纯数字 UID 筛选。
- `permission.test.ts`：EPERM→relaunch。
- `custom-dirs.test.ts`：manual root 增删查。

---

## 13. 验证收尾结论（2026-08-26）

按用户决策「在现有未提交改动上收尾（验证+补齐+跑单测+修错）」执行。经逐文件核对，诊断链路与四坑修复均已在未提交工作区就位，无需改码；全量单测零回归。

### 13.1 诊断日志链路（验收 #1）

- 9 个节点齐全：scan-start(worker-entry:492)、registry-hkcu(game-directory-discovery:194)、config(game-directory-discovery:227)、path-join(game-directory-discovery:258)、target-path(game-directory-discovery:458)、path-existence(game-directory-discovery:465)、dir-traverse(uid-discovery:83)、traverse-result(uid-discovery:94，含 UID 列表)、file-scan(worker-entry:1199，含目录数/媒体文件数/新增数)。
- 三类错误经 classifyFsError 归一：ENOENT→path-missing、EACCES/EPERM→permission、目录 0 UID→empty、其余→other。
- 诊断页 scan-log-diagnostic-section.tsx 从 getScanLog 拉取、按 [stage]+message+kind 渲染时间线，diagnostics.scan.* i18n 键齐全（zh-CN.json:2668）。

### 13.2 四坑核验

- 坑一 WOW64+HKCU：OFFICIAL_LAUNCHER_REG_KEYS HKCU 置首位；HKLM 项 use64BitView 经 C:\Windows\System32\reg.exe 强制 64 位视图。
- 坑二 两层校验：InstallPath\InfinityNikki 拼游戏根；validateGameRoot 校验 X6Game；目标严格 [根]\X6Game\Saved\GamePlayPhotos。
- 坑三 原生遍历：readUidsFromDir 用 fs.readdirSync 无 filter，仅 isDirectory()+ /^\d{6,12}$/ 筛 UID；src/ 内 fast-glob/glob 引用 0。
- 坑四 权限：permission.ts 幂等 promptAdminRelaunch；package.json build.win.requestedExecutionLevel=requireAdministrator(:249)；gameplayphotos-root 在 kind==='permission' 触发 onPermissionDenied。

### 13.3 nikki_albums 对齐（验收 #2/#3/#4）

- nikki-albums-compat.test.ts(4) 断言：GamePlayPhotos 豁免、UID/相册/来源分类与 path-classifier 纯函数一致、HQ 复用原生 LQ 缩略图（不生成新文件）、隐藏目录强制遍历。
- 三渠道（官方启动器/Steam/Epic）由 findGameInstallRootsByPriority 命中即止（worker-entry.findMediaDirectories.test.ts 5 例覆盖）。

### 13.4 测试运行结果

- npx vitest run src/main/scanner → 33 文件 / 397 用例全绿。
- npx vitest run（全量）→ 210 文件 / 3832 用例全绿，零回归。
- 关键单测：permission.test.ts 5/5、scan-log-store.test.ts 9/9、uid-discovery.test.ts 16/16、nikki-albums-compat.test.ts 4/4、gameplayphotos-hidden-traversal.test.ts 3/3、scan-diagnose.test.ts 3/3。

### 13.5 未执行项（环境约束，非缺陷）

- e2e S7（e2e/smoke.e2e.ts:106）需对含本次未提交改动的 win-unpacked 重打包才能验证改动本身；当前 release/win-unpacked 为旧产物（2.3.5/2.3.6-beta）不含未提交改动。S7 引用的 [Startup] 开始后台自动扫描、findMediaDirectories 搜索结果、[Startup] 扫描完成 字符串在代码中均存在（startup-tasks.ts:55 / worker-entry.ts:532 / zh-CN.json:3544），重打包后 npm run e2e:smoke 即可验证。重打包须用 Safe-Delete 安全序列：npx electron-vite build + 写 dist/main/package.json {"type":"commonjs"} + npx electron-builder --win --publish never + npm run verify:dist。
