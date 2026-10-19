import { layoutShareCards, SHARE_CARD_WIDTH, type ShareCardPayload } from './shareCardModel'
import { renderShareCardPage, type ShareCardCopy, type ShareCardDrawable } from './shareCardRender'

/**
 * 阶段 5 · B4：出图编排。
 *
 * canvas 与导出方式全部注入，因此本文件在 node 环境即可测（不必 jsdom、不必真字体）；
 * 真实 DOM 只在 `ShareCardDialog` 里接上。取消语义对齐上游 `createShareCardJob` 的
 * `check()`：在每个可能耗时的检查点退出，**已导出的页不返回给调用方**，由调用方决定丢弃。
 */

export interface ShareCardCanvasLike {
  width: number
  height: number
}

export interface GenerateShareCardDeps<TCanvas extends ShareCardCanvasLike> {
  canvas: TCanvas
  ctx: CanvasRenderingContext2D
  payload: ShareCardPayload
  copy: ShareCardCopy
  image: ShareCardDrawable
  soft?: ShareCardDrawable | null
  rotation: number
  /** 单品图标加载器；当前内嵌链路拿不到图标，缺省即全部走「图标暂缺」分支 */
  loadIcon?: (path: string) => Promise<ShareCardDrawable | null>
  exportPage: (canvas: TCanvas, width: number, height: number) => string
  isCancelled: () => boolean
  onProgress?: (current: number, total: number) => void
}

export interface GenerateShareCardResult {
  /** 每页一个 data URL；`cancelled` 时为空数组 */
  pages: string[]
  missingIcons: number
  cancelled: boolean
}

export async function generateShareCardPages<TCanvas extends ShareCardCanvasLike>(
  deps: GenerateShareCardDeps<TCanvas>
): Promise<GenerateShareCardResult> {
  const { canvas, ctx, payload, copy, image, soft, rotation, loadIcon, exportPage, isCancelled } =
    deps
  const pages = layoutShareCards(ctx as never, payload)
  const outputs: string[] = []
  let missingIcons = 0

  for (let index = 0; index < pages.length; index += 1) {
    if (isCancelled()) return { pages: [], missingIcons, cancelled: true }
    deps.onProgress?.(index + 1, pages.length)

    const icons = new Map<string, ShareCardDrawable>()
    for (const item of pages[index].outfit) {
      // 上游口径：missingIcons 统计的是「这一条穿搭没有图标」，与有没有 iconPath 无关
      if (!item.iconPath || !loadIcon) {
        missingIcons += 1
        continue
      }
      if (icons.has(item.iconPath)) continue
      try {
        const loaded = await loadIcon(item.iconPath)
        if (loaded) icons.set(item.iconPath, loaded)
        else missingIcons += 1
      } catch {
        missingIcons += 1
      }
      if (isCancelled()) return { pages: [], missingIcons, cancelled: true }
    }

    canvas.width = SHARE_CARD_WIDTH
    canvas.height = pages[index].height
    renderShareCardPage(ctx, {
      image,
      soft: soft ?? null,
      page: pages[index],
      payload,
      index,
      total: pages.length,
      rotation,
      copy,
      icons
    })
    outputs.push(exportPage(canvas, SHARE_CARD_WIDTH, pages[index].height))
    icons.clear()
  }

  return { pages: outputs, missingIcons, cancelled: false }
}
