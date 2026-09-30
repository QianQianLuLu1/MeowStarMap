/**
 * @layer L2
 * @module src/renderer/utils/thumbnail-src
 * @coverage 旧视图（列表/瀑布流/时间线/事件时间线/回收站）缩略图源统一解析（N1）
 * @remarks 缺陷：这些视图使用 `toFileUrl(file.thumbnail || file.file_path)`——视频
 *   thumbnail 为空时回退用「原视频文件」作 <img> 源，浏览器无法解码视频必触发
 *   onError 裂图；图片 thumbnail 为空时直载数 MB 原图拖慢加载。网格视图
 *   （VirtualImageGrid.resolveEffectiveThumbnail）已修，本模块将同一不变量抽为
 *   共享纯函数：DB thumbnail > （仅图片）原文件兜底 > null（组件显示占位图标）。
 */
import { describe, it, expect } from 'vitest'
import { resolveThumbnailSrc } from './thumbnail-src'

// tests/setup.ts 已注入 window.electronAPI 占位 → toFileUrl 产出 media:// URL
const THUMB = 'C:\\Users\\u\\AppData\\Roaming\\wxnn-photo-manager\\thumbnails\\abc123.jpg'
const THUMB_URL = `media://file?path=${encodeURIComponent(
  'C:/Users/u/AppData/Roaming/wxnn-photo-manager/thumbnails/abc123.jpg'
)}`
const VIDEO = 'D:\\Game\\Videos\\clip01.mp4'
const IMAGE = 'D:\\Game\\Photos\\pic01.png'
const IMAGE_URL = `media://file?path=${encodeURIComponent('D:/Game/Photos/pic01.png')}`

describe('resolveThumbnailSrc 缩略图源判定（N1）', () => {
  it('正常：有 DB thumbnail → 直接使用缩略图', () => {
    expect(resolveThumbnailSrc({ thumbnail: THUMB, file_path: VIDEO, file_type: 'video' })).toBe(
      THUMB_URL
    )
    expect(resolveThumbnailSrc({ thumbnail: THUMB, file_path: IMAGE, file_type: 'image' })).toBe(
      THUMB_URL
    )
  })

  it('正常：图片无 thumbnail → 回退原文件（保留旧行为兜底）', () => {
    expect(
      resolveThumbnailSrc({ thumbnail: undefined, file_path: IMAGE, file_type: 'image' })
    ).toBe(IMAGE_URL)
    expect(resolveThumbnailSrc({ thumbnail: null, file_path: IMAGE, file_type: 'image' })).toBe(
      IMAGE_URL
    )
  })

  it('异常：视频无 thumbnail → null（绝不返回视频路径，防裂图）', () => {
    expect(
      resolveThumbnailSrc({ thumbnail: null, file_path: VIDEO, file_type: 'video' })
    ).toBeNull()
    expect(
      resolveThumbnailSrc({ thumbnail: undefined, file_path: VIDEO, file_type: 'video' })
    ).toBeNull()
  })

  it('边界：thumbnail 空串视为无缩略图', () => {
    expect(resolveThumbnailSrc({ thumbnail: '', file_path: VIDEO, file_type: 'video' })).toBeNull()
    expect(resolveThumbnailSrc({ thumbnail: '', file_path: IMAGE, file_type: 'image' })).toBe(
      IMAGE_URL
    )
  })

  it('边界：file_type 未知值按视频处理 → null（不回退原文件）', () => {
    expect(
      resolveThumbnailSrc({ thumbnail: undefined, file_path: VIDEO, file_type: '' })
    ).toBeNull()
    expect(
      resolveThumbnailSrc({ thumbnail: undefined, file_path: VIDEO, file_type: 'gif' })
    ).toBeNull()
  })

  it('边界：图片原路径为空串 → null（交给组件占位）', () => {
    expect(
      resolveThumbnailSrc({ thumbnail: undefined, file_path: '', file_type: 'image' })
    ).toBeNull()
  })
})
