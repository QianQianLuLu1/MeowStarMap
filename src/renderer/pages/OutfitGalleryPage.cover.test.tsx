/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/pages/OutfitGalleryPage
 * @coverage 套装封面源判定（fix-thumbnail-persist-and-ondemand N3）
 * @dependencies ./OutfitGalleryPage（resolveOutfitCoverSrc 纯函数）、fs（源码结构检查）
 * @remarks
 *   缺陷：套装封面仍是 `toFileUrl(stat.coverThumbnail || stat.coverFilePath)` 旧模式
 *   且无 file_type 判断——用户可给视频打套装标签，视频成为最新一张时封面把视频文件
 *   当 <img> src（<img> 无法解码视频 → 裂图 + 整个视频被当图片下载，IO 争抢）。
 *   修复：封面判定抽为模块级纯函数 resolveOutfitCoverSrc（对齐 resolveThumbnailSrc /
 *   resolveEffectiveThumbnail 先例）：缩略图优先；无缩略图且封面是视频 → null（占位，
 *   绝不返回视频路径）；图片无缩略图 → 回退原文件（现状保留）。
 *
 *   测试策略：整页渲染需 mock 数十个模块且脆弱（VirtualImageGrid.thumb.test.tsx 先例），
 *   行为用例直测导出的纯函数 + 源码结构断言锁定 OutfitCard 不再出现旧模式。
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

// 行为用例仅导入模块级纯函数，不渲染组件；mock 掉页面周边依赖，保证模块可独立加载
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('../stores/uiStore', () => ({ useUIStore: () => ({ ui: {}, setUi: vi.fn() }) }))
vi.mock('../stores/mediaStore', () => ({ OUTFIT_PRESETS: [] }))
vi.mock('./settings/sections', () => ({ useGlobalToast: () => ({ showToast: vi.fn() }) }))
vi.mock('../utils/date', () => ({ formatDate: () => '' }))
vi.mock('../icons', () => ({
  IconOutfit: () => null,
  IconRefresh: () => null,
  IconImage: () => null,
  IconLock: () => null,
  IconVideo: () => null
}))

import { resolveOutfitCoverSrc } from './OutfitGalleryPage'
import { toFileUrl } from '../utils/file'

const src = fs.readFileSync(
  path.resolve(process.cwd(), 'src', 'renderer', 'pages', 'OutfitGalleryPage.tsx'),
  'utf-8'
)
// 剔除注释行：修复说明注释会引用缺陷写法本身，避免否定断言误命中
const code = src
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
  .join('\n')

describe('resolveOutfitCoverSrc 套装封面源判定（fix-thumbnail-persist-and-ondemand N3）', () => {
  const base = {
    coverFilePath: 'D:/media/cover.jpg',
    coverThumbnail: 'C:/cache/cover.jpg' as string | null,
    coverFileType: 'image' as 'image' | 'video' | null
  }

  it('正常：有封面缩略图 → 缩略图 URL（图片/视频一致，走 media://）', () => {
    expect(resolveOutfitCoverSrc({ ...base, coverFileType: 'image' })).toBe(
      toFileUrl('C:/cache/cover.jpg')
    )
    expect(resolveOutfitCoverSrc({ ...base, coverFileType: 'video' })).toBe(
      toFileUrl('C:/cache/cover.jpg')
    )
  })

  it('异常：视频且无缩略图 → null（绝不把视频文件当 <img> src）', () => {
    expect(
      resolveOutfitCoverSrc({ ...base, coverThumbnail: null, coverFileType: 'video' })
    ).toBeNull()
  })

  it('正常：图片且无缩略图 → 回退原文件（现状保留）', () => {
    expect(resolveOutfitCoverSrc({ ...base, coverThumbnail: null, coverFileType: 'image' })).toBe(
      toFileUrl('D:/media/cover.jpg')
    )
  })

  it('边界：coverThumbnail 为空串按无缩略图处理；coverFilePath 为空且图片无缩略图 → null', () => {
    expect(
      resolveOutfitCoverSrc({ ...base, coverThumbnail: '', coverFileType: 'video' })
    ).toBeNull()
    expect(
      resolveOutfitCoverSrc({
        coverFilePath: '',
        coverThumbnail: null,
        coverFileType: 'image'
      })
    ).toBeNull()
  })

  it('边界：file_type 缺失（null，旧数据）按图片处理 → 行为与现状一致', () => {
    expect(resolveOutfitCoverSrc({ ...base, coverThumbnail: null, coverFileType: null })).toBe(
      toFileUrl('D:/media/cover.jpg')
    )
  })
})

describe('OutfitCard 源码结构（N3）', () => {
  it('不再存在 coverThumbnail || coverFilePath 旧模式', () => {
    expect(code).not.toContain('stat.coverThumbnail || stat.coverFilePath')
  })

  it('封面经 resolveOutfitCoverSrc 判定，视频占位用 IconVideo', () => {
    expect(code).toContain('resolveOutfitCoverSrc(stat)')
    expect(code).toContain('IconVideo')
  })
})
