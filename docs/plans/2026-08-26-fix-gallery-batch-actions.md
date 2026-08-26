# 修复图库底部批量操作栏「字体显示不全」

> 交付日期：2026-08-26
> 状态：已实施并通过自动化验证（tsc + ESLint）；视觉验证为人工步骤。

## 1. 问题现象

「图库」板块选中图片后，底部弹出的批量操作浮动栏（BatchActions）文字被截断：

- “导出到默认”显示成“出到到”
- “WiFi 分享”显示成“WiFi 分 1”
- “分享”二字间出现不必要空隙

文字无法完整阅读，影响所有操作的可辨识性。

## 2. 根因分析

`src/renderer/styles/globals.css` 中 `.icon-btn` 是**裸 CSS（不在 `@layer` 内）**，定义：

```css
.icon-btn {
  width: 36px;
  overflow: hidden; /* … */
}
```

且其源顺序位于 Tailwind `utilities` 之后。BatchActions 的按钮虽然写了 `w-auto`，但：

- 裸 CSS `.icon-btn { width:36px }` 在**源顺序**上压制了 Tailwind `w-auto`（utilities 层）；
- 按钮被固定为 36px，`overflow: hidden` 将超出 36px 的中文标签裁剪。

叠加容器 `flex-wrap` + 按钮 `flex-shrink-0` 在窄视口下无法容纳全部标签，进一步放大截断。

**检查项（diagnose 复核）**：

1. `.icon-btn` 是否为裸 CSS → 是（`@layer components` 于 globals.css:300 关闭，`.icon-btn` 在 :389 其外）。
2. 是否 `width:36px; overflow:hidden` → 是（:390 / :402）。
3. BatchActions 按钮 `w-auto` 是否被压制 → 是（源顺序）。
4. 容器 `flex-wrap` + `max-w` 是否放大问题 → 是。

## 3. 修复方案

最小侵入、不引入新依赖，复用项目已有 Tailwind + 玻璃拟态体系：

1. **容器**：`flex-wrap` → `flex-nowrap overflow-x-auto`，单行水平滚动展示全部按钮；移除 `justify-center`。
2. **隐藏滚动条**：新增 `.scrollbar-hide` 工具类（`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`），视觉保持干净；不支持的浏览器优雅降级为系统滚动条。
3. **按钮宽度自适应**：新增 `.batch-act-btn`（裸 CSS，写在 `.icon-btn` 之后）覆盖固定宽度：
   ```css
   .batch-act-btn {
     width: auto;
     min-width: 36px;
     flex-shrink: 0;
   }
   ```
   按钮 `className` 由 `icon-btn text-sm px-3 w-auto gap-1 whitespace-nowrap flex-shrink-0` 改为
   `icon-btn batch-act-btn text-sm px-3 gap-1 whitespace-nowrap`。
4. 同源根因的 `ShareMenuButton`（底部栏“分享”按钮）一并修复：`w-auto` → `batch-act-btn`。
5. 保留全部操作按钮、回调、无障碍属性（`aria-label` / `role="toolbar"`）不变。

## 4. 子任务清单（文件 / 输入输出 / 验收）

| 子任务      | 修改文件                                                        | 输入                | 输出                                              | 验收标准                                                                                         |
| ----------- | --------------------------------------------------------------- | ------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 改容器布局  | `src/renderer/components/gallery/BatchActions.tsx`              | 原 `flex-wrap` 容器 | `flex-nowrap overflow-x-auto scrollbar-hide` 容器 | 容器 className 含 `scrollbar-hide`/`overflow-x-auto`/`flex-nowrap`，不含 `flex-wrap`（测试 T02） |
| 新增 CSS 类 | `src/renderer/styles/globals.css`                               | 裸 CSS `.icon-btn`  | 新增 `.batch-act-btn` + `.scrollbar-hide`         | `npx tsc -b` 与 `npx eslint` 本次文件 0 错误；类可被 CSS 解析                                    |
| 修分享按钮  | `src/renderer/components/common/ShareMenuButton.tsx`            | `icon-btn … w-auto` | `icon-btn batch-act-btn …`                        | ESLint 0 错误                                                                                    |
| 基础测试    | `src/renderer/components/gallery/BatchActions.test.tsx`（新增） | 组件 + props        | 渲染/交互断言                                     | 见第 8 节（正常环境 `npx vitest run` 全通过）                                                    |

## 5. 依赖声明

- **无新增 npm 依赖**。仅使用项目已安装的 `tailwindcss` 与现有 CSS 变量体系。
- 验证 UI 使用项目已有脚本：`npm run storybook`、`npx electron-vite dev`。

## 6. 启动 / 验证说明

1. `npx tsc -b` —— 对改动文件做类型检查（本次 3 文件 0 错误）。
2. `npx eslint src/renderer/components/gallery/BatchActions.tsx src/renderer/components/gallery/BatchActions.test.tsx src/renderer/components/common/ShareMenuButton.tsx` —— 0 错误。
3. `npm run storybook` —— 打开 `Gallery/BatchActions` 故事，将窗口宽度拖窄，确认所有按钮文字完整且可横向滚动。
4. （可选）`npx electron-vite dev` —— 在图库选中若干图片，验证底部栏文字无截断。
5. （正常环境）`npx vitest run src/renderer/components/gallery/BatchActions.test.tsx`。

> 注：本机 vitest 运行环境损坏（任何测试在 setup.ts 抛 `TypeError: Cannot read properties of undefined (reading 'on')`，与本次改动无关），故单元测试以代码审查 + 正常环境运行为交付标准。

## 7. 错误处理 / 参数校验

- 按钮条件渲染逻辑不变：`onExportToDefault` / `onBatchRename` / `onCategorize` / `onTransferToProfile` / `onShareWifi` / `onShareClipboard` 未传入时不渲染对应按钮（已有逻辑，测试 T06/T07 覆盖）。
- `count` / `total` 为 `number`，由父组件 `GalleryPage` 经 `BatchActionsProps` 接口约束；本次不新增 props，无需扩展接口。
- 滚动条隐藏为纯 CSS 装饰，不影响功能与交互。

## 8. 基础测试用例（BatchActions.test.tsx）

- T01 渲染 `role="toolbar"` 容器。
- T02 容器含 `scrollbar-hide`/`overflow-x-auto`/`flex-nowrap`，不含 `flex-wrap`（防回归）。
- T03 必选按钮（全选/反选/删除/导出/移动/水印）渲染。
- T04 选中计数文案 `3 / 31 项已选择`。
- T05 “清除选择”经 `aria-label` 可访问。
- T06 传入可选回调时渲染（导出到默认/批量重命名/分类/转移到档案/WiFi 分享/分享）。
- T07 未传可选回调时不渲染对应按钮。
- T08 点击“全选”触发 `onSelectAll`。
- T09 点击“删除”触发 `onDelete`。
- T10 点击“清除选择”触发 `onClear`。

## 9. 范围声明

仅改动底部批量操作栏布局与宽度修复相关代码（`BatchActions.tsx`、`globals.css`、`ShareMenuButton.tsx`），未触碰筛选/分页/图库核心功能。
