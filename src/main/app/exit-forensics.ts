import { app } from 'electron'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { writeFileAtomicSync } from '../utils/atomic-file'
import { diagLog } from '../utils/startup-diagnostic'
import { logger } from '../utils/logger'
import { getForensicsFilePath } from '../utils/forensics-dir'

/**
 * 退出取证（复刻 Chrome「Chrome 未正确关闭」检测模式）。
 *
 * 背景（2026-08-29 闪退取证）：打包版启动后 ~15-20s 进程无声消失，
 * 所有 JS 级退出路径（before-quit / uncaughtException / GPU 自愈 / 提权重启）
 * 都会留痕但痕迹全部缺席；带心跳复测后证实：Node exit 事件触发（code=0），
 * 但 before-quit / will-quit 均未触发 → 存在绕过 Electron 退出流程的
 * exit(0) 调用或事件循环排空。本模块负责把"谁调用的退出"变成可观测事件。
 *
 * 机制：
 * - 心跳：每 5s 同步覆写取证根目录 heartbeat.json（mtime = 最后存活时刻，
 *   精确定位死亡时间；正常退出时删除）。
 * - 事件日志：内存环形缓冲记录关键退出链事件（before-quit / window-all-closed /
 *   second-instance / app.exit / process.exit / beforeExit），退出时随
 *   last-exit.json 一并落盘。app.exit / process.exit 记录调用点 JS 堆栈；
 *   beforeExit 出现 = 事件循环自然排空（无显式退出调用）。
 * - 下次启动判别（readStaleEvidence）：
 *   心跳 pid 仍存活 → 前实例还在运行（健康实例或僵尸持锁），无死亡证据
 *   （F1，2026-11-15；此前会被误判为外部终止并记故障）；
 *   陈旧心跳（pid 已死）+ last-exit 匹配 → JS 管理退出（记 info，附 code/stage/事件链）；
 *   陈旧心跳 + last-exit 缺失 → 外部终止（TerminateProcess 类，logFault）。
 *
 * 全部文件读写 try/catch 容错：userData 不可写 / JSON 损坏 → 视为不存在，
 * 绝不阻塞启动。
 *
 * 口径订正（2026-11-02）：本模块**写盘与打点仍不参与业务控制流**，但「上次是否被
 * 原生层杀死」这一判定结论对外只读暴露（getPreviousExitEvidence），供 GPU 兼容阶梯
 * 作为升档证据消费——Chromium 的 GPU FATAL 是 int 3 同步自杀，JS 侧没有任何
 * 异常/退出痕迹可查，陈旧心跳是唯一可用信号。
 */

/** 上次终止性质：none=无陈旧心跳（首次/正常退出）；js=JS 管理退出；native=原生层/外部终止 */
export type PreviousExitKind = 'none' | 'js' | 'native'

export interface PreviousExitEvidence {
  kind: PreviousExitKind
  bootId?: string
  stage?: string
  /** js → last-exit 的 time；native → 最后一次心跳时刻 */
  at?: string
}

/** 心跳间隔：与启动扫描入队（5s）同量级，死亡时间定位误差 ≤5s */
const HEARTBEAT_INTERVAL_MS = 5000
/** 事件日志上限（环形覆盖最旧），退出时整体落盘 */
const JOURNAL_LIMIT = 50

interface HeartbeatFile {
  bootId: string
  pid: number
  startedAt: string
  updatedAt: string
  stage: string
}

interface LastExitFile {
  bootId: string
  code: number
  stage: string
  time: string
  /** 退出前事件链（app.exit/process.exit 含调用点堆栈首行） */
  journal: string[]
  /** process.uptime() 秒 */
  uptime: number
}

let bootId = ''
let currentStage = 'boot'
let heartbeatTimer: NodeJS.Timeout | null = null
const journal: string[] = []

function getHeartbeatPath(): string {
  return getForensicsFilePath('heartbeat.json')
}

function getLastExitPath(): string {
  return getForensicsFilePath('last-exit.json')
}

/** 记录一条退出链事件（环形缓冲 + diagLog 同步留痕） */
function recordEvent(kind: string, detail?: string): void {
  const at = new Date().toISOString()
  const line = detail ? `${at} ${kind} ${detail}` : `${at} ${kind}`
  journal.push(line)
  if (journal.length > JOURNAL_LIMIT) journal.shift()
  diagLog('EXIT-FX', line)
}

/** 摘取 Error 堆栈的前几行（定位 exit 调用点所在文件:行号） */
function briefStack(err: Error): string {
  try {
    return err.stack
      ? err.stack
          .split('\n')
          .slice(1, 4)
          .map((s) => s.trim())
          .join(' | ')
      : '(no stack)'
  } catch {
    return '(no stack)'
  }
}

/** 通用 JSON 读取：文件不存在 / JSON 损坏 / 形状校验不过 → null（视为不存在） */
function readJsonFile<T>(filePath: string, validate: (raw: unknown) => T | null): T | null {
  try {
    if (!fs.existsSync(filePath)) return null
    return validate(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch {
    return null
  }
}

function parseHeartbeat(raw: unknown): HeartbeatFile | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.bootId !== 'string' || r.bootId.length === 0) return null
  // pid 必须是正整数：pid=0 穿透后 defaultIsProcessAlive 的 kill(0,0) 探测的是**进程组**
  // → 恒返回 true → 死亡证据被永久遮蔽；负数/小数同样不是合法进程标识，按损坏处理。
  if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) return null
  if (typeof r.stage !== 'string') return null
  return {
    bootId: r.bootId,
    pid: r.pid,
    stage: r.stage,
    startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : ''
  }
}

function parseLastExit(raw: unknown): LastExitFile | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.bootId !== 'string' || r.bootId.length === 0) return null
  if (typeof r.code !== 'number' || !Number.isFinite(r.code)) return null
  if (typeof r.stage !== 'string') return null
  return {
    bootId: r.bootId,
    code: r.code,
    stage: r.stage,
    time: typeof r.time === 'string' ? r.time : '',
    journal: Array.isArray(r.journal)
      ? r.journal.filter((x): x is string => typeof x === 'string')
      : [],
    uptime: typeof r.uptime === 'number' && Number.isFinite(r.uptime) ? r.uptime : -1
  }
}

function writeHeartbeat(): void {
  try {
    const rec: HeartbeatFile = {
      bootId,
      pid: process.pid,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
      stage: currentStage
    }
    // 原子写：裸 writeFileSync 覆写存在「截断之后、写完之前」的窗口，读者（下次启动的
    // 判别 / 诊断包导出）撞上即读到半截 JSON → 证据丢失。与 last-exit.json / gpu-fallback.json
    // 同口径：先写同目录临时文件再 rename。
    writeFileAtomicSync(getHeartbeatPath(), JSON.stringify(rec))
  } catch {
    // userData 不可写等极端场景：静默降级，绝不影响启动
  }
}

/**
 * 进程存活探针签名（F1 活性判定的可注入点，便于测试矩阵化）。
 */
export type IsProcessAliveProbe = (pid: number) => boolean

/**
 * 默认存活探针：`kill(pid, 0)` 只探测进程存在性。
 * - 成功 → 存活；EPERM（存在但无权限，如提权僵尸）→ 存活
 * - ESRCH（不存在）→ 不存活；其余错误保守判「不自存活」——
 *   漏判只损失一次 GPU 升档机会，误判会让健康机器被永久降级软件渲染
 */
export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * 纯函数：由心跳与退出码两份文件判定上次终止性质（无 fs / 无 electron）。
 * 心跳缺席 = 无异常证据；同一 bootId 的 last-exit 存在 = JS 管理退出（含 app.exit /
 * process.exit / 事件循环排空），否则 = 原生层/外部终止（Chromium FATAL 即此类）。
 *
 * F1（2026-11-15）：`isAlive` 存活探针——心跳 pid 仍存活 = 前实例还在运行
 * （健康实例或僵尸持锁），这不是「死亡证据」。此前只要心跳文件存在且
 * last-exit bootId 不匹配就判 native：运行中实例的心跳被后来者读成
 * 「被原生层杀死」→ GPU 兼容阶梯白升档（第二实例每双击一次升一级，
 * fallbackActive 被永久置位）。活性判定优先于 js 分支：进程活着就没有
 * 「退出性质」可言。缺省 isAlive 时保持既有判定（历史调用方零改动）。
 */
export function classifyPreviousExit(
  heartbeat: HeartbeatFile | null,
  lastExit: LastExitFile | null,
  isAlive?: IsProcessAliveProbe
): PreviousExitEvidence {
  if (!heartbeat) return { kind: 'none' }
  if (isAlive && isAlive(heartbeat.pid)) return { kind: 'none' }
  if (lastExit && lastExit.bootId === heartbeat.bootId) {
    return { kind: 'js', bootId: heartbeat.bootId, stage: lastExit.stage, at: lastExit.time }
  }
  return {
    kind: 'native',
    bootId: heartbeat.bootId,
    stage: heartbeat.stage,
    at: heartbeat.updatedAt
  }
}

/**
 * 对外只读判定上次终止性质：**可在 ready 前调用**，不依赖 initExitForensics 已执行，
 * 且绝不写盘/不清理（否则随后 readStaleEvidence 的判别会被吞掉）。
 * 默认启用活性探针（心跳 pid 存活 → none）；测试可注入 isAlive 覆盖。
 */
export function getPreviousExitEvidence(
  options: { isAlive?: IsProcessAliveProbe } = {}
): PreviousExitEvidence {
  const heartbeat = readJsonFile(getHeartbeatPath(), parseHeartbeat)
  // 常见路径（上次正常退出，心跳已删）：不必再读退出码文件
  if (!heartbeat) return { kind: 'none' }
  return classifyPreviousExit(
    heartbeat,
    readJsonFile(getLastExitPath(), parseLastExit),
    options.isAlive ?? defaultIsProcessAlive
  )
}

/** 上次运行判别：产出日志，并把结论同一口径用于对外只读 API */
function readStaleEvidence(): void {
  const staleHeartbeat = readJsonFile(getHeartbeatPath(), parseHeartbeat)
  if (!staleHeartbeat) return // 首次启动 / 上次正常退出（心跳已清理）/ 文件损坏

  // F1（2026-11-15）：心跳 pid 仍存活 = 前实例（健康实例或僵尸持锁）还在运行，
  // 不是「被外部/原生层终止」。此前会误记 exitDiagnosis 故障污染诊断日志，
  // 与 getPreviousExitEvidence 的误判同源（每来一个第二实例就误报一次）。
  if (defaultIsProcessAlive(staleHeartbeat.pid)) {
    diagLog(
      'EXIT-FX',
      `上次实例可能仍在运行（心跳 pid=${staleHeartbeat.pid} 存活）: ` +
        `bootId=${staleHeartbeat.bootId} stage=${staleHeartbeat.stage}`
    )
    return
  }

  const lastExit = readJsonFile(getLastExitPath(), parseLastExit)
  if (classifyPreviousExit(staleHeartbeat, lastExit).kind === 'js' && lastExit) {
    // JS 管理的退出。口径订正（2026-11-02 实测）：`app.quit()` 会触发 Node 'exit' 事件，
    // 而 `app.exit()` / `process.exit()` **不会**（electron 41.10.6 探针），所以后两者由
    // installExitCallSpies 的包装层当场落退出码，否则主动退出会被误读成原生层杀死。
    const summary =
      `上次运行 JS 管理退出 code=${lastExit.code} stage=${lastExit.stage} ` +
      `uptime=${lastExit.uptime}s journal=[${lastExit.journal.join(' >> ')}]`
    diagLog('EXIT-FX', summary)
    try {
      logger.info(`exit-forensics: ${summary}`)
    } catch {
      // logger 未初始化时仅依赖 diagLog
    }
    return
  }

  // 陈旧心跳存在但退出码缺失 → TerminateProcess / 原生 ExitProcess / 断电类终止
  const msg =
    `检测到上次运行被外部/原生层终止（无 JS 退出痕迹）: ` +
    `上次 bootId=${staleHeartbeat.bootId} pid=${staleHeartbeat.pid} ` +
    `stage=${staleHeartbeat.stage} 最后心跳=${staleHeartbeat.updatedAt}`
  diagLog('EXIT-FX', msg)
  try {
    void logger.fault('exitDiagnosis', new Error(msg), {
      prevBootId: staleHeartbeat.bootId,
      prevPid: staleHeartbeat.pid,
      prevStage: staleHeartbeat.stage,
      prevHeartbeatAt: staleHeartbeat.updatedAt,
      lastExit: lastExit ?? null
    })
  } catch {
    // 故障日志失败不影响启动
  }
}

/**
 * 同步落盘退出码记录（Node 'exit' 处理器与 app.exit / process.exit 包装层共用同一构造）。
 * 为什么包装层也必须写：electron 41.10.6 本机探针实测 `app.exit()` 与 `process.exit()`
 * **都不触发** Node 的 'exit' 事件（只有 `app.quit()` 链触发）。只挂处理器时，
 * 「GPU 自愈主动重启」会留下心跳文件却没有任何退出码 → 下次启动被判成
 * 「被原生层杀死」→ 兼容阶梯在同一次崩溃上多升一档（三级塌成两级）。
 */
function flushLastExitRecord(code: number): void {
  try {
    const rec: LastExitFile = {
      bootId,
      code: typeof code === 'number' ? code : -1,
      stage: currentStage,
      time: new Date().toISOString(),
      journal: [...journal],
      uptime: process.uptime()
    }
    // 原子写：半截的 last-exit.json 会读成 null，而「心跳还在 + last-exit 缺席」正是
    // classifyPreviousExit 判 native 的形状 ⇒ 给一台没被原生杀死的机器白升一级兼容档。
    // 也就是说 DEBT-047 那个「强杀/断电同形误判」除了环境成因，还能由一次半截写入自己制造。
    writeFileAtomicSync(getLastExitPath(), JSON.stringify(rec))
  } catch {
    // 静默：取证写盘失败不改变退出行为
  }
}

/** 停摆心跳定时器：已宣告干净退出后不得再写心跳（复活的心跳 = 假 native 证据） */
function stopHeartbeatTimer(): void {
  if (!heartbeatTimer) return // 幂等：未初始化或已停摆都不重复 clearInterval
  try {
    clearInterval(heartbeatTimer)
  } catch {
    // 静默：停表失败最多多留一次心跳，不影响退出
  }
  heartbeatTimer = null
}

/** 拦截 app.exit / process.exit：记录调用点堆栈并当场落退出码，再透传原实现（纯取证，不改行为） */
function installExitCallSpies(): void {
  try {
    const original = app.exit.bind(app)
    const wrapped = function patchedAppExit(exitCode?: number): void {
      recordEvent('app.exit', `code=${exitCode} stack=${briefStack(new Error())}`)
      flushLastExitRecord(typeof exitCode === 'number' ? exitCode : 0)
      return original(exitCode as number)
    } as typeof app.exit
    app.exit = wrapped
  } catch {
    // 拦截失败仅损失取证精度，不影响运行
  }
  try {
    const original = process.exit.bind(process)
    const wrapped = function patchedProcessExit(code?: number): never {
      recordEvent('process.exit', `code=${code} stack=${briefStack(new Error())}`)
      flushLastExitRecord(typeof code === 'number' ? code : 0)
      return original(code)
    } as typeof process.exit
    process.exit = wrapped
  } catch {
    // 拦截失败仅损失取证精度，不影响运行
  }
}

/**
 * whenReady 后最早时机调用（userData 在 ready 前不可用）：
 * 幂等；注册心跳 / 退出码 / 事件日志 / 正常退出清理四通道。
 */
export function initExitForensics(): void {
  if (bootId) return // 幂等：防止重复注册监听器

  bootId = randomUUID()
  readStaleEvidence()
  writeHeartbeat()

  installExitCallSpies()

  heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS)
  // 绝不因取证心跳阻碍进程退出
  heartbeatTimer.unref?.()

  // 退出链事件：区分"显式退出调用"与"事件循环排空/外部终止"
  app.on('before-quit', (event) => {
    recordEvent('before-quit', `defaultPrevented=${event.defaultPrevented}`)
  })
  app.on('window-all-closed', () => {
    recordEvent('window-all-closed')
  })
  app.on('second-instance', () => {
    recordEvent('second-instance')
  })
  app.on('render-process-gone', (_event, _webContents, details) => {
    recordEvent('render-process-gone', `reason=${details?.reason} exitCode=${details?.exitCode}`)
  })
  app.on('child-process-gone', (_event, details) => {
    recordEvent(
      'child-process-gone',
      `type=${details?.type} reason=${details?.reason} exitCode=${details?.exitCode}`
    )
  })
  // beforeExit = 事件循环排空后、进程自然退出前的最后机会（Node 规范：只做同步操作）
  process.on('beforeExit', (code) => {
    recordEvent('beforeExit', `code=${code}（事件循环自然排空，无显式退出调用）`)
  })

  // 退出码落盘：Node 规范要求 exit 事件处理器内只做同步操作
  process.on('exit', (code) => {
    flushLastExitRecord(code)
  })

  // 正常退出收尾：停摆心跳 + 删除心跳，使下次启动不误报异常终止
  app.on('will-quit', () => {
    recordEvent('will-quit')
    stopHeartbeatTimer()
    try {
      fs.rmSync(getHeartbeatPath(), { force: true })
    } catch {
      // 静默：清理失败仅会导致下次启动多一条 info 级判别记录
    }
  })

  diagLog('EXIT-FX', `exit forensics initialized, bootId=${bootId}`)
}

/** 里程碑打点：boot → when-ready → initialized → cleanup；随下一次心跳落盘 */
export function markExitStage(stage: string): void {
  currentStage = stage
}

/**
 * 正常清理完成（performCleanup 末尾调用）：停摆心跳 + 删除心跳 + 标记 cleanup 阶段。
 * 顺序必须是先停表再删文件：只删不停表时，5s tick 会把心跳复活，
 * 下次启动看到「有心跳、无退出码」就被判成原生层杀死（GPU 兼容阶梯据此白升一档）。
 */
export function markCleanShutdown(): void {
  markExitStage('cleanup')
  stopHeartbeatTimer()
  try {
    fs.rmSync(getHeartbeatPath(), { force: true })
  } catch {
    // 静默：清理失败不影响退出流程
  }
}

/**
 * 「清理并重启」专用（F3，2026-11-15）：taskkill /F 杀掉的僵尸/实例必然留下
 * 陈旧心跳（pid 已死、无退出码）——这正是 classifyPreviousExit 判 native 的形状。
 * 不清掉就 relaunch，新实例会把「我们主动的杀进程」误判成「被原生层杀死」，
 * GPU 兼容阶梯白升一档（fallbackActive 被永久置位 → 健康机器被静默降级软件渲染）。
 * 本进程是锁失败实例，从未 initExitForensics（F2），无需停表，直接删文件即可。
 */
export function clearDeathEvidenceForRelaunch(): void {
  try {
    fs.rmSync(getHeartbeatPath(), { force: true })
  } catch {
    // 静默：清证据失败不影响重启流程（最坏情况是新实例多一条误判、兼容档多升一档、
    // 封顶 2 级；档位仅在版本更新或用户开启硬件加速时复位，同版本内不会自动重试）
  }
}
