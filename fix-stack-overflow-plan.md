# 修复图库主页 `Maximum call stack size exceeded`（调用栈溢出）

- 日期：2026-09-29
- 版本：wxnn-photo-manager v2.5.1
- 状态：执行中（TDD 红-绿闭环）
- 受影响面：`GalleryPage` 网格视图（`VirtualImageGrid` → `VirtuosoGrid`）

---

## 0. 取证结论（已完成，证据级）

### 0.1 现场数据来源

| 项                  | 值                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 渲染进程故障日志    | `%APPDATA%\wxnn-photo-manager\logs\faults-*.jsonl`                                                               |
| 首次出现 / 最近出现 | 2026-08-14 / **2026-09-29（今日，v2.5.1）**                                                                      |
| 每日命中次数        | 08-14:2、08-15:8、08-19:2、08-21:4、08-26:24、08-27:42、08-30:6、09-03:4、09-05:4、09-09:8、09-12:4、**09-29:4** |
| 带组件栈记录        | 22 条，其中命中 `GalleryPage` **12 条** → 故障集中在图库主页                                                     |

### 0.2 今日原始堆栈（verbatim，pid 5100，uptime 0.7696s）

```
RangeError: Maximum call stack size exceeded
    at Array.values (<anonymous>)
    at app://renderer/assets/index-C0xj9ENW.js:2904:11
    at app://renderer/assets/index-C0xj9ENW.js:10:19
    at app://renderer/assets/index-C0xj9ENW.js:77:13
    at app://renderer/assets/index-C0xj9ENW.js:178:11
    at Array.forEach (<anonymous>)
    at app://renderer/assets/index-C0xj9ENW.js:177:19
    at M (app://renderer/assets/index-C0xj9ENW.js:41:3)
    at app://renderer/assets/index-C0xj9ENW.js:222:36
    at app://renderer/assets/index-C0xj9ENW.js:178:11
```

组件栈：

```
at app://renderer/assets/index-C0xj9ENW.js:2300:23     ← VirtuosoGrid 内部
at div (<anonymous>)
at app://renderer/assets/share-NZRxLH6c.js:736:14      ← VirtualImageGrid
at BoundaryChildren / ErrorBoundary                    ← GalleryPage 区域级兜底
at div
at GalleryPage (GalleryPage-lYY3ZWQT.js:4890:17)
```

### 0.3 堆栈 → 源码映射

本地构建产物 `dist/renderer/assets/` 存在**同名同 content-hash** 文件
（`index-C0xj9ENW.js` 89175 B、`GalleryPage-lYY3ZWQT.js`、`share-NZRxLH6c.js`、
`index-CzbAHGUH.js`），因此混淆帧可逐一反查：

| 混淆帧位置            | 映射结果（`index-C0xj9ENW.js` = react-virtuoso 代码块）                          |
| --------------------- | -------------------------------------------------------------------------------- |
| `index-…:1` import 行 | `import { R as React, … } from "./index-CzbAHGUH.js"` → 确认为 react-virtuoso 块 |
| `177:19` / `178:11`   | 响应式流发布器 `U()`：`case we: t.slice().forEach(o => o(n))`                    |
| `222:36`              | `at()`（combineLatest）输入处理器：`n[i]=c, o\|=l, o===r && M(e,n)`              |
| `41:3`（`M`）         | 发布函数 `M(t,e){ t(we, e) }`                                                    |
| `77:13` / `10:19`     | `P()` 过滤 `t(n) && e(n)` / `re()` 映射 `t(e(n))`                                |
| `2904`                | **gridDimensions 网格维度计算**（源码 `index.mjs:3083-3109`）                    |
| `2300:23`             | 网格根组件 `const {children:H, ...y} = a, [k] = React.useState(() => …)`         |

**结论**：这是 **react-virtuoso 网格响应式图内部的同步「发布 → combineLatest 输入处理器 →
再发布」环路**，并非项目自有递归代码。`GalleryPage` 现有的区域级 `ErrorBoundary`
（2026-08-26 的缓解措施，登记于 `docs/技术债清单.md:115-118`）只能降级、无法根除。

### 0.4 环路为何不收敛（待直观证伪/证实，见 §5 二分）

`index.mjs:3095-3107` 的 gridDimensions 映射器：

```js
if (xt === 0 && (b === 0 || sn === 0)) return Bn   // 守卫仅在 xt===0 时生效
if (Ee === 0) { … return Pr(Ln(dn, ho, ct)) }      // itemWidth=0 分支
const ge = fo(sn, Ee, Wt)                          // 列数 =(视口宽+列间距)/(项宽+列间距)
const an = On(b / ge)                              // Math.ceil(总数/列数) → ge=0 时为 Infinity
const po = an * he + (an - 1) * ee - cn            // offsetBottom → Infinity/NaN
```

`visibleRange`（`index.mjs:1521`）又由列表渲染结果回流作为 gridDimensions 的输入。
正常情况下环被 `W()`/`nt()` 的 distinct 去重算子切断；一旦产出 `NaN/Infinity`，
`NaN !== NaN` 使去重永久失效 → **同步栈溢出**。

---

## 1. 依赖声明

| 类别     | 结论                                                                                   |
| -------- | -------------------------------------------------------------------------------------- |
| 新增依赖 | **无**                                                                                 |
| 版本变更 | **无**（`package.json` / lockfile 均不改动）                                           |
| 现有依赖 | `react-virtuoso ^4.18.11`（已安装，不改版本，避免 Safe-Delete 网关下的 lockfile 漂移） |
| 安装方式 | 无需安装；若缺包只能用 `npm install` 增量安装，**禁止** `npm ci` / `rm node_modules`   |

---

## 2. 启动说明

### 2.1 环境准备

```powershell
cd "d:\Users\Downloads\WXNN XiangCe（jiu)"
# node_modules 已存在（已确认 node_modules/.bin/vitest.cmd 存在）
```

### 2.2 命令与验证方式

| 阶段         | 命令                                                                                                   | 期望                            |
| ------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------- |
| 红灯（复现） | `npx vitest run src/renderer/components/gallery/VirtualImageGrid.grid-cycle.test.tsx`                  | **失败**（修复前必须失败）      |
| 绿灯         | 同上                                                                                                   | 全部通过                        |
| 局部回归     | `npx vitest run src/renderer/components/gallery` <br> `npx vitest run src/renderer/pages/GalleryPage*` | 全部通过                        |
| 类型检查     | `npm run typecheck`                                                                                    | 退出码 0                        |
| 静态检查     | `npm run lint`                                                                                         | 退出码 0                        |
| 全量测试     | `npm test`                                                                                             | 无新增失败                      |
| 构建         | `npm run build`                                                                                        | 成功产出 `dist/renderer/assets` |

### 2.3 运行时验收（附加）

重新打包运行后，`%APPDATA%\wxnn-photo-manager\logs\faults-<今日>.jsonl`
中不再出现 `Maximum call stack size exceeded`。

---

## 3. 错误处理

| 场景                                      | 处理策略                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 容器尚未测得有效尺寸（首帧/隐藏态）       | 不挂载 `VirtuosoGrid`，渲染与 EmptyState 同层的轻量占位；测得后自动挂载（无需用户干预）                                         |
| 第三方库再次抛出 `RangeError`             | 由 `GalleryPage` 既有区域级 `ErrorBoundary`（`resetKeys` / `maxRetries=3` / `ZoneErrorFallback`）捕获，局部降级，不影响其它区域 |
| `columns` 计算越界（NaN / ≤0 / Infinity） | clamp 到 `[1, max]`；不抛错、不写日志（纯函数降级）                                                                             |
| `overflow-hidden` 容器尺寸为 0            | 视为「未就绪」，走占位分支，不进入第三方库，杜绝 Infinity 传播                                                                  |
| 日志规范                                  | 本次修复**不新增日志输出**；断言只依赖返回值与 DOM 结构，不依赖 console 内容                                                    |

---

## 4. 参数校验

| 入参 / 状态                     | 校验规则                                                             | 非法值处理                |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------- |
| `items`（props）                | 必须 `Array.isArray`；否则降级为 `[]`（现有逻辑，保留）              | 降级，不抛错              |
| `columns`（内部 state）         | 必须有限且 ≥ 1；`Number.isFinite` 检查后 clamp 到 `[1, MAX_COLUMNS]` | 非法值 clamp，不抛错      |
| 容器实测宽/高                   | `Number.isFinite` 且 `> 0` 才认为就绪                                | 未就绪 → 不挂载第三方网格 |
| `List` 的 `gridTemplateColumns` | 只接受 clamp 后的整数 `columns`，不接受 NaN/负值                     | clamp，不抛错             |
| `gap`                           | 保持现有常量 `16`（正数）                                            | 保持不变                  |
| `increaseViewportBy`            | 保留 `{top:100,bottom:100}`（与 `RecycleBinPage` 用法对齐）          | —                         |

---

## 5. 子任务分解

### 子任务 1：写入实施计划文件 ✅ 本文件

- **文件**：`fix-stack-overflow-plan.md`（仓库根目录）
- **输入**：§0 取证结论
- **输出**：本 Markdown 文档
- **验收**：文件存在于仓库根目录，包含依赖声明 / 启动说明 / 错误处理 / 参数校验 / 测试用例五节

### 子任务 2：红灯复现用例

- **文件（新建）**：`src/renderer/components/gallery/VirtualImageGrid.grid-cycle.test.tsx`
- **输入**：`VirtualImageGrid` + 受控容器尺寸 + 受控 `react-virtuoso` 探针
- **输出**：至少 1 个用例在**修复前失败**
- **验收**：`npx vitest run <该文件>` 退出码非 0，失败信息明确指向「退化输入被喂给网格」
- 先行尝试：不 mock `react-virtuoso`，用真实库在 jsdom 下复现 `RangeError`；
  若 jsdom 无布局导致无法稳定复现，则退化为「输入守卫 + 契约断言」红灯用例
  （必须对退化输入敏感，即当前代码确实把退化输入喂给了网格 → 红）

### 子任务 3：二分定位触发输入

- **方式**：在红灯用例上逐项关闭候选输入，观察红转绿：
  1. `overscan={150}`（与 `increaseViewportBy` 并用的冗余视口放大旋钮）
  2. `increaseViewportBy={{top:100,bottom:100}}`
  3. 容器未测得有效尺寸时即挂载（ widths=0 → 列数 `ge=0` → `Infinity`）
  4. `rangeChanged` 触发的 300ms 定时器回调链路
- **输出**：一份「哪一项触发 → 该项被移除后转绿」的判定表
- **验收**：判定表至少有一项可使红灯转绿，且该改动不破坏 §5 子任务 2 的其它用例

### 子任务 4：按结论最小化修改 `VirtualImageGrid.tsx`

- **文件（修改）**：`src/renderer/components/gallery/VirtualImageGrid.tsx`
- **候选改动（按子任务 3 结论择一或组合，禁止无证据扩大）**：
  - A. 移除 `overscan={150}`（保留 `increaseViewportBy`），与 `RecycleBinPage.tsx:376-383` 用法对齐
  - B. 增加容器尺寸就绪门控，未就绪时不挂载 `VirtuosoGrid`
  - C. `columns` clamp 到 `[1, MAX]`（复用现有 `getResponsiveColumns` / `DEFAULT_COLUMNS_BREAKPOINTS`）
- **输入**：props（`items` / `selectedIds` / 回调）+ 容器实测尺寸
- **输出**：喂给 `VirtuosoGrid` 的 props 与 `List` 样式永不退化
- **验收**：子任务 2 的用例由红转绿；视觉/交互行为（虚拟滚动、多选、缩略图分级、响应式列数、触屏按钮）不变

### 子任务 5：局部回归

- **文件**：`src/renderer/components/gallery/**`、`src/renderer/pages/GalleryPage*`
- **命令**：`npx vitest run src/renderer/components/gallery`、对 GalleryPage 相关测试再补一轮
- **验收**：全部通过

### 子任务 6：全局校验

- **命令**：`npm test` + `npm run typecheck` + `npm run lint` + `npm run build`
- **验收**：全量测试无新增失败；typecheck / lint 退出码 0；build 成功

### 子任务 7：复核其它 Virtuoso 调用点 + 文档收尾

- **文件（修改）**：`docs/技术债清单.md`（第 115-118 行登记项状态）
- **文件（新建）**：`docs/plans/2026-09-29-fix-gallery-stack-overflow.md`（复盘）
- **验收**：技术债清单与复盘文档同步更新；其它调用点不受本次改动影响

---

## 6. 基础测试用例设计（覆盖正常 / 异常 / 边界）

测试文件：`src/renderer/components/gallery/VirtualImageGrid.grid-cycle.test.tsx`

| #   | 场景类别 | 用例名                                                                 | 输入                                    | 期望                                                                                     |
| --- | -------- | ---------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | 正常     | 有效尺寸下正常挂载并渲染首屏卡片                                       | 容器 1200×800，items=3000               | 渲染出 `[role="grid"]` 且 `.media-card` 数量 > 0，无异常抛出                             |
| 2   | 异常     | 容器未测得有效尺寸时**不**把退化输入喂给网格                           | 容器 0×0（模拟首帧/隐藏态），items=3000 | 不挂载 `VirtuosoGrid`；不出现 `gridTemplateColumns: repeat(NaN/0, …)`；不抛 `RangeError` |
| 3   | 边界     | `getResponsiveColumns` 收到非法宽度（NaN / -1 / Infinity）时列数仍 ≥ 1 | width = NaN / -1 / Infinity             | clamp 后 `gridTemplateColumns` 的 `repeat(N, …)` 中 N 为 ≥1 的有限整数                   |
| 4   | 异常     | `items` 非数组（null）时降级为空                                       | items = null                            | 不抛错，按空列表处理（沿用现有行为）                                                     |
| 5   | 边界     | 大列表（3000 条）不抛 `Maximum call stack size exceeded`               | items = 3000                            | `expect(renderError).toBeNull()`                                                         |

> 硬性要求：用例 2、3 在修复前必须失败；若修复前即通过，则该用例未有效覆盖本 Bug，必须重写。

---

## 7. 风险控制

- 仅改动 `src/renderer/components/gallery/VirtualImageGrid.tsx` 及其测试文件；
  其它 Virtuoso 调用点（`ListView` / `TimelineView` / `EventTimelineView` / `RecycleBinPage` / `DuplicatesPage`）在未经证据支持下一律不动。
- 不修改 IPC 通道名 / preload 暴露面 / handler 签名，`docs/IPC_CONTRACT.md` 无需变更。
- 不引入 `flushSync`、深拷贝、自研虚拟滚动等额外开销方案。
- Safe-Delete 网关环境下禁止 `npm ci` 与 `Remove-Item node_modules`。
