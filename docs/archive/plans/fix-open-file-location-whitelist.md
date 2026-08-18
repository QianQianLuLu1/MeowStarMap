# 修复「打开文件所在目录」白名单误拦截

## 一、背景与根因

在使用「打开文件所在目录」（`shell:showItemInFolder` / `shell:openPath`）功能时，右下角弹窗报错
**「路径不在白名单内，禁止读取操作」**（错误码 `IPC_PATH_FORBIDDEN`，文案 `pathNotAllowed`）。

根因定位：

- 报错来自 `src/main/ipc/handlers/shell-handler.ts` 中两个 handler 调用的 `assertFileReadPath(filePath)`。
  `assertFileReadPath` 由 `src/main/ipc/validator.ts` 提供，内部执行 `validateFilePath` + `pathGuard.assertReadAllowed`。
- `pathGuard`（`src/main/plugins/permission-guard.ts`）是**读取白名单**：仅放行已注册的 import_roots、上次成功读取缓存、
  DB 精确命中的 `file_path`/`thumbnail`、以及「已索引 `source_path` 目录 + 媒体扩展名」5 层。
- 图库中显示的图片（含游戏目录截图）其 `file_path`/`source_path` 未必被登记为 pathGuard 的读取白名单**根目录**，
  于是 shell 定位操作被 `pathGuard` 拒绝。
- 这两个操作本质是「让操作系统打开资源管理器定位文件」，**不经由应用读取文件内容**，本就不该受读取白名单约束。

图库图片显示逻辑（`media://` 协议 `isMediaPathAllowed`）已通过「DB file_path 精确命中」放行所有已索引图片，
与 pathGuard 读取白名单无关，因此**图库显示本身无需改动**，符合「控制修改范围」要求。

## 二、依赖声明

- **不引入任何第三方 / 开源新依赖**（符合「优先复用成熟项目、精简代码」原则）。
- 复用既有模块与库：
  - `zod`（项目已安装）：`schemas.filePath` 负责参数基础校验（非空、长度 1–1024）。
  - `src/main/utils/ipc-validate.ts` 的 `validateNonSensitivePath`（系统敏感目录黑名单），该工具已被 `media-protocol.ts` 成熟复用。
  - `src/shared/errors/app-error.ts` 的 `AppError.forbidden` / `AppError.internal`。
  - 测试复用 `vitest` + `src/main/ipc/handlers/_test-helpers.ts` 的 `createSchemasMock` / `makeCtx` / `getHandler`。

## 三、修改方案总览（最小化 diff）

仅改动 2 个文件：

- `src/main/ipc/handlers/shell-handler.ts`（业务修复）
- `src/main/ipc/handlers/shell-handler.test.ts`（测试对齐）

将 `assertFileReadPath`（读取白名单）替换为新增的 `assertShellPathSafe`：先做**绝对路径校验**（兼容 Windows 盘符 / POSIX 根路径 / UNC，拦截真正相对路径），
再调用 `validateNonSensitivePath` 做**系统敏感目录黑名单**拦截。shell API 调用与 `AppError.internal` 兜底逻辑保持不变。

### shell-handler.ts 关键改动（约 15 行）

```ts
import path from 'path'
import { validateNonSensitivePath } from '../../utils/ipc-validate'

function assertShellPathSafe(p: string): void {
  // 兼容 Windows 盘符路径（D:\...）、UNC（\\...）与 POSIX 根路径（/...）；真正的相对路径才拦截
  if (!path.isAbsolute(p) && !p.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(p)) {
    throw AppError.forbidden('路径必须为绝对路径', { path: p })
  }
  const result = validateNonSensitivePath(p)
  if (!result.valid) {
    throw AppError.forbidden(result.message ?? '出于安全考虑，不允许操作系统敏感目录', { path: p })
  }
}
```

`shell:openPath` 与 `shell:showItemInFolder` 中 `assertFileReadPath(x)` 改为 `assertShellPathSafe(x)`。

## 四、实施子任务（每个含：修改文件 / 输入 / 输出 / 验收标准）

### 子任务 1：修复 shell-handler.ts

- **修改文件**：`src/main/ipc/handlers/shell-handler.ts`
- **输入**：当前 handler 源码（两个 shell 操作均调用 `assertFileReadPath`）。
- **输出**：移除 `assertFileReadPath` 调用，新增 `assertShellPathSafe` 辅助并替换调用，更新 import。
- **验收标准**：`tsc -b` 类型检查无新增错误；`assertShellPathSafe` 对非绝对路径与敏感目录抛 `AppError.forbidden`
  （code `IPC_PATH_FORBIDDEN`），对普通 / 游戏目录路径不抛错。

### 子任务 2：更新 shell-handler.test.ts

- **修改文件**：`src/main/ipc/handlers/shell-handler.test.ts`
- **输入**：现有测试（mock `../validator` 并断言 `assertFileReadPathMock` 被调用）。
- **输出**：
  - 新增 `vi.mock('../../utils/ipc-validate', () => ({ validateNonSensitivePath: validateNonSensitivePathMock }))`。
  - validator mock 移除 `assertFileReadPath` / `assertFileWritePath`；断言改断言 `validateNonSensitivePathMock`。
  - 新增用例：游戏目录路径（`C:\Games\InfinityNikki\ScreenShot\img.jpg`，`validateNonSensitivePath` 返回 `{valid:true}`）
    → shell API 被调用且 `opened:true`；敏感目录（`C:\Windows\System32\x.dll`，返回 `{valid:false, message:'x'}`）
    → 返回 `IPC_PATH_FORBIDDEN`。
- **验收标准**：测试编译通过，断言与新的 handler 行为一致。

### 子任务 3：运行 vitest 单测并修复报错

- **命令**：`npx vitest run src/main/ipc/handlers/shell-handler.test.ts`
- **输入**：子任务 1、2 的改动。
- **输出**：全部用例通过；若有失败就地修复后重跑直到通过。
- **验收标准**：该测试文件 100% 通过，无 lint / 类型错误。✅ 已执行：10 passed (10)，0 lint 错误。

### 子任务 4：手动集成验证

- **启动**：`npm run dev`（electron-vite dev）。
- **操作**：图库内选取一张游戏目录截图（`file_path` 指向未登记为白名单根的游戏目录）→ 点击「打开文件所在目录」。
- **验收标准**：右下角不再弹出「路径不在白名单内，禁止读取操作」；系统资源管理器正确打开并选中该文件。
- **说明**：该步骤为 GUI 人工操作，需由用户在运行中的应用内完成（见第八节）。

## 五、启动说明

- 安装依赖（若未安装）：`npm install`
- 运行单测（指定文件）：`npx vitest run src/main/ipc/handlers/shell-handler.test.ts`
- 运行全部单测：`npm test`
- 类型检查：`npm run typecheck`
- 开发验证：`npm run dev`
- 构建验证：`npm run build`

## 六、错误处理

- 相对路径 / 非绝对路径：`assertShellPathSafe` 抛 `AppError.forbidden`（code `IPC_PATH_FORBIDDEN`，message「路径必须为绝对路径」）。
- 命中系统敏感目录：`validateNonSensitivePath` 返回 `{valid:false}` → 抛 `AppError.forbidden`（code `IPC_PATH_FORBIDDEN`，message 取 `result.message`）。
- shell API 执行失败（如文件不存在）：handler `catch` 中抛 `AppError.internal`，返回 `IPC_INTERNAL_ERROR`（保留既有文案
  `main.shell.openFileLocationFailed` / `main.shell.openPathFailed`）。
- 参数非法（空串 / 超长）：由 `wrapHandler` + zod `schemas.filePath` 拦截，返回 `IPC_VALIDATION_ERROR`。
- 全程不泄露完整路径，错误 details 仅携带传入 path 原串。

## 七、参数校验

- 第一层（`wrapHandler` + zod `schemas.filePath`）：非空字符串、长度 1–1024。
- 第二层（`assertShellPathSafe`）：绝对路径校验（兼容 Windows 盘符 / POSIX 根路径 / UNC）。
- 第三层（黑名单）：`validateNonSensitivePath` 校验是否落入 `SYSTEM_SENSITIVE_DIRS`
  （`C:\Windows\System32`、`C:\Windows\SysWOW64`、`C:\Program Files`、`C:\Program Files (x86)`、`C:\ProgramData`）。
- **不调用**读取白名单 `assertFileReadPath` / `pathGuard`，避免误拦截。

## 八、基础测试用例清单（已落地于 shell-handler.test.ts）

1. 注册 3 个 shell channel（openExternal / openPath / showItemInFolder）。
2. `shell:openPath` 成功：mock `validateNonSensitivePath` 返回 `{valid:true}` → 断言被调用、shell.openPath 被调用、返回 `{opened:true}`。
3. `shell:showItemInFolder` 成功：同上，断言 shell.showItemInFolder 被调用。
4. `shell:openExternal` 成功 / 抛错 → `IPC_INTERNAL_ERROR`。
5. `shell:openPath` 敏感目录被拒 → 返回 `IPC_PATH_FORBIDDEN`。
6. `shell:showItemInFolder` 敏感目录被拒 → 返回 `IPC_PATH_FORBIDDEN`。
7. `shell:openPath` / `shell:showItemInFolder` shell API 抛错 → 返回 `IPC_INTERNAL_ERROR`。
8. **游戏目录路径（未登记白名单根）放行**（核心回归用例）：`C:\Games\InfinityNikki\ScreenShot\img.jpg`
   → 断言 shell API 被调用、`opened:true`。

## 九、验收门槛

- [x] `npx vitest run src/main/ipc/handlers/shell-handler.test.ts` 全部通过（10/10）。
- [x] `npm run typecheck` 针对本次改动文件无新增错误（仓库内既有 `scan-sections.tsx` 的 `importRoot` 报错与本任务无关）。
- [ ] 手动复现：游戏目录图片「打开文件所在目录」不再弹白名单拦截提示，资源管理器正确定位（需用户在运行中的应用内确认）。

## 十、控制修改范围说明

- 仅修改 `shell-handler.ts` 与 `shell-handler.test.ts`。
- 不改动 `media-protocol.ts`（图库显示白名单）、`permission-guard.ts`、`validator.ts` 的 pathGuard 核心、图库 UI 与渲染层代码。
- 不引入新依赖、新 i18n key、新架构模式。
