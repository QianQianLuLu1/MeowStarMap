/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/hooks/useVideoThumbGenerate
 * @coverage 无缩略图视频的按需缩略图生成（fix-gameplayphotos-video-thumbnail-null 节点4）
 * @dependencies @testing-library/react（renderHook），window.electronAPI plain-object stub
 * @remarks
 *   缺陷现象：「缓存」（launcher-cache）与「重复文件」板块中，DB thumbnail 为 NULL 的游戏视频
 *   （...\X6Game\Saved\GamePlayPhotos\{uid}\Videos\{ts}\{ts}.Mp4）永久显示纯白占位卡片。
 *   根因：主进程多条补算链路全部失效（见 docs/archive/plans/fix-gameplayphotos-video-thumbnail-null.md（已归档，不入仓）），
 *   且网格视图（VirtualImageGrid）对无缩略图视频不触发任何生成。
 *   修复：本 hook 对齐 DuplicatesPage DuplicateFileCard 的已验证模式——视频缺 thumbnail 时
 *   按需调用一次 window.electronAPI.thumbnail.generate（IPC → 主进程 seek 阶梯抽帧），
 *   模块级 Map 做单次守卫（null 不重试，防请求风暴），成功后由组件就地显示。
 *   不变量：绝不回退视频原文件路径（<img> 无法解码视频）。
 *
 *   测试注意：模块级缓存跨用例共享（与 DuplicatesPage thumbGenerateCache 同策略），
 *   各用例使用互不相同的 file_path 隔离。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useVideoThumbGenerate } from './useVideoThumbGenerate'
import type { MediaFile } from '../stores/mediaStore'

type GenerateFn = (
  filePath: string,
  quality?: 'low' | 'standard' | 'high'
) => Promise<string | null>

/** 构造最小 MediaFile（仅 hook 关心的字段，其余强转兜底） */
function makeFile(
  overrides: Partial<Pick<MediaFile, 'id' | 'file_path' | 'file_type' | 'thumbnail'>> & {
    id: string
  }
): MediaFile {
  return {
    file_path: `C:\\videos\\${overrides.id}.Mp4`,
    file_type: 'video',
    thumbnail: undefined,
    ...overrides
  } as unknown as MediaFile
}

function setElectronApi(generate: GenerateFn | undefined): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI =
    generate === undefined ? {} : { thumbnail: { generate } }
}

let seq = 0

beforeEach(() => {
  seq += 0
  setElectronApi(undefined)
})

describe('useVideoThumbGenerate', () => {
  it('正常：无缩略图视频触发一次 generate，成功后结果进入返回 Map', async () => {
    const path = `C:\\videos\\gen-ok-${++seq}.Mp4`
    const thumbPath = `D:\\cache\\hash-${seq}.jpg`
    const generate = vi.fn().mockResolvedValue(thumbPath)
    setElectronApi(generate)

    const { result, rerender } = renderHook(({ items }) => useVideoThumbGenerate(items), {
      initialProps: { items: [makeFile({ id: 'ok-1', file_path: path })] }
    })

    await waitFor(() => expect(result.current.get(path)).toBe(thumbPath))
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledWith(path)

    // items 引用变化（父组件重渲染）不重复触发：模块级缓存单次守卫
    rerender({ items: [makeFile({ id: 'ok-1', file_path: path })] })
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    expect(result.current.get(path)).toBe(thumbPath)
  })

  it('边界：视频已有 thumbnail → 不调用 generate', () => {
    const generate = vi.fn().mockResolvedValue('D:\\cache\\x.jpg')
    setElectronApi(generate)

    const { result } = renderHook(({ items }) => useVideoThumbGenerate(items), {
      initialProps: {
        items: [makeFile({ id: 'has-thumb', thumbnail: 'D:\\cache\\existing.jpg' })]
      }
    })

    expect(generate).not.toHaveBeenCalled()
    expect(result.current.size).toBe(0)
  })

  it('边界：图片类型不参与按需生成（图片允许回退原文件，由组件处理）', () => {
    const generate = vi.fn().mockResolvedValue('D:\\cache\\x.jpg')
    setElectronApi(generate)

    const { result } = renderHook(({ items }) => useVideoThumbGenerate(items), {
      initialProps: { items: [makeFile({ id: 'img-1', file_type: 'image' })] }
    })

    expect(generate).not.toHaveBeenCalled()
    expect(result.current.size).toBe(0)
  })

  it('边界：file_path 为空字符串 → 不调用 generate', () => {
    const generate = vi.fn().mockResolvedValue('D:\\cache\\x.jpg')
    setElectronApi(generate)

    const { result } = renderHook(({ items }) => useVideoThumbGenerate(items), {
      initialProps: { items: [makeFile({ id: 'empty-path', file_path: '' })] }
    })

    expect(generate).not.toHaveBeenCalled()
    expect(result.current.size).toBe(0)
  })

  it('异常：generate 返回 null → 不写入结果，且单次守卫生效不重试', async () => {
    const path = `C:\\videos\\gen-null-${++seq}.Mp4`
    const generate = vi.fn().mockResolvedValue(null)
    setElectronApi(generate)

    const { result, rerender } = renderHook(({ items }) => useVideoThumbGenerate(items), {
      initialProps: { items: [makeFile({ id: 'null-1', file_path: path })] }
    })

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    expect(result.current.has(path)).toBe(false)

    rerender({ items: [makeFile({ id: 'null-1', file_path: path })] })
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
  })

  it('异常：generate reject → 不写入结果、不抛错，且单次守卫生效不重试', async () => {
    const path = `C:\\videos\\gen-reject-${++seq}.Mp4`
    const generate = vi.fn().mockRejectedValue(new Error('forbidden'))
    setElectronApi(generate)

    const { result, rerender } = renderHook(({ items }) => useVideoThumbGenerate(items), {
      initialProps: { items: [makeFile({ id: 'reject-1', file_path: path })] }
    })

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    expect(result.current.has(path)).toBe(false)

    rerender({ items: [makeFile({ id: 'reject-1', file_path: path })] })
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
  })

  it('异常：electronAPI.thumbnail.generate 缺失 → no-op 不抛错', () => {
    setElectronApi(undefined)

    const { result } = renderHook(({ items }) => useVideoThumbGenerate(items), {
      initialProps: { items: [makeFile({ id: 'no-api' })] }
    })

    expect(result.current.size).toBe(0)
  })
})
