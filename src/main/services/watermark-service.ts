// @core-change: 批量水印补齐 polaroid/date-label 底纹与 {date}/{time} 展开
import fsp from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import type { Blend, OverlayOptions } from 'sharp'
import type { WatermarkConfig } from '../types/file'
// {date}/{time} 展开与渲染层共用同一份实现（此前主进程不展开，导出图露字面花括号）
import { formatWatermarkText } from '../../shared/utils/watermark-text'
// C-3：统一文件工具函数与 MIME 映射
import { pathExists, getUniqueFilePath, bufferToDataUrl } from '../utils/file-utils'
import { getMimeType } from '../utils/media-constants'
// P2-A2：改用 utils/disk.ts 统一的 assertDiskSpace，消除本文件 31-39 行重复实现
import { assertDiskSpace } from '../utils/disk'
import { logger } from '../utils/logger'

export class WatermarkService {
  async applyBatch(
    config: WatermarkConfig,
    filePaths: string[],
    targetDir: string,
    onProgress?: (current: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<{ success: boolean; message: string; processed: number; cancelled?: boolean }> {
    try {
      // FIX(组16-3): 平铺间距校验——watermark handler 侧仅做存在性检查
      // （z.record(z.string(), z.unknown())），注释声称"config 由 WatermarkService 内部校验"
      // 但原先并无校验：tileSpacingX/Y 取 0 时 `pos.x % 0` = NaN，循环体不执行，
      // 水印静默缺失无任何提示；取负数时 `x += 负值` 使 `x < cw` 永真，
      // 主进程死循环应用整体冻结只能强杀
      if (config.tile) {
        const sx = config.tileSpacingX
        const sy = config.tileSpacingY
        const invalidSpacing =
          typeof sx !== 'number' ||
          !Number.isFinite(sx) ||
          sx <= 0 ||
          typeof sy !== 'number' ||
          !Number.isFinite(sy) ||
          sy <= 0
        if (invalidSpacing) {
          return {
            success: false,
            message: `平铺间距无效：tileSpacingX/tileSpacingY 必须为正数（当前 X=${String(sx)}，Y=${String(sy)}）`,
            processed: 0
          }
        }
      }

      await fsp.mkdir(targetDir, { recursive: true })

      // F-G2：预估所需空间（源文件总大小）
      let totalSize = 0
      for (const filePath of filePaths) {
        try {
          const stat = await fsp.stat(filePath)
          totalSize += stat.size
        } catch {
          // 源文件 stat 失败时跳过
        }
      }
      // P2-A2：改用 utils/disk.ts 的 assertDiskSpace，与 file-service/video-service 统一实现
      if (totalSize > 0) {
        await assertDiskSpace(targetDir, totalSize)
      }

      const blendMap: Record<string, string> = {
        normal: 'over',
        multiply: 'multiply',
        screen: 'screen',
        overlay: 'overlay',
        'soft-light': 'soft-light'
      }
      const blend = (blendMap[config.image?.blendMode || 'normal'] || 'over') as Blend

      let processed = 0

      for (let i = 0; i < filePaths.length; i++) {
        // 性能重构 v3 改造项三：用户取消时立即停止，保留已处理结果
        if (signal?.aborted) {
          return {
            success: true,
            message: `已取消：处理 ${processed}/${filePaths.length} 个文件`,
            processed,
            cancelled: true
          }
        }
        const filePath = filePaths[i]
        try {
          const metadata = await sharp(filePath).metadata()
          const cw = metadata.width || 1
          const ch = metadata.height || 1

          const overlays: OverlayOptions[] = []

          const textSvg = this.buildTextWatermarkSvg(config, cw, ch)
          if (textSvg) {
            overlays.push({ input: Buffer.from(textSvg), left: 0, top: 0, blend })
          }

          const imageSvg = await this.buildImageWatermarkSvg(config, cw, ch)
          if (imageSvg) {
            overlays.push({ input: Buffer.from(imageSvg), left: 0, top: 0, blend })
          }

          if (overlays.length === 0) {
            continue
          }

          const ext = path.extname(filePath)
          const baseName = path.basename(filePath, ext)
          // C-3：统一唯一路径生成（取代内联 do-while 冲突自增循环）
          const outputPath = await getUniqueFilePath(targetDir, baseName, ext)

          await sharp(filePath).composite(overlays).toFile(outputPath)
          processed++
          onProgress?.(processed, filePaths.length)
        } catch (err) {
          logger.error(`[Watermark] 处理失败 ${filePath}:`, err)
        }
      }

      // 性能重构 v3：循环结束后再次检查取消（循环内最后一项可能已完成但取消信号在期间到达）
      if (signal?.aborted) {
        return {
          success: true,
          message: `已取消：处理 ${processed}/${filePaths.length} 个文件`,
          processed,
          cancelled: true
        }
      }
      return { success: true, message: `已处理 ${processed}/${filePaths.length} 个文件`, processed }
    } catch (error) {
      return {
        success: false,
        message: `批量水印失败: ${error instanceof Error ? error.message : String(error)}`,
        processed: 0
      }
    }
  }

  private getWatermarkPosition(
    position: WatermarkConfig['position'],
    cw: number,
    ch: number,
    ww: number,
    wh: number,
    margin: number,
    customX: number,
    customY: number
  ): { x: number; y: number } {
    switch (position) {
      case 'topLeft':
        return { x: margin, y: margin }
      case 'topCenter':
        return { x: (cw - ww) / 2, y: margin }
      case 'topRight':
        return { x: cw - ww - margin, y: margin }
      case 'centerLeft':
        return { x: margin, y: (ch - wh) / 2 }
      case 'center':
        return { x: (cw - ww) / 2, y: (ch - wh) / 2 }
      case 'centerRight':
        return { x: cw - ww - margin, y: (ch - wh) / 2 }
      case 'bottomLeft':
        return { x: margin, y: ch - wh - margin }
      case 'bottomCenter':
        return { x: (cw - ww) / 2, y: ch - wh - margin }
      case 'bottomRight':
        return { x: cw - ww - margin, y: ch - wh - margin }
      case 'custom':
        return { x: customX, y: customY }
      default:
        return { x: cw - ww - margin, y: ch - wh - margin }
    }
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }

  private buildTextWatermarkSvg(config: WatermarkConfig, cw: number, ch: number): string | null {
    const text = config.text
    const fontWeight = text?.bold ? 'bold' : 'normal'
    const fontStyle = text?.italic ? 'italic' : 'normal'
    const opacity = (text?.opacity ?? 80) / 100

    /**
     * polaroid：底部白带与渲染层同源——`drawPolaroidFrame` 的 fillRect 写在
     * `if (config.text?.content)` 守卫**之前**（imageProcessor.ts:1000-1001），
     * 所以空文字也必须有框。判据必须放在 `!text?.content` 早退之前，
     * 否则 `overlays.length === 0 → continue`（:102-104）会让该文件**连输出都不写**。
     * 不套用 position / tile / rotation（画布版同样不套）。
     */
    if (config.style === 'polaroid') {
      const frameRatio = 0.16
      const frameHeight = Math.max(1, Math.round(ch * frameRatio))
      const content = text?.content ? formatWatermarkText(text.content) : ''
      // SVG 内部色（画布像素，与 UI 主题无关）：拍立得相纸固定白，同渲染层 '#ffffff'
      const frame = `<rect x="0" y="${ch - frameHeight}" width="${cw}" height="${frameHeight}" fill="#ffffff" />`
      const label =
        text && content
          ? `<text x="${cw / 2}" y="${ch - frameHeight / 2}" text-anchor="middle" dominant-baseline="middle" fill="${this.escapeXml(text.color || '#333333')}" font-family="${this.escapeXml(text.font || 'sans-serif')}" font-size="${Math.min(text.size, frameHeight * 0.4)}" font-weight="${fontWeight}" font-style="${fontStyle}" style="opacity: ${opacity};">${this.escapeXml(content)}</text>`
          : ''
      return `<svg width="${cw}" height="${ch}" xmlns="http://www.w3.org/2000/svg">${frame}${label}</svg>`
    }

    if (!text?.content) return null

    // 先展开 {date}/{time}，再参与尺寸估算与 XML 转义（顺序不可颠倒：转义会把串变长，
    // 影响 ww 估算；而占位符本身必须先落成日期，否则导出图里是一串字面花括号）
    const content = formatWatermarkText(text.content)
    const escaped = this.escapeXml(content)

    const ww = Math.round(text.size * content.length * 1.2)
    const wh = Math.round(text.size * 1.5)
    const pos = this.getWatermarkPosition(
      config.position,
      cw,
      ch,
      ww,
      wh,
      config.margin,
      config.customX,
      config.customY
    )

    // date-label 下抑制下划线，与画布版同口径（imageProcessor.ts:876）
    const decoration =
      text.underline && config.style !== 'date-label' ? 'text-decoration: underline;' : ''

    let elements = ''
    const rotation = config.rotation || 0

    const drawOne = (x: number, y: number) => {
      const cx = x + ww / 2
      const cy = y + wh / 2
      const transform = `rotate(${rotation}, ${cx}, ${cy})`
      // date-label：文字前置圆角暗底，口径对齐 imageProcessor.ts:861-868
      // （pad = size*0.3、底板高 = wh + pad、rx = size*0.25）。SVG 内部色（非 UI 主题色）。
      let bg = ''
      if (config.style === 'date-label') {
        const pad = text.size * 0.3
        bg = `<rect x="${cx - ww / 2 - pad}" y="${cy - wh / 2 - pad * 0.5}" width="${ww + pad * 2}" height="${wh + pad}" rx="${text.size * 0.25}" fill="rgba(0,0,0,0.55)" opacity="${opacity}" transform="${transform}" />`
      }
      return `${bg}<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" fill="${this.escapeXml(text.color)}" font-family="${this.escapeXml(text.font || 'sans-serif')}" font-size="${text.size}" font-weight="${fontWeight}" font-style="${fontStyle}" style="${decoration} opacity: ${opacity};" transform="${transform}">${escaped}</text>`
    }

    if (config.tile) {
      for (let y = pos.y % config.tileSpacingY; y < ch; y += config.tileSpacingY) {
        for (let x = pos.x % config.tileSpacingX; x < cw; x += config.tileSpacingX) {
          elements += drawOne(x, y)
        }
      }
    } else {
      elements += drawOne(pos.x, pos.y)
    }

    return `<svg width="${cw}" height="${ch}" xmlns="http://www.w3.org/2000/svg">${elements}</svg>`
  }

  private async buildImageWatermarkSvg(
    config: WatermarkConfig,
    cw: number,
    ch: number
  ): Promise<string | null> {
    const imgCfg = config.image
    if (!imgCfg?.path) return null
    // C-3：统一文件存在检查
    if (!(await pathExists(imgCfg.path))) return null

    const buffer = await fsp.readFile(imgCfg.path)
    const ext = path.extname(imgCfg.path).toLowerCase()
    // C-3：统一 MIME 映射 + DataURL 编码
    const mime = getMimeType(ext)
    const dataUrl = bufferToDataUrl(buffer, mime)

    const ww = imgCfg.width || 120
    const wh = imgCfg.height || 120
    const pos = this.getWatermarkPosition(
      config.position,
      cw,
      ch,
      ww,
      wh,
      config.margin,
      config.customX,
      config.customY
    )
    const opacity = (imgCfg.opacity ?? 80) / 100
    const rotation = config.rotation || 0

    let elements = ''
    const drawOne = (x: number, y: number) => {
      const cx = x + ww / 2
      const cy = y + wh / 2
      return `<image href="${dataUrl}" x="${x}" y="${y}" width="${ww}" height="${wh}" opacity="${opacity}" transform="rotate(${rotation}, ${cx}, ${cy})" />`
    }

    if (config.tile) {
      for (let y = pos.y % config.tileSpacingY; y < ch; y += config.tileSpacingY) {
        for (let x = pos.x % config.tileSpacingX; x < cw; x += config.tileSpacingX) {
          elements += drawOne(x, y)
        }
      }
    } else {
      elements += drawOne(pos.x, pos.y)
    }

    return `<svg width="${cw}" height="${ch}" xmlns="http://www.w3.org/2000/svg">${elements}</svg>`
  }
}
