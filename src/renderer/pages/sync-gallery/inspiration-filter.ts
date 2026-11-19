import type { NikkiSyncInspirationVersionedInfo } from '../../../shared/types/electron-api'

/**
 * T8：灵感库过滤/分享码识别纯函数（判据逐字对齐上游
 * NikkiSync/apps/pc-companion/src/desktop/InspirationPanel.ts，基准 6bdab4b4 / v1.0.41-public-beta.2）。
 *
 * - filterEntries：上游 InspirationPanel.ts:35 的可见性判据——
 *   q 对 title/notes/code.rawCode/tags/categories 拼接后小写 includes；
 *   category 精确 `categories.includes`（非模糊）；status 精确等值；
 *   恒滤 deletedAt（上游 :27 的列表前置过滤）。
 * - insCandidates：上游 InspirationPanel.ts:54 的分享码候选识别——
 *   1 开头 11 位字母数字 + '#'（容忍全角＃），跳过 URL 行尾，160 字符回看上限，
 *   去重、最多 20 个。本仓不发明新判据。
 */

/** 上游状态枚举（InspirationPanel.ts:7 的五个 option，顺序一致）。 */
export const INSPIRATION_STATUSES = ['self', 'want', 'reproduced', 'tried', 'archived'] as const

export type InspirationStatus = (typeof INSPIRATION_STATUSES)[number]

export interface InspirationFilterCriteria {
  /** 搜索词（大小写不敏感，多字段拼接 includes） */
  q?: string
  /** 分类（精确匹配 categories 数组元素） */
  category?: string
  /** 状态（精确等值；空串 = 全部） */
  status?: string
}

/**
 * 过滤灵感条目。外部 IPC 行一律防御式收敛：entry 缺失/脏行直接排除
 * （上游假设 entry 恒在，本仓 parseList 只保证行是 record，不保证 entry 形态）。
 */
export function filterEntries(
  entries: NikkiSyncInspirationVersionedInfo[],
  criteria: InspirationFilterCriteria
): NikkiSyncInspirationVersionedInfo[] {
  const q = (criteria.q ?? '').trim().toLowerCase()
  const category = (criteria.category ?? '').trim()
  const status = criteria.status ?? ''
  return entries.filter((row) => {
    const entry = row?.entry
    if (!entry || entry.deletedAt) return false
    const tags = Array.isArray(entry.tags) ? entry.tags : []
    const categories = Array.isArray(entry.categories) ? entry.categories : []
    const haystack = [entry.title, entry.notes, entry.code?.rawCode ?? '', ...tags, ...categories]
      .join(' ')
      .toLowerCase()
    return (
      haystack.includes(q) &&
      (!category || categories.includes(category)) &&
      (!status || entry.status === status)
    )
  })
}

/**
 * 分享码候选识别（上游 insCandidates 逐字移植）：
 * 扫描 '#'/'＃' 标记，取标记所在行向前回看收集 [a-z0-9]（最多 11 位、160 字符），
 * 遇 ASCII 非空白/非方括号标点即停；长度 11 且 1 开头且前一字符非字母数字才接受。
 * 返回 `chars + '#'` 形态，去重、上限 20。
 */
export function insCandidates(value: string): string[] {
  const found: string[] = []
  for (let end = 0; end < value.length && found.length < 20; end++) {
    if (value[end] !== '#' && value[end] !== '＃') continue
    const line = value.slice(value.lastIndexOf('\n', end - 1) + 1, end)
    if (/https?:\/\/[^\s]*$/i.test(line)) continue
    let chars = ''
    let at = line.length
    while (at > 0 && line.length - at < 160 && chars.length < 11) {
      const c = line[--at]
      if (/[a-z0-9]/i.test(c)) chars = c + chars
      else if (c.charCodeAt(0) < 128 && !/\s|\[|\]/.test(c)) break
    }
    if (
      chars.length === 11 &&
      chars[0] === '1' &&
      !(at > 0 && /[a-z0-9]/i.test(line[at - 1])) &&
      !found.includes(chars + '#')
    ) {
      found.push(chars + '#')
    }
  }
  return found
}

/**
 * 逗号分隔输入 → 数组（上游 InspirationPanel.ts:67 的拆分判据）：
 * 按 /[、,，]/ 拆分 → trim → 去空 → Set 去重。长度/数量上限由上游 validate() 单真相源判定。
 */
export function splitListInput(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[、,，]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ]
}
