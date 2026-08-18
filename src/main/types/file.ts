export type ExportFormat = 'jpg' | 'jpeg' | 'png' | 'webp' | 'original'

export interface ExportOptions {
  quality?: number
  format?: ExportFormat
  // P1-02：导出命名规则（支持变量 {date}/{album_type}/{uid}/{original_name}/{sequence}）
  namingPattern?: string
  // P0-F2：useDefaultDir=true 时从 settings 读取默认导出路径（file:export handler 使用）
  useDefaultDir?: boolean
}

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
}
