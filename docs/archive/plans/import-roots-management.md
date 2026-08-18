# 指定目录（import_roots）可视化管理

## 背景与根因

用户经「指定目录扫描」（`scanner.start({ path })`）导入后，主进程会把该目录登记进 `import_roots`
表，但此前**没有任何可视化入口**查看或移除这些已登记目录，导致「只增不减」——用户无法关闭曾经选择过的
指定目录。

`ImportRootRepository.removeImportRoot()` 早已实现（并有 4 例单测），但**生产代码无任何调用者**
（无 IPC、无 preload、无 UI）。本方案在现有架构上做最小接线，补齐这一缺口。

## 目标

- 在设置页「扫描」分组下新增独立的「指定目录」管理区块。
- 列出全部已登记目录；逐项移除，确认弹窗提供「仅移出管理」与「同时清除索引记录（进回收站）」两种选择。
- 现有「游戏目录」配置区增加跳转说明，避免与 `customScanPaths` 两套数据混淆。
- 中英双语。

## 数据流

```
UI(ImportRootsSection)
  → preload.importRoot.list()                      → ipc import:roots
  → preload.importRoot.removeRoot(path, clear)     → ipc import:removeRoot
        ├─ ImportRootRepository.removeImportRoot(path)        // 删 import_roots 行
        └─ if clear: MediaRepository.softDeleteByRootPath(path) // 软删该根下 media_files
```

## 修改清单

| 文件                                                | 变更                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/main/database/media-repository.ts`             | 新增 `softDeleteByRootPath(rootPath): Promise<number>`                            |
| `src/main/ipc/handlers/import-root-handler.ts`      | **新增** `registerImportRootHandlers(ctx)`：`import:roots` / `import:removeRoot`  |
| `src/main/app/ipc-setup.ts`                         | 注册 `registerImportRootHandlers(ctx)`                                            |
| `src/main/preload.ts`                               | 新增 `importRoot` 域（`list` / `removeRoot`）+ 随 `typeof electronAPI` 自动带类型 |
| `src/renderer/pages/settings/scan-sections.tsx`     | 新增 `ImportRootsSection`；`ScanPathsSection` 加管理说明                          |
| `src/renderer/pages/settings/sections.tsx`          | 导出 `ImportRootsSection`                                                         |
| `src/renderer/pages/SettingsPage.tsx`               | 「扫描」分组注册 `scan-import-roots` section                                      |
| `src/renderer/i18n/locales/zh-CN.json` / `en.json`  | 新增 `settings.scan.importRoots*` 与 `settings.sections.importRoots`              |
| `src/main/ipc/handlers/import-root-handler.test.ts` | **新增** 6 例 handler 单测                                                        |
| `src/main/database/media-repository.test.ts`        | 扩展 5 例 `softDeleteByRootPath` 单测                                             |

## 依赖声明

无新增运行时/开发依赖。复用：`electron`、`zod`、`better-sqlite3`、`react`、`react-i18next`、`vitest`。

## 关键签名

```ts
// media-repository.ts
/** 软删某导入根前缀下的媒体记录（进回收站，可恢复），返回受影响行数；空/非法路径 no-op 返回 0 */
async softDeleteByRootPath(rootPath: string): Promise<number>

// import-root-handler.ts
export function registerImportRootHandlers(ctx: HandlerContext): void
//   import:roots      -> ImportRootRepository(db, bridge, path).listImportRoots()  : string[]
//   import:removeRoot -> z.tuple([schemas.filePath, z.boolean()])
//                        await removeImportRoot(rootPath)
//                        if clearRecords: await mediaRepo.softDeleteByRootPath(rootPath)
//                        返回 { removed: boolean; cleared: number }

// preload.ts
importRoot: {
  list: () => call<string[]>('import:roots'),
  removeRoot: (rootPath: string, clearRecords: boolean) =>
    call<{ removed: boolean; cleared: number }>('import:removeRoot', rootPath, clearRecords)
}
```

## 实现要点（防回归）

- `softDeleteByRootPath` 对 `normalizeRootPath(rootPath).toLowerCase()` 结果空判断后 **no-op**，
  绝不会生成 `LIKE '%'` 误删全库；`escapeLikePattern` 转义 `_%` 防止目录名通配误伤。
- 复用 `NORMALIZED_PATH_EXPR`（`LOWER(REPLACE(file_path,'\\','/'))`）+ `ESCAPE '\'` 做 `'<root>/%'`
  前缀匹配，规避 Windows 路径大小写差异。
- `import:removeRoot` 中 `removeImportRoot` 与 `softDeleteByRootPath` 两操作**独立 try**：
  `import_roots` 移除成功即视为成功；媒体软删失败仅记日志，不回滚主结果，避免半失败卡死。
- 软删而非硬删，符合项目「回收站可恢复」数据模型；成功后调用 `ctx.notifyMediaUpdated()` 刷新图库。
- 所有 DB 写沿用 `runWrite`（有 workerBridge 走 utilityProcess，否则同步直写），与现有 Repository 模式一致。

## 参数校验

- `import:removeRoot` 入参：`z.tuple([schemas.filePath, z.boolean()])`；`schemas.filePath` 已含
  `z.string().min(1)`，空/非法路径被 zod 拒，绝不触发 DB 写。
- `removeImportRoot` 内部对空路径抛错（已存在）。
- `softDeleteByRootPath` 对空/非法 `rootPath` 直接 no-op，不生成 `LIKE`。

## 错误处理

- `import:roots` 失败：渲染端 `try/catch` 显示空列表 + 错误 toast。
- `import:removeRoot` 失败：handler 内 `try/catch` 降级为 `AppError`；渲染端 toast 报错，列表保持原状不刷新。
- 媒体软删失败不影响 `import_roots` 行移除（两操作独立 try）。

## 单元测试

- `media-repository.test.ts`（扩展）：空根 no-op；仅软删该根前缀、不影响其他根；Windows 反斜杠/大小写
  归一化匹配；目录名含下划线/百分号不触发通配；生成正确的 `LIKE ? ESCAPE` 条件与归一化参数。
- `import-root-handler.test.ts`（新增 6 例）：注册两个 channel；`import:roots` 返回全量路径；
  `removeRoot`(clearRecords=false) 仅调用 `removeImportRoot`；(clearRecords=true) 调用
  `softDeleteByRootPath` 并触发 `notifyMediaUpdated`；空 rootPath 被 zod 拒绝（未触发任何 DB 写）；
  移除不存在根 no-op 不抛错。

## 红线（不可触碰）

- 不新增 `PathGuard.clearRoots`；不改 `scanner:start` 现有登记逻辑；不改 `customScanPaths` 增删；
- 不改图库放行 SQL。移除仅影响 DB 与图库显示，pathGuard 白名单重启后自然生效。

## 手动验收

1. 设置 → 扫描 → 「指定目录」列出 `import_roots` 全部路径。
2. 点「移除」→ 弹确认框；勾选「同时清除索引记录」后确认 → 该目录 `media_files` 进入回收站（可恢复）。
3. 不勾选仅确认 → 该项从列表消失，媒体记录保留。
4. 「游戏目录」区块下方显示跳转说明。

## 验收命令

```bash
npx vitest run src/main/database/media-repository.test.ts src/main/ipc/handlers/import-root-handler.test.ts
```
