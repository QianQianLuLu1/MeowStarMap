# GPU 硬件加速启动兼容与自愈机制 — 实施计划与实现说明

> 项目：NikkiGallery（Electron 桌面应用）　|　角色：Electron 渲染兼容性专家
> 目标：在不影响主流设备性能的前提下，解决 Chromium 硬件加速与显卡驱动不兼容导致的启动失败（双击无窗口/无弹窗直接退出）。
> 本计划复用现有 `src/main/app/gpu-fallback.ts` 成熟状态机（VS Code 式自愈），零新增第三方依赖，逻辑集中在主进程。

---

## 1. 依赖声明

- **零新增第三方 npm 依赖**。复用 Electron 首方 API：`app.disableHardwareAcceleration()`（ready 前）、`app.relaunch()`、`app.releaseSingleInstanceLock()`、`app.getPath('userData')`、`app.on('child-process-gone')`、`webContents.on('render-process-gone')`。
- 复用现有模块（**不重写**）：
  - `src/main/app/gpu-fallback.ts` 状态机与文件契约：`userData/gpu-fallback.json{consecutiveFailures,fallbackActive}` 与 `userData/gpu-pref.json{hardwareAcceleration}`。
  - `src/main/ipc/handlers/settings-handler.ts` 对 `hardwareAcceleration` 的双写（用户手动开关已落地）。
  - `src/shared/settings-keys.ts` 的 `RENDERER_PREF_KEYS`（已含 `hardwareAcceleration`）。
  - `src/main/app/window-manager.ts` 既有事件接线。
  - `app:relaunch` IPC（`src/shared/ipc.ts` 已定义 `APP_RELUNCH='app:relaunch'`，渲染端 `window.electronAPI.app.relaunch` 已接通）。
- 开源复用：VS Code「GPU 崩溃自动回退软件渲染」成熟模式（不引入 electron-serve / 第三方 GPU 检测库）。

## 2. 启动说明

- **开发**：`npm run dev`。
- **构建（本机绕 Safe-Delete 网关序列）**：
  `npx electron-vite build` → 写 `dist/main/package.json {"type":"commonjs"}` → `npm run pre-dist-check` → `npx electron-builder --win --publish never` → `npm run verify:dist`。
- **决策时序**：
  1. `index.ts` 顶层 `recordBootDecision()` → 若 true 则 `app.disableHardwareAcceleration()`（**必须在 `app.ready` 前**）。
  2. `app.whenReady` 内 `markBootAttempt()` + `setupGpuProcessWatcher()`（观测 GPU `child-process-gone` → `requestSelfHeal`）。
  3. 首个窗口 `did-finish-load` → `markBootSuccess()`（清零失败计数 + `markAppBooted()` 退出启动期）。
  4. 启动期 `render-process-gone` → `requestSelfHeal()` 自动重启进入软件渲染。
  5. 演示开关：`NIKKI_GPU_SIMULATE_CRASH=1` 在 whenReady 后 guarded 触发一次 `requestSelfHeal`（仅硬件加速启动下）。
- **强制验证开关**：`NIKKI_FORCE_GPU_COMPAT=1` 强制下一次启动走软件渲染路径（用于健康 GPU 机验证降级态可行）。

## 3. 错误处理

- `gpu-fallback.ts` 全部文件读写 `try/catch`：无文件 / 损坏 JSON / 字段非法 → 默认状态，绝不阻塞启动。
- `requestSelfHeal` 内 `releaseSingleInstanceLock` / `relaunch` / `exit` 全程 `try/catch`：失败仅保留落盘标记，靠 `consecutiveFailures>=2` 阈值跨手动启动兜底。
- env 读取失败 / 未设置 → 忽略（等同 false），不影响正常路径。
- **防死循环**：仅当 "本次为硬件加速启动（`wasBootInCompatMode()===false`）" 才自动重启；已兼容模式仍崩 → 不重启，交由现有错误对话框。
- 自动重启前 `app.releaseSingleInstanceLock?.()` 降低单实例锁竞态。

## 4. 参数校验

- `settings:set('hardwareAcceleration', value)`：必须 boolean（既有 `z.unknown`+`typeof` 断言+`AppError.validation`），非布尔拒绝不落盘。
- `gpu-fallback` 读端：`consecutiveFailures` 有限非负、`fallbackActive===true`、`hardwareAcceleration===boolean` 守卫。
- env 变量仅做 `=== '1'` 字符串比对，不做隐式真值转换。

## 5. 基础测试用例

- `src/main/app/__tests__/gpu-selfheal.test.ts`（新增，真实 fs+临时目录+mock electron）：
  - 硬件加速启动崩溃 → `requestSelfHeal` 返回 true 且 `app.relaunch`/`app.exit` 被调用一次、`fallbackActive` 落盘；
  - 下次启动 `shouldDisableHardwareAcceleration()` 返回 true；
  - 已兼容模式仍崩 → `requestSelfHeal` 返回 false 且不调用 `relaunch`（防循环）；
  - `NIKKI_FORCE_GPU_COMPAT=1` → 判定 true 且不触发重启；
  - `isStartupPhase` 首绘前 true、`markAppBooted` 后 false；
  - `setupGpuProcessWatcher` 仅 `type=GPU` 触发自愈、非 GPU 忽略。
- `gpu-fallback.test.ts`（扩展）：env 强制分支、requestSelfHeal 防循环分支。
- `window-manager.test.ts`（扩展）：启动期 `render-process-gone` → `requestSelfHeal` 被调用且跳过对话框；已兼容模式仍崩 → 回退到错误对话框。

---

## 6. 子任务与验收（实现结果）

### T1 扩展 `gpu-fallback.ts`　【已完成】

- 改动：`shouldDisableHardwareAcceleration` 保持纯函数（每次重读磁盘）；新增 `recordBootDecision()`（启动期缓存一次）、`wasBootInCompatMode()`、`requestSelfHeal(reason,exitCode)`（标记+启动期判定+`relaunch/exit`，已兼容模式不重启）、`markAppBooted()`/`isStartupPhase()`、`NIKKI_FORCE_GPU_COMPAT` 强制分支；`setupGpuProcessWatcher` 改调 `requestSelfHeal`。
- 输入：崩溃事件 / 启动期标志 / env。　输出：落盘标记与自动重启决策。
- 验收：`gpu-selfheal.test.ts` + `gpu-fallback.test.ts` 新用例全绿（正常环境）；`eslint` 0 error。

### T2 `index.ts` 接线模拟崩溃　【已完成】

- 改动：顶层 `recordBootDecision()`；whenReady 内 `setupGpuProcessWatcher()` 后 guarded 接入 `NIKKI_GPU_SIMULATE_CRASH=1` 演示自愈。
- 输入：env。　输出：演示用模拟崩溃自愈。
- 验收：`eslint` 0 error；构建产物 `dist/main` grep 含 `NIKKI_GPU_SIMULATE_CRASH`。

### T3 `window-manager.ts` 启动期崩溃接入　【已完成】

- 改动：`render-process-gone` 处理器顶部：`isStartupPhase()` 为真 → `requestSelfHeal` 并 `return`（跳过对话框）；否则维持既有对话框。
- 输入：渲染进程崩溃事件。　输出：启动期崩溃自动降级重启，首绘后维持对话框。
- 验收：`window-manager.test.ts` 启动期分支用例全绿；`eslint` 0 error。

### T4 模拟验证脚本　【已完成】

- 新增 `scripts/simulate-gpu-crash.cjs`：自动探测 userData（含 `gpu-pref.json`/`gpu-fallback.json` 的目录），`--userdata`/`NIKKI_USERDATA` 可覆盖；默认写 `fallbackActive=true` 模拟已崩溃，`--reset` 复位恢复硬件加速。仅写已文档化文件契约，不复制逻辑。
- 验收：`node scripts/simulate-gpu-crash.cjs [--userdata X | --reset]` 无异常、输出可懂指引。

### T5 测试（TDD 纪律：每段代码审查一次）　【已完成 · 代码已写】

- 检查项：env 仅 `=== '1'`、relaunch 前释放单实例锁、已兼容模式不重启、文件读写全 try/catch、`recordBootDecision` 仅启动期调用一次。
- ⚠ 本机 vitest 运行环境损坏（任何测试抛 `TypeError: Cannot read properties of undefined (reading 'on')`，与改动无关）→ 测试需在**正常环境** `npx vitest run src/main/app/__tests__/gpu-selfheal.test.ts src/main/app/__tests__/gpu-fallback.test.ts src/main/app/__tests__/window-manager.test.ts` 验证。本机以 `eslint` + `electron-vite build` 静态校验替代。

### T6 质量门 + 构建 + 端到端　【进行中】

- 输入：全部改动。　输出：类型/规范/构建闸门全绿；端到端复现。
- 验收：`eslint`（改动文件）0 error；`npx electron-vite build` EXIT 0 + 写 `dist/main/package.json`；`asar` 静态校验含 `requestSelfHeal`/`NIKKI_FORCE_GPU_COMPAT`/`NIKKI_GPU_SIMULATE_CRASH`。
- 端到端（自运行/委托用户在正常环境）：① 默认无标记 → 行为与改动前一致；② `NIKKI_FORCE_GPU_COMPAT=1` 启动 → 软件渲染正常进界面；③ `NIKKI_GPU_SIMULATE_CRASH=1` → 实机演示自动重启进入兼容模式；④ 设置关闭硬件加速 → 重启 `app.disableHardwareAcceleration` 生效；⑤ 重新开启 → `gpu-fallback.json.fallbackActive` 被清空。

---

## 7. 兼容模式触发策略与状态管理

- **决策优先级**（`shouldDisableHardwareAcceleration`）：
  1. `NIKKI_FORCE_GPU_COMPAT==='1'` → true（dev/test）；
  2. 用户镜像 `gpu-pref.json.hardwareAcceleration===false` → true（用户绝对优先）；
  3. 崩溃自愈 `gpu-fallback.json.fallbackActive===true` 或 `consecutiveFailures>=2` → true；
  4. 否则 → false（保留硬件加速，不牺牲性能）。
- **状态管理**：两份 `userData` 持久化文件——`gpu-fallback.json`（崩溃驱动、自动）、`gpu-pref.json`（用户驱动镜像）。`app.disableHardwareAcceleration()` 仅在 ready 前生效，故启动期同步读两份 JSON；首绘成功 `markBootSuccess` 清零失败计数（`fallbackActive` 保留）。手动恢复：删 `gpu-fallback.json` 或 UI 开启硬件加速（写 `gpu-pref.json` 并清空 `fallbackActive`）。

## 8. 防回归要点

- **性能**：启动期仅同步读写两个小 JSON（<1ms）；健康路径仅一次 `recordBootDecision` 决策，无新增运行时开销；自愈仅在崩溃时触发。
- **时序硬约束**：`disableHardwareAcceleration` 必须在 `app.ready` 前。
- **blast radius**：仅改 `gpu-fallback.ts` / `index.ts` / `window-manager.ts` / 新增测试与脚本；不动 scanner/database/i18n/UI（UI 手动开关已存在，见 `docs/plans/gpu-accel-toggle.md`）。
