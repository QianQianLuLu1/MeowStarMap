/**
 * fluent-ffmpeg spawn 同步抛错逃逸垫片（节点5，plan: fix-spawn-eftype-crash）
 *
 * 根因：fluent-ffmpeg@2.1.3 的 `_spawnFfmpeg`（processor.js:113）在 `_getFfmpegPath` 回调内
 * 同步调用 `spawn()`（processor.js:150）。Windows 遇到被截断/损坏的 ffmpeg 二进制时，spawn 会
 * 「同步抛出 EFTYPE」。而 `.run()`/`getAvailableFormats` 的能力探测链路被 fluent-ffmpeg 内嵌的
 * async@0.2.10 放进 setImmediate 宏任务（async.js:497-503）：外层 try/catch 与 Promise executor
 * 均已退出该宏任务的调用栈，`.on('error')`（processor.js:156）也永不到达（spawn 尚未返回进程对象
 * 就抛错了）→ 逃逸为进程级 uncaughtException → early-crash-guard 弹「Runtime Error: spawn EFTYPE」，
 * 同时视频帧从未抽取 → 缩略图缺失（两症状同源）。
 *
 * 修复策略：monkey-patch `FfmpegCommand.prototype._spawnFfmpeg`，用 try/catch 包裹原始实现。
 * 一旦 spawn 同步抛错，精确复刻 processor.js:114-125 的两步参数归一化定位真正的 `endCB`，
 * 把错误作为回调首参 `endCB(e)` 送回——等价于异步 `.on('error')` 的效果，从而复用既有
 * reject/markCorrupted/return null 的优雅降级链路，不再升级为致命弹窗。
 *
 * 风险与约束：
 * - 本垫片依赖 fluent-ffmpeg 私有方法 `_spawnFfmpeg` 的存在与参数约定。**升级该库必须回归本垫片**；
 *   若结构变更（方法缺失/更名），断言失败时仅 `diagLog` 告警并跳过安装，绝不自身抛入 uncaughtException。
 * - 无 endCB 的调用形态（如直接 `_spawnFfmpeg(args, options)`）在归一化后 ecb 非函数时 rethrow，
 *   不吞真错，保持与原始语义一致。
 * - 幂等：多入口/多次 import 只应包裹一次。采用模块级布尔（而非挂在 prototype 上的 Symbol），
 *   以便 vi.resetModules 重置本模块时同步重置标记，避免跨用例重复包裹导致的语义漂移。
 */
import ffmpeg from 'fluent-ffmpeg'
import { diagLog } from './startup-diagnostic'

/**
 * 幂等标记（模块级）。安装成功后置 true；vi.resetModules 会重置本模块从而重置该标记。
 */
let installed = false

/**
 * 安装 fluent-ffmpeg spawn 同步抛错逃逸垫片。
 *
 * 应在每个使用 ffmpeg 的进程入口（主进程 + media/scanner/video-editor worker）的启动早期、
 * 任何 `ffmpeg(...).run()` / 能力探测之前调用一次。重复调用为 no-op。
 */
export function installFfmpegSpawnGuard(): void {
  if (installed) return

  const proto = (ffmpeg as unknown as { prototype?: Record<string, unknown> }).prototype
  if (!proto) {
    // fluent-ffmpeg prototype 缺失（结构异常）：告警降级，不抛错
    diagLog('ffmpeg-shim', 'fluent-ffmpeg prototype missing, skip spawn guard install')
    return
  }

  const orig = proto._spawnFfmpeg
  if (typeof orig !== 'function') {
    // 结构变更（升级后私有方法更名/移除）：告警降级，绝不抛错
    diagLog(
      'ffmpeg-shim',
      'fluent-ffmpeg structure changed: _spawnFfmpeg is not a function, skip spawn guard install'
    )
    return
  }

  const original = orig as (...a: unknown[]) => unknown

  proto._spawnFfmpeg = function patchedSpawnFfmpeg(this: unknown, ...args: unknown[]): unknown {
    try {
      return original.apply(this, args)
    } catch (e) {
      // 精确复刻 processor.js:114-125 两步参数归一化，定位真正的 endCB。
      // 原始签名：_spawnFfmpeg(args, options, processCB, endCB)
      let options = args[1]
      let processCB = args[2]
      let endCB = args[3]

      // Enable omitting options：options 位置传入了函数
      if (typeof options === 'function') {
        endCB = processCB
        processCB = options
        options = {}
      }

      // Enable omitting processCB：未显式传 endCB 时，endCB 即 processCB
      if (typeof endCB === 'undefined') {
        endCB = processCB
      }

      if (typeof endCB === 'function') {
        // 把同步抛错降级为回调错误，复用既有 .on('error')/reject/降级链路
        ;(endCB as (err: unknown) => void)(e)
        return undefined
      }

      // 无回调形态：不吞真错，rethrow 保持原始语义
      throw e
    }
  }

  installed = true
}
