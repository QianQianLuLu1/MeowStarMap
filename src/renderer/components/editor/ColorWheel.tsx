import React, { useRef, useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

interface ColorWheelProps {
  value: number
  onChange: (hue: number) => void
  size?: number
  className?: string
}

export const ColorWheel: React.FC<ColorWheelProps> = ({
  value,
  onChange,
  size = 120,
  className = ''
}) => {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const centerX = size / 2
    const centerY = size / 2
    const radius = size / 2 - 4

    ctx.clearRect(0, 0, size, size)

    const gradient = ctx.createConicGradient(0, centerX, centerY)
    for (let i = 0; i <= 360; i += 10) {
      gradient.addColorStop(i / 360, `hsl(${i}, 100%, 50%)`)
    }

    ctx.beginPath()
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2)
    ctx.fillStyle = gradient
    ctx.fill()

    const rad = ((value - 90) * Math.PI) / 180
    const knobX = centerX + Math.cos(rad) * radius
    const knobY = centerY + Math.sin(rad) * radius

    ctx.beginPath()
    ctx.arc(knobX, knobY, 6, 0, Math.PI * 2)
    ctx.fillStyle = 'white'
    ctx.fill()
    ctx.strokeStyle = 'rgba(0,0,0,0.3)'
    ctx.lineWidth = 2
    ctx.stroke()
  }, [value, size])

  // P1-U10：提取核心坐标计算，供 mouse/touch 事件复用
  const updateHue = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const x = clientX - rect.left - size / 2
      const y = clientY - rect.top - size / 2
      const angle = Math.atan2(y, x) * (180 / Math.PI)
      const hue = (angle + 90 + 360) % 360
      onChange(Math.round(hue))
    },
    [onChange, size]
  )

  // P1-U10：拖动时全局监听 mousemove/mouseup，避免拖出 canvas 后色相卡在边界
  useEffect(() => {
    if (!isDragging) return
    const handleMove = (e: MouseEvent) => updateHue(e.clientX, e.clientY)
    const handleUp = () => setIsDragging(false)
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [isDragging, updateHue])

  return (
    <div className={`inline-block ${className}`}>
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        role="application"
        aria-label={t('editor.colorWheel.ariaLabel')}
        tabIndex={0}
        className="cursor-pointer rounded-full"
        onMouseDown={(e) => {
          setIsDragging(true)
          updateHue(e.clientX, e.clientY)
        }}
        onTouchStart={(e) => {
          setIsDragging(true)
          updateHue(e.touches[0].clientX, e.touches[0].clientY)
        }}
        onTouchMove={(e) => {
          if (isDragging) updateHue(e.touches[0].clientX, e.touches[0].clientY)
        }}
        onTouchEnd={() => setIsDragging(false)}
      />
      <div className="text-center text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
        {value}°
      </div>
    </div>
  )
}
