/**
 * @vitest-environment jsdom
 * @module src/renderer/hooks/useGallerySummaryCounts
 * @coverage 图库计数口径判据：列表未拉齐时用服务端真值、拉齐后与纯前端筛选态用数组长度、
 *           服务端计数缺失时回落数组（不渲染 NaN）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useGallerySummaryCounts } from './useGallerySummaryCounts'
import type { MediaFile } from '../stores/mediaStore'

const { storeState } = vi.hoisted(() => ({
  storeState: {
    hasMoreMedia: false,
    mediaTotalCount: null as number | null,
    mediaImageCount: null as number | null,
    mediaVideoCount: null as number | null
  }
}))

vi.mock('../stores/mediaStore', () => ({
  useMediaStore: (selector: (s: typeof storeState) => unknown) => selector(storeState)
}))

/**
 * 桩文件：只关心 file_type，其余字段给齐以通过 MediaFile 校验。
 * 入参刻意收 string 而不是 MediaType —— media_files.file_type 是裸文本列，
 * 类型上只声明了 image/video 两种，但库里确实存在第三种历史取值（如 live_photo），
 * 本 hook 的「不计入 images/videos」分支就是要覆盖它。
 */
function makeFile(fileType: string, id = 1): MediaFile {
  return {
    id: String(id),
    file_path: `/test/f-${id}.bin`,
    file_name: `f-${id}.bin`,
    file_ext: '.bin',
    file_type: fileType as MediaFile['file_type'],
    file_size: 1024,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
    modified_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
    tags: [],
    rating: 0,
    is_favorite: false,
    notes: '',
    scene_category: 'other'
  }
}

const filesOf = (...types: string[]): MediaFile[] => types.map((t, i) => makeFile(t, i + 1))

describe('useGallerySummaryCounts', () => {
  beforeEach(() => {
    storeState.hasMoreMedia = false
    storeState.mediaTotalCount = null
    storeState.mediaImageCount = null
    storeState.mediaVideoCount = null
  })

  it('列表未拉齐且服务端计数到位时用真值，数组长度不参与', () => {
    storeState.hasMoreMedia = true
    storeState.mediaTotalCount = 1200
    storeState.mediaImageCount = 900
    storeState.mediaVideoCount = 300
    const { result } = renderHook(() => useGallerySummaryCounts(filesOf('image', 'image')))
    expect(result.current).toEqual({ total: 1200, images: 900, videos: 300 })
  })

  it('列表已拉齐时用数组长度：服务端计数此时是筛选前的口径，不能覆盖', () => {
    storeState.hasMoreMedia = false
    storeState.mediaTotalCount = 1200
    storeState.mediaImageCount = 900
    storeState.mediaVideoCount = 300
    const { result } = renderHook(() => useGallerySummaryCounts(filesOf('image', 'image', 'video')))
    expect(result.current).toEqual({ total: 3, images: 2, videos: 1 })
  })

  it('服务端计数缺失（nikkisync 源）时回落数组长度', () => {
    storeState.hasMoreMedia = true
    const { result } = renderHook(() => useGallerySummaryCounts(filesOf('image', 'video')))
    expect(result.current).toEqual({ total: 2, images: 1, videos: 1 })
  })

  it('空数组 + 无服务端值时三个计数都是 0，不是 NaN', () => {
    const { result } = renderHook(() => useGallerySummaryCounts(filesOf()))
    expect(result.current).toEqual({ total: 0, images: 0, videos: 0 })
  })

  it('第三种历史 file_type 计入 total 但不计入 images/videos（与主进程 typeCounts 同口径）', () => {
    const { result } = renderHook(() => useGallerySummaryCounts(filesOf('image', 'live_photo')))
    expect(result.current).toEqual({ total: 2, images: 1, videos: 0 })
  })

  it('服务端给出合法的 0 时不被当成缺失（空库不得回落）', () => {
    storeState.hasMoreMedia = true
    storeState.mediaTotalCount = 0
    storeState.mediaImageCount = 0
    storeState.mediaVideoCount = 0
    const { result } = renderHook(() => useGallerySummaryCounts(filesOf()))
    expect(result.current).toEqual({ total: 0, images: 0, videos: 0 })
  })
})
