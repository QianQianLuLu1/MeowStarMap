# 重构计划：设置页导航结构与功能布局整合（UI 债务清偿 · 严格 TDD）

> 本文为 2026-10-16 轮次快照，当前口径以主规约文档为准（生命周期/约定见根 AGENTS.md 与 docs/CODING_CONVENTIONS.md；渲染层细节见 src/renderer/AGENTS.md）。
> 仓库：`D:/Zcode项目/WXNN YD - 副本/WXNN XiangCe`（wxnn-photo-manager v2.5.5）
> 分支：`feat/gallery-runtime-embed`（开工前工作树干净；`stash@{0}` 为 `feature/sync-integration-07-bidirectional-sync` 的历史遗留，本次不动它）
> 方案（用户已拍板三项）：① 合并力度**中等**（9 组 23 节 → 8 组 17 节，profile 保持独立成组）；② **顺带全量替换 `SettingsCard`**（零行为变更的机械替换）；③ 旧 `activeSection` 走**显式迁移映射 + 兜底**。

---

## 一、背景与根因（逐行取证，非推测）

设置页当前 9 个二级分组 / 23 个三级节（`src/renderer/pages/SettingsPage.tsx:46-201`）。左导航一屏只渲染一个节，同类动作被拆到不同页面，复用层已存在却未被采纳。

| 编号 | 缺陷                                                                                          | 证据                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1   | 「哪些目录被扫描」这一件事被拆成 4 个页面                                                     | `scan-paths` / `scan-game-roots` / `scan-import-roots` / `scan-fallback`（`SettingsPage.tsx:89-117`）                                                                                                                                                                                                                                                                 |
| N2   | 同一个设置键被两套代码读写，其中一套绕过归一化                                                | `ScanPathsSection` 裸调 `settings.get/set('customScanPaths')`（`scan-sections.tsx:57,66`）；`ScanFallbackSection` 走 `loadCustomScanPaths/saveCustomScanPaths`（`:317`），后者内部 `normalizePathList` 会剔除非字符串与空白                                                                                                                                           |
| N3   | `customScanPaths` 写入后，同域只读块不刷新                                                    | 拆页时被「切页重挂 effect」掩盖；合页后会明显读到陈旧列表                                                                                                                                                                                                                                                                                                             |
| N4   | 已有 `SettingsCard`（`shared.tsx:234`）但 21 处仍手写同构 `p-3 rounded-lg + bg-tertiary` 卡片 | about(2) / data(7) / diagnostics(10) / general(1) / profile(1)                                                                                                                                                                                                                                                                                                        |
| N5   | `SegmentedControl` 自身注释即写明 SettingsPage 手写变体「待后续统一接入」                     | `components/common/SegmentedControl.tsx:26`；对应 `appearance-sections.tsx:199-223`（字号）、`242-274`（玻璃）两套手写档位磁贴，`general-sections.tsx:183-198` 裸 `input[type=range]`                                                                                                                                                                                 |
| N6   | `settings.theme.desc` 在同一页渲染两遍                                                        | `appearance-sections.tsx:25`（作 `SectionShell description`）与 `41-43`（又一遍 `<p>`）                                                                                                                                                                                                                                                                               |
| N7   | **11 个语言包共 62 处导航文案为空串**，非中文用户导航条目直接空白                             | `settings.sections.{pluginManage,scanPaths,gameRoots,scanFallback,importRoots}` + `settings.groups.plugins` 在 zh-TW/ja/ko/fr/de/es/pt/ru/th/vi 各 6 处为空、en 缺 `gameRoots`/`scanFallback` 2 处。`npm run i18n:guard` 与 `scripts/check-i18n-keys.ts` 只查键**存在性**、从不查空值，故闸门一路绿灯（已实跑确认）。这些键恰好是合并后页面的块标题，属本次必须收口项 |

### 明确不做（防止范围蔓延）

- 不扩写 `SectionShell` / `SettingsRow` 的 props——现有签名足够。
- `diagnostics-sections.tsx:223,805` 是裸 `glass-card p-5` + 标题行右侧挂按钮的头栏，`SectionShell`（`shared.tsx:64-77`）表达不了「标题行带操作按钮」，机械替换会新增 `card-hover` 并挪动工具栏 = 视觉变更，禁止。
- `about-sections.tsx:65,271-331` 技术栈版本字符串陈旧（写 `Electron 28 + React 18 + TypeScript 5.3`，实为 Electron 41 / React 19 / TS 5.9；`scripts/check-doc-versions.ts` 只校验 README，无人把关）→ 登记 DEBT-035，不在本次改。
- 设置页内联 `rgba()` 与三元里的 hex 色值（`data-sections.tsx:419`、`diagnostics-sections.tsx:383,393-397,438-441,530-539,599,691,958-969`、`about-sections.tsx:163`）→ 登记 DEBT-036。原因：`eslint.config.js:204-211` 的 §3-a 只匹配 `style={... Property > Literal}`，`ConditionalExpression` 与 `rgba()` 均落在选择器盲区，属「漏检的技术债」而非红灯。**迁移代码时不得把 hex 内联进 style 对象字面量**——那会新触发 error。
- 不动任何 IPC 通道 / preload / 主进程 / `package.json` 版本 / `CHANGELOG.md`。`[Unreleased]` 当前已收口为空，**不得新增条目**，否则下一次 `npm run dist:win` 被 `scripts/check-changelog-release.ts` 拦住。
- 不碰 `src/main/scanner/**`：N3/R2 的修复放在渲染层收口，主进程语义不动。

---

## 二、依赖声明

**零新增依赖。** 全部复用仓库内既有实现：

| 复用物                                                                                                                        | 出处                                                                                                        | 用途                                            |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `SectionShell` / `SettingsCard` / `SettingsRow` / `SettingsToggle`                                                            | `src/renderer/pages/settings/shared.tsx:60,234,103,153`                                                     | 页壳与行项；**不扩 props**                      |
| `SegmentedControl`（`role=radiogroup`/`radio`，`ariaLabel` 必填，`options:{value,label,icon?,disabled?}`，`onChange(value)`） | `components/common/SegmentedControl.tsx:6-48`                                                               | 替换两处手写档位磁贴                            |
| `SliderControl`（`label,value,min,max,step,onChange,onCommit,unit,defaultValue,onReset`）                                     | `components/common/SliderControl.tsx:3-25`                                                                  | 替换裸 `input[type=range]`                      |
| `loadCustomScanPaths` / `saveCustomScanPaths`（内含 `normalizePathList`，上限 64）                                            | `src/renderer/utils/scan-exclusions.ts`（已在 `scan-sections.tsx:8-9` 导入，**无需新增 import**）           | 统一 N2 双套读写                                |
| `GlobalToastProvider` / `useGlobalToast`                                                                                      | `components/common/ToastProvider.tsx`，经 `settings/shared.tsx:13-17` 与 `sections.tsx:6` re-export         | 提示；**barrel 出口不得变动**                   |
| `AppError.preconditionFailed`                                                                                                 | `src/shared/errors/app-error.ts`                                                                            | 既有 IPC 缺失分支保持                           |
| 测试脚手架                                                                                                                    | `tests/setup.ts`（jsdom + zh-CN i18n + electronAPI Proxy + motion/react mock）                              | 新套件直接复用                                  |
| i18n 键契约测试范式                                                                                                           | `src/renderer/i18n/locales/sync-gallery-keys.test.ts`（12 包静态导入、`readPath()`、`leafKeys()` 同构断言） | 新建 `settings-nav-keys.test.ts` 逐字对齐该结构 |

无新增 IPC 通道 ⇒ `docs/IPC_CONTRACT.md` 无需变更。无受保护路径改动 ⇒ 不需要 `// @core-change:` 注释（`scripts/core-path-gate.ts:37-42` 的 `PROTECTED_GLOBS` 只含 `src/main/preload/api`、`src/main/ipc/handlers`、`src/main/services`、`src/shared/errors`，均不含 `src/renderer/pages/settings/**`，已核实）。

---

## 三、启动与运行说明

### 环境准备与启动

```bash
npm ci      # 依赖已就绪；原生模块 koffi / better-sqlite3 / sharp 已装
npm run dev # electron-vite dev，进入设置页做人工自检
```

### 自动化验证命令（每个子任务都要跑）

```bash
# 设置板块全量（开工基线 42 项，任何一步都不得跌破）
npx vitest run src/renderer/pages/SettingsPage.test.tsx src/renderer/pages/settings/

# 新建的三份套件 + 键契约
npx vitest run src/renderer/i18n/locales/settings-nav-keys.test.ts \
               src/renderer/pages/settings/appearance-sections.test.tsx \
               src/renderer/pages/settings/scan-sections.test.tsx \
               src/renderer/pages/settings/general-sections.test.tsx

# 复用组件的既有套件（不得被我方改动弄红）
npx vitest run src/renderer/components/common/SegmentedControl.test.tsx \
               src/renderer/components/common/SliderControl.test.tsx

# barrel 波及面冒烟（21 个文件 import 它，其中 8 个测试 vi.mock 它）
npx vitest run src/renderer/components/scanner src/renderer/pages/GalleryPage.test.tsx \
               src/renderer/pages/RecycleBinPage.refresh.test.tsx

# 全局闸门
npm run typecheck && npm run lint && npm run format:check \
  && npm run i18n:guard && npm run i18n:check && npm run verify && npm test
```

> **关键陷阱（必守）**：`scripts/find-related-tests.ts:44-58` 只按 `<同名base>.test.ts(x)` 匹配。所以改 `scan-sections.tsx` 时 `npm run verify` 与 `.husky/pre-commit` **不会**自动跑 `ImportRootsSection.test.tsx` / `ScanFallbackSection.test.tsx` / `ScanGameRootsSection.test.tsx` / `AppearanceDisplaySection.test.tsx`——它们不叫这个名字。必须由执行者显式跑上面的命令，不得依赖 `verify` 代跑。
> 反过来，新建 `scan-sections.test.tsx` / `appearance-sections.test.tsx` / `general-sections.test.tsx` 会让 `verify` 与 pre-commit 从此真正覆盖这三个源文件（当前它们完全没有匹配套件，`verify` 只输出 `[VERIFY] ⚠`）。这是本次的附加收益。

### 人工自检路径（10 步）

1. 进设置页 → 左导航 **8 组 17 项**，无空分组标题。
2. 篡改 `localStorage['settings-active-section']='scan-fallback'` 后刷新 → 落在「扫描目录」且该项**高亮**（现状：旧 id 回退默认节且无任何高亮）。
3. 「扫描目录」单页内四块同屏：游戏目录 / 检测到的游戏目录 / 指定目录 / 手动兜底扫描，块标题不变。
4. 在兜底块「选择游戏安装根目录」加一个目录 → 上方「游戏目录」列表自动出现该条，无需切页。
5. 「扫描目录」页内：图库正在扫描时点「添加指定目录」→ 应报「扫描进行中」且按钮**恢复可点**，之后图库扫描结束**不得**误弹「已添加指定目录」。
6. 外观页：字号与玻璃效果为药丸切换（方向键可切），选「轻度增强」后颗粒纹理/漂浮几何体两开关仍为禁用。
7. 「文件操作」批量阈值：键盘方向键调整后**应落库**（旧实现只有鼠标抬起才落库，键盘改值被静默丢弃）。
8. 数据页：「缓存与清理」同屏，两个危险确认框互不干扰。
9. 插件/分享码同在一个「工具与插件」组内，原功能无变化。
10. 切 12 种语言 → 导航项与合并页块标题**均不得空白或显示原始 key**。

### 日志输出规范

主进程 `logs/main-YYYY-MM-DD.log`；渲染层 DevTools Console。组件级诊断沿用 `SettingsToggle` 的 `console.error('[SettingsToggle] ...')` 前缀风格，本次新增日志一律 `[Settings]` 前缀；面向开发者的内容用英文（不走 i18n），用户可见文案一律 `t('...')`。

---

## 四、错误处理机制

本次**不改变任何既有错误语义**，仅新增一处由合并直接引出的必要收口：

1. **保持原样**：各块继续 `window.electronAPI` 守卫 + `try/catch` + `GlobalToastContext` 出文案。`GameRootsSection` 在 `scanner.detectGameRoots` 缺失时抛 `AppError.preconditionFailed('IPC_UNAVAILABLE')`（`scan-sections.tsx:172-174`）并被 `:195` 捕获，渲染错误卡 + 「重试」——不动。
2. **新增收口（本次唯一行为修正之一）**：`ImportRootsSection.handleAddDirectory`（`:596-622`）只把 **IPC 抛异常**当失败，从不检查 `scanner.start` 的返回值。而主进程 `startScan` 在已有扫描时 `return { success:false, message:scanInProgress }` 且**不广播** `scanner:complete`（`src/main/scanner/index.ts:87-91`，已核实）。后果：`scanningDir` 与 `customScanningRef.current` 双双卡死 → 按钮永久「正在扫描…」，且**下一次任意扫描完成**会被当成这次添加成功，误报「已添加指定目录 X」并做无谓刷新。拆页时需图库侧扫描撞车才触发，合并同屏后一键即达。修复：`await` 后判 `!result.success` → 清两个 flag + 复用既有 `importRootsAddFailed` 文案。
3. **`scan-exclusions` 读写失败**继续 fail-open 返回空数组（沿用 `utils/scan-exclusions.ts` 现状），因此切到 util 后 `ScanPathsSection` 的失败语义与现状一致（异常不冒泡、列表退化为空）。此取舍须在改动处写明注释。
4. **兜底扫描**：`ScanFallbackSection` 既有 `success`/`catch` 双分支提示（`:338-358`）保持；新增的仅是「写完 customScanPaths 后通知父级」的可选回调，缺省即无操作，不影响任何既有调用点。
5. **无障碍兜底**：`SettingsToggle` 已有 label 缺失 / onChange 非函数 / 回调抛错的三重 `console.error` 隔离（`shared.tsx:168-186`），迁移时逐字保留。
6. 渲染层不改主进程 ⇒ 无 IPC 契约同步义务；错误展示继续经 `extractUserMessage` / `useErrorToast`（本次不涉及新通道）。

---

## 五、参数校验规则

| 对象                                        | 规则                                                                                                        | 边界 / 非法值处理                                                                                                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LEGACY_SECTION_ALIASES`                    | 键声明为**闭合字面量联合类型** `LegacySectionId`（10 个旧 id）                                              | 漏配或将来改名 ⇒ `tsc` 直接报错，把迁移表纳入类型系统而非散落字符串                                                                                                                        |
| `resolveActiveSection(raw: string \| null)` | 顺序：`null`→`DEFAULT_SECTION`；命中别名→新 id；在新树中存在→原样；其余→`SETTINGS_GROUPS[0].sections[0].id` | 未识别 id（含既有测试的 `'sync-service'`）必须仍回退默认节——这是既有契约，逐字不削弱                                                                                                       |
| 字号档位                                    | `'small'\|'normal'\|'large'\|'xlarge'` 四字面量不变宽                                                       | `SegmentedControl` 的 `value` 泛型收窄，非法值进不来                                                                                                                                       |
| 玻璃档位                                    | 沿用导出的 `normalizeGlassEffect`（`appearance-sections.tsx:73`，非 `'lite'` 一律归 `'rich'`）              | **必须保持导出**（`AppearanceDisplaySection.test.tsx:18` 在导入它）；`option.value` 必须逐字为 `'rich'/'lite'`，否则 `html.glass-lite` 氛围层降级链（`src/renderer/AGENTS.md` §3）静默断裂 |
| `customScanPaths`                           | `MAX_CUSTOM_PATHS = 64`，与主进程 `scanner-handler` 的 `schema.max(64)` 同源（`scan-sections.tsx:21`）      | 切 `normalizePathList` 后逐项剔除非字符串/空白/超长；混入脏数据时**只渲染合法项**                                                                                                          |
| `fileOps.batchThreshold`                    | `min 3 / max 100 / step 1`                                                                                  | 传给 `SliderControl` 的三值必须与原 `input` 完全一致（同置约束）；**必须传 `defaultValue={batchThreshold}`**，否则 `SliderControl` 双击复位会无条件写入 `min=3`，误操作丢值                |
| 缓存上限（未改动）                          | 0.1–100 GB                                                                                                  | 保持原位原逻辑                                                                                                                                                                             |
| i18n 新键                                   | 5 个新键必须在 **12 个语言包全部非空**                                                                      | 由 `settings-nav-keys.test.ts` 判红；**禁止**用 `npm run sync-i18n-keys` 走捷径——该脚本以 `""` 补空并删除多余键（`scripts/sync-i18n-keys.ts:2-4`），会批量制造 N7 那种空白文案 bug         |
| 新 UI 文案                                  | 一律 `t('...')`                                                                                             | 缺键即测试红；`src/**` 硬编码中文是 eslint error                                                                                                                                           |

---

## 六、目标结构与逐文件改动

### 6.1 最终 `SETTINGS_GROUPS`：8 组 / 17 节（原 9 / 23）

| 组                                                   | 节 id                                                                         | 组件                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `general`                                            | `general-startup` / `general-fileops` / `general-export` / `general-language` | 不变                                                       |
| `appearance`                                         | **`appearance-theme-display`** ← `settings.sections.themeDisplay`             | **`AppearanceThemeDisplaySection`**（新壳）                |
| `scan`                                               | **`scan-directories`** ← `settings.sections.scanDirectories`；`scan-options`  | **`ScanDirectoriesSection`**（新壳）；`ScanOptionsSection` |
| `profile`                                            | `profile-manage`                                                              | 不变（独立成组，用户已确认）                               |
| `data`                                               | `data-backup`；**`data-cache-clear`** ← `settings.sections.cacheCleanup`      | `DataBackupSection`；**`DataCacheClearSection`**（新壳）   |
| `diagnostics`                                        | `diagnostics-scan` / `diagnostics-logs` / `diagnostics-crash`                 | 不变                                                       |
| `about`                                              | **`about-overview`** ← `settings.sections.aboutOverview`；`about-license`     | **`AboutOverviewSection`**（新壳）；`AboutLicenseSection`  |
| **`tools-plugins`** ← `settings.groups.toolsPlugins` | `tools-sharecode` / `plugins-manage`                                          | `ToolsShareCodeSection` / `PluginManageSection`            |

`DEFAULT_SECTION = 'general-startup'`（`:203`）不变。合并页块顺序（扫描目录）：游戏目录 → 检测到的游戏目录 → 指定目录 → 手动兜底（先写 `customScanPaths` 的，再派生候选，再 `import_roots`，最后触发动作）。

### 6.2 组合方式：壳组件堆叠，不搬动任何节体

```tsx
export const ScanDirectoriesSection: React.FC = () => {
  const [pathsRev, setPathsRev] = useState(0)
  return (
    <div className="space-y-4">
      <ScanPathsSection key={`scan-paths-${pathsRev}`} />
      <GameRootsSection key={`game-roots-${pathsRev}`} />
      <ImportRootsSection />
      <ScanFallbackSection onCustomPathsChanged={() => setPathsRev((n) => n + 1)} />
    </div>
  )
}
```

三条理由：

1. `SectionShell` 无需改动（每个节自带一张卡）。
2. `ImportRootsSection` / `ScanFallbackSection` / `ScanGameRootsSection` / `AppearanceDisplaySection` 四份既有测试继续按原名从 `./scan-sections` / `./appearance-sections` 导入，**零改动保持绿色**——这是选择「加壳」而非「物理合并节体」的决定性原因。
3. `space-y-4` 是必需的：`SettingsPage.tsx:275` 容器为 `flex-1 min-w-0 overflow-y-auto max-w-2xl`，无 gap 工具类；今天每节只返回一张卡所以从未需要。页内 `ConfirmDialog`/`BaseDialog` 未 portal 且关闭态不渲染 DOM，不会给 `space-y-4` 增加空档。

`key` 重挂解决 N3：`pathsRev` 变更时两个只读块重新执行 mount effect，语义等同于过去「切页自动重读」；重挂不触发任何 `scanner.start`（两块的 mount 路径里都没有），不会误扫盘。

### 6.3 文件清单

**新建（4 个，全部是测试）**

| 路径                                                       | 内容                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/i18n/locales/settings-nav-keys.test.ts`      | 结构对齐 `sync-gallery-keys.test.ts`：12 包静态导入 + `LOCALES` + `readPath()` + `leafKeys()`。断言 (a) 5 个新键 12 包齐备非空；(b) 8 个 `settings.groups.*` + 17 个 `settings.sections.*` 在 12 包**全部非空**（收口 N7）；(c) `settings.sections` 子树与 zh-CN 同构 |
| `src/renderer/pages/settings/appearance-sections.test.tsx` | 文件名刻意取 `appearance-sections.tsx` 的 base，使 `verify`/pre-commit 从此自动跑它。N6 重复渲染断言 + 磁贴→药丸角色断言 + 氛围开关联动禁用断言                                                                                                                       |
| `src/renderer/pages/settings/scan-sections.test.tsx`       | N2 脏数据归一化、R2 `success:false` 收口、N3 合页后自动刷新                                                                                                                                                                                                           |
| `src/renderer/pages/settings/general-sections.test.tsx`    | `SliderControl` 键盘提交 + 双击不误写                                                                                                                                                                                                                                 |

**改动（17 个）**

| 路径                                                            | 改动                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/pages/SettingsPage.tsx`                           | 重写 `SETTINGS_GROUPS`（`:46-201`）；导入表（`:3-27`）换成壳名 + 保留仍直挂的节；新增 `LegacySectionId` / `LEGACY_SECTION_ALIASES` / `resolveActiveSection()`；`:208-210` 的 `useState` 初值改走 `resolveActiveSection`；**`:225` 的 `\|\| SETTINGS_GROUPS[0].sections[0]` 逐字保留**（旧测试钉的就是它）；导航 JSX `:228-281` 不动 |
| `src/renderer/pages/SettingsPage.test.tsx`                      | **只追加**。`:40-67` 两个既有用例一字不改。新增 `describe('合并后的导航结构')`：8 组 17 项计数、4 个新标签存在、被合并的旧导航项不再作为导航项出现（「游戏目录」仍作**块标题**存在，故必须按导航项 role 断言、不能按 text）、10 条旧→新迁移逐一验证 + 迁移后重新落盘的 id 断言                                                      |
| `src/renderer/pages/settings/sections.tsx`                      | **只追加**壳的 re-export。`:6-7` 的 toast/类型出口是 21 个下游的契约，**不得删改或重排**；叶子节导出全部保留                                                                                                                                                                                                                        |
| `src/renderer/pages/settings/scan-sections.tsx`                 | 新增 `ScanDirectoriesSection`；`ScanPathsSection:54-68` 与 `ImportRootsSection:599` 改走 `load/saveCustomScanPaths`；`ScanFallbackSection` 增可选 `onCustomPathsChanged?: () => void`（`:317` 保存后与扫描成功后各调一次）；`ImportRootsSection:604-608` 增 `success:false` 收口                                                    |
| `src/renderer/pages/settings/appearance-sections.tsx`           | 删 `:41-43` 重复 `<p>`；`:199-223` 与 `:242-274` 两处磁贴 → `SegmentedControl`（`onChange` 签名事件→值）；新增 `AppearanceThemeDisplaySection`；**保留 `:71 type GlassEffect` 与 `:73 normalizeGlassEffect` 导出**                                                                                                                  |
| `src/renderer/pages/settings/data-sections.tsx`                 | 新增 `DataCacheClearSection`；7 处 `SettingsCard` 机械替换                                                                                                                                                                                                                                                                          |
| `src/renderer/pages/settings/about-sections.tsx`                | 新增 `AboutOverviewSection`；2 处 `SettingsCard` 机械替换                                                                                                                                                                                                                                                                           |
| `src/renderer/pages/settings/general-sections.tsx`              | `:176-205` → `SettingsCard` + `SliderControl`；`updateSetting` 语义不变                                                                                                                                                                                                                                                             |
| `src/renderer/pages/settings/diagnostics-sections.tsx`          | **仅** 10 处 `SettingsCard` 机械替换，无结构改动                                                                                                                                                                                                                                                                                    |
| `src/renderer/pages/settings/profile-sections.tsx`              | 1 处 `SettingsCard` 机械替换（`:196`）                                                                                                                                                                                                                                                                                              |
| `src/renderer/pages/settings/AppearanceDisplaySection.test.tsx` | 仅机械跟随：`:80,92` `getByRole('button',…)` → `getByRole('radio',…)`。其余 4 案与 5 条 `normalizeGlassEffect` 断言一字不变                                                                                                                                                                                                         |
| `src/renderer/i18n/locales/*.json` ×12                          | 5 个新键 ×12 包 + 62 处空串补齐。zh-CN 取值：工具与插件 / 主题与显示 / 扫描目录 / 缓存与清理 / 应用信息与联系方式。UTF-8 无 BOM、LF、2 空格缩进                                                                                                                                                                                     |

**删除**：无。所有被合并的节都作为块继续存在。`tools-sections.tsx` / `plugin-sections.tsx` 文件不动（只并入同一分组）。

### 6.4 `SettingsCard` 替换的准入判据

`SettingsCard` 是 `p-3 rounded-lg` + 固定 `bg-tertiary` + 追加 `className`，**没有 `style` prop、padding 固定 `p-3`**。因此只替换「内联样式仅 `background: 'var(--bg-tertiary)'`、padding 恰为 `p-3`」的 21 处。不得传冲突 padding（追加 `p-2` 会和自带 `p-3` 撞，胜负取决于 CSS 顺序 = 静默视觉变更）。

不替换并在此列明（换过去就必须给 `SettingsCard` 加 `style`/`size` prop，违反「不扩共享件」）：`about` 391(`p-4`)、421-425、490-492(`px-3 py-2`)、506-509(内联 color)；`data` 217-219(`py-6`)、450-454、466-468(进度条轨道)；`diagnostics` 392、472-475 / 931-934(`py-8`)、496-503 / 626-633(动态 border)、597 / 689(`pre`)；`general` 327(`p-2`)；`profile` 246-255(ring-color)、376-413(`p-2`)、435 / 460(`p-1.5`)。

---

## 七、子任务清单与执行记录（严格 TDD：每节点先观察红灯，再修复，再转绿）

**硬性纪律**：每个回归测试在修复前必须由执行者亲自跑出**失败**并记录失败原文；若修复前就通过，视为测试未覆盖，重写后重跑。每步转绿后立刻重跑设置板块全量，42 项基线不得跌破。

| 节点                                | 红灯（先写、必须先红）                                                                                                                                                                | 绿灯动作                                                                                                                 | 验收命令                                                                                                                        | 状态 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---- |
| **T0 基线冻结**                     | —                                                                                                                                                                                     | —                                                                                                                        | `npx vitest run src/renderer/pages/SettingsPage.test.tsx src/renderer/pages/settings/` → `42 passed`；`npm run i18n:guard` → ✅ | ☐    |
| **T1 导航契约 红**                  | `SettingsPage.test.tsx` 追加 8/17 计数 + 4 个新标签 + 旧导航项消失 + 10 条迁移断言                                                                                                    | —                                                                                                                        | `npx vitest run src/renderer/pages/SettingsPage.test.tsx` → **必须红**（当前 23 项、无新标签、旧 id 全回退默认节）              | ☐    |
| **T2 导航 绿**                      | —                                                                                                                                                                                     | 5 个 zh-CN 新键；重写 `SETTINGS_GROUPS`；`resolveActiveSection` + 别名表；4 个壳；barrel 追加；`SettingsPage.tsx` 导入表 | T1 命令转绿，既有 2 案仍绿                                                                                                      | ☐    |
| **T3 新键 12 包 红→绿**             | `settings-nav-keys.test.ts` 断言 (a)                                                                                                                                                  | 补齐 5 键 ×11 包                                                                                                         | `npx vitest run src/renderer/i18n/locales/settings-nav-keys.test.ts`；`i18n:guard` + `i18n:check` 双 ✅                         | ☐    |
| **T4 空白导航文案 红→绿**           | 同文件断言 (b)：25 个标签 12 包非空 → 跑出 **62 处空** 的精确清单                                                                                                                     | 逐包翻译补齐                                                                                                             | 同上；`i18n:check` 需 missing=0 且 extra=0                                                                                      | ☐    |
| **T5 theme.desc 去重 红→绿**        | `appearance-sections.test.tsx`：`getAllByText(<desc>)` 长度 1 → 当前为 **2**，必须红                                                                                                  | 删 `appearance-sections.tsx:41-43`                                                                                       | `npx vitest run src/renderer/pages/settings/appearance-sections.test.tsx`                                                       | ☐    |
| **T6 磁贴→SegmentedControl 红→绿**  | 新增 `getByRole('radiogroup',{name:'字号'})`、`queryByRole('button',{name:'轻度增强'})` 为 null；`AppearanceDisplaySection.test.tsx:80,92` 改 `radio`（改完即红）                     | 替换两处磁贴；`onChange` 签名事件→值                                                                                     | `npx vitest run .../appearance-sections.test.tsx .../AppearanceDisplaySection.test.tsx .../SegmentedControl.test.tsx`           | ☐    |
| **T7 customScanPaths 归一化 红→绿** | `scan-sections.test.tsx`：种 `['D:\\ok','','   ',42]` → 只渲染 `D:\ok`；裸实现渲染 4 条，必须红                                                                                       | `ScanPathsSection:54-68` + `ImportRootsSection:599` 改走 util                                                            | `npx vitest run .../scan-sections.test.tsx`，且 `ImportRootsSection.test.tsx` 5 案不动仍绿                                      | ☐    |
| **T8 扫描中收口 红→绿**             | `ImportRootsSection.test.tsx` 追加案 (f)：`scanner.start` `mockResolvedValue({success:false,…})` → 期望失败 toast + 按钮恢复 + 后续 `onComplete` 不误报成功。当前不检查返回值，必须红 | `:604-608` 后判 `!result.success` 清 flag                                                                                | 同上，(a)-(e) 一字不变                                                                                                          | ☐    |
| **T9 合页读一致性 红→绿**           | `scan-sections.test.tsx`：渲染 `ScanDirectoriesSection`，走兜底加目录，断言「游戏目录」块随后列出该条 → 必须红                                                                        | `onCustomPathsChanged` + `pathsRev` + `key`                                                                              | 同上                                                                                                                            | ☐    |
| **T10 阈值→SliderControl 红→绿**    | `general-sections.test.tsx`：(a) `fireEvent.keyUp(range)` 后 `settings.set('fileOps.batchThreshold',…)` 被调用（当前只 `onMouseUp` 提交）→ 必须红；(b) 双击值不写入 3                 | 替换为 `SettingsCard`+`SliderControl`，`defaultValue={batchThreshold}` 中和双击复位                                      | `npx vitest run .../general-sections.test.tsx`                                                                                  | ☐    |
| **T11 SettingsCard 全量替换**       | 结构性断言先行取红：各页 `SettingsCard` 根节点计数（按替换后期望值写，对 HEAD 即红）                                                                                                  | 21 处机械替换                                                                                                            | 真闸门：`git diff --stat` 复核——**只允许 className 与 `div`→`SettingsCard` 的行 churn，0 逻辑行变更**                           | ☐    |
| **T12 全局收口**                    | —                                                                                                                                                                                     | —                                                                                                                        | 见第九节全部命令                                                                                                                | ☐    |

### T6 / T10 的两个诚实代价（不隐瞒）

- `SegmentedControl` 的 `SegmentedOption` 只有 `value/label/icon/disabled`，**字号磁贴原本「按该字号自身渲染预览」+「12/14/16/18px 角标」会丢失**。小/标准/大/超四字面自解释，接受此代价并记录。活动态文字色由 `'#fff'` 变 `var(--text-on-accent)`（`SegmentedControl.tsx:107`）——更贴合 `docs/CODING_CONVENTIONS.md` §3，但在 `--text-on-accent ≠ #fff` 的主题上是**可见变化**，属用户已批准的「统一接入设计系统」范围内。
- `SliderControl` 换上去会**顺带修好**键盘值不落库这个潜在缺陷（它的 commit 是 `onPointerUp` + `onKeyUp`），与 T8 并列本次仅有的两处行为修正，须在 T10 用例里钉住。

### 必须全程绿且不许动的

`SettingsPage.test.tsx:40-67`、`settings/shared.test.tsx`(21)、`ScanGameRootsSection.test.tsx`(4)、`ScanFallbackSection.test.tsx`(5)、`ImportRootsSection.test.tsx`(a)-(e)、`components/scanner/ScanProgress.test.tsx` 及 8 个 `vi.mock('./settings/sections')` 套件。唯一被有意编辑的既有测试是 `AppearanceDisplaySection.test.tsx`（仅角色选择器），且该编辑本身就是 T6 的红灯。

### 测试替身补喂（T1 起就要做，否则红得没有意义）

`SettingsPage.test.tsx:31-37` 的 electronAPI stub 只装了 `settings` + `app.relaunch`。`AboutInfoSection:26-33` / `AboutLicenseSection:245-252` 会 `window.electronAPI?.app?.getVersion?.().then(...)`——`getVersion` 缺失即在 mount effect 抛 `TypeError` 崩掉整棵树。必须补 `app.getVersion: async () => '2.5.5'`，按需补 `dialog.selectDirectory`、`scanner.{start,onComplete,detectGameRoots}`、`importRoot.list`、`cache.getStats`。**不要**点进 `plugins-manage`（会驱动 `usePluginStore.loadPlugins` 与 `ErrorBoundary`），只断言其导航标签。

---

## 八、基础测试用例设计（正常 / 异常 / 边界）

**正常**

- 渲染出 8 组 17 项导航；8 个组标题 + 17 个节标题在 12 语言包均非空。
- 4 个合并页各自同屏展示全部块，块标题与合并前一字一致。
- 字号 4 档、玻璃 2 档切换：写设置 + 挂/摘 `html` 类 + toast 文案正确。
- 「扫描目录」页 4 块、`SettingsCard` 计数与结构断言。

**异常**

- 缺 `scanner.detectGameRoots` → 错误卡 + 「重试」，不白屏。
- `scanner.start` 返回 `success:false` → 失败 toast + 按钮恢复 + 后续 `onComplete` **不**误报「已添加」。
- IPC reject → 既有 catch 分支 toast 不回归。
- 缺 `app.getVersion` → 不再 `TypeError`。

**边界**

- 10 个旧 id 逐一迁移到正确新宿主页，且迁移后 `localStorage` 被改写为新 id（否则未来「重新落盘脏 id」的回归看不见）。
- 未识别 id（含既有契约的 `'sync-service'`）→ `general-startup`，不崩、页头仍在。
- `localStorage` 为空 → 默认节。
- `customScanPaths` 64 条上限；混入非字符串/空白时只渲染合法项。
- `batchThresholdEnabled=false` 时 `SliderControl` 不挂载。
- 玻璃 `lite ↔ rich` 往返：两个氛围开关的 disabled 联动随之正确恢复。

---

## 九、全局校验（终止条件，全绿方可结束）

```bash
npx vitest run src/renderer/pages/SettingsPage.test.tsx src/renderer/pages/settings/   # 42 + 新增全绿
npx vitest run src/renderer/i18n/locales/settings-nav-keys.test.ts                     # 绿
npx vitest run src/renderer/components/common/SegmentedControl.test.tsx \
               src/renderer/components/common/SliderControl.test.tsx                    # 绿（未被我方破坏）
npx vitest run src/renderer/components/scanner src/renderer/pages/GalleryPage.test.tsx  # 绿（barrel 波及面）
npm run typecheck     # tsc -b + tsc -p tsconfig.scripts.json（CI 口径；本次未改 scripts/**，仍跑一次）
npm run lint          # eslint .
npm run format:check  # prettier --check --end-of-line auto（本机 core.autocrlf=true，不带此参数会假失败）
npm run i18n:guard && npm run i18n:check
npm run verify        # 允许 [VERIFY] ⚠ 缺套件提示；新建的同名套件会关掉其中 3 个缺口
npm test              # 全量 vitest run
```

- `core-path-gate` 不涉及本次文件（已核实 glob 清单）。
- 覆盖率：`vitest.config.ts:95-100` 只有全局阈值（66/58/59/68）、无 `perFile`，搬家不会触发；新壳会渲染更多块，覆盖率方向是上升。
- 提交用 Conventional Commits：`refactor(settings): 合并导航节与统一设置卡片组件（含 activeSection 迁移映射）`。提交后 `git status --porcelain` 复核 lint-staged 是否改写了文件。
- 技术债登记：`docs/技术债清单.md` 追加一节 + `docs/debt-registry.json` 新增 `DEBT-035`（about 技术栈版本漂移）、`DEBT-036`（settings 内联 rgba/hex，lint §3-a 选择器盲区），并 bump `updatedAt`。

**任何一项未通过，任务不得结束；不得跳过、伪造、注释或弱化任何失败。**

---

## 十、执行记录（2026-10-16 实际落地，逐节点红灯/绿灯原样记录）

### 红灯证据（每步都在改代码之前由执行者亲自跑出失败）

| 节点     | 红灯命令                                                                               | 实测红灯原文（摘要）                                                                                                                                                                                                                                                            | 转绿后                                                                          |
| -------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| T0       | `npx vitest run src/renderer/pages/SettingsPage.test.tsx src/renderer/pages/settings/` | `Test Files 6 passed (6) / Tests 42 passed (42)`；`npm run i18n:guard` → `✅ 守卫通过`                                                                                                                                                                                          | 基线冻结                                                                        |
| T1       | `npx vitest run src/renderer/pages/SettingsPage.test.tsx`                              | `Tests 14 failed \| 2 passed (16)`；`合并后导航项应为 17 个（原 23 个）: expected […] to have a length of 17 but got 23`；`导航项「扫描目录」应存在`；`「主题」已降为块标题，不得再是导航项`；10 条迁移全部 `Expected: "appearance-theme-display" Received: "appearance-theme"` | T2 后 `56 passed`                                                               |
| T2       | —                                                                                      | —                                                                                                                                                                                                                                                                               | 14 红转绿，既有 2 案仍绿                                                        |
| T3/T4    | `npx vitest run src/renderer/i18n/locales/settings-nav-keys.test.ts`                   | `Tests 5 failed \| 1 passed (6)`；`zh-TW.json 缺失 settings.groups.toolsPlugins`；`zh-TW.json settings.sections.scanPaths 不应为空串: expected '' to not have a length of +0`；`settings.groups 键集与 zh-CN 不一致: expected […(6)] to deeply equal […(7)]`                    | `6 passed`；补 55 新键 + 62 空串后 `i18n:guard ✅`、`i18n:check ✅ (3938 keys)` |
| T5/T6    | `npx vitest run .../appearance-sections.test.tsx`                                      | `6 failed`；`expected [ …(2) ] to have a length of 1 but got 2`（theme.desc 重复）；`Unable to find an accessible element with the role "radiogroup" and name "字号大小"`；`Unable to find … role "radio" and name "轻度增强"`                                                  | `18 passed`（含 `SegmentedControl.test.tsx` 7 例未被我方破坏）                  |
| T7/T8/T9 | `npx vitest run .../scan-sections.test.tsx .../ImportRootsSection.test.tsx`            | `4 failed \| 5 passed`；脏数据 `expected [ <button…(4)>…(3) ] to have a length of 1 but got 4`；`Unable to find an element with the text: F:\fallback-picked`；(f) 案 `settingsSet` 未收到失败 toast                                                                            | `18 passed`；`ImportRootsSection.test.tsx` (a)-(e) 一字未动仍绿                 |
| T10/T11  | `npx vitest run .../general-sections.test.tsx .../settings-card-usage.test.ts`         | `9 failed`；`expected "vi.fn()" to be called with arguments: [ 'fileOps.batchThreshold', 25 ] Number of calls: 1`（裸 range 不认 pointerUp/keyUp）；`data-sections.tsx 的 SettingsCard 用量: expected +0 to be 7`                                                               | `general 4 passed`、`card-usage 8 passed`                                       |

### 最终全局校验（实测退出码）

```
npx vitest run settings+locales     → 14 files / 104 passed  (exit 0)
波及面冒烟（复用的 2 个组件 + barrel 6 个消费方）→ 5 files / 67 passed (exit 0)
npm test（全量）                     → 402 files / 6219 passed | 2 skipped / 0 failed (exit 0)
npm run typecheck（含 scripts 面）    → exit 0
npm run lint                        → exit 0，0 error / 11 warning
npm run format:check                → All matched files use Prettier code style! (exit 0)
npm run i18n:guard / i18n:check     → ✅ / ✅ 3938 keys（missing=0 且 extra=0）
npm run verify                      → 5 项, 0 失败（typecheck/lint/core-gate/format/test 全 ✓）
npm run audit                       → Passed npm security audit (exit 0)
npm run debt:check                  → exit 0（3 条涉及本次文件的提醒）
```

lint 的 11 个 warning 全部落在 `src/renderer/components/common/*.test.tsx` 的 `unicode-bom`，
即 DEBT-030 已登记的存量豁免面，本次未触碰其中任何文件。`verify` 的 `core-gate` 通过，
印证第六节判断：设置页文件不在 `PROTECTED_GLOBS` 内。

### 与计划的偏差（逐条交代，不含隐藏改动）

1. **分组数**：合并后为 **8 组 17 节**（原 9/23）。第六节表与此一致；口头沟通阶段我曾误报「7 组」，以本表为准。
2. **`onCustomPathsChanged` 只在保存后调用一次**（计划写的是「保存后与扫描成功后各一次」）。
   理由：写 `customScanPaths` 的唯一位置就是那次保存，扫描成功并不改变该集合；
   多调一次会让两个只读块无谓重挂。
3. **`scan-sections.tsx` 的 SettingsCard 基线是 9 处而非计划里数到的 8 处**，
   守卫阈值按实测 9 设定。21 处替换的总数与分布（about 2 / data 7 / diagnostics 10 / general 1 / profile 1）与 6.4 节完全一致。
4. **T11 的守卫实现为源码扫描测试**（`settings-card-usage.test.ts`），不是 DOM 断言。
   原因：`SettingsCard` 渲染出的正是它取代的那段 `p-3 rounded-lg` + `bg-tertiary`，
   运行时结构完全相同，DOM 层无法区分「复用了组件」和「又手写了一遍」；
   这类机械替换的验收面只在源码。真实闸门 `git diff` 复核已做：
   差异全部是 import、`div`→`SettingsCard`、className 与 prettier 折行，**0 逻辑行变更**。
5. **脚本化替换被放弃**：先写过一次性替换脚本，dry-run 暴露它把
   `diagnostics-sections.tsx:351` 的卡片闭合误配到 360 行之外，同时漏掉 6 处合规站点，
   遂删除脚本、21 处全部手工改并逐个用深度计数核对闭合位置，再由 `tsc -b` 验证 JSX 平衡。
   （附带发现：工作副本里 `diagnostics-sections.tsx` 是 CRLF，`core.autocrlf=true` 所致，
   提交内容仍为 LF，不影响 `--end-of-line auto` 口径。）
6. **`general-sections.test.tsx` 的双击用例**：最初断言写成「双击应以当前值落库」，
   实测失败后确认是我写错了断言对象——传 `defaultValue={当前值}` 后双击是**无副作用的空操作**，
   正确不变量是「不改值、不落库、绝不写成 min=3」。已按真实语义改写并在用例里标注：
   它是新代码的边界守卫，本节点的红灯是 pointerUp / keyUp 两条提交用例。
7. **`npm run verify` 跑不到按组件命名的套件**（计划第三节已预警，此处复现实证）：
   verify 只跑了 40 例 / 6 文件，而非本板块全量 104 例。全部组件命名套件均由执行者显式运行。
   新建的 `appearance-sections.test.tsx` / `scan-sections.test.tsx` / `general-sections.test.tsx`
   已把三个源文件接入 `find-related-tests.ts` 的匹配面——verify 的 `⚠ 缺少匹配套件`
   清单从本轮起不再包含这三个文件。

### 本次顺带修掉的两个真缺陷

- 非用户明确要求，但均由取证确证且已用红灯测试钉住：

1. **`ImportRootsSection` 假阳性成功提示**（第四节 2 / T8）：并发被拒时标记卡死，
   下一次任意扫描完成会被误报成「已添加指定目录」。
2. **批量阈值键盘调整不落库**（T10）：原裸 `range` 只认 `mouseUp`，方向键改值静默丢弃。

### 尚未执行 / 遗留

- **人工 UI 自检（第三节的 10 步）未执行**：本环境无显示会话，未启动 Electron 实机看过设置页。
  结构层面已由测试覆盖（导航 8/17 计数、4 个合并页的块标题、radio/switch 角色与禁用联动、
  迁移后落盘 id），但**视觉与交互手感未经人眼确认**，需按下表手工过一遍。
- 本轮新发现的存量缺陷，登记但未改：
  - `docs/技术债清单.md` 第 14 节 / `docs/debt-registry.json` 的 **DEBT-035**（关于页技术栈版本字符串陈旧）、
    **DEBT-036**（设置页内联 `rgba()`/三元 hex 绕过 §3-a 选择器盲区）。
  - zh-TW 的 `settings.sections.scanDiagnostic` 值是简体「扫描链路诊断」（繁简混排）。
    非空、不阻塞任何闸门，属既有翻译缺陷，与本轮 62 处空串不同类，未顺手改。
  - 更广的翻译空缺面：`settings.plugin.*` 在 9 个语言包里整体为空串。
    本轮只收口导航文案（用户批准的范围），其余空缺需独立一轮。
