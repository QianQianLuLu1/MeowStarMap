/**
 * ThumbReveal 骨架门控图组件单测（plan: 2026-09-30-fix-thumbnail-skeleton-reveal N3）
 *
 * 行为契约：缩略图 onLoad 完成前只显示骨架动画（.skeleton），img 保持 opacity-0
 * 不渲染可见内容；onLoad 后骨架卸载、img 200ms 淡入直显——彻底消灭"白屏 → 模糊 →
 * 清晰"渐进中间态（用户要求：清晰前不显示图片本体，加载动画平滑过渡到清晰图）。
 * 覆盖：未加载态 / 加载完成态 / src 变化重置 / onError 透传 / 空 src 不渲染 /
 * 复用重挂载不重放骨架（2026-10-18 网格滚动闪烁修复 N1）。
 *
 * ⚠️ 契约变更（N1）：原用例「缓存已完成图片：同 src 重挂载后仍显示骨架」把
 * 「每次重挂载都要重绘一帧骨架」写死成了期望，而这条帧正是网格向下滚动时逐格闪现的直接
 * 来源（VirtuosoGrid 卸载视口外的行，滚回即重挂载；视口外只扩 100px，重放必然发生在可见区）。
 * 现改为：同 src 重挂载首帧即已加载态；只有**换新 src**才回到骨架（见上方 src 变化与 T2 竞态用例）。
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

  // ===== N1：复用重挂载不得重放骨架（2026-10-18 网格滚动闪烁修复，原契约已反转） =====

  it('复用重挂载：同 src 卸载后重新挂载，首帧即已加载态、不重放骨架', () => {
    // 虚拟列表（VirtuosoGrid / masonic）卸载视口外的行，滚回即整棵卡片重挂载；
    // 组件挂载时视口外只扩 100px，重放必然发生在可见区 → 逐格闪一下。
    const srcA = 'media://remount-a.jpg'
    const first = render(<ThumbReveal src={srcA} alt="照片" onError={() => undefined} />)
    fireEvent.load(screen.getByAltText('照片'))
    expect(screen.queryByTestId('thumb-reveal-skeleton')).toBeNull()

    first.unmount()
    render(<ThumbReveal src={srcA} alt="照片" onError={() => undefined} />)
    // 该 src 曾完整加载成功 → 重挂载首帧直接是已加载态，不出现骨架节点
    expect(screen.queryByTestId('thumb-reveal-skeleton')).toBeNull()
    expect(screen.getByAltText('照片').className).toContain('opacity-100')
  })

  it('同实例换回已加载过的 src（滚出再滚回同一张）：同样不重放骨架', () => {
    const srcB = 'media://remount-b.jpg'
    const { rerender } = render(<ThumbReveal src={srcB} alt="照片" onError={() => undefined} />)
    fireEvent.load(screen.getByAltText('照片'))
    // 空 src：卡片退场（父级切到占位分支），img 与骨架一起卸载
    rerender(<ThumbReveal src="" alt="照片" onError={() => undefined} />)
    expect(screen.queryByAltText('照片')).toBeNull()
    // 换回同一 src：位图早已就绪，不得再走一次「骨架 → 淡入」
    rerender(<ThumbReveal src={srcB} alt="照片" onError={() => undefined} />)
    expect(screen.queryByTestId('thumb-reveal-skeleton')).toBeNull()
    expect(screen.getByAltText('照片').className).toContain('opacity-100')
  })

  it('加载失败的 src 不进入记忆：重挂载仍走骨架（坏图不被掩盖）', () => {
    // onError 只透传父级（回退/重建由父级决定），组件不得把失败记成「已加载」，
    // 否则重建成功后同 URL 会被直接判为就绪、露出空白像素。
    const srcBad = 'media://remount-bad.jpg'
    const onError = vi.fn()
    const first = render(<ThumbReveal src={srcBad} alt="照片" onError={onError} />)
    fireEvent.error(screen.getByAltText('照片'))
    expect(onError).toHaveBeenCalledTimes(1)
    // 失败仍显示骨架（既有契约不变）
    expect(screen.getByTestId('thumb-reveal-skeleton')).toBeTruthy()

    first.unmount()
    render(<ThumbReveal src={srcBad} alt="照片" onError={() => undefined} />)
    expect(screen.getByTestId('thumb-reveal-skeleton')).toBeTruthy()
    expect(screen.getByAltText('照片').className).toContain('opacity-0')
  })

  it('重试代次是独立记忆 key：a.jpg 加载完不会让 a.jpg&r=1 跳过骨架', () => {
    // standard 404 后就地重建会 bump &r=N（VirtualImageGrid.tsx:279-286,484-487）；
    // 换 URL 即换证据，必须重新走骨架，否则掩盖重建结果。
    const srcPlain = 'media://remount-nonce.jpg'
    const first = render(<ThumbReveal src={srcPlain} alt="照片" onError={() => undefined} />)
    fireEvent.load(screen.getByAltText('照片'))
    first.unmount()

    render(<ThumbReveal src={`${srcPlain}&r=1`} alt="照片" onError={() => undefined} />)
    expect(screen.getByTestId('thumb-reveal-skeleton')).toBeTruthy()
    expect(screen.getByAltText('照片').className).toContain('opacity-0')
  })

  it('记忆有界：超出上限按 FIFO 淘汰最早项，被淘汰项重挂载重新显示骨架', () => {
    // 不注入上限常量，直接用「比上限更多」的 src 数量驱动淘汰（当前上限 512）。
    const oldest = 'media://evict-oldest.jpg'
    const first = render(<ThumbReveal src={oldest} alt="照片" onError={() => undefined} />)
    fireEvent.load(screen.getByAltText('照片'))
    expect(screen.queryByTestId('thumb-reveal-skeleton')).toBeNull()
    first.unmount()

    // 依次加载 600 个不同 src（> 512 上限），把 oldest 挤出记忆
    for (let i = 0; i < 600; i++) {
      const { unmount } = render(
        <ThumbReveal src={`media://evict-${i}.jpg`} alt="照片" onError={() => undefined} />
      )
      fireEvent.load(screen.getByAltText('照片'))
      unmount()
    }

    render(<ThumbReveal src={oldest} alt="照片" onError={() => undefined} />)
    expect(screen.getByTestId('thumb-reveal-skeleton')).toBeTruthy()
  })
})
