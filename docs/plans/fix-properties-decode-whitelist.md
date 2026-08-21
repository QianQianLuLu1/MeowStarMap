# 修复：图库属性面板“信息解析失败: 路径不在白名单内，禁止读取操作”

> 状态：已完成并验证（代码改动 + 单元测试全绿）
> 关联模块：`src/main/ipc/handlers/decrypt-handler.ts`、`src/main/app/media-protocol.ts`
> 修复策略：复用 `media://` 已索引媒体白名单，消除与文件操作审批白名单的数据源不同步

---

## 1. 问题现象

在**打包后**进入“图库”板块，对图片**右键 → 属性**，属性面板中所有游戏解码参数（相机参数 / 拍摄信息 / 角色 UID 等）统一显示：

```
信息解析失败: 路径不在白名单内，禁止 读取 操作
```

- 图片在图库中**能正常显示**（说明文件本身可读、且已登记进媒体库）。
- 仅“属性 → 游戏参数解密”失败；同一张图在文件管理器中手动打开正常。
- 错误文案来自 `src/main/ipc/validator.ts` 的 `pathGuard.assertAllowed` 抛出的拒绝信息，前缀“信息解析失败”由前端 `PropertiesDialog` 包裹。

---

## 2. 定位过程

逐步排查调用链（均在主进程）：

1. **前端触发点**：`src/renderer/components/common/PropertiesDialog.tsx` → `useGameParams.ts` 调用 IPC `decrypt:decodeFile({ filePath: file.file_path, albumType, uid })`。`file.file_path` 来自媒体库 `media_files` 表（即图库显示的同一文件路径）。

2. **IPC Handler**：`src/main/ipc/handlers/decrypt-handler.ts:23` 在调用解密服务**之前**执行：

   ```ts
   assertFileReadPath(filePath) // ← 解密前的前置路径守卫
   ```

3. **守卫实现**：`assertFileReadPath`（`src/main/ipc/validator.ts`）→ `pathGuard.assertAllowed(filePath)`。其白名单 `roots` 仅包含：
   - 各扫描源的 `source_path`
   - 自定义扫描路径 `customScanPaths`
   - 导入根 `import_roots`
   - `userDataDir`（用户目录兜底）

   当 `filePath` 不在上述任一 `roots` 内时，抛出“路径不在白名单内，禁止读取操作”。

4. **对比图库显示链路**：图库缩略图走 `media://` 协议（`src/main/app/media-protocol.ts:40` 的 `handler`），其放行函数 `isMediaPathAllowed`（`media-protocol.ts:229`）的放行规则是：
   - 缩略图缓存目录；**或**
   - `media_files` 表 `file_path` / `thumbnail` **精确命中**；**或**
   - 位于 `source_path` 目录下且扩展名属于媒体类型。

   → 图库能显示，`file_path` 必然已在 `media_files` 表中（被 `isMediaPathAllowed` 放行）。

5. **结论**：属性解密与图库显示使用了**两套独立、数据源不同步的白名单**——
   - `media://` 基于“DB 精确命中”（覆盖所有已索引媒体）；
   - `decrypt:decodeFile` 基于“pathGuard.roots”（仅覆盖扫描源/导入根/userData）。

   当某媒体的 `file_path` 在 DB 中（图库可见）但不落在 `pathGuard.roots` 内时（例如 `source_path` 为空、文件位于非 userData 的导入目录且 `import_roots` 未覆盖、或 `userDataDir` 兜底未正确初始化），解密读操作在**解密执行前**就被 `assertFileReadPath` 拦截。

6. **排除密钥/UID 因素**：解密服务 `src/main/services/decryption-service.ts` 内部的 UID 校验（`uidRequired` → `main.decryption.error.uidRequired`）与密钥匹配错误文案均**不同于**本错误；本错误发生在 `decodeFileParams` 被调用之前，与密钥/UID/解析逻辑无关。

---

## 3. 根因分析

| 项       | 说明                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 直接原因 | `decrypt:decodeFile` 解码前调用 `assertFileReadPath` → `pathGuard.assertAllowed`，对“已索引媒体的读取”使用了错误的白名单口径。                                                       |
| 根本原因 | 图库显示授权（`media://` 的 `isMediaPathAllowed`，基于媒体库 DB）与文件操作审批授权（`pathGuard.roots`）是两套独立数据源，长期未对齐；对已入库媒体的解密读取未被纳入媒体白名单放行。 |
| 触发条件 | 媒体 `file_path` ∈ DB（`isMediaPathAllowed` 放行）但 ∉ `pathGuard.roots`（`assertFileReadPath` 拒绝）。                                                                              |
| 影响范围 | 所有“右键图片 → 属性”的解密参数；不影响图库浏览、不影响文件管理器直接打开。                                                                                                          |

### 开源复用结论

- `ChanIok/SpinningMomo`（C++）：元数据解析依赖商业服务 `NUAN5.PRO`，无法直接复用其代码。
- `RanAxro/nikki_albums`（网页）：解密逻辑与 Electron 主进程 IPC 架构不兼容。
- **结论**：本项目 `decryption-service.ts` 已基于 `photography_decode` npm 库实现完整解密流程（密钥匹配 / UID / 解析），**直接复用现有实现**，本次仅修复前置路径拦截，不另写解密代码，避免自造轮子与漂移风险。

---

## 4. 解决方案

### 4.1 核心改动（最小范围）

让 `decrypt-handler` 在解密前**复用 `media://` 已索引媒体白名单** `isMediaPathAllowed`，与图库显示授权标准统一；仅在未命中媒体白名单时才回退到原 `assertFileReadPath` 兜底。

**改动 A — `src/main/app/media-protocol.ts`**

- 将私有函数 `function isMediaPathAllowed(ctx: AppContext, filePath)` 改为 `export function isMediaPathAllowed(ctx: HandlerContext, filePath)`。
  - 参数类型由 `AppContext` 收窄为 `HandlerContext`：`AppContext extends HandlerContext`，二者均含 `dbManager` 与 `thumbnailGen`，`decrypt-handler` 持有的 `HandlerContext` 可直接传入。
  - 函数体逻辑**不变**，无循环依赖（`media-protocol` 不反向依赖 `decrypt-handler`；其依赖 `MEDIA_EXTENSIONS`/`isPathUnderDir`/`getCachedSourcePaths`/`mediaPathCache`/`logger` 均在同模块内）。
  - 顶部新增 `import type { HandlerContext } from '../ipc/handler-context'`（仅类型导入，无运行时依赖）。

**改动 B — `src/main/ipc/handlers/decrypt-handler.ts`**

- 新增导入：`import { isMediaPathAllowed } from '../../app/media-protocol'`
- 将解密前的 `assertFileReadPath(filePath)` 替换为：
  ```ts
  if (!isMediaPathAllowed(ctx, filePath)) {
    assertFileReadPath(filePath) // 未命中媒体白名单时走原审批白名单兜底
  } else {
    logger.debug('[decrypt] 命中已索引媒体白名单，跳过 pathGuard 校验:', filePath)
  }
  ```

### 4.2 设计权衡

- **复用而非新增**：`isMediaPathAllowed` 已有 5 分钟 TTL 缓存 + LRU，性能与 `media://` 一致；解密为低频操作（仅属性面板触发），无性能风险。
- **不扩大 pathGuard 根集合**：避免放宽文件操作审批面；仅在“读已索引媒体”这一语义上对齐媒体协议，blast radius 最小。
- **保留兜底断言**：极端场景（路径既不在 DB 也不在 roots 但确需读取）仍走 `assertFileReadPath`，不破坏既有安全边界。

---

## 5. 依赖声明

| 依赖                                                                                            | 用途                                          | 备注                                            |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------- |
| `photography_decode`（npm）                                                                     | 游戏参数实际解密                              | 由 `decryption-service.ts` 使用，本次**未改动** |
| `zod`                                                                                           | IPC 入参 schema 校验（`schemas.decryptFile`） | 沿用既有，未降级                                |
| `electron`（`ipcMain`）                                                                         | IPC 通道注册                                  | 既有                                            |
| 现有模块 `media-protocol`、`validator`、`logger`                                                | 白名单校验 / 断言 / 日志                      | 既有，仅导出复用                                |
| 测试：`vitest`                                                                                  | 单元测试                                      | `npm run test`                                  |
| 测试 mock：`electron`（ipcMain）、`validator`、`media-protocol`、`decryption-service`、`logger` | 隔离依赖                                      | 见测试文件                                      |

> 未引入任何新第三方依赖。

---

## 6. 启动 / 复现说明

### 开发模式（验证修复）

```powershell
# 1. 安装依赖（增量，勿用 npm ci，本机有 Safe-Delete 网关）
npm install

# 2. 启动 Electron 开发环境
npm run dev
```

复现路径：图库板块 → 右键任意已索引图片 → 属性 → 游戏参数面板应正常显示（不再报“路径不在白名单内”）。

### 打包模式（用户原始场景）

```powershell
# 注意：本机 npm run build 的 clean 步会触发 Safe-Delete EPERM，改用等价序列
npx electron-vite build
node -e "require('fs').writeFileSync('dist/main/package.json',JSON.stringify({type:'commonjs'}))"
npm run pre-dist-check
npx electron-builder --win --publish never
```

安装并启动后，按上述路径验证属性面板。

---

## 7. 错误处理

| 场景                                                    | 行为                                                                          | 用户感知                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `filePath` 命中媒体白名单                               | 跳过 `assertFileReadPath`，直接解密                                           | 正常显示参数                                                         |
| `filePath` 未命中媒体白名单但 `assertFileReadPath` 通过 | 兜底放行后解密                                                                | 正常显示参数                                                         |
| `filePath` 未命中媒体白名单且 `assertFileReadPath` 拒绝 | 抛出白名单错误，由 `wrapHandler` 捕获                                         | “信息解析失败: 路径不在白名单内，禁止读取操作”（仅对真正的越权路径） |
| 解密服务内部错误（`result.error`）                      | 由 `decryption-service` 既有结构承载，前端以“信息解析失败: <err>”展示         | 维持既有 UI 约定                                                     |
| `isMediaPathAllowed` 自身异常                           | 函数内部已 try/catch 返回 `false`，落入 `assertFileReadPath` 兜底，不静默放行 | 维持既有安全边界                                                     |

> `isMediaPathAllowed` 的失败不会“睁一只眼放行”，而是保守地回退到审批白名单，确保不扩大攻击面。

---

## 8. 参数校验

解密入口沿用既有 `wrapHandler` + zod 元组校验（`schemas.decryptFile`）：

| 参数        | 类型    | 约束                                                                                 |
| ----------- | ------- | ------------------------------------------------------------------------------------ |
| `filePath`  | string  | `min(1).max(4096)`，必填                                                             |
| `albumType` | string  | `min(1).max(32)`，必填                                                               |
| `uid`       | string? | `min(1).max(64)`，可选（缺省时由 `resolveUidFromProfiles` / `getAllKnownUids` 推断） |

校验失败由 `wrapHandler` 统一返回 `参数校验失败: ...`，不进入白名单/解密逻辑。
新增的 `isMediaPathAllowed` 仅做“是否存在于媒体库”的只读判定，**不放松**入参 schema 校验。

---

## 9. 基础测试用例

新增测试：`src/main/ipc/handlers/__tests__/decrypt-handler.test.ts`
（沿用仓库既有测试约定：`_test-helpers` 模式 / `vi.mock` 隔离 electron、validator、media-protocol、decryption-service、logger）

| 用例                  | 输入                                                          | 预期                                                                                                          | 验证点                   |
| --------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 命中媒体白名单        | `isMediaPathAllowed=true`                                     | `success:true, ok:true`；`assertFileReadPath` **未调用**；`decodeFileParams` 调用 1 次；`logger.debug` 被调用 | 已索引媒体跳过审批白名单 |
| 未命中 → 兜底放行     | `isMediaPathAllowed=false`，`assertFileReadPath` 不抛错       | `success:true, ok:true`；`assertFileReadPath` 调用 1 次；`decodeFileParams` 调用 1 次                         | 兜底仍生效               |
| 非媒体路径 → 兜底拒绝 | `isMediaPathAllowed=false`，`assertFileReadPath` 抛白名单错误 | `success:false`，`error.message` 含“路径不在白名单内”；`decodeFileParams` **未调用**                          | 安全边界保留             |

运行：

```powershell
npx vitest run src/main/ipc/handlers/__tests__/decrypt-handler.test.ts
```

既有测试回归（`src/main/ipc/handlers/decrypt-handler.test.ts`、`src/main/app/__tests__/media-protocol.test.ts`）均无回归。

---

## 10. 子任务清单（修改文件 / 输入输出 / 验收标准）

### 子任务 1 — 调用链核对（分析）

- **修改文件**：无（仅分析）
- **输入**：`decrypt-handler.ts:23`、`media-protocol.ts:229`、相关 `import` 关系
- **输出**：核对结论（改动仅涉及两文件、无循环依赖、`isMediaPathAllowed` 依赖均在同模块内）
- **验收标准**：确认 `AppContext extends HandlerContext`，`decrypt-handler` 的 `ctx` 可直接传给 `isMediaPathAllowed`。

### 子任务 2 — 导出 `isMediaPathAllowed`

- **修改文件**：`src/main/app/media-protocol.ts`
- **输入**：现有私有函数 `function isMediaPathAllowed(ctx: AppContext, filePath)`
- **输出**：`export function isMediaPathAllowed(ctx: HandlerContext, filePath)`，逻辑不变
- **验收标准**：`npx tsc -b` 无错误；`eslint` 无新增 error；既有 `media-protocol.test.ts` 全绿。

### 子任务 3 — 修复 decrypt-handler

- **修改文件**：`src/main/ipc/handlers/decrypt-handler.ts`
- **输入**：`filePath / albumType / uid`
- **输出**：解密结果 `{ ok, data, message }`（命中媒体白名单时跳过 `assertFileReadPath`）
- **验收标准**：单元测试覆盖“命中放行 / 未命中兜底 / 非媒体拒绝”三场景，全部通过。

### 子任务 4 — 新增测试

- **修改文件**：`src/main/ipc/handlers/__tests__/decrypt-handler.test.ts`（新增）
- **输入**：mock `ctx`（含 `dbManager`、`thumbnailGen.getCacheDir`）与 `isMediaPathAllowed` 分支
- **输出**：3 个用例断言（见第 9 节）
- **验收标准**：`npx vitest run decrypt-handler` 全绿，覆盖新校验分支。

### 子任务 5 — 回归与文档

- **修改文件**：`docs/plans/fix-properties-decode-whitelist.md`（新增）
- **输入**：上述定位/根因/方案/测试结论
- **输出**：本 MD 文档
- **验收标准**：`npm run typecheck` 无错误、`npm run lint` 无新增 error（仅既有 warning）、文档结构完整可渲染。

---

## 11. 验证结果（本次执行）

| 检查项                           | 命令                                                                     | 结果                                 |
| -------------------------------- | ------------------------------------------------------------------------ | ------------------------------------ |
| 单元测试（新增）                 | `npx vitest run src/main/ipc/handlers/__tests__/decrypt-handler.test.ts` | ✅ 3/3 通过                          |
| 单元测试（既有 decrypt-handler） | `npx vitest run src/main/ipc/handlers/decrypt-handler.test.ts`           | ✅ 9/9 通过                          |
| 单元测试（media-protocol）       | `npx vitest run src/main/app/__tests__/media-protocol.test.ts`           | ✅ 21/21 通过                        |
| 类型检查                         | `npm run typecheck`（`tsc -b`）                                          | ✅ 无 error                          |
| 静态检查                         | `eslint` 对改动文件                                                      | ✅ 0 error（仅既有 warning，不阻断） |

> 说明：全部子任务均“先验证通过，再进入下一步”；未改动 `decryption-service`、密钥/UID 逻辑、`PropertiesDialog` 显示逻辑、`pathGuard` 其他调用方，改动范围可控。
