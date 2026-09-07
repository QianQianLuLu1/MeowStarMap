# i18n 存量技术债改造标准操作流程（SOP）

> **历史文档（2026-08-22）**：本文所述 legacy 白名单已于 2026-08-23 全量清偿（终态见
> [`docs/i18n/whitelist-status.md`](./whitelist-status.md)），`eslint.config.js` 中的白名单块已删除，
> §3 中"从 legacy 白名单 files 数组删除该路径"一步已无可操作对象。本文仅作为历史 SOP 保留。

> 适用对象：`eslint.config.js` 中 `legacy` 白名单块的 43 个存量文件（截至 2026-08-22 共 **464** 处
> `no-restricted-syntax` 违规，配置文件注释中的"约 700 条"已过时）。
> 目标：按"修复一个、移除一个"的渐进式收敛，最终让中文硬编码检测对所有源码 `error` 硬阻断。

---

## 1. 工具链总览

| 命令                                    | 作用                                                                                                  | 是否新建                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `npm run i18n:status`                   | 统计白名单每文件违规数、按模块分布、列出已清零可移除文件                                              | ✅ 本次新增（`scripts/i18n/whitelist-status.ts`） |
| `npm run i18n:extract-legacy [file...]` | 对白名单文件逐处给出中文原文 + 候选 key + 语言包补丁草稿（**只读，不改源码/配置**）                   | ✅ 本次新增（`scripts/i18n/extract-i18n.ts`）     |
| `npm run i18n:extract`                  | babel + `babel-plugin-i18next-extract`，对 `t(...)` 调用做权威 key 提取（仅 renderer）                | 既有                                              |
| `npm run i18n:check`                    | 校验全部 11 个语言包 key 与 `zh-CN.json` 完全对齐                                                     | 既有                                              |
| `npm run sync-i18n-keys`                | 以 `zh-CN.json` 为基准，把缺失 key 同步到其余 11 个语言包（空串占位）                                 | 既有                                              |
| `npm run i18n:prune-whitelist`          | 列出 / 移除白名单中"违规已清零"的文件（**dry-run 默认，`--apply` 落地**）                             | ✅ 本次新增（`scripts/i18n/prune-whitelist.ts`）  |
| `npm run i18n:codemod [file...]`        | 安全自动改写：对纯 UI 文案字面量生成 `t()` 包裹 + locale 补丁（**dry-run 默认，`--apply` 审核落地**） | ✅ 本次新增（`scripts/i18n/codemod.ts`）          |
| `npm run i18n:guard`                    | CI 守卫：白名单只减不增、清零必移除、key 已同步（三项任一失败阻断流水线）                             | ✅ 本次新增（`scripts/i18n/guard.ts`）            |

**铁律（默认只读）**：`i18n:status` / `i18n:extract-legacy` 绝不 `writeFile` 改动源码或 `eslint.config.js`；
`i18n:extract-legacy --out <dir>` 仅写出独立的 `zh-CN.suggest.json` 草稿供人工 review。
`i18n:codemod` / `i18n:prune-whitelist` **默认 dry-run 仅预览**，`--apply` 才精确改写源码 / `eslint.config.js`，
且绝不改动仍有违规的文件、不调用 `del` / 批删（避免误删与本地删除网关拦截）。

---

## 2. 先分类：每处中文属于哪一类？

跑 `npm run i18n:extract-legacy <file>`，脚本已按启发式标注，人工复核时重点区分三类：

1. **UI 文案（要翻译）**：展示给用户看的按钮、标题、提示、对话框文本。
   例：`发现新版本`、`有可用更新，是否下载并安装？`、`稍后`。
2. **数据值 / DB 标识（不翻译，应豁免）**：被持久化或作为程序标识的中文，如 `id: '初心之吻'`
   （`scene-category.ts` 的 `OUTFIT_PRESETS` 整张表都是这类）、文件匹配 `pattern`、错误码等。
   处理：用 `// eslint-disable-next-line no-restricted-syntax` 在所在行豁免，**不要**包成 `t()`。
3. **日志 / 调试噪声（通常不翻译）**：`console.*`、或以 `[Module] 下载更新失败:` 这类带模块前缀的
   logger 输出。处理：logger 化或整行豁免；除非确属用户可见错误提示。

> ⚠️ **整文件都是数据值的特例**（如 `src/shared/scene-category.ts`，35 处全部是 `id`）：
> 在文件顶部加 `/* eslint-disable no-restricted-syntax */`，随后即可从白名单移除该文件。

---

## 3. 标准修复流程（单文件）

1. **选目标**：`npm run i18n:status` 看分布，优先挑"违规少"或"纯数据值"的文件（收敛成本最低）。
2. **取建议**：`npm run i18n:extract-legacy <file>`（可加 `--out <dir>` 落盘 `zh-CN.suggest.json`）。
3. **逐处判定**：按第 2 节分类——UI 文案走 4，数据值/日志走豁免（见第 5 节）。
4. **抽取并包裹**：
   - **渲染层（`.tsx` / 有 React 的 `.ts`）**：
     ```tsx
     import { useTranslation } from 'react-i18next'
     const { t } = useTranslation()
     // JSX 文本
     <span>发现新版本</span>  →  <span>{t('updateDialog.foundNew')}</span>
     // 字符串字面量
     const msg = '正在检查更新…'  →  const msg = t('updateDialog.checking')
     // 含插值
     `下载 ${pct}%`  →  t('updateDialog.downloading', { pct })
     ```
   - **主进程 / shared（非 React）**：中文常经 IPC 传给渲染层展示，或用于原生对话框。
     评估是否值得翻译——仅翻译**真正面向用户**的文案（对话框标题、菜单项）；日志保持豁免。
     使用项目既有的 `i18n.t`（见 `src/renderer/i18n/index.ts` 的接线）。
5. **写语言包**：把 key 落入 `src/renderer/i18n/locales/zh-CN.json`（嵌套结构，如
   `"updateDialog": { "foundNew": "发现新版本" }`）。
6. **同步其余 11 个语言包**：`npm run sync-i18n-keys` → 自动补齐空串占位 → `npm run i18n:check` 校验对齐。
   > 只改 `zh-CN.json` 而不跑 `sync-i18n-keys`，`i18n:check` 会因 key 不齐而失败（CI 阻断）。
7. **收敛收尾**：该文件违规清零后，从 `eslint.config.js` 的 `legacy` 白名单 `files` 数组删除该路径
   → 该文件回到 `src` 块的 `error` 硬阻断。再跑 `npm run i18n:status` 确认其 0 违规、总数下降。

---

## 4. key 命名规范

- **复用既有命名空间**，不要自创顶层键。现有命名空间示例：`appShell` / `gallery` / `detail` /
  `editor` / `common` / `sceneCategory` / `sceneTime` / `outfit`。
- **推荐粒度**：
  - 组件级：`组件名小驼峰.*`（如 `updateDialog.checking`、`updateDialog.downloadFailed`）
  - 页面级：`页面.*`（如 `duplicatesPage.emptyHint`）
  - 主进程服务：`服务名.*`（如 `backupService.creating`）
- **同一含义复用同一 key**，不要为相同文案重复建 key。
- **脚本生成的 `legacy.<path>.*` 仅作起点**（过长），落地前应改为上述语义化短 key。
- key 用**小驼峰**；禁止在 key 里塞中文或空格。

---

## 5. 豁免写法（数据值 / 日志）

- 单行豁免：
  ```ts
  const id = '初心之吻' // eslint-disable-next-line no-restricted-syntax
  ```
- 整文件豁免（整张表都是数据值时）：文件首行加 `/* eslint-disable no-restricted-syntax */`。
- 注意：`eslint-disable` 注释本身也是代码改动，需走正常 review；滥用会掩盖真实硬编码，慎用。

---

## 6. 常见陷阱

- **插值别用字符串拼接**：`下载 ${pct}%` 必须改 `t('k', { pct })`，否则翻译时丢变量。
- **动态拼接数组**（`parts.join('、')` 含中文）：先 `t()` 各片段再拼接，或整体抽取为带占位符模板。
- **JSX 内联表达式中的中文**：`{count > 0 ? '有更新' : '无更新'}` 两端都要 `t()`。
- **长 key 反模式**：`legacy.renderer.components.common.UpdateDialog.if` 过长，落地时务必精简。
- **只改 zh-CN 忘同步**：必跑 `sync-i18n-keys` + `i18n:check`。
- **白名单移除后未验证**：移除前确认该文件 `no-restricted-syntax` 已 0 报错，否则会误伤 CI。

---

## 7. 验收清单（每文件修复完成）

- [ ] 所有 UI 文案已 `t()` 包裹，数据值/日志已豁免
- [ ] key 已写入 `zh-CN.json` 且命名符合第 4 节规范
- [ ] `npm run sync-i18n-keys` 通过，`npm run i18n:check` 通过
- [ ] 该文件已从 `eslint.config.js` 白名单移除
- [ ] `npm run i18n:status` 显示该文件 0 违规，总违规数较上次下降
- [ ] `npm run lint` 该文件无 `no-restricted-syntax` 报错

---

## 8. 自动化提效（codemod / prune / guard）

在"分类 → 修复 → 抽取 → 同步 → 收敛"手动流程之外，本仓库另提供三个自动化脚本加速收敛：

- **安全自动改写 `codemod`（默认只读预览）**：
  - `npm run i18n:codemod` 打印每处违规的"安全判定"——哪些可自动包裹 `t()`、哪些需人工
    （JSX 文本、主进程无 `t` 作用域、数据值 / 日志）。
  - `npm run i18n:codemod --apply` 仅对"整段字符串字面量 + 文件已有 `t` 作用域"的纯 UI 文案落地改写，
    并把 `key → 文案` 写入 `generated/zh-CN.suggest.json` 补丁。
  - 落地后：`npm run sync-i18n-keys && npm run i18n:check && npm run i18n:status`。
  - 安全边界：不触碰拼接 / 模板 / 插值；主进程（`src/main`）无 `t`，统一留人工（需走 IPC / 原生对话框）；
    JSX 文本节点需 AST，留人工。
- **白名单自动瘦身 `prune-whitelist`**：
  - `npm run i18n:prune-whitelist`（dry-run）列出违规已清零、可立即移除的文件。
  - `npm run i18n:prune-whitelist --apply` 精确从 `eslint.config.js` warn 块移除这些路径，
    并二次校验移除后 0 违规；任何 >0 违规文件绝不移除。
- **CI 守卫 `guard`（已接入 `build.yml` 的 `lint-typecheck`）**：
  - 白名单**只减不增**（新增文件即失败）；
  - 清零却仍白名单的文件必须先用 prune 移除（否则失败）；
  - 11 个语言包 key 必须与 `zh-CN.json` 对齐（新增未同步即失败）。
  - 守卫依赖 `docs/i18n/whitelist-baseline.json` 基线（由现状刷新时生成）；白名单收敛到空集仍通过（子集关系）。
