/**
 * Storybook 专用共享 fixtures（仅被 *.stories.tsx 导入，应用运行时代码不引用）。
 *
 * 媒体资源一律使用 SVG data URL 占位图：不使用真实本地路径与 `media://` 协议，
 * `toFileUrl()` 对 `data:` 前缀原样返回，保证故事在浏览器中直接可渲染。
 */
import type { MediaFile } from '../../stores/mediaStore'

/** 生成纯色背景 + 居中标签的 SVG 占位图 data URL */
export function svgPlaceholder(color: string, label: string, size = 480): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="100%" height="100%" fill="${color}"/>` +
    `<rect x="8" y="8" width="${size - 16}" height="${size - 16}" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="2" rx="16"/>` +
    `<text x="50%" y="52%" fill="rgba(255,255,255,0.92)" font-family="Segoe UI, sans-serif" font-size="${Math.round(
      size / 10
    )}" text-anchor="middle" dominant-baseline="middle">${label}</text>` +
    `</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** 一组常用占位图色板（柔和的莫兰迪色系，贴近相册截图观感） */
export const placeholderPalette = [
  '#8ea6c9',
  '#c9a38e',
  '#9bb89b',
  '#b48ec9',
  '#c98e9c',
  '#8ec9c0',
  '#c9bf8e',
  '#9d9dc9'
] as const

/** 生成一条最小可用的 MediaFile 记录（必填字段均有默认值，可按需覆盖） */
export function makeMediaFile(overrides: Partial<MediaFile> & { id: string }): MediaFile {
  const id = overrides.id
  const color = placeholderPalette[Number(id) % placeholderPalette.length] ?? placeholderPalette[0]
  return {
    file_path: svgPlaceholder(color, `IMG-${id}`),
    file_name: `IMG_${id.padStart(4, '0')}.png`,
    file_type: 'image',
    file_ext: '.png',
    file_size: 1_024_000 + Number(id || 0) * 37_000,
    width: 1920,
    height: 1080,
    created_at: '2026-08-01T10:30:00.000Z',
    modified_at: '2026-08-01T10:30:00.000Z',
    tags: [],
    rating: 0,
    is_favorite: false,
    notes: '',
    scene_category: 'screenshot',
    ...overrides
  }
}

/**
 * 生成一批演示用媒体文件：混合正常缩略图、收藏、视频（带时长）、
 * 丢失（is_missing）与损坏（is_corrupted）等状态，供各视图故事复用。
 */
export function makeMediaFiles(count = 8): MediaFile[] {
  return Array.from({ length: count }, (_, i) => {
    const id = String(i + 1)
    const base = makeMediaFile({ id })
    if (i === 2) {
      // 收藏项
      return { ...base, is_favorite: true, rating: 5 }
    }
    if (i === 3) {
      // 视频：占位图仅作展示，视频不读取真实资源
      return {
        ...base,
        file_type: 'video',
        file_ext: '.mp4',
        file_name: `VID_${id.padStart(4, '0')}.mp4`,
        duration: 95,
        file_size: 12_580_000,
        scene_time: 'unknown'
      }
    }
    if (i === 5) {
      // 丢失文件：半透明 + MissingBadge
      return { ...base, is_missing: true }
    }
    if (i === 6) {
      // 损坏文件：不显示缩略图，仅占位图标 + CorruptedBadge
      return { ...base, is_corrupted: true, corrupted_reason: 'decode failed (fixture)' }
    }
    if (i % 2 === 0) {
      return { ...base, rating: (i % 5) + 1 }
    }
    return base
  })
}
