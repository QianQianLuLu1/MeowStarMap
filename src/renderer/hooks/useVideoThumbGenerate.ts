import { useEffect, useState } from 'react'
import type { MediaFile } from '../stores/mediaStore'

// 模块级单次守卫：file_path → 生成结果（null = 已生成过但失败/无产物，不重试，防请求风暴）。
// 与 DuplicatesPage 的 thumbGenerateCache 同语义；跨组件实例共享，虚拟列表复挂载不重复触发 IPC。
const videoThumbGenerateCache = new Map<string, string | null>()

/**
 * 为「无缩略图的视频」按需生成缩略图（fix-gameplayphotos-video-thumbnail-null 节点4）。
 *
 * 背景：部分游戏视频（...\X6Game\Saved\GamePlayPhotos\{uid}\Videos\{ts}\{ts}.Mp4）入库时
 * thumbnail 为 NULL，且批量补算链路修复前永远缺图——网格此前只显示占位图标（视觉为纯白卡片）。
 * 本 hook 对齐 DuplicatesPage DuplicateFileCard 的已验证模式：对 video 且无 thumbnail 的项
 * 调用一次 window.electronAPI.thumbnail.generate（IPC → 主进程 seek 阶梯抽帧，正常/异常均
 * 只尝试一次），成功结果以 Map<file_path, 缩略图路径> 返回，由组件就地显示。
 *
 * 不变量：绝不返回视频原文件路径（<img> 无法解码视频，回退必裂图）。
 *
 * @param items 当前网格数据列表
 * @returns file_path → 已生成的缩略图绝对路径（仅包含成功项）
 */
export function useVideoThumbGenerate(items: MediaFile[]): Map<string, string> {
  const [generated, setGenerated] = useState<Map<string, string>>(() => new Map())

  useEffect(() => {
    const generate = window.electronAPI?.thumbnail?.generate
    if (!generate) return
    let cancelled = false

    // 回填缓存中已有的成功结果（组件重挂载后 generated 是新 Map，需从缓存恢复）
    const resolved: Array<[string, string]> = []
    for (const file of items) {
      if (file.file_type !== 'video' || file.thumbnail) continue
      const key = file.file_path
      if (typeof key !== 'string' || key.length === 0) continue
      const cached = videoThumbGenerateCache.get(key)
      if (cached) {
        resolved.push([key, cached])
        continue
      }
      // has(key) 为 true：失败(null)或在途占位——单次守卫，不再触发
      if (videoThumbGenerateCache.has(key)) continue
      videoThumbGenerateCache.set(key, null)
      void (async () => {
        try {
          const result = await generate(key)
          videoThumbGenerateCache.set(key, result ?? null)
          if (!cancelled && result) {
            setGenerated((prev) => {
              const next = new Map(prev)
              next.set(key, result)
              return next
            })
          }
        } catch {
          videoThumbGenerateCache.set(key, null)
        }
      })()
    }
    if (resolved.length > 0) {
      setGenerated((prev) => {
        const next = new Map(prev)
        for (const [k, v] of resolved) {
          if (!next.has(k)) next.set(k, v)
        }
        return next.size === prev.size ? prev : next
      })
    }

    return () => {
      cancelled = true
    }
  }, [items])

  return generated
}
