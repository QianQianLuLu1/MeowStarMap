import { describe, it, expect } from 'vitest'
import {
  SCENE_CATEGORIES,
  SCENE_TIMES,
  OUTFIT_PRESETS,
  detectSceneCategory,
  getSceneCategoryLabel,
  getSceneCategoryKeys,
  getSceneTimeLabel,
  getSceneTimeKeys
} from './scene-category'

describe('scene-category', () => {
  describe('常量配置', () => {
    it('SCENE_CATEGORIES 按优先级排序，other 在最后', () => {
      expect(SCENE_CATEGORIES.length).toBeGreaterThan(0)
      expect(SCENE_CATEGORIES[SCENE_CATEGORIES.length - 1].key).toBe('other')
    })

    it('SCENE_TIMES 包含 5 种场景时段', () => {
      expect(SCENE_TIMES.map((t) => t.key)).toEqual(
        expect.arrayContaining(['day', 'night', 'dawn', 'dusk', 'unknown'])
      )
    })

    it('OUTFIT_PRESETS 非空且无重复', () => {
      expect(OUTFIT_PRESETS.length).toBeGreaterThan(10)
      const ids = OUTFIT_PRESETS.map((p) => p.id)
      const set = new Set(ids)
      expect(set.size).toBe(ids.length)
    })
  })

  describe('detectSceneCategory', () => {
    it('Windows 路径分隔符也能识别', () => {
      const path = 'C:\\Games\\InfinityNikki\\ScreenShot\\img.jpg'
      expect(detectSceneCategory(path)).toBe('screenshot')
    })

    it('Unix 路径分隔符可识别', () => {
      expect(detectSceneCategory('/home/user/NikkiPhotos_LowQuality/thumb.jpg')).toBe('thumbnail')
    })

    it('匹配优先级：thumbnail 优先于 screenshot', () => {
      // 同时匹配多个模式时，按数组顺序返回最靠前的
      const path = '/game/NikkiPhotos_LowQuality/ScreenShot/x.jpg'
      expect(detectSceneCategory(path)).toBe('thumbnail')
    })

    it('旅行手账模式', () => {
      expect(detectSceneCategory('/game/MagazinePhotos/journal.jpg')).toBe('travel_journal')
    })

    it('世界巡游模式', () => {
      expect(detectSceneCategory('/game/ClockInPhoto/visit.jpg')).toBe('world_tour')
    })

    it('趣拼海报模式', () => {
      expect(detectSceneCategory('/game/Collage_CollagePhoto/collage.jpg')).toBe('collage')
    })

    it('不匹配任何模式返回 other', () => {
      expect(detectSceneCategory('/some/random/path/img.jpg')).toBe('other')
    })

    it('空路径返回 other', () => {
      expect(detectSceneCategory('')).toBe('other')
      expect(detectSceneCategory(null as unknown as string)).toBe('other')
      expect(detectSceneCategory(undefined as unknown as string)).toBe('other')
    })

    it('大小写不敏感', () => {
      expect(detectSceneCategory('/GAME/SCREENSHOT/IMG.JPG')).toBe('screenshot')
    })

    it('仅匹配目录名片段而非路径任意位置', () => {
      // 路径中含 ScreenShot 子串但不在目录边界，应不匹配
      expect(detectSceneCategory('/foo/MyScreenShotFolder/img.jpg')).toBe('other')
    })
  })

  describe('getSceneCategoryLabel', () => {
    it('已知键返回 i18n key', () => {
      expect(getSceneCategoryLabel('screenshot')).toBe('sceneCategory.screenshot')
      expect(getSceneCategoryLabel('thumbnail')).toBe('sceneCategory.thumbnail')
      expect(getSceneCategoryLabel('other')).toBe('sceneCategory.other')
    })

    it('未知键返回默认 sceneCategory.other', () => {
      expect(getSceneCategoryLabel('unknown' as never)).toBe('sceneCategory.other')
    })
  })

  describe('getSceneCategoryKeys', () => {
    it('返回所有键且顺序与配置一致', () => {
      const keys = getSceneCategoryKeys()
      expect(keys).toEqual(SCENE_CATEGORIES.map((c) => c.key))
    })
  })

  describe('getSceneTimeLabel', () => {
    it('已知键返回 i18n key', () => {
      expect(getSceneTimeLabel('day')).toBe('sceneTime.day')
      expect(getSceneTimeLabel('night')).toBe('sceneTime.night')
      expect(getSceneTimeLabel('unknown')).toBe('sceneTime.unknown')
    })

    it('未知键返回默认 sceneTime.unknown', () => {
      expect(getSceneTimeLabel('xyz' as never)).toBe('sceneTime.unknown')
    })
  })

  describe('getSceneTimeKeys', () => {
    it('返回所有键', () => {
      const keys = getSceneTimeKeys()
      expect(keys).toEqual(SCENE_TIMES.map((c) => c.key))
    })
  })
})
