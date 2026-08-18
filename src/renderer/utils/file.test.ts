/**
 * @layer L3
 * @module src/renderer/utils/file
 * @coverage needsAnonymousCors 协议判定（crossOrigin 设置前置条件）
 */
import { describe, it, expect } from 'vitest'
import { needsAnonymousCors } from './file'

describe('needsAnonymousCors', () => {
  it('http://、https://、media:// 返回 true', () => {
    expect(needsAnonymousCors('http://example.com/a.jpg')).toBe(true)
    expect(needsAnonymousCors('https://example.com/a.jpg')).toBe(true)
    expect(needsAnonymousCors('media://file?path=a%2Fb.jpg')).toBe(true)
  })

  it('blob:、data:、mock:// 返回 false', () => {
    expect(needsAnonymousCors('blob:http://localhost/uuid')).toBe(false)
    expect(needsAnonymousCors('data:image/png;base64,AAA')).toBe(false)
    expect(needsAnonymousCors('mock:///game/photo.png')).toBe(false)
  })

  it('空串与非法入参返回 false', () => {
    expect(needsAnonymousCors('')).toBe(false)
    // 防御性校验：非 string 入参（运行时可能出现）一律视为无需 CORS
    expect(needsAnonymousCors(null as unknown as string)).toBe(false)
    expect(needsAnonymousCors(undefined as unknown as string)).toBe(false)
  })
})
