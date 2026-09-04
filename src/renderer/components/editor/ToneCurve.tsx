import React, { useRef, useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { type CurvePoint } from '../../utils/imageProcessor'
// P1-U5：RGB 通道颜色集中管理
import { CHANNEL_COLORS } from '../../utils/editor-colors'

interface ToneCurveProps {
  channel: 'rgb' | 'r' | 'g' | 'b'
  value: CurvePoint[]
  onChange: (points: CurvePoint[]) => void
}

const channelKey = {
  rgb: 'editor.toneCurve.channelRgb',
  r: 'editor.toneCurve.channelR',
  g: 'editor.toneCurve.channelG',
  b: 'editor.toneCurve.channelB'
} as const
// P1-U5：从 CHANNEL_COLORS 派生纯色值，颜色变更单点修改
const channelColors = {
  rgb: CHANNEL_COLORS.rgb.solid,
  r: CHANNEL_COLORS.r.solid,
  g: CHANNEL_COLORS.g.solid,
  b: CHANNEL_COLORS.b.solid
}

export const ToneCurve: React.FC<ToneCurveProps> = ({ channel, value, onChange }) => {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)

  // 修复 U-F1：Canvas 2D 上下文不支持 CSS 变量（'var(--xxx)' 不是有效颜色值）
  // 通过 getComputedStyle 读取 CSS 变量的实际计算值，并提供合理回退色
  const readCssVar = (varName: string, fallback: string): string => {
    const canvas = canvasRef.current
    if (!canvas) return fallback
    const computed = getComputedStyle(canvas).getPropertyValue(varName).trim()
    return computed || fallback
  }

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const width = canvas.width
    const height = canvas.height

    ctx.clearRect(0, 0, width, height)

    // 网格（读取 CSS 变量实际值，回退到半透明灰）
    ctx.strokeStyle = readCssVar('--divider', 'rgba(0,0,0,0.08)')
    ctx.lineWidth = 1
    for (let i = 1; i < 4; i++) {
      const t = i / 4
      ctx.beginPath()
      ctx.moveTo(t * width, 0)
      ctx.lineTo(t * width, height)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(0, t * height)
      ctx.lineTo(width, t * height)
      ctx.stroke()
    }

    // 对角线（读取 CSS 变量实际值，回退到半透明灰）
    ctx.strokeStyle = readCssVar('--text-tertiary', 'rgba(0,0,0,0.25)')
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(0, height)
    ctx.lineTo(width, 0)
    ctx.stroke()
    ctx.setLineDash([])

    // 曲线
    const sorted = [...value].sort((a, b) => a.x - b.x)
    ctx.strokeStyle = channelColors[channel]
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let i = 0; i < width; i++) {
      const x = i / width
      let y = x
      for (let j = 0; j < sorted.length - 1; j++) {
        const p1 = sorted[j]
        const p2 = sorted[j + 1]
        if (x >= p1.x && x <= p2.x) {
          const t = p2.x === p1.x ? 0 : (x - p1.x) / (p2.x - p1.x)
          y = p1.y + (p2.y - p1.y) * t
          break
        }
      }
      const py = height - y * height
      if (i === 0) ctx.moveTo(i, py)
      else ctx.lineTo(i, py)
    }
    ctx.stroke()

    // 控制点
    value.forEach((p) => {
      const px = p.x * width
      const py = height - p.y * height
      ctx.beginPath()
      ctx.arc(px, py, 5, 0, Math.PI * 2)
      ctx.fillStyle = channelColors[channel]
      ctx.fill()
      ctx.strokeStyle = 'white'
      ctx.lineWidth = 2
      ctx.stroke()
    })

    // 悬停数值（读取 CSS 变量实际值，回退到半透明黑）
    if (hover) {
      ctx.fillStyle = readCssVar('--text-secondary', 'rgba(0,0,0,0.6)')
      ctx.font = '10px sans-serif'
      ctx.fillText(
        t('editor.toneCurve.inputOutput', {
          input: Math.round(hover.x * 255),
          output: Math.round(hover.y * 255)
        }),
        8,
        12
      )
    }
  }, [value, hover, channel, t])

  useEffect(() => {
    draw()
  }, [draw])

  const getPointFromEvent = (e: React.MouseEvent<HTMLCanvasElement>): CurvePoint => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height))
    return { x, y }
  }

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getPointFromEvent(e)
    const idx = value.findIndex((p) => Math.abs(p.x - x) < 0.04 && Math.abs(p.y - y) < 0.04)
    if (idx >= 0) {
      setDragging(idx)
    } else {
      const newPoints = [...value, { x, y }].sort((a, b) => a.x - b.x)
      const newIdx = newPoints.findIndex((p) => p.x === x && p.y === y)
      onChange(newPoints)
      setDragging(newIdx)
    }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getPointFromEvent(e)
    setHover({ x, y })
    if (dragging === null) return

    const newPoints = [...value]
    newPoints[dragging] = { x, y }
    onChange(newPoints)
  }

  const handleMouseUp = () => {
    setDragging(null)
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <span className="text-sm font-medium" style={{ color: channelColors[channel] }}>
          {t('editor.toneCurve.curveLabel', { channel: t(channelKey[channel]) })}
        </span>
        <button
          className="text-xs px-2 py-1 rounded"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
          onClick={() =>
            onChange([
              { x: 0, y: 0 },
              { x: 0.5, y: 0.5 },
              { x: 1, y: 1 }
            ])
          }
        >
          {t('editor.toneCurve.reset')}
        </button>
      </div>
      <canvas
        ref={canvasRef}
        width={280}
        height={160}
        role="application"
        aria-label={t('editor.toneCurve.ariaLabel', { channel: t(channelKey[channel]) })}
        tabIndex={0}
        className="w-full rounded-lg cursor-crosshair"
        style={{ background: 'var(--bg-tertiary)' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          setHover(null)
          setDragging(null)
        }}
      />
    </div>
  )
}
