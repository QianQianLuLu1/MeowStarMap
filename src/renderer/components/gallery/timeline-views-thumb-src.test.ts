/**
 * @module src/renderer/components/gallery/TimelineView + EventTimelineView
 * @coverage 时间线视图缩略图源统一（fix-thumbnail-display-and-latency N1）
 * @remarks 缺陷同 ListView：`toFileUrl(file.thumbnail || file.file_path)` 对 thumbnail
 *   为空的视频回退用「原视频文件」作 <img> 源必裂图。两个视图依赖 react-virtuoso
 *   分组渲染与 i18n，直接 render 需 mock 数十个模块（沿仓库既定测试策略），
 *   故采用源码结构断言（RecycleBinPage.thumb.test.tsx / VirtualImageGrid.thumb.test.tsx
 *   先例）+ resolveThumbnailSrc 纯函数行为用例（thumbnail-src.test.tsx）组合防护。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/** 剔除注释行，避免修复说明注释引用缺陷写法本身造成假失败 */
const stripComments = (src: string) =>
  src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n')

const readGallerySource = (name: string) =>
  stripComments(
    fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/components/gallery', name), 'utf-8')
  )

describe.each(['TimelineView.tsx', 'EventTimelineView.tsx'])('%s 缩略图源结构（N1）', (name) => {
  it('不得存在「thumbnail || file_path」旧回退写法（视频裂图根因）', () => {
    expect(readGallerySource(name)).not.toContain('toFileUrl(file.thumbnail || file.file_path)')
  })

  it('缩略图源统一走 resolveThumbnailSrc', () => {
    expect(readGallerySource(name)).toContain('resolveThumbnailSrc(file)')
  })
})

// ============================================================================
// N8：TimelineView 行 key 稳定性（fix-thumbnail-display-and-latency）
// ============================================================================
describe('TimelineView 行 key（N8）', () => {
  // 缺陷：行级 key 用 `row-${index}`——插入/删除文件后所有行下标整体移位，
  // 行子树整屏重挂载，行内全部缩略图 img 重新发起 media:// 请求（闪烁 + 慢）。
  // 修复：以行内首个文件 id 作 key（空行兜底 index），增删后未变动行不重挂载。
  it('行 key 不得使用纯下标，应以行内首个文件 id 命名', () => {
    const code = readGallerySource('TimelineView.tsx')
    expect(code).not.toContain('`row-${index}`')
    expect(code).toContain('`row-${unit.files[0]?.id ?? index}`')
  })
})
