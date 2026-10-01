/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/components/gallery/VirtualImageGrid
 * @coverage 图库视频缩略图裂图回归防护（fix-gallery-video-thumbnail）；
 *   缩略图路径推导纯函数（游戏原生缩略图路径守卫 + 缓存命名规则回归）；
 *   骨架门控直显接入结构断言（fix-thumbnail-skeleton-reveal N4）
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
vi.mock('../common/ThumbReveal', () => ({ ThumbReveal: () => null }))
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

import { toLowQualityUrl, toHighQualityUrl, resolveEffectiveThumbnail } from './VirtualImageGrid'
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
    expect(code).toContain('const standardUrl =')
    expect(code).toContain('toFileUrl(effectiveThumbnail)')
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

describe('骨架门控直显接入（fix-thumbnail-skeleton-reveal N4）', () => {
  it('模糊档位机已废除：不再存在 pickThumbnailUrl / TieredCardImage / 低清垫底交叉淡入', () => {
    // 旧"白屏→模糊→清晰"管线：64px 低清图垫底 + 停滚 300ms 升级 standard 交叉淡入，
    // 即使清晰图已在磁盘也要先模糊。新管线：standard 直接进 ThumbReveal 骨架门控。
    expect(code).not.toContain('pickThumbnailUrl')
    expect(code).not.toContain('TieredCardImage')
    expect(code).not.toContain('showingLow')
    expect(code).not.toContain('lowUrlResolved')
  })

  it('清晰图统一经 ThumbReveal 骨架门控直显（未 onLoad 前不显示图片内容）', () => {
    expect(code).toContain('<ThumbReveal')
  })

  it('highQualityIds 档位升级集合已移除（standard 不再等待停滚升级）', () => {
    expect(code).not.toContain('highQualityIds')
    expect(code).not.toContain('setHighQualityIds')
  })

  it('重试代次机制存在：standard 失败就地重建成功后以 &r=N 强制重载（media:// 路径由内容 hash 决定，重建不改路径）', () => {
    expect(code).toContain('thumbRetryNonce')
    expect(code).toMatch(/&r=\$\{/)
  })

  it('生成中待显骨架：无 URL 且未失败/未损坏的项显示骨架动画而非静态图标', () => {
    // "白屏"之二：thumbnail=NULL 生成中只有灰底+图标干等 → 改为骨架动画
    expect(code).toContain('showSkeleton')
  })

  it('standard 失败新链：就地重建 + 重试代次，不再回退低清显示', () => {
    expect(code).not.toContain('markStandardFailed')
    expect(code).not.toContain('standardFailedIds')
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

  it('边界：无 thumbnail、生成中（无结果）→ null（骨架/占位）', () => {
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
    // N1：守卫从 has() 直接 return 改为 get() 复用既有 promise——单次生成语义不变
    expect(code).toContain('onDemandThumbPromises.get(filePath)')
    expect(code).toContain('onDemandThumbPromises.set(')
  })

  it('缓存命中回填（fix-thumbnail-persist-and-ondemand N1）：Map 命中不再裸 return', () => {
    // 缺陷：旧写法 if (onDemandThumbPromises.has(filePath)) return —— 卡片滚出视区时
    // 组件卸载丢掉 onDemandThumbs state，滚回时 Map 命中直接返回，已生成的缩略图
    // 不回填新实例 → 显示占位直到下一次 media:updated 全量刷新。
    // 修复：命中分支必须挂 applyResult 把已 resolved 的结果回填新实例 state。
    // N4：applyResult 增加 bumpRetry 参数——Map 命中不递增重试代次（防无限重载循环）
    expect(code).not.toMatch(/if \(onDemandThumbPromises\.has\(filePath\)\) return/)
    expect(code).toMatch(/existing\.then\(\(r\) => applyResult\(r, false\)\)/)
    expect(code).toMatch(/promise\.then\(\(r\) => applyResult\(r, true\)\)/)
  })

  it('重建成功清除失败标记让原 URL 立即重试（clearFailed）', () => {
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
