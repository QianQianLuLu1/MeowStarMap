# 启动失败弹窗日志缺失 + 反馈诊断包导出卡死：修复实施计划

- 日期：2026-09-18
- 版本：2.5.1
- 影响面：启动诊断链路、反馈诊断包导出、子进程错误兜底
- 原则：最小化改动，禁止顺手重构；优先复用成熟开源方案（archiver），禁止重复造轮子

---

## 1. 问题与根因

### 现象

1. 启动时弹「启动失败 / Startup Failed」，显示 `原因 / Reason: spawn EFTYPE`，日志路径
   `C:\Users\Administrator\Documents\NikkiGallery\Diagnostics\startup-errors.log`，
   但该目录下**没有** `startup-errors.log`。
2. 右下角「反馈」→ 导出诊断压缩包：按钮始终显示「正在导出」，永不结束、不产文件。

### 根因 A：弹窗日志路径与真实落盘路径不同源

| 角色     | 代码位置                                                                                                    | 计算结果                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 弹窗展示 | `src/main/utils/early-crash-guard.ts` `resolveDiagDir()` → `getUserFacingDiagDir({ getDocumentsPath })`     | `<文档>/NikkiGallery/Diagnostics/startup-errors.log`     |
| 真实写盘 | `src/main/utils/startup-diagnostic.ts` `getStartupLogPath()` → `getUserFacingDiagDir()`（未注入 documents） | `<用户目录>/NikkiGallery/Diagnostics/startup-errors.log` |
| 第三口径 | `src/main/app/lifecycle.ts` fatal catch                                                                     | `<userData>/startup-errors.log`                          |
| 第四口径 | `src/main/services/log-service.ts` 导出时复制                                                               | `<logDir>/../startup-errors.log`                         |

弹窗指向 Documents，日志实际落在 `%USERPROFILE%\NikkiGallery\Diagnostics` → 用户必然找不到。

### 根因 B：诊断包导出依赖外部 `tar.exe`

`src/main/services/log-service.ts` 用 `spawn('tar.exe', ['-c','--format=zip',...])` 打包。

- `EFTYPE` = `ERROR_BAD_EXE_FORMAT`（"不是有效的 Win32 应用程序"），该机器 `tar.exe` 不可用。
- 该 Promise **无整体超时、无兜底**：子进程一旦既不 `error` 也不 `close`，Promise 永不 settle，
  `FeedbackDialog.tsx` 的 `setExporting(true)` 永不结束 → 「始终显示正在导出」。

### 根因 C：子进程 `error` 事件冒泡成假「启动失败」

- `src/main/index.ts` 与 `src/main/app/error-handlers.ts` 均把 `uncaughtException` 委托给
  `reportEarlyFatal()` → 弹「启动失败」+ `app.exit(1)`。
- `src/main/app/lifecycle.ts` 中 `exec('taskmgr')` 共 2 处未挂 `error` 监听；
  ChildProcess 无 `error` 监听时该事件冒泡为 `uncaughtException` → 一个可降级的子进程错误被升级为致命退出。
- 正确写法参照 `src/main/app/permission.ts`（已显式 `child.on('error')` 降级）。

---

## 2. 依赖声明

| 依赖              | 版本     | 类型            | 安装方式                         | 用途                                                                   |
| ----------------- | -------- | --------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `archiver`        | `^7.0.1` | dependencies    | `npm install archiver --save`    | 纯 JS 流式 zip 打包，替代外部 `tar.exe`；无原生模块，无需 `asarUnpack` |
| `@types/archiver` | `^6.0.3` | devDependencies | `npm install -D @types/archiver` | TS 类型（archiver 不自带 d.ts）                                        |

约束（本机 npm 有 Safe-Delete 网关，阈值 500）：

- **只能增量安装**：`npm install archiver --save` / `npm install -D @types/archiver`
- **禁止** `npm ci`、禁止删除 `node_modules`
- 安装后 `package.json` 与 `package-lock.json` 需一并提交
- 不新增其它依赖；不改动 `electron-builder` 的 `files`/`asarUnpack`（archiver 为纯 JS，默认随生产依赖入包）

---

## 3. 启动说明（环境准备 / 启动 / 验证）

### 环境准备

- Node >= 20（package.json `engines`），Windows x64
- `npm install`（工作区已有 `node_modules`，仅需增量安装 archiver）

### 验证命令（全部为仓库既存脚本，不新增）

```bash
# 单元：本次改动相关子集
npx vitest run src/main/utils/startup-diagnostic.test.ts
npx vitest run src/main/utils/early-crash-guard.test.ts
npx vitest run src/main/utils/zip-archive.test.ts
npx vitest run src/main/services/log-service.test.ts
npx vitest run src/main/app/__tests__/lifecycle.test.ts

# 全量回归（基线：279 文件 / 4722 用例全绿）
npm test

# 静态门禁
npm run typecheck     # tsc -b，基线 exit 0
npm run lint          # eslint .，基线 exit 0
npm run i18n:check    # 注意：正确脚本名是 i18n:check，不存在 check-i18n-keys
npm run sync-i18n-keys # 新增 i18n key 后补齐 12 份 locale
```

> 运行注意：PowerShell 管道直跑 vitest 会被 watch 探测吞输出，
> 需 `Start-Process cmd.exe "/c npx vitest run > .x.log 2>&1"` 后台跑后 `Select-String` 轮询。

### 手工冒烟（打包后）

1. 触发一次启动失败（`NIKKI_EARLY_CRASH_SIM=1`）→ 弹窗显示的日志路径下必须能找到 `startup-errors.log`。
2. 反馈 → 导出诊断包 → 选择保存位置 → 数秒内返回成功并生成非空 `.zip`；
   人为把目标设为非法路径时返回明确失败提示，**按钮不得长期停留在「正在导出」**。

---

## 4. 错误处理（异常分支 / 兜底 / 日志输出）

| 位置                                     | 异常分支                           | 处理                                                                                        |
| ---------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `startup-diagnostic.getStartupLogPath()` | `app.getPath('documents')` 抛错/空 | 吞掉，回落 homedir → tmpdir 候选链（`getUserFacingDiagDir` 既有语义）                       |
| `startup-diagnostic.logStartupError()`   | 任意 fs 失败                       | 外层 try/catch 静默，绝不因日志失败导致崩溃（保持既有行为）                                 |
| `early-crash-guard.reportEarlyFatal()`   | `logPath` 文件不存在               | 写 `os.tmpdir()/NikkiGallery-startup-errors.log` 应急文件并改展示该路径；仍失败则展示原路径 |
| `early-crash-guard.reportEarlyFatal()`   | 已开窗口 + 子进程 spawn 类错误     | 降级：`logStartupError` + 非致命弹框，**不退出**                                            |
| `zip-archive.createZipFromDirectory()`   | 源目录缺失 / 目标非法 / 父目录缺失 | 立即返回 `{ success: false, message }`，不创建子进程、不留半成品                            |
| `zip-archive.createZipFromDirectory()`   | archive/output `error` 事件        | `archive.abort()` + `output.destroy()`，返回失败                                            |
| `zip-archive.createZipFromDirectory()`   | 超过 `timeoutMs`（默认 60000）     | `archive.abort()` + `output.destroy()`，返回超时失败（**保证 settle**）                     |
| `zip-archive.createZipFromDirectory()`   | 产物为 0 字节 / 未生成             | 返回失败（`emptyArchive` / `targetNotGenerated`）                                           |
| `log-service.exportLogsAsZip()`          | 临时诊断目录构建失败               | 既有逻辑：回退打包 `logs` 目录                                                              |
| `log-service.exportLogsAsZip()`          | 打包结束（成功/失败/超时）         | `finally` 语义清理临时目录                                                                  |
| `lifecycle.exec('taskmgr')`              | spawn 失败                         | `child.on('error')` 记录到 `logStartupError('exec-taskmgr')`，不冒泡                        |

日志输出规范：`logStartupError` 在原有 `message + stack` 之外**追加一行 errno 摘要**
`[errno] code=… errno=… syscall=… path=… spawnargs=…`，使 `spawn EFTYPE` 能直接定位是哪个可执行文件失败。

---

## 5. 参数校验

### `createZipFromDirectory(sourceDir, targetPath, opts)`

| 入参                 | 类型                  | 必填 | 校验与边界                                                                         |
| -------------------- | --------------------- | ---- | ---------------------------------------------------------------------------------- |
| `sourceDir`          | `string`              | 是   | 非空、去空白后非空；`statSync` 成功且 `isDirectory()`；否则返回 `sourceMissing`    |
| `targetPath`         | `string`              | 是   | 非空、`path.isAbsolute()`；否则返回 `targetMissing`                                |
| `targetPath` 父目录  | 推导                  | 是   | 必须存在；否则返回 `targetParentMissing`                                           |
| `opts.timeoutMs`     | `number \| undefined` | 否   | 有限正数才生效（`>0` 且 `Number.isFinite`），`0/-1/NaN/undefined` 一律回落 `60000` |
| `opts.createArchive` | `() => Archiver`      | 否   | 仅测试注入；抛错时按 `writeFailed` 返回                                            |

返回值：`Promise<{ success: boolean; message: string }>`，**永远 resolve，不 reject**。

### `exportLogsAsZip(targetPath)`（既有校验保留）

- `targetPath` 非空、小写后必须以 `.zip` 结尾，否则返回 `main.logService.error.zipRequired`
- `targetPath` 其余合法性交由 `createZipFromDirectory` 校验

### `reportEarlyFatal(err, opts)`

- `err`：任意类型，`toMessage()` 兼容非 `Error`（既有行为）
- `opts.stage`：`string | undefined`，缺省 `'early-crash'`
- `opts.deps`：全量可选注入；`getDiagDir` 注入时跳过落盘存在性校验（测试专用 seam）

---

## 6. 基础测试用例（正常 / 异常 / 边界）

### 6.1 `src/main/utils/startup-diagnostic.test.ts`（新增用例）

- 正常：`getStartupLogPathValue()` 优先落在**文档**目录下的 `NikkiGallery/Diagnostics`（documents 可用时）
- 异常：`app.getPath('documents')` 抛错 → 回落 homedir 候选，仍匹配 `NikkiGallery/Diagnostics` 正则
- 边界：`logStartupError` 记录 `Error` 时，内容含 `[errno] code=... path=...`（errno 摘要）
- 边界：非 `Error`（数字/对象/null）不产生 `[errno]` 行，也不抛错

### 6.2 `src/main/utils/early-crash-guard.test.ts`（新增用例）

- 正常（核心回归）：不注入 `getDiagDir` 时，弹窗展示的日志路径 === `getStartupLogPathValue()`，且该路径文件存在
- 异常：落盘校验失败（模拟无写权限）→ 展示路径切换到 tmpdir 应急文件，且该文件存在
- 边界：已开窗口 + `spawn EFTYPE` 错误 → 只弹非致命框，**不调用 `exitApp`/`releaseLock`**
- 边界：未开窗口 + 同一错误 → 维持既有致命行为（弹「启动失败」+ 退出）

### 6.3 `src/main/utils/zip-archive.test.ts`（新建）

- 正常：临时目录含 2 个文件 → `success: true`，产物存在、非 0 字节、开头为 `PK`
- 异常：目标父目录不存在 → `success: false`，含明确原因
- 异常：注入 archive 触发 `error` 事件 → `success: false`，Promise 已 settle
- 边界：`timeoutMs: 50` + 注入永不结束 archive → 在 2s 内 settle 且 `success: false`
- 边界：`timeoutMs` 为 `0 / -1 / NaN` → 回落默认超时，仍能成功打包
- 边界：源目录为空 → 仍生成合法 zip（非 0 字节），`success: true`

### 6.4 `src/main/services/log-service.test.ts`（改造）

- 正常：日志目录含 `.log`/`.jsonl` → 导出成功，zip 存在且非 0 字节
- 正常：导出时复制启动日志走 `getStartupLogPathValue()`（断言该 getter 被调用）
- 异常：目标非 `.zip` → `success: false`
- 异常：目标父目录不存在 → `success: false`
- 边界：临时目录构建失败（logs 目录不可读）→ 回退打包 logs 目录仍成功

### 6.5 `src/main/app/__tests__/lifecycle.test.ts`（新增）

- 边界：`exec('taskmgr')` spawn 失败 → 错误被 `error` 监听记录，不冒泡为 `uncaughtException`

---

## 7. 子任务分解（文件 / 输入 / 输出 / 验收标准）

### T1 撰写本计划文件

- 修改文件：`docs/plans/2026-09-18-startup-log-and-export-fix.md`（新建）
- 输入：根因分析结论
- 输出：本 MD 文件
- 验收：文件存在，含依赖声明 / 启动说明 / 错误处理 / 参数校验 / 测试用例五节

### T2 红灯测试：弹窗路径必须等于真实落盘路径

- 修改文件：`src/main/utils/startup-diagnostic.test.ts`、`src/main/utils/early-crash-guard.test.ts`
- 输入：无（新增用例）
- 输出：新增失败用例
- 验收：运行 `npx vitest run src/main/utils/startup-diagnostic.test.ts src/main/utils/early-crash-guard.test.ts`
  **出现红灯**（证明缺陷存在），且失败原因明确为"路径不一致"

### T3 统一诊断日志路径单一真相源

- 修改文件：
  - `src/main/utils/startup-diagnostic.ts`（写入端注入 documents 候选）
  - `src/main/utils/early-crash-guard.ts`（展示端默认取 `getStartupLogPathValue()`）
  - `src/main/app/lifecycle.ts`（fatal catch 路径统一）
  - `src/main/services/log-service.ts`（导出复制路径统一）
- 输入：无
- 输出：四处口径全部指向 `getStartupLogPathValue()`
- 验收：T2 红灯转绿；`npx vitest run src/main/utils/startup-diagnostic.test.ts src/main/utils/early-crash-guard.test.ts src/main/services/log-service.test.ts` 全绿

### T4 日志内容富化 + 应急兜底

- 修改文件：`src/main/utils/startup-diagnostic.ts`、`src/main/utils/early-crash-guard.ts`
- 输入：`Error` 携带 `code/syscall/path/spawnargs`
- 输出：日志追加 `[errno] …` 行；落盘校验失败时写 tmpdir 应急文件并改展示路径
- 验收：`src/main/utils/startup-diagnostic.test.ts` 与 `early-crash-guard.test.ts` 新增用例转绿

### T5 新增 `zip-archive.ts` + 安装 archiver

- 修改文件：`package.json`、`package-lock.json`、新建 `src/main/utils/zip-archive.ts`、`src/main/utils/zip-archive.test.ts`
- 输入：`sourceDir` / `targetPath` / `opts`
- 输出：`{ success, message }`，永远 resolve
- 验收：`npx vitest run src/main/utils/zip-archive.test.ts` 全绿（含超时用例在 2s 内 settle）

### T6 导出改造：移除 tar.exe

- 修改文件：`src/main/services/log-service.ts`、`src/main/services/log-service.test.ts`
- 输入：保存对话框返回的目标 zip 路径
- 输出：进程内打包结果；UI 必然离开"正在导出"
- 验收：`npx vitest run src/main/services/log-service.test.ts` 全绿；源码中不再出现 `spawn('tar.exe'`

### T7 子进程 error 加固

- 修改文件：`src/main/app/lifecycle.ts`、`src/main/utils/early-crash-guard.ts`、`src/main/app/__tests__/lifecycle.test.ts`
- 输入：`exec('taskmgr')` 的失败事件 / `reportEarlyFatal` 的 spawn 类错误
- 输出：错误被记录，不冒泡；已开窗口时不致命退出
- 验收：`npx vitest run src/main/app/__tests__/lifecycle.test.ts src/main/utils/early-crash-guard.test.ts` 全绿

### T8 全量回归与门禁

- 修改文件：无（仅运行校验，必要时修 i18n locale 文件）
- 验收（全部必须满足）：
  - `npm test` 全绿，且用例数不低于基线 4722（新增用例后应更高）
  - `npm run typecheck` exit 0
  - `npm run lint` exit 0
  - `npm run sync-i18n-keys` + `npm run i18n:check` 通过

---

## 8. 实施结果（2026-09-18 执行完成）

| 节点                     | 红灯证据                                                                                                    | 绿灯结果                                                                                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T2/T3 路径同源           | 6 失败：`expected 'C:\Users\45001\NikkiGallery\Diagnostics…' to be '…\documents\…'`（写盘侧未走 documents） | `startup-diagnostic.test.ts` + `early-crash-guard.test.ts` 38 passed                                                                                                                                                                               |
| T4 errno 摘要 + 应急兜底 | `expected … to contain '[errno]'`                                                                           | 同上 38 passed                                                                                                                                                                                                                                     |
| T5 zip-archive           | `Failed to load url ./zip-archive`（模块不存在）→ 实现后再跑                                                | `zip-archive.test.ts` 11 passed                                                                                                                                                                                                                    |
| T6 导出改造              | 7 失败（依赖 tar.exe 的子进程打包，无法产出真实 zip）                                                       | `log-service.test.ts` 40 passed                                                                                                                                                                                                                    |
| T7 子进程加固            | 新增用例断言 `exec('taskmgr')` 必须挂 error 监听                                                            | `lifecycle.test.ts` 38 passed                                                                                                                                                                                                                      |
| T8 全量回归              | —                                                                                                           | `npx vitest run` **283 文件 / 4753 用例全部通过**（基线 279/4722）；`npm run typecheck` exit 0；`npm run lint` exit 0；`npm run sync-i18n-keys` + `npm run i18n:check` 通过；`npx electron-vite build` 成功且产物中 `require("archiver")` 已外部化 |

### 实施过程中的两个关键偏差（已记录）

1. **`require('electron')` 在 Vitest 中取不到 `vi.mock`**（ESM mock 注册表不覆盖 CJS `require`）。
   原计划"在 startup-diagnostic 内部惰性 require electron 取 documents"不可测，
   改为在叶子模块 `user-diag-path.ts` 增加 `setDocumentsPathProvider()`，
   由 `src/main/index.ts` 注册 `app.getPath('documents')`，测试侧注入临时目录。
2. **`archiver@8` 是 ESM-only 且无默认导出**（`require('archiver')` 返回对象而非函数），
   主进程为 CJS 产物不可用 → 实际安装 **`archiver@^7.0.1` + `@types/archiver@^6.0.4`**。

### 环境注意事项

- `npm install archiver` 会重解 electron 包且受 allow-scripts 网关限制不跑 postinstall，
  导致 `node_modules/electron` 丢失 `dist/` 与 `path.txt`，41 个测试套件报
  "Electron failed to install correctly"。修复：`node node_modules/electron/install.js`
  （走本地 `%LOCALAPPDATA%\electron\Cache` 离线恢复）。后续任何 `npm install` 后需确认该状态。

### 2026-09-25 复核（提交前）

- 全量 diff 审查：改动集合与 T1–T8 一致，无调试残留、无越权重构；12 份 locale key 程序化比对一致；lock 变动仅为 archiver 依赖子树与 6 处 `dev` 标志翻转。
- 验证：相关子集 5 文件 / 127 用例全绿；`npm test` 283 文件 / 4753 用例全绿；`typecheck` / `lint` / `i18n:check` 均 exit 0。复核通过，随本次提交入库。

## 9. 不做的事

- 不重构诊断目录体系以外的模块
- 不改动 IPC 通道名、preload 契约（`docs/IPC_CONTRACT.md` 无需更新）
- 不改 `FeedbackDialog.tsx`（主进程修复后失败态即可正常呈现）
- 不新增与本次问题无关的测试、不调整无关 UI 文案
