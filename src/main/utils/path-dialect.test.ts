/**
 * @layer L1
 * @module src/main/utils/path-dialect
 * @coverage pathOf/sepOf/joinUnder
 * @dependencies 无（纯函数，不触磁盘）
 * @remarks
 * 本文件**不**打 posix 宿主桩：它要证明的是「同一段代码在两种数据方言下各按自己的语义拼接」，
 * 而宿主语义由 CI（ubuntu）与开发机（win32）两侧各跑一遍来覆盖。
 * 判据用例：`joinUnder` 的两个方向（POSIX 根 → 正斜杠结果、Windows 根 → 反斜杠结果）
 * 只要有任何一侧被钉死成单一语义就会红——把 `pathOf` 改成恒 `win32` 或恒宿主，本文件立即红。
 */
import { describe, it, expect } from 'vitest'
import nodePath from 'path'
import { pathOf, sepOf, joinUnder } from './path-dialect'

describe('path-dialect —— 按数据方言选路径语义', () => {
  describe('pathOf', () => {
    it('含反斜杠的串取 win32 语义（正常）', () => {
      expect(pathOf('D:\\Game\\GamePlayPhotos')).toBe(nodePath.win32)
      expect(pathOf('D:\\Game\\GamePlayPhotos').basename('D:\\a\\b')).toBe('b')
    })

    it('POSIX 串取 posix 语义，不返回 win32（正常）', () => {
      const p = pathOf('/tmp/ci-io-abc')
      expect(p.sep).toBe('/')
      expect(p.basename('/a/b')).toBe('b')
    })

    it('盘符 + 正斜杠的 Windows 写法仍判为 win32 方言（边界）', () => {
      expect(pathOf('C:/Games/InfinityNikki')).toBe(nodePath.win32)
      expect(sepOf('C:/Games/InfinityNikki')).toBe('\\')
    })

    it('UNC 根判为 win32 方言（边界）', () => {
      expect(pathOf('\\\\server\\share\\Game')).toBe(nodePath.win32)
    })

    it('相对路径、空串、盘符相对名一律走 posix 侧，不冒领 win32（异常输入不放宽）', () => {
      // 三种形态在两种方言下都不是绝对路径；钉 posix 是为了结果与宿主无关
      expect(sepOf('relative/a.jpg')).toBe('/')
      expect(sepOf('')).toBe('/')
      expect(sepOf('C:x')).toBe('/')
      expect(pathOf('C:x').isAbsolute('C:x')).toBe(false)
      expect(pathOf('relative/a.jpg').isAbsolute('relative/a.jpg')).toBe(false)
    })
  })

  describe('sepOf', () => {
    it('前缀比较用的分隔符跟随串的方言，而不是宿主（这是 scan-channels E002 误记的根因）', () => {
      expect(sepOf('D:\\a')).toBe('\\')
      expect(sepOf('/tmp/a')).toBe('/')
    })
  })

  describe('joinUnder', () => {
    it('POSIX 临时目录根拼出纯正斜杠串，可直接交给 fs（正常）', () => {
      expect(joinUnder('/tmp/x', 'X6Game', 'Saved', 'GamePlayPhotos')).toBe(
        '/tmp/x/X6Game/Saved/GamePlayPhotos'
      )
    })

    it('Windows 形态根拼出纯反斜杠串，与产品宿主行为逐字一致（正常）', () => {
      expect(joinUnder('C:\\Games\\X', 'X6Game', 'Saved', 'GamePlayPhotos')).toBe(
        'C:\\Games\\X\\X6Game\\Saved\\GamePlayPhotos'
      )
    })

    it('片段不含分隔符时结果不出现混合分隔符（回归判据）', () => {
      // 混合分隔符就是 CI 红灯的原样：反斜杠根 + 宿主 join 造出 `...\X6Game/Saved`
      const hasSlash = (s: string) => s.includes('/')
      const hasBackslash = (s: string) => s.includes('\\')
      for (const base of ['/tmp/x', 'C:\\Games\\X', '\\\\srv\\share']) {
        const joined = joinUnder(base, 'X6Game', 'Saved')
        expect(hasSlash(joined) && hasBackslash(joined), joined).toBe(false)
      }
      expect(joinUnder('C:\\Games\\X', 'X6Game', 'Saved')).toBe('C:\\Games\\X\\X6Game\\Saved')
    })

    it('根为盘符根时不丢尾分隔符语义（边界）', () => {
      expect(joinUnder('D:\\', 'a')).toBe('D:\\a')
      expect(joinUnder('/', 'a')).toBe('/a')
    })
  })
})
