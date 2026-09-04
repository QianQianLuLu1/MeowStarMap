# 清空回收站报错 —— 诊断与修复计划

- **报告日期**：2026-08-18
- **受影响版本**：v2.3.5（打包版，`H:\WXNN  XC\wxnn-photo-manager\resources\app.asar`）
- **运行环境**：Electron 40.10.6 / Node 24.15.0 / win32 10.0.26200
- **日志来源**：`C:\Users\<username>\AppData\Roaming\wxnn-photo-manager\logs`（主证据文件 `main.old.log`）
- **故障时刻**：2026-08-18 10:06:27 ~ 10:06:45

---

## 1. 问题现象

用户在「回收站 → 清空回收站」操作后收到报错，回收站条目并未被清空。

## 2. 日志实证分析

### 2.1 缺陷 A：`shell.trashItem` 批量全量失败（核心报错）

日志原文（中文因 electron-log 编码在文件中显示为乱码，此处为源码对应文案）：

```
[2026-08-18 10:06:27.066] [warn]  [RecycleBin] 移至系统回收站失败: C:\Users\<username>\AppData\Local\InfinityNikki Launcher\cache\images\0eUV3e4utn1kgiLp.jpg Error: Failed to perform delete operation
```

量化统计（已用 PowerShell 对日志实测，非推断）：

| 指标                                  | 实测值                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| 失败日志行数                          | **2474**                                                                       |
| 错误文本唯一变体数                    | **1** 种：`Failed to perform delete operation`（Shell API 通用失败，无 errno） |
| 时间跨度                              | `10:06:27.066` → `10:06:45.533`，约 **18.5 秒**                                |
| 失败文件逐一 `Test-Path` 复检：仍存在 | **2337**（94.5%）                                                              |
| 失败文件复检：已消失                  | 137（5.5%）                                                                    |
| 失败路径盘符分布                      | C: 2094 / D: 284 / H: 96（**跨 3 个卷**）                                      |
| C/D/H 卷文件系统                      | 均为 NTFS，`$Recycle.Bin` 均存在（系统回收站功能正常）                         |
| 系统回收站当前条目数                  | **47564**（Shell COM `Namespace(10)`）                                         |
| C 盘剩余空间                          | **17 GB**（已用 183 GB）                                                       |
| 注册表 BitBucket                      | 无 HKLM 策略键；存在若干卷 `NukeOnDelete=1`                                    |

**根因判定**：`shell.trashItem` 被逐文件串行 `await` 调用 2474 次。在「系统回收站已积压 4.7 万条目 + C 盘仅剩 17GB + 文件跨 3 个卷」的高负载环境下，Windows Shell 删除操作大批量连续调用整体失败。

由于 94.5% 的文件物理仍存在，`trashItemWithFallback` 判为 `'failed'` → 依据 B1 修复约定**不删除 DB 记录** → 用户看到「清空」后条目仍在并报错。**该三态判定逻辑本身是正确的（保护数据不丢失），缺陷在于缺乏容错重试与日志降噪。**

### 2.2 缺陷 B：缩略图 `file://` 越权（伴随报错）

```
[2026-08-18 10:06:45.630] [error] [Fault:rendererError] Not allowed to load local resource: file:///C:/Users/<username>/AppData/Roaming/wxnn-photo-manager/thumbnails/ff6b32029931c766.jpg
```

- 出现 **570 行**，集中于 `...\wxnn-photo-manager\thumbnails` 目录。
- 与缺陷 A **同一时刻**（10:06:45）爆发 —— 是清空操作后列表重渲染触发。

缺陷代码位于 `src/renderer/pages/RecycleBinPage.tsx:414-424`：

```tsx
const thumbUrl = useMemo(() => {
  if (file.thumbnail) {
    try {
      const url = new URL(file.thumbnail, 'media://')
      return file.thumbnail.startsWith('media://') ? file.thumbnail : url.href
    } catch {
      return file.thumbnail
    }
  }
  return toFileUrl(file.file_path)
}, [file.thumbnail, file.file_path])
```

`file.thumbnail` 是绝对 Windows 路径。已用 Node 实测验证：

```
$ node -e "const u=new URL('C:\\Users\\...\\xx.jpg','media://'); console.log(u.href, u.protocol)"
href     = c:\Users\<username>\AppData\Roaming\wxnn-photo-manager\thumbnails\ff6b32029931c766.jpg
protocol = c:
```

`new URL` 把盘符 `C:` 当作 **scheme** 解析（`protocol` 变成 `c:`），**不抛异常**，因此 `catch` 分支不触发，`url.href` 直接返回该畸形 URL；Chromium 最终按 file 协议解析为 `file:///C:/...` 并拒绝加载。

**关键核实**：`src/main/app/media-protocol.ts:251` 的 `isMediaPathAllowed` **早已放行缩略图缓存目录**，因此只需改用 `media://` URL 即可，**协议侧无需任何改动**。

---

## 3. 依赖声明

### 3.1 运行时依赖（均为项目已有，**本次不新增任何依赖**）

| 依赖             | 版本     | 用途                                                               |
| ---------------- | -------- | ------------------------------------------------------------------ |
| `electron`       | 40.10.6  | `shell.trashItem` 官方回收站 API、`dialog.showMessageBox` 二次确认 |
| `better-sqlite3` | ^12.11.1 | 媒体记录持久化                                                     |
| `electron-log`   | ^5.4.4   | `logger.warn` 故障记录                                             |
| `zod`            | ^4.4.3   | IPC 参数校验（`wrapHandler` 内置）                                 |
| `react`          | 19.x     | 渲染层组件                                                         |

### 3.2 开发/测试依赖（均为项目已有）

| 依赖                     | 版本    | 用途                                             |
| ------------------------ | ------- | ------------------------------------------------ |
| `vitest`                 | ^1.6.1  | 单元测试（`pool: 'forks'`）                      |
| `@testing-library/react` | ^16.3.2 | 渲染层测试                                       |
| `jsdom`                  | ^29.1.1 | `src/renderer/**/*.test.tsx` 自动切换 jsdom 环境 |
| `typescript`             | 5.x     | `tsc -b` 类型门禁                                |
| `eslint`                 | 9.x     | 代码规范门禁                                     |

### 3.3 明确不引入的依赖及理由

- ❌ 第三方 `trash` / `rimraf` npm 包 —— `shell.trashItem` 已是 Electron 官方跨平台回收站 API，第三方库反而绕过系统回收站导致数据不可恢复。
- ❌ 重试库（`p-retry` / `async-retry`）—— 所需重试逻辑仅约 10 行，引入依赖不划算；且项目已有 `src/main/utils/concurrency.ts` 并发设施可复用。
- ❌ URL 处理库 —— 项目已有成熟的 `toFileUrl`（`src/renderer/utils/file.ts`），直接复用。

### 3.4 环境约束

> ⚠️ 本机 npm 存在 **Safe-Delete 网关（阈值 500 项）**，会拦截 `npm ci` 的全量删除与 `Remove-Item node_modules`。
> **只能使用 `npm install` 增量安装**，禁止 `npm ci`。

---

## 4. 启动说明

### 4.1 环境准备

```powershell
# 工作目录
cd "d:\Nikki Gallery\WXNN XiangCe"

# 依赖安装（增量，勿用 npm ci）
npm install
```

要求：Node >= 20（`engines` 声明），OS win32/x64。

### 4.2 开发模式启动

```powershell
npm run dev          # electron-vite dev，热重载
```

### 4.3 质量门禁命令（本计划每步均需通过）

```powershell
npm run typecheck        # tsc -b，类型检查
npm run lint             # eslint .
npm run test:main        # vitest run src/main
npm run test:renderer    # vitest run src/renderer
npm test                 # vitest run（全量）
npm run i18n:check       # tsx scripts/check-i18n-keys.ts，i18n key 完整性
```

### 4.4 构建与打包

```powershell
npm run build            # clean + electron-vite build + 写 dist/main/package.json
npm run dist:win         # build + pre-dist-check + electron-builder --win + verify:dist
                         # 产物：release/NikkiGallery-Setup-<version>.exe
```

### 4.5 手工验证（打包版复现路径）

1. 启动应用 → 进入「回收站」页面。
2. 确认缩略图正常显示（**不再出现裂图**）。
3. 点击「清空回收站」→ 在系统确认框点确认。
4. 预期：
   - 成功项被移入系统回收站且 DB 记录清除；
   - 失败项保留在列表中供重试，提示「部分失败（成功 X，失败 Y）」；
   - 日志中失败记录为**汇总一条**，而非 2474 行刷屏。
5. 检查日志目录 `C:\Users\<username>\AppData\Roaming\wxnn-photo-manager\logs`，确认无 `Not allowed to load local resource`。

---

## 5. 修复方案

### 5.1 缺陷 A：容错重试 + 日志降噪（`media-lifecycle-handler.ts`）

采用最小侵入策略，全部改动限定在单个文件内：

1. **单文件重试（核心）**
   为 `trashItemWithFallback` 增加失败后短延迟重试，默认 **2 次**，指数退避（100ms / 200ms）。
   每次重试前先 `pathExists` 复检 —— 文件已消失则立即判 `'missing'`，避免无谓重试。
   Windows Shell 批量删除的瞬时失败对重试敏感，重试可显著提升成功率。

2. **失败不阻断**
   现有 `for` 循环已是「逐项处理、失败仅累加 `failedPaths`」结构，天然不中断。保持该结构，确认无异常逃逸。

3. **日志降噪**
   当前每个失败都 `logger.warn` 一行 → 2474 行刷屏。改为**聚合记录**：函数内不再逐条 warn，由调用方在循环结束后汇总一条 warn（失败总数 + 前 3 个样例路径 + 首个错误信息）。日志量由 O(n) 降为 O(1)。

4. **有限并发（备选，不默认启用）**
   默认保持串行以规避 Shell 并发不确定性。如后续需提升吞吐，可用小并发度（如 4）分批 —— 仅在代码注释中说明，本次不启用（KISS）。

**语义与契约保持不变**：三态 `'ok' | 'missing' | 'failed'`、返回字段 `movedCount / missingCount / failedCount / message`、i18n key 全部不变。改动集中在共用函数，`media:emptyRecycleBin` 与 `media:permanentDelete` **两条链同时受益**。

### 5.2 缺陷 B：改用 `toFileUrl`（`RecycleBinPage.tsx`）

将 `thumbUrl` 的 `new URL(..., 'media://')` 逻辑替换为项目统一写法：

```tsx
const thumbUrl = useMemo(
  () => toFileUrl(file.thumbnail || file.file_path),
  [file.thumbnail, file.file_path]
)
```

与 `VirtualImageGrid.tsx:344`、`TimelineView.tsx:134` 完全一致。`toFileUrl` 已正确处理 `media://` / `blob:` / `data:` / `file://` 前缀与 Electron 环境转换，且该页面第 9 行**已 import 该函数**。

---

## 6. 错误处理设计

| 场景                          | 处理方式                                         | 用户可见结果                             |
| ----------------------------- | ------------------------------------------------ | ---------------------------------------- |
| 数据库未初始化                | `getRepo()` 抛 `AppError.preconditionFailed`     | 提示数据库未初始化                       |
| 回收站为空                    | 早返回，**不弹确认框**                           | `main.media.message.recycleBinEmpty`     |
| 用户取消确认框                | 抛 `AppError.canceled`（`IPC_CANCELED`）         | 静默取消，无错误弹窗                     |
| `trashItem` 失败 + 文件已消失 | 判 `'missing'`，**删除** DB 记录                 | 计入 `missingCount`                      |
| `trashItem` 失败 + 文件仍存在 | 重试 2 次；仍失败判 `'failed'`，**保留** DB 记录 | 计入 `failedCount`，条目留在列表供重试   |
| 部分成功部分失败              | 聚合日志一条 warn                                | `permanentDeletePartial`：成功 X，失败 Y |
| 全部成功                      | ——                                               | `recycleBinEmptied`：已清空 N 项         |
| 缩略图路径为空                | `toFileUrl` 返回 `null`                          | 渲染占位图标，不请求非法 URL             |
| 缩略图文件不存在              | `img onError` 回退占位                           | 占位图标                                 |

**核心错误处理原则**：`failed` 状态**绝不删除 DB 记录**。这保证在系统环境限制（回收站积压、磁盘将满、`NukeOnDelete=1`）导致无法移入回收站时，用户数据踪迹不会被静默丢失，用户可修复环境后重试。

**已知环境限制（不在代码层修复）**：日志显示部分卷设置了 `NukeOnDelete=1`（删除即彻底删除，不进回收站），且 C 盘空间紧张。重试机制能显著提升成功率并使失败可诊断，但在回收站积压 4.7 万条目、磁盘将满的机器上，**仍可能存在无法进入回收站的文件**。此时 UI 将如实反馈「部分失败」而非笼统报错。

---

## 7. 参数校验

| 位置                                 | 校验内容                                               | 手段                                              |
| ------------------------------------ | ------------------------------------------------------ | ------------------------------------------------- |
| `media:emptyRecycleBin`              | 无入参                                                 | `wrapHandlerNoArgs`（拒绝多余参数）               |
| `media:permanentDelete`              | `mediaIds: number[]`                                   | `wrapHandler` + `z.tuple([schemas.mediaIdArray])` |
| `media:softDelete` / `media:restore` | `mediaIds: number[]`                                   | 同上                                              |
| `trashItemWithFallback(filePath)`    | 非空字符串；失败时经 `pathExists` 复检存在性           | 函数内防御 + `pathExists` 不抛错语义              |
| `maxRetries` 参数                    | 默认 2；下限 0（`Math.max(0, n)`），避免负值导致死循环 | 函数内归一化                                      |
| `toFileUrl(filePath)`                | `null` / `undefined` / 空串 → 返回 `null`              | 已有实现第 4 行                                   |
| `media://` 协议路径                  | 白名单目录校验（含缩略图缓存目录）                     | `isMediaPathAllowed`（已有，不改）                |

**校验分层约定**（遵守项目既有架构）：Repository 层仅负责 SQL，**不含副作用**；`dialog` / `shell.trashItem` / `pathExists` / `notifyMediaUpdated` 全部留在 handler 层。

---

## 8. 基础测试用例

### 8.1 主进程（`src/main/ipc/handlers/media.test.ts`）

Mock 设施已就绪：`trashItemMock`、`pathExistsMock`、`showMessageBoxMock`、`repoMock.getSoftDeletedMediaPaths`、`repoMock.hardDeleteBatch`。

**既有用例（必须保持通过）**

| #   | 用例                                    | 预期                                     |
| --- | --------------------------------------- | ---------------------------------------- |
| E1  | `emptyRecycleBin` 回收站为空时返回提示  | `movedCount=0`，message 含「为空」       |
| E2  | `emptyRecycleBin` 用户取消时抛 canceled | `error.code === 'IPC_CANCELED'`          |
| E3  | `emptyRecycleBin` 用户确认后批量删除    | `hardDeleteBatch([1,2])`，`movedCount=2` |
| E4  | `trashItem` 成功计 `movedCount` 并删 DB | `movedCount=1`，`failedCount=0`          |
| E5  | `trashItem` 失败但文件不存在仍删 DB     | `missingCount=1`，`failedCount=0`        |
| E6  | `trashItem` 失败且文件存在【不】删 DB   | `hardDeleteBatch([2])`，`failedCount=1`  |
| P1  | `permanentDelete` 三态对应用例          | 同上语义                                 |

**新增用例（本次修复）**

| #   | 用例                                 | 输入                                                           | 预期输出                                            |
| --- | ------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------- |
| R1  | 首次失败（文件仍存在）但**重试成功** | `trashItem` 第 1 次 reject、第 2 次 resolve；`pathExists=true` | `movedCount=1`，`failedCount=0`，DB 记录被删除      |
| R2  | **重试用尽**仍失败                   | `trashItem` 全部 reject；`pathExists` 恒 `true`                | `failedCount=1`，`hardDeleteBatch` **不含**该 id    |
| R3  | **重试期间文件消失**                 | `trashItem` reject；`pathExists` 首次 `true`、后续 `false`     | 判 `missing`，`missingCount=1`，DB 记录被删除       |
| R4  | 重试次数上限                         | `trashItem` 恒 reject，`pathExists` 恒 `true`                  | `trashItem` 调用次数 == 1 + maxRetries（默认 3 次） |
| R5  | 日志降噪                             | 多项失败                                                       | `logger.warn` 调用次数为 O(1)，非每项一次           |

### 8.2 渲染进程（`src/renderer/pages/RecycleBinPage.thumb.test.tsx`，新增）

> **测试策略说明**：`RecycleBinPage` 依赖 `react-virtuoso` / `mediaStore` / i18n / 数十个子组件，直接 `render` 需 mock 大量模块且脆弱。
> 本项目已有成熟先例 —— `GalleryPage.test.tsx` 采用**源码结构性断言**验证契约。本用例沿用该模式，并补充 `toFileUrl` 的行为断言。

| #   | 用例                                                 | 预期                                                                                |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| T1  | 源码不再包含 `new URL(` 配 `'media://'` 的缩略图构造 | 断言不匹配该模式                                                                    |
| T2  | 缩略图走 `toFileUrl`                                 | 源码含 `toFileUrl(file.thumbnail`                                                   |
| T3  | `toFileUrl` 对绝对 Windows 路径产出 `media://`       | `toFileUrl('C:\\...\\x.jpg')` 以 `media://file?path=` 开头，**不以 `file://` 开头** |
| T4  | `toFileUrl` 幂等                                     | 已是 `media://` 的输入原样返回                                                      |

### 8.3 验证命令

```powershell
npm run test:main -- media.test          # 主进程回收站用例
npm run test:renderer                    # 渲染层用例
npm test                                 # 全量回归
```

---

## 9. 子任务分解

> **执行铁律：每一步必须先验证通过，再进入下一步。任何失败当场修复，不遗留、不累积。**

### 子任务 1 —— 编写本 MD 计划文件

- **修改文件**：`docs/FIX-empty-recycle-bin-2026-08-18.md`（新增）
- **输入**：日志实证分析结论 + 代码定位结果
- **输出**：含依赖声明、启动说明、错误处理、参数校验、基础测试用例的完整计划文档
- **验收标准**：文件存在；六项强制内容齐备；每个子任务写明「改哪些文件 / 输入输出 / 验收标准」

### 子任务 2 —— 修复缺陷 B（缩略图 URL）

- **修改文件**：`src/renderer/pages/RecycleBinPage.tsx`（仅 `thumbUrl` 的 `useMemo`，第 414-424 行）
- **输入**：`file.thumbnail`（绝对 Windows 路径 或 `media://` URL 或 `null`）、`file.file_path`
- **输出**：`media://file?path=<encoded>` 形式的 URL，或 `null`
- **验收标准**：
  1. `npm run typecheck` 通过；
  2. `npm run test:renderer` 通过；
  3. 源码中不再存在 `new URL(file.thumbnail, 'media://')`；
  4. 其余逻辑零改动（diff 仅限该 `useMemo`）

### 子任务 3 —— 修复缺陷 A（重试 + 降噪）

- **修改文件**：`src/main/ipc/handlers/media-lifecycle-handler.ts`
- **输入**：`filePath: string`、可选 `maxRetries: number`（默认 2）
- **输出**：`TrashItemResult = 'ok' | 'missing' | 'failed'`；`emptyRecycleBin` 返回 `{ message, movedCount, missingCount, failedCount }`
- **验收标准**：
  1. `npm run typecheck` 通过；
  2. `npm run test:main` 既有用例全部通过（三态语义未被破坏）；
  3. 返回字段与 i18n key 与修复前完全一致；
  4. 循环内不再逐条 `logger.warn`，改为循环后聚合一条；
  5. `media:permanentDelete` 与 `media:emptyRecycleBin` 共用同一重试逻辑

### 子任务 4 —— 扩展测试用例

- **修改文件**：`src/main/ipc/handlers/media.test.ts`（新增 R1~~R5）、`src/renderer/pages/RecycleBinPage.thumb.test.tsx`（新增 T1~~T4）
- **输入**：mock 的 `trashItem` reject/resolve 序列与 `pathExists` 返回序列
- **输出**：测试断言结果
- **验收标准**：
  1. 新增用例先红（修复前失败）后绿（修复后通过）；
  2. `npm run test:main` 与 `npm run test:renderer` 全绿；
  3. 既有用例零回归

### 子任务 5 —— 全量质量门禁

- **修改文件**：无（仅验证；若发现问题则当场修复对应文件）
- **输入**：完整代码库
- **输出**：各门禁命令退出码 0
- **验收标准**：依次通过 `npm run typecheck`、`npm run lint`、`npm run test:main`、`npm run test:renderer`、`npm run i18n:check`

### 子任务 6 —— 构建验证与范围确认

- **修改文件**：`docs/FIX-empty-recycle-bin-2026-08-18.md`（回填验证结果）
- **输入**：通过门禁的代码库
- **输出**：`dist/` 构建产物；本文档第 10 节验证记录
- **验收标准**：
  1. `npm run build` 成功；
  2. `git status` / `git diff --stat` 确认改动仅限 4 个目标文件 + 本文档，未波及无关内容；
  3. 验证结果已回填本文档

---

## 10. 验证记录

执行日期：2026-08-18。

| 命令                   | 结果                                | 备注                                                               |
| ---------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| `npm run typecheck`    | ✅ 通过                             | `tsc -b` 无错误                                                    |
| `npm run lint`         | ✅ 通过                             | 改动文件 **0 error**；全库 5933 warning 均为既有「硬编码中文」规则 |
| `npm run format:check` | ✅ 通过                             | `All matched files use Prettier code style!`                       |
| `npm test`（全量）     | ✅ 通过                             | **169 个测试文件 / 3350 个用例全部通过**                           |
| `npm run i18n:check`   | ⚠️ 失败（**既有问题，与本次无关**） | 见 10.1                                                            |
| `electron-vite build`  | ✅ 通过                             | exit 0；main / preload / renderer 三段均构建成功                   |

### 10.1 i18n:check 失败为既有问题（已证明）

缺失 key：`toast.backup`、`toast.scanInterrupted`、`faultTypes.indexingTimeout`、`main.decryption.error.uidRequired` —— 均与回收站无关。

证明方法：`git stash push -u` 回退到 HEAD 原始状态后重新执行 `npm run i18n:check`，**报出完全相同的缺失 key**，随后 `git stash pop` 恢复改动。故该失败早于本次修复存在；本次未新增任何 i18n key 引用，也未改动 `locales/` 下任何语言文件。

### 10.2 构建产物核验（修复确实进入产物）

| 检查项                                                                         | 结果 |
| ------------------------------------------------------------------------------ | ---- |
| `dist/main/main/app/application.js` 含聚合日志标记与 `trashItem` 逻辑          | ✅   |
| `dist/renderer/assets/RecycleBinPage-*.js` **不含** `new URL(..., "media://")` | ✅   |
| `toFileUrl`（`media://file?path=`）位于共享 chunk `index-*.js` 并被正确引用    | ✅   |

### 10.3 环境注意事项

`npm run build` 的 `clean` 前置步骤会被本机 **Safe-Delete 网关**（阈值 500 项）拦截（`dist/main` 达 529 项），报 `EPERM: operation not permitted, rmdir`。这是环境保护机制而非代码问题；改用 `npx electron-vite build` 直接构建即可通过（已验证 exit 0）。

> ⚠️ **本机禁止使用 cmd 的 `del` 删除以点开头的文件**（如 `.tmp-x.ps1`）。
> `cmd /c del /q "<dir>\.tmp-x.ps1"` 会被 cmd 解析为「当前目录」从而**静默删除该目录下所有文件**。
> 本次修复过程中曾因此误删全部根目录文件，已用 `git cat-file blob` 按字节精确恢复（25 个文件全部还原，git 校验零差异）。
> 清理临时文件请使用 PowerShell `Remove-Item -LiteralPath`。

### 10.4 测试耗时侧证熔断有效

引入重试但**尚未加入熔断**时，`media.test.ts` 耗时由 3.34s 升至 **7.28s**（14 项失败用例的退避延迟累积）；加入熔断后回落至 **3.34s**。这从侧面印证：若无熔断，生产环境 2474 项全失败场景下退避延迟将累积为分钟级卡顿。

---

## 11. 修改范围白名单

**允许修改（4 个代码文件 + 1 个文档）**

- `src/main/ipc/handlers/media-lifecycle-handler.ts`
- `src/main/ipc/handlers/media.test.ts`
- `src/renderer/pages/RecycleBinPage.tsx`
- `src/renderer/pages/RecycleBinPage.thumb.test.tsx`（新增）
- `docs/FIX-empty-recycle-bin-2026-08-18.md`（新增，本文档）

**明确不改动**

- `src/main/app/media-protocol.ts` —— 白名单已放行缩略图目录，无需改动
- `src/renderer/utils/file.ts` —— `toFileUrl` 实现正确，直接复用
- `src/main/database/media-repository.ts` —— 遵守「Repository 无副作用」分层约定
- `src/main/services/file-service.ts` —— `moveToRecycleBin` 属另一条调用链，本次不动以控制范围
- `package.json` —— 不新增任何依赖

**代码标记约定**：沿用项目既有风格 `// FIX(编号): 原因`。
