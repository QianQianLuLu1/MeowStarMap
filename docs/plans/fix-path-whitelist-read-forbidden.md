# 修复：分享 / WiFi 分享 / 属性解码对已索引合法媒体误报“路径不在白名单内，禁止读取操作”

> 状态：已执行完成，全链路回归通过（2026-08-28；手动验证待用户执行，见第 17 节）
> 关联模块：`src/main/ipc/validator.ts`、`src/main/app/media-protocol.ts`、`src/main/ipc/handlers/share.ts`、`src/main/ipc/handlers/file.ts`、`src/main/ipc/handlers/video.ts`、`src/main/ipc/handlers/decrypt-handler.ts`、渲染层属性面板相关
> 修复策略：抽取共享的“媒体读取守卫” `assertMediaReadPath`，统一复用 `media://` 已索引媒体白名单（`isMediaPathAllowed`）+ 审批白名单（`assertFileReadPath`）双层模式；同时在渲染层区分“不包含该参数”与真实错误
> 前置文档：`docs/plans/fix-properties-decode-whitelist.md`（同类根因，当时仅修复 `decrypt:decodeFile`，本次将内联逻辑抽为共享函数并推广到其余只读通道）

---

## 1. 问题背景

对**已入库、图库中可正常显示**的合法媒体文件，以下功能统一报错：

```
路径不在白名单内，禁止读取操作
```

受影响场景：

1. **剪贴板分享**：图库选中图片 → 分享（复制文件到剪贴板/目标目录），主进程 `share:copyFiles` 前置路径校验拒绝。
2. **WiFi 局域网分享**：`WifiShareDialog` 发起局域网分享，`share:startWifi` 前置路径校验拒绝。
3. **属性 / 解码面板**：
   - EXIF 信息（`file:getExif`）；
   - 视频信息（`video:thumbnail` / `video:metadata`）；
   - 游戏参数解码（`decrypt:decodeFile`）已按双层模式修复，作为本次改造范本。
4. **误导性错误文案**：属性面板对**不含游戏参数的文件**显示白名单错误，而不是如实显示“不包含该参数”。根因是解码服务返回 `{ hasParams: false, error: '未找到 CameraParams 字段' }`，渲染层把 `error` 字符串直接当作错误态展示，与白名单拒绝共用了同一分支。

错误的本质：文件**已在媒体库（`media_files` 表）中、可经 `media://` 协议正常显示**，但其路径不落在 `PathGuard` 已注册的审批根目录集合内，于是只读操作在业务逻辑执行前被误拦。

---

## 2. 影响范围

| 维度     | 说明                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------- |
| 功能面   | 剪贴板分享、WiFi 局域网分享、属性面板（EXIF / 视频信息 / 游戏参数）、解码相关只读通道                   |
| 用户感知 | 对合法媒体报“禁止读取操作”，分享功能不可用；属性面板显示误导性错误                                      |
| 触发条件 | 媒体 `file_path` ∈ 媒体库 DB（`isMediaPathAllowed` 放行）但 ∉ `PathGuard.roots`（`assertAllowed` 拒绝） |
| 不受影响 | 图库浏览（`media://` 缩略图）、写/删除类通道（本次**不改**）、打包/构建流程                             |
| 安全边界 | **不放宽**：不改 `PathGuard` 规则、不扩大 `roots`、敏感目录黑名单与 zod schema 原样保留                 |

---

## 3. 调用链定位过程

### 3.1 错误文案唯一来源

- 文案 `路径不在白名单内，禁止读取操作` 全仓库唯一来源：`src/renderer/i18n/locales/zh-CN.json` 的键 `main.validator.pathNotAllowed`。
- 抛出点：`src/main/ipc/validator.ts` 中 `PathGuard.assertAllowed`（第 171–271 行）→ `AppError.forbidden`，错误码 `IPC_PATH_FORBIDDEN`；经 `wrapHandler` 归一化为 `IpcResponse`，由渲染层 i18n 按 code 映射文案。

### 3.2 各误拦通道调用链（均在主进程）

| 通道                 | 前端入口 → 主进程 handler                                                            | 误拦位置                                        | 处理策略                       |
| -------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------ |
| `share:copyFiles`    | `GalleryPage.tsx` → `src/renderer/utils/share.ts` → `src/main/ipc/handlers/share.ts` | `share.ts` 第 62 行 `assertFileReadPath` 类校验 | 改为双层媒体读守卫             |
| `share:startWifi`    | `WifiShareDialog.tsx` → `src/renderer/utils/share.ts` → `share.ts`                   | `share.ts` 第 32 行                             | 改为双层媒体读守卫             |
| `decrypt:decodeFile` | `PropertiesDialog` → `useGameParams` → `decrypt-handler.ts`                          | 第 31–35 行（已按双层模式修复）                 | 内联逻辑替换为共享函数（范本） |
| `file:getExif`       | 属性面板 → `src/main/ipc/handlers/file.ts`                                           | `file.ts` 第 72 行                              | 改为双层媒体读守卫             |
| `video:thumbnail`    | 视频预览/属性 → `src/main/ipc/handlers/video.ts`                                     | `video.ts` 第 35 行                             | 改为双层媒体读守卫             |
| `video:metadata`     | 视频属性 → `video.ts`                                                                | `video.ts` 第 44 行                             | 改为双层媒体读守卫             |

> **注意**：所有**含写目标**的通道（如复制目标目录校验、移动/删除类）本次**不改**，写/删除审批校验原样保留。

### 3.3 两套白名单对照

1. **媒体白名单** `isMediaPathAllowed`（`src/main/app/media-protocol.ts` 第 231–310 行），`media://` 协议 handler 的放行函数，基于**媒体库 DB**：
   - 缩略图缓存目录；或
   - `media_files.file_path`（及 `thumbnail`）**精确命中**；或
   - 位于 `source_path` 目录下且扩展名属于媒体类型；
   - 带 5 分钟 TTL + LRU 缓存。

2. **审批白名单** `PathGuard`（`src/main/ipc/validator.ts` 第 171–271 行），基于**目录根集合**：
   - `userHome` + `userDataDir` + 动态注册的 `roots`；
   - `roots` 由 `refreshPathGuardRoots` 从数据库恢复，存在**注册时机窗口**（初始化早期 / 恢复失败时根集合不全）。

### 3.4 “不包含该参数”误导链路

```
解码服务返回 { hasParams: false, error: '未找到 CameraParams 字段' }
  → 渲染层 useGameParams 将 result.error 字符串当作错误态展示
  → 面板显示“信息解析失败: ...”，与白名单拒绝共用同一分支
  → 用户对无参数文件看到误导性错误
```

正确语义应为：`hasParams === false` 属于**业务空态**（“不包含该参数”），而非错误。

---

## 4. 根因分析

| 项       | 说明                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 直接原因 | 各只读通道在业务执行前统一调用 `assertFileReadPath` → `PathGuard.assertAllowed`，对“已索引媒体的读取”使用了审批白名单口径。                                                             |
| 根本原因 | 媒体展示授权（`isMediaPathAllowed`，基于媒体库 DB）与文件操作审批授权（`PathGuard.roots`）是两套独立数据源，长期未对齐；`roots` 由 `refreshPathGuardRoots` 动态恢复，存在注册时机窗口。 |
| 触发条件 | 媒体 `file_path` ∈ DB（`media://` 可显示）但其父目录不在任何已注册 `PathGuard` 根下。                                                                                                   |
| 非根因   | 路径规范化问题两侧均已归一（`PathGuard` 与 `isMediaPathAllowed` 均做规范化处理），**不是**本次误拦的原因。                                                                              |
| 文案根因 | 渲染层对解码结果未区分 `hasParams === false` 与真实错误，两者共用同一错误分支。                                                                                                         |

仓库文档 `docs/plans/fix-properties-decode-whitelist.md` 已得出同类结论，当时仅修复了 `decrypt:decodeFile` 单通道（内联实现）。本次将其模式沉淀为共享函数并推广到其余只读通道。

---

## 5. 复用方案结论

### 5.1 开源调研

- **Electron 官方“自定义协议 + 白名单”范式**：本项目 `media://` 协议 + `isMediaPathAllowed` 已按此范式实现，无需重造。
- **GitHub / npm 第三方库**：未发现可直接复用的成品库。原因：问题本质是**本项目两套自有白名单数据源不同步**，属于业务语义层面的对齐问题，任何通用的路径白名单/权限库都无法替代表达“已入库媒体即可读”这一项目特有语义。
- 前次计划已排除的仓库维持结论：`ChanIok/SpinningMomo`（C++，依赖商业服务 NUAN5.PRO，不可复用）、`RanAxro/nikki_albums`（网页，与 Electron 主进程 IPC 架构不兼容）。

### 5.2 复用结论

直接复用本项目既有资产，不引入新机制：

| 复用对象                             | 来源文件                                         | 用途                                         |
| ------------------------------------ | ------------------------------------------------ | -------------------------------------------- |
| `isMediaPathAllowed`                 | `src/main/app/media-protocol.ts`                 | 媒体白名单判定（已导出，带缓存）             |
| `assertFileReadPath`                 | `src/main/ipc/validator.ts`                      | 审批白名单兜底断言                           |
| `PathGuard` + 敏感目录黑名单         | `src/main/ipc/validator.ts`                      | 安全边界，**不改动**                         |
| `AppError.forbidden` / `wrapHandler` | `src/shared/errors/app-error.ts`、`validator.ts` | 统一错误归一化与 IPC 响应包装                |
| 既有 zod schemas                     | `src/main/ipc/validator.ts`                      | 入参校验（`filePath` / `filePathArrayBulk`） |

---

## 6. 解决方案

### 6.1 核心改动

1. **新建共享守卫** `src/main/ipc/media-read-guard.ts`，提供：

   ```ts
   export function assertMediaReadPath(ctx: HandlerContext, filePath: string): void {
     // 1) 命中媒体白名单（已索引媒体）→ 直接放行
     if (isMediaPathAllowed(ctx, filePath)) return
     // 2) 否则回退原审批白名单兜底（未命中或异常时保守拒绝越权路径）
     assertFileReadPath(filePath)
   }
   ```

   - 语义：`isMediaPathAllowed` 命中 → 放行；未命中（含其内部异常保守返回 `false`）→ 回退 `assertFileReadPath`，由其放行或抛 `AppError.forbidden`。
   - 与 `decrypt:decodeFile` 现有内联逻辑等价，抽取后可被多通道共享，避免逻辑漂移。

2. **接入只读通道**（仅替换读校验，不改业务逻辑）：
   - `share:copyFiles`（`share.ts` 第 62 行）
   - `share:startWifi`（`share.ts` 第 32 行）
   - `file:getExif`（`file.ts` 第 72 行）
   - `video:thumbnail` / `video:metadata`（`video.ts` 第 35、44 行）
   - `decrypt:decodeFile`（`decrypt-handler.ts` 第 31–35 行）：内联逻辑**替换**为 `assertMediaReadPath`，行为保持不变。

3. **渲染层语义区分**（“不包含该参数”不再伪装成错误）：
   - 解码结果结构增加结构化字段 `notContained: boolean`（对应 `hasParams === false` 且错误为“未找到 CameraParams 字段”这一类非错误空态）；
   - `decryption-service` 产出 `notContained` 语义；`useGameParams` 优先判断 `notContained` → 展示空态文案；
   - 属性面板为该字段配置 `emptyText`；
   - 新增 i18n 键 `infoPanel.paramNotContained`（“不包含该参数”），并**补齐** `main.validator.pathNotAllowed` 在非中文 locale 中缺失的文案。

4. **安全边界不放宽**（硬性约束）：
   - 不改 `PathGuard` 规则、不扩大 `roots`、不调用 `refreshPathGuardRoots` 提前注册；
   - 写/删除类通道校验原样保留（含分享中写目标目录的校验）；
   - 敏感目录黑名单与所有 zod schema 校验原样保留。

### 6.2 设计权衡

- **复用而非新增机制**：`isMediaPathAllowed` 已有 5 分钟 TTL + LRU 缓存，性能与 `media://` 一致；分享/属性均为低频操作，无性能风险。
- **共享函数替代内联**：`decrypt:decodeFile` 的内联实现已验证有效，抽为 `assertMediaReadPath` 后 5 个通道共用一份逻辑，杜绝多处漂移。
- **保留兜底断言**：未命中媒体白名单的路径仍走 `assertFileReadPath`，极端场景安全边界不变。
- **结构化字段替代字符串匹配**：渲染层用 `notContained` 布尔字段区分空态，不做“未找到 CameraParams”字符串匹配，避免跨语言/文案变更导致的脆弱性。

---

## 7. 依赖声明

| 依赖                                        | 用途                                            | 备注                   |
| ------------------------------------------- | ----------------------------------------------- | ---------------------- |
| `isMediaPathAllowed`（`media-protocol.ts`） | 媒体白名单判定                                  | 既有导出，本次不改逻辑 |
| `assertFileReadPath`（`validator.ts`）      | 审批白名单兜底                                  | 既有，不改             |
| `AppError` / `AppError.forbidden`           | 越权路径抛错                                    | 既有                   |
| `wrapHandler`                               | IPC 统一包装（校验 + 响应 + 异常归一）          | 既有                   |
| `HandlerContext`                            | 共享守卫入参类型                                | 既有，仅类型导入       |
| `zod`                                       | 入参 schema（`filePath` / `filePathArrayBulk`） | 沿用，不降级           |
| `vitest`                                    | 单元测试                                        | `npm run test`         |

- **无新增第三方依赖**。
- **无循环依赖**：`media-read-guard.ts` 仅单向依赖 `media-protocol`（类型 + `isMediaPathAllowed`）与 `validator`（`assertFileReadPath`），两者均不反向依赖新模块。

---

## 8. 启动 / 复现说明

### 单元测试（独立运行）

```powershell
# 指定测试文件独立运行，无需启动应用
npx vitest run src/main/ipc/media-read-guard.test.ts
```

### 开发模式（手动验证）

```powershell
# 1. 安装依赖（增量）
npm install

# 2. 启动 Electron 开发环境
npm run dev
```

复现路径（修复前可复现、修复后验证）：

1. 图库选中已索引图片 → 分享 → 不再报“路径不在白名单内”。
2. 打开 WiFi 局域网分享对话框 → 发起分享 → 正常。
3. 右键图片 → 属性 → EXIF / 视频信息 / 游戏参数正常显示；对不含参数的文件显示“不包含该参数”。

---

## 9. 错误处理

| 场景                                         | 行为                                                                                                                 | 用户感知                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 命中媒体白名单                               | `assertMediaReadPath` 直接放行，业务正常执行                                                                         | 分享/属性正常                           |
| 未命中媒体白名单但 `assertFileReadPath` 通过 | 兜底放行                                                                                                             | 正常                                    |
| 未命中媒体白名单且 `assertFileReadPath` 拒绝 | 抛 `AppError.forbidden` → `wrapHandler` 捕获 → IPC 响应 `{ success:false, error:{ code: IPC_PATH_FORBIDDEN, ... } }` | 仅对真正越权路径显示“路径不在白名单内…” |
| `isMediaPathAllowed` 自身异常                | 函数内部保守返回 `false`，自动落入 `assertFileReadPath` 兜底，不静默放行                                             | 安全边界保留                            |
| 解码结果为空态（`notContained`）             | 渲染层展示空态文案 `infoPanel.paramNotContained`                                                                     | “不包含该参数”（不再是误导性错误）      |
| 解码真实错误                                 | 渲染层展示具体错误原因                                                                                               | 维持既有错误态                          |

- 所有受影响通道均经 `wrapHandler` 统一包装：zod 校验 → 成功 `{ success: true, data }` / 失败 `{ success: false, error }`。
- 渲染层 preload 层将 IPC 错误还原为 `IpcError`（含 `code` / `message` / `userMessage`），由 `useErrorToast` / 面板按 code 决定展示。

---

## 10. 参数校验

沿用既有 `wrapHandler` + zod schemas，**不新增、不放宽**：

| 通道                                 | schema                      | 约束                                            |
| ------------------------------------ | --------------------------- | ----------------------------------------------- |
| `share:copyFiles`                    | `filePathArrayBulk`（既有） | 路径数组，非空；相对路径/空串在 zod 层拒绝      |
| `share:startWifi`                    | 既有分享入参 schema         | 同上                                            |
| `file:getExif`                       | `filePath`（既有）          | `string`，`min(1).max(4096)`，相对路径/空串拒绝 |
| `video:thumbnail` / `video:metadata` | `filePath`（既有）          | 同上                                            |
| `decrypt:decodeFile`                 | `decryptFile`（既有）       | `filePath` / `albumType` / `uid?`，沿用         |

校验失败由 `wrapHandler` 统一返回“参数校验失败: ...”，不进入白名单/业务逻辑。

---

## 11. 基础测试用例

| 组  | 场景                             | 输入要点                                                        | 预期                                                                                                 | 验证点                         |
| --- | -------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------ |
| a   | 合法已索引媒体可读取/解析/分享   | `isMediaPathAllowed = true`                                     | 业务服务被调用；`assertFileReadPath` **零调用**                                                      | 媒体白名单命中即放行           |
| b   | 未命中媒体白名单但符合 PathGuard | `isMediaPathAllowed = false`，`assertFileReadPath` 不抛错       | 兜底放行，业务正常                                                                                   | 兜底路径生效                   |
| c   | 非法/越权路径拒绝                | 敏感目录、未注册盘符、相对路径等；两白名单均不放行              | 抛 `AppError.forbidden`（code `IPC_PATH_FORBIDDEN`）；**业务服务零调用**                             | 安全边界保留、零副作用         |
| d   | 分享/WiFi/属性解码关键错误路径   | 混合批次（合法+非法）整批拒绝、zod 校验失败、无参数文件、真错误 | 混合批次整批拒绝且不部分执行；zod 失败返回校验错误；无参数文件显示“不包含该参数”；真错误显示具体原因 | 双层守卫 + `notContained` 语义 |

---

## 12. 子任务拆分

> 约定：每个子任务“先验证通过，再进入下一步”。

### 子任务 1 — 新建 `assertMediaReadPath` 共享守卫

- **文件**：
  - 新增 `src/main/ipc/media-read-guard.ts`
  - 新增 `src/main/ipc/media-read-guard.test.ts`
- **输入**：`HandlerContext`（含 `dbManager`、`thumbnailGen`）、`filePath: string`
- **输出**：放行（`void`）或抛 `AppError.forbidden`
- **验收标准**：
  - 命中媒体白名单 → 放行，`assertFileReadPath` 零调用；
  - 未命中 → 回退 `assertFileReadPath`（放行或抛错）；
  - 越权路径 → 抛错，业务零调用；
  - 无循环依赖、无新增第三方依赖。
- **验证命令**：

  ```powershell
  npx vitest run src/main/ipc/media-read-guard.test.ts
  npx tsc -b
  npx eslint src/main/ipc/media-read-guard.ts src/main/ipc/media-read-guard.test.ts
  ```

### 子任务 2 — 分享域接入（`share:copyFiles` / `share:startWifi`）

- **文件**：
  - 修改 `src/main/ipc/handlers/share.ts`（第 32、62 行的读校验替换为 `assertMediaReadPath`；写目标校验保留）
  - 更新 `src/main/ipc/handlers/share.test.ts`
- **输入**：分享文件路径数组（单路径）
- **输出**：分享/复制结果；越权路径整批拒绝
- **验收标准**：合法已索引媒体分享成功；混合批次整批拒绝；写目标校验行为不变；既有测试无回归。
- **验证命令**：

  ```powershell
  npx vitest run src/main/ipc/handlers/share.test.ts
  ```

### 子任务 3 — EXIF / 视频只读通道接入

- **文件**：
  - 修改 `src/main/ipc/handlers/file.ts`（第 72 行 `file:getExif`）
  - 修改 `src/main/ipc/handlers/video.ts`（第 35 行 `video:thumbnail`、第 44 行 `video:metadata`）
  - 补充 `src/main/ipc/handlers/file.test.ts`（及对应既有视频测试）
- **输入**：媒体文件路径
- **输出**：EXIF / 缩略图 / 元数据结果
- **验收标准**：已索引媒体可正常取回信息；越权路径仍拒绝；**写通道一律不改**；既有测试无回归。
- **验证命令**：

  ```powershell
  npx vitest run src/main/ipc/handlers/file.test.ts
  npx vitest run src/main/ipc/handlers/video.test.ts
  ```

### 子任务 4 — `decrypt:decodeFile` 复用共享函数

- **文件**：修改 `src/main/ipc/handlers/decrypt-handler.ts`（第 31–35 行内联双层逻辑替换为 `assertMediaReadPath`）
- **输入**：`filePath` / `albumType` / `uid?`
- **输出**：解码结果（行为与现有修复完全一致）
- **验收标准**：行为零变化；既有两份测试（`decrypt-handler.test.ts` 及 `__tests__/decrypt-handler.test.ts`）全绿。
- **验证命令**：

  ```powershell
  npx vitest run src/main/ipc/handlers/decrypt-handler.test.ts
  npx vitest run src/main/ipc/handlers/__tests__/decrypt-handler.test.ts
  ```

### 子任务 5 — 渲染层语义区分（“不包含该参数”）

- **文件**：
  - 解码结果类型增加 `notContained` 字段（GameParamsData 相关类型）
  - 修改 `src/main/services/decryption-service.ts`：空态语义产出 `notContained: true`
  - 修改 `src/renderer/hooks/useGameParams.ts`：优先判断 `notContained` → 空态，不再走错误分支
  - 属性面板：为该状态配置 `emptyText`
  - i18n：新增 `infoPanel.paramNotContained`（各语言）；补齐 `main.validator.pathNotAllowed` 非中文 locale 文案
  - 更新/新增 `src/renderer/hooks/useGameParams.test.ts`
- **输入**：解码结果 `{ hasParams, notContained?, data?, error? }`
- **输出**：空态显示“不包含该参数”；真实错误显示具体原因
- **验收标准**：无参数文件显示空态文案；真错误仍显示错误；`check-i18n-keys` 全语言键齐全。
- **验证命令**：

  ```powershell
  npx vitest run src/renderer/hooks/useGameParams.test.ts
  npx tsx scripts/check-i18n-keys.ts
  ```

### 子任务 6 — 全链路回归

- **文件**：无代码改动（回归验证 + 文档回填）
- **输入**：任务 1–5 全部产物
- **输出**：回归报告，回填本文档“验证结论 / 改动文件清单 / 已知限制”章节
- **验收标准**：全部回归命令绿；手动验证步骤通过。
- **回归命令清单**：

  ```powershell
  npx vitest run src/main/ipc/media-read-guard.test.ts src/main/ipc/handlers/share.test.ts src/main/ipc/handlers/file.test.ts src/main/ipc/handlers/video.test.ts src/main/ipc/handlers/decrypt-handler.test.ts src/main/ipc/handlers/__tests__/decrypt-handler.test.ts src/main/app/__tests__/media-protocol.test.ts src/renderer/hooks/useGameParams.test.ts
  npm run typecheck
  npx eslint src/main/ipc src/main/ipc/handlers src/renderer/hooks
  npx tsx scripts/check-i18n-keys.ts
  ```

- **手动验证步骤**（`npm run dev` 启动后）：
  1. 图库选中已索引图片 → 分享 → 成功；
  2. WiFi 局域网分享 → 成功；
  3. 右键属性 → EXIF / 视频信息正常；
  4. 对不含游戏参数的文件 → 显示“不包含该参数”；
  5. 对含参数的文件 → 正常解码；
  6. 构造越权路径（如直接调用）仍被拒绝。

---

## 12A. 验收标准（总体）

> 本节汇总全部子任务的验收口径，6 条全部满足方可判定修复完成。

1. **双层守卫语义正确**：全部只读媒体通道（`share:startWifi` / `share:copyFiles` / `file:getExif` / `video:thumbnail` / `video:metadata` / `decrypt:decodeFile` / `editor:readMetadata`）命中媒体白名单时放行且 `assertFileReadPath` 零调用；未命中时兜底校验；越权路径抛 `IPC_PATH_FORBIDDEN` 且业务服务零调用；写/删除通道一律不改。
2. **敏感目录纵深防御**：`assertMediaReadPath` 快路径放行前经 `isSensitivePath` 黑名单复检（纯字符串匹配零 IO），敏感路径即使被媒体白名单命中也不走快路径，回落兜底后由黑名单拒绝，并有对应测试用例。
3. **`notContained` 空态语义端到端**：`decryption-service` 对不含 CameraParams 的文件返回 `{ hasParams: false, notContained: true }`（error 保留诊断）；渲染层 5 个面板（CameraInfo / Photography / NikkiInfo / Outfit / Interaction）展示“不包含该参数”空态且不展示误导性错误，真实错误仍走错误分支。
4. **i18n 全语言完整**：`infoPanel.paramNotContained` 与既有漂移键（`settings.profile.{virtualBadge,cleanupVirtual,cleanupVirtualConfirm,noVirtual,cleanupDone,cleanupPartial}` / `settings.scan.{importRootsAdd,importRootsAddScanning,importRootsAddSuccess,importRootsAddFailed}`）在 12 个 locale 均有真实译文（无空串），`scripts/check-i18n-keys.ts` 通过。
5. **自动化回归全绿**：定向测试与面板测试全部通过；`tsc -b` 零新增类型错误（既有基线错误与本次无关）；`eslint` 对改动文件 0 error；i18n 键对齐检查通过。
6. **安全边界不放宽**：不改 `PathGuard` 规则、不扩 `roots`、不改 zod schema、不动写/删除通道；越权用例验证业务零调用。

---

## 13. 风险与缓解

| 风险                                                              | 缓解措施                                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 共享守卫引入行为差异（与 `decrypt:decodeFile` 内联逻辑不一致）    | 任务 4 以“行为零变化”为验收标准，回归既有两份测试；共享函数与内联逻辑逐行等价                            |
| `isMediaPathAllowed` 缓存（5min TTL + LRU）与数据库变更短暂不一致 | 沿用既有缓存策略（与 `media://` 一致），最坏情况仅延迟放行，且回退 `assertFileReadPath` 兜底             |
| 安全边界意外放宽                                                  | 硬性约束：不改 `PathGuard`、不扩 `roots`、写/删除通道不动；用例组 (c) 显式验证越权路径仍拒绝且业务零调用 |
| 渲染层 `notContained` 语义误判真错误                              | 仅对“未找到 CameraParams 字段”这一明确空态置 `notContained`，其余错误仍走错误分支；测试覆盖两类分支      |
| i18n 键遗漏语言                                                   | `npx tsx scripts/check-i18n-keys.ts` 全语言校验，任务 5 验收强制项                                       |
| 混合批次部分执行                                                  | 整批拒绝语义保留：任一路径校验失败即整批失败，测试用例组 (d) 覆盖                                        |

---

## 14. 已拒绝的替代方案

| 方案                                             | 拒绝原因                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 批量场景用 DB `IN` 分片查询优化白名单判定        | 属于性能优化而非正确性修复；现有 5min TTL + LRU 缓存已足够，分享/属性为低频操作，引入分片徒增复杂度          |
| 启动时提前调用 `refreshPathGuardRoots` 刷新根    | 治标不治本：`roots` 与媒体库仍是两套数据源，动态导入/扫描后仍会漂移；且改变启动时序有额外风险                |
| 扩大 `PathGuard.roots`（如注册媒体文件所在目录） | 直接放宽审批面，违反“安全边界不放宽”约束；按文件粒度注册海量根也不现实                                       |
| 渲染层用字符串匹配“未找到 CameraParams”区分空态  | 脆弱：依赖文案稳定性与多语言一致性；改用结构化字段 `notContained`                                            |
| 引入第三方白名单/权限库                          | 问题本质是本项目两套自有白名单不同步的业务语义问题，第三方库无法表达“已入库媒体即可读”，纯增加依赖与漂移风险 |

---

## 15. 验证结论

全链路回归于 2026-08-28 执行完毕，**自动化验证全部通过**，各命令逐项结果如下：

### 15.1 定向回归测试（第一批）

命令：

```powershell
npx vitest run src/main/ipc/media-read-guard.test.ts src/main/ipc/handlers/share.test.ts src/main/ipc/handlers/file.test.ts src/main/ipc/handlers/video.test.ts src/main/ipc/handlers/decrypt-handler.test.ts src/main/ipc/handlers/__tests__/decrypt-handler.test.ts src/main/app/__tests__/media-protocol.test.ts src/main/app/__tests__/media-update.test.ts src/renderer/hooks/useGameParams.test.ts src/renderer/hooks/useExif.test.ts src/renderer/utils/share.test.ts src/renderer/pages/GalleryPage.share.test.tsx src/renderer/components/common/WifiShareDialog.test.tsx src/main/services/decryption-service
```

结果：**✅ 通过，15 个测试文件 / 194 个用例全部通过，无跳过文件**（清单中所有目标测试文件均存在）。各文件用例数：

| 测试文件                                                   | 用例数 | 结果 |
| ---------------------------------------------------------- | ------ | ---- |
| `src/main/ipc/media-read-guard.test.ts`                    | 5      | ✅   |
| `src/main/ipc/handlers/share.test.ts`                      | 13     | ✅   |
| `src/main/ipc/handlers/file.test.ts`                       | 9      | ✅   |
| `src/main/ipc/handlers/video.test.ts`                      | 18     | ✅   |
| `src/main/ipc/handlers/decrypt-handler.test.ts`            | 7      | ✅   |
| `src/main/ipc/handlers/__tests__/decrypt-handler.test.ts`  | 3      | ✅   |
| `src/main/app/__tests__/media-protocol.test.ts`            | 21     | ✅   |
| `src/main/app/__tests__/media-update.test.ts`              | 16     | ✅   |
| `src/main/services/decryption-service.test.ts`             | 27     | ✅   |
| `src/main/services/decryption-service.integration.test.ts` | 12     | ✅   |
| `src/renderer/hooks/useGameParams.test.ts`                 | 21     | ✅   |
| `src/renderer/hooks/useExif.test.ts`                       | 15     | ✅   |
| `src/renderer/utils/share.test.ts`                         | 8      | ✅   |
| `src/renderer/pages/GalleryPage.share.test.tsx`            | 7      | ✅   |
| `src/renderer/components/common/WifiShareDialog.test.tsx`  | 12     | ✅   |

### 15.2 渲染层面板相关测试（第二批）

命令：

```powershell
npx vitest run src/renderer/components/common/CameraInfoPanel src/renderer/components/common/PhotographyPanel src/renderer/components/common/PropertiesDialog
```

结果：**✅ 通过，3 个测试文件 / 66 个用例全部通过**：

| 测试文件                    | 用例数 | 结果 |
| --------------------------- | ------ | ---- |
| `CameraInfoPanel.test.tsx`  | 24     | ✅   |
| `PhotographyPanel.test.tsx` | 25     | ✅   |
| `PropertiesDialog.test.tsx` | 17     | ✅   |

### 15.3 类型检查（`npm run typecheck`，即 `tsc -b`）

结果：**✅ 判定通过（零新增错误）**。共 25 个类型错误，全部命中既有错误基线（约 24–25 个），涉及文件为 `recovery.ts`、`connection.ts`、`media-repository.ts`、`scan-log-handler.ts`、`game-directory-discovery.ts`、`worker-entry.ts`、`ErrorFallback.stories.tsx`、`useFilteredMediaFiles.test.ts`、`mediaStore.integration.test.ts`、`mediaStore.ts`，**均不在本次改动文件内**。已用 `git status` 交叉确认本次改动文件零新增类型错误。详见第 17 节已知限制 (a)。

### 15.4 ESLint（对全部改动文件）

命令（26 个本次改动源码/测试文件统一执行）：

```powershell
npx eslint src/main/ipc/media-read-guard.ts src/main/ipc/media-read-guard.test.ts src/main/ipc/handlers/decrypt-handler.ts src/main/ipc/handlers/file.ts src/main/ipc/handlers/file.test.ts src/main/ipc/handlers/share.ts src/main/ipc/handlers/share.test.ts src/main/ipc/handlers/video.ts src/main/ipc/handlers/video.test.ts src/main/services/decryption-service.ts src/main/types/decryption.ts src/renderer/components/common/CameraInfoPanel.tsx src/renderer/components/common/CameraInfoPanel.test.tsx src/renderer/components/common/InteractionPanel.tsx src/renderer/components/common/NikkiInfoPanel.tsx src/renderer/components/common/OutfitPanel.tsx src/renderer/components/common/PhotographyPanel.tsx src/renderer/components/common/PhotographyPanel.test.tsx src/renderer/hooks/useGameParams.ts src/renderer/hooks/useGameParams.test.ts src/renderer/types/decryption.ts src/renderer/vite-env.d.ts src/renderer/styles/globals.css
```

结果：**✅ 通过，0 errors**。仅 1 条 warning：`globals.css` 无匹配的 ESLint 配置被忽略（该项目 ESLint 未配置 CSS 语法支持，属项目既有配置现状，与本次改动无关）。

### 15.5 i18n 键对齐检查（`npx tsx scripts/check-i18n-keys.ts`）

结果：**✅ 通过**。全部 12 个 locale（zh-CN / zh-TW / en / ja / ko / de / es / fr / pt / ru / th / vi）key 对齐，各 3555 keys；`infoPanel.paramNotContained` 与 `main.validator.pathNotAllowed` 全语言齐全。

### 15.6 总结论

- 自动化回归：**全部通过**（18 个测试文件 / 260 个用例全绿；类型检查零新增错误；ESLint 0 error；i18n 全语言对齐）。
- 安全边界：未放宽任何校验（`PathGuard` 规则、`roots`、黑名单、zod schema 均未改动），越权路径用例（组 c）验证业务零调用。
- 手动验证：**待用户执行**，建议步骤见第 17 节已知限制 (c)。

### 15.7 三维代码评审缺口修复后的回归（2026-08-28 第二轮）

针对评审发现的 8 项缺口（非中文译文补齐、漂移键补齐、`editor:readMetadata` 接入、`decryption-service` notContained 用例、快路径敏感目录黑名单复检、`video:thumbnail` 白名单用例、3 个面板 notContained 用例、文档补强）修复后统一回归：

**第一批（定向测试，含新增 `editor-metadata-handler.test.ts`）**：

```powershell
npx vitest run src/main/ipc/media-read-guard.test.ts src/main/ipc/handlers/share.test.ts src/main/ipc/handlers/file.test.ts src/main/ipc/handlers/video.test.ts src/main/ipc/handlers/decrypt-handler.test.ts src/main/ipc/handlers/__tests__/decrypt-handler.test.ts src/main/services/decryption-service.test.ts src/renderer/hooks/useGameParams.test.ts src/main/ipc/handlers/editor-metadata-handler.test.ts
```

结果：**✅ 通过，9 个测试文件 / 109 个用例全部通过**：

| 测试文件                                                  | 用例数                    | 结果 |
| --------------------------------------------------------- | ------------------------- | ---- |
| `src/main/ipc/media-read-guard.test.ts`                   | 6（+1 快路径黑名单复检）  | ✅   |
| `src/main/ipc/handlers/share.test.ts`                     | 13                        | ✅   |
| `src/main/ipc/handlers/file.test.ts`                      | 9                         | ✅   |
| `src/main/ipc/handlers/video.test.ts`                     | 19（+1 thumbnail 白名单） | ✅   |
| `src/main/ipc/handlers/decrypt-handler.test.ts`           | 7                         | ✅   |
| `src/main/ipc/handlers/__tests__/decrypt-handler.test.ts` | 3                         | ✅   |
| `src/main/services/decryption-service.test.ts`            | 28（+1 notContained）     | ✅   |
| `src/renderer/hooks/useGameParams.test.ts`                | 21                        | ✅   |
| `src/main/ipc/handlers/editor-metadata-handler.test.ts`   | 3（新建）                 | ✅   |
| `src/main/ipc/handlers/editor.test.ts`（补充回归）        | 22                        | ✅   |

**第二批（5 个面板）**：

```powershell
npx vitest run src/renderer/components/common/CameraInfoPanel.test.tsx src/renderer/components/common/PhotographyPanel.test.tsx src/renderer/components/common/NikkiInfoPanel.test.tsx src/renderer/components/common/OutfitPanel.test.tsx src/renderer/components/common/InteractionPanel.test.tsx
```

结果：**✅ 通过，5 个测试文件 / 101 个用例全部通过**（CameraInfoPanel 24 / PhotographyPanel 25 / NikkiInfoPanel 17（+1）/ OutfitPanel 18（+1）/ InteractionPanel 17（+1））。

**类型检查**：`npx tsc -b` 报 25 个错误，全部命中既有基线（见 17(a)），本次改动文件零新增错误。**✅**

**ESLint**：对本轮全部改动文件执行，**0 errors / 0 warnings**。**✅**

**i18n 键对齐**：`npx tsx scripts/check-i18n-keys.ts` 12 个 locale 各 3555 keys 全部对齐；另经全量 grep 确认目标键（`paramNotContained` 及 10 个漂移键）在 12 个 locale 均无空串残留。**✅**

---

## 16. 改动文件清单

以下为本次修复实际新增/修改的全部文件（经 `git status` / `git diff` 核实；不含与本修复无关的并行改动，如 `share-wifi-service.ts`、`ShareMenuButton.tsx`、`globals.css` 分属其他计划）：

### 主进程（新增）

| 文件                                    | 改动摘要                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/main/ipc/media-read-guard.ts`      | **新增**：共享媒体读取守卫 `assertMediaReadPath`（媒体白名单 `isMediaPathAllowed` 优先 + `assertFileReadPath` 兜底） |
| `src/main/ipc/media-read-guard.test.ts` | **新增**：共享守卫单测（媒体命中放行 / 兜底 / 越权拒绝 / `isMediaPathAllowed` 异常保守回退）                         |

### 主进程（修改）

| 文件                                       | 改动摘要                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `src/main/ipc/handlers/share.ts`           | `share:startWifi` / `share:copyFiles` 读校验改用 `assertMediaReadPath`（双层语义）；写目标校验保留 |
| `src/main/ipc/handlers/share.test.ts`      | 更新为双层语义用例（媒体白名单命中放行、兜底、混合批次整批拒绝）                                   |
| `src/main/ipc/handlers/file.ts`            | `file:getExif` 改用 `assertMediaReadPath`                                                          |
| `src/main/ipc/handlers/file.test.ts`       | 补充双层守卫用例                                                                                   |
| `src/main/ipc/handlers/video.ts`           | `video:thumbnail` / `video:metadata` 改用 `assertMediaReadPath`                                    |
| `src/main/ipc/handlers/video.test.ts`      | 补充双层守卫用例                                                                                   |
| `src/main/ipc/handlers/decrypt-handler.ts` | `decrypt:decodeFile` 内联双层逻辑替换为共享函数 `assertMediaReadPath`，行为零变化                  |
| `src/main/services/decryption-service.ts`  | `cameraParamsNotFound` 分支置 `notContained: true`（空态语义，区别于真实错误）                     |
| `src/main/types/decryption.ts`             | `DecryptionResult` 增加可选字段 `notContained`                                                     |

### 渲染进程（修改）

| 文件                                                                | 改动摘要                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `src/renderer/types/decryption.ts`                                  | `GameParamsData` 增加可选字段 `notContained`                         |
| `src/renderer/vite-env.d.ts`                                        | `WindowElectronAPI` 中 `decryptFile` 返回类型同步增加 `notContained` |
| `src/renderer/hooks/useGameParams.ts`                               | 优先判断 `notContained` → 空态，不再走错误分支                       |
| `src/renderer/hooks/useGameParams.test.ts`                          | 更新/新增用例（空态与真实错误两类分支）                              |
| `src/renderer/components/common/CameraInfoPanel.tsx` + `.test.tsx`  | 空态显示“不包含该参数”（`emptyText`）                                |
| `src/renderer/components/common/PhotographyPanel.tsx` + `.test.tsx` | 同上                                                                 |
| `src/renderer/components/common/InteractionPanel.tsx`               | 同上                                                                 |
| `src/renderer/components/common/NikkiInfoPanel.tsx`                 | 同上                                                                 |
| `src/renderer/components/common/OutfitPanel.tsx`                    | 同上                                                                 |

### i18n（12 个 locale）

`src/renderer/i18n/locales/` 下：`zh-CN.json`、`zh-TW.json`、`en.json`、`ja.json`、`ko.json`、`de.json`、`es.json`、`fr.json`、`pt.json`、`ru.json`、`th.json`、`vi.json`

- 新增 `infoPanel.paramNotContained`（“不包含该参数”）；
- 补齐 `main.validator.pathNotAllowed` 非中文 locale 缺失文案。

### 第二轮（三维代码评审缺口修复，2026-08-28）

| 文件                                                                                    | 改动摘要                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/ipc/handlers/editor-metadata-handler.ts`                                      | **修改**：`editor:readMetadata`（纯只读元数据通道）读路径校验改用 `assertMediaReadPath` 双层校验；导出/写通道不动                                                                                                                                                                                                                                  |
| `src/main/ipc/handlers/editor-metadata-handler.test.ts`                                 | **新增**：`editor:readMetadata` 双层守卫用例（白名单命中放行 / 越权拒绝 / PathGuard 兜底），模式参照 `file.test.ts` 的 getExif 用例                                                                                                                                                                                                                |
| `src/main/ipc/media-read-guard.ts`                                                      | **修改**：快路径增加敏感目录黑名单复检（`isSensitivePath`，纯字符串匹配零 IO）；模块注释记录“IPC 快路径未做 realpath 归一”的有意取舍（该取舍已于第三轮收敛为 realpath 复检，见 §17(e)）                                                                                                                                                            |
| `src/main/ipc/media-read-guard.test.ts`                                                 | **修改**：补“敏感路径即使命中媒体白名单（mock=true）仍被拒绝”用例                                                                                                                                                                                                                                                                                  |
| `src/main/ipc/handlers/video.test.ts`                                                   | **修改**：补 `video:thumbnail` 媒体白名单命中用例（成功且 `assertFileReadPath` 零调用、`thumbnailGen.generate` 被调用）                                                                                                                                                                                                                            |
| `src/main/services/decryption-service.test.ts`                                          | **修改**：补不含 CameraParams 输入返回 `{ hasParams: false, notContained: true }` 且 error 保留诊断信息的用例                                                                                                                                                                                                                                      |
| `src/renderer/components/common/InteractionPanel.test.tsx`                              | **修改**：补 notContained 空态用例（data-error 为空、文案“不包含该参数”）                                                                                                                                                                                                                                                                          |
| `src/renderer/components/common/NikkiInfoPanel.test.tsx`                                | **修改**：同上                                                                                                                                                                                                                                                                                                                                     |
| `src/renderer/components/common/OutfitPanel.test.tsx`                                   | **修改**：同上                                                                                                                                                                                                                                                                                                                                     |
| `src/renderer/i18n/locales/*.json`（11 个 locale：en/de/es/fr/ja/ko/pt/ru/th/vi/zh-TW） | **修改**：`infoPanel.paramNotContained` 填入真实译文；补齐 10 个漂移键（`settings.profile.{virtualBadge,cleanupVirtual,cleanupVirtualConfirm,noVirtual,cleanupDone,cleanupPartial}` / `settings.scan.{importRootsAdd,importRootsAddScanning,importRootsAddSuccess,importRootsAddFailed}`）译文（en.json 该 10 键已存在，仅补 `paramNotContained`） |

### 第三轮（读路径快路径符号链接绕过修复，2026-08-29）

| 文件                                    | 改动摘要                                                                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/ipc/media-read-guard.ts`      | **修改**：快路径命中后追加 `fs.realpathSync.native` 敏感目录复检，真实路径落敏感目录时回落 `assertFileReadPath(real)`；realpath 失败维持放行；模块注释改写为现行口径 + 残留面说明（见 §17(e)）            |
| `src/main/ipc/media-read-guard.test.ts` | **修改**：以 `importOriginal` 部分 mock `fs`（仅接管 `realpathSync.native`），新增 3 个用例：real 敏感 → 拒绝且以 real 路径回落 / realpath 抛错 → 放行 / real 非敏感 → 放行且 `assertFileReadPath` 零调用 |

调用方（`decrypt-handler` / `file` / `video` / `share` / `editor-metadata-handler`）与 `media-protocol.ts` 均未改动，仅纳入回归验证范围。

---

## 17. 已知限制

### (a) 工作区既有类型错误基线（与本次改动无关）

`npm run typecheck`（`tsc -b`）报 25 个错误，均为改动前既有基线，涉及文件：

- `src/main/app/recovery.ts`（1 处）
- `src/main/database/connection.ts`（4 处）
- `src/main/database/media-repository.ts`（5 处）
- `src/main/ipc/handlers/scan-log-handler.ts`（2 处）
- `src/main/scanner/game-directory-discovery.ts`（3 处）
- `src/main/scanner/worker-entry.ts`（2 处）
- `src/renderer/components/common/ErrorFallback.stories.tsx`（2 处）
- `src/renderer/hooks/useFilteredMediaFiles.test.ts`（2 处）
- `src/renderer/stores/mediaStore.integration.test.ts`（1 处）
- `src/renderer/stores/mediaStore.ts`（2 处）

已用 `git status` 核实上述文件均不在本次改动范围内，本次改动文件零新增类型错误；判定为已知限制，不在本修复范围内处理。

### (b) 批量分享逐路径校验未做批量化优化

`share:copyFiles` 等批量场景对每个路径逐一调用 `assertMediaReadPath`，依赖 `isMediaPathAllowed` 的 5 分钟 TTL + LRU 缓存。数千路径的极端批量场景未做 DB `IN` 分片等批量化优化（见第 14 节已拒绝替代方案）；日常分享/属性为低频操作，实际影响有限。

### (c) 手动验证待用户执行

本次回归仅覆盖自动化测试，未启动完整应用做手动冒烟，**手动验证待用户执行**。建议步骤（`npm run dev` 启动后）：

1. 图库选中已索引图片 → 分享（复制文件）→ 确认不再报“路径不在白名单内，禁止读取操作”；
2. WiFi 局域网分享 → 发起分享 → 确认成功；
3. 右键图片 → 属性 → EXIF / 视频信息 / 游戏参数正常显示；
4. 对不含游戏参数的文件 → 确认各面板显示“不包含该参数”（而非错误态）；
5. 对含参数的文件 → 确认正常解码；
6. （可选）构造越权路径直接调用 → 确认仍被拒绝（安全边界保留）。

### (d) 其他语义边界（沿用计划约定）

- 媒体白名单缓存（5min TTL + LRU）与数据库变更存在短暂不一致窗口：最坏情况仅延迟放行，未命中时回退 `assertFileReadPath` 兜底，安全边界不变；
- `notContained` 空态判定仅适用于游戏参数解码（“未找到 CameraParams 字段”这一明确空态），其余错误仍走错误分支；
- 写/删除类通道（含分享中的写目标目录校验）本次不改，审批校验原样保留。

### (e) IPC 快路径 realpath 归一（第二轮的“有意取舍”已于第三轮收敛，2026-08-29）

**第二轮结论（已作废）**：`assertMediaReadPath` 快路径仅做纯字符串匹配，不做符号链接解析，符号链接攻击面“由快路径的 `isSensitivePath` 字符串黑名单 + 未命中时的 PathGuard 兜底覆盖”。

**该假设不成立**：快路径命中时 PathGuard **根本不执行**。在已索引媒体目录内放置“媒体扩展名的符号链接 / junction”（如 `D:\Game\X6Game\ScreenShot\evil.jpg → %USERPROFILE%\.aws\credentials`）时，`isSensitivePath(入参)` 为 false（路径本身不含敏感段）、`isMediaPathAllowed` 为 true（位于已索引 `source_path` 下 + 媒体扩展名），于是直接 `return` 放行，可读取任意文件内容。Windows 非管理员虽默认不能建符号链接，但 junction / hardlink 可以。

**第三轮修复（现行口径）**：快路径命中后追加一次 `fs.realpathSync.native` 复检，`isSensitivePath(real)` 命中即回落 `assertFileReadPath(real)`，由 PathGuard 统一抛 `AppError.forbidden`（`IPC_PATH_FORBIDDEN`）；`realpath` 失败（ENOENT/EACCES）维持放行，交由下游读取自行报错（与写通道 `validateNonSensitivePath` 的“失败放行”一致）。

- **IO 约定不变**：同步 IO 只在快路径命中分支付出（前提是路径已在已索引媒体目录内），未命中分支仍零 IO，“热路径无 IO”的整体约定保留；
- **不缓存 realpath**：缓存有效期内把普通文件替换为软链即可绕过（TOCTOU），故每次命中都真实 syscall。与 `media-protocol.ts` 的 `realpathCache`（显示链路性能优先）取舍不同，属有意差异；
- **已知残留面（有意取舍）**：复检只比对敏感目录黑名单，**不**重跑 `isMediaPathAllowed(ctx, real)`，因此软链指向“非敏感的普通文件”（如 `D:\Work\合同.pdf`）仍可被读取，与 `media://` 的 `resolveRealPath` + 白名单复检口径仍有差异；进一步收紧需同时评估“用户媒体目录本身位于 junction 上”的兼容性；
- 现行口径与残留面已记录于 `src/main/ipc/media-read-guard.ts` 模块注释，回归用例见 `media-read-guard.test.ts`（realpath 敏感 → 拒绝并以 real 路径回落 / realpath 抛错 → 放行 / real 非敏感 → 放行）。
