/**
 * @layer L3
 * @module src/renderer/components/gallery/FullscreenViewer
 * @coverage 全屏首图「缩略图先行 + 原图延迟换源」策略（RC2）
 * @dependencies @testing-library/react + useUIStore + useMediaStore + 伪 Image（decode 可控）
 * @remarks
 *   根因 RC2：全屏共享元素原先直接以原文件 file:// / media:// 作为 <img> src。
 *   游戏截图常为数 MB 的 4K 图 —— 新快照拍摄时它尚未加载（固有尺寸未知导致 group 起终点
 *   尺寸失真），加载完成又触发重排撕裂动画，且解码任务落在 ~250ms 动画窗口内抢占主线程。
 *   修复策略：动画窗口内只显示已被图库网格加载过、浏览器缓存命中的 thumbnail；
 *   原图用离屏 Image + decode() 预解码，就绪后原子换源。
 *   不带 thumbnail 的文件维持旧行为（直接用原图），不得回归。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { FullscreenViewer } from './FullscreenViewer'
import { useUIStore } from '../../stores/uiStore'
import { useMediaStore, type MediaFile } from '../../stores/mediaStore'
import { toFileUrl } from '../../utils/file'

/** decode 行为开关：resolve / reject / pending（手动推进） */
type DecodeMode = 'resolve' | 'reject' | 'pending'
let decodeMode: DecodeMode = 'resolve'
/** 处于 pending 的 decode 推进器，按创建顺序追加 */
const pendingResolvers: Array<() => void> = []
const pendingRejectors: Array<(err: Error) => void> = []
/** 离屏预解码请求过的 src 序列（按调用顺序） */
const preDecodedSources: string[] = []

class FakeImage {
  src = ''

  async decode(): Promise<void> {
    preDecodedSources.push(this.src)
    if (decodeMode === 'resolve') return
    if (decodeMode === 'reject') throw new Error('decode boom')
    return new Promise<void>((resolve, reject) => {
      pendingResolvers.push(resolve)
      pendingRejectors.push(reject)
    })
  }
}

function file(
  id: string,
  name: string,
  thumbnail?: string,
  metadata: { width: number; height: number } | null = { width: 1920, height: 1080 }
): MediaFile {
  return {
    id,
    file_path: `C:\\media\\${name}`,
    file_name: name,
    file_type: 'image',
    thumbnail,
    ...(metadata ?? {})
  } as unknown as MediaFile
}

const fileWithThumb = file('a', 'a.jpg', 'C:\\cache\\a_thumb.jpg')
const fileNoThumb = file('n', 'n.jpg')
const secondFileWithThumb = file('b', 'b.jpg', 'C:\\cache\\b_thumb.jpg')
// 有缩略图但缺宽高元数据：无法撑出与原图一致的盒子，必须退回直接用原图
const fileThumbNoMeta = file('u', 'u.jpg', 'C:\\cache\\u_thumb.jpg', null)

const thumbUrlA = toFileUrl(fileWithThumb.thumbnail) as string
const fullUrlA = toFileUrl(fileWithThumb.file_path) as string
const fullUrlN = toFileUrl(fileNoThumb.file_path) as string

function openFullscreen(files: MediaFile[], index = 0): void {
  act(() => {
    useUIStore.setState({
      fullscreenOpen: true,
      fullscreenIndex: index,
      fullscreenFiles: files,
      fullscreenTargetImg: null
    })
  })
}

function currentImg(): HTMLImageElement | null {
  return document.querySelector('[data-fullscreen-img]') as HTMLImageElement | null
}

function resetStores(): void {
  act(() => {
    useMediaStore.setState({ mediaFiles: [] })
    useUIStore.setState({
      fullscreenOpen: false,
      fullscreenIndex: 0,
      fullscreenFiles: null,
      fullscreenTargetImg: null
    })
  })
}

beforeEach(() => {
  decodeMode = 'resolve'
  pendingResolvers.length = 0
  pendingRejectors.length = 0
  preDecodedSources.length = 0
  vi.stubGlobal('Image', FakeImage)
  resetStores()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  resetStores()
})

describe('FullscreenViewer 首图策略（RC2：缩略图先行）', () => {
  it('核心：有缩略图时首帧显示缩略图，而非尚未加载的原图', () => {
    render(<FullscreenViewer filteredFiles={[fileWithThumb]} />)
    openFullscreen([fileWithThumb])

    const img = currentImg()
    expect(img, '未渲染全屏图片').not.toBeNull()
    expect(img?.getAttribute('src'), '首帧必须显示缓存命中的缩略图').toBe(thumbUrlA)
    expect(img?.getAttribute('src')).not.toBe(fullUrlA)
  })

  it('核心：原图预解码就绪后原子换源为原图', async () => {
    render(<FullscreenViewer filteredFiles={[fileWithThumb]} />)
    openFullscreen([fileWithThumb])
    expect(currentImg()?.getAttribute('src')).toBe(thumbUrlA)

    await act(async () => {
      await Promise.resolve()
    })

    await waitFor(() => expect(currentImg()?.getAttribute('src')).toBe(fullUrlA))
    expect(preDecodedSources, '应对原图发起一次离屏预解码').toEqual([fullUrlA])
  })

  it('边界：缺宽高元数据时不用缩略图占位（避免换源时「先小后跳」）', () => {
    render(<FullscreenViewer filteredFiles={[fileThumbNoMeta]} />)
    openFullscreen([fileThumbNoMeta])

    expect(currentImg()?.getAttribute('src')).toBe(toFileUrl(fileThumbNoMeta.file_path))
    expect(preDecodedSources).toEqual([])
  })

  it('边界：占位阶段按原图宽高比撑满盒子（width/height 属性）', () => {
    render(<FullscreenViewer filteredFiles={[fileWithThumb]} />)
    openFullscreen([fileWithThumb])

    const img = currentImg()
    expect(img?.getAttribute('width')).toBe('1920')
    expect(img?.getAttribute('height')).toBe('1080')
  })

  it('边界：无缩略图时直接使用原图（维持旧行为，不回归）', () => {
    render(<FullscreenViewer filteredFiles={[fileNoThumb]} />)
    openFullscreen([fileNoThumb])

    expect(currentImg()?.getAttribute('src')).toBe(fullUrlN)
    expect(preDecodedSources, '无可换之源时不发起多余解码').toEqual([])
  })

  it('边界：缩略图路径恰好等于原图路径时不重复换源', async () => {
    const identical = file('same', 'same.jpg', 'C:\\media\\same.jpg')
    render(<FullscreenViewer filteredFiles={[identical]} />)
    openFullscreen([identical])

    const src = currentImg()?.getAttribute('src')
    expect(src).toBe(toFileUrl(identical.file_path))
    expect(preDecodedSources).toEqual([])
  })

  it('异常：预解码失败时仍换回原图，且不进入加载失败态', async () => {
    decodeMode = 'reject'
    render(<FullscreenViewer filteredFiles={[fileWithThumb]} />)
    openFullscreen([fileWithThumb])

    await act(async () => {
      await Promise.resolve()
    })

    await waitFor(() => expect(currentImg()?.getAttribute('src')).toBe(fullUrlA))
  })

  it('边界：快速切换到下一张时，上一张的异步换源不得覆盖新图', async () => {
    decodeMode = 'pending'
    render(<FullscreenViewer filteredFiles={[fileWithThumb, secondFileWithThumb]} />)
    openFullscreen([fileWithThumb, secondFileWithThumb], 0)
    expect(currentImg()?.getAttribute('src')).toBe(thumbUrlA)

    // 切换到第二张：第一张的 decode 仍处于 pending
    act(() => {
      useUIStore.setState({ fullscreenIndex: 1 })
    })
    expect(currentImg()?.getAttribute('src')).toBe(toFileUrl(secondFileWithThumb.thumbnail))

    // 推进第一张的 decode：若缺少竞态保护会把 b 图换成 a 图原图
    await act(async () => {
      pendingResolvers[0]?.()
      await Promise.resolve()
    })
    expect(currentImg()?.getAttribute('src')).toBe(toFileUrl(secondFileWithThumb.thumbnail))

    // 推进第二张的 decode：才应换成第二张原图
    await act(async () => {
      pendingResolvers[1]?.()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(currentImg()?.getAttribute('src')).toBe(toFileUrl(secondFileWithThumb.file_path))
    )
  })

  it('回归：图片加载失败仍显示既有错误占位（无缩略图路径）', () => {
    render(<FullscreenViewer filteredFiles={[fileNoThumb]} />)
    openFullscreen([fileNoThumb])

    const img = currentImg()
    expect(img).not.toBeNull()
    fireEvent.error(img as HTMLImageElement)

    expect(currentImg(), '加载失败后不得继续显示 img').toBeNull()
  })

  it('边界：缩略图本身加载失败时升级为原图，而非直接报错', async () => {
    render(<FullscreenViewer filteredFiles={[fileWithThumb]} />)
    openFullscreen([fileWithThumb])

    const img = currentImg()
    fireEvent.error(img as HTMLImageElement)

    // 缩略图失败应就地升级为原图（原图可能仍可加载），不应落入错误占位
    expect(currentImg()?.getAttribute('src')).toBe(fullUrlA)

    // 原图也失败才进入错误态
    fireEvent.error(currentImg() as HTMLImageElement)
    expect(currentImg()).toBeNull()
  })
})
