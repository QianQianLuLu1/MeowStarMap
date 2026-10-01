import { describe, expect, it } from 'vitest'
import { cn } from './cn'

describe('cn', () => {
  it('拼接非空类名', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('过滤 false/null/undefined 条件类名', () => {
    const hasError = ''.length > 0
    expect(cn('a', hasError && 'b', null, undefined, 'c')).toBe('a c')
  })

  it('全部为假值时返回空串', () => {
    expect(cn(false, null, undefined)).toBe('')
  })

  it('条件为真/为假时按运行时值取舍', () => {
    const items = [1, 2, 3]
    const hasItems = items.length > 0
    expect(cn('glass-card', hasItems && 'active')).toBe('glass-card active')

    const empty: number[] = []
    expect(cn('glass-card', empty.length > 0 && 'active')).toBe('glass-card')
  })
})
