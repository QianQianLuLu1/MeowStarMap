# AGENTS.md — `src/main/app`（应用生命周期编排层）

本文件为 Agent 与新协作者提供 **应用核心模块级** 速览与约定。顶层项目速览见根目录 [`AGENTS.md`](../../../AGENTS.md)；IPC 白名单与 AppError 两条硬性约定见 [`docs/CODING_CONVENTIONS.md`](../../../docs/CODING_CONVENTIONS.md)（唯一真相源；IDE 的 always-on 规则文件仅为它的本地镜像）。本文件只补 **本目录内** 的生命周期编排、安全协议与编码约定。

## 模块概述

Electron 主进程的应用核心模块，负责应用完整生命周期的编排：启动引导、数据库初始化、窗口管理、IPC 注册、自定义协议、GPU 自愈、自动更新、主题切换、启动扫描、退出清理。采用 **"Application 协调者 + 函数式子模块"** 架构，由 `Application` 类作为唯一入口构造所有服务，通过 `AppContext` 共享上下文，委托给各子模块函数执行。

## 目录结构

25 个源文件，其中 21 个有配套测试（`app-context.ts`、`auto-update.ts`、`cleanup.ts`、`renderer-bridge.ts` 暂无）：

### 核心编排

| 文件             | 职责                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `application.ts` | `Application` 类——构造所有服务实例（DB/Scanner/Media/Thumbnail/VideoEditor/Decryption worker bridges、TaskScheduler、Services），构建 `AppContext`，`initialize()` 委托给 `lifecycle.ts` |
| `app-context.ts` | `AppContext` 接口——扩展 `HandlerContext`，包含所有 worker bridges、可变状态（mainWindow、timers、cleaningUp）和状态访问器                                                                |
| `lifecycle.ts`   | `bootstrapApplication()` 启动主流程——单实例锁 → whenReady → 8 阶段初始化 → 退出清理链                                                                                                    |

### 窗口与协议

| 文件                   | 职责                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `window-manager.ts`    | 主窗口创建——CSP 策略、导航防护、ready-to-show/did-finish-load 双兜底、渲染进程崩溃自愈                      |
| `media-protocol.ts`    | `media://` 自定义协议——路径白名单（LRU 缓存 + DB 查询）、Range 请求、ETag 协商缓存、realpath 防符号链接绕过 |
| `renderer-protocol.ts` | `app://` 协议——映射 `app://renderer/<path>` → `dist/renderer/<path>`，asar 安全读取、防目录穿越             |
| `renderer-bridge.ts`   | `sendToRenderer()` 安全发消息（逐级检查窗口/webContents 存活）                                              |
| `navigation-guard.ts`  | 导航授信——仅放行 `app://` / `media://` / dev `localhost:5173`，其余拦截                                     |

### IPC 与恢复

| 文件           | 职责                                                                               |
| -------------- | ---------------------------------------------------------------------------------- |
| `ipc-setup.ts` | `setupIPC()` 注册 43 个 `registerXxxHandlers`（按域拆分），初始化 pathGuard 白名单 |
| `recovery.ts`  | 数据库恢复 + worker 崩溃监听器，事件暂存 → 主窗口就绪后弹窗                        |

### 启动与退出

| 文件                | 职责                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `startup-tasks.ts`  | 启动后延迟任务——自动扫描、索引链、DB 修复、孤儿清理、补偿重试                                                                  |
| `cleanup.ts`        | `performCleanup()` 退出清理——清定时器 → kill 子进程 → 停扫描 → dispose worker（1s 超时）→ 关 DB(WAL checkpoint) → 释放单实例锁 |
| `error-handlers.ts` | 全局错误处理——uncaughtException → 致命报告；unhandledRejection → 分级策略                                                      |
| `exit-forensics.ts` | 退出取证——心跳文件、事件环形缓冲、app.exit 拦截堆栈、下次启动判别                                                              |

### 自愈与安全

| 文件                     | 职责                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `gpu-fallback.ts`        | GPU 崩溃自动回退软件渲染（VS Code 模式）——状态文件持久化、连续失败阈值、自动 relaunch 自愈 |
| `native-load-guard.ts`   | 原生模块加载预检——better-sqlite3/koffi/sharp 分类错误（ABI/VC++/缺失）+ 双语弹窗           |
| `startup-environment.ts` | 启动环境检测——userData 可写性阻塞检测                                                      |
| `permission.ts`          | 管理员权限提升——UAC 提权重启 + 幂等弹窗                                                    |

### 辅助功能

| 文件                  | 职责                                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| `auto-update.ts`      | 自动更新状态机（electron-updater）——仅生产环境、状态推送到渲染端       |
| `custom-dirs.ts`      | 4 个自定义目录（backup/thumbnail/log/crash）的解析、迁移、副作用初始化 |
| `desktop-shortcut.ts` | 桌面快捷方式补创建（仅打包环境）                                       |
| `theme.ts`            | 主题切换——持久化 + nativeTheme 同步 + 标题栏叠加色                     |
| `media-update.ts`     | 媒体变更通知——失效白名单缓存 + 刷新 pathGuard + 节流广播（100ms）      |

## 编码约定

### AppContext 依赖注入

- 所有模块函数接收 `AppContext` 参数，**避免模块反向依赖 `Application` 类**。
- `Application` 通过闭包自引用（`ctx` 上的 getter/setter 指向实例字段）将自身注入上下文。
- handler 内不直接访问 `Application` 实例，只用 `ctx`。

### 防御性编程

- 每个启动阶段独立 `try/catch`，单阶段失败不阻塞后续阶段。
- 退出清理每步都有 `try/catch` 空 catch——确保一个清理步骤失败不影响其余。
- worker dispose 统一 1s `Promise.race` 超时兜底。
- `before-quit` 清理链有动态超时（WAL > 10MB 延长到 5s）后 `app.exit(1)` 强制退出。

### 早期弹窗约束

- `native-load-guard` 和 `startup-environment` 使用 **硬编码双语文案**（中/英），因为 i18n 在启动早期尚未初始化。
- **禁止** 在这些早期模块中调用 `t()`——会导致二次抛错、无弹窗。

### 状态文件持久化

- GPU 回退（`gpu-fallback.json`）、退出取证（`heartbeat.json` / `last-exit.json`）、硬件加速偏好（`gpu-pref.json`）——全部同步写入、全部容错。
- 状态文件读写不得抛出未捕获异常。

### 分级任务调度

- 启动期 `taskScheduler.pause()`，主窗口 `ready-to-show` 后 `resume()`。
- 延迟任务走 `enqueueLow`，保险丝 15s 强制恢复。

### 节流与缓存

- `media:updated` 广播 100ms 节流，避免高频渲染进程通信。
- `media://` 白名单缓存 LRU 策略（Map delete + set 移到末尾）。

## 应用启动流程

```
index.ts (入口)
  ├── 早期：异常捕获、GPU 决策、协议声明、原生模块预检、环境检测
  └── app.whenReady() 后：
       ├── initExitForensics()
       ├── registerRendererProtocol()
       ├── markBootAttempt() + setupGpuProcessWatcher()
       └── new Application().initialize()
            └── bootstrapApplication(ctx)     ← lifecycle.ts
                 ├── 阶段1: DB 初始化 + recovery 监听器
                 ├── 阶段2: 自定义目录迁移
                 ├── 阶段3: 日志 + i18n
                 ├── 阶段4: crashReporter
                 ├── 阶段5: 备份服务
                 ├── 阶段6: 协议(media) + IPC + 窗口 + 插件
                 ├── 阶段7: 主题 + DB 修复
                 ├── 阶段8: 延迟任务(扫描/完整性检查/LRU/崩溃清理)
                 └── 退出链: before-quit → performCleanup → app.exit(0)
```

## 注意事项

- **禁止** 在 `app/` 模块中裸调 `ipcMain.handle`——所有 IPC 注册必须经 `src/main/ipc/handlers/` 中的域文件 + `wrapHandler` 包装。
- 修改启动阶段顺序需评估依赖关系（如 i18n 必须在翻译消费方之前初始化）。
- `cleanup.ts` 中的 dispose 顺序很重要：先停调度器 → 再停 worker → 最后关 DB（worker 可能还在写 DB）。
- `media-protocol.ts` 的路径白名单是安全关键路径，修改时需同时考虑 LRU 缓存一致性和 realpath 解引用。
- `gpu-fallback.ts` 的状态文件在 `userData` 下，修改格式需向后兼容（旧格式仍能解析）。
- `window-manager.ts` 中的 CSP 策略修改会影响渲染进程所有外部资源加载，需同步评估。
- 25 个源文件中有**同名**配套测试的为 21 个（`app-context.ts`、`auto-update.ts`、`cleanup.ts`、`renderer-bridge.ts` 暂无同名套件）；其中 `cleanup.ts` 并非无测试，而是由 `__tests__/cleanup-perform-cleanup.test.ts` 与 `__tests__/cleanup-collect-exit-diagnosis.test.ts` 按函数拆分覆盖。修改后运行 `npm run test:main` 确认。
