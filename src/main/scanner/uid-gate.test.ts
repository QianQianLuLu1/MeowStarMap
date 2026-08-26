/**
 * gateAccountUid 单元测试（P0-02 根因修复：账号 UID 合法性闸门）
 *
 * 这些测试验证「虚拟 UID 闸门」纯函数 gateAccountUid 的判定语义。
 * 该闸门位于扫描入库链路（worker-entry.scanDirectory 图片/视频分支），
 * 仅当 extractUidFromPath 的宽松命中位于 discoverUidsFromGameDirs 发现的真实
 * UID 集合内（GamePlayPhotos 一级纯数字子目录）或本身为 'default' 时才采用，
 * 否则归 'default' 且不注册档案，从源头阻断虚拟 UID 写入 character_profiles。
 *
 * 运行（本机 vitest 环境损坏，需在正常环境执行）：
 *   npm run test:main
 *   或单项：npx vitest run src/main/scanner/uid-gate.test.ts
 */
import { describe, it, expect } from 'vitest'
import { extractUidFromPath, gateAccountUid, isGatedVirtualUid } from './path-classifier'

describe('gateAccountUid（虚拟 UID 闸门）', () => {
  describe('参数校验 / 向后兼容', () => {
    it('validUids 为 undefined 时保留旧行为，原样返回 rawUid', () => {
      expect(gateAccountUid('1700000000', undefined)).toBe('1700000000')
      expect(gateAccountUid('123456789', undefined)).toBe('123456789')
      expect(gateAccountUid('default', undefined)).toBe('default')
    })

    it('validUids 为 null 时保留旧行为，原样返回 rawUid', () => {
      expect(gateAccountUid('1700000000', null)).toBe('1700000000')
      expect(gateAccountUid('123456789', null)).toBe('123456789')
    })
  })

  describe('基础用例：真实 UID 采用', () => {
    const validUids = new Set(['123456789', '987654321'])

    it('命中真实 UID 集合时返回该 UID', () => {
      expect(gateAccountUid('123456789', validUids)).toBe('123456789')
      expect(gateAccountUid('987654321', validUids)).toBe('987654321')
    })

    it('rawUid 为 default 时始终返回 default（无论集合是否匹配）', () => {
      expect(gateAccountUid('default', validUids)).toBe('default')
      // 默认账号不应被误判为集合内数字
      expect(gateAccountUid('default', new Set(['default']))).toBe('default')
    })

    it('虚拟数字段（时间戳/活动ID/嵌套数字目录）不在集合内时归 default', () => {
      // 游戏内置截图时间戳目录：ScreenShot\1700000000\a.jpg
      const rawUid = extractUidFromPath('D:\\Game\\ScreenShot\\1700000000\\a.jpg')
      expect(rawUid).toBe('1700000000')
      expect(gateAccountUid(rawUid, validUids)).toBe('default')
    })

    it('真实路径（GamePlayPhotos/{uid}/...）提取的 UID 命中集合时采用', () => {
      const rawUid = extractUidFromPath(
        'D:\\X6Game\\Saved\\GamePlayPhotos\\123456789\\NikkiPhotos_HighQuality\\photo.jpg'
      )
      expect(rawUid).toBe('123456789')
      expect(gateAccountUid(rawUid, validUids)).toBe('123456789')
    })
  })

  describe('错误处理 / 边界', () => {
    it('validUids 为空 Set：回退旧行为原样返回 rawUid（避免静默零档案退化）', () => {
      // 空 Set 源于 discoverUidsFromGameDirs 返回 []（全新账号未拍照或目录 IO/权限异常被吞）。
      // 若误判为「有效空集闸门」会让所有文件归 default 并跳过注册，造成静默零档案写入，
      // 故空 Set 与 null/undefined 一致，保留旧行为注册路径中的真实 UID。
      expect(gateAccountUid('1700000000', new Set())).toBe('1700000000')
      expect(gateAccountUid('123456789', new Set())).toBe('123456789')
    })

    it('rawUid 为空串不抛错，返回 default', () => {
      expect(() => gateAccountUid('', new Set(['x']))).not.toThrow()
      expect(gateAccountUid('', new Set(['x']))).toBe('default')
    })

    it('rawUid 为 default 且 validUids 为空 Set 时仍返回 default', () => {
      expect(gateAccountUid('default', new Set())).toBe('default')
    })
  })
})

describe('isGatedVirtualUid（P0-02 拦截诊断计数判定）', () => {
  describe('应计入诊断计数（虚拟段被拦截）', () => {
    it('rawUid 为虚拟数字段、闸门归 default、允许集非空 → true', () => {
      const validUids = new Set(['123456789'])
      const rawUid = '1700000000' // 时间戳/活动ID 等虚拟段
      const gated = gateAccountUid(rawUid, validUids)
      expect(gated).toBe('default')
      expect(isGatedVirtualUid(rawUid, gated, validUids)).toBe(true)
    })

    it('真实路径含更高层级虚拟数字目录（先于真实 UID）被拦截 → true', () => {
      const validUids = new Set(['123456789'])
      // ScreenShot\1700000000 时间戳目录：extractUidFromPath 先命中虚拟段
      const rawUid = extractUidFromPath('D:\\Game\\ScreenShot\\1700000000\\a.jpg')
      const gated = gateAccountUid(rawUid, validUids)
      expect(isGatedVirtualUid(rawUid, gated, validUids)).toBe(true)
    })
  })

  describe('不计入诊断计数（合法或闸门未生效）', () => {
    it('rawUid 为 default（路径本无 UID）→ false', () => {
      expect(isGatedVirtualUid('default', 'default', new Set(['123456789']))).toBe(false)
    })

    it('rawUid 命中允许集、闸门保留真实 UID → false', () => {
      const validUids = new Set(['123456789'])
      const rawUid = '123456789'
      const gated = gateAccountUid(rawUid, validUids)
      expect(gated).toBe('123456789')
      expect(isGatedVirtualUid(rawUid, gated, validUids)).toBe(false)
    })

    it('允许集为空 Set → 闸门未生效，不计数 → false', () => {
      const rawUid = '1700000000'
      const gated = gateAccountUid(rawUid, new Set())
      expect(gated).toBe('1700000000') // 空集合回退旧行为，不拦截
      expect(isGatedVirtualUid(rawUid, gated, new Set())).toBe(false)
    })

    it('允许集为 null/undefined → 闸门未生效，不计数 → false', () => {
      const rawUid = '1700000000'
      const gatedNull = gateAccountUid(rawUid, null)
      const gatedUndef = gateAccountUid(rawUid, undefined)
      expect(isGatedVirtualUid(rawUid, gatedNull, null)).toBe(false)
      expect(isGatedVirtualUid(rawUid, gatedUndef, undefined)).toBe(false)
    })
  })
})
