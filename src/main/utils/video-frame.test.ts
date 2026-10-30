/**
 * 纯色帧判定工具单测（plan: fix-video-thumbnail-white-frame）
 *
 * 使用**真实 sharp** 生成测试素材（不 mock），覆盖：
 * - 正常：纯白 / 纯黑 JPEG → true
 * - 异常：渐变 / 噪点 JPEG → false；文件不存在 → false；非图片字节 → false
 * - 边界：体积超出闸门的纯白大图 → isBlankImageFile=true 但 isBlankCachedThumbnail=false
 *
 * 注：视频缩略图实际尺寸为 320×180（16:9 经 scale=320:320:force_original_aspect_ratio=decrease
 * 的输出），本测试的素材尺寸沿用该值，与真实产物一致。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import { rigNativePath } from '../../../tests/mocks/ci-linux-fs'
import {
  isBlankImageFile,
  isBlankCachedThumbnail,
  BLANK_CACHE_SIZE_HINT_BYTES
} from './video-frame'

const FRAME_WIDTH = 320
const FRAME_HEIGHT = 180

let tmpDir: string

/** 生成纯色 JPEG（与视频抽帧产物同尺寸） */
async function writeSolidJpeg(name: string, color: string): Promise<string> {
  const file = path.join(tmpDir, name)
  await sharp({
    create: {
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      channels: 3,
      background: color
    }
  })
    .jpeg({ quality: 85 })
    .toFile(file)
  return file
}

/** 生成横向渐变 JPEG（有内容，非纯色） */
async function writeGradientJpeg(name: string): Promise<string> {
  const file = path.join(tmpDir, name)
  const pixels = Buffer.alloc(FRAME_WIDTH * FRAME_HEIGHT * 3)
  let offset = 0
  for (let y = 0; y < FRAME_HEIGHT; y++) {
    for (let x = 0; x < FRAME_WIDTH; x++) {
      const value = Math.round((x / (FRAME_WIDTH - 1)) * 255)
      pixels[offset++] = value
      pixels[offset++] = (value + 64) % 256
      pixels[offset++] = 255 - value
    }
  }
  await sharp(pixels, { raw: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 3 } })
    .jpeg({ quality: 85 })
    .toFile(file)
  return file
}

beforeEach(async () => {
  // 夹具根必须是**真路径**：isBlankImageFile 用 sharp 解码，那是 libvips 自己的 open，
  // 不经装置的 fs 翻译层——装置形态的 `/tmp/…` 会被 Windows 按盘相对路径解析而读不到。
  // 轴未激活（真宿主 / CI）时 rigNativePath 恒等，本行等价于今日写法。
  tmpDir = rigNativePath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wxnn-video-frame-')))
})

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

describe('isBlankImageFile', () => {
  it('正常：纯白 JPEG 判定为纯色（视频片头白闪场景）', async () => {
    const file = await writeSolidJpeg('white.jpg', '#ffffff')
    expect(await isBlankImageFile(file)).toBe(true)
  })

  it('正常：纯黑 JPEG 判定为纯色（视频片头黑帧场景）', async () => {
    const file = await writeSolidJpeg('black.jpg', '#000000')
    expect(await isBlankImageFile(file)).toBe(true)
  })

  it('异常：渐变 JPEG 判定为非纯色（有真实画面）', async () => {
    const file = await writeGradientJpeg('gradient.jpg')
    expect(await isBlankImageFile(file)).toBe(false)
  })

  it('异常：文件不存在 → 失败开放返回 false', async () => {
    expect(await isBlankImageFile(path.join(tmpDir, 'not-exist.jpg'))).toBe(false)
  })

  it('异常：非图片字节文件 → 失败开放返回 false', async () => {
    const file = path.join(tmpDir, 'garbage.jpg')
    await fsp.writeFile(file, Buffer.alloc(2048, 0x7f))
    expect(await isBlankImageFile(file)).toBe(false)
  })

  it('异常：入参非法（空串 / null）→ 返回 false 且不抛错', async () => {
    expect(await isBlankImageFile('')).toBe(false)
    expect(await isBlankImageFile(null as unknown as string)).toBe(false)
    expect(await isBlankImageFile(undefined as unknown as string)).toBe(false)
  })
})

describe('isBlankCachedThumbnail', () => {
  it('边界：小体积纯白帧 → 两个判定均为 true（触发自愈）', async () => {
    const file = await writeSolidJpeg('small-white.jpg', '#ffffff')
    const stat = await fsp.stat(file)
    expect(stat.size).toBeLessThanOrEqual(BLANK_CACHE_SIZE_HINT_BYTES)
    expect(await isBlankCachedThumbnail(file)).toBe(true)
  })

  it('边界：体积超出闸门的纯白大图 → 跳过解码返回 false', async () => {
    const file = path.join(tmpDir, 'big-white.jpg')
    await sharp({
      create: { width: 2048, height: 2048, channels: 3, background: '#ffffff' }
    })
      .jpeg({ quality: 90 })
      .toFile(file)
    const stat = await fsp.stat(file)
    expect(stat.size).toBeGreaterThan(BLANK_CACHE_SIZE_HINT_BYTES)
    // 直接判定确实是纯色，但缓存命中场景被体积闸门短路
    expect(await isBlankImageFile(file)).toBe(true)
    expect(await isBlankCachedThumbnail(file)).toBe(false)
  })

  it('正常：有内容的小缩略图 → 返回 false（不误伤）', async () => {
    const file = await writeGradientJpeg('small-gradient.jpg')
    expect(await isBlankCachedThumbnail(file)).toBe(false)
  })

  it('异常：文件不存在 / 目录路径 → 返回 false', async () => {
    expect(await isBlankCachedThumbnail(path.join(tmpDir, 'missing.jpg'))).toBe(false)
    expect(await isBlankCachedThumbnail(tmpDir)).toBe(false)
  })
})
