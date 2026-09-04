/**
 * @layer L3
 * @module src/renderer/hooks/useWatermark
 * @coverage 水印配置状态 + updateText/updateImage/updatePosition/toggleTile/reset
 * @dependencies react, utils/imageProcessor (类型)
 * @remarks jsdom 环境
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useWatermark } from './useWatermark'
import type { WatermarkConfig } from '../utils/imageProcessor'

const fullConfig: WatermarkConfig = {
  text: {
    content: 'initial',
    font: 'Arial',
    size: 30,
    color: '#000000',
    opacity: 0.5,
    bold: true,
    italic: false,
    underline: true
  },
  position: 'topLeft',
  customX: 10,
  customY: 20,
  rotation: 45,
  margin: 30,
  tile: true,
  tileSpacingX: 200,
  tileSpacingY: 150
}

describe('useWatermark', () => {
  describe('初始状态', () => {
    it('未传 initial 时 config 为 null', () => {
      const { result } = renderHook(() => useWatermark())
      expect(result.current.config).toBeNull()
    })

    it('传入 initial 时 config 等于 initial', () => {
      const { result } = renderHook(() => useWatermark(fullConfig))
      expect(result.current.config).toEqual(fullConfig)
    })

    it('传入 null 时 config 为 null', () => {
      const { result } = renderHook(() => useWatermark(null))
      expect(result.current.config).toBeNull()
    })
  })

  describe('setConfig', () => {
    it('直接替换整个 config', () => {
      const { result } = renderHook(() => useWatermark())
      act(() => {
        result.current.setConfig(fullConfig)
      })
      expect(result.current.config).toEqual(fullConfig)
    })

    it('setConfig(null) 清空 config', () => {
      const { result } = renderHook(() => useWatermark(fullConfig))
      act(() => {
        result.current.setConfig(null)
      })
      expect(result.current.config).toBeNull()
    })
  })

  describe('updateText', () => {
    it('config 为 null 时使用默认 text 创建', () => {
      const { result } = renderHook(() => useWatermark())
      act(() => {
        result.current.updateText({ content: 'new content' })
      })
      expect(result.current.config?.text?.content).toBe('new content')
      expect(result.current.config?.text?.font).toBe('Arial')
    })

    it('config 已存在时合并 text 字段', () => {
      const { result } = renderHook(() => useWatermark(fullConfig))
      act(() => {
        result.current.updateText({ content: 'updated', size: 99 })
      })
      expect(result.current.config?.text?.content).toBe('updated')
      expect(result.current.config?.text?.size).toBe(99)
      // 其他字段保留
      expect(result.current.config?.text?.font).toBe('Arial')
      expect(result.current.config?.text?.bold).toBe(true)
    })

    it('text 为 undefined 时使用默认 text', () => {
      const { result } = renderHook(() => useWatermark({ ...fullConfig, text: undefined }))
      act(() => {
        result.current.updateText({ content: 'fallback' })
      })
      expect(result.current.config?.text?.content).toBe('fallback')
      expect(result.current.config?.text?.font).toBe('Arial')
    })
  })

  describe('updateImage', () => {
    it('config 为 null 时使用默认 image 创建', () => {
      const { result } = renderHook(() => useWatermark())
      act(() => {
        result.current.updateImage({ path: '/img.png' })
      })
      expect(result.current.config?.image?.path).toBe('/img.png')
      expect(result.current.config?.image?.width).toBe(100)
      expect(result.current.config?.image?.height).toBe(100)
      expect(result.current.config?.image?.opacity).toBe(0.7)
      expect(result.current.config?.image?.blendMode).toBe('normal')
    })

    it('config 已存在时合并 image 字段', () => {
      const { result } = renderHook(() => useWatermark(fullConfig))
      act(() => {
        result.current.updateImage({ path: '/new.png', opacity: 0.3 })
      })
      expect(result.current.config?.image?.path).toBe('/new.png')
      expect(result.current.config?.image?.opacity).toBe(0.3)
    })
  })

  describe('updatePosition', () => {
    it('更新 position 字段', () => {
      const { result } = renderHook(() => useWatermark(fullConfig))
      act(() => {
        result.current.updatePosition('center')
      })
      expect(result.current.config?.position).toBe('center')
    })

    it('config 为 null 时使用默认 config 创建并设置 position', () => {
      const { result } = renderHook(() => useWatermark())
      act(() => {
        result.current.updatePosition('topRight')
      })
      expect(result.current.config?.position).toBe('topRight')
      // 默认 config 的其他字段也存在
      expect(result.current.config?.margin).toBe(20)
    })

    it('更新 position 不影响其他字段', () => {
      const { result } = renderHook(() => useWatermark(fullConfig))
      act(() => {
        result.current.updatePosition('bottomLeft')
      })
      expect(result.current.config?.position).toBe('bottomLeft')
      expect(result.current.config?.text).toEqual(fullConfig.text)
      expect(result.current.config?.rotation).toBe(45)
    })
  })

  describe('toggleTile', () => {
    it('tile 从 false 切换到 true', () => {
      const { result } = renderHook(() => useWatermark({ ...fullConfig, tile: false }))
      act(() => {
        result.current.toggleTile()
      })
      expect(result.current.config?.tile).toBe(true)
    })

    it('tile 从 true 切换到 false', () => {
      const { result } = renderHook(() => useWatermark(fullConfig))
      act(() => {
        result.current.toggleTile()
      })
      expect(result.current.config?.tile).toBe(false)
    })

    it('config 为 null 时使用默认 config 创建并切换 tile', () => {
      const { result } = renderHook(() => useWatermark())
      act(() => {
        result.current.toggleTile()
      })
      expect(result.current.config?.tile).toBe(true)
    })
  })

  describe('reset', () => {
    it('清空 config 为 null', () => {
      const { result } = renderHook(() => useWatermark(fullConfig))
      act(() => {
        result.current.reset()
      })
      expect(result.current.config).toBeNull()
    })

    it('reset 后再 updateText 可重新创建 config', () => {
      const { result } = renderHook(() => useWatermark(fullConfig))
      act(() => {
        result.current.reset()
        result.current.updateText({ content: 'after reset' })
      })
      expect(result.current.config?.text?.content).toBe('after reset')
    })
  })
})
