/**
 * 参考数据名称查表（纯函数，零网络、零 Node/Electron 依赖）。
 *
 * 数据真相源：src/shared/data/infinity_nikki.zh-CN.json —— 逐字取自上游
 * RanAxro/nikki_albums 仓库 `assets/lang/infinity_nikki/zh-CN.json`（MIT，
 * 版权声明见根目录 THIRD_PARTY_NOTICES），对齐 main @ dc1b30b。
 *
 * 只暴露上游**确实存在**的 4 组「数值 → 中文名」映射；media_params 中的
 * light / filter / pose 仅为标签字符串，上游未提供「枚举名 → 数字 id」映射，
 * 因此本模块不臆造映射、不生成任何图片地址（灯光/滤镜行保持纯文字）。
 *
 * 外部输入一律不可信：组名须在封闭集内、数值须为有限数；查不到返回 null，
 * 由展示层回退既有 i18n 文案或纯文字，不抛未捕获异常、不静默给出错值。
 */
import upstreamNames from '../../shared/data/infinity_nikki.zh-CN.json'

/** 封闭集：只有上游实采确认存在数值映射的组才可查询 */
export const REFERENCE_NAME_GROUPS = [
  'photo_mode',
  'wind_intensity',
  'wind_direction',
  'weather'
] as const

export type ReferenceNameGroup = (typeof REFERENCE_NAME_GROUPS)[number]

type NameTable = Readonly<Record<string, string | undefined>>

const TABLES: Readonly<Record<ReferenceNameGroup, NameTable>> = {
  photo_mode: asNameTable(upstreamNames.infinity_nikki.photo_mode),
  wind_intensity: asNameTable(upstreamNames.infinity_nikki.wind_intensity),
  wind_direction: asNameTable(upstreamNames.infinity_nikki.wind_direction),
  weather: asNameTable(upstreamNames.infinity_nikki.weather)
}

/** 结构防御：JSON 缺字段 / 类型错时返回空表，不让模块初始化抛异常 */
function asNameTable(raw: unknown): NameTable {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0) out[key] = value
  }
  return out
}

function isReferenceNameGroup(value: unknown): value is ReferenceNameGroup {
  return typeof value === 'string' && (REFERENCE_NAME_GROUPS as readonly string[]).includes(value)
}

/**
 * 按组与数值查本地化名称。
 * @returns 上游名称；未知组 / 未知值 / 非法入参一律 null（fail-closed）
 */
export function lookupReferenceName(group: unknown, value: unknown): string | null {
  if (!isReferenceNameGroup(group)) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const name = TABLES[group][String(value)]
  return typeof name === 'string' && name.length > 0 ? name : null
}
