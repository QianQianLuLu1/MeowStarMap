# 修复「删除」报错：路径不在白名单内，禁止 读取 操作

> 状态：实施中（2026-09-01）
> 关联：docs/plans/fix-path-whitelist-read-forbidden.md（读通道对齐，本计划为删除通道补全）、docs/plans/fix-specified-dir-whitelist.md（userPicked 机制）

---

## 1. 问题与根因

### 1.1 现象

图库删除（移入回收站 / 彻底删除）时右下角 Toast 报错「路径不在白名单内，禁止 读取 操作」。期望：自动识别的游戏目录、用户自定义/指定的任意已展示目录中的图片/视频均可正常删除。

### 1.2 删除链路

```
渲染层 useFileOperations.deleteFiles / DetailPage.handleDelete
  → window.electronAPI.file.delete([file_path]) / file.deletePermanent([...])
    → 主进程 file:delete / file:deletePermanent（src/main/ipc/handlers/file.ts）
      → for (const p of filePaths) assertFileReadPath(p)   ← 拦截点
        → PathGuard.isAllowed（src/main/ipc/validator.ts）
```

### 1.3 根因（已探明）

| #   | 根因                          | 说明                                                                                                                                                                                                                                         |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 敏感目录黑名单硬拒            | `PathGuard.isAllowed` 第 1 步 `isSensitivePath`（`X:\Windows` / `Program Files` / `Program Files (x86)` / `ProgramData` / UNC 管理共享 / 主目录凭据目录）无条件拒绝且优先于已注册 roots。游戏装在 Steam 默认路径下时删除必现。               |
| R2  | userPicked 短路未接入删除通道 | commit `6f9aced` 的 userPicked 放行仅接入 scanner:start / customKnownPaths / settings 三处；删除通道未接入。且 userPicked 为内存态，重启丢失。                                                                                               |
| R3  | 已入库但目录未注册            | 重启后 roots 依赖 `refreshPathGuardRoots`（media_files.source_path + customScanPaths + import_roots）恢复；source_path 为 NULL/空或 file_path 不在 source_path 下（移动/改名后）的记录被默认拒绝。                                           |
| R4  | 安全口径不一致                | `media:permanentDelete` / `media:emptyRecycleBin` 经 trashBatch 对 DB 中 file_path 执行 `shell.trashItem`，完全无路径白名单校验；`media://` 协议对已入库 file_path 精确放行。同一文件"能显示、能彻底删除"，却无法经 file:delete 移入回收站。 |

---

## 2. 修复方案（最小改动）

在 `src/main/ipc/media-read-guard.ts` 新增导出函数 `assertMediaDeletePath(ctx, filePath)`，三级判定：

1. `pathGuard.isUserPicked(filePath)` 命中 → 放行（用户对话框显式授权，与 scanner:start B1 短路同语义）；
2. `isMediaPathAllowed(ctx, filePath)` 命中 → 放行（已入库 file_path 精确匹配 / 原生缩略图 / 已索引 source_path 下媒体扩展名文件，与 media:// 展示授权同口径）；
3. 否则 `assertFileReadPath(filePath)` 兜底：任意未入库路径（含敏感目录下未入库文件）仍被拒，安全边界不放宽。

`src/main/ipc/handlers/file.ts` 的 `file:delete`、`file:deletePermanent` 两处逐路径断言切换为 `assertMediaDeletePath(ctx, p)`。

### 2.1 安全论证

- renderer 只能传 DB 中已展示的路径；删除已入库媒体与 `media:permanentDelete` 既有能力对齐（后者本就无路径校验），不新增暴露面。
- 未入库任意文件仍需 PathGuard 审批白名单；敏感目录黑名单对未入库路径原样生效。
- **已知残留面（有意取舍）**：已索引 source_path 下、媒体扩展名的符号链接/junction 指向敏感文件时与 media:// 读取同口径放行——read 已暴露，delete 不新增暴露面；与 media-read-guard.ts 头注释 §已知残留面一致。

## 3. 依赖声明

**无新增第三方依赖。** 复用既有模块：

| 依赖                     | 来源                              | 用途                                       |
| ------------------------ | --------------------------------- | ------------------------------------------ |
| `pathGuard.isUserPicked` | `src/main/ipc/validator.ts`       | userPicked 短路判定（既有）                |
| `isMediaPathAllowed`     | `src/main/app/media-protocol.ts`  | 媒体白名单判定（既有，带 5 分钟 TTL 缓存） |
| `assertFileReadPath`     | `src/main/ipc/validator.ts`       | PathGuard 兜底断言（既有）                 |
| `AppError.forbidden`     | `src/shared/errors/app-error.ts`  | 越权路径抛错（既有）                       |
| `HandlerContext`         | `src/main/ipc/handler-context.ts` | 守卫入参类型（既有）                       |
| vitest                   | devDependencies                   | 测试（`npx vitest run`）                   |

不新增 i18n key（兜底拒绝文案复用既有 `main.validator.pathNotAllowed`）、不改 PathGuard / isSensitivePath / 任何 zod schema。

## 4. 启动说明

### 4.1 环境

- Windows + Node.js（本仓库 Electron 40.10 工程），依赖已安装（node_modules 就绪）。
- 本机 npm 有 Safe-Delete 网关：只用 `npm install` 增量安装；本次零新依赖，无需安装。

### 4.2 开发启动（人工复现验证）

```powershell
npm run dev        # 启动开发模式
```

验证路径：图库选中一张已扫描媒体 → 删除 → 不再出现「路径不在白名单内」Toast，文件进入系统回收站。

### 4.3 自动化验证命令

```powershell
# 定向回归
npx vitest run src/main/ipc
# 全量回归
npx vitest run
# 类型 / 静态检查
npm run typecheck   # 基线：exit 0
npm run lint        # 基线：仅 16 个历史问题（.cache/、e2e/fullscreen-diagnose.e2e.ts、scripts/after-pack-vc-runtime.cjs）
```

## 5. 错误处理

| 分支                        | 行为                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 三重校验皆不命中            | `assertFileReadPath` 抛 `AppError.forbidden`（`IPC_PATH_FORBIDDEN`，文案复用 `main.validator.pathNotAllowed`，details 携带 `maskPath` 脱敏路径），经 wrapHandler 统一转 IpcError → 渲染层 Toast。 |
| userPicked / 媒体白名单命中 | 放行，零日志噪音（userPicked 分支静默；不新增 debug 日志 key）。                                                                                                                                  |
| 非绝对路径 / 空串           | isUserPicked 返回 false、isMediaPathAllowed 返回 false，原样落 PathGuard 拒绝（不在新守卫内静默放行）。                                                                                           |
| DB 不可用                   | `isMediaPathAllowed` 内部 db 为 null 时返回 false → 回落 PathGuard，行为与修复前一致。                                                                                                            |

## 6. 参数校验

- 不改任何 zod schema：`filePathArrayBulk` 元素级（非空 + 1-1024 字符）校验保留。
- `assertMediaDeletePath(ctx, p)` 入参：`ctx: HandlerContext`（必填，运行时由 handler 闭包提供）、`p: string`（schema 已保证非空字符串）；守卫内部不重复做长度/类型校验（zod 已覆盖），只做白名单语义判定。

## 7. 基础测试用例

### 7.1 守卫级（`src/main/ipc/media-read-guard.test.ts`，新增 describe `assertMediaDeletePath`）

| 类   | 用例                         | 输入要点                                                                                | 预期                                       |
| ---- | ---------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------ |
| 正常 | N1 userPicked 命中放行       | `registerUserPicked('C:\\test\\picked')`，路径为其子文件，媒体白名单 false              | 不抛错，assertFileReadPath 零调用          |
| 正常 | N2 媒体白名单命中放行        | `isMediaPathAllowed→true`，未注册 userPicked                                            | 不抛错，assertFileReadPath 零调用          |
| 正常 | N3 双不命中但 PathGuard 放行 | 媒体 false + 路径注册进 roots                                                           | 不抛错，assertFileReadPath 调用 1 次后通过 |
| 异常 | E1 双白名单皆不命中          | 敏感目录（`C:\Windows\notepad.exe`）+ 媒体 false                                        | 抛 AppError（code=PATH_FORBIDDEN）         |
| 异常 | E2 未注册盘符路径            | `Q:\nowhere\a.jpg` + 媒体 false                                                         | 抛 AppError（code=PATH_FORBIDDEN）         |
| 边界 | B1 敏感目录但已入库          | `C:\Program Files (x86)\Steam\...\photo.jpg` + 媒体 true                                | 放行（本修复核心场景）                     |
| 边界 | B2 非绝对路径                | `'relative/a.jpg'` + 媒体 false                                                         | 抛 AppError（落 PathGuard 拒绝）           |
| 边界 | B3 userPicked 优先于媒体判定 | userPicked 命中且媒体 false（N1 已覆盖放行）；userPicked 未命中但媒体 true（N2 已覆盖） | 见 N1/N2                                   |

### 7.2 handler 级（`src/main/ipc/handlers/file.test.ts`，新增 describe `file:delete 删除白名单对齐`）

| 类   | 用例                           | 输入要点                                             | 预期                                               |
| ---- | ------------------------------ | ---------------------------------------------------- | -------------------------------------------------- |
| 正常 | D1 已入库媒体删除成功          | `isMediaPathAllowed→true`，路径在 Program Files 形态 | `moveToRecycleBin` 被调用，返回 success            |
| 正常 | D2 未入库但已注册根            | 媒体 false，路径注册进 pathGuard                     | `moveToRecycleBin` 被调用                          |
| 异常 | D3 未入库且未注册              | 媒体 false，`Q:\nowhere\a.jpg`                       | 返回 `IPC_PATH_FORBIDDEN`，moveToRecycleBin 零调用 |
| 边界 | D4 file:deletePermanent 同口径 | 媒体 true + 敏感目录形态                             | `deletePermanent` 被调用（对话框 mock 为确认）     |
| 边界 | D5 复制通道不受影响            | `file:copy` 源路径媒体 false + 未注册                | 仍被 PATH_FORBIDDEN 拦截（守卫只替换删除通道）     |

## 8. 子任务拆解（TDD 红绿）

### 子任务 1：写入本计划文档

- 文件：`docs/plans/fix-delete-whitelist-read-forbidden.md`（NEW）
- 输入：根因分析与方案；输出：本文件
- 验收：文件存在且包含 §3-§7 全部章节

### 子任务 2：守卫测试红灯（RED）

- 文件：`src/main/ipc/media-read-guard.test.ts`（MODIFY，新增 describe，复用既有 isMediaPathAllowedMock / 真实 PathGuard）
- 输入：§7.1 用例表；输出：N1/E1/B1 先行（垂直切片，逐条红→绿）
- 验收：`npx vitest run src/main/ipc/media-read-guard.test.ts` 中新增用例失败，失败原因 = `assertMediaDeletePath is not a function`（预期红灯）

### 子任务 3：守卫实现绿灯（GREEN）

- 文件：`src/main/ipc/media-read-guard.ts`（MODIFY，新增 `assertMediaDeletePath` 约 30 行含安全注释与残留面说明）
- 输入：子任务 2 的红灯用例；输出：三级判定实现
- 验收：同文件测试全绿（含既有 assertMediaReadPath 用例零回归）

### 子任务 4：handler 切换（RED→GREEN）

- 文件：`src/main/ipc/handlers/file.test.ts`（MODIFY，先加 D1/D3/D4/D5 红灯）、`src/main/ipc/handlers/file.ts`（MODIFY，两处断言替换 + import 调整）
- 输入：§7.2 用例表；输出：file:delete / file:deletePermanent 走新守卫
- 验收：file.test.ts 全绿；file:copy 既有用例不回归

### 子任务 5：定向回归 + 静态检查

- 命令：`npx vitest run src/main/ipc` + `npm run typecheck` + `npm run lint`
- 验收：定向回归全通过；typecheck exit 0；lint 仅 16 项历史基线、零新增；`git diff --numstat` 行数合理且改动文件为 CRLF

### 子任务 6：全量回归

- 命令：后台 `npx vitest run`（`Start-Process cmd.exe "/c npx vitest run > .x.log 2>&1"` 轮询日志）
- 验收：仅允许 2 个既有环境性失败（path-safety.test.ts「只读目录」、GalleryStackOverflow.test.tsx），其余全部通过；回填本计划 §9 验证结论

## 9. 验证结论

### 9.1 TDD 红绿证据

| 阶段             | 命令                                                   | 结果                                                                                                       |
| ---------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| RED（守卫）      | `npx vitest run src/main/ipc/media-read-guard.test.ts` | 7 failed（新增 assertMediaDeletePath 用例，失败原因 `assertMediaDeletePath is not a function`）\| 9 passed |
| GREEN（守卫）    | 同上                                                   | 16/16 全部通过                                                                                             |
| RED（handler）   | `npx vitest run src/main/ipc/handlers/file.test.ts`    | 2 failed（D1/D4：敏感目录形态已入库媒体删除被 PATH_FORBIDDEN 拦截，即本次修复目标场景）\| 12 passed        |
| GREEN（handler） | 同上                                                   | 14/14 全部通过                                                                                             |

### 9.2 回归结果

| 检查项         | 命令                          | 结果                                                                                                                                                        |
| -------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定向回归       | `npx vitest run src/main/ipc` | ✅ 33 文件 / 405 用例全通过                                                                                                                                 |
| 全量测试       | `npx vitest run`              | ✅ 261 文件 / 4438 用例全通过（0 failed，含 2 个既有环境性用例本轮亦通过）                                                                                  |
| 类型检查       | `npm run typecheck`           | ✅ exit 0                                                                                                                                                   |
| ESLint（全仓） | `npm run lint`                | 16 problems（10 errors / 6 warnings），全部位于历史基线三处（`.cache/`、`e2e/fullscreen-diagnose.e2e.ts`、`scripts/after-pack-vc-runtime.cjs`），**0 新增** |

### 9.3 改动文件清单（git diff --numstat，源码部分）

```
62	0	src/main/ipc/handlers/file.test.ts
6	3	src/main/ipc/handlers/file.ts
76	1	src/main/ipc/media-read-guard.test.ts
32	1	src/main/ipc/media-read-guard.ts
```

另新增本计划文档 `docs/plans/fix-delete-whitelist-read-forbidden.md`。4 个源文件行尾已核对为 CRLF。
