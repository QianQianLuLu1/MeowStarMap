import { useMemo } from 'react'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'

export interface GallerySummaryCounts {
  total: number
  images: number
  videos: number
}

/**
 * 图库计数口径选择器：AppShell 状态栏、Sidebar「图片 / 视频」、GalleryPage 统计条共用。
 *
 * 背景（R-1，计划见 docs/plans/2026-11-03-fix-media-recognized-count-500-limit-实施计划.md）：
 * 这三处原先都遍历 `mediaFiles` 数组算数量，而 mediaFiles 是分页加载的切片，首屏只有一页 ⇒
 * 数字恒等于页大小 500，用户读成「识别数量被限制为最多 500」。
 *
 * 判据（唯一一条，刻意保持可判定）：
 * **`hasMoreMedia === true` 且服务端三个计数都到位 ⇒ 用服务端真值；否则 ⇒ 遍历传入数组。**
 * `hasMoreMedia === true` 是「客户端数组确定不完整」的可靠信号；一旦拉齐（false），数组即真值，
 * 且此时任何纯前端筛选（收藏 / 场景 / 套装 / 日期 / 评分 / 搜索 / 分组）都已把全库拉齐，
 * 长度才是筛选后的真实数量——服务端计数不含这些前端条件，不能用。
 *
 * nikkisync 数据源没有等价的「分类型真计数」能力（store 里恒为 null），因此该源下自然走数组分支，
 * 行为与本轮修复前一致，不伪造服务端值。
 */
export function useGallerySummaryCounts(files: MediaFile[]): GallerySummaryCounts {
  const hasMoreMedia = useMediaStore((s) => s.hasMoreMedia)
  const mediaTotalCount = useMediaStore((s) => s.mediaTotalCount)
  const mediaImageCount = useMediaStore((s) => s.mediaImageCount)
  const mediaVideoCount = useMediaStore((s) => s.mediaVideoCount)

  return useMemo(() => {
    if (
      hasMoreMedia &&
      mediaTotalCount !== null &&
      mediaImageCount !== null &&
      mediaVideoCount !== null
    ) {
      return { total: mediaTotalCount, images: mediaImageCount, videos: mediaVideoCount }
    }
    let images = 0
    let videos = 0
    for (const file of files) {
      if (file.file_type === 'image') images++
      else if (file.file_type === 'video') videos++
    }
    return { total: files.length, images, videos }
  }, [files, hasMoreMedia, mediaTotalCount, mediaImageCount, mediaVideoCount])
}
