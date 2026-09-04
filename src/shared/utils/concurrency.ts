/**
 * 固定并发遍历：以 limit 并发执行 task(ids[index])，返回与 ids 下标一一对应的 settled 结果。
 * 单个任务失败不中断其余任务。支持 onProgress（每完成一项回调已完成的个数）与
 * signal（取消时停止派发新任务；已在途任务由其自身对 signal 的监听决定中断）。
 */
export async function settleWithConcurrency<T>(
  ids: string[],
  limit: number,
  task: (id: string) => Promise<T>,
  onProgress?: (completed: number) => void,
  signal?: AbortSignal
): Promise<PromiseSettledResult<T>[]> {
  const results = new Array<PromiseSettledResult<T> | undefined>(ids.length)
  let cursor = 0
  let completed = 0

  const worker = async (): Promise<void> => {
    while (cursor < ids.length) {
      if (signal?.aborted) return
      const index = cursor
      cursor += 1
      const [settled] = await Promise.allSettled([task(ids[index])])
      results[index] = settled
      completed += 1
      onProgress?.(completed)
    }
  }

  const workerCount = Math.min(limit, ids.length)
  await Promise.all(Array.from({ length: workerCount }, worker))
  return results as PromiseSettledResult<T>[]
}
