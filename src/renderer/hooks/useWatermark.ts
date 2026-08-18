import { useState, useCallback } from 'react'
import { WatermarkConfig } from '../utils/imageProcessor'

export interface UseWatermarkReturn {
  config: WatermarkConfig | null
  setConfig: (config: WatermarkConfig | null) => void
  updateText: (text: Partial<NonNullable<WatermarkConfig['text']>>) => void
  updateImage: (image: Partial<NonNullable<WatermarkConfig['image']>>) => void
  updatePosition: (position: NonNullable<WatermarkConfig['position']>) => void
  toggleTile: () => void
  reset: () => void
}

const defaultConfig: WatermarkConfig = {
  text: {
    content: 'WXNN Photo',
    font: 'Arial',
    size: 24,
    color: '#ffffff',
    opacity: 0.7,
    bold: false,
    italic: false,
    underline: false
  },
  position: 'bottomRight',
  customX: 0,
  customY: 0,
  rotation: 0,
  margin: 20,
  tile: false,
  tileSpacingX: 100,
  tileSpacingY: 100
}

export function useWatermark(initial?: WatermarkConfig | null): UseWatermarkReturn {
  const [config, setConfig] = useState<WatermarkConfig | null>(initial ?? null)

  const ensureConfig = useCallback((): WatermarkConfig => {
    return config ?? { ...defaultConfig }
  }, [config])

  const updateText = useCallback(
    (text: Partial<NonNullable<WatermarkConfig['text']>>) => {
      const current = ensureConfig()
      setConfig({
        ...current,
        text: { ...(current.text || defaultConfig.text!), ...text }
      })
    },
    [ensureConfig]
  )

  const updateImage = useCallback(
    (image: Partial<NonNullable<WatermarkConfig['image']>>) => {
      const current = ensureConfig()
      setConfig({
        ...current,
        image: {
          ...(current.image || {
            path: '',
            width: 100,
            height: 100,
            opacity: 0.7,
            blendMode: 'normal'
          }),
          ...image
        }
      })
    },
    [ensureConfig]
  )

  const updatePosition = useCallback(
    (position: NonNullable<WatermarkConfig['position']>) => {
      const current = ensureConfig()
      setConfig({ ...current, position })
    },
    [ensureConfig]
  )

  const toggleTile = useCallback(() => {
    const current = ensureConfig()
    setConfig({ ...current, tile: !current.tile })
  }, [ensureConfig])

  const reset = useCallback(() => {
    setConfig(null)
  }, [])

  return {
    config,
    setConfig,
    updateText,
    updateImage,
    updatePosition,
    toggleTile,
    reset
  }
}
