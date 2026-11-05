# 完整搭配码面板 — 阶段 3：搭配码网络结果本地缓存 实施计划

> 日期：2026-10-31
> 前置：阶段 0（契约冻结）/ 阶段 1（structured 解析）/ 阶段 2（gongeo 服饰数据 service）已交付。
> 状态：计划经确认后执行，执行记录见文末。

## 1. 背景与目标

当前每次粘贴搭配码都走 `decrypt:decodeClothDiy` → `decodeClothDiyShareCode` → `decodeNetworkGraceful` → utilityProcess 子进程（`src/main/decryption-worker/`）打叠纸服务器。同一码短时间重复打开会重复请求。

本阶段目标：**同一搭配码在本地有缓存时跳过子进程网络解码，直接用缓存的原始 networkData 字符串走阶段 1 的结构化解析**。value 存原始字符串（非结构化结果），解析逻辑更新后旧缓存仍可用。

## 2. 依赖声明

无新增 npm 依赖。仅使用：

- Node 内置：`crypto`（sha256）、`fs/promises`、`path`
- 仓库现有工具：`src/main/utils/atomic-file.ts` 的 `writeFileAtomic`（临时文件 + rename 原子写）、`src/main/utils/logger.ts`
- Electron：`app.getPath('userData')`（缓存根缺省来源）

## 3. 启动说明（环境 / 命令 / 验证）

- 环境准备：无（本机已具备 Node + 依赖；不执行 `npm install`）。
- 开发验证：`npm run dev` 手工链路（粘贴同码两次，观察日志命中）——本阶段无 UI 改动，主验证走单测。
- 自动验证：
  - `npx vitest run src/main/services/cloth-diy-cache.test.ts`
  - `npx vitest run src/main/services/decryption-service.test.ts`
  - `npx vitest run src/main/ipc/handlers/decrypt-handler.clearClothCache.test.ts src/main/preload/__tests__/preload.test.ts`
  - 收尾：`npm run verify`（typecheck + eslint 只读 + core-gate + prettier --check + 相关单测）+ `npm test` 全量。

## 4. 设计决策

| 决策       | 结论                                                   | 依据                                                                                                                                                            |
| ---------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 清理通道   | 新增 `decrypt:clearClothCache`（任务预设「否则」分支） | 现有「清理缓存」设置项是缩略图缓存专用（`cache:clean` → `ThumbnailGenerator.cleanAll`，与 LRU/统计/自定义目录耦合），纳入需改既有通道语义并动 UI；本阶段不做 UI |
| TTL        | 无。容量增长由 clear 通道兜底                          | 同一码的网络内容视为不可变；如需按期过期可后续基于 mtime 扩展                                                                                                   |
| 缓存 key   | `sha256(codeStr.trim())` hex                           | trim 归一化提升命中率；非法码在缓存逻辑之前已返回，永不入缓存                                                                                                   |
| 缓存 value | 原始 networkData 字符串（utf8）                        | 任务要求：解析逻辑更新后旧缓存仍可用                                                                                                                            |
| 缓存目录   | `<userData>/cloth-diy-cache/<hash>.txt`                | 仓库 userData 子目录约定（thumbnails/logs/crashes 同层）；路径可预测                                                                                            |
| 范围       | 仅 clothDiy；homeBuild 不缓存；不做在途去重            | 任务范围限定；并发同码 → 原子写覆盖同内容，无害                                                                                                                 |
| i18n       | 零改动，日志中文硬编码                                 | 沿用 `parseClothDiyNetworkData` 内中文日志先例                                                                                                                  |

## 5. 各子任务（文件 / 输入 / 输出 / 验收标准）

### 5.1 新模块 `src/main/services/cloth-diy-cache.ts`（新增，需 @core-change 注释）

- **输入**：`codeStr: string`、`networkData: string`
- **输出**：
  - `setClothDiyCacheRoot(root: string | null): void` — 注入缓存根（测试/DI seam；null 回缺省）
  - `getClothDiyCachePath(codeStr: string): string | null` — 可预测路径 `<root>/<sha256hex>.txt`
  - `readClothDiyCache(codeStr): Promise<string | undefined>` — 命中返回字符串；任何读错误/空内容 → undefined（未命中）；命中打 debug（hash 前 8 位，不打完整码）
  - `writeClothDiyCache(codeStr, networkData): Promise<boolean>` — mkdir recursive + `writeFileAtomic`；任何失败 warn 后返回 false，绝不抛错、不阻塞主流程；成功打 debug
  - `clearClothDiyCache(): Promise<{ clearedCount: number; clearedSize: number }>` — 目录不存在 → `{0,0}`；单文件失败跳过并 warn；readdir 失败直接 throw（handler 层统一转 IPC 错误）
- **缺省根**：`path.join(app.getPath('userData'), 'cloth-diy-cache')`，解析失败 → null = 缓存禁用，不阻塞解码。
- **验收**：`cloth-diy-cache.test.ts` 全绿（用例见 §6.1）。

### 5.2 `decodeClothDiyShareCode` 接入（`src/main/services/decryption-service.ts`，需替换 @core-change 注释）

- **输入/输出**：函数签名与返回结构零变化。
- **改动**：本地提取成功后、`decodeNetworkGraceful` 前：
  1. `readClothDiyCache(codeStr)` 命中 → 以 `{ networkData: cached }` 代替网络结果（跳过子进程桥，离线可用）；
  2. 未命中 → 原网络流程；成功（有 networkData）→ `writeClothDiyCache`（await，失败仅 warn）；
  3. 网络失败（无 networkData）不写缓存。
- **验收**：`decryption-service.test.ts` 全绿（用例见 §6.2），存量用例无回归。

### 5.3 `decrypt:clearClothCache` 通道（`decrypt-handler.ts` / `preload/api/decrypt.ts` / `electron-api.ts` / `vite-env.d.ts` / `docs/IPC_CONTRACT.md`）

- **输入**：无参。
- **输出**：内层 `{ ok: true, data: { clearedCount, clearedSize } }`；共享类型 `ClearClothCacheResponse` 登记于 `src/shared/types/electron-api.ts`；preload `electronAPI.decrypt.clearClothCache()`；IPC_CONTRACT 追加 §15。
- **验收**：`decrypt-handler.clearClothCache.test.ts` + `preload.test.ts` 全绿（用例见 §6.3）。

### 5.4 @core-change 授权注释（核心路径闸门）

| 文件                       | 新注释（替换旧注释，旧原因不复用）                                           |
| -------------------------- | ---------------------------------------------------------------------------- |
| `decryption-service.ts:1`  | `// @core-change: 搭配码网络解码结果接入本地磁盘缓存（阶段 3）`              |
| `decrypt-handler.ts:1`     | `// @core-change: 新增 decrypt:clearClothCache 搭配码缓存清理通道（阶段 3）` |
| `preload/api/decrypt.ts:1` | `// @core-change: decrypt 命名空间新增 clearClothCache 方法（阶段 3）`       |
| `cloth-diy-cache.ts`（新） | `// @core-change: 新增搭配码网络结果磁盘缓存服务（阶段 3）`                  |

`electron-api.ts` / `vite-env.d.ts` / 测试文件不在保护范围，不加。

## 6. 错误处理 / 参数校验 / 测试用例

### 6.1 错误处理与兜底

| 分支                               | 行为                                                            |
| ---------------------------------- | --------------------------------------------------------------- |
| 读缓存失败（不存在/权限/损坏）     | 视为未命中 → 走网络                                             |
| 写缓存失败（磁盘满/只读/路径异常） | warn 日志 + 返回 false，主流程（解码结果）照常返回              |
| `app.getPath` 不可用               | 缓存禁用（根为 null），解码不受影响                             |
| clear 时目录不存在                 | 返回 `{0,0}` 不抛错                                             |
| clear 时单文件删除失败             | 跳过该文件并 warn，继续清其余                                   |
| clear 时 readdir 失败              | 直接 throw，由 `wrapHandlerNoArgs` 的 `handleError` 转 IPC 错误 |

### 6.2 参数校验

- IPC 层：`decrypt:clearClothCache` 无参（`wrapHandlerNoArgs` 无校验面）；`decrypt:decodeClothDiy` 既有 zod（1B–1MB）不变。
- service 层：`readClothDiyCache`/`writeClothDiyCache` 对 `codeStr` 做 `trim()` 后哈希；空 `networkData` 不写缓存（write 直接返回 false）。

### 6.3 基础测试用例（正常 / 异常 / 边界）

**§6.3.1 `cloth-diy-cache.test.ts`**（临时目录注入，不污染真实用户数据）

- 正常：默认根解析（不注入 → 文件落在 mocked `app.getPath('userData')/cloth-diy-cache`）；write→read 往返一致；文件名 = `sha256(trim(code)).txt`；trim 归一化（`' code '` 命中 `'code'` 的缓存）；clear 清空并返回计数与字节数。
- 异常：读未命中 → undefined；空内容文件 → undefined；`getPath` 抛错 → 缓存禁用兜底（read undefined / write false）。
- 边界：写失败（根注入为已存在的普通文件，mkdir 失败）→ false 且不抛；clear 目录不存在 → `{0,0}` 不抛。

**§6.3.2 `decryption-service.test.ts` 新增 describe**（复用 `setupClothDiyLocal()` / `installBridge()`；文件级 beforeEach 注入每用例隔离缓存根，防止同文件存量用例经缺省根互相污染）

- ① 首次未命中→网络→写盘（`decodeNetwork` 1 次；缓存文件内容 === networkData）
- ② 同一码二次调用命中缓存：`decodeNetwork` 调用次数仍为 1；结果一致（含 structured）
- ③ 删除缓存文件后再次调用重走网络（`decodeNetwork` 第 2 次）
- ④ 网络失败（status≠0 与 `ok:false` 两形态）不写缓存（缓存目录为空）且二次仍走网络
- ⑤ 缓存命中 + 桥未注入 → 仍返回 networkData、error 为 undefined（离线复用）
- ⑥ 写盘失败不阻塞主流程（根指向普通文件 → success:true + networkData 照常返回）

**§6.3.3 `decrypt-handler.clearClothCache.test.ts`**（仿 `decrypt-handler.lookupCloth.test.ts`，真实 wrapHandler 面）

- 调用透传：service 返回 `{3, 123}` → `{success:true, data:{ok:true, data:{clearedCount:3, clearedSize:123}}}`，service 被调 1 次
- service 抛错 → `success:false`，不崩溃

## 7. 明确不做

- 不改 `cloth-data-service.ts` / `cloth-data-config.ts`（阶段 2 内存缓存不动）
- 不改 UI / settings 页 / i18n locale / homeBuild 缓存 / TTL / 缓存加密
- 不修存量类型漂移（`DecodeClothDiyResponse.networkData: unknown`、缺 `structured` 等）
- 不补录 IPC_CONTRACT 既有 4 通道的存量缺口（§14 已注明）

## 8. 执行记录（2026-10-31 完成）

TDD 红-绿读数（每节点先确认红灯再实现）：

| 节点         | 红灯                                                    | 绿灯                                                                    |
| ------------ | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1 缓存模块   | 模块不存在 → 1 suite 失败                               | `cloth-diy-cache.test.ts` 9/9                                           |
| 2 解码接入   | 6 个新缓存用例失败 / 55 存量全绿                        | `decryption-service.test.ts` 61/61                                      |
| 3 clear 通道 | 2 用例失败（`未找到 channel: decrypt:clearClothCache`） | `decrypt-handler.clearClothCache.test.ts` 2/2 + `preload.test.ts` 20/20 |

回归与全局校验：

- `npm run verify`：5/5 通过（typecheck / lint / core-gate / format / 相关单测 70）。
  过程中修复 2 项：① 测试未用变量 `r2` 补断言；② `check-md-links` 守卫判 §15 引用
  `cloth-diy-cache.ts` 为死引用（新文件未入仓）——按 §14 阶段 2 同款口径补
  「未纳入版本控制、随本批提交入仓」标注后转绿。
- `npm test` 全量：**7186 passed / 0 failed / 20 skipped**。
- `npm run lint` 全量、`npm run typecheck:e2e`：零输出通过。
- 全程零 i18n 改动（无需 `i18n:guard`）；未新增 npm 依赖。

实现与计划的偏差：仅一处测试设计修正——「网络失败不写缓存」「写盘失败不阻塞」两个负向
用例单独存在时实现前即为绿（违反红-绿硬性要求），已分别重组为「失败→随后成功才写入」
「写盘失败→恢复根后可正常缓存」的复合序列，保证实现前可红。
