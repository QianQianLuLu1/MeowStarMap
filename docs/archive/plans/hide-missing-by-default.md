# 计划：已丢失（is_missing）项目默认隐藏，仅"仅看丢失"时显示

> 状态：已完成实现（2026-08-15）。本文件为完整实施计划 + 已执行结果记录，可直接作为后续维护参考。

## 1. 问题描述

图库主视图（"全部"）当前会显示 `is_missing === true` 的"已丢失"媒体项（带角标）。
用户期望：**已丢失项不应出现在"全部"等常规视图中，仅当用户在上方任务栏勾选"仅看丢失"时才显示。**

## 2. 范围与控制原则

- **仅前端改动**：丢失过滤完全发生在客户端钩子，后端 `media.list`（见 `src/main/database/media-repository.ts`）无 `missingOnly`/`hideMissing` 参数，`media-handler.ts` 仅把 `is_missing` 作为返回字段读出。故本次**不修改任何主进程 / 数据库 / IPC 代码**。
- **唯一改动点**：`src/renderer/hooks/useFilteredMediaFiles.ts`（过滤中枢，被 GalleryPage / DetailPage / FullscreenViewer / App / Sidebar 共用），改动一处即全局统一生效。
- **不引入新依赖**：复用现有 `useFilteredMediaFiles` 钩子、zustand `uiStore`、以及既有 `vitest` + `@testing-library/react` + `vi` 测试基建。
- **不触碰**：`uiStore`、`GalleryToolbar`（"仅看丢失"开关已存在并正确绑定）、`zh-CN.json`（`missingOnly` / `missingOnlyTitle` 文案已存在）。

## 3. 依赖声明

| 类型           | 名称                   | 版本/来源         | 说明                           |
| -------------- | ---------------------- | ----------------- | ------------------------------ |
| 运行时（既有） | react / react-dom      | package.json 现有 | 过滤钩子宿主                   |
| 运行时（既有） | zustand                | package.json 现有 | `uiStore.showMissingOnly` 状态 |
| 测试（既有）   | vitest                 | package.json 现有 | 单测运行器                     |
| 测试（既有）   | @testing-library/react | package.json 现有 | `renderHook`                   |
| 测试（既有）   | vi（vitest 内置）      | —                 | mock / 断言                    |
| 无需新增       | —                      | —                 | 本方案零新增第三方依赖         |

## 4. 启动 / 验证说明

```powershell
# 1) 进入工程根目录（PowerShell）
cd "d:\Nikki Gallery\WXNN XiangCe"

# 2) 定向运行受影响的单元测试（仅该文件，避免整仓 watch 截断）
npx vitest run src/renderer/hooks/useFilteredMediaFiles.test.ts

# 3) 静态校验改动文件
npx eslint src/renderer/hooks/useFilteredMediaFiles.ts src/renderer/hooks/useFilteredMediaFiles.test.ts

# 4)（可选）启动桌面应用人工验收
npm run dev          # 或按仓库约定脚本启动 Electron
```

人工验收：启动应用 → 默认"全部"视图不应出现已丢失项（带角标的灰色项）；点击任务栏"仅看丢失" → 仅显示已丢失项；再次取消勾选 → 恢复隐藏。

## 5. 技术实现

### 5.1 核心改动文件

**文件**：`src/renderer/hooks/useFilteredMediaFiles.ts`

**改动位置**（过滤阶段，原 T02 分支）：

```ts
// T02：已丢失文件默认隐藏，仅在勾选"仅看丢失"时显示
// 默认（showMissingOnly=false）过滤掉 is_missing===true，使其不出现在"全部"/收藏夹等视图
// 字段为 undefined（存量/未扫描完整性）视为未丢失，使用 !== true 防御性判断，避免参数缺失误判
if (showMissingOnly) {
  files = files.filter((f) => f.is_missing === true)
} else {
  files = files.filter((f) => f.is_missing !== true)
}
```

**输入**：`mediaStore.mediaFiles`（含 `is_missing?: boolean | number`） + `uiStore.showMissingOnly: boolean`。
**输出**：过滤后的 `MediaFile[]`（默认隐藏已丢失；`showMissingOnly=true` 时仅保留已丢失）。

### 5.2 关键设计决策

- **`!== true` 防御性判断**：`is_missing` 可能为 `undefined`（存量数据 / 未做完整性扫描）。`f.is_missing !== true` 将 `undefined`/`false`/`0` 一律视为"未丢失"，等价于缺失字段的**参数校验兜底**，不会因字段缺失而误判或抛错。
- **缓存一致性**：`FilterCache` 已包含 `showMissingOnly` 作为依赖键（命中条件与赋值均已存在），翻转默认分支后切换开关仍正确失效缓存，无需改动缓存结构。
- **与"仅看损坏"互斥**：`uiStore.setShowMissingOnly(true)` 会自动关闭 `showCorruptedOnly`，过滤顺序（先 missing 后 corrupted）不受影响。

## 6. 错误处理与参数校验

- **无抛错路径**：过滤为纯函数式 `Array.filter`，无异步 / IO，无 `throw`。
- **字段缺失兜底**：`f.is_missing !== true` 天然兼容 `undefined`/`0`，不依赖数据完整。
- **状态来源校验**：`showMissingOnly` 来自 zustand `uiStore`，其初始值为 `false`（`uiStore.ts` 默认 state），故默认进入"隐藏"分支，行为确定。
- **下游容错**：若某视图依赖 `useFilteredMediaFiles` 且期望看到已丢失项，需显式开启 `showMissingOnly`（符合需求语义）。

## 7. 基础测试用例（已落地于 `useFilteredMediaFiles.test.ts` → `describe('丢失文件')`）

| 用例                                                | 输入                         | 预期输出                                  | 验收    |
| --------------------------------------------------- | ---------------------------- | ----------------------------------------- | ------- |
| `showMissingOnly=true 仅显示 is_missing=true`       | 1 丢失 / 1 未丢失 / 1 未定义 | 长度 1，仅 id='1'                         | ✅ 通过 |
| `showMissingOnly=false（默认）隐藏 is_missing=true` | 1 丢失 / 1 未丢失 / 1 未定义 | 长度 2，仅 id='2','3'（含字段缺失项保留） | ✅ 通过 |
| `recycle-bin 视图默认同样隐藏已丢失项`              | 1 丢失 / 1 已删除            | 结果全部 `is_missing !== true`            | ✅ 通过 |

**执行结果（2026-08-15）**：

- `npx vitest run src/renderer/hooks/useFilteredMediaFiles.test.ts` → **Test Files 1 passed (1)，Tests 34 passed (34)，EXIT:0**。
- `npx eslint` 两个文件 → **0 errors**（仅有既有的中文 `it()` 描述 warning，属仓库既有约定，非本次引入）。

## 8. 子任务清单与验收标准

| 子任务          | 修改文件                                           | 输入 / 输出                                      | 验收标准                                        |
| --------------- | -------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| 1. 影响面核查   | 无（只读）                                         | 调用链检索                                       | 确认仅前端钩子需改、`media.list` 未参与丢失过滤 |
| 2. 翻转默认过滤 | `src/renderer/hooks/useFilteredMediaFiles.ts`      | 输入 mediaFiles+showMissingOnly → 输出隐藏丢失项 | 代码改动完成、lint 0 error                      |
| 3. 补充单测     | `src/renderer/hooks/useFilteredMediaFiles.test.ts` | 用例输入 → 断言输出                              | 定向 vitest 全部通过（34/34）                   |
| 4. 运行验证     | 无新文件                                           | 命令 → 退出码                                    | vitest EXIT:0、eslint 0 error                   |
| 5. 编写计划 MD  | `docs/plans/hide-missing-by-default.md`            | —                                                | 本文件产出，含依赖/启动/错误处理/校验/测试      |

## 9. 回滚方案

若需恢复"默认显示已丢失（带角标）"的旧行为：将 5.1 的 `else` 分支删除、仅保留 `if (showMissingOnly) { ... }` 原逻辑即可，无需改动其它文件。
