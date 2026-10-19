// 导出格式与选项的单一来源已上移至 shared（preload 桥接层同样引用），此处 re-export 保持既有导入路径稳定
export type { ExportFormat, ExportOptions } from '../../shared/types/electron-api'
// 水印样式与 shared 同一份定义（渲染层 WatermarkPanel 写、主进程批量导出读，禁止各留一套）
import type { WatermarkStyle } from '../../shared/types/watermark'

// P1-02：导出时单文件的元数据（用于命名规则变量替换）
export interface ExportFileMetadata {
  album_type?: string
  account_uid?: string
}

export interface ExifData {
  camera?: string
  lens?: string
  aperture?: string
  shutter?: string
  iso?: number
  focalLength?: string
  gps?: { latitude: number; longitude: number }
  dateTaken?: string
  width?: number
  height?: number
}

export interface WatermarkTextConfig {
  content: string
  font: string
  size: number
  color: string
  opacity: number
  bold: boolean
  italic: boolean
  underline: boolean
}

export interface WatermarkImageConfig {
  path: string
  width: number
  height: number
  opacity: number
  blendMode: string
}

export interface WatermarkConfig {
  text?: WatermarkTextConfig
  image?: WatermarkImageConfig
  position:
    | 'topLeft'
    | 'topCenter'
    | 'topRight'
    | 'centerLeft'
    | 'center'
    | 'centerRight'
    | 'bottomLeft'
    | 'bottomCenter'
    | 'bottomRight'
    | 'custom'
  customX: number
  customY: number
  rotation: number
  margin: number
  tile: boolean
  tileSpacingX: number
  tileSpacingY: number
  /**
   * 样式预设（拍立得白框 / 日期标签底纹等）。渲染层 WatermarkPanel 写入，
   * 批量导出据此在 SVG 里补对应的底纹元素——此前主进程不读该字段，
   * 导致「编辑器预览有底纹、批量导出没有」。
   */
  style?: WatermarkStyle
}
