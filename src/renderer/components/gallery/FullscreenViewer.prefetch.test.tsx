/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/hooks/useNeighborPrefetch + src/renderer/components/gallery/FullscreenViewer
 * @coverage 全屏查看器邻近预取（THUMBNAIL_OPTIMIZATION_PLAN 节点4）：
 *   当前项变化时以 new Image() 预热前后各一张原图（跳过视频——img 无法解码视频）；
 *   enabled=false（全屏未打开）不预热；FullscreenViewer 必须接线该 hook（源码结构断言）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import fs from 'fs'
import path from 'path'
import { useNeighborPrefetch } from '../../hooks/useNeighborPrefetch'
import type { MediaFile } from '../../stores/mediaStore'

// 记录 new Image() 实例与其 src
const createdImages: Array<{ src: string }> = []

beforeEach(() => {
  createdImages.length = 0
  vi.stubGlobal(
    'Image',
    class {
      src = ''
      constructor() {
        createdImages.push(this)
      }
    }
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const img = (p: string): MediaFile =>
  ({ id: p, file_path: p, file_type: 'image' }) as unknown as MediaFile
const vid = (p: string): MediaFile =>
  ({ id: p, file_path: p, file_type: 'video' }) as unknown as MediaFile

const enc = (p: string) => `media://file?path=${encodeURIComponent(p)}`

describe('useNeighborPrefetch 邻近预取', () => {
  it('正常：中间项 → 预热前后各一张原图，不预热当前项', () => {
    const files = [img('D:/a.jpg'), img('D:/b.jpg'), img('D:/c.jpg')]
    renderHook(() => useNeighborPrefetch(files, 1, true))
    const srcs = createdImages.map((i) => i.src)
    expect(srcs).toContain(enc('D:/a.jpg'))
    expect(srcs).toContain(enc('D:/c.jpg'))
    expect(srcs).not.toContain(enc('D:/b.jpg'))
  })

  it('边界：首项只预热下一张；末项只预热上一张', () => {
    const files = [img('D:/a.jpg'), img('D:/b.jpg'), img('D:/c.jpg')]
    const { rerender } = renderHook(
      ({ list, idx }: { list: MediaFile[]; idx: number }) => useNeighborPrefetch(list, idx, true),
      { initialProps: { list: files, idx: 0 } }
    )
    expect(createdImages.map((i) => i.src)).toEqual([enc('D:/b.jpg')])
    createdImages.length = 0
    rerender({ list: files, idx: 2 })
    expect(createdImages.map((i) => i.src)).toEqual([enc('D:/b.jpg')])
  })

  it('异常：相邻项为视频时不构造 Image', () => {
    const files = [img('D:/a.jpg'), vid('D:/v.mp4'), img('D:/c.jpg')]
    renderHook(() => useNeighborPrefetch(files, 1, true))
    expect(createdImages.map((i) => i.src)).toEqual([enc('D:/c.jpg'), enc('D:/a.jpg')])
  })

  it('异常：enabled=false（全屏未打开）→ 不预热', () => {
    const files = [img('D:/a.jpg'), img('D:/b.jpg')]
    renderHook(() => useNeighborPrefetch(files, 0, false))
    expect(createdImages).toHaveLength(0)
  })
})

describe('FullscreenViewer 预取接线（源码结构，THUMBNAIL_OPTIMIZATION_PLAN 节点4）', () => {
  it('FullscreenViewer 必须调用 useNeighborPrefetch', () => {
    const src = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'src',
        'renderer',
        'components',
        'gallery',
        'FullscreenViewer.tsx'
      ),
      'utf-8'
    )
    // 剔除注释行，防止修复说明注释本身命中断言造成假通过
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n')
    expect(code).toContain('useNeighborPrefetch(')
  })
})
