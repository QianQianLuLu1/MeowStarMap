# 修复计划：导入向导步骤二“下一步”按钮永久禁用（阻塞性缺陷）

> 问题单：图片导入功能在步骤二（命名规则 + 分类 + 冲突策略所在向导链路）中，“下一步”按钮呈现灰色且无法点击，用户无法进入步骤三执行导入。
>
> 修复原则：**仅改动导入向导 `ImportWizard` 的状态判断逻辑与数据校验流程**；禁止改动游戏目录自动扫描、数据库架构及其他无关模块。

---

## 1. 依赖声明 (Dependencies)

### 1.1 外部依赖（仅用于校验/测试，本次修复不新增任何运行时依赖）

| 依赖                                                              | 版本约束              | 用途                                                                          | 是否新增 |
| ----------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------- | -------- |
| `react` / `react-dom`                                             | 已装（lockfile 锁定） | 组件渲染与状态管理                                                            | 否       |
| `react-i18next`                                                   | 已装                  | 按钮文案 `gallery.import.nextStep` 等 i18n key                                | 否       |
| `zod`                                                             | 已装                  | 主进程 `import:preview` / `import:run` 入参 schema 校验（**只读引用，不改**） | 否       |
| `better-sqlite3`                                                  | 已装                  | `ImportRootRepository` 登记导入根（**只读引用，不改**）                       | 否       |
| `vitest` + `@testing-library/react` + `@testing-library/jest-dom` | 已装                  | 新增单元测试的测试框架与 DOM 断言                                             | 否       |

### 1.2 内部模块引用（引用关系与职责边界）

| 模块路径                                                | 角色                                                                              | 本次是否修改 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------ |
| `src/renderer/components/gallery/ImportWizard.tsx`      | **缺陷载体，唯一修改对象**                                                        | ✅ 修改      |
| `src/renderer/components/gallery/ImportWizard.test.tsx` | 新增单元测试（与本文件同目录）                                                    | ✅ 新增      |
| `src/renderer/components/common/BaseDialog.tsx`         | 向导外层容器（Modal），只读引用                                                   | 否           |
| `src/main/services/file-service.ts`                     | 提供 `previewImport` / `importFiles`，返回结构契约的**事实来源**                  | 否（只读）   |
| `src/main/ipc/handlers/import-handler.ts`               | 注册 `import:preview` / `import:run`，zod 入参校验 + PathGuard 路径校验           | 否（只读）   |
| `src/main/preload.ts`                                   | 解包 `IpcResponse`，暴露 `electronAPI.import.preview/run/onProgress`              | 否（只读）   |
| `src/renderer/pages/GalleryPage.tsx`                    | 相册页工具栏“导入”入口（`setImportWizardOpen(true)`），只读引用                   | 否           |
| `tests/setup.ts`                                        | vitest 全局 setup：注入 `window.electronAPI` 占位、mock motion/react、i18n 初始化 | 否           |

### 1.3 数据流契约（修复前必须确认的事实，已核实）

```
GalleryPage.tsx ──open──▶ ImportWizard.tsx（步骤 1/2/3）
                            │  electronAPI.import.preview(sourceDir)
                            ▼
              file-service.previewImport(sourceDir)
              → { success: boolean, files: ImportFilePreview[], message?: string }
              （res.files 结构 = { sourcePath, fileName, size, mtime, ext, isVideo }）

              electronAPI.import.run(sourcePaths, targetDir, { namingRule, categorize, conflictStrategy })
              → { imported[], failed[], skipped[], warnings? }
```

---

## 2. 启动说明 (Startup Instructions)

### 2.1 环境配置

- 操作系统：Windows 10/11（开发环境 Windows 25H2）
- Node.js：遵循 `.node-version`（项目锁定版本，建议用 nvm 切换）
- 依赖安装：`npm ci`（以 `package-lock.json` 为准，勿手动升级）
- 无外网构建依赖；主进程依赖 `resources/nuan5_decryption.dll`（仅在解码功能启用时涉及，与本缺陷无关）

### 2.2 复现步骤（缺陷 100% 复现路径）

1. 启动开发模式：`npm run dev`（或构建产物 `npm run dist:win` 后运行安装包）。
2. 进入“相册”页面，点击工具栏“导入”按钮 → 打开导入向导。
3. 步骤 1/3：点击“浏览”选择一个**包含至少 1 张图片/视频**的文件夹（如 `C:\Users\<user>\Pictures\test-import`），等待扫描完成，确认出现“扫描结果”摘要，点击“下一步”进入步骤 2/3。
4. 步骤 2/3：出现待导入文件列表（默认全选），观察底部按钮：
   - **缺陷表现**：右侧按钮为“下一步”且呈灰色（`disabled`），点击无任何响应。
   - **期望表现**：已选中 ≥1 个文件时按钮应可点击，进入步骤 3/3（命名规则 + 分类 + 冲突策略 + 目标目录）。

### 2.3 测试数据准备

创建临时测试目录（PowerShell）：

```powershell
# 准备：含 2 张图片 + 1 个视频的源目录，以及空目标目录
$src = "$env:TEMP\wizard-src"; $dst = "$env:TEMP\wizard-dst"
New-Item -ItemType Directory -Force -Path "$src\sub", $dst | Out-Null
# 生成合法占位图片（png 魔数 + 最小内容），避免空文件被识别问题
[IO.File]::WriteAllBytes("$src\photo-a.png", [byte[]](0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A))
[IO.File]::WriteAllBytes("$src\sub\photo-b.jpg", [byte[]](0xFF,0xD8,0xFF,0xE0))
[IO.File]::WriteAllBytes("$src\clip.mp4", [byte[]](0x00,0x00,0x00,0x18,0x66,0x74,0x79,0x70))
Write-Host "src=$src (3 files) dst=$dst"
```

同时准备一个**空文件夹**（`$env:TEMP\wizard-empty`）用于边界用例（0 个媒体文件时“下一步”必须保持禁用）。

### 2.4 验证命令

```powershell
npm run typecheck                    # 全量类型检查
npx vitest run src/renderer/components/gallery/ImportWizard.test.tsx   # 新增单测
npm run test:renderer                # 渲染层全量回归（确保无副作用）
```

---

## 3. 详细实施计划 (Implementation Plan)

### 3.1 根因分析（结论先行）

`src/renderer/components/gallery/ImportWizard.tsx` 第 223-224 行定义了两个启用条件：

```ts
const canProceedToStep2 = sourceDir && previewFiles.length > 0 && !loading
const canProceedToStep3 = targetDir && selectedPaths.size > 0
```

而步骤 2 的“下一步”按钮（第 660-668 行）**错误复用了 `canProceedToStep3`**：

```tsx
{step === 2 && (
  <button ... disabled={!canProceedToStep3} onClick={() => setStep(3)}>
```

`canProceedToStep3` 要求 `targetDir`（目标目录）非空，但 `targetDir` **只在步骤 3 界面才允许输入**（第 490-516 行），步骤 2 界面（第 351-408 行）根本没有目标目录控件。因此正常流程（步骤 1 → 步骤 2）中 `targetDir === ''` 恒成立 → `canProceedToStep3` 恒为 `false` → **步骤 2 的“下一步”按钮永久禁用**，用户永远无法进入步骤 3（命名规则 + 分类 + 冲突策略 + 执行）界面。这与“手动导入自定义图片”的核心功能直接冲突。

**附带的两处状态一致性缺陷**（同属“表单状态绑定/文件选择有效性校验”，一并修复）：

- **S2**：`loadPreview` 失败分支（第 158-163 行）只 `setPreviewFiles([])`，未清空 `selectedPaths`，旧选中集合残留造成状态脏数据。
- **S3**：步骤 1 的 `sourceDir` 文本框 `onChange`（第 290 行）只更新路径字符串，不重置 `previewFiles`/`selectedPaths`：手动改路径后按钮状态与真实文件列表脱节（可能基于旧目录的文件列表错误放行“下一步”）。

### 3.2 子任务分解

#### 子任务 1：拆分“步骤 2 → 3”与“步骤 3 执行”的启用条件

- **文件影响范围**：`src/renderer/components/gallery/ImportWizard.tsx`（第 223-224 行区域）
- **Input**：现有两个派生布尔量 `canProceedToStep2`、`canProceedToStep3`；步骤状态 `step`、`loading`、`selectedPaths`、`targetDir`
- **Output**：新增独立派生量 `canProceedFromStep2`，语义为“步骤 2 允许进入步骤 3”
  ```ts
  const canProceedFromStep2 = selectedPaths.size > 0 && !loading
  ```
- **验收标准（AC1）**：
  - 步骤 2 中 `selectedPaths.size === 0` 或 `loading === true` 时 `canProceedFromStep2 === false`（按钮禁用）
  - 步骤 2 中 `selectedPaths.size > 0` 且 `!loading` 时 `canProceedFromStep2 === true`（按钮激活），**与 `targetDir` 是否为空无关**
  - `canProceedToStep3` 保持不变（仍用于步骤 3 的“开始导入”按钮）

#### 子任务 2：步骤 2“下一步”按钮改用新条件

- **文件影响范围**：`src/renderer/components/gallery/ImportWizard.tsx`（第 660-668 行）
- **Input**：步骤 2 的 `<button>` 现有 `disabled={!canProceedToStep3}`
- **Output**：`disabled={!canProceedFromStep2}`，其余（文案 `gallery.import.nextStep`、`onClick={() => setStep(3)}`）不变
- **验收标准（AC2）**：
  - 单元测试：步骤 1 扫描成功后进入步骤 2，全选状态下按钮 `not.toBeDisabled()`
  - 单元测试：点击“取消全选”后按钮 `toBeDisabled()`
  - 手动验证：按 2.2 复现步骤，步骤 2 可点击“下一步”进入步骤 3

#### 子任务 3：`loadPreview` 失败路径同步清空选中集

- **文件影响范围**：`src/renderer/components/gallery/ImportWizard.tsx`（第 147-169 行）
- **Input**：`loadPreview(dir)` 的 else（`res.success === false`）与 catch（异常）分支
- **Output**：两分支均追加 `setSelectedPaths(new Set())`，保证 `previewFiles` 与 `selectedPaths` 始终同源同灭
- **验收标准（AC3）**：
  - 单元测试：`preview` 返回 `{ success: false }` 后，步骤 1 的“下一步”禁用（`previewFiles.length === 0`），且状态无残留（重扫成功后进入步骤 2 时 `selectedPaths.size === 预览文件数`）
  - 单元测试：`preview` reject 异常后行为同上

#### 子任务 4：步骤 1 手动改路径时重置预览状态

- **文件影响范围**：`src/renderer/components/gallery/ImportWizard.tsx`（第 287-300 行输入框区域）
- **Input**：`sourceDir` 文本框 `onChange` 事件
- **Output**：路径文本变化时同步 `setPreviewFiles([])`、`setSelectedPaths(new Set())`；路径清空后 `canProceedToStep2` 因 `!sourceDir` 自然为 false，无需额外分支
- **验收标准（AC4）**：
  - 单元测试：扫描目录 A 后手动把输入框改为目录 B 路径（不点浏览），步骤 1 的“下一步”立即禁用（预览列表已清空）
  - 单元测试：清空输入框后“下一步”禁用
  - 行为约束：**不引入失焦自动扫描**（超出最小化改动范围，路径有效性由步骤 1 的“浏览”按钮与主进程 `assertFileReadPath` 兜底）

### 3.3 文件影响范围汇总

| 操作 | 文件                                                                                                      | 改动量级                 |
| ---- | --------------------------------------------------------------------------------------------------------- | ------------------------ |
| 修改 | `src/renderer/components/gallery/ImportWizard.tsx`                                                        | +4 / -1 行逻辑，注释若干 |
| 新增 | `src/renderer/components/gallery/ImportWizard.test.tsx`                                                   | 约 200 行测试            |
| 不动 | `src/main/services/file-service.ts`、`import-handler.ts`、`preload.ts`、`GalleryPage.tsx`、数据库、扫描器 | —                        |

### 3.4 输入输出定义（总表）

| 子任务 | 输入                                         | 输出                                  | 验收 |
| ------ | -------------------------------------------- | ------------------------------------- | ---- |
| 1      | `step`/`loading`/`selectedPaths`/`targetDir` | `canProceedFromStep2` 派生量          | AC1  |
| 2      | 步骤 2 按钮现有禁用条件                      | `disabled={!canProceedFromStep2}`     | AC2  |
| 3      | `loadPreview` else/catch 分支                | 追加 `setSelectedPaths(new Set())`    | AC3  |
| 4      | `sourceDir` onChange                         | 重置 `previewFiles` + `selectedPaths` | AC4  |

---

## 4. 错误处理机制 (Error Handling)

### 4.1 异常捕获策略（沿用现有模式，不新增全局机制）

| 场景                                                            | 现有行为                                                                                 | 本次调整                        |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------- |
| `electronAPI.import.preview` 返回 `{ success: false, message }` | `setPreviewFiles([])` + `setError(res.message)`                                          | 追加清空 `selectedPaths`（AC3） |
| `electronAPI.import.preview` 抛异常（IPC 失败）                 | `setError(err.message)`                                                                  | 追加清空 `selectedPaths`（AC3） |
| 主进程侧 `previewImport` 目录不存在/不可访问                    | 返回 `success:false` + i18n 文案（`main.file.message.notDirectory` / `cannotAccessDir`） | 不修改，仅透传                  |
| 主进程侧 `import:run` 失败                                      | `AppError.internal('导入失败: ...')` + `logger.error`，渲染层捕获后 `setError`           | 不修改                          |
| 步骤 1 手动输入非法路径                                         | 点击“下一步”时按钮已禁用（预览列表为空），主进程 `assertFileReadPath` 兜底               | 由子任务 4 保证状态同步         |

### 4.2 用户友好提示文案（沿用既有 i18n key，不新增 key）

- 源目录读取失败：`gallery.import.errors.readSourceFailed` / `gallery.import.errors.loadFailed`
- 非目录/不可访问：`main.file.message.notDirectory` / `main.file.message.cannotAccessDir`
- 导入失败：`gallery.import.errors.importFailed`
- 按钮禁用期用户无操作反馈属于既有设计（与相册其余按钮一致），不引入 tooltip

### 4.3 日志记录规范

- 渲染层：不新增 console 日志（遵循现有组件风格，错误统一走 `setError` 展示）。
- 主进程：不修改。既有 `logger.info('[Import] 导入完成: ...')` / `logger.error('[Import] 导入失败: ...')` 已覆盖执行链路。
- 本次缺陷为纯渲染层状态逻辑，无主进程日志改动。

---

## 5. 参数校验逻辑 (Parameter Validation)

### 5.1 渲染层（ImportWizard 内，本次修复覆盖）

| 校验项             | 规则                                                                                                                              | 实现位置                                      | 失败表现                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| 文件类型           | 由主进程 `previewImport` 按 `MEDIA_EXTENSIONS` 白名单过滤（图片/视频），渲染层不重复实现                                          | `loadPreview` 结果直接采用                    | 目录无媒体文件 → `previewFiles.length === 0` → 步骤 1“下一步”禁用 |
| 文件大小           | 仅展示 `formatSize`，不做上限限制（导入为本地复制，无传输体积约束）                                                               | 步骤 2/3 摘要                                 | 无                                                                |
| 路径合法性（源）   | ① 步骤 1 必须存在扫描成功的 `previewFiles`；② 主进程 `assertFileReadPath` 二次校验                                                | `canProceedToStep2` + handler                 | 禁用按钮 / 返回错误文案                                           |
| 路径合法性（目标） | `targetDir` 非空即视为候选，主进程 `assertFileWritePath` 校验可写性                                                               | `canProceedToStep3` + handler                 | 步骤 3“开始导入”禁用 / 返回错误文案                               |
| 路径变更一致性     | 手动编辑 `sourceDir` 输入框 → 立即清空 `previewFiles` + `selectedPaths`（子任务 4）                                               | `onChange`                                    | 按钮禁用，杜绝旧列表放行                                          |
| 文件选中有效性     | 步骤 2 → 3 要求 `selectedPaths.size > 0` 且非扫描中                                                                               | `canProceedFromStep2`（子任务 1/2）           | “下一步”禁用                                                      |
| 重复检测           | 运行期由主进程 `importFiles` 处理（`skip`/`rename`/`overwrite` + 批次内 `usedTargetPaths`）；预览阶段不预先判重（与既有设计一致） | handler 内 `pathExists` + `getUniqueFilePath` | 按冲突策略处理并计入 `skipped`                                    |

### 5.2 主进程（只读引用，不修改）

- `import-handler.ts`：`z.enum` 校验命名/分类/冲突策略枚举、`schemas.filePath` 校验路径字符串、`seqStart` 范围 `[0, 1_000_000]`。
- `file-service.ts`：目录可达性 stat、递归遍历、扩展名白名单。

---

## 6. 基础测试用例 (Unit Tests)

新增 `src/renderer/components/gallery/ImportWizard.test.tsx`（`@vitest-environment jsdom`），mock 策略沿用 [BaseDialog.test.tsx](src/renderer/components/common/BaseDialog.test.tsx) 风格：mock `motion/react`（全局已 mock）、icons；`window.electronAPI` 由 `tests/setup.ts` 占位，用例内用 `vi.spyOn` 覆盖 `import.preview` / `import.run`。

### 6.1 测试脚手架（关键片段）

```tsx
/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ImportWizard } from './ImportWizard'

const FILES = [
  {
    sourcePath: 'C:\\src\\a.png',
    fileName: 'a.png',
    size: 1024,
    mtime: '2026-08-01T00:00:00.000Z',
    ext: '.png',
    isVideo: false
  },
  {
    sourcePath: 'C:\\src\\b.jpg',
    fileName: 'b.jpg',
    size: 2048,
    mtime: '2026-08-02T00:00:00.000Z',
    ext: '.jpg',
    isVideo: false
  }
]

const setupElectronAPI = (overrides: Record<string, unknown> = {}) => {
  vi.spyOn(window.electronAPI, 'import').mockReturnValue({
    preview: vi.fn().mockResolvedValue({ success: true, files: FILES }),
    run: vi.fn().mockResolvedValue({ imported: [], failed: [], skipped: [] }),
    onProgress: vi.fn(() => vi.fn()),
    ...overrides
  } as never)
}

const openAndScan = async () => {
  render(<ImportWizard open onClose={vi.fn()} />)
  fireEvent.click(screen.getByText('下一步')) // 步骤1 -> 2（预览默认已触发？见 6.2 用例 C1 的触发方式）
}
```

> 说明：步骤 1 的扫描由“浏览”按钮触发，测试中直接点击“浏览”并让 `dialog.selectDirectory` 返回固定路径即可驱动 `loadPreview`。

### 6.2 正常流程用例

| 编号 | 用例                   | 步骤                                                 | 断言                                                                                                     |
| ---- | ---------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| C1   | 扫描成功且默认全选     | 点“浏览”（selectDirectory → `C:\src`）→ 等待列表渲染 | 步骤 2 出现 2 行文件；“下一步”`not.toBeDisabled()`；摘要“已选 2 / 2”                                     |
| C2   | 全流程可达步骤 3       | C1 后点“下一步”                                      | 出现“命名规则/分类策略/冲突处理”区块与“开始导入”按钮；未选目标目录时“开始导入”`toBeDisabled()`           |
| C3   | 选择目标目录后开始导入 | C2 后输入/浏览目标目录 → 点“开始导入”                | `import.run` 被调用且入参含 `namingRule/categorize/conflictStrategy`；结果卡片渲染（成功/跳过/失败计数） |

### 6.3 边界条件用例

| 编号 | 用例                      | 步骤                                        | 断言                                                                           |
| ---- | ------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| B1   | 空目录扫描                | preview 返回 `{ success: true, files: [] }` | 步骤 1“下一步”`toBeDisabled()`                                                 |
| B2   | 取消全选后按钮锁定        | C1 后点“取消全选”                           | 步骤 2“下一步”`toBeDisabled()`；点“全选”恢复 `not.toBeDisabled()`              |
| B3   | 重新勾选单个文件          | B2 后勾选第 1 行                            | “下一步”`not.toBeDisabled()`；摘要“已选 1 / 2”                                 |
| B4   | 目标目录为空时步骤 3 锁定 | 到达步骤 3 但未填目标目录                   | “开始导入”`toBeDisabled()`；输入目标目录后 `not.toBeDisabled()`                |
| B5   | 扫描中按钮锁定            | `preview` 返回 pending Promise              | 步骤 1 显示“正在扫描源目录…”，期间“下一步”`toBeDisabled()`；resolve 后恢复可用 |
| B6   | 重新打开向导重置          | 完成一次扫描后 `open=false` 再 `open=true`  | 回到步骤 1，所有表单状态复位                                                   |

### 6.4 异常场景用例

| 编号 | 用例             | 步骤                                           | 断言                                                                       |
| ---- | ---------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| E1   | preview 返回失败 | `{ success: false, message: '无法读取' }`      | 步骤 1 显示错误文案；“下一步”`toBeDisabled()`；无残留选中集                |
| E2   | preview 抛异常   | `vi.fn().mockRejectedValue(new Error('boom'))` | 显示 `gallery.import.errors.loadFailed` 对应文案；“下一步”`toBeDisabled()` |
| E3   | 失败后重扫成功   | 先 E1 再让 preview 返回成功                    | 步骤 2 列表正常、“下一步”可用（验证 AC3 无脏状态）                         |
| E4   | 手动改路径重置   | 扫描 A 成功后手动输入 B 路径                   | 步骤 1“下一步”立即 `toBeDisabled()`（AC4）                                 |
| E5   | import.run 失败  | run 返回 failed 数组或 reject                  | 结果卡片失败计数正确 / 错误文案展示；不卡死界面（按钮恢复）                |

### 6.5 回归验证命令

```powershell
npx vitest run src/renderer/components/gallery/ImportWizard.test.tsx   # 新增用例全绿
npm run test:renderer        # 渲染层回归（确认无副作用）
npm run typecheck            # 类型检查
npm run lint -- --quiet src/renderer/components/gallery/ImportWizard.tsx src/renderer/components/gallery/ImportWizard.test.tsx
```

---

## 7. 执行纪律与验收清单

- **串行验证**：子任务 1→4 依序实施，每完成一个即运行 6.5 对应命令，全绿方可进入下一个。
- **自证清白**：实施完成后运行 `npm run typecheck` + `npm run test:renderer`，确认编译零错误、测试全绿；再按 2.2 手动冒烟一次完整导入链路。
- **最终验收**：
  - [ ] 步骤 2“下一步”在有效选中时立即可点击（核心缺陷关闭）
  - [ ] 步骤 3“开始导入”仍要求目标目录非空（既有正确行为未回归）
  - [ ] 自动扫描/数据库/主进程 handler 零改动（`git diff --stat` 仅含 ImportWizard 两个文件）
  - [ ] 新增单测覆盖正常/边界/异常三类场景且全部通过
