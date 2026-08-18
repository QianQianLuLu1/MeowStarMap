import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// 反馈循环：所有渲染 media-card 的图库视图必须接入 onContextMenu，
// 否则该视图下图片右键菜单失效（用户报告的"部分场景右键无法使用"）。
// 跑红 = 存在视图未接 onContextMenu；修复后跑绿。
const galleryDir = path.resolve(process.cwd(), 'src', 'renderer', 'components', 'gallery')
const pagesDir = path.resolve(process.cwd(), 'src', 'renderer', 'pages')

const CARD_VIEWS = [
  'VirtualImageGrid.tsx',
  'ListView.tsx',
  'MasonryView.tsx',
  'TimelineView.tsx',
  'EventTimelineView.tsx'
]

describe('右键菜单接线结构性检查', () => {
  for (const file of CARD_VIEWS) {
    it(`${file} 声明并绑定 onContextMenu`, () => {
      const src = fs.readFileSync(path.join(galleryDir, file), 'utf-8')
      // 1) props 接口声明了 onContextMenu
      expect(src).toMatch(/onContextMenu\s*:/)
      // 2) 卡片元素绑定了 onContextMenu
      expect(src).toMatch(/onContextMenu\s*=\s*\{/)
    })
  }

  it('GalleryPage 为全部 5 个视图传递 onContextMenu', () => {
    const src = fs.readFileSync(path.join(pagesDir, 'GalleryPage.tsx'), 'utf-8')
    for (const view of [
      'VirtualImageGrid',
      'ListView',
      'MasonryView',
      'TimelineView',
      'EventTimelineView'
    ]) {
      // 截取该视图的 JSX 调用块（从 <ViewName 到对应的 /> 闭合），避免窗口溢出到下一个视图
      const startIdx = src.indexOf(`<${view}`)
      expect(startIdx, `${view} 调用块未找到`).toBeGreaterThan(-1)
      const endIdx = src.indexOf('/>', startIdx)
      expect(endIdx, `${view} 调用块未找到闭合 />`).toBeGreaterThan(startIdx)
      const block = src.slice(startIdx, endIdx + 2)
      expect(block, `${view} 调用处未传 onContextMenu`).toMatch(/onContextMenu\s*=\s*\{/)
    }
  })
})
