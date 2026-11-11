/**
 * 外部图片总开关的运行时回归：关闭时两条链路都必须零网络、回退占位。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  setRemoteImagesEnabled,
  isRemoteImagesEnabled,
  resetRemoteImagesEnabled
} from '../../utils/resonance/remote-images-enabled'
import { cdnImageUrl } from '../../utils/resonance/cdnImageUrl'

describe('remote-images-enabled — 正常', () => {
  beforeEach(() => resetRemoteImagesEnabled())

  it('默认开启，保持既有行为不回归', () => {
    expect(isRemoteImagesEnabled()).toBe(true)
  })

  it('显式开启后 gongeo 热链正常生成地址', () => {
    setRemoteImagesEnabled(true)
    expect(cdnImageUrl('outfit', 12345)).toBe('https://cdn.gongeo.us/images/outfits/12345.png')
  })
})

describe('remote-images-enabled — 异常', () => {
  beforeEach(() => resetRemoteImagesEnabled())

  it('开关关闭 → gongeo 热链返回 null（零网络、由调用方回退占位）', () => {
    setRemoteImagesEnabled(false)
    expect(cdnImageUrl('outfit', 12345)).toBeNull()
  })

  it('非 boolean 值按安全默认关闭，且记录明确错误（不静默）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    setRemoteImagesEnabled('false' as unknown as boolean)
    expect(isRemoteImagesEnabled()).toBe(false)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('reset 后恢复默认开启', () => {
    setRemoteImagesEnabled(false)
    resetRemoteImagesEnabled()
    expect(isRemoteImagesEnabled()).toBe(true)
  })
})

describe('remote-images-enabled — 边界', () => {
  beforeEach(() => resetRemoteImagesEnabled())

  it('重复设置为同一值幂等', () => {
    setRemoteImagesEnabled(false)
    setRemoteImagesEnabled(false)
    expect(isRemoteImagesEnabled()).toBe(false)
  })

  it('关闭后原有的参数校验仍生效（非法 id 依旧 null，不产生地址）', () => {
    setRemoteImagesEnabled(false)
    expect(cdnImageUrl('unknown', 1)).toBeNull()
    expect(cdnImageUrl('outfit', -1)).toBeNull()
  })
})
