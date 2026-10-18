/**
 * 预览像素 worker 入口
 *
 * 把「逐像素调色 + 编码」这两步主线程上最贵的活搬到 worker：
 * 实测单帧（1024×768）在只调亮度时约 30ms、多 pass 开启时约 347ms，
 * 全部压在主线程就是拖动卡顿的本源（见 docs/plans/2026-10-18-fix-editor-preview-realtime.md §0）。
 *
 * 输入是主线程已经重采样好的底图像素（Transferable，零拷贝转移），
 * 输出是编码后的 Blob；worker 全程不碰 `document` / `new Image()`。
 * 图片水印需要 logo，而 logo 只能在主线程经 media:// 取（`fetch('media://…')`
 * 会撞 CSP 的 connect-src），因此带图片水印的帧由主线程自行处理，不会走到这里。
 */
import {
  processPreviewBase,
  imageDataToBlob,
  type FilterParams,
  type PreviewBase,
  type WatermarkConfig
} from './imageProcessor'

/** 与 preview-worker-bridge 的握手消息共存：READY / pong 由骨架消息占用 */
export interface PreviewRenderRequest {
  type: 'RENDER'
  reqId: number
  buffer: ArrayBuffer
  width: number
  height: number
  params: FilterParams
  watermark: WatermarkConfig | null
  mime: 'image/jpeg' | 'image/png' | 'image/webp'
  quality: number
}

export type PreviewRenderReply =
  { type: 'RESULT'; reqId: number; blob: Blob } | { type: 'ERROR'; reqId: number; message: string }

/** 一次渲染：底图像素 → 完整滤镜链 → 编码 Blob */
export async function handlePreviewRenderRequest(request: PreviewRenderRequest): Promise<Blob> {
  const base: PreviewBase = {
    width: request.width,
    height: request.height,
    data: new Uint8ClampedArray(request.buffer)
  }
  const imageData = await processPreviewBase(base, request.params, {
    watermark: request.watermark
  })
  return imageDataToBlob(imageData, request.mime, request.quality)
}

const scope = globalThis as unknown as {
  postMessage(message: unknown): void
  onmessage: ((event: MessageEvent) => void) | null
}

function wireWorkerScope(): void {
  scope.onmessage = (event: MessageEvent): void => {
    const data = event.data as { type?: string; reqId?: number } | null
    if (!data || typeof data !== 'object') return
    if (data.type === 'ping') {
      scope.postMessage({ type: 'pong' })
      return
    }
    if (data.type !== 'RENDER') return

    const request = data as unknown as PreviewRenderRequest
    const reqId = request.reqId
    void handlePreviewRenderRequest(request).then(
      (blob) => scope.postMessage({ type: 'RESULT', reqId, blob } satisfies PreviewRenderReply),
      (err: unknown) =>
        scope.postMessage({
          type: 'ERROR',
          reqId,
          message: err instanceof Error ? err.message : String(err)
        } satisfies PreviewRenderReply)
    )
  }

  scope.postMessage({ type: 'READY' })
}

/**
 * 只有在真正的 worker 作用域里才接线并自报 READY。
 * 判定用 `window === undefined`：worker 里没有 window，主线程/jsdom 里有——
 * 否则单测 import 本文件取 `handlePreviewRenderRequest` 时就会撞上
 * jsdom 的 `window.postMessage` 参数校验而整档加载失败。
 */
if (typeof window === 'undefined') {
  wireWorkerScope()
}
