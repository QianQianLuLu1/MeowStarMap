# 2026-10-17 未提交变更审查 / 修复 / 提交 / 版本复验 / 重新打包实施计划

- 计划日期：2026-10-17
- 基线提交：`cfdbc5c`（工作区仅余本计划要处理的未提交变更）
- 影响面：`src/renderer/hooks/useWheelPageNav.ts`、`src/renderer/components/gallery/FullscreenViewer.tsx`、两个测试文件、`CHANGELOG.md`、`docs/plans/` 两份文档；打包产物 `release/`

## 一、审查结论（已读源码确证 + 工具交叉验证）

未提交变更为「全屏预览鼠标翻页（滚轮 / 侧键 / 边缘热区）与键盘切换防抖」一套完整实现（原计划见 `docs/plans/2026-10-17-fix-fullscreen-mouse-nav-and-keyboard-jank.md`）。本轮逐项审查后确认 **2 个代码缺陷 + 2 个测试质量问题**，其余维度通过。

### 缺陷清单

| 编号 | 严重度             | 位置                                         | 结论                                                                                                                                                                                                   |
| ---- | ------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1   | 高（用户可见回归） | `FullscreenViewer.tsx:145-150` + `:645-656`  | EXIF 信息浮层的滚轮被全屏根上的 `useWheelPageNav` 监听吞并：浮层无法自行滚动（`preventDefault` 取消默认滚动）且越阈值误翻页。修复前滚轮无监听，属本次改动引入的回归                                    |
| F2   | 中（潜在逻辑错误） | `useWheelPageNav.ts:68,90`                   | 冷却状态机 `lastTriggerRef` 初值 0 语义为「t=0 已触发过一次」；事件 `timeStamp < cooldownMs` 时首次滚动被误吞。本 App 因 `enabled` 门控与 jsdom epoch 时间戳实际不可达，但初始化语义不正确             |
| F3   | 中（测试质量）     | `FullscreenViewer.mouseNav.test.tsx`         | 裸 `dispatchEvent`（wheel helper 与 mousedown 用例）未包 `act()`，运行输出大量 React act 警告                                                                                                          |
| F4   | 低（测试质量）     | `FullscreenViewer.mouseNav.test.tsx:240-247` | 用例名「点击中间背景仍然关闭全屏」名不副实：`fireEvent.click(dialog())` 直派根元素；真实浏览器点击中间背景的命中目标是内层 `w-full h-full` 容器（HEAD 既有 `stopPropagation`），并不会触发根 `onClick` |

### 审查通过项（无需改动）

- 键盘三修复正确：`navigate` 改读 `useUIStore.getState().fullscreenIndex`（依赖收敛为 `[activeFiles.length]`）；五个接管键分支 `preventDefault`；focus effect 收敛为 `[fullscreenOpen]` + `preventScroll: true`。
- 热区层叠正确：热区为 `absolute` 且位于 img（in-flow）之后、工具栏/导航按钮之前 → 绘制于 img 之上但不遮挡既有按钮；点击经内层容器 `stopPropagation` 不触发关闭（测试已验证）。
- 阈值累加 / 冷却 / 单轴优先 / ctrlKey 放行 / 非法参数归一化 / try-catch 静默降级均正确；`@use-gesture/react@10.3.1` 的 `target`/`eventOptions`/`enabled` 配置键已从包内 `GenericOptions` 类型核实合法，target 为对象时返回 void、忽略返回正确。
- 核心路径闸门不涉及（renderer 组件不在保护清单）；依赖按字母序插入，lock 仅新增两包。
- 工具交叉验证：`ocr delegate preview/rule`（workspace 模式）确认可审查面为 `package.json` / `FullscreenViewer.tsx` / `useWheelPageNav.ts` 三文件，按系统规则组（死代码 / Hooks 规则 / null 检查 / 严格相等 / 注释 / 内联样式等）逐条应用后无 F1–F4 之外的新增类别问题。

### 已知残留（本次不修，如实留档）

- 删除确认 `ConfirmDialog`（`BaseDialog` 无 portal，渲染在全屏根内）上的滚轮仍会翻动背后照片——与「对话框打开时方向键仍可翻页」的既有行为同类，且删除后 index 数学有 `Math.min` 兜底不越界。Toast 同理但瞬态。
- 真机手感项（滚轮方向顺滑度、侧键、热区宽度、连按无跳动）仍需 `npm run dev` 人工目视，自动化断言已覆盖行为正确性。

## 二、依赖声明

**无新增、无变更、无删除任何依赖。** 修复全部落在既有文件内：

- 滚轮手势继续复用已入依赖的 `@use-gesture/react@^10.3.1`（未提交变更已 `npm install` 增量安装，`package.json` / `package-lock.json` 随 C1 提交，本轮不再执行安装）。
- 不新增脚本、不新增 i18n key、不改 `vitest.config.ts`。

## 三、启动与运行说明

```bash
# 环境准备（只读校验）
node -v                                        # 需 >= 22.12.0
npm run link:nikkisync:check                   # 四链 junction 必须全 OK（npm install 会剪链，装依赖后必须复验）

# TDD 红灯（修复前必失败）
npx vitest run src/renderer/components/gallery/FullscreenViewer.mouseNav.test.tsx   # F1 新增用例红
npx vitest run src/renderer/hooks/useWheelPageNav.test.ts                            # F1/F2 新增用例红

# 修复后绿灯
npx vitest run src/renderer/hooks/useWheelPageNav.test.ts src/renderer/components/gallery

# 变更后只读闸门
npm run verify

# 全局回归
npm test
npm run lint
npm run typecheck

# 版本闸门（打包前）
npx tsx scripts/check-changelog-release.ts
npx tsx scripts/check-doc-versions.ts

# 重新打包
npm run dist:win
npm run verify:nikkisync
npm run e2e:smoke
```

## 四、错误处理与兜底

| 异常分支                                                                        | 兜底策略                                                                                                                    | 可观测结果                                           |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `ignoreSelector` 传了非法选择器（`closest` 抛 `SyntaxError`）                   | 既有 handler 级 `try/catch` 静默吞掉，且位于 `preventDefault` 之前                                                          | 降级为「该次滚动不翻页」，不影响关闭 / 删除 / 幻灯片 |
| `ignoreSelector` 非字符串 / 空串                                                | 归一化为不启用，行为与本轮之前完全一致                                                                                      | 无行为变化                                           |
| EXIF 内联面板在最小 fixture 下无关崩溃                                          | 充实测试 fixture 字段复现真实数据形态，**禁止 mock 被测链路凑绿**                                                           | 测试反映真实渲染                                     |
| Safe-Delete 网关拦截 `npm run build` 清 `dist/main`（862 项 > 500）             | 先 `Move-Item dist/main` 至 `.tmp/`，再 `npx electron-vite build`，并手写 `dist/main/package.json` 为 `{"type":"commonjs"}` | 构建继续，旧产物留证                                 |
| Safe-Delete 网关拦截 electron-builder 解包时删 `release/win-unpacked`（753 项） | `Move-Item release\win-unpacked` 至 `.tmp/` 后重跑 builder                                                                  | 打包继续                                             |
| pre-commit 钩子改写文件                                                         | 提交后 `git status --porcelain` 核对仅格式层（eslint --fix / prettier --write）                                             | 非格式改动即回审查阶段                               |
| `zip-archive.test.ts`（`restore-failed`）全量复现                               | 记录为既有 flake（主进程归档用例，与渲染层改动无关）                                                                        | 不作为本轮回归失败                                   |

日志规范：renderer 侧 eslint 禁 `console`、禁 `throw new Error`，非破坏性失败一律静默降级，不新增日志面。

## 五、参数校验（唯一新增接口）

`useWheelPageNav` 新增**一个可选字段**，完全向后兼容：

```ts
export interface UseWheelPageNavOptions {
  enabled: boolean
  target: RefObject<HTMLElement | null>
  onPrev: () => void
  onNext: () => void
  threshold?: number // 既有：非有限数 / ≤0 回落 60
  cooldownMs?: number // 既有：非有限数 / <0 回落 220
  ignoreSelector?: string // 新增：事件目标命中其后代时整条放行
}
```

| 入参                       | 类型                  | 必填 | 校验与非法值处理                                                                                           |
| -------------------------- | --------------------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| `ignoreSelector`           | `string \| undefined` | 否   | 仅非空字符串启用；`undefined` / 空串 / 非字符串 → 不启用，handler 行为与本轮之前逐字节一致                 |
| 事件目标                   | `EventTarget`         | —    | 仅当 `target instanceof Element` 才做 `closest()` 判定；非 Element（如 document）不命中、不放行            |
| 放行时机                   | —                     | —    | 判定置于 `ctrlKey` 分支与 `event.preventDefault()` **之前**：命中即 `return`，既不阻止默认滚动也不累计位移 |
| `threshold` / `cooldownMs` | 既有                  | 否   | 维持既有归一化，不改语义                                                                                   |
| F2 修复                    | —                     | —    | `lastTriggerRef` 初值 `0` → `Number.NEGATIVE_INFINITY`（「从未触发」），一处比较恒不成立，消除首事件误吞   |

## 六、基础测试用例（正常 / 异常 / 边界）

### 正常路径

1. F1 组件集成：打开 EXIF 信息浮层后在其上派发 `WheelEvent`（`deltaY: 300`）→ `fullscreenIndex` 不变且 `event.defaultPrevented === false`（修复前 index 1→2 且 defaultPrevented=true → 红灯）。
2. F1 hook 单测：`ignoreSelector` 命中（子节点携带属性、事件派发在子节点）→ `onPrev`/`onNext` 0 次且 defaultPrevented=false。
3. F2 hook 单测：事件 `timeStamp` 覆写为 50（< 冷却 220ms）且位移越阈值 → `onNext` 1 次（修复前被吞 → 红灯）。
4. 回归：既有 38 项新测试（13 hook + 16 鼠标 + 9 键盘）与 FullscreenViewer 既有四套件保持全绿。

### 异常路径

5. `ignoreSelector` 缺省时全部既有行为不变（既有 13 项 hook 用例即守卫）。
6. 非法选择器致 `closest` 抛错 → handler try/catch 吞掉，不冒泡到 React 树（以代码走查 + 既有降级守卫覆盖，不伪造用例）。
7. 全屏关闭态 / `enabled=false` / target 未挂载 → 零响应（既有用例守卫）。

### 边界条件

8. 冷却窗口内连发仍只翻一张；冷却结束后可再翻（既有用例守卫，F2 不得破坏）。
9. `ctrlKey`（捏合缩放）仍放行且不阻止默认；横向 delta 优先；首/末张不越界（既有用例守卫）。
10. 信息浮层打开/关闭反复切换后放行判定仍生效（无状态实现，天然成立；以组件用例覆盖一次开→滚→关→开→滚序列）。

## 七、子任务与验收标准（TDD 红 → 改 → 绿）

> 硬性要求：每个新增用例先运行确认为红灯，再落地修复；修复前就通过的用例必须重写。

### T0 · 审查与计划落盘

- **涉及文件**：`docs/plans/2026-10-17-uncommitted-review-commit-2.5.5-repack.md`（本文件）。
- **输入 / 输出**：输入 = 工作区未提交变更全集；输出 = 本计划 + F1–F4 缺陷清单 + 审查通过项。
- **验收标准**：三个新测试文件实测 38 项全绿（已取证）；`ocr delegate preview/rule` 交叉验证完成；`git status --porcelain` 与计划列举的 8 个条目一致。

### T1 · F1 修复：EXIF 浮层滚轮归属（红灯 → 绿灯）

- **涉及文件**：
  - `src/renderer/components/gallery/FullscreenViewer.mouseNav.test.tsx`（+组件集成用例）
  - `src/renderer/hooks/useWheelPageNav.test.ts`（+hook 放行用例）
  - `src/renderer/hooks/useWheelPageNav.ts`（+`ignoreSelector` 政策出口 + 注释）
  - `src/renderer/components/gallery/FullscreenViewer.tsx`（EXIF 浮层 div 加 `data-wheel-ignore` 与 `data-fullscreen-info-panel`；向 hook 传 `ignoreSelector: '[data-wheel-ignore]'`）
- **输入 / 输出**：输入 = 选项对象（新增可选 `ignoreSelector`）与 wheel 事件；输出 = 命中放行（不 preventDefault、不翻页），未命中行为不变。
- **验收标准**：新增组件用例修复前**红**（index 变化 + defaultPrevented=true）；修复后**绿**；hook 新增用例先红后绿；既有 38 项不转红。

### T2 · F2 修复 + F3/F4 测试质量整改（红灯 → 绿灯）

- **涉及文件**：
  - `src/renderer/hooks/useWheelPageNav.ts`（`lastTriggerRef` 初值改 `Number.NEGATIVE_INFINITY`）
  - `src/renderer/hooks/useWheelPageNav.test.ts`（+timeStamp=50 首事件用例）
  - `src/renderer/components/gallery/FullscreenViewer.mouseNav.test.tsx`（wheel helper 与裸 mousedown 派发包 `act()`；更名 F4 用例并补注真实语义）
- **输入 / 输出**：输入 = 小 timeStamp 的首事件；输出 = 正常受理翻页；测试运行无 act 警告。
- **验收标准**：F2 用例修复前**红**（`onNext` 0 次）、修复后**绿**；运行 mouseNav 套件 stderr 无 `not wrapped in act` 警告；更名后用例语义与注释一致。

### T3 · 局部回归与只读闸门

- **涉及文件**：无（只读验证）。
- **输入 / 输出**：输入 = T1/T2 后的工作区；输出 = 全绿证据。
- **验收标准**：`npx vitest run src/renderer/hooks/useWheelPageNav.test.ts src/renderer/components/gallery` 全绿；`npm run verify` 5 项（typecheck / lint / core-gate / format / test）全绿。

### T4 · 全局回归

- **涉及文件**：无（只读验证）。
- **输入 / 输出**：输入 = 全部变更；输出 = 与基线对比的回归报告。
- **验收标准**：`npm test` 全量通过（基线 405 files / 6257 passed / 2 skipped，本轮预期 407 files、+4 用例，skipped 维持 2，无新增失败；`zip-archive.test.ts` flake 复现则记录为既有失败）；`npm run lint` 0 error；`npm run typecheck` 退出码 0。

### T5 · 版本识别、CHANGELOG 与三笔提交

- **涉及文件**：`CHANGELOG.md`（仅向 `[2.5.5-beta]` 节内追加 dated addenda 与 Fixed 条目，不改既有条目）；`package.json` / `package-lock.json` / 全部 `src/**` / 两份计划文档（提交面）。
- **输入 / 输出**：输入 = 已验证工作区；输出 = C1 / C2 / C3 三笔 commit。
- **验收标准**：
  1. `node -e` 复验 `package.json` / lock 顶层 / lock `packages[""]` 三处 version 均为 `2.5.5-beta`；`database-mock.ts:664` 同为 `2.5.5-beta`；`git grep "2\.5\.5"` 残留逐条落在「明确不动」清单（`SettingsPage.test.tsx:39` 测试桩、`verify-nikkisync-link.ts:236` 注释、`docs/plans/*`、`docs/sync-integration/*`）。
  2. `check-changelog-release.ts` + `check-doc-versions.ts` 双绿；CHANGELOG 中 `[2.5.5]` 字面不存在、`[2.5.5-beta]` 唯一。
  3. C1 = `fix(gallery): …`（代码 + 测试 + 依赖，git show --stat 核对文件集）；C2 = `chore(release): …`（CHANGELOG）；C3 = `docs(plans): …`（两份计划文档）。commitlint 三笔均过；每笔后 `git status --porcelain` 仅剩后续笔次应含文件；末笔后工作树干净。

### T6 · 重新打包与产物校验

- **涉及文件**：无仓库文件改动；产物落 `release/`。
- **输入 / 输出**：输入 = T5 提交后的干净工作区；输出 = 新安装包 + 校验证据。
- **验收标准**：`npm run dist:win` 退出码 0（Safe-Delete 两命中点按预案 Move-Item 并留证）；`verify:dist` 全 ✔；`verify:nikkisync` blocking failures 0；`release/NikkiGallery-Setup-2.5.5-beta.exe` mtime 晚于 C2 提交时间；`latest.yml` 的 version/size/sha512 与新 exe 逐项一致；`npm run e2e:smoke` 退出码 0（含打包态 `app.getVersion` 与 package.json 一致断言）。

## 八、范围边界（明确不做）

- 不改 `uiStore` open/close 语义、不改 `view-transition.ts`、不动「缩略图先行」首图策略（`FullscreenViewer.transition.test.tsx` 已锁定）。
- 不修 ConfirmDialog / Toast 上的滚轮残留（见 §一已知残留，同类既有行为）。
- 不改背景点击关闭的既有行为（HEAD 起内层容器即 stopPropagation，非本次引入）。
- 不顺手重构、格式化无关文件、不新增 i18n key、不动覆盖率阈值。

## 九、执行记录

| 节点           | 状态   | 关键产出 / 证据                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0             | 完成   | `ocr delegate preview/rule` 交叉验证（workspace 模式，3 个可审查文件：package.json / FullscreenViewer.tsx / useWheelPageNav.ts；按系统规则组逐条应用后无 F1–F4 之外的新增类别问题）；本计划落盘；三个新测试文件实测 38 项全绿                                                                                                                                                                                                                              |
| T1（F1）       | 完成   | 红灯证据：组件用例「浮层上的滚轮不得翻动背后照片: expected 2 to be 1」、hook 用例「命中放行选择器不得翻页: called 1 times」。修复：hook 新增 `ignoreSelector` 政策出口（置于 ctrlKey 与 preventDefault 之前）+ 浮层 `data-wheel-ignore`。绿灯：hook 16/16、mouseNav 18/18。过程修正两处：测试辅助 `mount()` 漏转发 `ignoreSelector`（补转发后绿）；EXIF 边界桩改用永挂起 Promise（`getExif` resolve 会令 ExifPanel 异步 setState 落到 act 之外产生新警告） |
| T2（F2/F3/F4） | 完成   | F2 红灯「首次滚动不得被冷却初值吞掉: got 0 times」→ `lastTriggerRef` 初值改 `Number.NEGATIVE_INFINITY` → 16/16 绿。F3：mouseNav wheel helper / 裸 mousedown / keyboardNav `press()` 全部包 `act()` → 三个套件 stderr 无 act 警告（F3 范围按「同类问题同批整改」扩大到 keyboardNav.test.tsx）。F4：更名「回归：根层点击仍触发关闭（热区接线不得影响 root onClick）」并补注真实语义                                                                          |
| T3             | 完成   | 局部回归 18 文件 / 196 用例全绿。`npm run verify` 首跑 typecheck 红：`mouseNav.test.tsx(282,24) TS2304 Cannot find name 'vi'`（新 describe 用 `vi.fn` 未导入；eslint no-undef 对 TS 关闭故只有 tsc 能抓）→ 补导入后 5 项全绿                                                                                                                                                                                                                               |
| T4             | 完成   | 全量 `npm test`：405 文件 / **6262 通过 / 2 跳过 / 0 失败**（基线 6257 + 本轮新增 5 用例 = 6262，精确吻合；`zip-archive.test.ts` flake 未复现）。`npm run lint` 0 error / 11 warning（全部为既有测试文件 Unicode BOM，与基线记录一致）。`npm run typecheck` exit 0。`link:nikkisync:check` 四链 OK                                                                                                                                                         |
| T5             | 完成   | `node -e` 复验三处 version 均 `2.5.5-beta`；`git grep` 非 beta 残留逐条落在「明确不动」清单；CHANGELOG `[2.5.5-beta]` 节追加 dated addenda + Fixed 条目（既有条目未动）；`check-changelog-release` / `check-doc-versions` 双绿。C1 = `3f568e6`（7 文件，pre-commit 三步 + commitlint 全过，仅 1 条 body 行宽 warning）、C2 = `4644d77`（CHANGELOG）                                                                                                        |
| T6             | 进行中 | 打包与产物校验见下笔回填                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### 执行偏离与备忘（如实留档）

1. **F3 整改范围扩大**：计划只列 mouseNav.test.tsx，执行中发现 keyboardNav.test.tsx 的 `press()` 辅助存在同类 act 警告，按「将错误消灭在当下」同批整改（同文件集、同类问题、零行为变更）。
2. **PowerShell 提交消息传输坑（两次失败后定型））**：`Set-Content -Encoding utf8` 在 Windows PowerShell 5.1 下写**带 BOM** 文件，commitlint 解析 header 首行失败（报「不符合 Conventional Commits」）；here-string 直接传 `-m` 会被 PowerShell 拆成多个参数（git 报 `unknown switch`）。定型做法：消息文本避开双引号字符 + 反引号 `n 换行拼接 + `[System.IO.File]::WriteAllText(path, msg, UTF8Encoding($false))`无 BOM 写入 +`git commit -F`。后续提交沿用。
3. **verify 首跑暴露的 TS2304**：新测试代码用 `vi.fn()` 未导入 `vi`——vitest 用 esbuild 转译不做类型检查所以测试照跑，只有 `tsc -b` 能抓；印证「verify 闸门必须先于提交」的价值。
4. **测试边界桩口径**：`window.electronAPI` 是 IPC 进程边界，为其补 `file.getExif` 最小桩属合法边界 mock（未 mock 任何被测链路）；永挂起 Promise 的选择是为了不让 ExifPanel 的异步 setState 产生 act 警告，非为凑绿掩盖行为。
5. **T6 待办**：`npm run dist:win` 全链 + Safe-Delete 两命中点预案 + `verify:dist` / `verify:nikkisync` / `e2e:smoke`；完成后以 `docs(plans): 回填 …` 单独一笔回填本节 T6 行。
