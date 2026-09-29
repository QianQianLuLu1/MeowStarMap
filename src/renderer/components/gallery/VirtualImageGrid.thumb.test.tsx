/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/components/gallery/VirtualImageGrid
 * @coverage 图库视频缩略图裂图回归防护（fix-gallery-video-thumbnail）；
 *   缩略图路径推导纯函数（游戏原生缩略图路径守卫 + 缓存命名规则回归）
 * @dependencies fs（源码结构检查）、./VirtualImageGrid（toLowQualityUrl/toHighQualityUrl 纯函数）
 * @remarks
 *   缺陷现象：图库中部分视频缩略图显示警告/裂图图标。
 *   根因：视频记录的 thumbnail 字段为空时，`toFileUrl(file.thumbnail || file.file_path)`
 *   回退用「原视频文件」作为 <img> 源，浏览器加载视频进 img 必触发 onError → 警告图标。
 *   修复：视频类型不使用 file.file_path 作为 img 源，仅使用 file.thumbnail；无缩略图时
 *   由 MediaThumbPlaceholder 显示 IconVideo 占位图标。
 *
 *   测试策略：VirtualImageGrid 依赖 react-virtuoso / mediaStore / i18n 与大量子组件，
 *   直接 render 需 mock 数十个模块且脆弱。遵循项目既有 GalleryPage.test.tsx /
 *   RecycleBinPage.thumb.test.tsx 的源码结构性检查模式。
 *   路径推导守卫：后端会把游戏原生缩略图路径（.../NikkiPhotos_LowQuality|HighQuality/xxx.jpg）
 *   直接填入 thumbnail，推导函数须返回 null（组件改用原路径显示），
 *   不得按缓存命名规则推导出不存在的 _low/_high 路径。
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

// 行为用例仅导入模块级纯函数，不渲染组件；mock 掉组件周边依赖，保证模块可独立加载
vi.mock('react-virtuoso', () => ({ VirtuosoGrid: () => null }))
vi.mock('../../stores/mediaStore', () => ({ toFileUrl: (p: string) => `file:///${p}` }))
vi.mock('../../utils/format', () => ({ formatFileSize: () => '' }))
vi.mock('../../icons', () => ({
  IconEdit: () => null,
  IconFavorite: () => null,
  IconDelete: () => null
}))
vi.mock('../common/MissingBadge', () => ({ MissingBadge: () => null }))
vi.mock('../common/CorruptedBadge', () => ({ CorruptedBadge: () => null }))
vi.mock('./MediaThumbPlaceholder', () => ({ MediaThumbPlaceholder: () => null }))
vi.mock('../../hooks/useFailedImages', () => ({
  useFailedImages: () => ({
    failedImages: new Set(),
    markFailed: () => {},
    clearFailed: () => {}
  })
}))
vi.mock('../../utils/responsive', () => ({
  getResponsiveColumns: () => 4,
  DEFAULT_COLUMNS_BREAKPOINTS: {}
}))

import {
  toLowQualityUrl,
  toHighQualityUrl,
  pickThumbnailUrl,
  resolveEffectiveThumbnail
} from './VirtualImageGrid'
const src = fs.readFileSync(
  path.resolve(process.cwd(), 'src', 'renderer', 'components', 'gallery', 'VirtualImageGrid.tsx'),
  'utf-8'
)

/**
 * 剔除注释行后的源码。修复说明注释中会引用缺陷写法本身，
 * 若直接对全文做否定断言会误命中注释造成假失败。
 */
const code = src
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
  .join('\n')

describe('VirtualImageGrid 视频缩略图裂图防护（fix-gallery-video-thumbnail）', () => {
  it('视频类型不再以原视频文件 file.file_path 作为 <img> 源', () => {
    // 旧写法：toFileUrl(file.thumbnail || file.file_path) 对视频会回退到视频文件本身
    expect(code).not.toMatch(
      /const standardUrl = toFileUrl\(file\.thumbnail \|\| file\.file_path\)/
    )
  })

  it('缩略图源统一由 resolveEffectiveThumbnail 判定（THUMBNAIL_OPTIMIZATION_PLAN 节点2）', () => {
    // effectiveThumbnail = thumbnail > 按需生成结果 > （图片生成失败时）原文件兜底 > null 占位
    expect(code).toContain('resolveEffectiveThumbnail({')
    expect(code).toContain(
      "const standardUrl = (effectiveThumbnail && toFileUrl(effectiveThumbnail)) || ''"
    )
  })

  it('图片类型不再在「生成中」直载原文件（消除数 MB 原图拉伸当缩略图 + IO 争抢）', () => {
    // 旧写法 effectiveThumbnail || file.file_path 在 thumbnail=NULL 时直载原图；
    // 新写法仅当「图片且生成失败」时由 resolveEffectiveThumbnail 内部兜底原文件
    expect(code).not.toMatch(/effectiveThumbnail \|\| file\.file_path/)
  })

  it('缺缩略图项接入可视区按需生成（不再整表触发 useVideoThumbGenerate）', () => {
    // 节点2：对齐 useVideoThumbGenerate 已验证模式，但触发范围收敛到可视区，
    // 消除万级视频库一次性发起全部 IPC 在主进程 decodeLimiter 排长队的隐性瓶颈
    expect(code).not.toContain('useVideoThumbGenerate')
    expect(code).toContain('onDemandThumbPromises')
    expect(code).toContain('ensureOnDemandThumbnail')
  })
})

/**
 * 缩略图源判定纯函数（THUMBNAIL_OPTIMIZATION_PLAN 节点2）。
 *
 * 缺陷现象：thumbnail=NULL（刚导入/批量未达）的图片卡片直载数 MB 原图拉伸当缩略图，
 * 与后台批量任务争抢磁盘 IO，「模糊→清晰」被放大到数秒~数十秒。
 * 修复优先级：DB thumbnail > 按需生成结果 >（仅图片且生成失败）原文件兜底 > null（占位）；
 * 视频绝不返回原视频路径（<img> 无法解码视频，回退必裂图）。
 */
describe('resolveEffectiveThumbnail 缩略图源判定', () => {
  it('正常：有 DB thumbnail → 直接使用', () => {
    expect(
      resolveEffectiveThumbnail({
        fileType: 'image',
        thumbnail: 'C:/cache/abc.jpg',
        generatedPath: undefined,
        generateFailed: false,
        filePath: 'D:/photos/a.jpg'
      })
    ).toBe('C:/cache/abc.jpg')
  })

  it('正常：无 thumbnail，按需生成成功 → 使用生成结果', () => {
    expect(
      resolveEffectiveThumbnail({
        fileType: 'image',
        thumbnail: null,
        generatedPath: 'C:/cache/abc.jpg',
        generateFailed: false,
        filePath: 'D:/photos/a.jpg'
      })
    ).toBe('C:/cache/abc.jpg')
  })

  it('正常：图片无 thumbnail 且生成失败 → 回退原文件（保留旧行为兜底）', () => {
    expect(
      resolveEffectiveThumbnail({
        fileType: 'image',
        thumbnail: null,
        generatedPath: undefined,
        generateFailed: true,
        filePath: 'D:/photos/a.jpg'
      })
    ).toBe('D:/photos/a.jpg')
  })

  it('异常：视频无 thumbnail 且生成失败 → null（绝不返回视频路径）', () => {
    expect(
      resolveEffectiveThumbnail({
        fileType: 'video',
        thumbnail: null,
        generatedPath: undefined,
        generateFailed: true,
        filePath: 'D:/videos/a.mp4'
      })
    ).toBeNull()
  })

  it('边界：无 thumbnail、生成中（无结果）→ null（占位图标）', () => {
    expect(
      resolveEffectiveThumbnail({
        fileType: 'image',
        thumbnail: null,
        generatedPath: undefined,
        generateFailed: false,
        filePath: 'D:/photos/a.jpg'
      })
    ).toBeNull()
    expect(
      resolveEffectiveThumbnail({
        fileType: 'video',
        thumbnail: undefined,
        generatedPath: undefined,
        generateFailed: false,
        filePath: 'D:/videos/a.mp4'
      })
    ).toBeNull()
  })

  it('边界：filePath 为空字符串时即使图片生成失败也不回退 → null', () => {
    expect(
      resolveEffectiveThumbnail({
        fileType: 'image',
        thumbnail: null,
        generatedPath: undefined,
        generateFailed: true,
        filePath: ''
      })
    ).toBeNull()
  })
})

describe('按需生成机制源码结构（THUMBNAIL_OPTIMIZATION_PLAN 节点2）', () => {
  it('单次守卫：同一 file_path 只触发一次 thumbnail:generate（Promise Map 缓存）', () => {
    expect(code).toContain('onDemandThumbPromises.has(')
    expect(code).toContain('onDemandThumbPromises.set(')
  })

  it('standard 404（LRU 驱逐等）时同样触发重建，成功后 clearFailed 以原 URL 重试', () => {
    expect(code).toContain('clearFailed')
  })
})

// 游戏原生缩略图路径样本：覆盖反斜杠/正斜杠与目录名大小写混合（守卫内部小写归一化）
const NATIVE_BACKSLASH =
  'C:\\Users\\game\\GamePlayPhotos\\uid123\\NikkiPhotos_LowQuality\\photo001.jpg'
const NATIVE_SLASH_MIXED_CASE = 'D:/GamePlayPhotos/uid123/NikkiPhotos_LOWQUALITY/photo002.jpg'
const NATIVE_HIGH = 'E:\\GamePlayPhotos\\uid\\NikkiPhotos_HighQuality\\photo003.jpg'
const CACHE_PATH = 'C:/Users/app/AppData/thumbnails/abc123.jpg'

describe('toLowQualityUrl 游戏原生缩略图路径守卫', () => {
  it('原生路径（反斜杠）→ 返回 null，不推导 _low 缓存名', () => {
    expect(toLowQualityUrl(NATIVE_BACKSLASH)).toBeNull()
  })

  it('原生路径（正斜杠 + 目录名大小写混合）→ 返回 null', () => {
    expect(toLowQualityUrl(NATIVE_SLASH_MIXED_CASE)).toBeNull()
  })

  it('回归：应用缓存路径仍正常推导 _low.jpg', () => {
    expect(toLowQualityUrl(CACHE_PATH)).toBe('C:/Users/app/AppData/thumbnails/abc123_low.jpg')
  })
})

describe('toHighQualityUrl 游戏原生缩略图路径守卫', () => {
  it('原生路径（HighQuality 反斜杠）→ 返回 null，不推导 _high 缓存名', () => {
    expect(toHighQualityUrl(NATIVE_HIGH)).toBeNull()
  })

  it('原生路径（LowQuality 正斜杠 + 大小写混合）→ 返回 null', () => {
    expect(toHighQualityUrl(NATIVE_SLASH_MIXED_CASE)).toBeNull()
  })

  it('回归：应用缓存路径仍正常推导 _high.jpg', () => {
    expect(toHighQualityUrl(CACHE_PATH)).toBe('C:/Users/app/AppData/thumbnails/abc123_high.jpg')
  })

  it('既有规则保留：_low/_high 后缀与非 jpg/空输入仍返回 null', () => {
    expect(toHighQualityUrl('C:/t/abc_low.jpg')).toBeNull()
    expect(toHighQualityUrl('C:/t/abc_high.jpg')).toBeNull()
    expect(toHighQualityUrl('C:/t/abc.png')).toBeNull()
    expect(toHighQualityUrl(undefined)).toBeNull()
    expect(toLowQualityUrl(undefined)).toBeNull()
  })
})

/**
 * 缩略图档位状态机（fix-thumbnail-loading-latency 节点3）。
 *
 * 缺陷现象：① 图片缩略图先模糊，standard 未生成时 404 → markFailed 死胡同（警告图标、
 * 无重试），要等 media:updated 全量刷新才恢复清晰；② DPR≥2 首请求打在基本不存在的
 * _high.jpg 上必 404 一次，且升级后反而从 512px 回落到 320px（档位写反）。
 * 修复：档位选择收敛为纯函数 pickThumbnailUrl——未升级（或升级失败回退）用低清，
 * 升级用 standard；onError 回退链 low→standard→low→markFailed（standard 失败不再死胡同，
 * 回退低清等待 items 刷新自动重试）；移除 HIGH_DPI_MODE 投机 _high 请求与预生成 effect。
 */
describe('pickThumbnailUrl 档位选择（low → standard，standard 失败回退 low）', () => {
  const low = 'media://file?path=abc_low.jpg'
  const std = 'media://file?path=abc.jpg'

  it('正常：有低清且未升级 → 低清（首屏快速出图）', () => {
    expect(
      pickThumbnailUrl({ lowUrl: low, standardUrl: std, upgraded: false, standardFailed: false })
    ).toBe(low)
  })

  it('正常：升级 → standard（停滚 300ms 后切换的唯一目标档）', () => {
    expect(
      pickThumbnailUrl({ lowUrl: low, standardUrl: std, upgraded: true, standardFailed: false })
    ).toBe(std)
  })

  it('正常：无低清（游戏原生缩略图）→ 恒用 standard', () => {
    expect(
      pickThumbnailUrl({ lowUrl: null, standardUrl: std, upgraded: false, standardFailed: false })
    ).toBe(std)
    expect(
      pickThumbnailUrl({ lowUrl: null, standardUrl: std, upgraded: true, standardFailed: false })
    ).toBe(std)
  })

  it('边界：升级后 standard 加载失败 → 回退低清（不再死胡同，待 items 刷新重试）', () => {
    expect(
      pickThumbnailUrl({ lowUrl: low, standardUrl: std, upgraded: true, standardFailed: true })
    ).toBe(low)
  })

  it('边界：standard 失败但无低清可退 → standard（交给 onError 终止为 markFailed）', () => {
    expect(
      pickThumbnailUrl({ lowUrl: null, standardUrl: std, upgraded: true, standardFailed: true })
    ).toBe(std)
  })

  it('异常：lowUrl 与 standardUrl 全空 → null（组件层由占位图标兜底）', () => {
    expect(
      pickThumbnailUrl({ lowUrl: null, standardUrl: null, upgraded: false, standardFailed: false })
    ).toBeNull()
    expect(
      pickThumbnailUrl({ lowUrl: null, standardUrl: null, upgraded: true, standardFailed: true })
    ).toBeNull()
  })
})

describe('档位状态机源码结构（fix-thumbnail-loading-latency 节点3）', () => {
  it('不再存在 HIGH_DPI_MODE 投机 _high 首请求与高分屏预生成 effect', () => {
    expect(code).not.toContain('HIGH_DPI_MODE')
    expect(code).not.toContain("generate(file.file_path, 'high')")
  })

  it('standard 加载失败走 markStandardFailed 回退链（而非 markFailed 死胡同）', () => {
    expect(code).toContain('markStandardFailed')
    // 回退链终止条件仍在：回退后的低清再失败才 markFailed
    expect(code).toContain('markFailed')
  })

  it('standardFailed 集合随 items 变化自动清空（media:updated 刷新后可重试）', () => {
    expect(code).toContain('useFailedImages(items)')
  })
})
