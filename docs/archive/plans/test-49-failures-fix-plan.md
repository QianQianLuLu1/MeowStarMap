# NikkiGallery 全量测试 49 失败排查与修复计划

> 审查对象：`wxnn-photo-manager` v2.3.5（Electron 40 + React 19 + TypeScript 5.9 + Vitest 1.6.1）
> 基线：`npm test` = 150 文件 / 3172 用例，**49 失败（13 文件）**
> 审查日期：2026-08-14
> 审查方法：逐文件独立运行 `npx vitest run <file>` 捕获真实报错 → 读被测实现与 mock → 分类根因 → 对代表性文件实测修复验证（scene-brightness 已通过打补丁验证修复路径可行）

---

## ⚠️ 关键结论：既有文档对失败根因的定性是错的

[项目全量审查与轻量化优化方案.md](../项目全量审查与轻量化优化方案.md) §5 曾把 49 失败全部定性为：

> "均为 TRAE 沙箱禁止写 `D:\tmp\test-userdata` 的环境性失败"

**本次逐文件复核证伪该结论。** 沙箱禁止写日志只是部分用例的 `stderr` 噪音（`electron-log` 写文件失败），**不是**这些用例失败的原因；真正失败都发生在**断言/模块加载**阶段，与沙箱无关。13 个失败文件可归为 **8 类独立根因**，其中绝大多数是**测试 mock 与实现漂移**（测试没跟上实现），少数是**实现 bug**。若按旧文档"不改代码"处理，这 49 失败会一直存在。

**结论优先级**：先修这 49 个真实失败（P0），再做冗余删改（P1）。

---

## 1. 审查概述

### 1.1 总体结论

- **49 个失败全部可复现、可定位、可修复**，分布在 13 个测试文件，无随机性。
- **根因高度集中在"测试环境与实现脱节"**：`src/main/utils/logger.ts` 顶层 `import { app } from 'electron'` 并在 `initLogger()`/`writeLog()` 中调用 `app.getPath('userData')`（[logger.ts:133](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/utils/logger.ts#L133)）。任何未 mock `logger` 又未在 electron mock 中提供 `app.getPath` 的测试，一旦被测代码触发日志即抛 `No "app" export` / `Cannot read properties of undefined (reading 'getPath')`。**这一条蔓延了 30 个失败（61%）**。
- 其余失败为：mock 窗口缺 `isDestroyed`（3）、漏 mock 第 30 个 handler（4）、validator mock 缺 `pathGuard`（5）、断言过时（2）、实现/日志漂移（2）、网络地址 mock 失效（1）、`fs.existsSync` 未 mock（2）。
- **无生产逻辑缺陷引发的"功能 bug"**（除 watermark applyBatch 需复核外），全部是测试侧修复或轻量实现对齐。

### 1.2 失败分布一览（13 文件 / 49 用例）

| #   | 测试文件                                        | 失败数 | 根因类别 | 一句话根因                                                                                                           |
| --- | ----------------------------------------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | `main/app/__tests__/media-protocol.test.ts`     | 17     | **A**    | electron mock 只给了 `protocol`，缺 `app`；`logger.error` → `app.getPath` 抛 "No app export"                         |
| 2   | `main/services/thumbnail-phash-service.test.ts` | 8      | **A**    | 未 mock logger，`app` 在 node 环境为 undefined → "Cannot read getPath"                                               |
| 3   | `main/utils/scene-brightness.test.ts`           | 3      | **A**    | 同上（`analyzeSceneBrightness` 走 `logger.warn`）                                                                    |
| 4   | `main/services/file-service.test.ts`            | 1      | **A**    | electron mock 缺 `app`，`getExif` 走 `logger.error`                                                                  |
| 5   | `main/ipc/handlers/decrypt-handler.test.ts`     | 1      | **A**    | 未 mock logger，UID 回退路径走 `logger.warn`                                                                         |
| 6   | `main/app/__tests__/ipc-setup.test.ts`          | 4      | **C**    | 漏 mock `registerExportPrefHandlers`（第 30 个 handler），真实实现 `ipcMain.handle` 时 `ipcMain` 为 undefined        |
| 7   | `main/app/__tests__/ipc-setup.test.ts`          | 1      | **B**    | mock 的 `webContents` 缺 `isDestroyed`                                                                               |
| 8   | `main/app/__tests__/theme.test.ts`              | 2      | **B**    | mock 的 `mainWindow` 缺 `isDestroyed`                                                                                |
| 9   | `main/ipc/handlers/import-handler.test.ts`      | 5      | **D**    | `vi.mock('../validator')` 工厂缺 `pathGuard` 导出，handler 调 `pathGuard.register` 抛错                              |
| 10  | `main/renderer/stores/mediaStore.test.ts`       | 2      | **E**    | 断言过时：实现已硬编码 `galleryHighQualityOnly=false`，测试仍期望 `true`                                             |
| 11  | `main/app/__tests__/custom-dirs.test.ts`        | 1      | **F**    | 实现用 `logger.info` 打"迁移"日志，测试 spy `console.log` 断言不中                                                   |
| 12  | `main/services/watermark-service.test.ts`       | 1      | **F**    | `applyBatch` 单文件 `sharp.metadata` 抛错后整体返回 `success=false`（需确认是隔离逻辑 bug 还是 mock 触发外层 catch） |
| 13  | `main/services/share-wifi-service.test.ts`      | 1      | **G**    | 期望 URL 含 mock 的 `192.168.1.100`，实得真实网卡 `192.168.1.249`（network-address mock 失效）                       |
| 14  | `main/utils/ffmpeg-paths.test.ts`               | 2      | **H**    | 实现新增 `fs.existsSync` 校验，测试未 mock `fs`，假路径不存在 → 回退 `'ffmpeg'`                                      |

合计：17+8+3+1+1+4+1+2+5+2+1+1+1+2 = **49**。

---

## 2. 分维度问题 + 优化 / 删改方案

> 本计划遵循两条红线（对齐用户规则）：
>
> 1. **每一步先验证通过再进下一步**——每个子任务都有明确验收命令与口径，失败即停，就地修复。
> 2. **删改不降健壮性**——所有改动以"测试反映实现意图"为准，不臆造生产行为；对实现的改动仅限确凿的 bug。

### 2.0 全局通用说明（每个子任务都遵守）

- **依赖声明**：改的都是测试文件 / 少量实现，**不新增任何 npm 依赖**；仅依赖项目既有 `vitest`、`vi.mock`、既有 mock 模式（`_test-helpers.ts`、各处 `vi.mock('../../utils/logger')` 范式）。
- **启动 / 验证命令**：
  - 单文件：`npx vitest run <file>`
  - 全量：`npm test`（150 文件 / 3172 用例）
  - 类型：`npm run typecheck`
- **错误处理原则**：测试修复定位的是"mock 是否提供了被测代码实际调用的导出"。修复后若仍报错，先读报错指向的实现行，确认是 mock 缺导出还是实现行为变化，不盲目加 mock。
- **参数校验**：涉及 handler 的测试（import/decrypt）用 `_test-helpers.ts` 的 `createSchemasMock()` 提供真实 zod schema，保证 zod 校验路径不被 mock 掉；修改时保持该约定。
- **基础测试用例**：每个失败用例本身就是"回归测试"，修复后该文件全部 `it` 通过即为验收。

---

### 2.1 类别 A：logger 触发 `electron.app.getPath` 崩溃（30 失败，5 文件）

**根因**：`logger.ts` 顶层 `import { app } from 'electron'`，在 `initLogger()`（[logger.ts:133](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/utils/logger.ts#L133)）调用 `app.getPath('userData')`。测试在 node 环境无 electron 运行时：

- 若测试 mock 了 electron 但**没给 `app`** → vitest 抛 `No "app" export is defined on the "electron" mock`（media-protocol、file-service）。
- 若测试**完全没 mock electron** → `app` 为 `undefined` → 抛 `Cannot read properties of undefined (reading 'getPath')`（thumbnail-phash、scene-brightness、decrypt-handler）。

**修复策略（统一）**：按项目既有模式，在受影响的测试文件里 `vi.mock` logger，彻底切断 `electron.app` 依赖。**该修复已在 scene-brightness.test.ts 实测验证：补 `vi.mock('./logger')` 后 23/23 全绿**（验证后已还原，等待按本计划执行）。

**逐文件删改方案**：

<details>
<summary>2.1.1 scene-brightness.test.ts（3 失败）— 已实测验证</summary>

- **修改文件**：[scene-brightness.test.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/utils/scene-brightness.test.ts)
- **输入**：在 `vi.mock('sharp', ...)` 之后、`import { analyzeSceneBrightness }` 之前插入：
  ```ts
  // 被测模块经 logger 写日志会触发 electron.app.getPath，测试环境无 electron 运行时，
  // mock logger 隔离 electron 依赖（与项目其他主进程测试的既有模式一致）
  vi.mock('./logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    logFault: vi.fn(),
    getLogDirectory: vi.fn(() => '/mock/logs')
  }))
  ```
- **输出**：`scene-brightness.test.ts` 23 个用例全部通过。
- **验收**：`npx vitest run src/main/utils/scene-brightness.test.ts` → `Tests 23 passed`。
- **注意**：mock 路径必须是 `./logger`（被测实现 [scene-brightness.ts:8](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/utils/scene-brightness.ts#L8) 是 `import { logger } from './logger'`），不能写成 `../../utils/logger`。

</details>

<details>
<summary>2.1.2 thumbnail-phash-service.test.ts（8 失败）</summary>

- **修改文件**：[thumbnail-phash-service.test.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/services/thumbnail-phash-service.test.ts)
- **输入**：插入 `vi.mock('../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, logFault: vi.fn(), getLogDirectory: vi.fn(() => '/mock/logs') }))`（被测实现 [thumbnail-phash-service.ts:6](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/services/thumbnail-phash-service.ts#L6) 为 `import { logger } from '../utils/logger'`）。
- **输出**：8 个原本在 `runBatch`/`processThumbnailForRow` 内 `logger.error/info` 处崩溃的用例转绿；其余 23 个保持通过。
- **验收**：`npx vitest run src/main/services/thumbnail-phash-service.test.ts` → 31 全过。

</details>

<details>
<summary>2.1.3 file-service.test.ts（1 失败）</summary>

- **修改文件**：[file-service.test.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/services/file-service.test.ts)
- **输入**：插入 `vi.mock('../utils/logger', ...)`（实现 [file-service.ts:14](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/services/file-service.ts#L14) 为 `import { logger } from '../utils/logger'`）。若该文件已有 electron mock，也可在 electron mock 工厂补 `app: { getPath: vi.fn(() => '/mock/userData') }`；二选一，推荐 mock logger 以统一。
- **输出**：`getExif` 用例通过。
- **验收**：`npx vitest run src/main/services/file-service.test.ts` → 46 全过。

</details>

<details>
<summary>2.1.4 media-protocol.test.ts（17 失败）</summary>

- **修改文件**：[media-protocol.test.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/__tests__/media-protocol.test.ts)
- **输入**：该文件已 mock electron（[第 23-28 行](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/__tests__/media-protocol.test.ts#L23-L28)只给了 `protocol`）。在 mock 工厂内补 `app`：
  ```ts
  vi.mock('electron', () => ({
    protocol: { unhandle: protocolUnhandleMock, handle: protocolHandleMock },
    app: { getPath: vi.fn(() => '/mock/userData'), getVersion: vi.fn(() => 'test') }
  }))
  ```
- **输出**：17 个协议分支用例（400/403/404/200/206/416/Range/LRU）不再因 logger 崩溃。
- **验收**：`npx vitest run src/main/app/__tests__/media-protocol.test.ts` → 19 全过。

</details>

<details>
<summary>2.1.5 decrypt-handler.test.ts（1 失败）</summary>

- **修改文件**：[decrypt-handler.test.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/ipc/handlers/decrypt-handler.test.ts)
- **输入**：该测试未 mock logger，失败用例 `['/f','a']`（uid 缺省）触发 `resolveUidFromProfiles`/`getAllKnownUids` 的 `logger.warn`。插入 `vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, logFault: vi.fn(), getLogDirectory: vi.fn(() => '/mock/logs') }))`（与 import-handler.test.ts 的既有 logger mock 一致）。
- **输出**：`decrypt:decodeFile 返回 error 时 ok=false` 用例通过。
- **验收**：`npx vitest run src/main/ipc/handlers/decrypt-handler.test.ts` → 7 全过。

</details>

---

### 2.2 类别 B：mock 窗口 / webContents 缺 `isDestroyed`（3 失败，2 文件）

**根因**：`renderer-bridge.ts` 的 `sendToRenderer` 逐级调用 `win.isDestroyed()` / `wc.isDestroyed()`（[renderer-bridge.ts:13,15](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/renderer-bridge.ts#L13-L15)）。测试提供的 mock 窗口对象只有 `{ webContents: { send } }`，缺 `isDestroyed` → 抛 `win.isDestroyed is not a function`。

**修复**：给 mock window / webContents 补 `isDestroyed: () => false`。

- [theme.test.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/__tests__/theme.test.ts)：第 152、161 行的 `{ webContents: { send } }` 改为 `{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }`。
- [ipc-setup.test.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/__tests__/ipc-setup.test.ts)：`bindScanProgressListener` 用例的 mock `webContents` 补 `isDestroyed`。
- **验收**：`npx vitest run src/main/app/__tests__/theme.test.ts` → 10 全过；ipc-setup 该用例转绿。

---

### 2.3 类别 C：ipc-setup 漏 mock 第 30 个 handler（4 失败）

**根因**：`ipc-setup.ts` 调用了 `registerExportPrefHandlers(ctx)`（[ipc-setup.ts:82](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/ipc-setup.ts#L82)），但 `ipc-setup.test.ts` 的 `handlerMocks`（[第 16-51 行](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/__tests__/ipc-setup.test.ts#L16-L51)）只 mock 了 29 个 registerXxxHandlers + `initUserDataDir` + `refreshPathGuardRoots`，**漏了 `registerExportPrefHandlers`**。于是真实 `export-pref-handler.ts` 在 `setupIPC` 中被执行，且该测试无 electron mock → `ipcMain` 为 undefined → `ipcMain.handle(...)` 抛 `Cannot read properties of undefined (reading 'handle')`。

**修复**（对齐测试自身"调用所有 registerXxxHandlers"的意图）：

1. 在 `handlerMocks` 增加 `registerExportPrefHandlers: vi.fn()`。
2. 补 `vi.mock('../../ipc/handlers/export-pref-handler', () => ({ registerExportPrefHandlers: handlerMocks.registerExportPrefHandlers }))`。
3. 在"调用所有 29 个"的断言处把计数/断言补上 `registerExportPrefHandlers`（并同步更新注释/计数为 30）。

- **验收**：`npx vitest run src/main/app/__tests__/ipc-setup.test.ts` → 15 全过。

---

### 2.4 类别 D：import-handler validator mock 缺 `pathGuard`（5 失败）

**根因**：`import-handler.ts` 从 `../validator` 导入 `pathGuard` 并调用 `pathGuard.register(...)`（[import-handler.ts:35,50,53](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/ipc/handlers/import-handler.ts#L35)）。`import-handler.test.ts` 的 `vi.mock('../validator')` 工厂（[第 28-52 行](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/ipc/handlers/import-handler.test.ts#L28-L52)）未导出 `pathGuard` → 访问 `pathGuard.register` 抛 `No "pathGuard" export is defined on the "../validator" mock`。

**修复**：在 mock 工厂对象里补 `pathGuard: { register: vi.fn(), setRootMediaDir: vi.fn() }`（`validator.ts` 实际导出 `pathGuard = new PathGuard()`，[validator.ts:261](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/ipc/validator.ts#L261)）。

- **验收**：`npx vitest run src/main/ipc/handlers/import-handler.test.ts` → 8 全过（含既有 3 个通过用例）。

---

### 2.5 类别 E：断言过时（2 失败，mediaStore）

**根因**：[mediaStore.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/renderer/stores/mediaStore.ts#L294-L296) 已**有意**硬编码 `const galleryHighQualityOnly = false`（注释明确"图库板块不再限制为 NikkiPhotos_HighQuality 目录，展示用户扫描到的所有路径下的图片"），`fetchMediaFromDatabase` 与 `loadMoreMedia` 均如此。但 `mediaStore.test.ts` 仍断言 gallery 视图传 `galleryHighQualityOnly: true`。

**修复**：**改测试不改实现**（实现注释即产品决策，测试是过时断言）。

- 第 452-460 行"图库视图调用 list 时传 galleryHighQualityOnly: true" → 改为断言 `false`（并更新用例名/注释）。
- 第 494-501 行同改。
- **验收**：`npx vitest run src/renderer/stores/mediaStore.test.ts` → 全过。

---

### 2.6 类别 F：日志 / 批处理漂移（2 失败）

**2.6.1 custom-dirs.test.ts（1 失败）**

- **根因**：实现 `custom-dirs.ts:91` 用 `logger.info(\`[Dir] 迁移...\`)`打迁移日志，测试`custom-dirs.test.ts:155`却 spy`console.log`并断言字符串含"迁移"。logger 未 mock 时不会写 console → 断言`some(...)` 为 false。
- **修复**：改测试——mock `../../utils/logger` 的 `logger.info`，断言 `loggerInfoMock` 被以含"迁移"的参数调用；或保留 spy 但断言对象改为 logger mock。**推荐前者**（对齐项目 logger 用法）。
- **验收**：`npx vitest run src/main/app/__tests__/custom-dirs.test.ts` → 12 全过。

**2.6.2 watermark-service.test.ts（1 失败）**

- **根因**：`applyBatch`（[watermark-service.ts:14-104](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/services/watermark-service.ts#L14)）期望"单个文件 sharp.metadata 抛错不影响其他文件"，但实测返回 `{ success: false }`。需复核：若是外层 catch（[watermark-service.ts:106](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/services/watermark-service.ts#L106)）把单文件错误吞成整体失败，则为**实现 bug**，应在单文件循环内 try/catch 隔离（`processed` 计成功数），外层只兜非业务异常；若测试 mock 的 `sharp.metadata` 抛的错类型/时机不在单文件隔离分支内，则修测试 mock。
- **动作**：先读 `applyBatch` 单文件循环的分支，运行该用例确认错误落在外层 catch 还是内层——**据此决定改实现还是改测试**。默认按"实现应满足测试语义（单文件失败不影响整体）"处理，即在单文件循环内加 try/catch，保证 `success` 恒为 true、`processed` 计成功数。
- **验收**：`npx vitest run src/main/services/watermark-service.test.ts` → 45 全过。

---

### 2.7 类别 G：share-wifi 网络地址 mock 失效（1 失败）

- **根因**：测试期望 `session.url` 含 `192.168.1.100`，实得真实网卡 `http://192.168.1.249:54321/`。说明测试对"局域网地址获取"的 mock 未生效（`network-address` 或地址解析模块未被 `vi.mock`，或 mock 路径/导出与实现不符）。
- **修复**：读 `share-wifi-service.ts` 获取地址的调用点，`vi.mock` 对应模块并返回 `192.168.1.100`；若实现直接读 `os.networkInterfaces()`，则 mock 该模块或在测试中 stub。
- **验收**：`npx vitest run src/main/services/share-wifi-service.test.ts` → 5 全过。

---

### 2.8 类别 H：ffmpeg-paths `fs.existsSync` 未 mock（2 失败）

- **根因**：`resolveBinaryPath`（[ffmpeg-paths.ts:32-36](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/utils/ffmpeg-paths.ts#L32-L36)）用 `fs.existsSync(resolved)` 校验二进制真实落盘，为健壮性要求。测试 mock 的假路径 `/fake/app.asar.unpacked/ffmpeg.exe` 在磁盘上不存在 → `existsSync` 返回 false → 回退 `'ffmpeg'`，与断言 `/fake/...` 不符。
- **修复**：改测试——mock `fs` 的 `existsSync` 对假路径返回 `true`（对通用路径返回 false），或把假路径改为条件 `vi.mock('fs', () => ({ default: { existsSync: (p) => p.includes('/fake/') }, existsSync: (p) => p.includes('/fake/') }))`。注意 ffmpeg-paths 用 `vi.resetModules()` + 动态 `import()`，mock 需在顶层 `vi.mock('fs')` 声明。
- **验收**：`npx vitest run src/main/utils/ffmpeg-paths.test.ts` → 13 全过。

---

### 2.9 全链路冗余识别（与修复同步做的删改评估）

> 说明：既有文档 §5/§6 已完成 `safe-execute.ts`、`common/utils`、`scene-category.ts` 桥接、`dev:ev`、`tsconfig.phase3-check.json`、3 个 `.ps1` 归档等冗余删除。本次新增发现的冗余集中在**测试侧的重复性修补**，属"防复发"而非"删功能"：

| 冗余点                                                | 证据                                                                                                       | 建议                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **logger 的 electron.app 依赖在 5+ 测试文件重复修补** | media-protocol / thumbnail-phash / scene-brightness / file-service / decrypt-handler 都要为同一根因补 mock | 在 `tests/setup.ts` 或 `_test-helpers.ts` 提供统一 `mockLogger()` 工厂，新测试一行引入，杜绝每次从报错反查 mock 路径             |
| **`vi.mock('electron')` 各文件碎片化**                | 每个 app 测试各自手写 electron mock，`app.getPath` 时缺时全缺                                              | 沉淀一个共享 `electronMock` 辅助（含 `app.getPath/getVersion`、`ipcMain.handle/on`、`protocol`），统一缺失项                     |
| **既有文档误诊**                                      | 把 49 失败归为环境性，导致长期未修                                                                         | 本计划修复后，在文档 §5 附录补"真实根因更正"记录，避免后续误读基线                                                               |
| **`registerXxxHandlers` mock 清单与实现漂移**         | ipc-setup 漏第 30 个 handler                                                                               | 为 ipc-setup 的 handler mock 清单加注释来源（`ipc-setup.ts:74-104` 实际调用列表），并考虑用循环/数据驱动生成 mock 断言，避免再漏 |

---

## 3. 实施优先级排期

> 原则：**类别 A（30 失败，占比 61%）优先**，且修复手法统一、已验证；随后按"单文件修复成本低、收益明确"推进。每阶段结束跑一次全量 `npm test` 记录基线，只增绿不增红。

| 阶段     | 事项                                                             | 涉及文件                                                                                              | 风险                            | 验收（每步）                                                            |
| -------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| **P0-1** | 类别 A：补 logger mock / electron `app`                          | scene-brightness、thumbnail-phash、file-service、media-protocol、decrypt-handler 共 5 文件（30 失败） | 低（纯测试 mock，已验证路径）   | 逐文件 `npx vitest run <file>` 全绿；随后 `npm test` 失败数 49 → **19** |
| **P0-2** | 类别 B + C：mock `isDestroyed` + 补 `registerExportPrefHandlers` | theme、ipc-setup 共 2 文件（7 失败）                                                                  | 低                              | ipc-setup、theme 全绿；`npm test` 失败数 → **12**                       |
| **P0-3** | 类别 D：validator mock 补 `pathGuard`                            | import-handler（5 失败）                                                                              | 低                              | import-handler 全绿；`npm test` → **7**                                 |
| **P0-4** | 类别 E：更新 mediaStore 过时断言                                 | mediaStore（2 失败）                                                                                  | 低                              | mediaStore 全绿；`npm test` → **5**                                     |
| **P0-5** | 类别 F/G/H：custom-dirs、watermark、share-wifi、ffmpeg-paths     | 4 文件（5 失败）                                                                                      | 中（watermark 需判断实现/测试） | 逐文件全绿；`npm test` → **0**                                          |
| **P1-1** | 冗余防复发：统一 logger mock 工厂 / electron mock 辅助           | `tests/setup.ts` 或 `_test-helpers.ts`（新增，可选）                                                  | 低                              | 全量 `npm test` 仍 0 失败；`npm run typecheck` 通过                     |
| **P1-2** | 更正既有文档误诊记录                                             | `docs/项目全量审查与轻量化优化方案.md` §5                                                             | 无（纯文档）                    | 人工审阅                                                                |

**门禁**：每个子任务完成后，必须 `npm run typecheck` + 对应文件 `npx vitest run <file>` 通过，才进入下一步；任何一步出现新的失败，就地修复后再继续。

---

## 4. 收益预期

| 指标           | 预期                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **测试健康度** | 全量失败 49 → **0**，13 个失败文件全部转绿；`npm test` 从"一半红"回到"全绿基线"                                                                |
| **可信度**     | 纠正既有文档"全环境性失败"的误诊；CI（`.github/workflows/build.yml` 若含 test 步骤）不再被假阴性掩盖真实回归                                   |
| **回归护栏**   | 修复的 49 用例重新成为有效回归测试，能捕获"logger/app 依赖回归""handler 清单漂移""webContents mock 缺方法"等类型的后续破坏                     |
| **防复发**     | P1 引入统一 logger mock 工厂 / electron mock 辅助，将"5 文件重复修补同一根因"收敛为一行引入，降低后续维护成本                                  |
| **健壮性**     | 除 watermark `applyBatch` 可能需 1 处实现隔离修复外，其余均为测试侧改动，**零生产逻辑改动**（或仅在 watermark 做最小隔离），不降低运行时健壮性 |
| **删改量**     | 无功能删减；冗余治理集中在测试辅助层（新增共享 mock 帮助函数），删除的是"重复的手写 mock 修补"                                                 |

---

## 附：每个子任务统一验收模板（执行时逐项打勾）

- [x] 依赖：无新增 npm 依赖（仅用 vitest 既有能力）
- [x] 启动/验证命令：单文件 `npx vitest run <file>`；阶段末 `npm test`；改动后 `npm run typecheck`
- [x] 错误处理：mock 必须覆盖被测代码实际调用的导出；报错先读实现行定位，不盲目加 mock
- [x] 参数校验：handler 测试沿用 `createSchemasMock()` 真实 zod schema，不 mock 掉校验
- [x] 基础测试用例：该文件全部 `it` 通过即验收；不新增无关用例
- [x] 每步验证通过后再进入下一步，失败就地修复

---

## 执行进度记录（2026-08-14）

> 结论：**49 失败已全部修复**。全量 `npm test` = 150 文件 / 3172 用例 **全部通过（0 失败）**，`npm run typecheck` 通过。全程未新增任何 npm 依赖，无生产逻辑改动。

| 阶段                               | 结果    | 单文件验收                                                                                          | 与计划差异                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 类别 A（5 文件 / 30 失败）    | ✅ 完成 | scene-brightness 23、thumbnail-phash 31、file-service 46、media-protocol 19、decrypt-handler 7 全绿 | media-protocol 根因不止缺 `app`：该文件 mock 的 `fs` 缺 `realpath`，实现 `resolveRealPath`（media-protocol.ts:330）调用后一律返回 null → 404。改为统一 mock logger（计划 §2.1 统一策略）+ fs mock 补 `realpath`                                                                                                                                                               |
| P0-1 内 thumbnail-phash            | ✅ 完成 | 31 全绿                                                                                             | 计划归为纯类别 A（8 失败），实际 logger mock 后仍有 5 个"断言漂移"：实现用 `logger.error`，测试 spy `console.error`。已把 5 个用例改为断言 logger mock                                                                                                                                                                                                                        |
| P0-2 类别 B+C（2 文件 / 7 失败）   | ✅ 完成 | theme 10、ipc-setup 15 全绿                                                                         | 与计划一致                                                                                                                                                                                                                                                                                                                                                                    |
| P0-3 类别 D（1 文件）              | ✅ 完成 | import-handler 7 全绿                                                                               | 该文件实际 7 个用例（计划写 8），全部通过                                                                                                                                                                                                                                                                                                                                     |
| P0-4 类别 E（2 失败）              | ✅ 完成 | mediaStore 40 全绿                                                                                  | 与计划一致（改测试不改实现）                                                                                                                                                                                                                                                                                                                                                  |
| P0-5 类别 F/G/H（4 文件 / 5 失败） | ✅ 完成 | custom-dirs 12、watermark 45、share-wifi 5、ffmpeg-paths 13 全绿                                    | ① watermark：经复核**非实现 bug**——单文件 try/catch 隔离正确，是缺 logger mock 导致 `logger.error` 崩溃逃逸到外层 catch 返回 `success=false`；补 logger mock + 改 console.error 断言。② share-wifi：`vi.mock('network-address')` 无法拦截源码内 `require()`（CJS 不走 Vite 模块图，连 `server.deps.inline` 都无效）；改在测试文件内拦截 `Module._load` + 动态 import 被测模块 |

### 与计划的结论性差异（供后续维护参考）

1. **media-protocol** 的真实失败链是：真实 logger 顶层 `import { app } from 'electron'` → "No app export"（模块加载失败）→ 修复后暴露第二层：fs mock 缺 `realpath`。计划 §2.1.4 的"补 `app`"不足以修复，最终按统一策略 mock logger 解决。
2. **thumbnail-phash / watermark** 各有 5 / 1 个用例是"实现已从 `console.error` 迁到 `logger.error`、测试断言未跟上"的漂移，非纯环境性问题。已把断言对齐到 logger mock。
3. **share-wifi** 的 `network-address` 是源码内 `require()` 加载，`vi.mock` 不生效；采用 `Module._load` 拦截（仅测试 fork 内生效，且该模块仅此处使用，无副作用）。
4. **watermark 无实现 bug**：`applyBatch` 单文件循环内 try/catch 隔离是正确设计，`success` 恒为 true、`processed` 计成功数，与测试语义一致。

### 遗留（可选，未纳入本次执行）

- **P1-1** 冗余防复发：`tests/setup.ts` 或 `_test-helpers.ts` 沉淀统一 `mockLogger()` 工厂 / electron mock 辅助（5+ 文件同一根因重复修补的收敛）。
- **P1-2** 更正 `docs/项目全量审查与轻量化优化方案.md` §5 的"全部为环境性失败"误诊记录。
