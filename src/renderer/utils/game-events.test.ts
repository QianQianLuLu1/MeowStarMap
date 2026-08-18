import { describe, it, expect } from 'vitest'
import {
  GAME_VERSIONS,
  GAME_EVENTS,
  getGameVersions,
  getGameEvents,
  findVersionByDate,
  getTimelineNodes
} from './game-events'

describe('game-events', () => {
  describe('常量配置', () => {
    it('GAME_VERSIONS 按时间升序排列', () => {
      for (let i = 1; i < GAME_VERSIONS.length; i++) {
        const prev = new Date(GAME_VERSIONS[i - 1].startDate).getTime()
        const curr = new Date(GAME_VERSIONS[i].startDate).getTime()
        expect(curr).toBeGreaterThanOrEqual(prev)
      }
    })

    it('GAME_VERSIONS 每条记录包含必填字段', () => {
      for (const v of GAME_VERSIONS) {
        expect(v.version).toBeTruthy()
        expect(v.name).toBeTruthy()
        expect(v.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      }
    })

    it('GAME_EVENTS 每条记录包含必填字段', () => {
      for (const e of GAME_EVENTS) {
        expect(e.name).toBeTruthy()
        expect(e.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(e.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      }
    })
  })

  describe('getGameVersions / getGameEvents', () => {
    it('返回与常量相同的引用', () => {
      expect(getGameVersions()).toBe(GAME_VERSIONS)
      expect(getGameEvents()).toBe(GAME_EVENTS)
    })
  })

  describe('findVersionByDate', () => {
    it('日期早于最早版本返回 null', () => {
      expect(findVersionByDate('2024-01-01')).toBeNull()
    })

    it('空字符串返回 null', () => {
      expect(findVersionByDate('')).toBeNull()
    })

    it('无效日期返回 null', () => {
      expect(findVersionByDate('invalid-date')).toBeNull()
    })

    it('返回 startDate <= date 的最后一个版本', () => {
      // 2025-05-01 应属于 1.5 泡泡季（2025-04-29 开始），不是 1.6 天真季（2025-06-13）
      const v = findVersionByDate('2025-05-01')
      expect(v).not.toBeNull()
      expect(v?.version).toBe('1.5')
    })

    it('正好等于版本上线日期时归属该版本', () => {
      const v = findVersionByDate('2025-04-29')
      expect(v?.version).toBe('1.5')
    })

    it('最新版本之后的日期返回最新版本', () => {
      const v = findVersionByDate('2026-12-31')
      expect(v?.version).toBe('2.3')
    })
  })

  describe('getTimelineNodes', () => {
    it('合并版本与活动节点并按时间升序排列', () => {
      const nodes = getTimelineNodes()
      expect(nodes.length).toBe(GAME_VERSIONS.length + GAME_EVENTS.length)

      for (let i = 1; i < nodes.length; i++) {
        const prev = new Date(nodes[i - 1].startDate).getTime()
        const curr = new Date(nodes[i].startDate).getTime()
        expect(curr).toBeGreaterThanOrEqual(prev)
      }
    })

    it('版本节点 type=version 且包含 version 字段', () => {
      const nodes = getTimelineNodes()
      const versionNodes = nodes.filter((n) => n.type === 'version')
      expect(versionNodes.length).toBe(GAME_VERSIONS.length)
      for (const n of versionNodes) {
        expect(n.version).toBeTruthy()
        expect(n.key).toBe(`version-${n.version}`)
      }
    })

    it('活动节点 type=event 且 key 形如 event-N', () => {
      const nodes = getTimelineNodes()
      const eventNodes = nodes.filter((n) => n.type === 'event')
      expect(eventNodes.length).toBe(GAME_EVENTS.length)
      for (let i = 0; i < eventNodes.length; i++) {
        expect(eventNodes[i].key).toMatch(/^event-\d+$/)
      }
    })

    it('每个节点包含 name 和 startDate', () => {
      const nodes = getTimelineNodes()
      for (const n of nodes) {
        expect(n.name).toBeTruthy()
        expect(n.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      }
    })
  })
})
