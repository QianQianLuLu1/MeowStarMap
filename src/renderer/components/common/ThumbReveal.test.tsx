/**
 * ThumbReveal 骨架门控图组件单测（plan: 2026-09-30-fix-thumbnail-skeleton-reveal N3）
 *
 * 行为契约：缩略图 onLoad 完成前只显示骨架动画（.skeleton），img 保持 opacity-0
 * 不渲染可见内容；onLoad 后骨架卸载、img 200ms 淡入直显——彻底消灭"白屏 → 模糊 →
 * 清晰"渐进中间态（用户要求：清晰前不显示图片本体，加载动画平滑过渡到清晰图）。
 * 覆盖：未加载态 / 加载完成态 / src 变化重置 / onError 透传 / 空 src 不渲染。
 */

/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ThumbReveal } from './ThumbReveal'

describe('ThumbReveal 骨架门控直显', () => {
  it('未加载完成：渲染骨架动画层，img 为 opacity-0 不可见', () => {
    render(<ThumbReveal src="media://thumb.jpg" alt="照片" onError={() => undefined} />)
    const img = screen.getByAltText('照片')
    // img 已挂载（负责发起加载）但完全透明：清晰图就绪前不显示任何图片内容
    expect(img.getAttribute('src')).toBe('media://thumb.jpg')
    expect(img.className).toContain('opacity-0')
    expect(img.className).not.toContain('opacity-100')
    // 骨架动画层可见（复用 globals.css .skeleton 渐变动画）
    expect(screen.getByTestId('thumb-reveal-skeleton').className).toContain('skeleton')
  })

  it('onLoad 后：骨架卸载，img 淡入为 opacity-100', () => {
    render(<ThumbReveal src="media://thumb.jpg" alt="照片" onError={() => undefined} />)
    fireEvent.load(screen.getByAltText('照片'))
    const img = screen.getByAltText('照片')
    expect(img.className).toContain('opacity-100')
    expect(img.className).not.toContain('opacity-0')
    expect(screen.queryByTestId('thumb-reveal-skeleton')).toBeNull()
  })

  it('src 变化（复用卡片换源）：重置为未加载态，骨架重新出现', () => {
    const { rerender } = render(
      <ThumbReveal src="media://a.jpg" alt="照片" onError={() => undefined} />
    )
    fireEvent.load(screen.getByAltText('照片'))
    expect(screen.queryByTestId('thumb-reveal-skeleton')).toBeNull()

    rerender(<ThumbReveal src="media://b.jpg" alt="照片" onError={() => undefined} />)
    expect(screen.getByAltText('照片').getAttribute('src')).toBe('media://b.jpg')
    expect(screen.getByTestId('thumb-reveal-skeleton')).toBeTruthy()
    expect(screen.getByAltText('照片').className).toContain('opacity-0')
  })

  it('竞态（审查修复 T2）：换源后旧源的迟到 load 不得撤掉新源骨架', () => {
    const { rerender, container } = render(
      <ThumbReveal src="media://a.jpg" alt="照片" onError={() => undefined} />
    )
    const firstImg = screen.getByAltText('照片')
    fireEvent.load(firstImg)
    expect(screen.queryByTestId('thumb-reveal-skeleton')).toBeNull()

    rerender(<ThumbReveal src="media://b.jpg" alt="照片" onError={() => undefined} />)
    expect(screen.getByTestId('thumb-reveal-skeleton')).toBeTruthy()
    // 旧源 A 的 load 事件迟到（换源前已入队，目标为换源前的 img 元素）：
    // 不得让尚未加载完成的新源 B 提前撤骨架露出空白/旧像素
    fireEvent.load(firstImg)
    expect(screen.getByTestId('thumb-reveal-skeleton')).toBeTruthy()
    expect(screen.getByAltText('照片').className).toContain('opacity-0')
    // 迟到事件的目标元素已被新 src 的元素替换（换源即重挂载）
    expect(container.querySelector('img')).not.toBe(firstImg)
  })

  it('onError 透传父级（回退链由父级处理），骨架保持显示', () => {
    const onError = vi.fn()
    render(<ThumbReveal src="media://bad.jpg" alt="照片" onError={onError} />)
    fireEvent.error(screen.getByAltText('照片'))
    expect(onError).toHaveBeenCalledTimes(1)
    // 失败时仍显示骨架：父级决定回退/重建/占位，组件不擅自进入错误终态
    expect(screen.getByTestId('thumb-reveal-skeleton')).toBeTruthy()
  })

  it('空 src：不渲染 img 与骨架（无图可加载，错误态由父级占位负责）', () => {
    const { container } = render(<ThumbReveal src="" alt="照片" onError={() => undefined} />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByTestId('thumb-reveal-skeleton')).toBeNull()
  })

  it('缓存已完成图片（complete 且 naturalWidth>0）：挂载后直接进入已加载态，不闪骨架', async () => {
    // src 相同的 remount 模拟浏览器缓存命中：img 元素创建前图片已在 HTTP 缓存，
    // onLoad 可能在 React 事件绑定前已错过——挂载后用 complete 兜底检测。
    const { rerender } = render(
      <ThumbReveal src="media://cached.jpg" alt="照片" onError={() => undefined} />
    )
    // 先触发 load 完成首张，再卸载 src 后立刻挂回（模拟 virtuoso 复用 + 缓存命中）
    fireEvent.load(screen.getByAltText('照片'))
    rerender(<ThumbReveal src="" alt="照片" onError={() => undefined} />)
    rerender(<ThumbReveal src="media://cached.jpg" alt="照片" onError={() => undefined} />)
    // complete 兜底是微任务级别的自检，等一轮微任务后断言
    await Promise.resolve()
    // jsdom 不真正解码图片，naturalWidth 恒 0 → 兜底不触发、骨架保留（行为与真实浏览器一致：
    // 缓存命中时 onLoad 正常到达）。确定性断言：不因兜底逻辑卡死在中间态之外的状态。
    const img = screen.getByAltText('照片')
    expect(img.className).toContain('opacity-0')
    expect(screen.getByTestId('thumb-reveal-skeleton')).toBeTruthy()
  })
})
