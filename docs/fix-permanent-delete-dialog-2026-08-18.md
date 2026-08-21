# 修复计划：图片右键「永久删除」确认后软件内弹窗不关闭

- 日期：2026-08-18
- 模块：`src/renderer/pages/GalleryPage.tsx`
- 严重度：中（功能可用，但 UX 缺陷：删除成功后确认弹窗常驻）
- 修改范围：单文件、单函数（`handleDelete`），严格未触碰 `useFileOperations` / `ConfirmDialog` / `RecycleBinPage`

---

## 0. 问题现象（用户反馈）

打包后版本中，在画廊页对图片**右键 → 永久删除**（或普通删除）：

1. 点击「删除」→ 软件内弹出 `ConfirmDialog` 确认弹窗；
2. 点击确认 → 主进程弹出**系统级删除确认弹窗**（OS shell 二次确认）；
3. 用户在系统弹窗二次确认 → 文件被删除；
4. **缺陷**：第 3 步之后，软件内的 `ConfirmDialog` 仍未自行关闭，需用户手动点「取消/×」才能关掉。

---

## 1. 依赖声明（Dependency Declaration）

本修复**不引入任何新依赖、不新增第三方库**，完全复用项目既有技术栈与既有代码模式（DRY）：

| 类别         | 依赖                                                         | 版本/来源                                               | 用途                | 是否新增     |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------- | ------------------- | ------------ |
| 运行时框架   | Electron + React 18 + TypeScript                             | 项目既有（`package.json`）                              | UI 与类型           | 否           |
| 状态管理     | React `useState` + Zustand（`useMediaStore` / `useUIStore`） | 项目既有                                                | 组件状态            | 否           |
| 删除逻辑     | `useFileOperations.getDeleteConfirm`                         | 既有 `src/renderer/hooks/useFileOperations.ts`          | 生成删除确认配置    | 否（仅调用） |
| 确认弹窗     | `ConfirmDialog`（含 `BaseDialog`）                           | 既有 `src/renderer/components/common/ConfirmDialog.tsx` | 渲染确认弹窗        | 否（仅消费） |
| 测试框架     | Vitest                                                       | 项目既有（`package.json` → `vitest`）                   | 单元测试            | 否           |
| 测试断言模式 | 源码结构性断言（读文件文本匹配）                             | 既有 `GalleryPage.test.tsx` 约定                        | 重页面不整页 render | 否           |

> 选型依据：项目渲染层「重页面」（依赖 `react-virtuoso` / store / i18n / 大量子组件）**不做完整 `render`**，沿用 `GalleryPage.test.tsx` 已有的「源码结构性断言」模式。修复直接复用 `handleBatchDelete` / `handleCleanupCorrupted` 既有的 `setConfirmDialog((prev) => ({ ...prev, open: false }))` 关闭写法，零新增抽象。

---

## 2. 根因分析（已核实，非猜测）

- `GalleryPage.handleDelete`（修改前 `src/renderer/pages/GalleryPage.tsx:267-278`）把
  `fileOperations.getDeleteConfirm(file, permanent).onConfirm` **直接透传**为
  `ConfirmDialog` 的 `onConfirm`：
  ```ts
  onConfirm: config.onConfirm // ← 只执行删除，从不关闭对话框
  ```
- `useFileOperations.getDeleteConfirm` 返回的 `onConfirm`（见 `useFileOperations.ts` 约 276–308 行）**只负责调 IPC 删除 + 删 store 项**，它**无权也不关闭** `confirmDialog` 这一组件状态。
- 对比同文件两条**已正确**路径：
  - `handleBatchDelete`（约 416 行）`finally` 中 `setConfirmDialog((prev) => ({ ...prev, open: false }))`
  - `handleCleanupCorrupted`（约 439 行）`finally` 中同样关闭
  - 这两条都显式关闭弹窗；唯独单文件删除路径（`handleDelete`）漏掉了关闭动作 → 弹窗 `open` 恒为 `true`，常驻不关。
- 回收站页 `RecycleBinPage` 的永久删除弹窗关闭逻辑**已正确**，不在本次范围。

**结论**：缺陷 100% 位于 `GalleryPage.handleDelete` 一处；修复只需在该函数内包裹一层关闭逻辑，影响面可控。

---

## 3. 修复方案（最小改动）

仅修改 `GalleryPage.handleDelete` 的 `onConfirm` 字段，用 `try/finally` 包裹，确保**无论删除成功、失败或抛错，弹窗都关闭**，与既有两条路径模式完全一致：

```ts
// #fix-permanent-delete-dialog：单文件删除确认后必须关闭弹窗。
// getDeleteConfirm 返回的 onConfirm 只负责执行删除、无权关闭对话框，
// 因此在此包裹 finally 显式关闭（与 handleBatchDelete / handleCleanupCorrupted 模式一致）。
const handleDelete = useCallback(
  (file: MediaFile, permanent = false) => {
    const config = fileOperations.getDeleteConfirm(file, permanent)
    setConfirmDialog({
      open: true,
      title: config.title,
      message: config.message,
      onConfirm: async () => {
        try {
          await config.onConfirm()
        } finally {
          setConfirmDialog((prev) => ({ ...prev, open: false }))
        }
      }
    })
  },
  [fileOperations]
)
```

### 3.1 错误处理（Error Handling）

- 内层 `config.onConfirm()` 的失败由 `useFileOperations` 内部既有 `try/catch + Toast` 处理（删除失败会提示且保留列表项），**不**在本层吞掉。
- 外层 `finally` **只负责关弹窗**，绝不在 `catch` 中吞掉内层错误；即便删除抛错，弹窗也关闭、错误仍按既有路径上报。
- 与 `handleCleanupCorrupted` 的 `try/catch/finally` 风格一致，保持代码风格统一。

### 3.2 参数校验（Parameter Validation）

- 复用既有契约：`fileOperations.getDeleteConfirm(file, permanent)` 的入参校验已由该 hook 负责（`file` 为 `MediaFile`、`permanent` 为 `boolean`，缺省 `false`）。本修复**不新增任何参数校验分支**，避免引入不一致行为。
- `setConfirmDialog` 关闭时采用函数式更新 `(prev) => ({ ...prev, open: false })`，避免直接读取可能过期的闭包状态（与既有模式一致）。

---

## 4. 启动 / 验证说明（Startup & Verification）

> 本机环境约束（来自项目记忆，务必遵守）：
>
> - npm 有 **Safe-Delete 网关**（阈值 500 项），会拦截 `npm ci` 全量删除与 `Remove-Item node_modules`；依赖增量 `npm install`。
> - `npm run build` 的 `clean` 步骤会被 EPERM 拦截（dist 项过多），构建改用 `npx electron-vite build`。
> - 严禁用 `cmd /c del` 删点开头文件；清理临时文件一律 `Remove-Item -LiteralPath`。

### 4.1 安装依赖（如尚未就绪）

```powershell
cd d:\Nikki Gallery\WXNN XiangCe
npm install            # 增量安装，勿用 npm ci
```

### 4.2 运行单测（针对性回归，最快反馈，< 2s）

```powershell
npx vitest run src/renderer/pages/GalleryPage.test.tsx
```

### 4.3 类型检查

```powershell
npx tsc -b
```

### 4.4 全量渲染测试（环境告警，见 §6）

```powershell
npm run test:renderer     # = npx vitest run src/renderer
```

### 4.5 手动目检（可选，打包产物验证）

```powershell
npx electron-vite build   # 构建（绕过 build clean 网关限制）
npm run dist:win          # 生成 release/NikkiGallery-Setup-<ver>.exe
```

安装后：画廊页右键图片 → 永久删除 → 系统二次确认 → 软件内确认弹窗应自动消失。

---

## 5. 基础测试用例（Basic Test Cases）

沿用既有「源码结构性断言」模式：读取 `GalleryPage.tsx` 源码文本，断言 `handleDelete` 函数体内**确实存在**关闭弹窗的 `setConfirmDialog((prev) => ({ ...prev, open: false }))` 写法。断言范围严格限定在 `handleDelete` 函数体内（以 `const handleDelete = useCallback(` 起、下一个 `// 稳定回调` 注释止），**避免误命中** `handleBatchDelete` / `handleCleanupCorrupted` 中已有的同类写法。

**新增用例**（`src/renderer/pages/GalleryPage.test.tsx`）：

```ts
describe('GalleryPage handleDelete 确认后关闭弹窗（#fix-permanent-delete-dialog）', () => {
  it('handleDelete 的 onConfirm 在确认后应将确认弹窗 open 置为 false', () => {
    const startMarker = 'const handleDelete = useCallback('
    const endMarker = '  // 稳定回调'
    const startIdx = galleryPageSrc.indexOf(startMarker)
    const endIdx = galleryPageSrc.indexOf(endMarker, startIdx)
    expect(startIdx, 'handleDelete 定义未找到').toBeGreaterThan(-1)
    expect(endIdx, 'handleDelete 函数体结束标记未找到').toBeGreaterThan(startIdx)
    const handleDeleteBlock = galleryPageSrc.slice(startIdx, endIdx)
    expect(handleDeleteBlock).toContain('setConfirmDialog((prev) => ({ ...prev, open: false }))')
  })
})
```

**红-绿验证记录**：

- 修改前运行：`1 failed`（5 passed → 6 个用例中新增用例失败，符合「红」）。
- 修改后运行：`6 passed`（全部通过，符合「绿」）。

> 注：结构性断言专门规避了「否定断言误命中修复说明注释」的坑（项目记忆约定：做「不得包含某写法」的否定断言须先剔除注释行；本用例采用**正向断言** `toContain` 修复写法，从根上规避该坑）。

---

## 6. 分步执行记录与验收（每步先验证通过，再进入下一步）

| 步骤 | 子任务           | 修改文件                                         | 输入                                                             | 输出                                | 验收标准                                           | 实际结果        |
| ---- | ---------------- | ------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------- | --------------- |
| 1    | 复核根因与影响面 | 无（只读）                                       | `GalleryPage.tsx` / `useFileOperations.ts` / `ConfirmDialog.tsx` | 根因定位：透传 `onConfirm` 漏关弹窗 | 确认仅 `handleDelete` 受影响，其他路径已正确       | ✅ 确认         |
| 2    | 写失败用例（红） | `GalleryPage.test.tsx`                           | —                                                                | 新增结构性断言                      | 运行该文件 → 新增用例 **失败**（红）               | ✅ `1 failed`   |
| 3    | 应用最小修复     | `GalleryPage.tsx`（`handleDelete`）              | 第 2 步的红用例                                                  | `finally` 关闭弹窗的 `handleDelete` | 运行该文件 → 全部 **通过**（绿）                   | ✅ `6 passed`   |
| 4    | 类型检查         | 无                                               | 修改后的源码                                                     | —                                   | `npx tsc -b` 退出码 0、无报错                      | ✅ 通过         |
| 5    | 全量渲染测试     | 无                                               | 全部 `src/renderer` 用例                                         | —                                   | 见下方「环境告警」                                 | ⚠️ 既有环境问题 |
| 6    | 写入本 MD 计划   | `docs/fix-permanent-delete-dialog-2026-08-18.md` | 上述所有记录                                                     | 本文件                              | 文件存在且含依赖/启动/错误处理/校验/测试与分步验收 | ✅ 产出         |

### 6.1 环境告警（重要，非本次修改引入）

`npm run test:renderer` 在本机**全量**运行时，63 个测试文件**全部**在 `tests/setup.ts:219` 抛
`TypeError: Cannot read properties of undefined (reading 'on')` 且 `0 test`。已验证该失败**与本次修改无关**：

- 证据 A：将本次涉及的两个文件 `git stash` 后（保留其余工作树改动），全量运行**复现完全相同的错误**。
- 证据 B：单独运行 `GalleryPage.test.tsx`（纯结构性测试、不 import `@testing-library/react`）→ **通过**；单独运行 `ConfirmDialog.test.tsx`（依赖 `@testing-library/react`）→ 复现同样的 `setup.ts:219` 错误。
- 结论：该失败源于测试基础设施 / `@testing-library/react` 与当前环境的交互问题，是**既有、与本缺陷无关**的环境问题。

**处理原则**：用户明确要求「控制修改范围，不要动到其他无关的内容」。修复测试基础设施会牵动 `tests/setup.ts`、依赖版本及大量无关测试文件，超出本次任务范围，**故不改动**。本次缺陷修复已由步骤 2–4 的针对性回归测试 + 类型检查充分验证。若后续需要 `test:renderer` 全绿，应单独立项排查 `tests/setup.ts:219`（疑似 jsdom/forks worker 环境下 `@testing-library/react` 的 `cleanup`/afterEach 注册异常）。

---

## 7. 回归与后续

- 回归风险：低。`handleDelete` 同时服务于右键「删除」(`onDelete`) 与「永久删除」(`onDeletePermanent`)，两条路径现都会正确关闭弹窗，行为一致。
- 不影响 `RecycleBinPage`（其关闭逻辑独立且已正确）、`useFileOperations`（保持纯删除语义）、`ConfirmDialog`（确认按钮本就不自动关闭，符合设计）。
- 建议：`npm run i18n:check` 存在既有失败（缺 `toast.backup` 等 4 个 key），非本次引入，无需处理。

---

## 8. 修改清单（最终）

| 文件                                             | 改动类型 | 说明                                                                         |
| ------------------------------------------------ | -------- | ---------------------------------------------------------------------------- |
| `src/renderer/pages/GalleryPage.tsx`             | MODIFY   | `handleDelete` 的 `onConfirm` 外包 `try/finally`，确认后关闭 `confirmDialog` |
| `src/renderer/pages/GalleryPage.test.tsx`        | MODIFY   | 新增「确认后 open=false」结构性回归断言                                      |
| `docs/fix-permanent-delete-dialog-2026-08-18.md` | NEW      | 本计划文件                                                                   |
