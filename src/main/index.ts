import { app, protocol } from 'electron'
import fs from 'fs'
import path from 'path'
import { diagLog, logStartupError, getStartupLogPathValue } from './utils/startup-diagnostic'
import { showFatalStartupErrorBox } from './app/native-load-guard'
import {
  reportEarlyFatal,
  markStartupSettled,
  isStartupSettled,
  shouldEscalateUnhandledRejection
} from './utils/early-crash-guard'
import { setDocumentsPathProvider, CHROMIUM_LOG_BASENAME } from './utils/user-diag-path'
// 2026-11-17 取证统一收口：取证根目录单一真相源（详见 forensics-dir 头注释）
import {
  setForensicsEnvProvider,
  migrateLegacyUserDataRootSync,
  getForensicsRoot,
  getForensicsFilePath
} from './utils/forensics-dir'
import { verifyStartupEnvironment } from './app/startup-environment'
import { electronLogger } from './utils/logger'
import { registerRendererProtocol } from './app/renderer-protocol'
// R1（2026-11-15）：单实例锁获取前移到重模块加载之前（详见 single-instance.ts 头注释）
// B（2026-11-15）：writeSecondInstanceAck 供下方赢家侧 ack 写入监听使用（详见函数注释）
import {
  acquireSingleInstanceLockOrHandleFailure,
  writeSecondInstanceAck
} from './app/single-instance'
import {
  recordBootLevel,
  requestSelfHeal,
  wasBootInCompatMode,
  readGpuBootPrefs
} from './app/gpu-fallback'
import { applyDiscreteGpuPreference } from './app/gpu-preference'
import { getPreviousExitEvidence, markExitStage } from './app/exit-forensics'
import { installFfmpegSpawnGuard } from './utils/fluent-ffmpeg-shim'
import { t } from './i18n'

// 捕获未处理异常和未处理的 Promise 拒绝。
// 必须放在任何可能抛错的模块级代码（registerSchemesAsPrivileged 等）之前：
// 若在模块加载期抛错但处理器未注册，Electron 会弹阻塞式模态框导致启动挂起。
// 提前注册可将"挂起"变成"记录诊断日志"。
// 启动最早期全局异常捕获：error-handlers.ts 在 app.initialize() 阶段才注册，
// 此前（含原生模块加载、环境检测、窗口创建前）任何崩溃都在此兜底——同步落盘 +
// 不依赖 i18n / 渲染进程的原生弹框 + 退出进程。中心化到 early-crash-guard.reportEarlyFatal，
// 与 error-handlers 共用去重守卫，避免重复弹窗 / 退出。
process.on('uncaughtException', (err) => {
  reportEarlyFatal(err, { stage: 'index.uncaughtException' })
})
process.on('unhandledRejection', (reason) => {
  diagLog('INDEX', `unhandledRejection: ${String(reason)}`)
  // electron-log 统一落盘原始 reason，便于崩溃诊断
  electronLogger.error('unhandledRejection:', reason)
  // 启动期（编排未走完）致命化：此时多半是 189-214 行、动态 import 或初始化抛错，
  // 若只记日志不退出，进程会存活但无窗口、无提示，还可能持有单实例锁 ——
  // 用户反复双击只会不断撞「已有实例运行」。由 reportEarlyFatal 统一弹框 + 落盘 +
  // 释放锁 + 退出（内部去重守卫避免与 .catch 重复）。
  if (shouldEscalateUnhandledRejection(isStartupSettled())) {
    reportEarlyFatal(reason, { stage: 'index.unhandledRejection' })
  }
  // 启动完成后不直接 app.exit(1)：非致命的游离 rejection 不应杀死整个应用，
  // 避免一条边缘异步路径导致扫描进度/用户数据丢失。
})

// fluent-ffmpeg spawn 逃逸垫片：主进程内任何 ffmpeg .run()/能力探测之前尽早安装。
// 将损坏二进制导致的 spawn 同步抛错（EFTYPE）收敛为回调错误，避免升级为致命弹窗。
installFfmpegSpawnGuard()

// 诊断目录单一真相源：注册「文档」目录，使启动日志落盘路径与致命弹窗展示路径同源
// （此前写盘侧未拿到 documents 候选，弹窗指向 Documents 而日志写在 homedir，用户找不到日志）
try {
  setDocumentsPathProvider(() => app.getPath('documents'))
} catch {
  // 不可用时保持未注册，由 user-diag-path 回落到 homedir / tmpdir 候选
}

// 2026-11-17 取证统一收口：注册取证环境提供器（打包态 → <安装目录>\Diagnostics，
// 不可写回落 Documents 候选链）。defaultApp 是权威 dev 信号——Electron 41 下
// `electron.exe <显式 app 目录>` 的 isPackaged 恒为 true（探针实证），只凭它会
// 把 dev/e2e 的取证写进 node_modules。provider 注册必须先于任何取证写入与
// recordBootLevel（后者读 gpu-fallback.json）。
try {
  setForensicsEnvProvider(() => ({
    isPackaged: app.isPackaged === true,
    defaultApp: process.defaultApp === true,
    exePath: process.execPath
  }))
} catch {
  // 注册失败保持未注册态：forensics-dir 解析自动回落 Documents 候选链
}

// R-a3（审查修复轮）：升级首启先把 userData 根级历史取证文件（gpu-fallback 档位 /
// gpu-pref 用户偏好等 6 文件）同步迁入取证根——必须先于 recordBootLevel 读取，
// 否则旧版 GPU 档位与显式关闭硬件加速偏好在升级后被静默架空。同步版零 electron，
// 可在模块加载期执行；userData 不可得（ready 前受限）时跳过，阶段 2 异步版兜底。
try {
  let legacyUserDataDir = ''
  try {
    legacyUserDataDir = app.getPath('userData')
  } catch {
    legacyUserDataDir = path.join(app.getPath('appData'), app.getName())
  }
  migrateLegacyUserDataRootSync(legacyUserDataDir)
} catch {
  // 迁移失败不阻塞启动：GPU 决策按取证根现有证据进行
}

// 崩溃转储目录统一到取证根（须在 crashReporter.start 前设定）
try {
  app.setPath('crashDumps', getForensicsRoot())
} catch {
  // crashDumps 路径不可用时沿用 electron 默认
}

// Chromium 原生日志落盘（ready 前 appendSwitch 才生效）：
// 捕获 Chromium FATAL（如 "GPU process isn't usable. Goodbye."）等原生层退出原因——
// 此类退出是原生 int 3 自杀，不经过 Node（无 uncaughtException、无 JS 退出痕迹）。
// 口径订正（2026-11-02）：转储并非完全没有——crashReporter 在 lifecycle 阶段 4 已启动，
// 问题设备确实产出了 .dmp；但 dmp 需要专业解析，exit_code 这类关键事实只有本日志里
// 有原文，且用户能自助打包，故仍把它作为首选取证载体并纳入「导出诊断包」。
try {
  const chromiumLogPath = getForensicsFilePath(CHROMIUM_LOG_BASENAME)
  // 轮转：超过 10MB 重命名为 .old（单文件保留一份，防无限增长）
  try {
    if (fs.existsSync(chromiumLogPath) && fs.statSync(chromiumLogPath).size > 10 * 1024 * 1024) {
      fs.rmSync(chromiumLogPath + '.old', { force: true })
      fs.renameSync(chromiumLogPath, chromiumLogPath + '.old')
    }
  } catch {
    // 轮转失败不影响日志写入
  }
  app.commandLine.appendSwitch('enable-logging', 'file')
  app.commandLine.appendSwitch('log-file', chromiumLogPath)
  // 意图路径留痕：与 lifecycle 的在位探测行配对，诊断包可判定 chromium 日志缺席原因（T11）
  diagLog('INDEX', `chromium log target: ${chromiumLogPath}`)
} catch {
  // 诊断目录不可用时静默降级：不影响启动
}

// 验证专用：模拟启动最早期崩溃，验证 reportEarlyFatal 弹框+日志（仅 === '1'，默认关闭）
if (process.env.NIKKI_EARLY_CRASH_SIM === '1') {
  throw new Error('NIKKI_EARLY_CRASH_SIM triggered simulated early crash')
}

diagLog('INDEX', '=== index.ts loaded ===')

// Windows 任务栏分组与跳转列表需要显式 AppUserModelID，取值与 build.appId 同源；
// 必须在 app.whenReady() 之前设置，失败只记日志不阻断启动。
try {
  app.setAppUserModelId('com.qianlu.meow-star-map')
} catch (err) {
  electronLogger.warn('[INDEX] setAppUserModelId failed', err)
}

// GPU 崩溃自动回退（VS Code 模式）：部分机器 GPU 进程无法运行时，Chromium 会以
// FATAL "GPU process isn't usable. Goodbye." 自杀主进程，表现为启动即闪退或
// loadURL 报 ERR_FAILED(-2) 白屏（app:// 协议层无关，2026-08-19 用户机 54 个 dump 裁决）。
// 三级兼容阶梯：0 硬件加速 / 1 禁用硬件加速 / 2 最大兼容（见 gpu-fallback 头注释）。
// 上次被原生层杀死（FATAL 是 int 3 同步自杀，JS 侧无异常无退出痕迹，陈旧心跳是唯一信号）
// → 在上一次实际用过的档位上再降一级；必须在 app ready 之前决策才生效。
// 审查修复轮 G1-F1：recordBootLevel 在模块加载期执行（早于 whenReady 内的完整锁流程），
// 输家也会跑到这里。先做一次同步锁探测：未持锁 ⇒ 本次为输家，GPU 决策只读化，
// 不得写共享 gpu-fallback.json（阈值激活/盖戳会把运行中的赢家打进软件渲染）。
// 完整的重试+三选项框失败路径仍在 whenReady 内 acquireSingleInstanceLockOrHandleFailure 闭环。
const holdsInstanceLockAtBoot = app.requestSingleInstanceLock()
const gpuCompatLevel = recordBootLevel({
  prevNativeKill: getPreviousExitEvidence().kind === 'native',
  readOnly: !holdsInstanceLockAtBoot
})
if (gpuCompatLevel >= 1) {
  app.disableHardwareAcceleration()
  diagLog(
    'INDEX',
    `gpu compat level=${gpuCompatLevel}: hardware acceleration DISABLED for this boot`
  )
  if (gpuCompatLevel >= 2) {
    // 第 2 级（最大兼容）：上游 SoftwareGLAllowed() 因 --disable-software-rasterizer 变 false，
    // 与 --disable-gpu 同给时 GpuAccessAllowed() 直接判 false ⇒ GPU 进程根本不再启动，
    // "GPU process isn't usable. Goodbye." 这条 FATAL 才结构性不可达。
    // 只调 disableHardwareAcceleration() 到不了这一档：它只把上游模式阶梯往下弹，
    // GPU 进程照旧启动、照旧崩满 3 次后走空阶梯（2026-11-02 问题设备转储实证）。
    try {
      app.commandLine.appendSwitch('disable-gpu')
      app.commandLine.appendSwitch('disable-software-rasterizer')
      diagLog('INDEX', 'gpu compat level=2: --disable-gpu + --disable-software-rasterizer appended')
    } catch (e) {
      // 开关下发失败只退化为「禁用硬件加速」，绝不因诊断性开关打断启动
      diagLog('INDEX', `appendSwitch(disable-gpu/disable-software-rasterizer) failed: ${String(e)}`)
    }
  }
  try {
    electronLogger.info(t('main.index.log.gpuFallbackActive'))
  } catch {
    // electronLogger 未就绪时仅依赖 diagLog
  }
}

// 独显优先（Windows 混合显卡）：按启动偏好镜像写 HKCU UserGpuPreferences 的
// GpuPreference=2（默认 high-performance，仅打包版，对下次启动生效；'auto' 时仅
// 清理我们写入过的自有格式值）。内部全程 fail-open，失败只记日志不影响启动。
try {
  void applyDiscreteGpuPreference(readGpuBootPrefs().discretePreference)
} catch {
  // 偏好读取/应用异常绝不阻塞启动
}

// 注册自定义协议，使渲染进程可以安全访问本地媒体文件
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      secure: true,
      standard: true,
      // 渲染进程以 crossOrigin='anonymous' 加载 media:// 图片绘制 canvas，
      // 需声明 CORS 特权，否则请求在网络层被拒
      corsEnabled: true,
      supportFetchAPI: true,
      stream: true
    }
  },
  // 渲染进程产物协议：替代 file:// 加载，规避 ES Module 经 file:// 触发的 CORS 白屏
  {
    scheme: 'app',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      stream: true
    }
  }
])

diagLog('INDEX', 'protocol.registerSchemesAsPrivileged done')

// 注意：protocol.handle 内部会访问 session.defaultSession，必须在 app.whenReady() 之后调用，
// 否则抛出 "Session can only be received when app is ready"。scheme 特权声明已在上方 ready 前完成。

// 修复：Application 构造函数中的 DatabaseManager 和 ThumbnailGenerator
// 都调用了 app.getPath('userData')，这在 app.whenReady() 之前会抛错
// （打包环境下错误为 "Cannot create app data folder before app.whenReady()"）
// 因此必须将 new Application() 延迟到 app.whenReady() 之后执行
const readyStartup = app.whenReady().then(async () => {
  diagLog('INDEX', 'app.whenReady() fired')

  // R1（2026-11-15）：单实例锁必须在动态 import Application / 构造 16 个服务之前获取。
  // 修复前锁在 lifecycle.ts 内才获取：慢机/杀软扫描首实例的数秒加载窗口内，第二次
  // 双击的实例可抢先拿锁（实例角色颠倒），且失败实例会白加载重模块、继续执行
  // initialize() 完成段写共享 userData 的 boot-ok.marker（污染诊断标记）。
  // 失败路径（6×1s 重试 + 三选项对话框）在 single-instance.ts 内闭环，不加载重模块。
  const gotLock = await acquireSingleInstanceLockOrHandleFailure()
  if (!gotLock) return

  // B（2026-11-15）：赢家最早注册 ack 写入器——动态 import Application 的数秒窗口内
  // （杀软扫描热点）发生的第二次双击也能留下「赢家存活」证据，输家据此在重试耗尽后
  // 静默让位而不是 6s 后弹「已有实例运行」。lifecycle 稍后注册的完整 handler 负责
  // 聚焦窗口，两个监听器并存不冲突（EventEmitter 多播）。
  app.on('second-instance', () => writeSecondInstanceAck())

  // F2+F5（2026-11-15）：退出取证 / 原生模块预检 / markBootAttempt / GPU 观测
  // 已后移到 lifecycle.ts 单实例锁获取成功之后（赢家专属）。
  // 此前它们在锁检查之前执行：锁失败实例会给共享 gpu-fallback.json 的失败计数 +1、
  // 覆写运行实例的 heartbeat.json，并白白加载原生模块拖慢"已有实例运行"弹窗。

  // 启动期环境检测：安装路径特殊字符（仅提示）+ userData 可写性（阻塞）。
  // 不可写（权限不足 / 杀毒软件拦截）时弹双语友好引导并终止启动，替代静默失败。
  if (
    !verifyStartupEnvironment({
      getExecPath: () => process.execPath,
      getUserDataPath: () => app.getPath('userData')
    })
  ) {
    try {
      app.releaseSingleInstanceLock?.()
    } catch {}
    app.exit(1)
    return
  }

  // 首个窗口导航前注册 app:// 处理器（此时 session 已可用）
  registerRendererProtocol()
  diagLog('INDEX', 'registerRendererProtocol done')

  // 开发/测试：模拟 GPU 崩溃以演示"崩溃→自动降级→重启自愈"链路。
  // 仅当本次为硬件加速启动（未禁用）时触发一次；进入兼容模式后的启动不再触发，避免死循环。
  if (process.env.NIKKI_GPU_SIMULATE_CRASH === '1' && !wasBootInCompatMode()) {
    diagLog('INDEX', 'NIKKI_GPU_SIMULATE_CRASH=1 → simulate GPU crash to exercise self-heal')
    requestSelfHeal('simulated-gpu-crash', 1)
    return
  }

  try {
    diagLog('INDEX', 'before import Application')
    const { Application } = await import('./app/application')
    diagLog('INDEX', 'Application module imported, before new Application()')
    const application = new Application()
    diagLog('INDEX', 'Application constructed, before initialize()')
    await application.initialize()
    diagLog('INDEX', 'Application.initialize() completed')

    // 整合阶段 1：NikkiSync 依赖链接探针（默认关，仅 NIKKI_NIKKISYNC_PROBE=1 时跑）。
    // 只验证四包可装载与内存库建表，绝不启动 Runtime/scanner/服务器；失败只记录，
    // 绝不阻塞启动（与本文件其余诊断分支一致的 fail-open 口径）。
    if (process.env.NIKKI_NIKKISYNC_PROBE === '1') {
      try {
        const { runNikkiSyncLinkProbe } = await import('./nikkisync/probe')
        const { buildPackagingContext } = await import('./nikkisync/embedding-paths')
        // 打包态必须给出上下文：装载缝据此走 app.asar.unpacked 兜底装载，
        // 探针据此以本侧解析的绝对路径显式传 schemaSql（上游 import.meta.url 不可靠）。
        const packagingContext = buildPackagingContext({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          projectRoot: app.getAppPath()
        })
        const report = await runNikkiSyncLinkProbe(packagingContext)
        const summary =
          `nikkisync link probe ok=${report.ok} host=node ${report.host.node} ` +
          `(electron=${report.host.electron ?? 'n/a'}) packages=${report.packages.length} ` +
          `exports=${report.exports.length} dbTables=${report.database.tableCount ?? 'n/a'} ` +
          `packaged=${packagingContext.isPackaged} schemaSource=${report.database.schemaSource ?? 'n/a'} ` +
          `failures=${report.failures.length > 0 ? report.failures.join(' | ') : 'none'}`
        diagLog('INDEX', summary)
        // diag.log 落盘在本机存在静默失败（历史 INDEX 行停在 2026-09-18），因此额外走
        // electron-log 统一通道，使 dev 启动阶段的可观测性与 gpuFallbackActive 日志一致。
        try {
          electronLogger.info(`[NIKKISYNC] ${summary}`)
        } catch {
          // electron-log 未就绪时仅依赖 diagLog
        }
      } catch (err) {
        diagLog('INDEX', `nikkisync link probe threw: ${String(err)}`)
        try {
          electronLogger.warn(`[NIKKISYNC] link probe threw: ${String(err)}`)
        } catch {
          // 同上：日志通道不可用时不阻塞启动
        }
      }
    }
    markExitStage('initialized')
    // 启动编排完成：此后 unhandledRejection 降级为「只记日志不退出」，
    // second-instance 的 0 窗口兜底也从此才允许重建窗口（避免与启动链重入）。
    markStartupSettled()
    // 启动成功标记：供纯净系统 / CI 断言启动成功（2026-11-17 随取证统一收口迁至取证根）
    try {
      fs.writeFileSync(getForensicsFilePath('boot-ok.marker'), 'ok')
    } catch {}
  } catch (err) {
    markStartupSettled()
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : ''
    diagLog('INDEX', `FATAL ERROR in startup: ${msg}\n${stack}`)
    logStartupError('index.ts app.whenReady', err)
    // 崩溃发生在 registerGlobalErrorHandlers 注册之前，必须在此兜底。
    // 改用不依赖 i18n 的同步弹窗（修复原 t() 在 i18n 未就绪时二次抛错 → 无弹窗）。
    // 日志路径统一到用户友好目录（文档/喵星图/Diagnostics），普通用户易查找
    const logPath = getStartupLogPathValue()
    showFatalStartupErrorBox(err, logPath)
    try {
      app.releaseSingleInstanceLock?.()
    } catch {
      // 释放锁失败时忽略
    }
    app.exit(1)
  }
})

// 启动早期兜底：189-214 行不在 try 内（环境检测 / 协议注册 / GPU 模拟分支），
// 或上面的 FATAL catch 自身抛错时，必须给出可见提示并退出，绝不留下
// 「进程存活、无窗口、无提示、还持锁」的静默挂起状态。
readyStartup.catch((err) => {
  markStartupSettled()
  reportEarlyFatal(err, { stage: 'index.whenReady.catch' })
})
