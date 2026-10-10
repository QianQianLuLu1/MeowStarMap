// 旧视图（列表/瀑布流/时间线/事件时间线/回收站）统一的缩略图源解析。
// 缺陷背景：这些视图曾用 `toFileUrl(file.thumbnail || file.file_path)`——视频 thumbnail
// 为空时回退用「原视频文件」作 <img> 源，浏览器无法解码视频必触发 onError 裂图；
// 图片 thumbnail 为空时直载数 MB 原图，与后台批量任务争抢磁盘 IO。
// 网格视图（VirtualImageGrid.resolveEffectiveThumbnail）已修复同一缺陷，
// 本模块将相同不变量抽为共享纯函数供其余视图复用：DB thumbnail 优先，
// 缩略图缺失时返回 null，由组件显示占位并触发按需生成。
import { toFileUrl } from './file'

/**
 * 解析媒体条目的缩略图展示源。
 * @param file.thumbnail 数据库缩略图绝对路径（null/undefined/空串均视为无）
 * @param file.file_path 原文件路径，仅用于按需生成，不作为展示兜底
 * @param file.file_type 'image' | 'video'；未知值按视频处理（不回退原文件）
 * @returns 可直接赋给 <img src> 的 URL；无可用缩略图时返回 null
 */
export function resolveThumbnailSrc(file: {
  thumbnail?: string | null
  file_path: string
  file_type: string
}): string | null {
  if (file.thumbnail) return toFileUrl(file.thumbnail)
  return null
}
