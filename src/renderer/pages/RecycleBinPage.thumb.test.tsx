/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/pages/RecycleBinPage
 * @coverage 缩略图 URL 构造契约：必须走 media:// 协议，不得退化为 file://
 * @dependencies fs（源码结构检查）、src/renderer/utils/file
 * @remarks 缺陷B 回归防护。打包版 v2.3.5 日志实测 570 次
 *   `Not allowed to load local resource: file:///C:/.../thumbnails/*.jpg`，
 *   根因为 `new URL(绝对Windows路径, 'media://')` 把盘符「C:」当作 scheme 解析
 *   （protocol === 'c:'）且不抛异常，致 catch 分支失效并返回畸形 URL，
 *   最终被 Chromium 按 file 协议拒绝加载。
 *
 * 测试策略：RecycleBinPage 依赖 react-virtuoso / mediaStore / i18n 与大量子组件，
 *   直接 render 需 mock 数十个模块且脆弱。参考项目已有 GalleryPage.test.tsx 的
 *   源码结构性检查模式，并补充 toFileUrl 的行为断言（该函数此前无测试覆盖）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import fs from 'fs'
import path from 'path'
import { toFileUrl } from '../utils/file'
import type { MediaFile } from '../stores/mediaStore'
import { RecycleBinItemComponent } from './RecycleBinPage'

const recycleBinPageSrc = fs.readFileSync(
  path.resolve(process.cwd(), 'src', 'renderer', 'pages', 'RecycleBinPage.tsx'),
  'utf-8'
)

/**
 * 剔除注释行后的源码。修复说明注释中会引用缺陷写法本身，
 * 若直接对全文做否定断言会误命中注释造成假失败。
 */
const recycleBinPageCode = recycleBinPageSrc
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
  .join('\n')

/** 日志中真实出现的缩略图绝对路径 */
const REAL_THUMB_PATH =
  'C:\\Users\\<username>\\AppData\\Roaming\\wxnn-photo-manager\\thumbnails\\ff6b32029931c766.jpg'

describe('RecycleBinPage 缩略图 URL 构造契约（缺陷B）', () => {
  it("不得再用 new URL(..., 'media://') 构造缩略图 URL", () => {
    // 该写法对绝对 Windows 路径会静默产出 file:/// URL，是缺陷B 的根因
    expect(recycleBinPageCode).not.toMatch(/new URL\([^)]*'media:\/\/'\)/)
  })

  it('缩略图源统一经 resolveThumbnailSrc 判定（N1：视频无缩略图不回退原文件防裂图）', () => {
    // 旧契约「toFileUrl(file.thumbnail || file.file_path)」把视频文件本身当 <img> 源，
    // 是视频裂图根因（对齐 VirtualImageGrid.resolveEffectiveThumbnail 不变量），已废除
    expect(recycleBinPageCode).toContain('resolveThumbnailSrc(file)')
    expect(recycleBinPageCode).not.toContain('toFileUrl(file.thumbnail || file.file_path)')
  })

  it('骨架门控直显（fix-thumbnail-skeleton-reveal N5）：裸 <img> 已替换为 ThumbReveal', () => {
    expect(recycleBinPageCode).toContain('<ThumbReveal')
    expect(recycleBinPageCode).not.toContain('<img')
  })
})

describe('toFileUrl 对绝对 Windows 路径的行为（缺陷B 根因验证）', () => {
  beforeAll(() => {
    // toFileUrl 仅在检测到 electronAPI 时才走 media:// 分支
    Object.assign(window, { electronAPI: {} })
  })

  afterAll(() => {
    Object.assign(window, { electronAPI: undefined })
  })

  it('绝对 Windows 路径应产出 media:// URL，且绝不以 file:// 开头', () => {
    const url = toFileUrl(REAL_THUMB_PATH)
    expect(url).toBeTruthy()
    expect(url!.startsWith('media://file?path=')).toBe(true)
    expect(url!.startsWith('file://')).toBe(false)
    // 反斜杠须归一化为正斜杠后再编码
    expect(url).toContain(encodeURIComponent('C:/Users/<username>'))
  })

  it("根因对照：new URL(绝对路径, 'media://') 会把盘符当作 scheme 而非 media 协议", () => {
    // 说明「为何不能用 new URL」——它不抛异常，因此原代码的 catch 兜底完全失效
    const bad = new URL(REAL_THUMB_PATH, 'media://')
    expect(bad.protocol).toBe('c:')
    expect(bad.protocol).not.toBe('media:')
  })

  it('已是 media:// 的输入原样返回（幂等）', () => {
    const already = 'media://file?path=a%2Fb.jpg'
    expect(toFileUrl(already)).toBe(already)
  })

  it('空值输入返回 null（渲染层据此显示占位图）', () => {
    expect(toFileUrl(null)).toBeNull()
    expect(toFileUrl(undefined)).toBeNull()
    expect(toFileUrl('')).toBeNull()
  })
})

describe('RecycleBinItem thumbFailed 失败态复位（审查修复 T5）', () => {
  const makeFile = (thumbnail: string | null): MediaFile =>
    ({
      id: 'f1',
      file_name: 'photo.jpg',
      file_path: 'D:/photos/photo.jpg',
      file_type: 'image',
      file_ext: '.jpg',
      file_size: 1024,
      created_at: '2026-01-01T00:00:00',
      modified_at: '2026-01-01T00:00:00',
      deleted_at: '2026-01-02T00:00:00',
      tags: [],
      rating: 0,
      is_favorite: false,
      notes: '',
      is_missing: false,
      is_corrupted: false,
      thumbnail
    }) as unknown as MediaFile

  const renderItem = (file: MediaFile) =>
    render(<RecycleBinItemComponent file={file} selected={false} onToggle={() => {}} />)

  it('异常后恢复：缩略图加载失败 → 图标占位；同 id 条目缩略图补齐后必须恢复加载', () => {
    // Virtuoso 以 computeItemKey={file.id} 复用实例：数据刷新（恢复/重扫描后缩略图
    // 补齐）= 同一实例收到新 file。thumbFailed 若不复位，新缩略图永不显示、停留图标态。
    const { rerender, container } = renderItem(makeFile('C:/cache/missing.jpg'))
    const img = container.querySelector('img') as HTMLImageElement
    expect(img).toBeTruthy()
    // 缩略图加载失败 → 回退图标占位（img 卸载）
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()

    // 同 id 条目换新缩略图重渲染：失败态必须随 thumbUrl 变化复位，恢复 ThumbReveal 分支
    rerender(
      <RecycleBinItemComponent
        file={makeFile('C:/cache/fixed.jpg')}
        selected={false}
        onToggle={() => {}}
      />
    )
    const reloaded = container.querySelector('img') as HTMLImageElement | null
    expect(reloaded).toBeTruthy()
    expect(reloaded?.getAttribute('src')).toBe(toFileUrl('C:/cache/fixed.jpg'))
  })

  it('边界：thumbnail 为 null 且为图片 → resolveThumbnailSrc 回退原文件，img 仍渲染', () => {
    const { container } = renderItem(makeFile(null))
    const img = container.querySelector('img') as HTMLImageElement | null
    expect(img).toBeTruthy()
    expect(img?.getAttribute('src')).toBe(toFileUrl('D:/photos/photo.jpg'))
  })
})
