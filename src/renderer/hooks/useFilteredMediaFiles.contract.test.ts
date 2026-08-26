// @vitest-environment jsdom
/**
 * 索引对齐契约测试（T4）：验证 useFilteredMediaFiles 的 module-level 缓存
 * 在相同过滤参数下返回同一数组引用。GalleryPage 与 App 顶层均以此 hook
 * 获取 filteredFiles；openFullscreen(index) 的 index 与 FullscreenViewer 接收的
 * filteredFiles 因此同义 → 全屏显示即被点击的图片。固化该不变量，确认 H2（索引错位）不成立。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFilteredMediaFiles } from './useFilteredMediaFiles'
import { useMediaStore } from '../stores/mediaStore'
import { useUIStore } from '../stores/uiStore'
import type { MediaFile } from '../stores/mediaStore'

const sampleFiles = [
  {
    id: 'a',
    file_name: 'a.jpg',
    file_type: 'image',
    created_at: '2024-01-01T00:00:00Z',
    is_missing: false
  },
  {
    id: 'b',
    file_name: 'b.jpg',
    file_type: 'image',
    created_at: '2024-01-02T00:00:00Z',
    is_missing: false
  }
] as unknown as MediaFile[]

describe('useFilteredMediaFiles 索引对齐契约', () => {
  afterEach(() => {
    act(() => {
      useMediaStore.setState({ mediaFiles: [] })
    })
    useUIStore.setState({ fullscreenOpen: false, fullscreenIndex: -1, fullscreenTargetImg: null })
  })

  it('相同过滤参数下两次调用返回同一引用（图库与全屏查看器共享列表，index 同义）', () => {
    act(() => {
      useMediaStore.setState({ mediaFiles: sampleFiles })
    })
    const { result: r1 } = renderHook(() => useFilteredMediaFiles())
    const { result: r2 } = renderHook(() => useFilteredMediaFiles())
    expect(r1.current).toBe(r2.current)
    expect(r1.current).toHaveLength(2)
    expect(r1.current.map((f) => f.id).sort()).toEqual(['a', 'b'])
  })

  it('openFullscreen(index) 解析到与图库一致的 filteredFiles[index]（全屏即所点图片）', () => {
    act(() => {
      useMediaStore.setState({ mediaFiles: sampleFiles })
    })
    const { result } = renderHook(() => useFilteredMediaFiles())
    const list = result.current

    // 模拟图库网格点击 id='b' 的项：先按同一 list 算出其 index（与 FullscreenViewer 共享）
    const idxB = list.findIndex((f) => f.id === 'b')
    expect(idxB).toBeGreaterThanOrEqual(0)
    useUIStore.getState().openFullscreen(idxB)
    expect(useUIStore.getState().fullscreenIndex).toBe(idxB)
    // FullscreenViewer 接收同一 list（module cache 保证），currentFile 即被点击项
    expect(list[useUIStore.getState().fullscreenIndex].id).toBe('b')

    act(() => {
      useUIStore.getState().closeFullscreen()
    })
  })
})
