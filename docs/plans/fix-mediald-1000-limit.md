# 修复计划：删除/恢复功能报「参数校验失败：mediaId 数组长度上限 1000」

- 计划 ID：`fix-mediald-1000-limit`
- 创建日期：2026-08-18
- 状态：已确认，进入实施
- 修复范围：**仅** `src/main/ipc/validator.ts` 与 `src/main/ipc/handlers/media-lifecycle-handler.ts` 两处；不触碰图库/导入/缓存板块业务代码、不改动数据库层、不引入任何新依赖。

---

## 1. 问题现象与根因

### 1.1 现象

打包后版本在以下板块使用"删除/恢复"功能时，控制台/弹窗报错：

```
参数校验失败:[0] mediald 数组长度上限1000x
```

（"mediald" 系用户口语对 "media id" 的转述。）

### 1.2 根因（已实测定位）

- 报错文案来自 i18n 键 `main.validator.mediaIdsMaxLength = "mediaId 数组长度上限 {{max}}"`，经 `wrapHandler` 包装为 `参数校验失败：mediaId 数组长度上限 1000`。
- 触发点：`src/main/ipc/validator.ts` 的 `schemas.mediaIdArray` 带 `.max(MAX_MEDIA_ID_ARRAY_SIZE)`，`MAX_MEDIA_ID_ARRAY_SIZE = 1000`（`src/main/utils/constants.ts`）。
- 该 schema 被 `media-lifecycle-handler.ts` 中三个 handler 复用：
  - `media:softDelete`（约 167 行）
  - `media:restore`（约 180 行）
  - `media:permanentDelete`（约 190 行）
- 下游数据库层 `media-repository.ts` 的 `softDeleteBatch` / `restoreBatch` / `hardDeleteBatch` / `getMediaPathsByIds` 均已通过 `runChunkedTransaction` / `queryChunked` 调用 `sql-chunk.ts` 的 `chunkArray`（默认 500）**分片执行**，可承载任意长度的数组。
- 结论：1000 上限**纯粹是校验层的人为限制**，下游完全能处理更大数组。移除该上限即可修复，不降低安全边界（元素级「正整数 + 非空」校验保留）。

### 1.3 四个板块命中分析

| 板块            | 调用方式                                        | 是否命中 1000 上限     | 本修复影响       |
| --------------- | ----------------------------------------------- | ---------------------- | ---------------- |
| 重复文件        | `DuplicatesPage` 全量 `softDelete(ids)`         | **命中**（>1000 报错） | 修复             |
| 回收站-恢复     | `RecycleBinPage` 全量 `restore(ids)`            | **命中**（>1000 报错） | 修复             |
| 回收站-彻底删除 | 全量 `permanentDelete(ids)`                     | **命中**（>1000 报错） | 修复             |
| 图库            | 逐条 `softDelete([id])` / `file.delete([path])` | 当前不命中（单元素）   | 无回归保障，不改 |
| 图片导入        | 路径级 `softDeleteByRootPath`，非 mediaId 数组  | 不依赖 `mediaIdArray`  | 无影响           |
| 缓存            | 非 mediaId 数组路径                             | 不依赖 `mediaIdArray`  | 无影响           |

---

## 2. 依赖声明

本修复**不新增任何 npm 依赖**，全部复用项目既有能力：

| 依赖/工具                      | 用途                                        | 来源                                    |
| ------------------------------ | ------------------------------------------- | --------------------------------------- |
| `zod`（已安装）                | IPC 参数 schema 定义与校验                  | `package.json` → `dependencies`         |
| `sql-chunk.ts`（`chunkArray`） | 下游 500 分片（已存在且有单测，**零改动**） | `src/main/database/sql-chunk.ts`        |
| `media-repository.ts` 批量方法 | 下游分片写入（**零改动**）                  | `src/main/database/media-repository.ts` |
| Vitest（已安装）               | 单元测试                                    | `package.json` → `devDependencies`      |
| `electron` / `better-sqlite3`  | 既有运行时                                  | 不变                                    |

> 复用而非自写：分片逻辑直接复用成熟稳定的 `chunkArray`，不重新实现分片。本修复仅调整"校验闸门"，不重复造轮子。

---

## 3. 启动说明

### 3.1 开发/测试环境

```bash
# 安装依赖（本机受限环境用 npm install 增量安装，勿用 npm ci）
npm install

# 仅跑主进程（IPC/handler）单测
npm run test:main          # = vitest run src/main

# 仅跑数据库层单测（含 sql-chunk 分片测试）
npm run test:db            # = vitest run src/main/database

# 全量单测
npm test                  # = vitest run

# 类型检查
npm run typecheck         # = tsc -b

# Lint
npm run lint              # = eslint .
```

### 3.2 GUI 打包验证说明（受限环境）

本机无头环境**无法启动 GUI**，故"启动服务后接口可正常调用"以 **Vitest 中 mock Repository 的 handler 集成测试**代替；边界（>1000 id 通过校验并落到 repo 批量方法）由 `media.test.ts` 新增用例覆盖。

> 若需真实打包验证：本机 `npm run build` 的 `clean` 步会触发安全网关 EPERM，应改用：
> `npx electron-vite build` → 写 `dist/main/package.json {type:"commonjs"}` → `npm run pre-dist-check` → `npm run verify:dist`。

---

## 4. 错误处理

- **校验失败（保持既有行为）**：`wrapHandler` 内 `schema.safeParse` 失败时，返回 `{ success:false, error:{ code: VALIDATION_ERROR, message:"参数校验失败：…" } }`。本修复仅放宽数组长度上限，**保留**：
  - `.min(1)` —— 空数组仍被拒（message：`mediaIdsRequired`）
  - `.int().positive()` —— 含 `0`/负数/非数字的数组仍被拒（message：`mediaIdPositive`）
- **下游 DB 失败**：`media-repository` 事务抛错仍由 `handleError` 统一捕获，转 `INTERNAL_ERROR`，不改动。
- **彻底删除二次确认**：`permanentDelete` 的 `dialog.showMessageBox` 取消/确认逻辑、`trashBatch` 三态（ok/missing/failed）与熔断逻辑**完全不变**。
- **不引入新的错误码与文案**：无需改动 i18n 资源。

---

## 5. 参数校验（核心改动）

`src/main/ipc/validator.ts` 的 `schemas` 集合中**新增**独立 `mediaIdArrayBulk`，仅去掉 `.max(1000)`：

```ts
/** mediaId 数组（批量删除/恢复用：保留元素级校验，但去掉 1000 人为上限；下游 sql-chunk 已按 500 分片） */
mediaIdArrayBulk: z
  .array(z.number().int().positive(t('main.validator.mediaIdPositive')))
  .min(1, t('main.validator.mediaIdsRequired')),
```

- **保留** `analyzeSceneTime` / `profile:transferFiles` 使用的 `mediaIdArray`（仍有 `.max(1000)`），控制改动爆炸半径。
- `media-lifecycle-handler.ts` 中三处 `z.tuple([schemas.mediaIdArray])` 改为 `z.tuple([schemas.mediaIdArrayBulk])`。

**校验边界对照表**

| 输入                       | 修复前                | 修复后                          |
| -------------------------- | --------------------- | ------------------------------- |
| `[1,2,3]`                  | 通过                  | 通过                            |
| 1500 个合法 id             | ❌ 报 1000 上限       | ✅ 通过→`softDeleteBatch(1500)` |
| 2000 个合法 id（彻底删除） | ❌ 报 1000 上限       | ✅ 通过→分片 `hardDeleteBatch`  |
| `[]`                       | ❌ `mediaIdsRequired` | ❌ `mediaIdsRequired`（不变）   |
| `[0]` / `[-1]`             | ❌ `mediaIdPositive`  | ❌ `mediaIdPositive`（不变）    |
| `[1.5]` / `['a']`          | ❌ 类型错误           | ❌ 类型错误（不变）             |

---

## 6. 基础测试用例（必含）

在 `src/main/ipc/handlers/media.test.ts` 新增以下用例（沿用既有 `registerMediaHandlers` + `getHandler` + `repoMock` 模式）：

1. **`media:softDelete` 传入 1500 个合法 id → 通过并调用 `softDeleteBatch(1500)`**
   - 输入：`Array.from({length:1500}, (_,i)=>i+1)`
   - 验收：`repoMock.softDeleteBatch` 被调用且参数长度为 1500；返回 `success:true`。
2. **`media:restore` 传入 1200 个合法 id → 通过并调用 `restoreBatch(1200)`**
   - 输入：1200 个合法 id
   - 验收：`repoMock.restoreBatch` 被调用且参数长度为 1200；返回 `success:true`。
3. **`media:permanentDelete` 传入 2000 个合法 id → 二次确认通过后分片 `hardDeleteBatch`**
   - 输入：`showMessageBoxMock` 返回 `{response:1}`；`getMediaPathsByIds` mock 返回 2000 条；`trashItemMock` 成功。
   - 验收：`softDeleteForPermanentDelete` 与 `hardDeleteBatch` 均被调用且参数为 2000 个 id；`deletedCount===2000`。
4. **负向-空数组**：`media:softDelete([])` → 返回 `success:false` 且 `error.code==='VALIDATION_ERROR'`（仍为 `mediaIdsRequired`）。
5. **负向-含非正整数**：`media:softDelete([[1,0,-5,'x']])` → 返回 `success:false` 且 `error.code==='VALIDATION_ERROR'`（仍为 `mediaIdPositive`）。

> 既有用例（`media:softDelete` 传 `[1,2,3]`、`media:restore` 传 `[1,2]`、所有 `permanentDelete` 三态用例）**必须继续全部通过**（回归保障）。

---

## 7. 子任务清单（逐步验证）

> 每步必须验证通过后再进入下一步。

### 子任务 1：撰写本计划 MD ✅

- 修改文件：`docs/plans/fix-mediald-1000-limit.md`（新建）
- 输入：根因分析
- 输出：本文件（含依赖声明/启动说明/错误处理/参数校验/基础测试用例五章节）
- 验收标准：章节齐全，含修改文件/输入输出/验收标准字段。

### 子任务 2：新增 `mediaIdArrayBulk` schema

- 修改文件：`src/main/ipc/validator.ts`
- 输入：在 `schemas` 对象中新增 `mediaIdArrayBulk`（见 §5 代码片段）
- 输出：schema 定义
- 验收标准：`npm run typecheck` 通过；`mediaIdArrayBulk` 在 `schemas` 中可被引用（Lint 无 unused）。

### 子任务 3：三处 handler 改用 `mediaIdArrayBulk`

- 修改文件：`src/main/ipc/handlers/media-lifecycle-handler.ts`
- 输入：将 `media:softDelete` / `media:restore` / `media:permanentDelete` 的 `z.tuple([schemas.mediaIdArray])` 替换为 `z.tuple([schemas.mediaIdArrayBulk])`
- 输出：handler 注册代码
- 验收标准：`npm run typecheck` + `npm run lint` 通过；`analyzeSceneTime`/`transferFiles` 仍使用原 `mediaIdArray`（未被改）。

### 子任务 4：新增 >1000 id 与负向校验用例

- 修改文件：`src/main/ipc/handlers/media.test.ts`
- 输入：见 §6 五个用例
- 输出：测试代码
- 验收标准：`npm run test:main` 中本文件全部用例通过（含既有回归用例）。

### 子任务 5：全量验证与自修复

- 命令：`npm run test:main` → `npm run test:db` → `npm run typecheck` → `npm run lint`
- 输入：全部源码与测试
- 输出：测试报告
- 验收标准：**全部命令 0 失败**；若有报错，就地修复后重跑直至通过（错误消灭在当下）。

---

## 8. 风险与回滚

- 风险极低：仅放宽校验上限，元素级校验与下游分片不变；无新依赖、无 schema 语义变化影响其他调用方。
- 回滚：仅 `git checkout` 两个文件即可恢复原 1000 上限行为。
