/**
 * @layer L1
 * @module src/main/utils/constants
 * @coverage 主进程跨文件共享常量
 * @dependencies none
 * @remarks 纯常量测试，无外部依赖
 */
import { describe, it, expect } from 'vitest'
import {
  STARTUP_SCAN_DELAY_MS,
  THUMBNAIL_CONCURRENCY,
  DRIVE_LETTER_START,
  DRIVE_LETTER_END,
  MEDIA_CACHE_TTL_MS,
  MAX_PATH_ARRAY_SIZE,
  MAX_MEDIA_ID_ARRAY_SIZE,
  MAX_TAG_NAME_LENGTH,
  MAX_FILE_PATH_LENGTH
} from './constants'

describe('constants', () => {
  describe('STARTUP_SCAN_DELAY_MS', () => {
    it('应为 5000 毫秒，让自动扫描在窗口出现后充分让位（启动性能优化方案 A）', () => {
      expect(STARTUP_SCAN_DELAY_MS).toBe(5000)
    })

    it('应是正整数', () => {
      expect(Number.isInteger(STARTUP_SCAN_DELAY_MS)).toBe(true)
      expect(STARTUP_SCAN_DELAY_MS).toBeGreaterThan(0)
    })
  })

  describe('THUMBNAIL_CONCURRENCY', () => {
    it('应限制缩略图并发为 4 避免 OOM', () => {
      expect(THUMBNAIL_CONCURRENCY).toBe(4)
    })

    it('应是合理范围内的正整数', () => {
      expect(Number.isInteger(THUMBNAIL_CONCURRENCY)).toBe(true)
      expect(THUMBNAIL_CONCURRENCY).toBeGreaterThan(0)
      expect(THUMBNAIL_CONCURRENCY).toBeLessThanOrEqual(16)
    })
  })

  describe('DRIVE_LETTER_START', () => {
    it('应为 C(67)', () => {
      expect(DRIVE_LETTER_START).toBe(67)
    })

    it('应对应字符 C', () => {
      expect(String.fromCharCode(DRIVE_LETTER_START)).toBe('C')
    })
  })

  describe('DRIVE_LETTER_END', () => {
    it('应为 Z(90)', () => {
      expect(DRIVE_LETTER_END).toBe(90)
    })

    it('应对应字符 Z', () => {
      expect(String.fromCharCode(DRIVE_LETTER_END)).toBe('Z')
    })

    it('应大于 DRIVE_LETTER_START', () => {
      expect(DRIVE_LETTER_END).toBeGreaterThan(DRIVE_LETTER_START)
    })
  })

  describe('MEDIA_CACHE_TTL_MS', () => {
    it('应为 5 分钟（5 * 60 * 1000 毫秒）', () => {
      expect(MEDIA_CACHE_TTL_MS).toBe(5 * 60 * 1000)
    })

    it('应是正数', () => {
      expect(MEDIA_CACHE_TTL_MS).toBeGreaterThan(0)
    })
  })

  describe('MAX_PATH_ARRAY_SIZE', () => {
    it('应限制单次扫描路径数组上限为 1000', () => {
      expect(MAX_PATH_ARRAY_SIZE).toBe(1000)
    })

    it('应是正整数', () => {
      expect(Number.isInteger(MAX_PATH_ARRAY_SIZE)).toBe(true)
      expect(MAX_PATH_ARRAY_SIZE).toBeGreaterThan(0)
    })
  })

  describe('MAX_MEDIA_ID_ARRAY_SIZE', () => {
    it('应限制单次 mediaId 数组上限为 1000', () => {
      expect(MAX_MEDIA_ID_ARRAY_SIZE).toBe(1000)
    })

    it('应是正整数', () => {
      expect(Number.isInteger(MAX_MEDIA_ID_ARRAY_SIZE)).toBe(true)
      expect(MAX_MEDIA_ID_ARRAY_SIZE).toBeGreaterThan(0)
    })
  })

  describe('MAX_TAG_NAME_LENGTH', () => {
    it('应限制单个标签名称最大长度为 64', () => {
      expect(MAX_TAG_NAME_LENGTH).toBe(64)
    })

    it('应是正整数', () => {
      expect(Number.isInteger(MAX_TAG_NAME_LENGTH)).toBe(true)
      expect(MAX_TAG_NAME_LENGTH).toBeGreaterThan(0)
    })
  })

  describe('MAX_FILE_PATH_LENGTH', () => {
    it('应限制文件路径最大长度为 1024', () => {
      expect(MAX_FILE_PATH_LENGTH).toBe(1024)
    })

    it('应是正整数', () => {
      expect(Number.isInteger(MAX_FILE_PATH_LENGTH)).toBe(true)
      expect(MAX_FILE_PATH_LENGTH).toBeGreaterThan(0)
    })

    it('应大于 MAX_TAG_NAME_LENGTH（路径比标签名长）', () => {
      expect(MAX_FILE_PATH_LENGTH).toBeGreaterThan(MAX_TAG_NAME_LENGTH)
    })
  })

  describe('常量整体约束', () => {
    it('所有数值常量均为有限数', () => {
      const values = [
        STARTUP_SCAN_DELAY_MS,
        THUMBNAIL_CONCURRENCY,
        DRIVE_LETTER_START,
        DRIVE_LETTER_END,
        MEDIA_CACHE_TTL_MS,
        MAX_PATH_ARRAY_SIZE,
        MAX_MEDIA_ID_ARRAY_SIZE,
        MAX_TAG_NAME_LENGTH,
        MAX_FILE_PATH_LENGTH
      ]
      for (const v of values) {
        expect(Number.isFinite(v)).toBe(true)
      }
    })

    it('驱动器字母范围 C-Z 共 24 个字母', () => {
      const count = DRIVE_LETTER_END - DRIVE_LETTER_START + 1
      expect(count).toBe(24)
    })
  })
})
