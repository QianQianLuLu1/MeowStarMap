/**
 * 原生并发控制（替代 p-limit，避免 ESM/CJS 兼容问题）
 * p-limit v7 为纯 ESM，主进程编译为 CommonJS 后 require() 失败
 */

export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let nextIndex = 0

  const runNext = async (): Promise<void> => {
    while (nextIndex < tasks.length) {
      const index = nextIndex++
      results[index] = await tasks[index]()
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => runNext())
  await Promise.all(workers)
  return results
}

/**
 * 有状态并发信号量（与 runWithConcurrency 的区别）：
 * runWithConcurrency 是"一次性批处理"——拿到整批任务后按并发数跑完即丢弃状态；
 * createConcurrencyLimiter 返回的函数是长生命周期的——每次调用都复用同一个许可池，
 * 适合"任务逐张到来"的场景（如渲染层滚动大库时逐张请求的缩略图解码）。
 *
 * 用同一个 limit 约束全局同时执行的异步任务数，超出的请求在内部排队，
 * 不创建新 Promise worker 池，也不消耗外层超时预算（计时器在拿到许可后才启动）。
 *
 * @param limit 同时执行的最大任务数（应取 CPU 核数相关值，调用方负责 Math.max(1, ...) 兜底）
 */
export function createConcurrencyLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  // 兜底：limit 非法（0 / 负数 / NaN）会让队列永远无法放行，退化为串行而非死锁
  const max = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1
  let active = 0
  const queue: Array<() => void> = []

  // 释放一个许可后尝试放行队首任务；active 未满且队列非空时持续放行
  const pump = (): void => {
    if (active >= max || queue.length === 0) return
    active++
    const run = queue.shift()!
    run()
  }

  return <T>(task: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        // 用 async 包裹调用：task 同步抛错时转为 rejected promise，
        // 否则异常会越过 finally 逃逸出 Promise 执行器，许可永不归还（limit=1 时死锁）
        void (async () => task())()
          .then(resolve, reject)
          .finally(() => {
            active--
            pump()
          })
      }
      queue.push(run)
      pump()
    })
  }
}
