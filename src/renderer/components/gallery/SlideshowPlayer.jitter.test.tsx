/**
 * @layer L3
 * @module src/renderer/components/gallery/SlideshowPlayer
 * @coverage 幻灯片切换抖动修复（jitter-fix）：宽高盒预成形 + 播放顺序邻居预取
 * @dependencies @testing-library/react + useUIStore + useMediaStore + 伪 Image
 * @remarks
 *   根因：每次翻页 setTransitionKey 强制重挂载媒体容器，img 直接以 4K 原图为 src，
 *   无 width/height 属性（位图加载前盒子零尺寸）且无预加载 → 空白/黑框后图片加载完
 *   突然撑开，fade/slide 动画跑在空盒上与撑开叠加。
 *
 *   修复契约：
 *   - 图片按元数据设置 width/height 属性：盒子在位图加载前即按原比例成形（撑开跳动
 *     消失，过渡动画作用于稳定盒子）；
 *   - 按播放顺序（洗牌感知）预热相邻原图（复用 useNeighborPrefetch，翻页即点即显）；
 *   - 无元数据文件不设宽高属性（无法预成形，不硬造）；视频邻居不预热（<img> 无法
 *     解码视频，沿用 useNeighborPrefetch 既有跳过逻辑）。
 *
 *   断言口径：jsdom 不渲染位图，按 DOM 属性（width/height）与预取实例（new Image()
 *   的 src 序列）断言，真实观感由真机实测兜底（计划 T5）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, act, cleanup } from '@testing-library/react'
import { SlideshowPlayer } from './SlideshowPlayer'
import { useUIStore, type SlideshowConfig } from '../../stores/uiStore'
import { useMediaStore, type MediaFile } from '../../stores/mediaStore'
import { toFileUrl } from '../../utils/file'

/** 预取只 new Image() 设 src、不调用 decode，故仅需记录实例 */
class FakeImage {
  static instances: FakeImage[] = []
  src = ''
  constructor() {
    FakeImage.instances.push(this)
  }
  decode(): Promise<void> {
    return Promise.resolve()
  }
}

function makeFile(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    id: '1',
    file_path: 'C:\\media\\k1.jpg',
    file_name: 'k1.jpg',
    file_type: 'image',
    file_ext: '.jpg',
    file_size: 1024,
    created_at: '2026-01-01T00:00:00.000Z',
    modified_at: '2026-01-01T00:00:00.000Z',
    thumbnail: 'C:\\cache\\k1_thumb.jpg',
    tags: [],
    rating: 0,
    is_favorite: false,
    notes: '',
    scene_category: 'other',
    width: 1600,
    height: 900,
    ...overrides
  }
}

const fileA = makeFile({
  id: 'a',
  file_name: 'a.jpg',
  file_path: 'C:\\media\\a.jpg',
  width: 1600,
  height: 900
})
const fileB = makeFile({
  id: 'b',
  file_name: 'b.jpg',
  file_path: 'C:\\media\\b.jpg',
  width: 900,
  height: 1600
})
// 无元数据：无法预成形，不得硬造宽高属性
const fileNoMeta = makeFile({
  id: 'c',
  file_name: 'c.jpg',
  file_path: 'C:\\media\\c.jpg',
  width: undefined,
  height: undefined
})
const fileVideo = makeFile({
  id: 'v',
  file_name: 'v.mp4',
  file_path: 'C:\\media\\v.mp4',
  file_type: 'video',
  file_ext: '.mp4',
  width: undefined,
  height: undefined
})

const fullUrlA = toFileUrl(fileA.file_path)
const fullUrlB = toFileUrl(fileB.file_path)
const fullUrlC = toFileUrl(fileNoMeta.file_path)
const fullUrlV = toFileUrl(fileVideo.file_path)

const defaultConfig: SlideshowConfig = {
  order: 'sequence',
  interval: 3000,
  transition: 'fade',
  loop: false,
  skipVideo: true
}

function resetStores(): void {
  useMediaStore.setState({ mediaFiles: [] })
  useUIStore.setState({
    slideshowOpen: false,
    slideshowStartIndex: 0,
    slideshowConfig: { ...defaultConfig },
    fullscreenOpen: false,
    fullscreenIndex: 0,
    fullscreenFiles: null,
    fullscreenTargetImg: null
  })
}

function openSlideshow(startIndex = 0): void {
  useUIStore.setState({ slideshowOpen: true, slideshowStartIndex: startIndex })
}

function slideshowImg(): HTMLImageElement | null {
  return document.querySelector('[role="dialog"] img') as HTMLImageElement | null
}

function prefetchedSrcs(): string[] {
  return FakeImage.instances.map((instance) => instance.src)
}

beforeEach(() => {
  FakeImage.instances = []
  vi.stubGlobal('Image', FakeImage)
  resetStores()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  FakeImage.instances = []
  resetStores()
})

describe('幻灯片切换抖动（jitter-fix：宽高盒 + 播放顺序预取）', () => {
  it('①图片带原图宽高盒：位图加载前盒子即按原比例成形', () => {
    const files = [fileA, fileB]
    openSlideshow()
    render(<SlideshowPlayer filteredFiles={files} />)

    const img = slideshowImg()
    expect(img, '应渲染幻灯片图片').not.toBeNull()
    expect(img?.getAttribute('src')).toBe(fullUrlA)
    expect(
      img?.getAttribute('width'),
      '缺 width 属性：位图加载前盒子零尺寸，加载完突然撑开（切换抖动根因）'
    ).toBe('1600')
    expect(img?.getAttribute('height')).toBe('900')
  })

  it('②按播放顺序预热相邻原图（顺序模式：前进预热后一张、翻页后回补前一张）', () => {
    const files = [fileA, fileB]
    openSlideshow()
    render(<SlideshowPlayer filteredFiles={files} />)

    expect(
      prefetchedSrcs(),
      '播放第 1 张时应预热第 2 张原图（零预取导致翻页现场加载，空白后突然撑开）'
    ).toContain(fullUrlB)

    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowRight' })
    })
    expect(prefetchedSrcs(), '翻到第 2 张后应回补预热第 1 张原图（往回翻即点即显）').toContain(
      fullUrlA
    )
  })

  it('③洗牌模式按播放顺序预热：恰好预热 1 个相邻原图', () => {
    const files = [fileA, fileB, fileNoMeta]
    useUIStore.setState({ slideshowConfig: { ...defaultConfig, order: 'shuffle' } })
    openSlideshow()
    render(<SlideshowPlayer filteredFiles={files} />)

    // 洗牌序不可预知，但 playOrder[0] 恒为起始张、3 张序列的 pos0 恒恰有 1 个后邻
    const others = [fullUrlB, fullUrlC]
    const prefetched = prefetchedSrcs().filter((src) => others.includes(src))
    expect(prefetched, '洗牌模式应恰好预热 1 个相邻原图（按播放顺序而非数组顺序）').toHaveLength(1)
    expect(prefetchedSrcs()).not.toContain(fullUrlA)
  })

  it('④边界：无元数据不设宽高盒；视频邻居不预热；末尾停播不崩溃', async () => {
    const files = [fileA, fileNoMeta, fileVideo]
    // 不跳过视频，让视频进入播放序列
    useUIStore.setState({ slideshowConfig: { ...defaultConfig, skipVideo: false } })
    openSlideshow()
    render(<SlideshowPlayer filteredFiles={files} />)

    expect(prefetchedSrcs(), 'pos0 的图片邻居应被预热（修复前零预取，此处红灯）').toContain(
      fullUrlC
    )
    expect(prefetchedSrcs(), '视频邻居不得预热（<img> 无法解码视频）').not.toContain(fullUrlV)

    // 翻到无元数据的 fileNoMeta：仍渲染 img 但不设宽高属性（不硬造比例）
    await act(async () => {
      fireEvent.keyDown(window, { key: 'ArrowRight' })
    })
    const img = slideshowImg()
    expect(img, '无元数据图片仍应渲染').not.toBeNull()
    expect(img?.getAttribute('width')).toBeNull()
    expect(img?.getAttribute('height')).toBeNull()
    expect(img?.getAttribute('src')).toBe(fullUrlC)

    // 翻到视频：渲染 video 元素
    await act(async () => {
      fireEvent.keyDown(window, { key: 'ArrowRight' })
    })
    expect(document.querySelector('[role="dialog"] video')).not.toBeNull()

    // 末尾（loop=false）再按下一张：停在原地不崩溃
    await act(async () => {
      fireEvent.keyDown(window, { key: 'ArrowRight' })
    })
    expect(document.querySelector('[role="dialog"] video')).not.toBeNull()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 审查收口（review-fix）：播放状态机两处残余缺陷的红-绿回归
// F1：暂停态改播放间隔被拉回播放——useSlideshow.start 的引用随 interval 重建
//     （useCallback 依赖 [interval]），interval 变化 → 自动启动 effect 重入 →
//     强制 setIsPlaying(true)
// F2：videoEndedRef「因等待暂停」标记跨手动导航/暂停残留——togglePlay 不清标记，
//     暂停态可被后续视频播完事件无声复播
// ---------------------------------------------------------------------------

const videoB = makeFile({
  id: 'v2',
  file_name: 'v2.mp4',
  file_path: 'C:\\media\\v2.mp4',
  file_type: 'video',
  file_ext: '.mp4',
  width: undefined,
  height: undefined
})

describe('幻灯片播放状态机（审查收口：暂停态语义）', () => {
  it('⑤暂停后修改播放间隔保持暂停（F1：interval 变化重建 start 引用不得复播）', () => {
    vi.useFakeTimers()
    try {
      const files = [fileA, fileB]
      openSlideshow()
      render(<SlideshowPlayer filteredFiles={files} />)

      // 空格暂停（打开即自动播放 → toggle → stop）
      act(() => {
        fireEvent.keyDown(window, { key: ' ' })
      })

      // 设置抽屉改播放间隔的等价 store 变更（间隔预设按钮即 setSlideshowConfig({ interval })，
      // interval 取预设联合类型中的最小值 1000）
      act(() => {
        useUIStore.setState({ slideshowConfig: { ...defaultConfig, interval: 1000 } })
      })

      // 新间隔（1000ms）远小于打开时默认间隔（3000ms）：若被拉回播放，1200ms 内必然已翻页
      act(() => {
        vi.advanceTimersByTime(1200)
      })

      expect(
        slideshowImg()?.getAttribute('src'),
        '暂停后修改播放间隔不得恢复播放（否则用户暂停被静默覆盖、当前页倒计时被清零）'
      ).toBe(fullUrlA)
    } finally {
      vi.useRealTimers()
    }
  })

  it('⑥过期的视频等待标记不得复活暂停态（F2：togglePlay 清除标记）', () => {
    vi.useFakeTimers()
    try {
      // 图-视频-图-视频-图：等待置位/播/停都发生在可观测的图片页之间，且末位视频
      // 后仍有图片页（避免 loop=false 停播分支截断恢复链）
      const files = [fileA, fileVideo, fileB, videoB, fileNoMeta]
      useUIStore.setState({
        slideshowConfig: { ...defaultConfig, skipVideo: false, loop: true, interval: 3000 }
      })
      openSlideshow()
      render(<SlideshowPlayer filteredFiles={files} />)

      // 翻到首个视频：等待 effect 置位 videoEndedRef 并自动停表
      act(() => {
        fireEvent.keyDown(window, { key: 'ArrowRight' })
      })
      expect(document.querySelector('[role="dialog"] video'), '应停在首个视频').not.toBeNull()

      // 翻回图片页 → 空格播放 → 再空格暂停（等待语义已随离开视频过期）
      act(() => {
        fireEvent.keyDown(window, { key: 'ArrowRight' })
      })
      act(() => {
        fireEvent.keyDown(window, { key: ' ' })
      })
      act(() => {
        fireEvent.keyDown(window, { key: ' ' })
      })

      // 暂停态翻到第二个视频（等待 effect 因 isPlaying=false 不置位），视频播完
      act(() => {
        fireEvent.keyDown(window, { key: 'ArrowRight' })
      })
      const video = document.querySelector('[role="dialog"] video') as HTMLVideoElement | null
      expect(video, '应已翻到第二个视频').not.toBeNull()
      act(() => {
        fireEvent.ended(video as HTMLVideoElement)
      })

      // 若过期标记复活播放：一个间隔后循环回第 1 张（bug 可观测）；修复后应停在末页
      act(() => {
        vi.advanceTimersByTime(3100)
      })

      expect(
        slideshowImg()?.getAttribute('src'),
        '手动暂停后视频播完不得恢复自动播放（videoEndedRef 是「因等待暂停」标记，跨会话残留即过期）'
      ).toBe(fullUrlC)
    } finally {
      vi.useRealTimers()
    }
  })
})
