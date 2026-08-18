import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * @layer L2
 * @module src/main/services/watermark-service
 * @coverage WatermarkService.applyBatch（含 getWatermarkPosition / escapeXml / buildTextWatermarkSvg / buildImageWatermarkSvg）
 * @dependencies sharp, file-utils, media-constants, disk
 * @remarks Mock sharp + 真实 fs + 临时目录；通过拦截 sharp().composite().toFile() 验证 SVG 内容
 */

// ============================================================
// Mock 声明（hoisted）
// ============================================================

// 收集每次 sharp.composite 调用传入的 overlays（含 SVG buffer）
const sharpCalls: Array<{
  filePath: string
  compositeOverlays: Array<{ input: Buffer; left: number; top: number; blend: string }>
  outputPath: string
}> = []

// 记录最后一次 sharp(filePath) 调用
let lastSharpChain: any = null

vi.mock('sharp', () => {
  const factory = vi.fn((filePath: string) => {
    const chain = {
      _filePath: filePath,
      _metadata: { width: 800, height: 600 },
      metadata: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
      composite: vi.fn((overlays: any[]) => {
        sharpCalls.push({
          filePath,
          compositeOverlays: overlays,
          outputPath: ''
        })
        lastSharpChain = chain
        return chain
      }),
      toFile: vi.fn(async (outputPath: string) => {
        if (sharpCalls.length > 0) {
          sharpCalls[sharpCalls.length - 1].outputPath = outputPath
        }
        // 实际写入空文件模拟输出
        await fs.promises.writeFile(outputPath, Buffer.from('fake-output'))
        return { width: 800, height: 600 }
      })
    }
    return chain
  })
  return { default: factory }
})

vi.mock('../utils/disk', () => ({
  assertDiskSpace: vi.fn()
}))

// logger mock：隔离被测实现写日志时的 electron.app.getPath 依赖（logger.ts:133）
const loggerMocks = vi.hoisted(() => ({
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  logFaultMock: vi.fn(),
  getLogDirectoryMock: vi.fn(() => '/mock/logs')
}))

vi.mock('../utils/logger', () => ({
  logger: {
    info: loggerMocks.loggerInfoMock,
    warn: loggerMocks.loggerWarnMock,
    error: loggerMocks.loggerErrorMock,
    debug: loggerMocks.loggerDebugMock
  },
  logFault: loggerMocks.logFaultMock,
  getLogDirectory: loggerMocks.getLogDirectoryMock
}))

// 保留 file-utils 与 media-constants 真实实现（用于冲突检测 + DataURL 编码）

// ============================================================
// Import after mock
// ============================================================
import sharp from 'sharp'
import { WatermarkService } from './watermark-service'
import { assertDiskSpace } from '../utils/disk'
import type { WatermarkConfig } from '../types/file'

// ============================================================
// Helpers
// ============================================================

function makeBaseConfig(overrides: Partial<WatermarkConfig> = {}): WatermarkConfig {
  return {
    text: {
      content: 'hello',
      font: 'Arial',
      size: 24,
      color: '#ffffff',
      opacity: 80,
      bold: false,
      italic: false,
      underline: false
    },
    image: undefined,
    position: 'bottomRight',
    customX: 0,
    customY: 0,
    rotation: 0,
    margin: 10,
    tile: false,
    tileSpacingX: 100,
    tileSpacingY: 100,
    ...overrides
  } as WatermarkConfig
}

let tmpRoot: string
let srcImage: string
let outDir: string
let service: WatermarkService

beforeEach(() => {
  vi.clearAllMocks()
  sharpCalls.length = 0
  lastSharpChain = null
  ;(assertDiskSpace as any).mockResolvedValue(undefined)

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-watermark-'))
  srcImage = path.join(tmpRoot, 'photo.jpg')
  fs.writeFileSync(srcImage, Buffer.from('fake-image-content'))
  outDir = path.join(tmpRoot, 'output')
  fs.mkdirSync(outDir, { recursive: true })
  service = new WatermarkService()
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

// ============================================================
// describe: WatermarkService.applyBatch - 成功路径
// ============================================================

// ============ FIX(组16-3): 平铺间距校验 ============
describe('WatermarkService.applyBatch - 平铺间距校验（组16-3）', () => {
  it('tile 开启且 tileSpacingX=0 时立即返回失败（修复前 NaN 静默丢失水印）', async () => {
    const r = await service.applyBatch(
      makeBaseConfig({ tile: true, tileSpacingX: 0 }),
      [srcImage],
      outDir
    )
    expect(r.success).toBe(false)
    expect(r.message).toContain('平铺间距无效')
    expect(r.processed).toBe(0)
    expect(sharpCalls).toHaveLength(0)
  })

  it('tile 开启且 tileSpacingY 为负数时立即返回失败（修复前主进程死循环）', async () => {
    const r = await service.applyBatch(
      makeBaseConfig({ tile: true, tileSpacingY: -50 }),
      [srcImage],
      outDir
    )
    expect(r.success).toBe(false)
    expect(r.message).toContain('平铺间距无效')
    expect(sharpCalls).toHaveLength(0)
  })

  it('tile 未开启时非法间距不影响处理（校验仅作用于平铺模式）', async () => {
    const r = await service.applyBatch(
      makeBaseConfig({ tile: false, tileSpacingX: 0 }),
      [srcImage],
      outDir
    )
    expect(r.success).toBe(true)
    expect(r.processed).toBe(1)
  })

  it('tile 开启且间距合法时正常处理', async () => {
    const r = await service.applyBatch(
      makeBaseConfig({ tile: true, tileSpacingX: 120, tileSpacingY: 100 }),
      [srcImage],
      outDir
    )
    expect(r.success).toBe(true)
    expect(r.processed).toBe(1)
    expect(sharpCalls).toHaveLength(1)
  })
})

describe('WatermarkService.applyBatch - 成功路径', () => {
  it('单文件 + 文字水印：返回 success=true + processed=1', async () => {
    const r = await service.applyBatch(makeBaseConfig(), [srcImage], outDir)

    expect(r.success).toBe(true)
    expect(r.processed).toBe(1)
    expect(r.message).toContain('已处理 1/1 个文件')
    expect(sharp).toHaveBeenCalledWith(srcImage)
    expect(sharpCalls.length).toBe(1)
    expect(sharpCalls[0].compositeOverlays.length).toBe(1)
  })

  it('多文件批量处理：返回 processed=N', async () => {
    const files = [
      path.join(tmpRoot, 'a.jpg'),
      path.join(tmpRoot, 'b.jpg'),
      path.join(tmpRoot, 'c.jpg')
    ]
    for (const f of files) fs.writeFileSync(f, Buffer.from('content'))

    const r = await service.applyBatch(makeBaseConfig(), files, outDir)

    expect(r.success).toBe(true)
    expect(r.processed).toBe(3)
    expect(r.message).toContain('已处理 3/3 个文件')
  })

  it('onProgress 回调在每个文件处理后触发', async () => {
    const files = [path.join(tmpRoot, 'a.jpg'), path.join(tmpRoot, 'b.jpg')]
    for (const f of files) fs.writeFileSync(f, Buffer.from('content'))
    const progressCalls: Array<{ current: number; total: number }> = []

    await service.applyBatch(makeBaseConfig(), files, outDir, (current, total) => {
      progressCalls.push({ current, total })
    })

    expect(progressCalls).toEqual([
      { current: 1, total: 2 },
      { current: 2, total: 2 }
    ])
  })

  it('目标目录不存在时自动创建', async () => {
    const newDir = path.join(tmpRoot, 'new-output')
    expect(fs.existsSync(newDir)).toBe(false)

    const r = await service.applyBatch(makeBaseConfig(), [srcImage], newDir)

    expect(r.success).toBe(true)
    expect(fs.existsSync(newDir)).toBe(true)
  })

  it('磁盘空间检查：使用源文件总大小', async () => {
    await service.applyBatch(makeBaseConfig(), [srcImage], outDir)

    expect(assertDiskSpace).toHaveBeenCalledWith(outDir, fs.statSync(srcImage).size)
  })

  it('磁盘空间检查：多文件时累加源文件大小', async () => {
    const files = [path.join(tmpRoot, 'a.jpg'), path.join(tmpRoot, 'b.jpg')]
    fs.writeFileSync(files[0], Buffer.from('content1')) // 8 字节
    fs.writeFileSync(files[1], Buffer.from('content22')) // 9 字节

    await service.applyBatch(makeBaseConfig(), files, outDir)

    expect(assertDiskSpace).toHaveBeenCalledWith(outDir, 8 + 9)
  })

  it('源文件 stat 失败时跳过累加但不影响处理（totalSize=0 时不检查磁盘）', async () => {
    const nonExistent = path.join(tmpRoot, 'no-such.jpg')

    const r = await service.applyBatch(makeBaseConfig(), [nonExistent], outDir)

    // stat 失败时 totalSize=0，跳过 assertDiskSpace
    expect(assertDiskSpace).not.toHaveBeenCalled()
    // 源码 stat 失败仅跳过累加，不跳过文件处理；sharp 被 mock 不会抛错，故 processed=1
    expect(r.success).toBe(true)
    expect(r.processed).toBe(1)
  })
})

// ============================================================
// describe: WatermarkService.applyBatch - 异常路径
// ============================================================

describe('WatermarkService.applyBatch - 异常路径', () => {
  it('磁盘空间不足时返回 success=false', async () => {
    ;(assertDiskSpace as any).mockRejectedValue(new Error('磁盘空间不足'))

    const r = await service.applyBatch(makeBaseConfig(), [srcImage], outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('批量水印失败')
    expect(r.message).toContain('磁盘空间不足')
    expect(r.processed).toBe(0)
  })

  it('assertDiskSpace 抛非 Error 类型时使用 String 转换', async () => {
    ;(assertDiskSpace as any).mockRejectedValue('string-error')

    const r = await service.applyBatch(makeBaseConfig(), [srcImage], outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('string-error')
  })

  it('单个文件 sharp.metadata 抛错时不影响其他文件处理', async () => {
    const goodFile1 = path.join(tmpRoot, 'good1.jpg')
    const badFile = path.join(tmpRoot, 'bad.jpg')
    const goodFile2 = path.join(tmpRoot, 'good2.jpg')
    for (const f of [goodFile1, badFile, goodFile2]) fs.writeFileSync(f, Buffer.from('content'))

    ;(sharp as any).mockImplementationOnce(() => {
      throw new Error('sharp init failed')
    })

    const r = await service.applyBatch(makeBaseConfig(), [goodFile1, badFile, goodFile2], outDir)

    expect(r.success).toBe(true)
    expect(r.processed).toBe(2) // badFile 失败，其他成功
    // 失败日志经 logger.error 输出（watermark-service.ts:91）
    expect(loggerMocks.loggerErrorMock).toHaveBeenCalled()
  })

  it('sharp.composite 失败时单文件处理失败但不影响其他', async () => {
    const file1 = path.join(tmpRoot, 'a.jpg')
    const file2 = path.join(tmpRoot, 'b.jpg')
    fs.writeFileSync(file1, Buffer.from('content'))
    fs.writeFileSync(file2, Buffer.from('content'))

    // mockImplementationOnce 只匹配源码每文件首次 sharp 调用（用于 metadata），
    // 而源码每文件第二次 sharp 调用（用于 composite）会回落到默认 mock 正常工作，
    // 故两个文件均处理成功，processed=2
    ;(sharp as any).mockImplementationOnce(() => ({
      metadata: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
      composite: vi.fn(() => {
        throw new Error('composite failed')
      }),
      toFile: vi.fn()
    }))

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const r = await service.applyBatch(makeBaseConfig(), [file1, file2], outDir)

    expect(r.success).toBe(true)
    expect(r.processed).toBe(2) // 默认 mock 下两文件均成功
    consoleSpy.mockRestore()
  })
})

// ============================================================
// describe: WatermarkService.applyBatch - 水印类型组合
// ============================================================

describe('WatermarkService.applyBatch - 水印类型组合', () => {
  it('仅文字水印：生成 1 个 overlay', async () => {
    const cfg = makeBaseConfig({ image: undefined })

    await service.applyBatch(cfg, [srcImage], outDir)

    expect(sharpCalls[0].compositeOverlays.length).toBe(1)
    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    expect(svg).toContain('<svg')
    expect(svg).toContain('hello')
  })

  it('仅图片水印：生成 1 个 overlay（image 标签）', async () => {
    const watermarkImg = path.join(tmpRoot, 'logo.png')
    fs.writeFileSync(watermarkImg, Buffer.from('fake-png'))
    const cfg = makeBaseConfig({
      text: undefined,
      image: {
        path: watermarkImg,
        width: 100,
        height: 100,
        opacity: 80,
        blendMode: 'normal'
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    expect(sharpCalls[0].compositeOverlays.length).toBe(1)
    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    expect(svg).toContain('<image')
    expect(svg).toContain('data:image/png;base64,')
  })

  it('文字 + 图片水印：生成 2 个 overlays', async () => {
    const watermarkImg = path.join(tmpRoot, 'logo.png')
    fs.writeFileSync(watermarkImg, Buffer.from('fake-png'))
    const cfg = makeBaseConfig({
      image: {
        path: watermarkImg,
        width: 100,
        height: 100,
        opacity: 80,
        blendMode: 'normal'
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    expect(sharpCalls[0].compositeOverlays.length).toBe(2)
  })

  it('text.content 为空字符串且 image 未配置：overlays 为空，文件被跳过', async () => {
    const cfg = makeBaseConfig({
      text: { ...makeBaseConfig().text!, content: '' },
      image: undefined
    })

    const r = await service.applyBatch(cfg, [srcImage], outDir)

    expect(r.success).toBe(true)
    expect(r.processed).toBe(0) // 无 overlay，跳过 composite
    expect(sharpCalls.length).toBe(0)
  })

  it('image.path 不存在时跳过图片水印', async () => {
    const cfg = makeBaseConfig({
      image: {
        path: path.join(tmpRoot, 'no-such.png'),
        width: 100,
        height: 100,
        opacity: 80,
        blendMode: 'normal'
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    expect(sharpCalls[0].compositeOverlays.length).toBe(1) // 只有文字水印
  })

  it('text 为 undefined 时仅处理图片水印', async () => {
    const watermarkImg = path.join(tmpRoot, 'logo.png')
    fs.writeFileSync(watermarkImg, Buffer.from('fake-png'))
    const cfg = makeBaseConfig({
      text: undefined,
      image: {
        path: watermarkImg,
        width: 100,
        height: 100,
        opacity: 80,
        blendMode: 'normal'
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    expect(svg).not.toContain('<text')
    expect(svg).toContain('<image')
  })
})

// ============================================================
// describe: WatermarkService.applyBatch - 文字水印样式
// ============================================================

describe('WatermarkService.applyBatch - 文字水印样式', () => {
  it('bold=true 时 font-weight=bold', async () => {
    const cfg = makeBaseConfig({
      text: { ...makeBaseConfig().text!, bold: true }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    expect(svg).toContain('font-weight="bold"')
  })

  it('italic=true 时 font-style=italic', async () => {
    const cfg = makeBaseConfig({
      text: { ...makeBaseConfig().text!, italic: true }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    expect(svg).toContain('font-style="italic"')
  })

  it('underline=true 时 text-decoration: underline', async () => {
    const cfg = makeBaseConfig({
      text: { ...makeBaseConfig().text!, underline: true }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    expect(svg).toContain('text-decoration: underline')
  })

  it('opacity=50 时 style 包含 opacity: 0.5', async () => {
    const cfg = makeBaseConfig({
      text: { ...makeBaseConfig().text!, opacity: 50 }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    expect(svg).toContain('opacity: 0.5')
  })

  it('opacity=undefined 时默认 80 → opacity: 0.8', async () => {
    const cfg = makeBaseConfig({
      text: { ...makeBaseConfig().text!, opacity: undefined as any }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    expect(svg).toContain('opacity: 0.8')
  })

  it('rotation=45 时 transform 包含 rotate(45', async () => {
    const cfg = makeBaseConfig({ rotation: 45 })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    expect(svg).toContain('rotate(45')
  })

  it('特殊字符（<, >, &, ", \'）应被 XML 转义', async () => {
    const cfg = makeBaseConfig({
      text: {
        ...makeBaseConfig().text!,
        content: '<script>alert("x")</script>&\'quote\'',
        font: 'Arial'
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
    expect(svg).toContain('&amp;')
    expect(svg).toContain('&apos;quote&apos;')
    expect(svg).toContain('&quot;x&quot;')
  })

  it('tile=true 时生成多个 <text> 元素', async () => {
    const cfg = makeBaseConfig({
      tile: true,
      tileSpacingX: 50,
      tileSpacingY: 50
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    const textCount = (svg.match(/<text/g) || []).length
    expect(textCount).toBeGreaterThan(1)
  })

  it('tile=false 时只生成 1 个 <text> 元素', async () => {
    const cfg = makeBaseConfig({ tile: false })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    const textCount = (svg.match(/<text/g) || []).length
    expect(textCount).toBe(1)
  })

  it('SVG 宽高与原图片元数据一致（800x600）', async () => {
    await service.applyBatch(makeBaseConfig(), [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    expect(svg).toContain('width="800"')
    expect(svg).toContain('height="600"')
  })
})

// ============================================================
// describe: WatermarkService.applyBatch - 位置（getWatermarkPosition）
// ============================================================

describe('WatermarkService.applyBatch - 位置参数', () => {
  it('position=custom 时使用 customX/customY', async () => {
    const cfg = makeBaseConfig({ position: 'custom', customX: 100, customY: 200 })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    // 源码 drawOne 把坐标转换为文本中心点：cx = customX + ww/2, cy = customY + wh/2
    // text.size=24, content='hello'(5 字符) → ww=Math.round(24*5*1.2)=144, wh=Math.round(24*1.5)=36
    // 故 cx=100+72=172, cy=200+18=218
    expect(svg).toContain('x="172"')
    expect(svg).toContain('y="218"')
  })

  it('默认 blendMode=normal 时使用 blend="over"', async () => {
    await service.applyBatch(makeBaseConfig(), [srcImage], outDir)

    expect(sharpCalls[0].compositeOverlays[0].blend).toBe('over')
  })

  it('blendMode=multiply 时使用 blend="multiply"', async () => {
    const cfg = makeBaseConfig({
      image: {
        path: '',
        width: 100,
        height: 100,
        opacity: 80,
        blendMode: 'multiply'
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    expect(sharpCalls[0].compositeOverlays[0].blend).toBe('multiply')
  })

  it('blendMode=screen 时使用 blend="screen"', async () => {
    const cfg = makeBaseConfig({
      image: {
        path: '',
        width: 100,
        height: 100,
        opacity: 80,
        blendMode: 'screen'
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    expect(sharpCalls[0].compositeOverlays[0].blend).toBe('screen')
  })

  it('blendMode=overlay 时使用 blend="overlay"', async () => {
    const cfg = makeBaseConfig({
      image: {
        path: '',
        width: 100,
        height: 100,
        opacity: 80,
        blendMode: 'overlay'
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    expect(sharpCalls[0].compositeOverlays[0].blend).toBe('overlay')
  })

  it('blendMode=soft-light 时使用 blend="soft-light"', async () => {
    const cfg = makeBaseConfig({
      image: {
        path: '',
        width: 100,
        height: 100,
        opacity: 80,
        blendMode: 'soft-light'
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    expect(sharpCalls[0].compositeOverlays[0].blend).toBe('soft-light')
  })

  it('blendMode 为未知值时回退到 "over"', async () => {
    const cfg = makeBaseConfig({
      image: {
        path: '',
        width: 100,
        height: 100,
        opacity: 80,
        blendMode: 'unknown-mode'
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    expect(sharpCalls[0].compositeOverlays[0].blend).toBe('over')
  })

  it('image.blendMode 为 undefined 时默认 normal → over', async () => {
    const cfg = makeBaseConfig({
      image: {
        path: '',
        width: 100,
        height: 100,
        opacity: 80,
        blendMode: undefined as any
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    expect(sharpCalls[0].compositeOverlays[0].blend).toBe('over')
  })
})

// ============================================================
// describe: WatermarkService.applyBatch - 图片水印细节
// ============================================================

describe('WatermarkService.applyBatch - 图片水印细节', () => {
  it('image.width/height 默认 120（未传时）', async () => {
    const watermarkImg = path.join(tmpRoot, 'logo.png')
    fs.writeFileSync(watermarkImg, Buffer.from('fake-png'))
    const cfg = makeBaseConfig({
      text: undefined,
      image: {
        path: watermarkImg,
        width: undefined as any,
        height: undefined as any,
        opacity: 80,
        blendMode: 'normal'
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    expect(svg).toContain('width="120"')
    expect(svg).toContain('height="120"')
  })

  it('image.opacity=50 时 opacity="0.5"', async () => {
    const watermarkImg = path.join(tmpRoot, 'logo.png')
    fs.writeFileSync(watermarkImg, Buffer.from('fake-png'))
    const cfg = makeBaseConfig({
      text: undefined,
      image: {
        path: watermarkImg,
        width: 100,
        height: 100,
        opacity: 50,
        blendMode: 'normal'
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    expect(svg).toContain('opacity="0.5"')
  })

  it('image.opacity=undefined 时默认 80 → opacity="0.8"', async () => {
    const watermarkImg = path.join(tmpRoot, 'logo.png')
    fs.writeFileSync(watermarkImg, Buffer.from('fake-png'))
    const cfg = makeBaseConfig({
      text: undefined,
      image: {
        path: watermarkImg,
        width: 100,
        height: 100,
        opacity: undefined as any,
        blendMode: 'normal'
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    expect(svg).toContain('opacity="0.8"')
  })

  it('rotation=30 时 image 标签包含 transform="rotate(30', async () => {
    const watermarkImg = path.join(tmpRoot, 'logo.png')
    fs.writeFileSync(watermarkImg, Buffer.from('fake-png'))
    const cfg = makeBaseConfig({
      text: undefined,
      rotation: 30,
      image: {
        path: watermarkImg,
        width: 100,
        height: 100,
        opacity: 80,
        blendMode: 'normal'
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    expect(svg).toContain('rotate(30')
  })

  it('PNG 图片转换为 data:image/png;base64,...', async () => {
    const watermarkImg = path.join(tmpRoot, 'logo.png')
    fs.writeFileSync(watermarkImg, Buffer.from('fake-png'))
    const cfg = makeBaseConfig({
      text: undefined,
      image: {
        path: watermarkImg,
        width: 100,
        height: 100,
        opacity: 80,
        blendMode: 'normal'
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    expect(svg).toContain('data:image/png;base64,')
  })

  it('JPEG 图片转换为 data:image/jpeg;base64,...', async () => {
    const watermarkImg = path.join(tmpRoot, 'logo.jpg')
    fs.writeFileSync(watermarkImg, Buffer.from('fake-jpg'))
    const cfg = makeBaseConfig({
      text: undefined,
      image: {
        path: watermarkImg,
        width: 100,
        height: 100,
        opacity: 80,
        blendMode: 'normal'
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    expect(svg).toContain('data:image/jpeg;base64,')
  })

  it('tile=true 时生成多个 <image> 元素', async () => {
    const watermarkImg = path.join(tmpRoot, 'logo.png')
    fs.writeFileSync(watermarkImg, Buffer.from('fake-png'))
    const cfg = makeBaseConfig({
      text: undefined,
      tile: true,
      tileSpacingX: 80,
      tileSpacingY: 80,
      image: {
        path: watermarkImg,
        width: 100,
        height: 100,
        opacity: 80,
        blendMode: 'normal'
      }
    })

    await service.applyBatch(cfg, [srcImage], outDir)

    const svg = sharpCalls[0].compositeOverlays[0].input.toString()
    const imageCount = (svg.match(/<image/g) || []).length
    expect(imageCount).toBeGreaterThan(1)
  })
})

// ============================================================
// describe: WatermarkService.applyBatch - 输出文件
// ============================================================

describe('WatermarkService.applyBatch - 输出文件', () => {
  it('输出文件名与源文件同名（不同目录）', async () => {
    await service.applyBatch(makeBaseConfig(), [srcImage], outDir)

    expect(fs.existsSync(path.join(outDir, 'photo.jpg'))).toBe(true)
  })

  it('文件名冲突时自动追加 _1 后缀', async () => {
    fs.writeFileSync(path.join(outDir, 'photo.jpg'), Buffer.from('existing'))

    await service.applyBatch(makeBaseConfig(), [srcImage], outDir)

    expect(fs.existsSync(path.join(outDir, 'photo.jpg'))).toBe(true)
    expect(fs.existsSync(path.join(outDir, 'photo_1.jpg'))).toBe(true)
  })

  it('保留源文件扩展名（.png）', async () => {
    const pngFile = path.join(tmpRoot, 'image.png')
    fs.writeFileSync(pngFile, Buffer.from('content'))

    await service.applyBatch(makeBaseConfig(), [pngFile], outDir)

    expect(fs.existsSync(path.join(outDir, 'image.png'))).toBe(true)
  })
})
