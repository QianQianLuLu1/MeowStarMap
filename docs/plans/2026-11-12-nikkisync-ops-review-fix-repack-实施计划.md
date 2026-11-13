# 2.5.7-beta 全面审查 / 修复 / 全量验证 / 提交推送 / 重打包 实施计划

> 仓库根：`D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe`（下文所有路径均相对此根）
> 计划状态：已于 2026-11-12 获用户确认并批准（6 项决策见 §0），本文件即落盘到仓库的计划正本，将随本轮改动一并提交。
> 用户原始要求「计划写入仓库的 `plans/` 或 `.zcode/plans/`」：实测 `plans/` 不存在，`.zcode/`、`.workbuddy-ai/` 均被 `.gitignore` 忽略（`:157-158`、`:108`），而 `docs/plans/` 是受跟踪的活文档目录（77 篇历史计划），故落盘于此，不改变意图。

---

## 0. 范围、基线与已确认决策

**Git 基线（执行首步须用 `git status --short` / `git log --oneline -6` / `git diff --stat` 复核）**

- 分支 `main` @ `57b04bb`，领先 `origin/main` 4 个提交（`0138f73`、`128bdc6`、`5ea9546`、`57b04bb`），暂存区为空。
- 工作区 **44 个未暂存修改 + 2 个未跟踪文件** = 46 项（`+1507/−69`）；未跟踪文件为 `docs/plans/2026-11-11-nikkisync-ops-fix-gpu-diag-实施计划.md`、`src/renderer/stores/mediaStore.recycle-nikkisync.test.ts`。
- 最近 tag `NikkiGallery2.5.5-beta` 落后 433 提交，**不能作打包基线**。最后一次真实打包 = `5ea9546` 轮（2026-11-11 20:41:28，产物 `release/MeowStarMap-Setup-2.5.7-beta.exe` 189,167,812 B，`release/latest.yml` 与 `CHANGELOG.md:59`、上一轮计划三方对账一致）；其后仅 `57b04bb`（纯 CHANGELOG/plan 回写，无代码）。

**用户拍板的 6 项决策**

1. 版本号：**核实并统一声明位**（`package.json`/`package-lock.json` 保持 `2.5.7-beta` 不变，修正 `README.md`、`DEVELOPMENT.md` 残留的 `2.5.6`，核实 CHANGELOG / preview mock / e2e 版本断言自洽）。
2. 审查范围：**聚焦 46 个工作区文件**（+ `57b04bb` 纯文档提交），不扩大到 433 提交。
3. 修复深度：**修全部 5 个确认问题**；低优先级规范项只登记不改。
4. `e2e:smoke` 时序：**按你给的顺序跑（旧产物基线）+ `dist:win` 后补跑一次（新产物）**，两次全绿才收口。
5. 提交：**全部改动一次提交并 `git push origin main`**（会把领先的 4 个历史提交一并推送，已获授权）。
6. 版本时序：**合并为一次提交** —— 版本统一与 CHANGELOG 条目提前到 6 条验证之前完成，与 5 项修复、计划文档一起进同一条提交；之后只做重打包 + 补跑 `e2e:smoke`，最终 `git status --short` 干净。

**6 条验证命令（以用户原话为准，严格按此顺序，不得替换成仓库旧计划 §8 的 9 条清单）**
`npm install` → `npm run build` → `npm run test` → `npm run typecheck` → `npm run e2e:smoke` → `npm run test:ci-linux`

**审查确认的 5 个问题（逐行复核坐实）**

| #   | 位置                                                                                                                                                                                                                        | 缺陷                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | `src/renderer/stores/mediaStore.ts:931` + `src/renderer/pages/RecycleBinPage.tsx:310-326`                                                                                                                                   | 整页孤儿行时 `fetchNikkiRecyclePage` 返回 `null`，清空循环 `while (page && …)` 直接终止、`offset` 不推进 → 后续页永不删除，仍弹成功 toast（首页 `null` 时 `total=0`、`maxPages=0` 亦弹「已彻底删除 0 项」） |
| P2  | `src/renderer/stores/mediaStore.ts:1016`/`:1025`/`:960`/`:909`                                                                                                                                                              | `if (!page) return` 不推进 `nikkiRecycleOffset` 且 `recycleBinHasMore` 保持 true → 无限滚动每次重取同一页卡死；`consumed===0` 空页同样不推进                                                                |
| P3  | `src/shared/errors/app-error.ts:339-344` + `src/main/preload/ipc.ts:22-35` + `src/renderer/hooks/useStagedTask.ts:165` + `src/renderer/hooks/useFavoriteToggle.ts:63` + `src/renderer/pages/RecycleBinPage.tsx:179/264/346` | `extractUserMessage` 只在 `isAppError` 时读 `userMessage`，而 `IpcError extends Error`（非 AppError）→ 用户文案被忽略；`useStagedTask` 又提前把错误拍平为 `err.message`，`final.message` 已丢失用户文案     |
| P4  | `src/renderer/pages/RecycleBinPage.empty.test.tsx:18-63`、`RecycleBinPage.restore.test.tsx:16-69`                                                                                                                           | 「读源码 + `indexOf` 切片 + `toMatch` 字符串」的文本断言，不渲染组件、不验证实参/失败分支/返回值，分支写错仍绿                                                                                              |
| P5  | `src/renderer/hooks/useFileOperations.deleteProgress.test.tsx`                                                                                                                                                              | 未跟踪计划 `:99` 的 T6 声明 4 组 nikkisync 删除进度红灯用例，该文件（真实存在）未纳入本轮 46 项改动                                                                                                         |

**已核实无问题（勿误报，禁止顺手改）**：IPC 契约五处形状一致；3 个受保护文件 `asset-edits-handler.ts:1`、`preload/api/asset-edits.ts:1`、`services/log-service.ts:1` 的 `// @core-change:` 已就位；12 语包新增 key 齐全；`asset-edits:set` 部分合并/三态正确；新增 import 均被使用；15 个测试文件无 `skip`/`only`/注释掉断言。

---

## 1. 依赖声明

- **新增 / 变更 / 删除依赖：无**。不改 `package.json` 的 `dependencies` / `devDependencies` / `optionalDependencies`，不改 `package-lock.json` 的依赖树，不引入任何外部开源库（本轮全部复用仓库既有函数与测试范式）。
- **版本声明位**：`package.json:3`、`package-lock.json:3,9` 保持 `2.5.7-beta`；**不执行 `npm version`**（仓库无 `preversion`/`version`/`postversion` 钩子，手工声明位不会被同步，且用户明确要求保持该版本）。
- **运行时要求**：Node `>=22.12.0`（`package.json:24-26`），npm 10+；原生模块 `better-sqlite3` / `sharp` / `koffi` 需 Windows 原生绑定，首次安装或切换 Node 版本后需 `npx @electron/rebuild`（`DEVELOPMENT.md:79-87`）。
- **安装方式**：按用户要求执行 **`npm install`**（不传任何参数、不加 `--ignore-scripts`）。它会跑 `prepare: husky || true`、可能改写 `package-lock.json`（`prepare` 仅在 husky 失败时才求值 `true`，Windows 上非阻断）。若产生 `package-lock.json` 实质差异，纳入同一次提交并在报告中说明；若只是无关格式变化，按最小化改动原则复核后再决定。
- **已有工具链（无需安装）**：`tsx`、`electron-vite`、`electron-builder`、`vitest@5`、`@playwright/test`、`typescript`、`eslint`、`prettier`、`audit-ci`、`husky`、`lint-staged`，均在现有 devDependencies 中。
- **环境镜像**：`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 由环境变量注入，`.npmrc` 仅注释、无有效配置键；不得写入 `.npmrc`（npm 11 会报 `Unknown project config`）。

---

## 2. 启动与运行说明

**环境准备（执行首步，只读）**

```
git status --short && git log --oneline -6 && git diff --stat
node -v && npm -v                      # 确认 Node >=22.12.0
ls release/win-unpacked/*.exe          # e2e:smoke 硬依赖（当前存在，属 5ea9546 旧产物）
```

若基线不符（不是 46 项 / 不是 `57b04bb`），**停止并报告用户**，不自行 `reset` / `checkout`。

**启动 / 验证命令**

- 编译：`npm run build`（若 clean 触发 EPERM，按 §8 分级处置走文档分步绕行）
- 单测：`npm run test`；单个文件：`npx vitest run <path>` 或 `npm test -- <path>`；CI 宿主模拟：`npm run test:ci-linux -- <path>`
- 类型 / 静态：`npm run typecheck`、`npm run typecheck:e2e`、`npm run lint`、`npm run format:check`、`npm run verify`
- 冒烟：`npm run e2e:smoke`（`_electron.launch` 启真实 Electron 窗口，需桌面会话；写 `test-results/`、`.cache/`）
- 打包：`npm run dist:win` = `build:recycle-helper && stage:nikkisync-pc && build && pre-dist-check && electron-builder --win --publish never && verify:dist`
- 手工验收（可选）：`npm run dev` 下验证 nikkisync 源收藏/软删/恢复/彻底删/批量/撤销全链路、诊断包含 GPU 段。

**验证方式（原子化）**：每个 T 先跑 §4 阶段 B 的局部子集 → 红灯留证 → 绿灯；全部节点完成后跑 §4 阶段 C 的 6 条（严格顺序）+ 阶段 D 全局检查；提交后 `dist:win` 重打包 + 第二次 `e2e:smoke`；两次冒烟全绿才收口。

---

## 3. 子任务清单（每步含「涉及文件 / 输入输出 / 验收标准」+ TDD 红绿）

### T0｜Plan-first 落盘

- **涉及文件**：`docs/plans/2026-11-12-nikkisync-ops-review-fix-repack-实施计划.md`（新建，内容 = 本计划）
- **输入 / 输出**：本计划 → 仓库内受跟踪 MD（含 §1/§2/§5/§6/§7 五大块）
- **验收标准**：`git status --short` 出现 `?? docs/plans/2026-11-12-…md`；文件含五大块与可执行步骤表；未写入 `.zcode/` 或 `.workbuddy-ai/`

### T1｜P2 根因契约统一（孤儿页不再返回 null）

- **涉及文件**：`src/renderer/stores/mediaStore.ts`（`:899-900` 注释、`:931`、`:955/:960`、`:1016/:1025`）、`src/renderer/stores/mediaStore.recycle-nikkisync.test.ts`（未跟踪新文件）
- **输入 / 输出**：`fetchNikkiRecyclePage(offset: number)` + `listHidden({limit:200,offset})` + 逐条 `getAssetDetail` → `NikkiRecyclePage|null`；**`null` 今后仅表示真取数失败**（API 缺失 / `listHidden` 无效 / 抛错）
- **验收标准**：新增 3 组用例红灯→绿灯；该文件全部用例（既有 6 + 新增 4）全绿；`npm run verify` 中相关子集全绿
- **红灯**（追加到 `mediaStore.recycle-nikkisync.test.ts`，`import { fetchNikkiRecyclePage }`）：
  - R1 孤儿页：`detail` 全 throw、`hiddenPages:[{edits:[edit('a/1')],total:3}]` → `expect(page).not.toBeNull()`、`expect(page?.consumed).toBe(1)`、`expect(page?.files).toEqual([])`。**预期失败**：`expected null not to be null`
  - R2 续页：第 1 页 2 行有效 / 第 2 页 1 行孤儿 / 第 3 页 1 行有效（`total=4`）→ 两次 `loadNextRecycleBinPage()` 后 `expect(api.listHidden).toHaveBeenNthCalledWith(3, {limit:200, offset:3})`、`expect(recycleBinHasMore).toBe(false)`。**预期失败**：第 3 次未调用 / hasMore 仍 true
  - R3 边界：`{edits:[], total:2}` 空页 → 续页后 `hasMore===false`，且 `listHidden` 不重复取同一页
  - **契约同步（非删除覆盖）**：该文件 `:135-147` 既有用例断言「整页 detail 全失败 ⇒ 返回 null 且保留现有列表」，随新契约等价替换为「消费该页、`files:[]`、按 `total` 判定 `hasMore`」，并**新增** `consumed` / 消费推进 / `hasMore` 断言（强化）。注释记录「旧 `toBeNull()` 属 null 契约，随本轮统一同步更新，非弱化」。
- **绿灯最小改法**：
  - `:931` `if (recovered.length === 0) return null` → `return { files: [], total, consumed: page.edits.length }`；`:899` 注释改为「`null` 仅用于真取数失败」
  - `:1025` → `recycleBinHasMore: page.consumed > 0 && nikkiRecycleOffset < page.total`；`:960` 首页同样加 `page.consumed > 0 &&`
  - `:1016` `if (!page) return` **保持**（真失败保留 offset 供重试，符合 `:1028` 注释）；`:954` 保持；不动 `RECYCLE_BIN_PAGE_SIZE`、`dedupeAgainst`、本地源分支

### T2｜P1 + P4（清空循环修复 + 两个弱测试改行为测试）

- **涉及文件**：`src/renderer/pages/RecycleBinPage.tsx`（`:310-327`）、`src/renderer/pages/RecycleBinPage.empty.test.tsx`、`src/renderer/pages/RecycleBinPage.restore.test.tsx`
- **输入 / 输出**：nikkisync 隐藏集分页 → `file.deletePermanent(paths)` 逐页实参 → `staged.run` 终态 + `showMessageMock` toast + 重试入口
- **验收标准**：两个测试文件**完全移除** `fs.readFileSync`/`indexOf`/`toMatch` 源码断言，改为 `render(<RecycleBinPage />)` 行为测试；覆盖成功实参、失败分支、终态、孤儿页、真失败；`RecycleBinPage.permanentDelete.test.tsx` 既有 8 例保持全绿
- **红灯**（复用 `permanentDelete.test.tsx:14-149` 的 mock 套件：`ResizeObserverStub` / `vi.mock('./settings/sections')` 注入 `showMessageMock` / mock `react-virtuoso`·`ConfirmDialog`·`TaskProgressOverlay`·`useRefreshMedia` / `makeRecycleFile`）：
  - `empty.test.tsx`：「清空：第 1 页整页孤儿行时仍能删除第 2 页有效行」→ `expect(deletePermanent).toHaveBeenCalledWith(['D:/Game/a2.png'])`。**预期失败**：零调用且弹 `'success'` 但 `deletedCount=0`
  - `empty.test.tsx`：「`listHidden` 真失败时弹 error + 重试清空按钮，不得弹 success」→ **预期失败**：收到 `'success'`
  - `restore.test.tsx`（行为版）：`assetEdits.set(assetId,{isHidden:false})`、`mediaAction.restore` 零调用、`refreshMedia()` 被调、失败分支 `showMessageMock(...,'error')` + `setFailedAction('restore')`
  - **等价替换说明**：删除源码文本断言是用户明确要求的「改成行为测试」，以行为用例等价替换（非删除覆盖），注释记录理由；保留 `empty.test.tsx:33-49` 中 3 条「不得误读 `result.success` / 必须 `await loadRecycleBin()` / toast 语义」的**契约意图**，改为行为断言表达
- **绿灯最小改法**（依赖 T1 契约已统一；仅改 `:310-327`）：
  ```ts
  let offset = 0
  let pages = 0
  let deletedCount = 0
  const first = await fetchNikkiRecyclePage(offset)
  if (!first) throw new InternalError(t('recycleBin.emptyFailed'))
  const total = first.total
  const maxPages = Math.ceil(total / 200)
  let page: NikkiRecyclePage | null = first
  while (offset < total && pages < maxPages) {
    if (!page) throw new InternalError(t('recycleBin.emptyFailed')) // 取数失败不得弹成功
    const paths = page.files.map((f) => f.file_path).filter((p) => p.length > 0)
    if (paths.length > 0) {
      const r = await window.electronAPI!.file.deletePermanent(paths)
      if (!r.success) throw new InternalError(r.message)
      deletedCount += paths.length
    }
    offset += page.consumed // 孤儿页 consumed>0 ⇒ 推进到后续页（P1 核心）
    pages += 1
    page = offset < total && pages < maxPages ? await fetchNikkiRecyclePage(offset) : null
  }
  successMessage = t('recycleBin.permanentDeleteSuccess', { count: deletedCount })
  ```
  `maxPages` 仍兜底防死循环；保留 `200` 硬编码（低优先级规范项只登记）。

### T3｜P3 错误文案收口（根因修复）

- **涉及文件**：`src/shared/errors/app-error.ts`（**受保护路径**）、`src/renderer/hooks/useStagedTask.ts`、`src/renderer/pages/RecycleBinPage.tsx`（`:19`、`:179`、`:264`、`:346`）、`src/renderer/hooks/useFavoriteToggle.test.ts`、`src/renderer/hooks/useStagedTask.test.tsx`、`src/renderer/pages/RecycleBinPage.restore.test.tsx`、计划新增且未实施的 `src/shared/errors/app-error.test.ts`
- **输入 / 输出**：任意 `unknown` 错误（含 `IpcError` 形态 `Error & {userMessage}`）→ toast / `final.message` 用户文案
- **验收标准**：`extractUserMessage` 对 `AppError` 行为零变化；对 `IpcError` 形态返回 `userMessage`；3 处 toast 均经 `extractUserMessage`；`npx tsx scripts/core-path-gate.ts` 与 `npm run lint`（`local/core-path-guard`）通过；`useErrorToast.test.ts`、`useIpcCall.test.ts`、`useFavoriteToggle.test.ts` 既有用例全绿
- **裁定：选根因修复（改 shared 函数），不在渲染层复制 helper**。依据：`src/main/preload/AGENTS.md:116` 明文「userMessage 经 `extractUserMessage(error)` 取用」，`src/shared/AGENTS.md:73` 要求 toast 必经该函数；一次修复同时惠及 `useErrorToast.ts:110`、`useIpcCall.ts:207`、`useFavoriteToggle` 等既有调用点，比新增第 3、4 份本地 helper（违反 `src/renderer/AGENTS.md:69`）改动更小。用 duck typing，**不 import preload 的 `IpcError`**，shared 层保持零 electron 依赖。
- **红灯**（IpcError 桩复用 `ShareCardDialog.test.tsx:231` 的 `Object.assign(new Error(…), {name:'IpcError',…})`）：
  - `useFavoriteToggle.test.ts`：`updateFavorite.mockRejectedValue(Object.assign(new Error('DB raw: UNIQUE constraint failed'), {name:'IpcError',code:'INTERNAL_ERROR',userMessage:'收藏失败，请稍后重试'}))` → `expect(onShowMessage).toHaveBeenCalledWith('收藏失败，请稍后重试','error')`。**预期失败**：收到 `'DB raw: UNIQUE constraint failed'`
  - `useStagedTask.test.tsx`：`execute` 抛同形态，`expect(final.message).toBe('磁盘空间不足')`。**预期失败**：`expected 'raw technical' to be '磁盘空间不足'`
  - `restore.test.tsx`（行为版）：`mediaAction.restore` reject 同形态 → `showMessageMock` 收到用户文案 + `'error'`
  - 既有用例用普通 `new Error(...)`（无 `userMessage`）→ 仍走 `error.message`，不受影响
- **绿灯最小改法**：
  1. `src/shared/errors/app-error.ts` **第 1 行**新增至多一条真实中文授权注释（当前前 5 行为块注释、无 `@core-change`，禁用占位文案「核心路径保护规则初始化」）：
     `// @core-change: extractUserMessage 兼容 preload IpcError 的 userMessage 结构化读取，避免渲染层 toast 回落开发者技术串`
     `:342-344` 仅在 `error instanceof Error` 分支加 3 行，**`isAppError` 分支零改动**：
     ```ts
     if (error instanceof Error) {
       const m = (error as Error & { userMessage?: unknown }).userMessage
       if (typeof m === 'string' && m.length > 0) return m
       return error.message
     }
     ```
     不改 `toIpcError` / `isAppError` / 任何子类。
  2. `useStagedTask.ts:165` → `const message = extractUserMessage(err, String(err))`，加 `import { extractUserMessage } from '../../shared/errors/app-error'`（传 fallback 保持原非 Error 语义）。该文件在 `src/renderer/hooks/`，**非受保护路径**。
  3. `RecycleBinPage.tsx:19` 引入 `extractUserMessage`；`:179` → `showMessage(extractUserMessage(error, t('recycleBin.restoreFailed')),'error')`；`:264` / `:346` → `showMessage(extractUserMessage(final.message ?? t('recycleBin.…Failed')),'error')`。
  4. 计划新增且未实施的 `src/shared/errors/app-error.test.ts`：正常（`AppError.userMessage` 优先）/ 异常（IpcError 形态）/ 边界（`userMessage` 非字符串、空白串、`null`、数字 → 回落）三例。

### T4｜P5 补 nikkisync 删除进度回归用例

- **涉及文件**：`src/renderer/hooks/useFileOperations.deleteProgress.test.tsx`（现存、本轮 46 项未含）；仅当用例暴露真缺口时才动 `src/renderer/hooks/useFileOperations.ts`
- **输入 / 输出**：`getDeleteConfirm().onConfirm()` / `deleteFilesBatch(ids)` → `deleteProgress` 终态 + `assetEdits.set` / 本地通道调用记录
- **验收标准**：按 T6 声明补齐 4 组（软删 / 彻底删 / 批量混合 id 集 / 撤销）；stub 扩 `assetEdits:{set}`、`makeFile` 支持 `nikkisync.assetId`（复用 `useFavoriteToggle.test.ts:197-210` 的 `makeAssetFile`）；断言 `set(assetId,{isHidden:true})`、本地 `mediaAction.delete/softDelete` 零调用、`deleteProgress.phase==='done'`、失败项保留在 `failed`
- **红灯判定与硬性要求处置**：先写 4 组并跑。若暴露 `useFileOperations.ts` 真缺口 → 真红灯，按 TDD 最小改动修业务代码到绿。**若首次即绿**（业务代码 `:297-413` 已正确分流）：该节点属「覆盖补齐」而非「Bug 修复」，不落入用户「针对本次 Bug 新增的回归测试」硬性条款；仍按红线要求**收窄断言重写并重跑留证**（`toHaveBeenCalledWith('a/1',{isHidden:true})` + 本地通道 `not.toHaveBeenCalled()` + `failed[0].id` 精确匹配），报告中注明「首次绿属预期，本节点不改业务代码」。**严禁**用「stub 缺 `assetEdits` 导致的 TypeError」冒充红灯（属测试桩错误，禁止测试作弊）。

### T5｜版本号核实与统一（提前到提交前）

- **涉及文件（改）**：`README.md:10`、`DEVELOPMENT.md:5,804,859,870`
- **涉及文件（仅核实不改）**：`package.json:3`、`package-lock.json:3,9`、`CHANGELOG.md:26,28,583-586`、`src/renderer/preview/mock/database-mock.ts:664`、`e2e/helpers.ts:47-50`、`e2e/smoke.e2e.ts:97-100`、`release/latest.yml`、`dev-app-update.yml`、`AGENTS.md:7`
- **输入 / 输出**：`2.5.6` 残留 → `2.5.7-beta`；`package.json` 版本号设定为 `2.5.7-beta`（已是，保持）
- **验收标准**：`grep -n "2\.5\.6" README.md DEVELOPMENT.md` 仅剩历史说明性文字；`package.json`/`lock` 三处仍为 `2.5.7-beta`；`npx tsx scripts/check-doc-versions.ts` 与 `npx tsx scripts/check-changelog-release.ts` 均 exit 0；`e2e:smoke` 的 S4 版本断言成立
- **改法**：徽章 shields.io 连字符转义为 `version-2.5.7--beta-blue`；`DEVELOPMENT.md:804,859` 产物名 → `MeowStarMap-Setup-2.5.7-beta.exe`；`:5,870` 当前版本 → `2.5.7-beta`。**不运行 `npm version`**。

### T6｜CHANGELOG / i18n / 授权注释收口

- **涉及文件**：`CHANGELOG.md`（`[2.5.7-beta]` 节，本轮 5 项修复 + 版本统一条目）、`src/shared/errors/app-error.ts:1`（T3 已加）、`docs/IPC_CONTRACT.md`（**仅核实，不改表格分隔线**）
- **输入 / 输出**：本轮改动 → `[2.5.7-beta]` 节条目；`[Unreleased]` 保持已收口状态
- **验收标准**：`npx tsx scripts/check-changelog-release.ts` exit 0（`:99-130` 判据：版本节唯一、`[Unreleased]` 无条目，**不校验 commit 哈希**，故提交前写描述性条目即可）；`npm run i18n:guard` exit 0；`npx tsx scripts/core-path-gate.ts` exit 0；`npm run docs:links` exit 0
- 不写 `docs/plans/` 路径、不写未产生的 commit 哈希，避免提交后回填造成二次改动。

### T7｜6 条验证（按用户顺序）+ 全局回归 + 第一次 `e2e:smoke`（旧产物基线）

- **涉及文件**：无业务改动；产生 `test-results/`、`.cache/`、`dist/`（均被 gitignore）
- **验收标准**：§4 阶段 C 六条逐条 exit 0；阶段 D 全部 exit 0；第一次 `e2e:smoke` 全绿
- **必须标注**：此时 `e2e:smoke` 启动 `release/win-unpacked/*.exe`，是 `5ea9546` 轮旧产物（与尚未打包的工作区代码无关）；S4 因旧产物同为 `2.5.7-beta` 而成立。此结果**不代表本轮代码**，故需 T9 后补跑。

### T8｜一次性提交并 push

- **涉及文件**：`git add` 逐项核对 46 项 + T1–T6 产生的新改动 + 本轮计划文档
- **输入 / 输出**：工作区 → 本地 1 条提交 → `origin/main`
- **验收标准**：commit message 符合 commitlint（Conventional Commits，如 `fix(recycle-bin): 修复 nikkisync 回收站孤儿页分页与错误文案收口`）；`git log --oneline -6` 显示新提交 + 领先历史 4 提交；`git push origin main` exit 0；push 后 `git status --short` **干净**
- **注意**：`.husky/pre-commit` 会跑 ① `lint-staged`（`eslint --fix` + `prettier --write` **改写并重新暂存** + 对 `src/**/*.ts(x)` 跑 `npm run test:precommit`）② `core-path-gate.ts --staged` ③ `npx --no-install tsc -b`；`.husky/commit-msg` 跑 commitlint。提交后必须重新 `git status --short`，若钩子改写文件，对受影响文件重跑相关单测子集并确认绿灯，必要时新建后续提交（不 `amend`）。
- **`git add` 前逐项核对**，禁 `git add -A` 误加 `test-results/`、`.cache/`、`release/` 归档。

### T9｜重打包 + 第二次 `e2e:smoke`（新产物）

- **涉及文件**：`release/MeowStarMap-Setup-2.5.7-beta.exe`、`release/latest.yml`、`release/win-unpacked/`（**不入 commit**，`.gitignore:7`）
- **输入 / 输出**：已提交代码 → NSIS 安装包 + `latest.yml`
- **验收标准**：`npm run dist:win` exit 0；`latest.yml` 的 `version/size/sha512` 与产物、`verify:dist` 三方自洽；第二次 `npm run e2e:smoke` **全绿**；两次冒烟全绿才收口

---

## 4. 分步验证顺序与命令清单（每步通过才进入下一步）

**阶段 A｜基线复核（只读）**：`git status --short` / `git log --oneline -6` / `git diff --stat` / `node -v` / `npm -v`。判据：46 项、`57b04bb`、Node ≥22.12.0。不符 → 停止报告。

**阶段 B｜局部单测子集（每完成一个 T 立即跑；红灯必须留证）**

```
npx vitest run src/renderer/stores/mediaStore.recycle-nikkisync.test.ts
npx vitest run src/renderer/pages/RecycleBinPage.empty.test.tsx src/renderer/pages/RecycleBinPage.restore.test.tsx src/renderer/pages/RecycleBinPage.permanentDelete.test.tsx
npx vitest run src/renderer/hooks/useFavoriteToggle.test.ts src/renderer/hooks/useStagedTask.test.tsx src/renderer/hooks/useErrorToast.test.ts src/renderer/hooks/useIpcCall.test.ts
npx vitest run src/renderer/hooks/useFileOperations.deleteProgress.test.tsx src/renderer/hooks/useFileOperations.test.ts
npx vitest run src/shared/errors/app-error.test.ts        # 仅当 T3 追加该文件
npx tsx scripts/core-path-gate.ts                         # 工作区 diff 授权闸门
```

判据：红灯阶段出现**预期失败信息**并留证；绿灯阶段 exit 0。任一新增回归测试修复前即通过 → 按硬性要求重写断言重跑，不得弱化。

**阶段 C｜用户指定的 6 条（严格按此顺序，逐条确认全绿）**

```
1. npm install                 # 需网络；确认 exit 0、node_modules 可用、prepare 钩子无阻断
2. npm run build               # clean 可能 EPERM → 见 §8 绕行
3. npm run test                # vitest run 全量
4. npm run typecheck           # tsc -b + tsc -p tsconfig.scripts.json
5. npm run e2e:smoke           # 第一次：5ea9546 旧产物基线，必须显式标注
6. npm run test:ci-linux       # Windows 开发机模拟 ubuntu 宿主，强依赖真 sharp/koffi
```

判据：逐条 exit 0，无 Error 级日志；`npm install` 若改写 `package-lock.json` 需在报告中说明并纳入提交。

**阶段 D｜全局静态 / 类型 / 安全检查（用户第五条要求）**

```
npm run lint                  # eslint .（含 local/core-path-guard、i18n 护栏）
npm run typecheck:e2e         # typecheck 不覆盖 e2e/，必须补
npm run format:check          # 已带 --end-of-line auto，适配 core.autocrlf=true
npm run verify                # 只读：tsc -b + eslint + core-path-gate + prettier --check + 相关单测
npm run verify:staged
npm run i18n:guard
npm run audit                 # audit-ci 安全检查，需网络
npm run docs:links
npm run preview:check
npm run verify:nikkisync
npx tsx scripts/check-doc-versions.ts
npx tsx scripts/check-changelog-release.ts
npx tsx scripts/core-path-gate.ts --staged    # 暂存前可跳过，T8 时由钩子执行
```

判据：全部 exit 0；未全绿不得进入 T8。

**阶段 E｜提交与 push**：T8 命令与验收见上。

**阶段 F｜重打包**：`npm run dist:win`（内部串联 `build:recycle-helper → stage:nikkisync-pc → build → pre-dist-check → electron-builder --win --publish never → verify:dist`）。

**阶段 G｜第二次冒烟**：`npm run e2e:smoke` 全绿。两次全绿才收口。

**阶段 H｜收尾核对**：`git status --short`（干净）、`git log --oneline -3`、`release/latest.yml` 与安装包大小/sha512 对账、汇总 6 条命令 + 全局检查的逐项结果。

---

## 5. 错误处理（异常分支 / 兜底 / 日志规范）

- **孤儿行**：单条 `getAssetDetail` 失败跳过并 `console.error(i18n.t('mediaStore.log.fetchError'), assetId, error)` 留痕，不中断整页；整页孤儿行消费该页（`consumed = page.edits.length`，`files: []`）后继续翻页。
- **真取数失败**（API 缺失 / `listHidden` 返回无效 / 抛错）：`fetchNikkiRecyclePage` 返回 `null`；`loadNextRecycleBinPage` 保持 `nikkiRecycleOffset` 不变供用户再次触底重试（符合 `mediaStore.ts:1028` 注释）；**清空循环遇 `null` 抛 `InternalError(t('recycleBin.emptyFailed'))`**，使 `staged.run` 终态为 `error` → 红 toast + 「重试清空」按钮，**禁止「取数失败却弹 success」**。
- **防死循环**：`consumed===0` 时 `recycleBinHasMore=false`（T1）；清空循环用 `pages < maxPages`（`Math.ceil(total/200)`）兜底。
- **toast 文案兜底链**：`userMessage`（非空字符串）→ `error.message` → `String(error)` / i18n fallback；`extractUserMessage(error, fallback)` 对非字符串/空白串/非对象一律回落，不得因 duck typing 把任意对象当错误源。
- **日志规范**：`console.error` + i18n key，不输出完整路径/堆栈/敏感信息；主进程 `userMessage` 给用户、`message` 给开发者（`src/main/ipc/handlers/AGENTS.md:65`）；渲染层技术串一律不得直接弹 toast；`details` 仅放调试上下文，禁含密码/token/完整路径。
- **fail-open 一致性**：`asset-edits-repository.ts:153-169`、`log-service.ts`、`startup-diagnostic.ts`、`lifecycle.ts` 的静默回退符合 AGENTS.md「诊断/日志 fail-open」约定，本轮**不改**，仅在报告登记「上层无法区分无隐藏资产与库异常」为已知边界。

---

## 6. 参数校验（入参类型 / 必填 / 边界与非法值）

| 目标                                            | 约束与非法值处理                                                                                                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetchNikkiRecyclePage(offset: number)`         | `offset` 非负整数，由模块级 `nikkiRecycleOffset`（`:884`）维护；调 `listHidden({limit:200,offset})`；`page.edits` 必须 `Array.isArray`（`:907` 既有校验保留），否则 fail-closed 返回 `null`                                      |
| `NikkiRecyclePage`                              | `{files: MediaFile[]; total: number; consumed: number}`；`consumed` 必须等于 `page.edits.length`（含跳过孤儿行）；边界 `0` 触发分页终止；`total=0` 时 `maxPages=0`、清空循环零次                                                 |
| `handleEmptyRecycleBin`                         | 双条件 `offset < total && pages < maxPages`；`paths` 过滤 `p.length > 0`；`file.deletePermanent` 返回 `success:false` 即抛 `InternalError(r.message)`；`deletePermanent` / `listHidden` API 缺失时提前 return（既有 `:283-288`） |
| `assetEdits.set(assetId, {isHidden:true         | false})`                                                                                                                                                                                                                         | nikkisync id 为字符串 `assetId`（`Number()` 得 NaN，禁走本地通道）；`assetId` 缺失回落本地 `mediaAction` 分支 |
| `extractUserMessage(error: unknown, fallback?)` | `userMessage` 必须为**非空字符串**才采用；非字符串 / 空白串 / `null` / `undefined` / 数字 → 回落 `error.message` 或 `fallback`；不得抛错                                                                                         |
| `useStagedTask.run`                             | `stageLabels` 非空校验（`:112` 既有）保持不变；`signal.aborted` / `AbortError` 走 `cancelled` 终态                                                                                                                               |
| IPC handler 侧                                  | `asset-edits:listHidden` 的 zod `limit 1..500` / `offset 0..1_000_000`（既有，本轮不改契约）                                                                                                                                     |

---

## 7. 基础测试用例（正常 / 异常 / 边界三类，均为客观断言）

| 类别 | 用例                                   | 落点                                                                        | 断言                                                                        |
| ---- | -------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 正常 | 首页正常回捞                           | `mediaStore.recycle-nikkisync.test.ts:102-119`（既有）                      | `listHidden({limit:200,offset:0})`、`files[0].file_path`、`recycleBinTotal` |
| 正常 | 续页去重追加                           | 同上 `:157-179`（既有）                                                     | 第 2 次 `listHidden` 的 `offset:2`、末页 `hasMore=false`                    |
| 正常 | 恢复走叠加层                           | `RecycleBinPage.restore.test.tsx`（改造后）                                 | `set(assetId,{isHidden:false})`、`restore` 零调用、`refreshMedia()` 被调    |
| 正常 | 清空遍历多页                           | `RecycleBinPage.empty.test.tsx`（改造后）                                   | `deletePermanent(paths)` 逐页实参、`showMessageMock(…,'success')`           |
| 正常 | nikkisync 删除进度                     | `useFileOperations.deleteProgress.test.tsx`（T4）                           | `set(assetId,{isHidden:true})`、本地通道零调用、`phase==='done'`            |
| 异常 | 整页孤儿行                             | `mediaStore.recycle-nikkisync.test.ts`（R1/R2）                             | `page.consumed===1`、第 3 次 `listHidden` 的 `offset:3`、`hasMore=false`    |
| 异常 | 清空时真取数失败                       | `RecycleBinPage.empty.test.tsx`（新增）                                     | `showMessageMock(…,'error')` + 「重试清空」按钮，且**不**出现 `'success'`   |
| 异常 | IpcError 携带 userMessage              | `useFavoriteToggle.test.ts` / `useStagedTask.test.tsx` / `restore.test.tsx` | toast / `final.message` 等于用户文案，不等于技术 `message`                  |
| 异常 | 删除失败项保留                         | `useFileOperations.deleteProgress.test.tsx`（T4）                           | `failed[0].id` 精确匹配、`succeeded` 不含该 id                              |
| 异常 | `deletePermanent` 返回 `success:false` | `RecycleBinPage.empty.test.tsx`（新增）                                     | `staged.run` 终态 `error`、不弹 success                                     |
| 边界 | `page.edits.length===0`                | `mediaStore.recycle-nikkisync.test.ts`（R3）                                | 续页后 `recycleBinHasMore===false`                                          |
| 边界 | `consumed===0` 且 `total>0`            | 同上                                                                        | 不重复取同一页（`listHidden` 调用次数有上限）                               |
| 边界 | 非 Error 的 reject 值                  | `useFavoriteToggle.test.ts:163-172`（既有）                                 | `onShowMessage('收藏操作失败','error')`                                     |
| 边界 | `userMessage` 非字符串/空白串/`null`   | `src/shared/errors/app-error.test.ts`（计划新增且未实施）                   | 回落 `error.message` / `fallback`，不抛错                                   |

**TDD 硬性要求**：T1/T2/T3 的每条新增回归用例在修复前必须处于失败状态并留证；若修复前即通过，重写断言直至准确暴露问题再修代码。**不得**跳过、注释掉、删除测试，不得伪造或弱化失败结果。

---

## 8. 风险登记表与失败分级处置

| #   | 风险                                                                 | 处置                                                                                                                                                                                                           | 分级           |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| R1  | `npm run build` 的 clean `fs.rmSync` 触发 Safe-Delete EPERM          | 按 `DEVELOPMENT.md:121-129,796` 分步绕行：`npx electron-vite build` + `node -e "require('fs').writeFileSync('dist/main/package.json',JSON.stringify({type:'commonjs'}))"`，记录原因；不得跳过 build            | 可绕行（留证） |
| R2  | `test:ci-linux` / 原生模块 `sharp`·`koffi`·`better-sqlite3` ABI 不符 | 确认 Node ≥22.12.0；必要时 `npx @electron/rebuild` 后重跑；**不得跳过该命令**                                                                                                                                  | 可绕行         |
| R3  | `core-path-gate` 授权注释                                            | T3 改 `src/shared/errors/app-error.ts` 需第 1 行新增 1 条真实中文 `@core-change`（当前前 5 行无）；`npx tsx scripts/core-path-gate.ts` + `npm run verify` + pre-commit `--staged` 三重校验；3 个已就位文件不动 | 必须满足       |
| R4  | pre-commit `lint-staged` 改写文件                                    | `eslint --fix` + `prettier --write` 会改写并重新暂存；commit 后重新 `git status --short`，对改写文件重跑受影响子集确认绿灯；不顺手格式化                                                                       | 必须核对       |
| R5  | `npm run test:precommit` 子集失败                                    | 由 `scripts/run-precommit-tests.ts` 驱动，失败则修代码后重新 commit                                                                                                                                            | 阻断           |
| R6  | 两次 `e2e:smoke` 产物混淆                                            | 第一次 = `5ea9546` 旧产物（与工作区改动无关）；第二次 = `dist:win` 后新产物；两次全绿才收口，报告中显式标注                                                                                                    | 必须标注       |
| R7  | e2e 副作用污染暂存区                                                 | `test-results/`、`.cache/`、`dist/`、`release/` 均忽略；`git add` 逐项核对，禁 `git add -A`                                                                                                                    | 必须核对       |
| R8  | `git push origin main` 外部动作                                      | 用户已授权；会把领先 4 提交一并推送；鉴权/网络/非快进失败 → 停止报告，不 `--force`、不改 remote/凭证                                                                                                           | 需报告         |
| R9  | CHANGELOG 收口闸门                                                   | `check-changelog-release.ts:99-130` 只校验版本节唯一 + `[Unreleased]` 无条目，**不校验 commit 哈希**；当前 `[Unreleased]` 已收口、版本节存在，写描述性条目即可，避免提交后回填                                 | 阻断           |
| R10 | CI 命令在开发机语义差异                                              | `test:ci-linux` 是 Windows 开发机模拟 ubuntu 宿主的装置（装置自带失真清单）；不得把「开发机通过」等同「CI 通过」，结论中注明差异                                                                               | 需注明         |
| R11 | 契约变更使既有测试变红                                               | `mediaStore.recycle-nikkisync.test.ts:135-147` 是未跟踪新文件，随契约统一同步改断言并**新增** hasMore/消费推进断言（强化非弱化），注释记录理由                                                                 | 必须记录       |
| R12 | T4 首次即绿                                                          | 见 T4 处置：收窄断言重写重跑留证，注明「覆盖补齐、非 Bug 修复」；禁伪造红灯                                                                                                                                    | 需注明         |
| R13 | `npm run audit` 需网络                                               | 记录网络原因并单独复跑；**不得**改 `audit-ci.jsonc` 放宽规则                                                                                                                                                   | 可绕行         |
| R14 | `npm install` 改写 `package-lock.json`                               | 复核差异性质；实质差异纳入同一次提交并说明，无关格式变化按最小化改动原则处理                                                                                                                                   | 需核对         |

**失败分级**

- **必须修代码（阻断）**：任何单测红灯不符预期、断言失败、typecheck/eslint/core-path-gate 报错、`extractUserMessage` 回归、`e2e` 断言失败、`pre-dist-check` 闸门失败 → 回到对应 T 修业务代码，重跑该子集 + `npm run verify`。
- **可绕行（环境性，须留证）**：R1 / R2 / R13。
- **需报告用户（不自行处理）**：R8、基线不符、push 失败、pre-commit 改写导致工作区不干净。

---

## 9. 明确的「不做什么」

1. 不运行 `npm version`；不改 `package.json:3` / `package-lock.json:3,9` 的 `2.5.7-beta`；不新增/升级/删除任何依赖。
2. 不改 5 个低优先级规范项（只登记）：`RecycleBinPage.tsx:313` 硬编码 200、`docs/IPC_CONTRACT.md` 表格分隔线、4 处 `(file as AssetMediaFile).nikkisync` 强转、fail-open 静默回退、`asset-edits-handler.test.ts:40` 的 COUNT(*) 桩。
3. 不扩大审查范围到 433 提交；不以 `NikkiGallery2.5.5-beta` 作基线。
4. 不顺手重构/格式化无关代码：不改 `toIpcError` / `isAppError` / 任何 `AppError` 子类；不删 `reference-data-sections.tsx` / `share.ts` 既有本地 helper；不改 `dedupeAgainst`、本地源 keyset 分页、`RECYCLE_BIN_PAGE_SIZE`。
5. 不改 IPC 契约面（通道名 / `electronAPI` 方法签名 / `IpcResponse`·`IpcError` 结构）；不 import preload 的 `IpcError` 到 shared 层。
6. 不删除/跳过/注释掉任何测试，不弱化或伪造失败结果；`empty.test.tsx` / `restore.test.tsx` 的源码文本断言以行为用例**等价替换**并注释理由；`mediaStore.recycle-nikkisync.test.ts:135-147` 的契约同步为强化。
7. 不假设不存在的脚本：`build:win` / `package` / `build:unpack` 均不存在；所有命令以 `package.json:31-92` 已核对的 61 条为准。
8. 不动已就位的 3 个受保护文件授权注释；`app-error.ts` 只新增 1 条、禁用占位文案。
9. 不在第一次 `e2e:smoke` 前重打包；不把 `release/` 产物、`test-results/`、`.cache/` 纳入 commit。
10. 不自行处理 push 失败（不 `--force`、不改 remote/凭证）；不 `git reset --hard` / `git checkout --` 丢弃工作区改动。

---

## 10. 交付与验收总表（必须逐项报告结果）

| 项           | 判据                                                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5 个确认问题 | 全部按红→绿闭环修复，新增回归测试修复前确有失败留证                                                                                                                                                      |
| 6 条验证     | `npm install` / `npm run build` / `npm run test` / `npm run typecheck` / `npm run e2e:smoke`(旧产物) / `npm run test:ci-linux` 逐条 exit 0，报告每项结果                                                 |
| 全局回归     | `lint` / `typecheck:e2e` / `format:check` / `verify` / `i18n:guard` / `audit` / `docs:links` / `preview:check` / `verify:nikkisync` / 版本与 CHANGELOG 闸门 / `core-path-gate` 全部 exit 0，无新增失败项 |
| 版本         | `package.json` 为 `2.5.7-beta`；`README.md` / `DEVELOPMENT.md` 无 `2.5.6` 残留；`check-doc-versions.ts` / `check-changelog-release.ts` exit 0                                                            |
| 提交         | 1 条符合 commitlint 的清晰提交，包含 46 项 + 修复 + 计划文档；`git push origin main` 成功；最终 `git status --short` 干净                                                                                |
| 打包         | `npm run dist:win` exit 0；`latest.yml` version/size/sha512 自洽；**第二次 `npm run e2e:smoke` 全绿**                                                                                                    |
| 一票否决     | 任一回归测试或静态检查未通过 → 任务不得标记完成                                                                                                                                                          |
