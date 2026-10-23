import { describe, it, expect } from 'vitest'
import { formatWatermarkText } from './watermark-text'

/**
 * @layer L1
 * @module src/shared/utils/watermark-text
 * @coverage formatWatermarkText 的占位符展开
 * @remarks 固定传入 now，不用系统时钟——渲染层与主进程必须得到同一串文本，否则
 *          「预览有日期、导出是花括号」这类漂移会重新出现。
 */

const at = (y: number, mo: number, d: number, h: number, mi: number): Date =>
  new Date(y, mo - 1, d, h, mi, 0, 0)

describe('formatWatermarkText', () => {
  it('正常：{date} 展开为 YYYY.MM.DD、{time} 展开为 HH:mm，月/日/时/分补零', () => {
    const now = at(2026, 3, 5, 9, 7)
    expect(formatWatermarkText('{date}', now)).toBe('2026.03.05')
    expect(formatWatermarkText('{time}', now)).toBe('09:07')
    expect(formatWatermarkText('{date} {time}', now)).toBe('2026.03.05 09:07')
  })

  it('正常：不区分大小写（用户从模板/预设里可能写成 {DATE}）', () => {
    const now = at(2026, 10, 17, 23, 59)
    expect(formatWatermarkText('{DATE}', now)).toBe('2026.10.17')
    expect(formatWatermarkText('{Time}', now)).toBe('23:59')
  })

  it('边界：同一占位符出现多次全部展开', () => {
    const now = at(2026, 12, 1, 0, 0)
    expect(formatWatermarkText('{date}-{date}', now)).toBe('2026.12.01-2026.12.01')
    expect(formatWatermarkText('x{time}y{time}z', now)).toBe('x00:00y00:00z')
  })

  it('边界：无占位符原样返回；空串返回空串', () => {
    const now = at(2026, 1, 1, 1, 1)
    expect(formatWatermarkText('Meow Star Map', now)).toBe('Meow Star Map')
    expect(formatWatermarkText('', now)).toBe('')
  })

  it('异常：未闭合/未知占位符不得被吞掉或抛错，原样保留', () => {
    const now = at(2026, 1, 1, 1, 1)
    expect(formatWatermarkText('{date', now)).toBe('{date')
    expect(formatWatermarkText('{filename}', now)).toBe('{filename}')
  })

  it('边界：默认 now 走系统时钟，展开结果仍符合日期形态', () => {
    expect(formatWatermarkText('{date}')).toMatch(/^\d{4}\.\d{2}\.\d{2}$/)
  })
})
