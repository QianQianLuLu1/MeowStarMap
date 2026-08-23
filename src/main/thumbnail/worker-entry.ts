/**
 * 缩略图单文件生成 worker 进程入口
 *
 * 由主进程通过 utilityProcess.fork() 启动，承载 sharp 缩放实现（迁移自 ThumbnailGenerator）。
 * - 通过 process.parentPort 与主进程通信（THUMBNAIL_PROCESS_START/DISPOSE → THUMBNAIL_PROCESS_COMPLETE/LOG）
 * - 收到 THUMBNAIL_WORKER_DISPOSE 时主动退出
 * - sharp 是 native 模块，由 Node.js require 机制解析（与 media-worker 一致，无需手动修正 asar 路径）
 *
 * 设计要点：
 * 1. 常量与主进程 ThumbnailGenerator 完全一致（避免 IPC 传参），复制一份维护
 * 2. 三档处理函数：processStandard / processLow / processHigh
 * 3. processStandard 同步生成 _low（与主进程 doGenerate 一致）
 * 4. processLow 优先从 standard 缩放（更快），否则从原文件生成
 * 5. sharp 是 async（基于 libuv 线程池），多个 THUMBNAIL_PROCESS_START 自然并发，无需队列调度
 * 6. cacheDir 由主进程在每次请求时传入（支持运行时 setDir 切换目录）
 */
import fsp from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import { pathExists } from '../utils/file-utils'
import type {
  ThumbnailWorkerCommand,
  ThumbnailWorkerEvent,
  ThumbnailProcessInput,
  ThumbnailProcessOutput
} from './worker-protocol'

// ============ 常量（与主进程 ThumbnailGenerator 保持一致，禁止改值） ============

const STANDARD_MAX_WIDTH = 320
const STANDARD_MAX_HEIGHT = 320
const STANDARD_QUALITY = 85

const LOW_MAX_WIDTH = 64
const LOW_MAX_HEIGHT = 64
const LOW_QUALITY = 30

const HIGH_MAX_WIDTH = 512
const HIGH_MAX_HEIGHT = 512
const HIGH_QUALITY = 90

/** 发送事件到主进程 */
function sendEvent(event: ThumbnailWorkerEvent): void {
  try {
    process.parentPort?.postMessage(event)
  } catch {
    // parentPort 不可用时丢弃事件
  }
}

// ============ 三档 sharp 处理 ============

/**
 * 标准档位（320×320, q85, progressive）。
 * 与主进程 doGenerate 中 sharp 段一致：fit=inside, withoutEnlargement=true。
 *
 * 同时同步生成 _low 版本（从刚生成的标准缩略图缩放），失败不阻断主流程。
 * 与主进程 doGenerate 第 421~436 行逻辑保持一致。
 *
 * @returns { path, size } 标准缩略图路径与文件大小
 */
async function processStandard(
  input: ThumbnailProcessInput
): Promise<{ path: string; size: number }> {
  const { filePath, fileHash, cacheDir } = input
  const thumbnailPath = path.join(cacheDir, `${fileHash}.jpg`)

  await sharp(filePath)
    .resize(STANDARD_MAX_WIDTH, STANDARD_MAX_HEIGHT, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({ quality: STANDARD_QUALITY, progressive: true })
    .toFile(thumbnailPath)

  // 同步生成 _low（与主进程 doGenerate 一致）
  const lowPath = path.join(cacheDir, `${fileHash}_low.jpg`)
  if (!(await pathExists(lowPath))) {
    try {
      await sharp(thumbnailPath)
        .resize(LOW_MAX_WIDTH, LOW_MAX_HEIGHT, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: LOW_QUALITY })
        .toFile(lowPath)
    } catch {
      // 低质量生成失败不影响标准缩略图返回（与主进程行为一致）
    }
  }

  const size = (await fsp.stat(thumbnailPath).catch(() => ({ size: 0 }))).size
  return { path: thumbnailPath, size }
}

/**
 * 低质量档位（64×64, q30）。
 * 与主进程 doGenerateLow 一致：优先从标准缩略图缩放（更快），否则从原文件生成。
 */
async function processLow(input: ThumbnailProcessInput): Promise<{ path: string; size: number }> {
  const { filePath, fileHash, cacheDir } = input
  const lowPath = path.join(cacheDir, `${fileHash}_low.jpg`)
  const standardPath = path.join(cacheDir, `${fileHash}.jpg`)
  const sourcePath = (await pathExists(standardPath)) ? standardPath : filePath

  await sharp(sourcePath)
    .resize(LOW_MAX_WIDTH, LOW_MAX_HEIGHT, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({ quality: LOW_QUALITY })
    .toFile(lowPath)

  const size = (await fsp.stat(lowPath).catch(() => ({ size: 0 }))).size
  return { path: lowPath, size }
}

/**
 * 高清档位（512×512, q90, progressive）。
 * 与主进程 doGenerateHigh 中 sharp 段一致：fit=inside, withoutEnlargement=true。
 */
async function processHigh(input: ThumbnailProcessInput): Promise<{ path: string; size: number }> {
  const { filePath, fileHash, cacheDir } = input
  const highPath = path.join(cacheDir, `${fileHash}_high.jpg`)

  await sharp(filePath)
    .resize(HIGH_MAX_WIDTH, HIGH_MAX_HEIGHT, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({ quality: HIGH_QUALITY, progressive: true })
    .toFile(highPath)

  const size = (await fsp.stat(highPath).catch(() => ({ size: 0 }))).size
  return { path: highPath, size }
}

// ============ 单文件处理入口 ============

/**
 * 处理单个缩略图请求。
 * sharp 解码失败时回传 success=false + errorMessage，由主进程决定是否走 markCorrupted。
 */
async function processImage(input: ThumbnailProcessInput): Promise<ThumbnailProcessOutput> {
  const { requestId, quality } = input

  // 兜底：确保 cacheDir 存在（主进程通常已创建，但 setDir 切换目录后首次请求可能未创建）
  try {
    await fsp.mkdir(input.cacheDir, { recursive: true })
  } catch (err) {
    return {
      requestId,
      success: false,
      outputPath: null,
      errorMessage: `cacheDir 创建失败: ${err instanceof Error ? err.message : String(err)}`,
      outputSize: 0
    }
  }

  try {
    let result: { path: string; size: number }
    switch (quality) {
      case 'low':
        result = await processLow(input)
        break
      case 'high':
        result = await processHigh(input)
        break
      case 'standard':
      default:
        result = await processStandard(input)
        break
    }
    return {
      requestId,
      success: true,
      outputPath: result.path,
      errorMessage: '',
      outputSize: result.size
    }
  } catch (err) {
    // sharp 解码失败（文件损坏、格式不支持等）：回传失败，主进程走 markCorrupted
    return {
      requestId,
      success: false,
      outputPath: null,
      errorMessage: err instanceof Error ? err.message : String(err),
      outputSize: 0
    }
  }
}

// ============ 资源清理与退出 ============

/**
 * worker 退出前清理。
 * 单文件 worker 无 DB 连接、无子进程，仅同步退出。
 */
function cleanupAndExit(): void {
  process.exit(0)
}

// ============ 消息处理 ============

// utilityProcess 的 parentPort 'message' 事件参数是 Node.js MessageEvent（仅 data 字段）
// 用最小结构类型避免与 lib.dom.d.ts 的 MessageEvent 冲突
process.parentPort?.on('message', async (event: { data: unknown }) => {
  const msg = event.data as ThumbnailWorkerCommand
  if (msg.type === 'THUMBNAIL_PROCESS_START') {
    // 异步处理，sharp 自身 async 基于线程池，多个请求自然并发
    const output = await processImage(msg.payload)
    sendEvent({ type: 'THUMBNAIL_PROCESS_COMPLETE', payload: output })
  } else if (msg.type === 'THUMBNAIL_WORKER_DISPOSE') {
    cleanupAndExit()
  }
})

// ============ 兜底清理 ============

process.on('exit', cleanupAndExit)

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

// 向主进程发送 WORKER_READY，表示 worker 已就绪可接收 THUMBNAIL_PROCESS_START
sendEvent({ type: 'WORKER_READY' })
