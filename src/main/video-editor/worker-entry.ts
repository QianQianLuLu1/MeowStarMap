/**
 * 视频编辑 worker 进程入口
 *
 * 由主进程通过 utilityProcess.fork() 启动，承载视频滤镜渲染的 ffmpeg 调用。
 * - 通过 process.parentPort 与主进程通信（EDIT_START/STOP/DISPOSE → EDIT_PROGRESS/COMPLETE/LOG）
 * - 复用 runFfmpegCommand 统一处理 trackFfmpegCommand / 超时 / end/error 事件
 * - 单任务派发：bridge 通过 runWithConcurrency 控制批量并发，worker 一次只处理一条任务
 * - 收到 EDITOR_DISPOSE 时主动 kill 子进程 + 退出
 *
 * 详见 docs/VIDEO_EDIT_PLAN.md §9。
 */
import fsp from 'fs/promises'
import path from 'path'
import ffmpeg from 'fluent-ffmpeg'
import { runFfmpegCommand } from '../utils/ffmpeg-runner'
import { killAllProcesses } from '../utils/process-registry'
import { t } from '../i18n/worker-safe'
import { buildColorFilter } from './filter-builder'
import { buildWatermarkFilter } from './watermark-builder'
import type { VideoEditTaskPayload } from './worker-protocol'
import type { VideoEditorCommand, VideoEditorEvent } from './worker-protocol'
import type { VideoEditTask } from './types'
import { installFfmpegSpawnGuard } from '../utils/fluent-ffmpeg-shim'

// fluent-ffmpeg spawn 逃逸垫片：本 worker 任何 ffmpeg .run() 之前尽早安装（幂等）。
// 将损坏二进制导致的 spawn 同步抛错（EFTYPE）收敛为回调错误，避免 worker 进程崩溃。
installFfmpegSpawnGuard()

// ============ 常量 ============

/** 单任务默认超时 10 分钟（视频滤镜重编码耗时较长） */
const DEFAULT_VIDEO_EDIT_TIMEOUT_MS = 10 * 60 * 1000
/** 速度范围（与 video-service.ts 保持一致） */
const MIN_SPEED = 0.25
const MAX_SPEED = 4.0

// ============ 状态 ============

/** 用户请求停止：ffmpeg progress 回调中检查并主动 kill */
let shouldStop = false
// FIX(组16-2): 被取消的任务批次 ID——EDIT_STOP 时记录当前任务的 taskId，
// 该批次在消息队列中已排队但未开始的任务直接跳过（原实现 handleEditStart 开头
// 无条件 shouldStop=false，批量取消时排队任务仍被完整执行）
let cancelledTaskId: string | null = null
// FIX(组16-2): 当前执行中的 ffmpeg 命令句柄——EDIT_STOP 时立即 kill，
// 原先仅置 shouldStop 标志，当前编码会完整执行（单任务超时上限 10 分钟）后才被当作部分输出清理
let activeCommand: ffmpeg.FfmpegCommand | null = null

/** 当前任务载荷（用于异常退出时合成 EDIT_COMPLETE） */
let currentPayload: VideoEditTaskPayload | null = null

// ============ 工具方法 ============

/** 发送事件到主进程（parentPort 不可用时静默丢弃） */
function sendEvent(event: VideoEditorEvent): void {
  try {
    process.parentPort?.postMessage(event)
  } catch {
    // parentPort 不可用时丢弃事件，避免日志本身导致 worker 崩溃
  }
}

/** 发送日志到主进程（warn/error 级别，info 级别丢弃以减少 IPC 开销） */
function workerLog(level: 'warn' | 'error', message: string): void {
  sendEvent({ type: 'EDITOR_LOG', payload: { level, message } })
}

// ============ 进度推送（500ms 节流） ============

let lastProgressEmit = 0

/**
 * 推送进度事件。
 * - 首次推送立即发送
 * - 后续按 500ms 节流（避免 ffmpeg 高频 progress 事件打满 IPC）
 * - current ≥ total 时强制发送（终态）
 */
function emitProgress(current: number, total: number, message: string): void {
  const now = Date.now()
  if (now - lastProgressEmit < 500 && current < total) return
  lastProgressEmit = now
  const percent = total > 0 ? Math.min(100, Math.floor((current / total) * 100)) : 0
  sendEvent({
    type: 'EDIT_PROGRESS',
    payload: { current, total, percent, message }
  })
}

/** 强制推送进度（用于终态前的最后一次进度） */
function emitProgressForce(current: number, total: number, message: string): void {
  lastProgressEmit = 0
  emitProgress(current, total, message)
}

// ============ Atempo 滤镜链构建 ============

/**
 * 构建 atempo 滤镜链（atempo 单次范围 0.5-2.0，超出则链式分解）。
 *
 * 与 video-service.ts 的 buildAtempoChain 逻辑保持一致：
 * - speed > 2.0：分解为多个 2.0 相乘（如 4.0 = atempo=2.0,atempo=2.0）
 * - speed < 0.5：分解为多个 0.5 相乘（如 0.25 = atempo=0.5,atempo=0.5）
 */
function buildAtempoChain(speed: number): string {
  const factors: number[] = []
  let remaining = speed
  let iter = 0
  const MAX_ITER = 20
  while (remaining > 2.0 && iter < MAX_ITER) {
    factors.push(2.0)
    remaining /= 2.0
    iter++
  }
  while (remaining < 0.5 && iter < MAX_ITER) {
    factors.push(0.5)
    remaining /= 0.5
    iter++
  }
  if (remaining > 2.0) remaining = 2.0
  else if (remaining < 0.5) remaining = 0.5
  factors.push(Number(remaining.toFixed(6)))
  return factors.map((f) => `atempo=${f}`).join(',')
}

// ============ 单任务处理 ============

/**
 * 处理单条视频编辑任务。
 *
 * 构建顺序：
 * 1. 调色滤镜（buildColorFilter）→ -vf/-filter_complex 一部分
 * 2. 水印滤镜（buildWatermarkFilter）→ 图片水印走 -filter_complex，文本水印追加到主滤镜
 * 3. 调速滤镜（setpts + atempo）→ 追加到视频滤镜 / 音频滤镜
 * 4. 裁剪区间 → 通过 seekInput + duration 实现（不进滤镜）
 *
 * 滤镜合并策略：
 * - 仅 -vf 场景（无图片水印）：调色 + 文本水印 + setpts 合并到 -vf，atempo 走 -af
 * - -filter_complex 场景（有图片水印）：所有视频滤镜合并到 filter_complex，atempo 走 -af
 */
async function processSingleTask(payload: VideoEditTaskPayload): Promise<void> {
  const { task, index, total } = payload
  const { inputPath, outputPath, params, watermark, speed } = task

  // 参数校验：输入路径必填
  if (!inputPath || inputPath.length === 0) {
    throw new Error(t('main.videoEditor.error.inputPathRequired'))
  }
  if (!outputPath || outputPath.length === 0) {
    throw new Error(t('main.videoEditor.error.outputPathRequired'))
  }
  // 速度范围校验（与 video-service.ts 一致）
  if (speed !== null && speed !== undefined) {
    if (speed < MIN_SPEED || speed > MAX_SPEED) {
      throw new Error(
        t('main.videoEditor.error.unsupportedSpeed', {
          speed: String(speed),
          min: String(MIN_SPEED),
          max: String(MAX_SPEED)
        })
      )
    }
  }

  // 确保输出目录存在
  await fsp.mkdir(path.dirname(outputPath), { recursive: true })

  // 构建调色 + 水印滤镜
  const colorFilter = buildColorFilter(params)
  const watermarkFilter = buildWatermarkFilter(watermark ?? null)

  // 构建 setpts 滤镜（调速）
  let videoFilterParts: string[] = []
  let audioFilter = ''
  if (speed !== null && speed !== undefined && speed !== 1) {
    videoFilterParts.push(`setpts=${(1 / speed).toFixed(6)}*PTS`)
    audioFilter = buildAtempoChain(speed)
  }

  // 合并滤镜到 filterComplex 或 -vf
  let useFilterComplex = false
  let combinedFilter = ''
  let inputs: string[] = []

  if (watermarkFilter.useFilterComplex) {
    // 图片水印场景：使用 -filter_complex
    useFilterComplex = true
    inputs = watermarkFilter.inputs
    // 调色滤镜和 setpts 追加到主视频流（[0:v]）之前
    const mainChainParts: string[] = []
    if (colorFilter) mainChainParts.push(colorFilter)
    // setpts 在 watermarkFilter 之前应用到 [0:v]
    if (videoFilterParts.length > 0) {
      mainChainParts.push(...videoFilterParts)
      videoFilterParts = [] // 已合并，避免重复
    }

    if (mainChainParts.length > 0) {
      // 在 watermarkFilter 之前对 [0:v] 应用调色+setpts
      const mainChain = mainChainParts.join(',')
      // watermarkFilter.filter 形如 "[1:v]...[wm];[0:v][wm]overlay=..."
      // 需要把 [0:v] 之前的滤镜注入：[0:v]chain[0v];[0v][wm]overlay
      combinedFilter = injectMainChain(watermarkFilter.filter, mainChain)
    } else {
      combinedFilter = watermarkFilter.filter
    }
  } else {
    // 文本水印或无水印场景：使用 -vf
    const vfParts: string[] = []
    if (colorFilter) vfParts.push(colorFilter)
    if (videoFilterParts.length > 0) vfParts.push(...videoFilterParts)
    if (watermarkFilter.filter) vfParts.push(watermarkFilter.filter)
    combinedFilter = vfParts.join(',')
    videoFilterParts = [] // 已合并
  }

  // 兜底：未消耗的 videoFilterParts（理论上不会发生，但健壮底线）
  if (videoFilterParts.length > 0) {
    combinedFilter = combinedFilter
      ? `${combinedFilter},${videoFilterParts.join(',')}`
      : videoFilterParts.join(',')
  }

  emitProgress(
    index,
    total,
    t('main.videoEditor.message.progressStart', {
      current: String(index + 1),
      total: String(total)
    })
  )

  try {
    await runFfmpegCommand(
      inputPath,
      (cmd) => configureCommand(cmd, task, combinedFilter, useFilterComplex, inputs, audioFilter),
      DEFAULT_VIDEO_EDIT_TIMEOUT_MS,
      `视频编辑 #${index}`,
      // FIX(组16-2): 持有当前 ffmpeg 命令句柄，EDIT_STOP 到达时立即 kill
      (command) => {
        activeCommand = command
      }
    )

    // 成功完成
    if (shouldStop) {
      // 用户在 ffmpeg 执行过程中取消：清理部分输出
      await cleanupPartialOutput(outputPath)
      throw new Error(t('main.videoEditor.error.cancelledByUser'))
    }
    emitProgressForce(
      index + 1,
      total,
      t('main.videoEditor.message.progressDone', {
        current: String(index + 1),
        total: String(total)
      })
    )
  } catch (err) {
    // 失败时清理部分输出
    await cleanupPartialOutput(outputPath)
    throw err
  } finally {
    // FIX(组16-2): 任务结束（含被 kill）后释放命令句柄
    activeCommand = null
  }
}

/**
 * 把主视频流滤镜链（调色+setpts）注入到 watermarkFilter 的 [0:v] 之前。
 *
 * 输入形如：`[1:v]scale=...[wm];[0:v][wm]overlay=x:y`
 * 输出形如：`[0:v]eq=...,setpts=...[0v];[1:v]scale=...[wm];[0v][wm]overlay=x:y`
 */
function injectMainChain(watermarkFilter: string, mainChain: string): string {
  // 简化策略：把 [0:v] 替换为 [0:v]mainChain[0v]
  // 假设 watermarkFilter 以 "[1:v]" 开头，"[0:v]" 出现在 overlay 段
  const label = '[0v]'
  // 在 watermarkFilter 之前插入主链：[0:v]chain[0v];<原 filter 中 [0:v] 替换为 [0v]>
  const rewritten = watermarkFilter.replace(/\[0:v\]/g, label)
  return `[0:v]${mainChain}${label};${rewritten}`
}

/**
 * 配置 ffmpeg 命令：滤镜 / 输入 / 输出选项 / 进度回调。
 */
function configureCommand(
  cmd: ffmpeg.FfmpegCommand,
  task: VideoEditTask,
  combinedFilter: string,
  useFilterComplex: boolean,
  inputs: string[],
  audioFilter: string
): ffmpeg.FfmpegCommand {
  let c = cmd

  // 裁剪区间：seekInput + duration（不影响滤镜）
  if (task.trim) {
    c = c.seekInput(task.trim.start)
    const duration = task.trim.end - task.trim.start
    c = c.duration(duration)
  }

  // 图片水印的额外输入
  for (const input of inputs) {
    c = c.input(input)
  }

  // 滤镜
  if (combinedFilter) {
    if (useFilterComplex) {
      c = c.outputOptions('-filter_complex', combinedFilter)
      // filter_complex 模式下需显式 map 输出流
      c = c.outputOptions('-map', '0:v')
      // 若有音频则映射
      c = c.outputOptions('-map', '0:a?')
    } else {
      c = c.outputOptions('-vf', combinedFilter)
    }
  }
  // 音频滤镜（调速时 atempo）
  if (audioFilter) {
    c = c.outputOptions('-af', audioFilter)
  }

  // 编码参数：libx264 medium crf=23（平衡速度与质量）
  c = c.outputOptions('-c:v', 'libx264', '-preset', 'medium', '-crf', '23')
  // 音频编码：AAC 128k
  c = c.outputOptions('-c:a', 'aac', '-b:a', '128k')

  // 输出路径
  c = c.output(task.outputPath)

  // 进度回调（fluent-ffmpeg progress 事件）
  c.on('progress', (info: { percent?: number }) => {
    if (shouldStop) return
    const percent = info.percent ?? 0
    if (currentPayload) {
      const { index, total } = currentPayload
      // 把单视频进度（0-100%）映射到批量进度（index + percent/100）
      const batchProgress = index + Math.min(1, percent / 100)
      emitProgress(batchProgress, total, `处理中 ${percent.toFixed(0)}%`)
    }
  })

  return c
}

/** 清理部分输出文件（失败 / 取消时调用） */
async function cleanupPartialOutput(outputPath: string): Promise<void> {
  try {
    await fsp.unlink(outputPath)
  } catch {
    // 文件不存在或已被清理，忽略
  }
}

// ============ 资源清理与退出 ============

/**
 * worker 退出前清理：kill 所有子进程 + 退出。
 * 必须使用同步操作，避免异步 I/O 延迟进程退出。
 */
function cleanupAndExit(): void {
  try {
    killAllProcesses('SIGKILL')
  } catch {}
  process.exit(0)
}

// ============ 消息处理 ============

/**
 * 消息队列：批量模式下 bridge 可能并发发送多个 EDIT_START，
 * 但 ffmpeg 是 CPU 密集型，worker 一次只处理一条任务。
 * 收到 EDIT_START 时若 isProcessing=true，加入队列等待；否则立即处理。
 */
const messageQueue: VideoEditorCommand[] = []
let isProcessing = false

/** 处理单条 EDIT_START 指令 */
async function handleEditStart(payload: VideoEditTaskPayload): Promise<void> {
  // FIX(组16-2): 已取消批次中排队未开始的任务直接跳过——原实现开头无条件 shouldStop=false，
  // 批量取消时消息队列中已排队的任务仍被完整执行（UI 已显示"已取消"但 worker 持续满载编码）
  if (cancelledTaskId !== null && payload.taskId === cancelledTaskId) {
    sendEvent({
      type: 'EDIT_COMPLETE',
      payload: {
        success: false,
        message: t('main.videoEditor.error.taskCancelledSkipped'),
        index: payload.index
      }
    })
    return
  }
  // 不同 taskId 的新任务批次：解除上一轮取消状态
  cancelledTaskId = null
  shouldStop = false
  currentPayload = payload
  const { index, task } = payload
  try {
    await processSingleTask(payload)
    sendEvent({
      type: 'EDIT_COMPLETE',
      payload: {
        success: true,
        message: t('main.videoEditor.message.exportSuccess', {
          filename: path.basename(task.outputPath)
        }),
        index,
        outputPath: task.outputPath
      }
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    sendEvent({
      type: 'EDIT_COMPLETE',
      payload: {
        success: false,
        message: shouldStop
          ? t('main.videoEditor.error.taskCancelled', { reason: message })
          : t('main.videoEditor.error.exportFailed', { reason: message }),
        index
      }
    })
  } finally {
    currentPayload = null
  }
}

/** 从队列取下一条 EDIT_START 处理（串行） */
async function drainQueue(): Promise<void> {
  if (isProcessing) return
  const next = messageQueue.shift()
  if (!next) return
  isProcessing = true
  try {
    if (next.type === 'EDIT_START') {
      await handleEditStart(next.payload)
    }
  } finally {
    isProcessing = false
    // 队列还有任务则继续处理
    if (messageQueue.length > 0) {
      drainQueue().catch(() => {
        /* 队列处理失败忽略，下条消息会重新触发 */
      })
    }
  }
}

// utilityProcess 中 parentPort 推送的 'message' 事件参数是 Node.js 的 MessageEvent（仅含 data 字段）。
// 此处用最小结构类型 { data: unknown } 避免与 lib.dom.d.ts 的 MessageEvent 冲突。
process.parentPort?.on('message', (event: { data: unknown }) => {
  const msg = event.data as VideoEditorCommand

  if (msg.type === 'EDIT_START') {
    messageQueue.push(msg)
    drainQueue().catch((err) => {
      workerLog('error', `队列处理异常: ${err instanceof Error ? err.message : String(err)}`)
    })
  } else if (msg.type === 'EDIT_STOP') {
    // FIX(组16-2): 取消必须立即终止进行中的 ffmpeg——原先仅置 shouldStop 标志，
    // 当前编码会完整执行后才被当作部分输出清理，期间 worker 持续满载编码。
    // kill 使 ffmpeg 触发 error 事件 → runFfmpegCommand reject → 走取消清理路径
    shouldStop = true
    cancelledTaskId = currentPayload?.taskId ?? null
    try {
      activeCommand?.kill('SIGKILL')
    } catch {}
    workerLog('warn', t('main.videoEditor.log.editStopReceived'))
  } else if (msg.type === 'EDITOR_DISPOSE') {
    cleanupAndExit()
  }
})

// ============ 兜底清理 ============

// process.exit 触发时清理
process.on('exit', cleanupAndExit)

// 未捕获异常：发送 WORKER_ERROR 后清理退出
process.on('uncaughtException', (err) => {
  sendEvent({
    type: 'WORKER_ERROR',
    payload: { message: err.message, stack: err.stack }
  })
  cleanupAndExit()
})

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason))
  sendEvent({
    type: 'WORKER_ERROR',
    payload: { message: err.message, stack: err.stack }
  })
  cleanupAndExit()
})

// ============ 启动完成通知 ============

// 向主进程发送 WORKER_READY，表示 worker 已就绪可接收 EDIT_START
sendEvent({ type: 'WORKER_READY' })
