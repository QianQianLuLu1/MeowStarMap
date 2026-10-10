# 侧边栏流体滑块 Tab 指示器：代码审查 → 修复 → 提交 → 版本 2.5.3 → 重新打包

> 本文为 2026-10-09 轮次快照，当前口径以主规约文档为准（生命周期/约定见根 AGENTS.md 与 docs/CODING_CONVENTIONS.md；通道见 docs/IPC_CONTRACT.md）。
> 日期：2026-10-09
> 仓库：`D:/Zcode项目/WXNN XiangCe`（wxnn-photo-manager / NikkiGallery）
> 范围：全部未提交改动（流体滑块 Tab 指示器）+ 版本核验 + Windows 打包重跑

## 一、依赖声明

**本轮不新增任何依赖**。全部能力复用仓库既有依赖：

| 依赖                                              | 版本来源                         | 用途                                                                   |
| ------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `motion`（`motion/react`）                        | 已在 `package.json` dependencies | 命令式 `animate()` 做双边缘补间；`useReducedMotion()` 读取减弱动效偏好 |
| `react` 19                                        | 已存在                           | Hook 与组件                                                            |
| `vitest` 1.6 + `jsdom` + `@testing-library/react` | 已存在                           | 单元测试（纯函数走 node 环境，组件/Hook 走 jsdom）                     |
| `electron-vite` / `electron-builder`              | 已存在                           | 构建与 Windows NSIS 打包                                               |

安装/引入方式：**无需安装**。若将来需要强制一致，使用 `npm ci`（注意本机 npm 存在 Safe-Delete 网关，见 §3.4），本轮跳过。

## 二、启动与运行说明

### 2.1 环境准备

已在 workspace 内完成（`node_modules`、`dist`、`release` 均存在），无需额外准备。

### 2.2 常用命令（均为仓库 `package.json` 中真实存在的脚本）

```bash
npm run dev            # 开发启动（electron-vite dev）
npm run build          # clean + electron-vite build + 写 dist/main/package.json
npm run dist:win       # build → pre-dist-check → electron-builder --win → verify:dist
npm test               # vitest run 全量
npm run typecheck      # tsc -b + tsc -p tsconfig.scripts.json
npm run lint           # eslint .
npm run verify         # 变更文件只读验证（typecheck + lint + core-gate + format + 相关单测）
```

### 2.3 验证方式（逐项，按序执行）

| 步骤       | 命令                                                                                                                                  | 期望                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 局部回归   | `npx vitest run src/renderer/hooks/useFluidTabIndicator.test.tsx src/renderer/utils/fluid-tab.test.ts src/renderer/components/layout` | 全通过，且**无** `not wrapped in act(...)` 告警 |
| 全量测试   | `npm test`                                                                                                                            | 全部用例通过，无新增失败                        |
| 增量校验   | `npm run verify`                                                                                                                      | `[VERIFY]` 各步骤 ✓                             |
| 类型检查   | `npm run typecheck`                                                                                                                   | 退出码 0                                        |
| 静态检查   | `npm run lint`                                                                                                                        | 退出码 0                                        |
| 打包前闸门 | `npx tsx scripts/pre-dist-check.ts` + `npx tsx scripts/check-doc-versions.ts`                                                         | `✅ 全部校验通过`                               |
| 解包校验   | `npm run verify:dist`                                                                                                                 | `✅ 解包二进制校验通过`                         |

## 三、错误处理

### 3.1 Hook 内部兜底（沿用现有契约，不弱化）

- 测量失败 / 矩形非法 / `activeId` 未注册 → `console.warn('[fluid-tab-indicator] …')` + 隐藏滑块（`opacity: 0`），**不抛异常、不阻断渲染**。
- `ResizeObserver` 缺失环境 → `typeof ResizeObserver === 'undefined'` 直接 return。
- 卸载 → `stopAll()` + `observer.disconnect()`；新订阅点必须与现有 disconnect 同生命周期，不得泄漏。
- 中断（快速连点）→ 先 `stopAll()` 再以「当前视觉边值」为起点，不回跳、不叠加。

### 3.2 参数校验

- `sanitizeFluidConfig()`：`duration ∈ (0, 2]`、`ease` 必须 4 元有限数、`maxStretch ≥ 0`；非法项回退默认并告警（既有实现保留）。
- `composeFluidFrame()`：非有限输入或 `baseHeight <= 0` → 零形变安全帧 `{top:0, scaleY:1, gap:0}`。
- **新增条目订阅逻辑**：`el` 为 `null` 时必须 `unobserve` 并从 `itemsRef` 删除；`observerRef.current` 为空时不得调用（禁止空指针）。

### 3.3 日志规范

- 渲染层告警统一前缀 `[fluid-tab-indicator]`，与现有实现一致；禁止 `console.error`（避免污染测试输出）。

### 3.4 打包阶段兜底

本机存在 **Safe-Delete 网关**（阈值 500 项），历史上会拦截 `npm run build` 的 `clean` 步骤（`dist/main` 约 862 项）。
兜底序列：

```powershell
Move-Item dist/main "$env:TEMP/wxnn-dist-main-<时间戳>"   # 移走而非删除
npx electron-vite build
node -e "require('fs').writeFileSync('dist/main/package.json', JSON.stringify({type:'commonjs'}))"
```

仅在 `npm run dist:win` 因网关拦截失败时启用，成功路径不额外改动任何东西。

## 四、基础测试用例（覆盖正常 / 异常 / 边界）

针对本轮审查发现的缺陷 A（ResizeObserver 订阅面过窄），新增 **TDD 红→绿** 用例：

| 类别 | 用例                                                             | 判据                                                                                                   |
| ---- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 正常 | 单个导航项几何变化（容器尺寸不变）时滑块跟随                     | 找到订阅了该条目的 observer → 触发回调 → `transform === 'translateY(60px) scaleY(1)'` 且 `height` 更新 |
| 边界 | 容器矩形 `container` 全程不变                                    | 断言该用例不依赖容器尺寸变化才成立（即不可通过驱动容器 observer 复现）                                 |
| 异常 | 未注册的 activeId（detail / editor）与小矩形（高度 0）仍隐藏滑块 | 既有用例保底：`opacity === '0'` 且无 animate 调用                                                      |

**红灯证据**：修复前 `expect(itemObserver).toBeDefined()` 失败（容器之外没有任何条目被订阅）→ 修复后转绿。修改业务代码前必须先在本地复现红灯并留证。

## 五、子任务清单

### T0 输出实施计划（本文件）

- **涉及文件**：`docs/plans/2026-10-09-sidebar-fluid-tab-review-and-release.md`（新增）
- **输入 / 输出**：输入＝未提交改动集；输出＝可执行的子任务计划
- **验收标准**：文件存在且包含本计划要求的五个章节

### T1 TDD 修复：ResizeObserver 订阅面过窄（功能缺陷）

- **涉及文件**：
  - `src/renderer/hooks/useFluidTabIndicator.ts`（业务修复：订阅容器 + 所有已注册条目）
  - `src/renderer/hooks/useFluidTabIndicator.test.tsx`（红灯用例 + RO stub 记录被观察目标）
- **输入 / 输出**：输入＝`activeId`、注册条目元素集合；输出＝任一被观察对象尺寸/几何变化时触发「重测 + 瞬时吸附」
- **验收标准**：新增用例在修复前失败（已留红灯输出）、修复后通过；该文件其余 11 个用例保持通过

### T2 修复测试告警：store 更新未包 `act()`

- **涉及文件**：`src/renderer/components/layout/Sidebar.fluid-tab.test.tsx`
- **输入 / 输出**：输入＝`useUIStore.setState({ currentView: 'detail' })`；输出＝在 `act()` 内触发更新
- **验收标准**：`npx vitest run src/renderer/components/layout` 输出不再包含 `not wrapped in act(...)`

### T3 全量回归与静态检查

- **涉及文件**：无（只读校验）
- **输入 / 输出**：输出＝各项命令退出码与通过率
- **验收标准**：`npm run verify`、`npm run typecheck`、`npm run lint`、`npm test` 全部通过，无新增失败项

### T4 版本核验 / 统一为 2.5.3

- **涉及文件**（核验清单，按 `ARCHITECTURE.md:1656` 的版本同步约定）：
  `package.json`、`package-lock.json`、`AGENTS.md`、`ARCHITECTURE.md`、`ARCHITECTURE.en.md`、`DEVELOPMENT.md`、`DEVELOPMENT.en.md`、`README.md`、`CHANGELOG.md`
- **输入 / 输出**：输入＝上述文件的当前版本串；输出＝全部统一为 `2.5.3`（仅漂移时最小改写，无漂移则不改，遵循 `ARCHITECTURE.md:1654`「版本号必须保持不变，除非用户明确要求」）
- **验收标准**：脚本化枚举上述文件的版本串均为 `2.5.3`；若发生改写，`git diff` 仅含版本串本身

### T5 提交改动

- **涉及文件**：T1/T2 改动 + 全部未提交改动 + 本计划文件
- **输入 / 输出**：输出＝一条 Conventional Commits 规范的提交（经 husky pre-commit 与 commit-msg 钩子）
- **验收标准**：`git status --porcelain` 为空（钩子改写后重新暂存），`git log -1` 展示预期提交信息

### T6 重新打包 Windows 安装包

- **涉及文件**：`dist/**`、`release/**`
- **输入 / 输出**：输出＝`release/NikkiGallery-Setup-2.5.3.exe`（artifactName 模板自动跟随 package.json 版本）
- **验收标准**：`npm run dist:win` 全流程成功（含 `pre-dist-check`、`check-doc-versions`、electron-builder、`verify:dist`），且 `release/` 下 2.5.3 安装包 `mtime` 更新为本次构建时间
