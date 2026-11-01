/**
 * @layer L3
 * @module src/renderer/components/gallery/FullscreenViewer
 * @coverage 全屏前后切换画面抖动修复（jitter-fix）：换源三联状态原子性
 * @dependencies @testing-library/react + useUIStore + useMediaStore + 伪 Image（decode 按 src 手动推进）
 * @remarks
 *   根因：navigate 只改 store 下标，同帧渲染中 img 的 width/height 属性立即取新文件
 *   元数据，而 src（displayUrl）要等 effect 提交后才换成新缩略图——旧位图被塞进新
 *   比例的盒子重新 letterbox（横→竖整幅瞬间缩小过半再弹出），随后缩略图、原图再各
 *   换一次像素，一次翻页肉眼可见跳 2~3 下。
 *
 *   修复契约（换源三联状态 src / 宽高盒 / 归属文件 恒属同一文件）：
 *   - 新缩略图离屏 decode 就绪前，旧画面原样持稳（src 与宽高属性都不得提前切换）；
 *   - 就绪后 src 与宽高盒在同一次提交内原子切换（jsdom 只能断言 DOM 属性，原子性
 *     体现为「成组更新 → 单次渲染」）；
 *   - 原图 decode 就绪后宽高属性退场（还原固有尺寸语义）；
 *   - 快速往返翻页不降级缩略图、过期 probe 不回写；错误占位持稳到新图就绪。
 *
 *   断言口径：jsdom 不渲染位图、不模拟 paint，无法直接观测视觉跳动，故按 DOM 属性
 *   契约断言（src / width / height 序列），真实观感由真机实测兜底（计划 T5）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { FullscreenViewer } from './FullscreenViewer'
import { useUIStore } from '../../stores/uiStore'
import { useMediaStore, type MediaFile } from '../../stores/mediaStore'
import { toFileUrl } from '../../utils/file'

/** decode 按 src 手动推进的伪 Image：预取实例不调用 decode（天然无 resolver，可安全并提） */
class FakeImage {
  static instances: FakeImage[] = []
  src = ''
  resolvers: Array<() => void> = []
  rejectors: Array<(err: Error) => void> = []

  constructor() {
    FakeImage.instances.push(this)
  }

  decode(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resolvers.push(resolve)
      this.rejectors.push(reject)
    })
  }
}

/** 推进指定 src 的全部离屏 decode（同 src 的过期 probe 一并推进，由 cancelled 隔离） */
async function settleProbe(url: string): Promise<void> {
  await act(async () => {
    for (const instance of FakeImage.instances) {
      if (instance.src === url) {
        instance.resolvers.forEach((resolve) => resolve())
      }
    }
    // Promise.all → then 回调链需要多个微任务刻度
    for (let i = 0; i < 5; i++) {
      await Promise.resolve()
    }
  })
}

/** 令指定 src 的全部离屏 decode 拒绝（降级路径：decode 失败仍换源） */
function rejectProbe(url: string): void {
  for (const instance of FakeImage.instances) {
    if (instance.src === url) {
      instance.rejectors.forEach((reject) => reject(new Error('decode boom')))
    }
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

// 横图 A（1600×900）→ 竖图 B（900×1600）：比例翻转是 letterbox 跳变最敏感的场景
const fileA = makeFile({
  id: 'a',
  file_name: 'a.jpg',
  file_path: 'C:\\media\\a.jpg',
  thumbnail: 'C:\\cache\\a_thumb.jpg',
  width: 1600,
  height: 900
})
const fileB = makeFile({
  id: 'b',
  file_name: 'b.jpg',
  file_path: 'C:\\media\\b.jpg',
  thumbnail: 'C:\\cache\\b_thumb.jpg',
  width: 900,
  height: 1600
})

const fullUrlA = toFileUrl(fileA.file_path) as string
const thumbUrlB = toFileUrl(fileB.thumbnail) as string
const fullUrlB = toFileUrl(fileB.file_path) as string

function resetStores(): void {
  useMediaStore.setState({ mediaFiles: [] })
  useUIStore.setState({
    fullscreenOpen: false,
    fullscreenIndex: 0,
    fullscreenFiles: null,
    fullscreenTargetImg: null,
    slideshowOpen: false,
    slideshowStartIndex: 0
  })
}

/** 渲染前即打开全屏（沿用 topbarFix 口径：先 setState 后 render，避免时序抖动） */
function openFullscreen(files: MediaFile[], index = 0): void {
  useUIStore.setState({
    fullscreenOpen: true,
    fullscreenIndex: index,
    fullscreenFiles: files,
    fullscreenTargetImg: null
  })
}

function currentImg(): HTMLImageElement | null {
  return document.querySelector('[data-fullscreen-img]') as HTMLImageElement | null
}

/** 断言换源三联契约：src 与宽高盒必须同时匹配预期 */
function expectSource(
  img: HTMLImageElement | null,
  src: string,
  width: string | null,
  height: string | null,
  message: string
): void {
  expect(img, message).not.toBeNull()
  expect(img?.getAttribute('src'), `${message}（src）`).toBe(src)
  expect(img?.getAttribute('width'), `${message}（width）`).toBe(width)
  expect(img?.getAttribute('height'), `${message}（height）`).toBe(height)
}

let files: MediaFile[] = []

beforeEach(() => {
  FakeImage.instances = []
  vi.stubGlobal('Image', FakeImage)
  files = [fileA, fileB]
  resetStores()
  openFullscreen(files)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  FakeImage.instances = []
  resetStores()
})

/** 打开全屏并推进 A 的原图解码：进入「原图显示中」稳定态（宽高属性已退场） */
async function openSettledOnA(): Promise<void> {
  render(<FullscreenViewer filteredFiles={files} />)
  await settleProbe(fullUrlA)
  expectSource(currentImg(), fullUrlA, null, null, '前置：A 原图应已显示且宽高属性退场')
}

describe('全屏前后切换抖动（jitter-fix：换源三联原子性）', () => {
  it('①按钮切换：新缩略图就绪前旧画面持稳（src 与宽高盒都不得提前切到新图）', async () => {
    await openSettledOnA()

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '下一张' }))
    })

    expectSource(
      currentImg(),
      fullUrlA,
      '1600',
      '900',
      'B 缩略图就绪前 src 必须仍是 A 原图、宽高盒必须仍是 A 的尺寸——提前切盒子会让旧位图被塞进新比例盒重新 letterbox（切换抖动根因）'
    )
  })

  it('②键盘切换：ArrowRight 遵循同一持稳契约', async () => {
    await openSettledOnA()

    await act(async () => {
      fireEvent.keyDown(window, { key: 'ArrowRight' })
    })

    expectSource(
      currentImg(),
      fullUrlA,
      '1600',
      '900',
      '键盘翻页同样必须在新缩略图就绪前持稳旧画面'
    )
  })

  it('③原子换源：缩略图就绪时 src 与宽高盒同帧切到新图，原图就绪后宽高属性退场', async () => {
    await openSettledOnA()

    act(() => {
      useUIStore.setState({ fullscreenIndex: 1 })
    })
    // 持稳前置断言（修复前此处即红：src 已提前变成 B 缩略图）
    expectSource(currentImg(), fullUrlA, '1600', '900', '换源前旧画面必须持稳')

    await settleProbe(thumbUrlB)
    expectSource(currentImg(), thumbUrlB, '900', '1600', '缩略图就绪必须与宽高盒成组原子切换')

    await settleProbe(fullUrlB)
    expectSource(currentImg(), fullUrlB, null, null, '原图就绪后宽高属性退场（还原固有尺寸语义）')
  })

  it('④往返翻页：回退原图已在显示的文件不降级缩略图，过期 probe 不回写', async () => {
    await openSettledOnA()

    act(() => {
      useUIStore.setState({ fullscreenIndex: 1 })
    })
    expectSource(currentImg(), fullUrlA, '1600', '900', '前进持稳')

    act(() => {
      useUIStore.setState({ fullscreenIndex: 0 })
    })
    expectSource(
      currentImg(),
      fullUrlA,
      null,
      null,
      '回退到 A：src 不得降级为 A 缩略图（重开同图零闪烁）、宽高属性保持退场'
    )

    await settleProbe(thumbUrlB)
    await settleProbe(fullUrlB)
    expectSource(currentImg(), fullUrlA, null, null, 'B 的过期 probe 不得回写当前显示')
  })

  it('⑤异常降级：缩略图 probe 解码失败仍换源缩略图，并可经 onError 升级原图', async () => {
    await openSettledOnA()

    act(() => {
      useUIStore.setState({ fullscreenIndex: 1 })
    })
    expectSource(currentImg(), fullUrlA, '1600', '900', '换源前旧画面必须持稳')

    await act(async () => {
      rejectProbe(thumbUrlB)
      for (let i = 0; i < 5; i++) {
        await Promise.resolve()
      }
    })
    expectSource(
      currentImg(),
      thumbUrlB,
      '900',
      '1600',
      'decode 失败不判死图片：仍换源缩略图（既有降级语义）'
    )

    await act(async () => {
      fireEvent.error(currentImg() as HTMLImageElement)
    })
    expectSource(currentImg(), fullUrlB, null, null, '缩略图加载失败应升级为原图')
  })

  it('⑥错误占位持稳：前图加载失败后翻页，占位保持到新缩略图就绪才切图', async () => {
    await openSettledOnA()

    await act(async () => {
      fireEvent.error(currentImg() as HTMLImageElement)
    })
    expect(currentImg(), '前置：A 原图失败应进入错误占位').toBeNull()

    act(() => {
      useUIStore.setState({ fullscreenIndex: 1 })
    })
    expect(currentImg(), 'B 缩略图就绪前错误占位必须持稳（img 不得提前出现一帧又消失）').toBeNull()

    await settleProbe(thumbUrlB)
    expectSource(currentImg(), thumbUrlB, '900', '1600', '占位与新缩略图应成组原子切换')
  })
})
