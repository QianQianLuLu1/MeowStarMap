/**
 * 预览 worker 桥（B0 可行性闸门 / B2 管线卸载的地基）
 *
 * 设计口径对齐主进程 `src/main/thumbnail/worker-bridge.ts`：READY 握手 + 超时兜底 +
 * 失败即回落，**任何情况下都不让预览变黑屏**。这里回落的含义是「继续用主线程渲染」，
 * 而不是「放弃渲染」。
 */

/** worker 脚本工厂；必须是 `() => new Worker(new URL('./x.ts', import.meta.url))` 字面量形式 */
export type PreviewWorkerFactory = () => Worker

/** READY 握手超时（毫秒）：超时即判定 worker 不可用 */
export const PREVIEW_WORKER_READY_TIMEOUT_MS = 3000

export interface PreviewWorkerHandle {
  readonly worker: Worker
  /** 握手完成后的运行期错误监听（此时不再回收 handle，由调用方决定重启还是回落） */
  attachErrorWatcher(listener: (message: string) => void): void
  terminate(): void
}

/** 只认 `{type:'READY'}` 对象；畸形/伪造消息不得误判为就绪 */
function isReadyHandshake(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'READY'
}

/**
 * 建立 bridge：构造 worker → 等 READY → 成功给 handle，失败给 null。
 * 永不 reject：预览可用性优先于「调用方必须处理异常」。
 */
export function createPreviewWorkerBridge(
  factory: PreviewWorkerFactory
): Promise<PreviewWorkerHandle | null> {
  if (typeof Worker === 'undefined') {
    return Promise.resolve(null)
  }

  return new Promise<PreviewWorkerHandle | null>((resolve) => {
    let worker: Worker
    try {
      worker = factory()
    } catch (err) {
      console.warn('[previewWorker] worker construct failed, preview stays on main thread', err)
      resolve(null)
      return
    }

    let settled = false
    let ready = false
    const errorListeners: Array<(message: string) => void> = []

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      console.warn('[previewWorker] READY timed out, preview stays on main thread')
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      resolve(null)
    }, PREVIEW_WORKER_READY_TIMEOUT_MS)

    const failOver = (reason: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      console.warn(`[previewWorker] ${reason}, preview stays on main thread`)
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      resolve(null)
    }

    worker.onmessage = (event: MessageEvent) => {
      if (settled || ready) return
      if (!isReadyHandshake(event.data)) return
      ready = true
      settled = true
      clearTimeout(timer)
      // 握手监听到此为止：后续消息由调用方接管；错误改为向运行期监听者广播
      worker.onmessage = null
      worker.onerror = (errorEvent) => {
        const message = String(errorEvent?.message ?? 'worker error')
        for (const listener of errorListeners) listener(message)
      }
      resolve({
        worker,
        attachErrorWatcher: (listener) => {
          errorListeners.push(listener)
        },
        terminate: () => {
          worker.onmessage = null
          worker.onerror = null
          worker.terminate()
        }
      })
    }

    worker.onerror = (event) => {
      if (ready) {
        const message = String(event?.message ?? 'worker error')
        for (const listener of errorListeners) listener(message)
        return
      }
      failOver(`handshake error: ${String(event?.message ?? '')}`)
    }
  })
}

/**
 * 打开预览 worker。返回 null 表示本环境不可用（无 Worker 实现 / 被 CSP 拦 / 脚本 404 / 握手超时），
 * 调用方必须继续走主线程渲染。
 *
 * ⚠️ `new Worker(new URL('./preview-worker.ts', import.meta.url))` 必须**原样留在调用点**：
 * Vite 靠静态匹配这一形状才会把它编译成独立 worker chunk。一旦把 URL 提成变量、
 * 或经参数传进工厂（B0 首次实测即踩此坑），Vite 会退化成「普通资源」处理，
 * 而 `.ts` 会被按 MIME 表识别成 MPEG 传输流并内联成 `data:video/mp2t;base64,…` ——
 * 结果既没有 worker chunk，运行时也起不来。
 */
export function openPreviewWorker(): Promise<PreviewWorkerHandle | null> {
  return createPreviewWorkerBridge(
    () => new Worker(new URL('./preview-worker.ts', import.meta.url))
  )
}
