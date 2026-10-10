/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/components/gallery/ListView
 * @coverage 列表视图缩略图源统一（fix-thumbnail-display-and-latency N1）
 * @remarks 缺陷：`toFileUrl(file.thumbnail || file.file_path)` 对 thumbnail 为空的视频
 *   回退用「原视频文件」作 <img> 源 → 浏览器无法解码视频必裂图（网格视图已有同类
 *   修复与测试先例 VirtualImageGrid.thumb.test.tsx，本文件同步防护列表视图）。
 *   测试策略：mock react-virtuoso 为透传渲染探针断言行内 img/占位行为
 *   （沿 VirtualImageGrid.grid-cycle.test.tsx 的 vi.hoisted + createElement 模式），
 *   另附源码结构断言（沿 RecycleBinPage.thumb.test.tsx 先例）。
 */
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import fs from 'fs'
import path from 'path'
import type { MediaFile } from '../../stores/mediaStore'

const { VirtuosoMock } = vi.hoisted(() => {
  const ReactLib = require('react') as typeof React
  const Virtuoso = (props: Record<string, unknown>) => {
    const data = (props.data as unknown[] | undefined) ?? []
    const itemContent = props.itemContent as
      ((index: number, item: unknown) => React.ReactNode) | undefined
    const computeItemKey = props.computeItemKey as
      ((index: number, item: unknown) => string | number) | undefined
    const rangeChanged = props.rangeChanged as
      ((range: { startIndex: number; endIndex: number }) => void) | undefined
    ReactLib.useEffect(() => {
      if (data.length > 0) rangeChanged?.({ startIndex: 0, endIndex: data.length - 1 })
    }, [data, rangeChanged])
    return ReactLib.createElement(
      'div',
      null,
      data.map((item, i) =>
        ReactLib.createElement(
          'div',
          { key: computeItemKey ? computeItemKey(i, item) : i },
          itemContent ? itemContent(i, item) : null
        )
      )
    )
  }
  return { VirtuosoMock: Virtuoso }
})
vi.mock('react-virtuoso', () => ({ Virtuoso: VirtuosoMock }))

import { ListView } from './ListView'

const makeFile = (overrides: Record<string, unknown>): MediaFile =>
  ({
    id: 'f1',
    file_name: 'clip01.mp4',
    file_path: 'D:/Game/Videos/clip01.mp4',
    file_type: 'video',
    file_ext: '.mp4',
    file_size: 1024,
    created_at: '2026-01-01T00:00:00',
    modified_at: '2026-01-01T00:00:00',
    tags: [],
    rating: 0,
    is_favorite: false,
    notes: '',
    is_missing: false,
    is_corrupted: false,
    ...overrides
  }) as unknown as MediaFile

afterEach(cleanup)

const renderRow = (file: MediaFile) =>
  render(
    <ListView
      files={[file]}
      selectedIds={[]}
      onSelect={() => {}}
      onToggleSelection={() => {}}
      onContextMenu={() => {}}
    />
  )

describe('ListView 缩略图源（N1）', () => {
  it('异常：视频无缩略图 → 不得以视频文件作 <img> 源（裂图根因）', () => {
    const { container } = renderRow(makeFile({ thumbnail: undefined }))
    expect(container.querySelector('img')).toBeNull()
  })

  it('正常：视频有缩略图 → img 指向缩略图', () => {
    const { container } = renderRow(makeFile({ thumbnail: 'C:/cache/abc.jpg', file_name: 'v.mp4' }))
    const img = container.querySelector('img') as HTMLImageElement
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe(
      `media://file?path=${encodeURIComponent('C:/cache/abc.jpg')}`
    )
  })

  it('正常：图片无缩略图 → 不加载原图，并按需生成后显示缩略图', async () => {
    const filePath = `D:/p/list-${Date.now()}.png`
    const generatedPath = 'C:/cache/list-generated.jpg'
    const generate = vi.fn().mockResolvedValue(generatedPath)
    const originalElectronApi = window.electronAPI
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { thumbnail: { generate } }
    })

    try {
      const { container } = renderRow(
        makeFile({ file_type: 'image', file_path: filePath, thumbnail: undefined })
      )
      expect(container.querySelector('img')).toBeNull()

      await waitFor(() => expect(generate).toHaveBeenCalledWith(filePath))
      await waitFor(() => {
        const img = container.querySelector('img') as HTMLImageElement | null
        expect(img?.getAttribute('src')).toBe(
          `media://file?path=${encodeURIComponent(generatedPath)}`
        )
      })
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: originalElectronApi
      })
    }
  })

  it('结构：不得存在原图回退，统一消费共享按需生成结果', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/gallery/ListView.tsx'),
      'utf-8'
    )
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n')
    expect(code).not.toContain('toFileUrl(file.thumbnail || file.file_path)')
    expect(code).toContain('useOnDemandThumbnails()')
    expect(code).toContain('rangeChanged={handleRangeChanged}')
    expect(code).toContain('getGeneratedPath(file.file_path)')
  })
})

describe('ListView 骨架门控直显（fix-thumbnail-skeleton-reveal N5）', () => {
  it('行为：img 加载完成前显示骨架动画层，onLoad 后骨架卸载', () => {
    const { container } = renderRow(makeFile({ thumbnail: 'C:/cache/abc.jpg', file_name: 'v.mp4' }))
    const img = container.querySelector('img') as HTMLImageElement
    // 未加载：img 已挂载（发起请求）但透明，骨架层可见
    expect(img.className).toContain('opacity-0')
    expect(container.querySelector('.skeleton')).toBeTruthy()
    // 加载完成：骨架卸载，img 淡入
    fireEvent.load(img)
    expect(img.className).toContain('opacity-100')
    expect(container.querySelector('.skeleton')).toBeNull()
  })

  it('结构：裸 <img> 已替换为 ThumbReveal 骨架门控组件', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/gallery/ListView.tsx'),
      'utf-8'
    )
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n')
    expect(code).toContain('<ThumbReveal')
    expect(code).not.toContain('<img')
  })
})
