# 放开 `filePathArray` 1000 路径数组上限

- 日期：2026-08-23
- 关联：参考已上线的 `mediaIdArray → mediaIdArrayBulk` 修复范式
- 目标：移除主进程批量文件通道的 1000 路径人为上限，支持 >1000 全选导入/导出/移动/复制/删除/永久删除/分享/水印等场景，同时**不降级**元素级路径安全边界。

## 1. 依赖声明

零新增依赖、零新增运行时机制，全部复用项目内既有设施：

| 复用项                                                                         | 位置                                                           | 用途                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `schemas.filePathArrayBulk`（新增）                                            | `src/main/ipc/validator.ts`                                    | 无 1000 上限、保留元素级校验的路径数组 schema                            |
| `schemas.filePathArray`/`mediaIdArrayBulk`（既有模板）                         | `src/main/ipc/validator.ts`                                    | 对照/范式参考                                                            |
| `wrapHandler` + `IPC_ERROR_CODES`                                              | `src/main/ipc/validator.ts` / `src/shared/types/ipc-types.ts`  | 统一错误响应（`VALIDATION_ERROR` / `PATH_FORBIDDEN` / `INTERNAL_ERROR`） |
| `assertFileReadPath` / `assertFileWritePath` / `pathGuard` / `isSensitivePath` | `src/main/ipc/validator.ts` / `src/main/utils/ipc-validate.ts` | 元素级绝对路径白名单 + 敏感目录黑名单安全边界                            |
| `chunkArray`                                                                   | `src/main/database/sql-chunk.ts`                               | `file:export` 元数据查询分片，规避 SQLite 变量数上限（已用，未改）       |
| `runWithConcurrency`（`utils/concurrency.ts`，可选）                           | 超大数组限流，最小修改下不强制引入                             | 见 §3                                                                    |
| vitest mock 范式                                                               | `src/main/ipc/handlers/profile-handler.test.ts`                | 真实 zod 集成测试模板                                                    |
| `_test-helpers.ts`（`createSchemasMock`）                                      | 已补充 `filePathArrayBulk` 键                                  | 避免 mock `../validator` 时取到 `undefined`                              |

## 2. 启动说明

- 开发：`npm run dev`（electron-vite dev）
- 定点单测：
  - `npx vitest run src/main/ipc/validator.test.ts`
  - `npx vitest run src/main/ipc/handlers/file.test.ts`
- 全量：`npm test`
- 类型：`npm run typecheck`；规范：`npm run lint`
- 构建：`npm run build`；打包安装版：`npm run dist`（注意本机 `npm run dist:win` 的 `clean` 步会触发 Safe-Delete 网关 EPERM，改用 `npx electron-vite build` + 写 `dist/main/package.json {"type":"commonjs"}` + `npx electron-builder --win --publish never` 序列）
- 手动回归（`npm run dev` 后）：导入向导选目录导入 >1000 文件；图库/缓存全选 >1000 导出/移动到档案/删除/永久删除；水印应用 >1000；局域网/剪贴板分享 >1000，均无「路径数组长度上限」报错。

## 3. 错误处理

| 异常分支                                 | 处理策略                                                                                                                                                                               | 降级                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| zod 校验失败（空数组/元素非法/元素超长） | `wrapHandler` 统一返回 `IPC_VALIDATION_ERROR`，不进入业务                                                                                                                              | 前端 toast                                                           |
| 元素不在白名单 / 命中敏感目录            | `assertFileReadPath/WritePath` 抛 `AppError.forbidden` → `handleError` 转 `IPC_PATH_FORBIDDEN`                                                                                         | 该路径被拒，其余不处理                                               |
| 大批量部分失败                           | `importFiles` 返回 `{imported,skipped,failed}`；`moveFiles` 返回 `renamed` + 失败明细并回写 DB（防破图）；`copy/moveToRecycleBin/deletePermanent/exportFiles` 逐文件、服务层上报失败项 | 上报失败明细，用户可重试                                             |
| 永久删除不可逆                           | `file:deletePermanent` 已有高危二次确认 dialog；`move` 失败点前的已成功项靠 `renamed` 映射回写                                                                                         | 无事务级整体回滚（FS 本质不可整体回滚），以部分失败上报 + 重试为降级 |
| 超时 / 超大数组                          | 主进程不设硬超时；`import:run` 已发 `import:progress` 进度事件；如需可对 >20000 数组复用 `runWithConcurrency` 限流（可选，非强制）                                                     | 前端进度 UI 不阻塞                                                   |
| DB 查询分片                              | `file:export` 元数据查询已 `chunkArray(filePaths)` 分片，防 SQLite 变量上限                                                                                                            | —                                                                    |

## 4. 参数校验（新旧 Schema 对照 + 安全边界）

**旧**：`filePathArray = z.array(z.string().min(1).max(MAX_FILE_PATH_LENGTH)).min(1).max(MAX_PATH_ARRAY_SIZE, …)`（含 1000 上限）。
**新**：`filePathArrayBulk` = 同上但**去掉 `.max(1000)`**，保留 `.min(1)` 与元素 `min(1).max(MAX_FILE_PATH_LENGTH)`。

| 通道                             | 旧 schema                                   | 新 schema             | 元素校验                             | 状态     |
| -------------------------------- | ------------------------------------------- | --------------------- | ------------------------------------ | -------- |
| `import:run`                     | filePathArray                               | **filePathArrayBulk** | 绝对路径 + 白名单（register+assert） | 已改     |
| `file:delete`                    | filePathArray                               | **filePathArrayBulk** | assertFileReadPath                   | 已改     |
| `file:copy`                      | filePathArray                               | **filePathArrayBulk** | read+write 白名单                    | 已改     |
| `file:move`                      | filePathArray                               | **filePathArrayBulk** | read+write 白名单                    | 已改     |
| `file:export`                    | filePathArray                               | **filePathArrayBulk** | read+write 白名单                    | 已改     |
| `file:deletePermanent`           | filePathArray                               | **filePathArrayBulk** | assertFileReadPath                   | 已改     |
| `share:startWifi`                | filePathArray                               | **filePathArrayBulk** | assertFileReadPath                   | 已改     |
| `share:copyFiles`                | filePathArray                               | **filePathArrayBulk** | assertFileReadPath                   | 已改     |
| `watermark:apply`                | filePathArray                               | **filePathArrayBulk** | read+write 白名单                    | 已改     |
| `editor:batchExportWithMetadata` | filePathArray                               | **filePathArrayBulk** | 元素级校验                           | 已改     |
| `file:batchRename`               | 独立 schema（自带 `MAX_BATCH_RENAME_SIZE`） | 不变                  | —                                    | 不在范围 |

**安全边界（不降级）**：`min(1)` 拒空数组；元素 `min(1).max(MAX_FILE_PATH_LENGTH)` 拒空串/超长串；handler 内 `assertFileReadPath/WritePath` 逐元素白名单 + `isSensitivePath` 敏感目录黑名单兜底；`file:export` 的 `chunkArray` 分片查询防 SQLite 变量上限。放开**仅限数组长度这一人为上限**，常量 `MAX_PATH_ARRAY_SIZE` 保留（仍被遗留手写校验器与 `constants.test.ts`/`ipc-validate.test.ts` 引用）。

## 5. 基础测试用例

- `validator.test.ts`（新增 6 例，共 13 例全过）：① 接受 1500 路径 ② 接受 1000/2000/3000 路径 ③ 空数组→`min(1)` 拒绝 ④ 含空串/非字符串元素→元素级拒绝 ⑤ 元素超 1024 字符→`max` 拒绝 ⑥ 控制对照：旧 `filePathArray` 仍限 1000。
- `file.test.ts`（新增，真实 zod，6 例全过）：① 1500 路径经 `file:delete` 真实接受并全量下发 `moveToRecycleBin` ② 1001/3000 路径通过 ③ 空数组→`IPC_VALIDATION_ERROR` ④ 含空串元素→`IPC_VALIDATION_ERROR` ⑤ 非白名单相对路径→`IPC_PATH_FORBIDDEN` ⑥ 变异验证基准：`bulk` 语义当前生效（>1000 通过、空数组拒绝）。
- **变异验证（已做）**：将 `file.ts` 临时回退为 `schemas.filePathArray`，重跑 `file.test.ts` → 1500/3000/1001 三例失败、安全边界三例仍通过；恢复 `filePathArrayBulk` 后全过。证明回归防线有效。
- 手动回归：见 §2。

## 子任务与验收（实施记录）

| #   | 子任务                   | 修改文件（行号）                                                                                           | 输入/输出                                                                              | 验收标准                                                                         | 状态 |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---- |
| 1   | 新增 `filePathArrayBulk` | `src/main/ipc/validator.ts`（filePathArray 原 48-56 之后，约 57-66）                                       | 输入：需无上限路径数组 schema；输出：新增 `z.array(...).min(1)` 无 `.max`              | `npm run typecheck`/`lint` 无报错；`validator.test.ts` 新 6 例通过               | ✅   |
| 2   | 切换 10 处 handler       | `import-handler.ts:47`；`file.ts:94/107/122/197/286`；`share.ts:31/61`；`watermark.ts:30`；`editor.ts:336` | 输入：原 `schemas.filePathArray`；输出：改为 `schemas.filePathArrayBulk`               | `npm test` 全量 3559 通过（无回归）；`file.test.ts` 大批量用例通过               | ✅   |
| 3   | 更新测试 mock            | `_test-helpers.ts:14-44`（`createSchemasMock` 新增 `filePathArrayBulk = z.array(filePath).min(1)`）        | 输入：mock 缺 `filePathArrayBulk`；输出：mock 补齐该键                                 | handler 测试模块注册不再取到 `undefined`                                         | ✅   |
| 4   | 补充 schema 单测         | `validator.test.ts`（追加 6 例 + 控制对照）                                                                | 输入：bulk/capped schema；输出：>1000 接受、<1000 边界、非法输入拒绝                   | `npx vitest run validator.test.ts` 13 例全过                                     | ✅   |
| 5   | 新增 handler 集成测试    | `file.test.ts`（新建，真实 zod）                                                                           | 输入：真实 `registerFileHandlers` + stub `fileService`；输出：>1000 通过、安全边界拦截 | `npx vitest run file.test.ts` 6 例全过；变异验证有效                             | ✅   |
| 6   | 全量回归                 | 全仓                                                                                                       | 输入：全部改动；输出：无新增失败                                                       | `npm run typecheck` 无错 / `npm run lint` 无错 / `npm test` 187 文件 3559 例通过 | ✅   |
| 7   | 产出本计划               | `docs/plans/2026-08-23-fix-filepath-array-limit-1000.md`                                                   | 输入：实施记录；输出：含 5 强制章节 + 子任务表                                         | 文件已生成并含全部要求章节                                                       | ✅   |

## 备注

- 仅改「IPC 校验层 → handler 注册」这一薄层，未触碰 `mediaIdArray`、批量重命名、扫描器、渲染层等无关逻辑。
- `file:batchRename` 有独立上限 `MAX_BATCH_RENAME_SIZE`，不在本次范围。
