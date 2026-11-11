/**
 * T5-B 失败先行：MIT 静态语言底座与名称映射纯函数。
 *
 * 覆盖度实采（2026-11-10，上游 RanAxro/nikki_albums main 的
 * assets/lang/infinity_nikki/zh-CN.json）：
 * - 顶层 photo_mode / wind_intensity / wind_direction / weather 为「数值 → 中文名」映射；
 * - media_params.light / filter / pose 仅为标签字符串，**没有**枚举名 → 数字 id 映射，
 *   故灯光/滤镜缩略图无法接入，保持纯文字（不臆造映射）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  lookupReferenceName,
  REFERENCE_NAME_GROUPS,
  type ReferenceNameGroup
} from './reference-names'
import zhCN from '../i18n/locales/zh-CN.json'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const DATA_PATH = path.join(ROOT, 'src/shared/data/infinity_nikki.zh-CN.json')

describe('静态语言底座（MIT，逐字保留）', () => {
  it('底座文件存在且可解析，含 4 组数值映射与 media_params 子树', () => {
    const raw = fs.readFileSync(DATA_PATH, 'utf8')
    const data = JSON.parse(raw) as {
      infinity_nikki?: Record<string, unknown>
    }
    expect(data.infinity_nikki).toBeDefined()
    for (const group of REFERENCE_NAME_GROUPS) {
      expect(data.infinity_nikki?.[group], `缺少 ${group} 映射`).toBeDefined()
    }
    expect(data.infinity_nikki?.media_params).toBeDefined()
  })

  it('本轮新增的 3 组映射与 zh-CN 语包 enums.* 译文逐字一致（名称映射无漂移）', () => {
    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) as {
      infinity_nikki: Record<string, Record<string, string>>
    }
    // 仅本轮新增的 3 组；weather 是既有映射，译文风格差异见下一条断言
    const pairs: Array<[ReferenceNameGroup, Record<string, string>]> = [
      ['photo_mode', zhCN.enums.photoMode as unknown as Record<string, string>],
      ['wind_intensity', zhCN.enums.windIntensity as unknown as Record<string, string>],
      ['wind_direction', zhCN.enums.windDirection as unknown as Record<string, string>]
    ]
    for (const [group, localeMap] of pairs) {
      const upstream = data.infinity_nikki[group]
      for (const [value, name] of Object.entries(upstream)) {
        const localeKey = value === '-1' ? 'neg1' : value
        expect(localeMap[localeKey], `${group}.${value} 与语包译文不一致`).toBe(name)
      }
    }
  })

  it('既有 weather 组与上游逐字差异如实登记（不改动既有文案）', () => {
    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) as {
      infinity_nikki: Record<string, Record<string, string>>
    }
    const localeMap = zhCN.enums.weather as unknown as Record<string, string>
    // 既有语包用「晴朗」，上游为「晴」：属既有译文风格差异，本轮按边界不改动
    expect(localeMap['0']).toBe('晴朗')
    expect(data.infinity_nikki.weather['0']).toBe('晴')
    expect(Object.keys(data.infinity_nikki.weather)).toHaveLength(9)
  })

  it('许可标注：THIRD_PARTY_NOTICES 明确记录该静态资源的来源与 MIT 许可', () => {
    const notices = fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES'), 'utf8')
    expect(notices).toContain('assets/lang/infinity_nikki/zh-CN.json')
    expect(notices).toContain('Copyright (c) 2025 Ran')
  })
})

describe('lookupReferenceName 纯函数', () => {
  it('正常：4 组已知数值均返回底座中的中文名', () => {
    expect(lookupReferenceName('photo_mode', 0)).toBe('普通拍照')
    expect(lookupReferenceName('wind_intensity', -1)).toBe('未知')
    expect(lookupReferenceName('wind_direction', 8)).toBe('无')
    expect(lookupReferenceName('weather', 7)).toBe('星海')
  })

  it('异常：未知组 / 未知数值 / 非有限数一律返回 null（fail-closed）', () => {
    expect(lookupReferenceName('unknown_group' as ReferenceNameGroup, 1)).toBeNull()
    expect(lookupReferenceName('photo_mode', 999)).toBeNull()
    expect(lookupReferenceName('photo_mode', Number.NaN)).toBeNull()
    expect(lookupReferenceName('photo_mode', Number.POSITIVE_INFINITY)).toBeNull()
    expect(lookupReferenceName(null as unknown as ReferenceNameGroup, 0)).toBeNull()
    expect(lookupReferenceName('photo_mode', '0' as unknown as number)).toBeNull()
  })

  it('边界：字符串数值键与数字键等价，且 4 组映射条目数符合实采', () => {
    expect(lookupReferenceName('photo_mode', 3)).toBe('游戏截图')
    expect(lookupReferenceName('wind_intensity', 4)).toBe('特大风')
    const counts: Record<ReferenceNameGroup, number> = {
      photo_mode: 4,
      wind_intensity: 6,
      wind_direction: 10,
      weather: 9
    }
    for (const group of REFERENCE_NAME_GROUPS) {
      let found = 0
      for (let v = -1; v <= 10; v++) if (lookupReferenceName(group, v) !== null) found++
      expect(found, `${group} 条目数`).toBe(counts[group])
    }
  })
})
