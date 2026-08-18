import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
// P1-U5：RGB 通道颜色集中管理
import { CHANNEL_COLORS } from '../../utils/editor-colors'
import { needsAnonymousCors } from '../../utils/file'

interface HistogramProps {
  imageSrc: string | null
  className?: string
}

const DEBOUNCE_MS = 80

export const Histogram: React.FC<HistogramProps> = ({ imageSrc, className = '' }) => {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  const drawHistogram = (img: HTMLImageElement) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const width = canvas.width
    const height = canvas.height
    ctx.clearRect(0, 0, width, height)

    const tempCanvas = document.createElement('canvas')
    const size = 256
    tempCanvas.width = size
    tempCanvas.height = size
    const tempCtx = tempCanvas.getContext('2d')
    if (!tempCtx) return

    const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight)
    const dw = Math.floor(img.naturalWidth * scale)
    const dh = Math.floor(img.naturalHeight * scale)
    tempCtx.drawImage(img, 0, 0, dw, dh)

    try {
      // U13：getImageData 对跨域图片会抛 SecurityError；try/catch 已正确处理，失败时清空直方图
      const data = tempCtx.getImageData(0, 0, dw, dh).data
      const r = new Array(256).fill(0)
      const g = new Array(256).fill(0)
      const b = new Array(256).fill(0)
      const l = new Array(256).fill(0)

      for (let i = 0; i < data.length; i += 4) {
        r[data[i]]++
        g[data[i + 1]]++
        b[data[i + 2]]++
        l[Math.round((data[i] + data[i + 1] + data[i + 2]) / 3)]++
      }

      const max = Math.max(Math.max(...r), Math.max(...g), Math.max(...b), Math.max(...l), 1)

      const drawChannel = (values: number[], color: string) => {
        ctx.strokeStyle = color
        ctx.lineWidth = 1
        ctx.beginPath()
        for (let i = 0; i < 256; i++) {
          const x = (i / 255) * width
          const y = height - (values[i] / max) * height * 0.9
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }

      drawChannel(r, CHANNEL_COLORS.r.stroke)
      drawChannel(g, CHANNEL_COLORS.g.stroke)
      drawChannel(b, CHANNEL_COLORS.b.stroke)
      drawChannel(l, CHANNEL_COLORS.rgb.stroke)
    } catch {
      setError(true)
    }
  }

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (imgRef.current) {
      imgRef.current.onload = null
      imgRef.current.onerror = null
      imgRef.current.src = ''
      imgRef.current = null
    }

    if (!imageSrc) {
      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext('2d')
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
      }
      setError(false)
      return
    }

    timerRef.current = setTimeout(() => {
      const img = new Image()
      // media:// 注册为 standard scheme 具有独立 origin，getImageData 前需以 anonymous CORS 模式加载
      if (needsAnonymousCors(imageSrc)) {
        img.crossOrigin = 'anonymous'
      }
      imgRef.current = img
      img.onload = () => {
        drawHistogram(img)
        imgRef.current = null
      }
      img.onerror = () => {
        setError(true)
        imgRef.current = null
      }
      img.src = imageSrc
    }, DEBOUNCE_MS)

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
      if (imgRef.current) {
        imgRef.current.onload = null
        imgRef.current.onerror = null
        imgRef.current.src = ''
        imgRef.current = null
      }
    }
  }, [imageSrc])

  return (
    <div
      className={`relative rounded-xl overflow-hidden ${className}`}
      style={{ background: 'var(--bg-tertiary)' }}
    >
      <canvas
        ref={canvasRef}
        width={256}
        height={100}
        aria-label={t('editor.histogram.ariaLabel')}
        className="w-full h-24"
      />
      {error && (
        <div
          className="absolute inset-0 flex items-center justify-center text-xs"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {t('editor.histogram.error')}
        </div>
      )}
    </div>
  )
}
