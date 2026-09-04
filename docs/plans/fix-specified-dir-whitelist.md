# 修复：「指定目录」扫描对用户显式选择的系统目录误报「路径不在白名单内，禁止读取操作」

> 状态：执行中（TDD 红绿循环推进）
> 关联模块：`src/main/ipc/validator.ts`、`src/main/ipc/handlers/dialog-handler.ts`、`src/main/ipc/handlers/scanner-handler.ts`、`src/main/ipc/handlers/settings-handler.ts`
> 修复策略：「用户显式选择即授权」（userPicked 标记）——仅真实系统对话框返回的路径可标记，命中标记的路径跳过 PathGuard 审批校验；渲染进程伪造路径的完整白名单 + 黑名单校验不放宽。
> 关联文档：`docs/plans/fix-path-whitelist-read-forbidden.md`（同族白名单误报问题的历史修复，本计划沿用其双层守卫之外的第三条口径：对话框显式授权）

---

## 1. 问题背景

「指定目录」扫描在选择**部分路径**时报错：

```
扫描失败：路径不在白名单内，禁止读取 操作
```

受影响入口（三者共用同一主进程链路，Toast 文案分别对应）：

| 渲染入口                                                      | Toast 文案键                                                           | 链路                                                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 图库 `ScanButton` custom 分支                                 | `toast.scanFailed` + reason                                            | `dialog.selectDirectory()` → `scanner.start({ path })`                                                        |
| 设置页「添加指定目录」`ImportRootsSection.handleAddDirectory` | `settings.scan.importRootsAddFailed`（"指定目录扫描失败：{{reason}}"） | `dialog.selectDirectory()` → `scanner.start({ path, fullScan: true, customKnownPaths })`                      |
| 设置页多级兜底 `ScanFallbackSection.runFallbackScan`          | `settings.scan.fallbackScanFailed`（"扫描失败：{{reason}}"）           | `dialog.selectDirectory()` → `settings.set('customScanPaths', [...])` → `scanner.start({ customKnownPaths })` |

普通目录（如 `D:\Games`、`E:\Photos`）正常，系统目录形态必现——即「选择部分路径」失败。

## 2. 根因（已探明）

1. `dialog:selectDirectory`（`dialog-handler.ts`）选中后已 `pathGuard.register(p)` 登记白名单根；
2. 但 `PathGuard.isAllowed`（`validator.ts`）**第 1 步**先做 `isSensitivePath` 黑名单判定（`ipc-validate.ts` 的 `DRIVE_SYSTEM_DIR_RE`：任意盘符 `X:\Windows` / `X:\Program Files` / `X:\Program Files (x86)` / `X:\ProgramData`；UNC 管理共享；主目录凭据目录 `.ssh` / `.aws` / `.gnupg` / `.kube`），黑名单**无条件拒绝且优先于已注册 roots**；
3. `scanner:start` 的 `assertScanPathsAllowed` 对 `options.path` 与每个 `customKnownPaths` 逐条 `assertFileReadPath` → 用户刚显式选中的目录落黑名单形态即抛 `main.validator.pathNotAllowed`，经 `main.scanner.error.pathCheckFailed` 包装为「扫描失败：{reason}」广播；
4. `ScanFallbackSection` 还会在 `settings:set('customScanPaths')` 处被 `assertCustomScanPaths` 的同名校验提前拒绝。

结论：**黑名单的拦截对象应是"渲染进程伪造的路径"，而非"用户在真实系统对话框中显式选中的目录"**。后者是用户真实授权行为（与用户用任意本地软件打开该目录同权），不应被黑名单覆盖。

## 3. 影响范围与安全边界

| 维度       | 说明                                                                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 功能面     | 仅「指定目录 / 兜底扫描」三个入口的目标路径校验                                                                                                                                                                   |
| 不受影响   | `file` / `video` / `share` / `editor` 等其他域读写校验；`import` 链路；`PathGuard` 黑名单本身；zod schema                                                                                                         |
| 安全防线   | **不放宽**：`isSensitivePath` 黑名单原样保留；未命中 userPicked 的路径（含渲染进程伪造路径）仍走完整 `assertFileReadPath`；渲染进程无任何 IPC 通道可标记 userPicked（仅 dialog-handler 两个真实对话框返回点写入） |
| 攻击面分析 | 被入侵的渲染进程要读系统目录，必须诱导用户在真实系统对话框中选中该目录（即用户显式授权），风险可接受                                                                                                              |

## 4. 依赖声明

**零新增第三方依赖**。仅复用既有模块：

| 依赖                                   | 用途                                                | 备注                 |
| -------------------------------------- | --------------------------------------------------- | -------------------- |
| `pathGuard`（`validator.ts`）          | 新增 `registerUserPicked` / `isUserPicked` 两个方法 | 既有单例             |
| `assertFileReadPath`（`validator.ts`） | 未命中 userPicked 时的兜底校验                      | 既有                 |
| `isSensitivePath`（`ipc-validate.ts`） | 黑名单判定                                          | 既有，不改           |
| `vitest`                               | 测试                                                | 既有                 |
| `tests/mocks/mock-validator.ts`        | handler 测试共享 mock（pathGuard 超集补 2 个方法）  | 测试脚手架，同步扩展 |

## 5. 启动说明

```powershell
# 1. 依赖安装（增量；本机 npm 有 Safe-Delete 网关，禁用 npm ci）
npm install

# 2. 定向测试（无需启动应用）
npx vitest run src/main/ipc/validator.test.ts src/main/ipc/handlers/dialog-handler.test.ts src/main/ipc/handlers/scanner-handler.test.ts src/main/ipc/handlers/settings-handler.test.ts

# 3. 手动验证（启动 Electron 开发环境）
npm run dev
# 复现/验证路径：设置页 → 扫描设置 → 「添加指定目录」/ 兜底扫描 →
# 选择系统目录（如游戏装在 X:\Program Files\...）→ 不再报白名单错误，扫描正常
```

## 6. 错误处理

| 场景                                                         | 行为                                                                                                          | 用户感知               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------- |
| userPicked 命中（对话框显式选择）                            | 跳过 PathGuard 审批校验，扫描正常发起                                                                         | 正常扫描               |
| 未命中 userPicked 且 PathGuard 通过                          | 兜底放行（既有行为）                                                                                          | 正常                   |
| 未命中 userPicked 且 PathGuard 拒绝（伪造路径 / 黑名单目录） | 抛 `AppError.forbidden` → 广播 `scanner:complete { success:false }` → 前端展示「扫描失败：路径不在白名单内…」 | 仅对真正未授权路径报错 |
| `registerUserPicked` 收到空串/无效路径                       | 静默忽略（与 `register` 一致）                                                                                | 无感知                 |
| `settings:set customScanPaths` 数组格式非法                  | 既有 zod / 内联校验拒绝，行为不变                                                                             | 校验错误提示           |

广播兜底链路（校验失败也广播 complete，避免前端卡在"正在扫描"）为既有实现，本次不改。

## 7. 参数校验

沿用既有校验，不新增、不放宽 schema：

| 通道                                         | schema                               | 约束                                                                   |
| -------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| `scanner:start`                              | `scannerStartSchema`（既有）         | `path` / `customKnownPaths` 元素为 1-1024 字符绝对路径串               |
| `settings:set customScanPaths`               | 内联 `assertCustomScanPaths`（既有） | 数组 ≤ 64 项、元素非空字符串；本次仅在元素级校验前增加 userPicked 短路 |
| `dialog:selectDirectory` / `dialog:openFile` | 既有                                 | 无入参 / properties 枚举校验                                           |

userPicked 判定语义：与 `roots` 一致的归一化（`path.resolve(p).toLowerCase()`）+ 前缀/相等匹配（目录名边界必须为分隔符或末尾，`'D:\Program Filesabc'` 不命中 `'D:\Program Files'`）。

## 8. 基础测试用例

> **翻转回归用例**（覆盖本 bug，修复前必须红灯、修复后绿灯）：A1 / A3 / B1 / B3 / C1 / D1 / D2。
> **守卫用例**（防安全面放宽，修复前后均应通过，单独标注不参与翻转判定）：A2 / B2 / C2。

| 组                          | 编号       | 场景                                              | 输入要点                                                | 预期                                                               |
| --------------------------- | ---------- | ------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| validator（真实 PathGuard） | D1         | `registerUserPicked` 后自身/子路径/大小写变体命中 | `registerUserPicked('D:\\Program Files\\Game')`         | `isUserPicked` 对三者均 true；`isAllowed` 亦 true（联动 register） |
| validator（真实 PathGuard） | D2         | 未登记 / 前缀边界                                 | `E:\\Other`、`D:\\Program Filesabc`                     | `isUserPicked` 均 false                                            |
| dialog-handler              | A1         | `selectDirectory` 登记 userPicked                 | 对话框返回 `/selected`                                  | `pathGuard.registerUserPicked` 以该路径调用                        |
| dialog-handler              | A2（守卫） | `openFile` 文件模式不登记                         | `properties: ['openFile']`                              | `registerUserPicked` 未被调用                                      |
| dialog-handler              | A3         | `openFile` openDirectory 模式登记                 | `properties: ['openDirectory']`                         | `registerUserPicked` 以该路径调用                                  |
| scanner-handler             | B1         | userPicked 命中的系统目录 `path` 放行             | `isUserPicked→true`，`assertFileReadPath` 抛 forbidden  | `startScan` 被调用，扫描成功                                       |
| scanner-handler             | B2（守卫） | 伪造路径仍拒绝                                    | `isUserPicked→false`，`assertFileReadPath` 抛 forbidden | 拒绝、`registerRoots`/`startScan` 零调用、广播失败                 |
| scanner-handler             | B3         | userPicked 命中的 `customKnownPaths` 条目放行     | 同 B1，路径经 customKnownPaths 传入                     | `startScan` 被调用                                                 |
| scanner-handler             | B4（守卫） | 未命中的 `customKnownPaths` 条目仍走校验          | `isUserPicked→false`                                    | `assertFileReadPath` 以该路径调用                                  |
| settings-handler            | C1         | userPicked 命中路径写 `customScanPaths` 放行      | `isUserPicked→true`，`assertFileReadPath` 抛 forbidden  | `saved: true`，`assertFileReadPath` 未被调用                       |
| settings-handler            | C2（守卫） | 未命中路径仍被校验拦截                            | `isUserPicked→false`，`assertFileReadPath` 抛 forbidden | `settings:set` 失败（`IPC_VALIDATION_ERROR`）                      |

## 9. 子任务拆分（每步验证通过后才进入下一步）

### 子任务 0 — 计划文档落库（本文件）

- **文件**：新增 `docs/plans/fix-specified-dir-whitelist.md`
- **验收标准**：本文件存在且包含依赖声明 / 启动说明 / 错误处理 / 参数校验 / 测试用例 / 子任务验收标准全部章节。

### 子任务 1 — RED：新增失败测试

- **文件**：
  - 修改 `tests/mocks/mock-validator.ts`（pathGuard 超集补 `registerUserPicked` / `isUserPicked` 两个 `vi.fn`）
  - 修改 `src/main/ipc/handlers/dialog-handler.test.ts`（A1 / A2 / A3）
  - 修改 `src/main/ipc/handlers/scanner-handler.test.ts`（B1-B4）
  - 修改 `src/main/ipc/handlers/settings-handler.test.ts`（C1 / C2）
  - 新增 `src/main/ipc/validator.test.ts`（D1 / D2，真实 PathGuard，mock electron）
- **输入 / 输出**：输入为各 handler 的既有 mock 脚手架；输出为可运行的新用例。
- **验收标准**：`npx vitest run <上述文件>` 中，翻转用例（A1/A3/B1/B3/C1/D1/D2）全部失败且失败原因指向"userPicked 能力不存在/未被调用"；守卫用例（A2/B2/B4/C2）通过。
- **验证命令**：

  ```powershell
  npx vitest run src/main/ipc/validator.test.ts src/main/ipc/handlers/dialog-handler.test.ts src/main/ipc/handlers/scanner-handler.test.ts src/main/ipc/handlers/settings-handler.test.ts
  ```

### 子任务 2 — GREEN：最小实现

- **文件**：
  - 修改 `src/main/ipc/validator.ts`：PathGuard 新增 `userPicked` Set + `registerUserPicked(p)`（联动 `register`，同一归一化）+ `isUserPicked(p)`（归一化 + 前缀/相等匹配）
  - 修改 `src/main/ipc/handlers/dialog-handler.ts`：`selectDirectory` 循环内与 `openFile` 的 openDirectory 分支追加 `registerUserPicked`
  - 修改 `src/main/ipc/handlers/scanner-handler.ts`：`assertScanPathsAllowed` 对 `options.path` 与 `customKnownPaths` 各条目改为 `!pathGuard.isUserPicked(p)` 时才 `assertFileReadPath(p)`
  - 修改 `src/main/ipc/handlers/settings-handler.ts`：`assertCustomScanPaths` 元素级校验增加 userPicked 短路（导入 `pathGuard`）
- **输入 / 输出**：输入为子任务 1 的红灯用例；输出为全部转绿的最小实现（不重构无关代码）。
- **验收标准**：子任务 1 的验证命令全部通过（含守卫用例）。
- **验证命令**：同子任务 1。

### 子任务 3 — 定向回归 + 静态检查

- **文件**：无新改动（如回归暴露问题则回到子任务 2 修复）
- **验收标准**：
  - `npx vitest run src/main/ipc` 全绿；
  - `npx tsc -b` exit 0（基线零错误）；
  - `npx eslint <4 个改动源文件 + 4 个测试文件 + mock>` 0 error。
- **验证命令**：

  ```powershell
  npx vitest run src/main/ipc
  npx tsc -b
  npx eslint src/main/ipc/validator.ts src/main/ipc/validator.test.ts src/main/ipc/handlers/dialog-handler.ts src/main/ipc/handlers/dialog-handler.test.ts src/main/ipc/handlers/scanner-handler.ts src/main/ipc/handlers/scanner-handler.test.ts src/main/ipc/handlers/settings-handler.ts src/main/ipc/handlers/settings-handler.test.ts tests/mocks/mock-validator.ts
  ```

### 子任务 4 — 全量回归 + 文档回填

- **验收标准**：
  - 全量 `npx vitest run`：仅允许 2 个既有环境性失败（`path-safety.test.ts`、`GalleryStackOverflow.test.tsx`）；
  - `npm run typecheck` exit 0；
  - `npm run lint` 仅 3 处历史文件基线（`.cache/`、`e2e/fullscreen-diagnose.e2e.ts`、`scripts/after-pack-vc-runtime.cjs`）；
  - 本文档回填「验证结论 / 改动文件清单 / 已知限制」。
- **验证命令**：

  ```powershell
  npx vitest run
  npm run typecheck
  npm run lint
  ```

## 10. 对已批准计划的偏差说明（必要修正）

已批准计划原文为「`customKnownPaths` 维持逐条 `assertFileReadPath` 不变」。实施时发现其与 settings-handler 放行组合后**自相矛盾**：`ScanFallbackSection` 先把选中目录写入 `customScanPaths`，随后立即以 `customKnownPaths` 发起 `scanner.start`（不传 `path`，见 `scan-sections.tsx` 332-336 行）。若 `customKnownPaths` 条目不放行，用户选择系统目录后同一次操作内仍会在 `scanner:start` 被拒——bug 未修复。

修正：`assertScanPathsAllowed` 对 `customKnownPaths` 条目同样应用 `!isUserPicked` 短路。语义不变（放行的仍仅限对话框显式选择的路径），安全边界不变。

## 11. 风险与缓解

| 风险              | 缓解                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| 安全面意外放宽    | 守卫用例（A2/B2/B4/C2）锁死"伪造路径仍拒绝"；黑名单与 zod schema 零改动 |
| userPicked 误匹配 | 归一化 + 分隔符边界前缀匹配（与 roots 同语义），D2 用例覆盖边界         |
| 行为回归          | 既有 16 个 scanner-handler 用例 + dialog/settings 既有用例全量保留      |

## 12. 已知限制（待回填）

- userPicked 标记为**内存态**（与 `pathGuard.roots` 一致），应用重启后丢失。重启后 `customScanPaths` 中的系统目录条目（重启后经 `refreshPathGuardRoots` 注册为 roots 但仍被黑名单拒绝）在全量扫描中仍会被拒——与修复前行为一致，未恶化；用户重新选择一次即恢复。持久化 userPicked（如随 `customScanPaths` 落库）为后续可选增强，本计划不做。
- 用户主目录凭据目录（`.ssh` 等）与 UNC 管理共享若被用户显式选择，同样会被放行扫描（用户显式授权语义）。属预期行为，如需保留硬拒绝可在后续评审中调整。
- **未修复的仓库既有缺陷（与本次改动无关，建议单独立项）**：
  - `src/main/database/resonance-repository.test.ts`「schema（由 RESONANCE_DDL_STATEMENTS 驱动）」用例失败：`connection.ts` 缺 `resonance_pulls` 建表 DDL。单独运行亦复现（1 failed / 12 passed），且 `connection.ts` / `resonance-repository.ts` / 该测试文件三者与 HEAD **零差异**，属 HEAD 既有失败。
  - `npx tsc -b` 报 `src/renderer/preview/mock/resonance-mock.ts(13,8): TS2307 Cannot find module '../../shared/types/resonance'`——该导入按目录算术解析为 `src/renderer/shared/types/resonance`（不存在；实际文件在 `src/shared/types/resonance.ts`），同为 HEAD 既有缺陷（文件未被任何在途改动触及）。
  - 两者同属 resonance 模块，推测为 resonance 功能引入不完整所致，不在本计划范围。
- **临时日志待清理**（迭代中由测试输出重定向生成，删除审批未通过）：工作区根目录 `.vitest-full.log`、`.vitest-full.err`、`.vitest-full2.log`、`.conn-test.log`、`.v2.log`、`.v3.log`、`.orig-validator.test.ts`、`.final-ipc.log`。

## 13. 验证结论

### 13.1 TDD 红绿证据

| 阶段              | 命令                                                                                                                                                                                      | 结果                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| RED（子任务 1）   | `npx vitest run src/main/ipc/validator.test.ts src/main/ipc/handlers/dialog-handler.test.ts src/main/ipc/handlers/scanner-handler.test.ts src/main/ipc/handlers/settings-handler.test.ts` | 4 文件 / 46 用例：**7 failed**（D1/D2/A1/A3/B1/B3/C1）\| 39 passed（含 4 个守卫用例 A2/B2/B4/C2 通过） |
| GREEN（子任务 2） | 同上                                                                                                                                                                                      | 4 文件 / 46 用例**全部通过**                                                                           |

### 13.2 回归结果

| 检查项             | 命令                          | 结果                                                                        |
| ------------------ | ----------------------------- | --------------------------------------------------------------------------- |
| 定向回归（改动域） | `npx vitest run src/main/ipc` | ✅ 33 文件 / 393 用例全通过                                                 |
| 全量测试           | `npx vitest run`              | 261 文件 / 4422 用例：4421 passed，1 failed（既有 resonance DDL，见 §12）   |
| 类型检查           | `npx tsc -b`                  | 1 error（既有 resonance-mock 导入路径，见 §12）；**本次改动文件零类型错误** |
| ESLint（改动文件） | `npx eslint <9 个改动文件>`   | ✅ exit 0 / 0 problems                                                      |
| ESLint（全仓）     | `npm run lint`                | 16 problems（10 errors / 6 warnings），与历史基线三处文件一致，**0 新增**   |

### 13.3 改动文件清单

`git diff --numstat` 合计 **9 文件 / 272 增 / 15 删**（含测试与共享 mock；换行符已统一为工作副本约定的 CRLF）：

| 文件                                             | 增 / 删   | 改动摘要                                                                                                       |
| ------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------- |
| `src/main/ipc/validator.ts`                      | +37 / -0  | PathGuard 新增 `userPicked` 集合、`registerUserPicked`（联动 `register`）、`isUserPicked`（归一化 + 前缀匹配） |
| `src/main/ipc/handlers/dialog-handler.ts`        | +6 / -4   | `selectDirectory` 与 `openFile`(openDirectory) 改用 `registerUserPicked`                                       |
| `src/main/ipc/handlers/scanner-handler.ts`       | +11 / -2  | `assertScanPathsAllowed` 对 `path` 与 `customKnownPaths` 条目增加 userPicked 短路                              |
| `src/main/ipc/handlers/settings-handler.ts`      | +5 / -2   | `assertCustomScanPaths` 元素级校验增加 userPicked 短路                                                         |
| `src/main/ipc/validator.test.ts`                 | +33 / -1  | 追加 D1/D2（原 13 个 schema 用例完整保留，现 15 用例全通过）                                                   |
| `src/main/ipc/handlers/dialog-handler.test.ts`   | +27 / -4  | 新增 A1/A3 翻转 + A2 守卫；2 处既有断言随实现迁移到 `registerUserPicked`                                       |
| `src/main/ipc/handlers/scanner-handler.test.ts`  | +101 / -0 | 新增 B1/B3 翻转 + B2/B4 守卫                                                                                   |
| `src/main/ipc/handlers/settings-handler.test.ts` | +48 / -1  | 新增 C1 翻转 + C2 守卫                                                                                         |
| `tests/mocks/mock-validator.ts`                  | +4 / -1   | `pathGuard` 超集补 `registerUserPicked` / `isUserPicked`                                                       |

另新增计划文档 `docs/plans/fix-specified-dir-whitelist.md`（本文件）。

### 13.4 验收标准达成情况（对照 §9）

| 子任务         | 验收标准                                                            | 结论                              |
| -------------- | ------------------------------------------------------------------- | --------------------------------- |
| 0 计划文档落库 | 含依赖 / 启动 / 错误处理 / 参数校验 / 测试 / 子任务验收标准         | ✅                                |
| 1 RED          | 7 个翻转用例失败、4 个守卫用例通过                                  | ✅                                |
| 2 GREEN        | 同命令全绿                                                          | ✅                                |
| 3 定向回归     | `src/main/ipc` 全绿 + `tsc -b` 无新增错误 + 改动文件 eslint 0 error | ✅                                |
| 4 全量回归     | 全量 vitest 无新增失败 + lint 基线一致 + 本文档回填                 | ✅（剩余失败项均为 §12 既有缺陷） |
