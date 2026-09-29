import { useEffect } from 'react'
import { toFileUrl } from '../stores/mediaStore'
import type { MediaFile } from '../stores/mediaStore'

/**
 * 邻近项预取（THUMBNAIL_OPTIMIZATION_PLAN 节点4）：
 * 当前项变化时以 `new Image()` 预热前后各一张原图（跳过视频——<img> 无法解码视频），
 * 使全屏/详情翻页时相邻图基本即点即显，替代「每次换张现场 load+decode」的等待。
 *
 * 预热失败静默：不挂 onload/onerror 监听，无未捕获 Promise 拒绝；
 * 浏览器 HTTP 缓存（原图一年强缓存，media-protocol.ts IMMUTABLE_CACHE_CONTROL）保证
 * 预热的字节在翻页时直接命中。
 *
 * @param files   当前浏览的文件列表（全屏 activeFiles / 详情 filteredFiles）
 * @param index   当前项下标
 * @param enabled 仅在浏览面打开时预热（全屏关闭/详情未选中时不发请求）
 */
export function useNeighborPrefetch(files: MediaFile[], index: number, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const neighbors = [files[index + 1], files[index - 1]]
    for (const file of neighbors) {
      if (!file || file.file_type === 'video') continue
      const url = toFileUrl(file.file_path)
      if (!url) continue
      const probe = new Image()
      probe.src = url
    }
  }, [files, index, enabled])
}
