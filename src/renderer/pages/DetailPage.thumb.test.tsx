/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/pages/DetailPage
 * @coverage 详情页主图渐进加载（THUMBNAIL_OPTIMIZATION_PLAN 节点4）：
 *   有 thumbnail 的图片先显示低清底图，原图 onLoad 后淡入并卸载底图；
 *   无 placeholderSrc（无缩略图/游戏原生缩略图推导为 null）时行为与现状一致（单图直显）。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import fs from 'fs'
import path from 'path'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('../components/common/ZoomableContainer', () => ({
  ZoomableContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('../components/video/VideoPlayer', () => ({ VideoPlayer: () => null }))

import { ZoomableImage } from './DetailPage'

describe('DetailPage.ZoomableImage 渐进加载（节点4）', () => {
  it('正常：有 placeholderSrc → 底图先行，原图 onLoad 后淡入并卸载底图', () => {
    const { container } = render(
      <ZoomableImage
        src="media://file?path=big.jpg"
        alt="a"
        isVideo={false}
        onClick={() => {}}
        placeholderSrc="media://file?path=big_low.jpg"
      />
    )
    // 原图加载完成前：低清底图 + 原图（opacity-0 待淡入）
    expect(container.querySelectorAll('img')).toHaveLength(2)
    const original = screen.getByAltText('a')
    expect(original.className).toContain('opacity-0')
    fireEvent.load(original)
    expect(original.className).toContain('opacity-100')
    expect(container.querySelectorAll('img')).toHaveLength(1)
  })

  it('边界：无 placeholderSrc → 单图直接完整显示（现状不变）', () => {
    const { container } = render(
      <ZoomableImage src="media://file?path=big.jpg" alt="a" isVideo={false} onClick={() => {}} />
    )
    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(screen.getByAltText('a').className).toContain('opacity-100')
  })
})

describe('DetailPage 主图接线（源码结构，THUMBNAIL_OPTIMIZATION_PLAN 节点4）', () => {
  it('主图传入由 thumbnail 推导的低清底图（游戏原生缩略图推导 null → 行为不变）', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src', 'renderer', 'pages', 'DetailPage.tsx'),
      'utf-8'
    )
    // 剔除注释行，防止修复说明注释本身命中断言造成假通过
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n')
    expect(code).toContain('toLowQualityUrl(media.thumbnail)')
    expect(code).toContain('placeholderSrc={thumbPlaceholderUrl}')
  })
})
