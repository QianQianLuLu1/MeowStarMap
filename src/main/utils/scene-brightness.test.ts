/**
 * @layer L1
 * @module src/main/utils/scene-brightness
 * @coverage analyzeSceneBrightness/analyzeSceneBrightnessBatch
 * @dependencies mock: sharp
 * @remarks mock sharp 后的纯逻辑测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 控制 sharp 链式调用的 mock
let mockStats: () => Promise<{
  channels: Array<{ mean: number }>
}>

vi.mock('sharp', () => {
  const sharpFn = vi.fn(() => {
    return {
      resize: vi.fn().mockReturnThis(),
      stats: () => mockStats()
    }
  })
  return { default: sharpFn }
})

// 被测模块经 logger 写日志会触发 electron.app.getPath，测试环境无 electron 运行时，
// mock logger 隔离 electron 依赖（与项目其他主进程测试的既有模式一致）
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

import { analyzeSceneBrightness, analyzeSceneBrightnessBatch } from './scene-brightness'

describe('scene-brightness', () => {
  beforeEach(() => {
    mockStats = async () => ({ channels: [{ mean: 128 }, { mean: 128 }, { mean: 128 }] })
  })

  describe('analyzeSceneBrightness', () => {
    it('低亮度（<60）返回 night', async () => {
      mockStats = async () => ({ channels: [{ mean: 30 }, { mean: 30 }, { mean: 30 }] })
      const result = await analyzeSceneBrightness('/fake/night.jpg')
      expect(result).toBe('night')
    })

    it('高亮度（>180）返回 day', async () => {
      mockStats = async () => ({ channels: [{ mean: 200 }, { mean: 200 }, { mean: 200 }] })
      const result = await analyzeSceneBrightness('/fake/day.jpg')
      expect(result).toBe('day')
    })

    it('中等亮度 + R>B（暖色，差值>10）返回 dawn', async () => {
      // brightness = 0.299*150 + 0.587*100 + 0.114*100 = 44.85+58.7+11.4 = 114.95（中等）
      // warmColdDiff = 150 - 100 = 50 > 10
      mockStats = async () => ({ channels: [{ mean: 150 }, { mean: 100 }, { mean: 100 }] })
      const result = await analyzeSceneBrightness('/fake/dawn.jpg')
      expect(result).toBe('dawn')
    })

    it('中等亮度 + B>R（冷色，差值<-10）返回 dusk', async () => {
      // brightness = 0.299*100 + 0.587*100 + 0.114*150 = 29.9+58.7+17.1 = 105.7（中等）
      // warmColdDiff = 100 - 150 = -50 < -10
      mockStats = async () => ({ channels: [{ mean: 100 }, { mean: 100 }, { mean: 150 }] })
      const result = await analyzeSceneBrightness('/fake/dusk.jpg')
      expect(result).toBe('dusk')
    })

    it('中等亮度 + 色温中性（|R-B|<=10）默认归为 day', async () => {
      // brightness = 0.299*100 + 0.587*100 + 0.114*100 = 100（中等，60-180 之间）
      // warmColdDiff = 0，既不 >10 也不 <-10
      mockStats = async () => ({ channels: [{ mean: 100 }, { mean: 100 }, { mean: 100 }] })
      const result = await analyzeSceneBrightness('/fake/neutral.jpg')
      expect(result).toBe('day')
    })

    it('亮度刚好等于 60 时不归为 night（不小于 60）', async () => {
      // brightness = 60，不满足 <60，warmColdDiff = 0，归为 day
      mockStats = async () => ({ channels: [{ mean: 60 }, { mean: 60 }, { mean: 60 }] })
      const result = await analyzeSceneBrightness('/fake/edge60.jpg')
      expect(result).not.toBe('night')
    })

    it('亮度刚好等于 180 时不归为 day 高亮（不大于 180）', async () => {
      // brightness = 180，不满足 >180，warmColdDiff = 0，归为 day（默认）
      mockStats = async () => ({ channels: [{ mean: 180 }, { mean: 180 }, { mean: 180 }] })
      const result = await analyzeSceneBrightness('/fake/edge180.jpg')
      expect(result).toBe('day')
    })

    it('色温差刚好等于 10 不归为 dawn（不大于 10）', async () => {
      // warmColdDiff = 10，不满足 >10
      mockStats = async () => ({ channels: [{ mean: 110 }, { mean: 100 }, { mean: 100 }] })
      const result = await analyzeSceneBrightness('/fake/edge10.jpg')
      expect(result).not.toBe('dawn')
    })

    it('色温差刚好等于 -10 不归为 dusk（不小于 -10）', async () => {
      // warmColdDiff = -10，不满足 <-10
      mockStats = async () => ({ channels: [{ mean: 100 }, { mean: 100 }, { mean: 110 }] })
      const result = await analyzeSceneBrightness('/fake/edge-10.jpg')
      expect(result).not.toBe('dusk')
    })

    it('stats 通道数少于 3 返回 unknown', async () => {
      mockStats = async () => ({ channels: [{ mean: 128 }, { mean: 128 }] })
      const result = await analyzeSceneBrightness('/fake/gray.jpg')
      expect(result).toBe('unknown')
    })

    it('stats 通道数为 0 返回 unknown', async () => {
      mockStats = async () => ({ channels: [] })
      const result = await analyzeSceneBrightness('/fake/empty.jpg')
      expect(result).toBe('unknown')
    })

    it('sharp 抛错时返回 unknown', async () => {
      mockStats = async () => {
        throw new Error('sharp failed')
      }
      const result = await analyzeSceneBrightness('/fake/broken.jpg')
      expect(result).toBe('unknown')
    })

    it('调用 sharp 时传入文件路径', async () => {
      const sharp = (await import('sharp')).default
      await analyzeSceneBrightness('/fake/path.jpg')
      expect(sharp).toHaveBeenCalledWith('/fake/path.jpg')
    })

    it('BT.601 加权亮度计算正确（极红图像高亮度）', async () => {
      // R=255, G=0, B=0 → brightness = 0.299*255 = 76.245，不归为 day
      mockStats = async () => ({ channels: [{ mean: 255 }, { mean: 0 }, { mean: 0 }] })
      const result = await analyzeSceneBrightness('/fake/red.jpg')
      // brightness=76.245，warmColdDiff=255 > 10，归为 dawn
      expect(result).toBe('dawn')
    })

    it('BT.601 加权亮度计算正确（极绿图像中等亮度）', async () => {
      // R=0, G=255, B=0 → brightness = 0.587*255 = 149.685（中等）
      // warmColdDiff = 0 - 0 = 0，归为 day
      mockStats = async () => ({ channels: [{ mean: 0 }, { mean: 255 }, { mean: 0 }] })
      const result = await analyzeSceneBrightness('/fake/green.jpg')
      expect(result).toBe('day')
    })

    it('BT.601 加权亮度计算正确（极蓝图像中等亮度）', async () => {
      // R=0, G=0, B=255 → brightness = 0.114*255 = 29.07 < 60，归为 night
      mockStats = async () => ({ channels: [{ mean: 0 }, { mean: 0 }, { mean: 255 }] })
      const result = await analyzeSceneBrightness('/fake/blue.jpg')
      expect(result).toBe('night')
    })
  })

  describe('analyzeSceneBrightnessBatch', () => {
    it('空数组返回空 Map', async () => {
      const result = await analyzeSceneBrightnessBatch([])
      expect(result.size).toBe(0)
    })

    it('单文件返回单条映射', async () => {
      mockStats = async () => ({ channels: [{ mean: 30 }, { mean: 30 }, { mean: 30 }] })
      const result = await analyzeSceneBrightnessBatch(['/fake/night.jpg'])
      expect(result.get('/fake/night.jpg')).toBe('night')
    })

    it('多文件返回对应映射（保持路径-结果对应）', async () => {
      let callCount = 0
      mockStats = async () => {
        callCount++
        if (callCount === 1) {
          return { channels: [{ mean: 30 }, { mean: 30 }, { mean: 30 }] } // night
        }
        if (callCount === 2) {
          return { channels: [{ mean: 200 }, { mean: 200 }, { mean: 200 }] } // day
        }
        return { channels: [{ mean: 100 }, { mean: 100 }, { mean: 100 }] } // day
      }
      const result = await analyzeSceneBrightnessBatch([
        '/fake/night.jpg',
        '/fake/day.jpg',
        '/fake/mid.jpg'
      ])
      expect(result.size).toBe(3)
      expect(result.get('/fake/night.jpg')).toBe('night')
      expect(result.get('/fake/day.jpg')).toBe('day')
      expect(result.get('/fake/mid.jpg')).toBe('day')
    })

    it('默认并发数为 4', async () => {
      // 验证默认参数能正常工作
      mockStats = async () => ({ channels: [{ mean: 100 }, { mean: 100 }, { mean: 100 }] })
      const result = await analyzeSceneBrightnessBatch(['a', 'b', 'c', 'd', 'e'])
      expect(result.size).toBe(5)
    })

    it('自定义并发数生效', async () => {
      mockStats = async () => ({ channels: [{ mean: 100 }, { mean: 100 }, { mean: 100 }] })
      const result = await analyzeSceneBrightnessBatch(['a', 'b'], 1)
      expect(result.size).toBe(2)
    })

    it('部分文件分析失败时仍返回其他文件结果', async () => {
      let callCount = 0
      mockStats = async () => {
        callCount++
        if (callCount === 2) {
          throw new Error('sharp failed')
        }
        return { channels: [{ mean: 100 }, { mean: 100 }, { mean: 100 }] }
      }
      const result = await analyzeSceneBrightnessBatch(['/ok1', '/bad', '/ok2'])
      expect(result.size).toBe(3)
      expect(result.get('/bad')).toBe('unknown')
      expect(result.get('/ok1')).toBe('day')
      expect(result.get('/ok2')).toBe('day')
    })

    it('所有文件分析失败时全部返回 unknown', async () => {
      mockStats = async () => {
        throw new Error('all fail')
      }
      const result = await analyzeSceneBrightnessBatch(['/a', '/b', '/c'])
      expect(result.size).toBe(3)
      for (const v of result.values()) {
        expect(v).toBe('unknown')
      }
    })
  })
})
