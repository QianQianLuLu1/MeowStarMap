import { useEffect, useState } from 'react'

// EXIF 数据结构（与主进程 ExifData 类型保持一致）
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

export interface UseExifResult {
  exif: ExifData | null
  loading: boolean
  error: string | null
}

/**
 * 异步加载图片 EXIF 数据
 * 文件路径变化时自动重新加载
 * 视频文件不加载 EXIF（exifr 主要面向图片）
 */
export function useExif(
  filePath: string | null | undefined,
  enabled: boolean = true
): UseExifResult {
  const [exif, setExif] = useState<ExifData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !filePath) {
      setExif(null)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    window.electronAPI?.file
      ?.getExif(filePath)
      .then((data) => {
        if (cancelled) return
        setExif(data || null)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setExif(null)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [filePath, enabled])

  return { exif, loading, error }
}
