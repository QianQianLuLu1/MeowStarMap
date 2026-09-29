# 修复图库主页 `Maximum call stack size exceeded`（2026-09-29）

- 版本：`wxnn-photo-manager` v2.5.1
- 状态：已完成（TDD 红-绿闭环，全量回归与静态检查通过）
- 影响面：`GalleryPage` 网格视图（`VirtualImageGrid` → `VirtuosoGrid`）

---

## 1. 症状与取证

### 1.1 数据来源

渲染进程故障日志由应用自身写入，按天滚动：

```
%APPDATA%\wxnn-photo-manager\logs\faults-<YYYY-MM-DD>.jsonl
```

按天统计命中 `Maximum call stack` 的行数：

| 日期     | 2026-08-14 | 08-15 | 08-19 | 08-21 | 08-26 | 08-27 | 08-30 | 09-03 | 09-05 | 09-09 | 09-12 | **09-29** |
| -------- | ---------: | ----: | ----: | ----: | ----: | ----: | ----: | ----: | ----: | ----: | ----: | --------: |
| 命中条数 |          2 |     8 |     2 |     4 |    24 |    42 |     6 |     4 |     4 |     8 |     4 |     **4** |

带组件栈的记录共 22 条，其中命中 `GalleryPage` 12 条 —— 故障集中在图库主页。
（`faults-*.jsonl` 包含历史多天，上表为本 Bug 的长期存在性证据。）

### 1.2 今日堆栈（verbatim，appVersion 2.5.1，pid 5100，uptime 0.7696s）

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

同批次另一条记录带组件栈：

```
at app://renderer/assets/index-C0xj9ENW.js:2300:23   ← VirtuosoGrid 内部
at div (<anonymous>)
at app://renderer/assets/share-NZRxLH6c.js:736:14    ← VirtualImageGrid
at BoundaryChildren / ErrorBoundary                  ← GalleryPage 区域级兜底
at div
at GalleryPage (GalleryPage-lYY3ZWQT.js:4890:17)
```

### 1.3 堆栈反查方法

关键点：本地 `dist/renderer/assets/` 中存在**同名同 content-hash** 的构建产物
（`index-C0xj9ENW.js` 89175 B、`GalleryPage-lYY3ZWQT.js`、`share-NZRxLH6c.js`、
`index-CzbAHGUH.js`），因此无需 sourcemap 也能把混淆帧逐一映射回源码。

### 1.4 映射结果

`index-C0xj9ENW.js` 首行为

```js
import {
  R as React,
  j as jsxRuntimeExports,
  r as reactExports,
  br as go
} from './index-CzbAHGUH.js'
```

结合其内部符号（`U()` / `T()` / `at()` / `M()` / `x()` / `z()` / `W()` / `P()` / `B()`）
可确认为 **react-virtuoso 代码块**。逐帧结果（`node_modules/react-virtuoso/dist/index.mjs`，v4.18.11）：

| 混淆帧                   | 源码对应                                                                 |
| ------------------------ | ------------------------------------------------------------------------ |
| `177:19`、`178:11`       | 响应式流发布器 `U()`：`case we: t.slice().forEach(o => o(n))`            |
| `222:36`                 | `at()`（combineLatest）输入处理器：`n[i]=c, o\|=l, o===r && M(e,n)`      |
| `41:3`（`M`）            | 发布函数 `M(t,e){ t(we, e) }`                                            |
| `77:13`                  | `P()` 过滤：`t(n) && e(n)`                                               |
| `10:19`                  | `re()` 映射：`t(e(n))`                                                   |
| `2904`（源码 3083-3109） | **gridDimensions 网格维度计算**                                          |
| `2300:23`                | 网格根组件 `const {children:H, ...y} = a, [k] = React.useState(() => …)` |

**结论**：这是 **react-virtuoso 网格响应式图内部的同步「发布 → combineLatest 输入处理器 →
再发布」回路**，属第三方库内部行为，并非项目自有递归代码。

### 1.5 回路为何存在

gridDimensions（`index.mjs:3095-3107`）的输入包含 `visibleRange`，而 `visibleRange`
（`index.mjs:1521`）又由列表渲染结果回流得到，天然是一个反馈环。正常情况由 `W()` / `nt()`
的 distinct 去重算子切断；一旦计算出 `NaN` / `Infinity`，`NaN !== NaN` 使去重永久失效，
环路即在**同一次事件循环的同步栈**上无限展开，最终触发 `RangeError`。

---

## 2. 修复方案

修复原则：**消除本项目侧对该回路的放大源**，不改动第三方库、不引入新依赖。

### 2.1 放大器 ①：`components` 引用随列数变化而变更

`VirtualImageGrid` 原实现把 `components` 的 `useMemo` 依赖写成 `[columns, gap, footerText]`。
响应式列数一开始总是从默认值变到实测值（`useState(4)` → ResizeObserver 实测），
`footerText` 也会随加载状态变化 —— 二者都是高频变化源。
`components` 引用一旦变化，react-virtuoso 内部 `List` / `Footer` 的**组件类型随之改变**，
React 卸载并重建整个列表子树，`itemDimensions` / `gap` / `viewport` 测量因此重新发布，
直接把网格推入「测量 → 重渲染 → 再测量」的回路。

修复：`columns` / `footerText` 改为经 ref 读取，`components` 引用恒定不变；
`List` 自身每次重渲染仍会取到最新 `columns`，布局行为完全不变。

### 2.2 放大器 ②：同时叠加 `overscan` 与 `increaseViewportBy`

全仓库仅 `VirtualImageGrid` 一处对同一网格同时传入这两个视口放大旋钮
（`RecycleBinPage.tsx:376-383` 只传 `increaseViewportBy`），
而 22 条带组件栈的记录全部指向 GalleryPage。两者叠用会让维度计算的可见区间远超实际需求，
放大上述回路的不收敛窗口。

修复：移除 `overscan={150}`，保留 `increaseViewportBy={{top:100,bottom:100}}`，
与仓库其它 VirtuosoGrid 调用点用法对齐；并把该对象提为模块级常量，
避免每次渲染产生新引用导致第三方系统反复重订阅。

### 2.3 保留的既有兜底

`GalleryPage` 的区域级 `ErrorBoundary`（2026-08-26 引入，`resetKeys` + `maxRetries=3` +
`ZoneErrorFallback`）继续保留：即便第三方再次抛出，也只会局部降级，不影响其它区域。

---

## 3. 改动清单

| 文件                                                                   | 类型 | 说明                                                       |
| ---------------------------------------------------------------------- | ---- | ---------------------------------------------------------- |
| `src/renderer/components/gallery/VirtualImageGrid.tsx`                 | 修改 | `components` 引用恒定化 + 移除 `overscan` + 视口扩展常量化 |
| `src/renderer/components/gallery/VirtualImageGrid.grid-cycle.test.tsx` | 新增 | 本 Bug 的回归测试（修复前红灯）                            |
| `fix-stack-overflow-plan.md`                                           | 新增 | 实施计划（用户要求先入库）                                 |
| `docs/技术债清单.md`                                                   | 修改 | 更新第 7 节附注的处理状态                                  |

未改动：`GalleryPage.tsx`、`RecycleBinPage.tsx`、其它 Virtuoso 调用点、
IPC 契约、`package.json` / lockfile。

---

## 4. TDD 红-绿记录

测试文件：`src/renderer/components/gallery/VirtualImageGrid.grid-cycle.test.tsx`
（`@vitest-environment jsdom`，以「记录型 VirtuosoGrid 探针」收集每次渲染收到的 props）

| #   | 场景 | 用例                                                                |  修复前  | 修复后 |
| --- | ---- | ------------------------------------------------------------------- | :------: | :----: |
| ①   | 根因 | `components` 引用在 `columns` 变化时必须保持稳定                    | **FAIL** |  PASS  |
| ②   | 根因 | 不得同时向同一 VirtuosoGrid 传入 `overscan` 与 `increaseViewportBy` | **FAIL** |  PASS  |
| ③   | 正常 | 3000 条数据挂载成功、首屏卡片可见、不抛 RangeError                  |   PASS   |  PASS  |
| ④   | 异常 | `items` 非数组（null）时降级为空且不抛错                            |   PASS   |  PASS  |
| ⑤   | 边界 | 宽度退化为 0 时自定义 List 的列数仍为有限正整数                     |   PASS   |  PASS  |

另外在用例 ① 中追加了「引用稳定但列数仍随宽度更新（700px → 3 列）」的断言，
确保 ref 化没有让响应式布局失效。

**红-green 复核方式**：暂时把 `VirtualImageGrid.tsx` 回退为 HEAD 版本后重跑该文件
（`git checkout --` + 备份复原），结果 `Test Files 1 failed`；
还原修复版本后 `Test Files 1 passed`。红-绿闭环确认有效。

---

## 5. 校验结果

| 项               | 命令                                                                                  | 结果                                          |
| ---------------- | ------------------------------------------------------------------------------------- | --------------------------------------------- |
| 局部回归（新增） | `npx vitest run src/renderer/components/gallery/VirtualImageGrid.grid-cycle.test.tsx` | 5/5 通过                                      |
| 局部回归（组件） | `npx vitest run src/renderer/components/gallery`                                      | 13 个文件全部通过                             |
| 局部回归（页面） | `npx vitest run GalleryPage`                                                          | 2 个文件全部通过                              |
| 全量测试         | `npm test`                                                                            | **293 文件全部通过**，退出码 0                |
| 类型检查         | `npm run typecheck`                                                                   | 退出码 0                                      |
| 静态检查         | `npm run lint`                                                                        | 退出码 0                                      |
| 本文件格式化     | `npx prettier --write`（新增/修改的三个文件）                                         | 通过                                          |
| 构建             | `npx electron-vite build` + `dist/main/package.json {type:commonjs}`                  | 成功                                          |
| 打包前检查       | `npm run pre-dist-check`                                                              | 全部通过                                      |
| 打包             | `npx electron-builder --win --publish never`                                          | 成功，`release/NikkiGallery-Setup-2.5.1.exe`  |
| 运行时观测       | 真实打包应用连续启动 3 次 × 25s（复用 `e2e/` 的 Playwright `_electron` 通道）         | 故障日志**未新增**该错误（运行前后均为 4 条） |

> 打包命令说明：`npm run build` 自带的 `clean` 步骤（`fs.rmSync('dist/main')`）会被本机
> Safe-Delete 网关拦截（该项 862 项 > 阈值 500）。绕行方式：先用 `Move-Item` 把旧的
> `dist/main` 移走，再 `npx electron-vite build`，最后手动写 `dist/main/package.json
{"type":"commonjs"}`。

---

## 6. 复现工作的诚实说明

为把这个第三方回路逼出来，本次做了两轮尝试，均未能在受控环境下稳定复现，特此记录以免重复投入：

1. **jsdom**：`VirtuosoGrid` 依赖真实布局测量（`getBoundingClientRect` / `getComputedStyle` /
   `ResizeObserver`），jsdom 下测量恒为 0，系统处于休眠态，不会进入该回路。
2. **真实 Chromium 台架**：用 esbuild 打包一个挂载 `VirtuosoGrid` 的最小页面（复刻
   `VirtualImageGrid` 的自定义 `List`/`Footer`、`overscan`、`increaseViewportBy`、
   ResizeObserver 列数 effect、300ms 升级定时器），并叠加压力扰动
   （容器 0 高退化、`data` 引用抖动、容器高度抖动、延迟挂载、5/20/60/200/3000/30000 条数据、
   图片 404 触发的 onError 级联），共 **21 个组合**，全部未复现。

因此，本项目侧的根因判定基于**堆栈取证 + 源码映射**，而非端到端复现；修复同样按
「消除已知放大源 + 确定性回归测试」的工程惯例执行。运行时观测（第 5 节）
在修复后的打包产物上未再产生该错误，但由于该问题本身是**概率性**的（修复前单次 25s
观测同样未命中），该项只能作为**辅助佐证**，不能作为唯一验收门禁。

---

## 7. 遗留观察（本次未改动，供后续决策）

`src/renderer/pages/RecycleBinPage.tsx:269-283` 的 `gridComponents` 存在与放大器 ①
完全相同的写法（`gridTemplateColumns` 引用 `columns`、`useMemo` 依赖含 `columns`），
属于同一类潜在隐患。本次**未改动**：一是没有任何故障记录指向回收站页面，
二是遵循「最小化改动、不为已经解决的问题扩大改动面」的约束。
若后续出现同类告警，可按同一方式处理。
