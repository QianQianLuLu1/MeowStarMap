编码约定真相源

> **本文件是全仓库编码约定的唯一真相源，纳入版本控制。**
> 下方的「项目编码约定」正文区是约定本体；以该一级标题为锚点，逐字镜像到
> `.qoder/rules/project-conventions.md`（供 IDE 以 `trigger: always_on` 注入规则上下文，
> 受 `.gitignore` 中 `.qoder/` 目录级排除约束，不入库）。改动本体任一节后必须同步镜像。
> 一致性由 `scripts/__tests__/verify-format-scope.test.ts` 守护：正文区漂移，或被跟踪的指引文件
> 重新把出处指向 `.qoder/`，测试即失败（不因文件缺失而跳过）。
> 入口速览见 [`AGENTS.md`](../AGENTS.md)，模块级约定见各目录下的 `AGENTS.md`。

---

# 项目编码约定（Project Conventions）

适用范围：本仓库全部代码改动。以下五条约定为**硬性规则**，PR 与自动化检查会拒绝违反项。若确需例外，必须在改动处附中文注释说明原因、影响面与回滚方案，并在 `docs/技术债清单.md` 登记。

---

## 1. Electron IPC 白名单约束

**规则**

- Preload 只做**装配与暴露**，不写业务；每个功能域必须走 `src/main/preload/api/*.ts` 中的命名空间对象（如 `scannerAPI` / `fileAPI`），再由 `preload.ts` 经 `exposeIfTrusted(key, value)` 挂到 `contextBridge`。**禁止**在 preload 里裸调 `ipcRenderer.invoke`，也**禁止**绕过 `exposeIfTrusted` 直接调 `contextBridge.exposeInMainWorld`。
  - 依据：`src/main/preload.ts` 的 `isTrustedDocumentOrigin` 门禁是"第二层防线"，非授信文档 origin 必须静默跳过全部桥暴露；未经门禁的暴露等于向 `file:///evil.html` 开放完整 IPC。
- 主进程 handler **必须**在 `src/main/ipc/handlers/*.ts` 中按领域一个文件注册，并**必须**用 `wrapHandler(ctx, schema, handler)` 或 `wrapHandlerNoArgs` 包装。返回值经 `wrapHandler` 统一封装为 `IpcResponse<T>`，preload 侧 `call<T>()` 解包。禁止裸调 `ipcMain.handle`。
- 参数**必须**用 `src/main/ipc/validator.ts` 中的 `schemas`（zod）校验；涉及文件路径的通道**必须**根据读写语义调用 `assertFileReadPath` / `assertFileWritePath`，媒体读取额外走 `assertMediaReadPath`（`src/main/ipc/media-read-guard.ts`）。
- 用户通过系统对话框显式选择的目录视为已授权：登记经 `dialog-handler.ts` 中的 `pathGuard.registerUserPicked`，后续校验用 `pathGuard.isUserPicked(p)` 短路；**伪造路径**（未命中标记）仍必须走完整白名单 + 黑名单校验。
- 对插件暴露的 facade **必须只读**（如 `pluggableElectronIpc` 仅暴露 `getActive` / `updatesAvailable`）；任何变更类管理操作统一经 `electronAPI.plugin.*` 通道，主进程侧做可信调用方校验。参照 `src/main/preload.ts` 关于 `pluggable-electron` `install` 风险的注释。

**通道/签名变更的同步义务**

- 修改**任何** IPC 通道名、preload 暴露的方法签名、或 `IpcResponse`/`IpcError` 结构时，**必须**同步更新 `docs/IPC_CONTRACT.md` 并保持向后兼容（新增字段可选、旧字段语义不变、需要破坏性变更时另起通道 + 迁移期双写）。
- `media:findDuplicates` 等前端会检查 `res.success` 的通道，其 handler 返回值必须真的包含 `success: true` 字段（约定见 `docs/IPC_CONTRACT.md` §2）。

**禁止**

- ❌ 在渲染层 `import('electron')` 或使用 `remote`。
- ❌ 在 preload/主进程之外新增 `window.*` 全局。
- ❌ 在 handler 里 `throw new Error(...)` 直接冒泡——`wrapHandler` 会捕获为 `INTERNAL_ERROR`，但**必须**用第 2 节的 `AppError` 家族表达语义。

---

## 2. AppError 错误分类使用规范

**规则**

- 跨进程/跨模块的错误**必须**使用 `src/shared/errors/app-error.ts` 中定义的 `AppError` 家族，禁止 `throw new Error('字符串')` 表达可预期业务错误。
- 六个分类子类按语义选择：
  | 子类              | 典型场景                                    | 对应 `ERROR_CODES`  |
  | ----------------- | ------------------------------------------- | ------------------- |
  | `ValidationError` | zod 校验失败、参数格式/业务规则不匹配       | `VALIDATION_ERROR`  |
  | `NotFoundError`   | 记录/文件/目录不存在                        | `NOT_FOUND`         |
  | `PermissionError` | 路径白/黑名单拦截、权限校验失败             | `PATH_FORBIDDEN`    |
  | `DatabaseError`   | better-sqlite3 SQL 错误、事务冲突、数据损坏 | `DATABASE_ERROR`    |
  | `FileSystemError` | `fs` 读写错误、磁盘满、路径不存在           | `FILE_SYSTEM_ERROR` |
  | `InternalError`   | 兜底，未预期异常/第三方库错误               | `INTERNAL_ERROR`    |
- `cause` 字段**必须**携带原始错误（若来自 `fs` / `better-sqlite3` 等），用于日志排查；`toIpcError()` 序列化时**不会**跨 IPC 传输 `cause`。
- `userMessage` 字段用于 UI 展示，写用户可读语言，不含技术细节、路径、堆栈；`message` 字段给开发者看，可含技术上下文。`DatabaseError` / `FileSystemError` / `InternalError` 已通过 `translate('appError.*')` 提供默认 `userMessage`，通常无需手填。
- `details` 只放调试上下文，**禁止**包含密码、token、完整文件路径或其他敏感数据。
- 捕获时优先用类型守卫：`isAppError` / `isValidationError` / `isNotFoundError` / `isPermissionError` / `isDatabaseError` / `isFileSystemError` / `isInternalError`，而不是比对字符串错误码。

**渲染层展示**

- UI toast 文本**必须**经 `extractUserMessage(error)`（同文件）取得，优先级：`userMessage` > `message` > `String(error)` > 兜底翻译。`useErrorToast` 钩子已按此实现，业务代码直接复用即可。
- `AppError` 的翻译函数由 `src/main/i18n` 与 `src/renderer/i18n` 初始化时通过 `setAppErrorTranslator` 注入。**禁止**在 `src/shared/**` 引入 electron / react / i18next 运行时依赖。

**主进程侧**

- `wrapHandler` 会自动捕获 `AppError` 并转为 `IpcError` 返回；不要在 handler 内手写 `try/catch + return { success: false }`。

---

## 3. CSS 变量优先于硬编码颜色值

**规则**

- 渲染层所有颜色、背景、边框、强调色**必须**通过 CSS 变量或 `tailwind.config.ts` 中已 extend 的 token 表达。**禁止**在组件里硬编码 `#xxxxxx` / `rgb()` / `hsl()` 具体色值（下列例外除外）。
- Tailwind token 已映射至 CSS 变量（见 `tailwind.config.ts`）：
  - `accent` → `var(--accent)`；`accent-light` / `accent-soft` / `accent-deep` 同理
  - `bg-primary` / `bg-secondary` / `bg-tertiary` → `var(--bg-*)`
  - `text-primary` / `text-secondary` / `text-tertiary` → `var(--text-*)`
- 优先使用 Tailwind 类名（`className="text-primary bg-tertiary"`）；仅当需要动态计算、伪类或内联覆盖时才用 `style={{ color: 'var(--text-primary)' }}`——参考 `src/renderer/pages/settings/shared.tsx`、`appearance-sections.tsx`、`tools-sections.tsx` 的写法。
- 新增主题只允许通过 CSS 变量赋值实现（当前主题文件位于 `src/renderer/styles/themes/*.css`，样例：`soft-pink-luxury.css`），不允许在组件里写"如果主题是 X 就用 Y 色"这类分支。

**允许的例外**（必须注释说明原因）

- 纯白/纯黑文字叠在自定义渐变或图片缩略图上的对比色（如 `#fff` 用于选中态徽标；见 `appearance-sections.tsx` 中 `fontSize === opt.value ? '#fff' : 'var(--text-primary)'`）。
- SVG/Canvas 绘图内部色彩。
- Tailwind 内置灰色系（`gray-500` 等）**仅限**于与主题无关的调试面板/日志视图，业务 UI 一律走 CSS 变量。

**禁止**

- ❌ 内联 `style={{ color: '#333' }}` / `bg: 'rgba(0,0,0,0.5)'`。
- ❌ 在 tsx 里定义局部色值常量对象绕过主题。
- ❌ 用 `dark:` 前缀手工写两套颜色——主题切换通过 CSS 变量重写在根元素，`dark:` 类不适用。

---

## 4. 组件使用 React 函数式组件 + Hooks 模式

**规则**

- 所有 UI 组件**必须**写成函数式组件（`React.FC<P>` 或裸函数 + 返回 JSX），**禁止**新增 class 组件。当前 `src/renderer/components/**` 全量为 `export const Xxx: React.FC<XxxProps> = ({ ... }) => {...}`，新增组件严格对齐该格式（参考 `TitleBar.tsx`、`Sidebar.tsx`、`AppShell.tsx`、`MasonryView.tsx`）。
- Props 类型必须显式声明为 `interface XxxProps` 或 `type XxxProps`，**禁止** `props: any`、`React.FC` 上不带泛型。
- 状态管理一律走 Zustand（`src/renderer/stores/*`）；组件内局部 UI 状态用 `useState`，副作用与生命周期用 `useEffect`，引用用 `useRef`。**禁止**Redux / Context 手搓全局 store。
- 与主进程交互**必须**通过 `window.electronAPI.<namespace>.<method>`（见第 1 节），**必须** `try/catch` 且用 `err instanceof window.IpcError` 或第 2 节的守卫判断分支。
- 自定义 Hook：文件名以 `use` 开头，放在 `src/renderer/hooks/`；组件文件不放 Hook 逻辑，除非是本文件私有的极小 utility。
- 无状态、纯展示的组件优先导出为 `function Xxx(...)`；有 Props 泛型且需要 `children` 时可用 `React.FC`。项目现状以 `React.FC` 为主，同一文件内保持一致即可。
- Memo 与虚拟滚动：列表元素组件在实测卡顿前不强制 `React.memo`；大数据视图复用现有 `VirtualImageGrid` / `MasonryView`，不要另起新虚拟列表。
- 可访问性：交互元素保留 `type="button"`；用 `id` / `htmlFor` 关联 label；不可访问的自定义控件必须补 `role` 与 `aria-*`（示例见 `settings/shared.tsx` 中通过 `labelId` / `descId` 关联的写法）。

**禁止**

- ❌ `class Xxx extends React.Component`。
- ❌ 在渲染层直接 `import('electron')` 或调用 Node 原生模块——一律经 preload 桥。
- ❌ 在组件里 `fetch` 外部 HTTP API（更新检查、分享等）**必须**走主进程对应 handler（`app-handler`、`share-handler` 等），保持网络与代理行为一致。
- ❌ 在 JSX 内联三元/`&&` 里做复杂数据变换——抽为 `useMemo`。

---

## 5. 源文件编码：UTF-8 无 BOM，行尾 LF

**规则**

- `src/`、`scripts/`、`e2e/`、`.storybook/` 与仓库根配置文件的**非测试**源码一律以 **UTF-8 无 BOM** 保存。承载位是 `eslint.config.js` 全局代码块中的 `unicode-bom: ['error', 'never']`：CI 全量 `npm run lint` 硬阻断。`.husky/pre-commit` 只对 lint-staged 中含 `eslint --fix` 任务的键（`src/`、`.storybook/`、`e2e/` 下的 TS/TSX）自动剥离 BOM（该规则 `fixable: 'whitespace'`）；`scripts/**` 与仓库根配置仅跑 prettier，其 BOM 会被钩子硬拦截，需按本节清偿方式手工修复。
- 行尾口径沿用既有约定，不另起炉灶：`.prettierrc` 固定 `endOfLine: "lf"`，git index 恒为 LF；本机 `core.autocrlf=true` 只影响工作区表现，不改变提交内容。因此脚本化的只读格式检查必须传 `prettier --check --end-of-line auto`——**该参数只豁免行尾，不豁免 BOM**。
- 编码与行尾约定**只此一套口径**：仓库不新增 `.gitattributes`，避免与上一段的 `--end-of-line auto` 形成两套判定（若将来改为固定 LF，必须同时去掉 `--end-of-line auto`，否则真实行尾违规会被放过）。

**允许的例外**（须附中文注释说明原因、影响面与回滚方案，并在 `docs/技术债清单.md` 登记）

- 存量 11 个 `src/renderer/components/common/*.test.tsx` 在 HEAD 中即带 BOM，已在 `eslint.config.js` 的测试/stories 豁免块降为 `warn` 渐进收敛（登记为 DEBT-030）；清偿方式为 `npx eslint --fix src/renderer/components/common/*.test.tsx`，随后删除该降级行让测试文件回到 `error`。

**禁止**

- ❌ 用脚本/工具批量改写源码后以带 BOM 编码写回。Windows PowerShell 的 `Set-Content -Encoding utf8` / `Out-File -Encoding utf8` 与部分编辑器的「UTF-8 with BOM」都会引入 BOM；批量改写必须显式无 BOM（例：`[IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`）。
- ❌ 在 LF 文件里混入单行 CRLF（BOM 注入通常伴随首行 `\r\n`，两者是同一类缺陷）。
- ❌ 为绕过拦截而关掉源码块的 `unicode-bom`，或给非测试源码加文件级 `/* eslint-disable unicode-bom */`。

---

## 校验与提交

- 本地 `pre-commit` 钩子对暂存文件运行 lint-staged（eslint + prettier + 相关单测），并在暂存含 TS/TSX 时执行 `tsc -b` 增量类型检查，任一失败即阻止提交。CI 中 `lint-typecheck` job 强制全量 `npm run lint`、`npm run typecheck` 与 `npm run i18n:guard`，`test` job（10 分片并行）强制全量 `npm test`，`coverage` job 强制 `npm run test:coverage` 覆盖率阈值门控（未达 `vitest.config.ts` 阈值即阻断 `build` job），均必须通过。
- 钩子与自查命令的分工必须说清：`.husky/pre-commit` **会改动文件**（`eslint --fix` + `prettier --write` 改写并重新暂存）；`npm run verify` / `verify:staged`（`scripts/verify-changes.ts`）是**只读**检查集（`tsc -b` + `eslint` 不带 `--fix` + `prettier --check` + 相关单测），格式检查作用域取自 `package.json` 的 `lint-staged` 中含 `prettier` 任务的键。因此 verify 通过不代表提交时文件内容不变，逐项差异见 `AGENTS.md`「verify 与 pre-commit 闸门的差异」；不得为对齐两侧而放宽钩子或 CI 的既有拦截。
- 修改 IPC / 错误码 / 主题变量时，PR 描述必须列出：受影响的通道清单、`docs/IPC_CONTRACT.md` 是否更新、是否有 i18n key 新增（`npm run i18n:guard`）。
- Commit message 遵循 Conventional Commits（`feat:` / `fix:` / `refactor:` / `chore:` / `docs:`）。
