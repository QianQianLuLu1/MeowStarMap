import React from 'react'

interface SliderControlProps {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (value: number) => void
  onCommit?: () => void
  /** U-G5：单位显示（如色温 "K"） */
  unit?: string
  /** U-G5：双击复位时的默认值 */
  defaultValue?: number
  /** U-G5：双击复位回调，优先于 defaultValue/min */
  onReset?: () => void
}

export const SliderControl: React.FC<SliderControlProps> = ({
  label,
  value,
  min = -100,
  max = 100,
  step = 1,
  onChange,
  onCommit,
  unit,
  defaultValue,
  onReset
}) => {
  // U-G5：双击复位——优先调用 onReset，否则重置为 defaultValue/min
  const handleDoubleClick = () => {
    if (onReset) {
      onReset()
    } else if (defaultValue !== undefined) {
      onChange(defaultValue)
    } else {
      onChange(min)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          {label}
        </span>
        <span
          className="text-xs font-mono w-12 text-right"
          style={{ color: 'var(--text-primary)' }}
          onDoubleClick={handleDoubleClick}
        >
          {value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        // U-G5：键盘方向键调整时在 keyUp 触发 onCommit，避免拖动过程中频繁触发
        onKeyUp={onCommit}
        onDoubleClick={handleDoubleClick}
        className="w-full"
        style={{
          background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${((value - min) / (max - min)) * 100}%, var(--bg-tertiary) ${((value - min) / (max - min)) * 100}%, var(--bg-tertiary) 100%)`
        }}
      />
    </div>
  )
}
