/**
 * T8 纯函数判据测试：filterEntries / insCandidates / splitListInput。
 * 判据逐字对齐上游 InspirationPanel.ts（6bdab4b4 / v1.0.41-public-beta.2），不发明新语义。
 */
import { describe, expect, it } from 'vitest'
import type {
  NikkiSyncInspirationEntryInfo,
  NikkiSyncInspirationVersionedInfo
} from '../../../shared/types/electron-api'
import {
  INSPIRATION_STATUSES,
  filterEntries,
  insCandidates,
  splitListInput
} from './inspiration-filter'

function makeRow(
  overrides: Partial<NikkiSyncInspirationEntryInfo> = {}
): NikkiSyncInspirationVersionedInfo {
  return {
    revision: 1,
    entry: {
      id: 'e1',
      title: '樱花裙',
      notes: '',
      tags: [],
      categories: [],
      status: 'self',
      createdAt: 1,
      deletedAt: 0,
      code: {
        id: 'c1',
        rawCode: '',
        type: '',
        sourceText: '',
        sourceUrl: null,
        parsedState: 'none',
        snapshotJson: null,
        resolverVersion: null,
        dictionaryVersion: null,
        resolvedAt: 0
      },
      images: [],
      ...overrides
    }
  }
}

describe('filterEntries（上游 InspirationPanel.ts:35 判据）', () => {
  it('空筛选条件返回全部未删除条目', () => {
    const rows = [makeRow(), makeRow({ id: 'e2', title: '海边' })]
    expect(filterEntries(rows, {})).toHaveLength(2)
    expect(filterEntries(rows, { q: '', category: '', status: '' })).toHaveLength(2)
  })

  it('q 大小写不敏感且拼接 title/notes/rawCode/tags/categories 多字段', () => {
    const byTitle = makeRow({ title: 'Blue Dress' })
    const byNotes = makeRow({ id: 'e2', title: 'x', notes: '适合 BLUE 主题' })
    const byCode = makeRow({
      id: 'e3',
      title: 'x',
      code: { ...makeRow().entry.code, rawCode: '1AbCdEfGhIj#' }
    })
    const byTag = makeRow({ id: 'e4', title: 'x', tags: ['Blue系'] })
    const byCategory = makeRow({ id: 'e5', title: 'x', categories: ['blue'] })
    const rows = [byTitle, byNotes, byCode, byTag, byCategory]
    expect(filterEntries(rows, { q: 'blue' })).toHaveLength(4) // title/notes/tag/category（码为 AbC 不含 blue）
    expect(filterEntries(rows, { q: 'ABCDE' })).toEqual([byCode])
    expect(filterEntries(rows, { q: ' BLUE ' })).toHaveLength(4) // trim
  })

  it('category 精确匹配数组元素，不做模糊包含', () => {
    const rows = [
      makeRow({ categories: ['连衣裙'] }),
      makeRow({ id: 'e2', categories: ['连衣裙长款'] })
    ]
    expect(filterEntries(rows, { category: '连衣裙' })).toHaveLength(1)
    expect(filterEntries(rows, { category: '连衣' })).toHaveLength(0)
  })

  it('status 五枚举精确等值过滤', () => {
    const rows = INSPIRATION_STATUSES.map((status, i) => makeRow({ id: `e${i}`, status }))
    for (const status of INSPIRATION_STATUSES) {
      const matched = filterEntries(rows, { status })
      expect(matched).toHaveLength(1)
      expect(matched[0].entry.status).toBe(status)
    }
    expect(filterEntries(rows, { status: 'unknown' })).toHaveLength(0)
  })

  it('恒滤 deletedAt（软删除条目任何条件下不可见）', () => {
    const rows = [makeRow(), makeRow({ id: 'e2', deletedAt: 123 })]
    expect(filterEntries(rows, {})).toHaveLength(1)
    expect(filterEntries(rows, { q: '樱花' })).toHaveLength(1)
  })

  it('三条件可组合（AND 语义）', () => {
    const hit = makeRow({ title: '蓝裙', categories: ['裙装'], status: 'want' })
    const missStatus = makeRow({ id: 'e2', title: '蓝裙', categories: ['裙装'], status: 'self' })
    const missCat = makeRow({ id: 'e3', title: '蓝裙', categories: ['上衣'], status: 'want' })
    expect(
      filterEntries([hit, missStatus, missCat], { q: '蓝', category: '裙装', status: 'want' })
    ).toEqual([hit])
  })

  it('脏行防御：entry 缺失的行直接排除，不抛异常', () => {
    const dirty = { revision: 2 } as unknown as NikkiSyncInspirationVersionedInfo
    expect(filterEntries([dirty, makeRow()], {})).toHaveLength(1)
  })
})

describe('insCandidates（上游 InspirationPanel.ts:54 逐字判据）', () => {
  it('识别 1 开头 11 位字母数字 + # 的分享码', () => {
    expect(insCandidates('1AbCdEfGhIj#')).toEqual(['1AbCdEfGhIj#'])
    expect(insCandidates('复制这段 1abcdefghij# 打开游戏')).toEqual(['1abcdefghij#'])
  })

  it('容忍全角＃标记', () => {
    expect(insCandidates('1abcdefghij＃')).toEqual(['1abcdefghij#'])
  })

  it('码长边界：10 位 / 12 位均不接受，恰好 11 位才接受', () => {
    expect(insCandidates('1abcdefghi#')).toEqual([]) // 10 位
    expect(insCandidates('1abcdefghijkl#')).toEqual([]) // 12 位（回看被前一字母数字挡住）
    expect(insCandidates('1abcdefghij#')).toEqual(['1abcdefghij#']) // 11 位
  })

  it('非 1 开头不接受；前一字符为字母数字时不接受（截取片段）', () => {
    expect(insCandidates('2abcdefghij#')).toEqual([])
    expect(insCandidates('x1abcdefghij#')).toEqual([]) // 前一字符 x 为字母 ⇒ 视为更长码的截取片段，拒绝
    expect(insCandidates('01abcdefghij#')).toEqual([])
  })

  it('URL 行尾的 # 跳过（不误报链接锚点）', () => {
    expect(insCandidates('https://example.com/1abcdefghij#')).toEqual([])
    expect(insCandidates('看 http://a.b/1abcdefghij# 这个')).toEqual([])
  })

  it('回看遇 ASCII 标点即停（空白与方括号除外），中文等非 ASCII 分隔可跨越', () => {
    expect(insCandidates('[1abcdefghij]#')).toEqual(['1abcdefghij#'])
    expect(insCandidates('码：1abcdefghij#')).toEqual(['1abcdefghij#'])
    expect(insCandidates('1ab-cdefghij#')).toEqual([]) // '-' 在回看收集途中 ⇒ break，不足 11 位
    expect(insCandidates('a=1abcdefghij#')).toEqual(['1abcdefghij#']) // '=' 在 11 位之外，前字符检查只挡字母数字
  })

  it('多行输入按行回看，去重且上限 20', () => {
    expect(insCandidates('1abcdefghij#\n1abcdefghij#')).toEqual(['1abcdefghij#'])
    const many = Array.from(
      { length: 25 },
      (_, i) => `1abcdefgh${String(i).padStart(2, '0')}#`
    ).join('\n')
    expect(insCandidates(many)).toHaveLength(20)
  })

  it('空串与无标记文本返回空数组', () => {
    expect(insCandidates('')).toEqual([])
    expect(insCandidates('普通笔记没有码')).toEqual([])
  })
})

describe('splitListInput（上游 InspirationPanel.ts:67 拆分判据）', () => {
  it('按 、/半角逗号/全角逗号 拆分并 trim 去空', () => {
    expect(splitListInput(' 蓝 、白, 粉，绿 ')).toEqual(['蓝', '白', '粉', '绿'])
    expect(splitListInput(',,、，')).toEqual([])
    expect(splitListInput('')).toEqual([])
  })

  it('Set 去重保序', () => {
    expect(splitListInput('裙装,裙装、裙装')).toEqual(['裙装'])
  })
})
