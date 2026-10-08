/**
 * motion 命令式 `animate()` 的测试桩注册表
 *
 * jsdom 下没有可控的动画时间轴（无真实 rAF 驱动、时长不可控），故 `tests/setup.ts`
 * 把 `animate()` 替换为同步桩：立即把值推进到终态并触发 `onComplete`。
 * 为了让测试仍能断言动画语义（前沿 / 后沿用了不同 ease、切换前先 stop 上一段），
 * 桩把每次调用记录在此，本模块提供类型化的读写入口。
 *
 * 记录挂在 `globalThis` 而非模块变量：setup 与测试文件可能落在不同的模块实例上，
 * globalThis 保证两侧看到同一份数组。
 */

export interface MotionAnimateOptions {
  duration?: number
  ease?: readonly number[] | string
  onUpdate?: (value: number) => void
  onComplete?: () => void
}

export interface MotionAnimateCall {
  from: number
  to: number
  options: MotionAnimateOptions
  /** `stop()` / `cancel()` 累计调用次数：用于断言「切换前先停掉上一段动画」 */
  stopped: number
}

const KEY = '__motionAnimateCalls'

type MotionAnimateRegistry = { [KEY]?: MotionAnimateCall[] }

export function recordMotionAnimateCall(call: MotionAnimateCall): void {
  const store = globalThis as unknown as MotionAnimateRegistry
  if (!store[KEY]) store[KEY] = []
  store[KEY]?.push(call)
}

export function getMotionAnimateCalls(): MotionAnimateCall[] {
  return (globalThis as unknown as MotionAnimateRegistry)[KEY] ?? []
}

export function resetMotionAnimateCalls(): void {
  ;(globalThis as unknown as MotionAnimateRegistry)[KEY] = []
}
