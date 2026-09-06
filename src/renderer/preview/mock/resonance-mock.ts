// 共鸣录 Mock：UI 展示用示例数据
// 数据读取返回示例数据（让 UI 完整渲染），写入操作提示预览版不支持

import { unsupported } from './ipc-error'
import i18n from '../../i18n'
import type {
  ResonanceGetDataResult,
  ResonancePullRow,
  ResonanceEditRow,
  ResonancePearpalRow,
  ResonanceEvoRow,
  ResonanceWardrobeData
} from '../../../shared/types/resonance'

// ============================================================================
// 示例数据：让预览版的共鸣录 UI 内容丰富、可交互
// ============================================================================

/** 示例抽卡记录：卡池 73（最新）露肩绒绒 + 其他卡池散条 */
const SAMPLE_PULLS: ResonancePullRow[] = [
  // 卡池 73 — 最新一期（含 5 星出货）
  {
    id: 1,
    banner_id: '73',
    item_id: '10294',
    obtained_at: '2026-08-28 14:23:01',
    source: 'json',
    created_at: '2026-08-28 14:23:01'
  },
  {
    id: 2,
    banner_id: '73',
    item_id: '10084',
    obtained_at: '2026-08-28 14:23:15',
    source: 'json',
    created_at: '2026-08-28 14:23:15'
  },
  {
    id: 3,
    banner_id: '73',
    item_id: '10056',
    obtained_at: '2026-08-28 14:24:02',
    source: 'json',
    created_at: '2026-08-28 14:24:02'
  },
  {
    id: 4,
    banner_id: '73',
    item_id: '10397',
    obtained_at: '2026-08-28 14:25:30',
    source: 'json',
    created_at: '2026-08-28 14:25:30'
  },
  {
    id: 5,
    banner_id: '73',
    item_id: '10084',
    obtained_at: '2026-08-28 14:27:44',
    source: 'json',
    created_at: '2026-08-28 14:27:44'
  },
  {
    id: 6,
    banner_id: '73',
    item_id: '10092',
    obtained_at: '2026-08-28 14:30:12',
    source: 'json',
    created_at: '2026-08-28 14:30:12'
  },
  {
    id: 7,
    banner_id: '73',
    item_id: '10294',
    obtained_at: '2026-08-28 14:33:55',
    source: 'json',
    created_at: '2026-08-28 14:33:55'
  },
  {
    id: 8,
    banner_id: '73',
    item_id: '10058',
    obtained_at: '2026-08-28 14:35:20',
    source: 'json',
    created_at: '2026-08-28 14:35:20'
  },
  {
    id: 9,
    banner_id: '73',
    item_id: '10033',
    obtained_at: '2026-08-28 14:38:01',
    source: 'json',
    created_at: '2026-08-28 14:38:01'
  },
  {
    id: 10,
    banner_id: '73',
    item_id: '10145',
    obtained_at: '2026-08-28 14:41:22',
    source: 'json',
    created_at: '2026-08-28 14:41:22'
  },
  // 卡池 70 — 闪耀期许·美梦筑巢
  {
    id: 11,
    banner_id: '70',
    item_id: '10366',
    obtained_at: '2026-07-20 10:15:30',
    source: 'json',
    created_at: '2026-07-20 10:15:30'
  },
  {
    id: 12,
    banner_id: '70',
    item_id: '10085',
    obtained_at: '2026-07-20 10:16:45',
    source: 'json',
    created_at: '2026-07-20 10:16:45'
  },
  {
    id: 13,
    banner_id: '70',
    item_id: '10392',
    obtained_at: '2026-07-20 10:18:20',
    source: 'json',
    created_at: '2026-07-20 10:18:20'
  },
  {
    id: 14,
    banner_id: '70',
    item_id: '10126',
    obtained_at: '2026-07-20 10:22:10',
    source: 'json',
    created_at: '2026-07-20 10:22:10'
  },
  {
    id: 15,
    banner_id: '70',
    item_id: '10392',
    obtained_at: '2026-07-20 10:25:33',
    source: 'json',
    created_at: '2026-07-20 10:25:33'
  },
  // 卡池 69 — 虚影的饔宴
  {
    id: 16,
    banner_id: '69',
    item_id: '10300',
    obtained_at: '2026-07-18 09:30:00',
    source: 'json',
    created_at: '2026-07-18 09:30:00'
  },
  {
    id: 17,
    banner_id: '69',
    item_id: '10391',
    obtained_at: '2026-07-18 09:32:15',
    source: 'json',
    created_at: '2026-07-18 09:32:15'
  },
  {
    id: 18,
    banner_id: '69',
    item_id: '10084',
    obtained_at: '2026-07-18 09:35:40',
    source: 'json',
    created_at: '2026-07-18 09:35:40'
  },
  {
    id: 19,
    banner_id: '69',
    item_id: '10165',
    obtained_at: '2026-07-18 09:38:55',
    source: 'json',
    created_at: '2026-07-18 09:38:55'
  },
  // 卡池 66 — 星月万载
  {
    id: 20,
    banner_id: '66',
    item_id: '10382',
    obtained_at: '2026-06-25 16:45:10',
    source: 'json',
    created_at: '2026-06-25 16:45:10'
  },
  {
    id: 21,
    banner_id: '66',
    item_id: '10385',
    obtained_at: '2026-06-25 16:47:25',
    source: 'json',
    created_at: '2026-06-25 16:47:25'
  },
  {
    id: 22,
    banner_id: '66',
    item_id: '10223',
    obtained_at: '2026-06-25 16:50:30',
    source: 'json',
    created_at: '2026-06-25 16:50:30'
  }
]

/** 示例手动补录记录 */
const SAMPLE_EDITS: ResonanceEditRow[] = [
  {
    id: 1001,
    banner_id: '65',
    item_id: '10384',
    obtained_at: '2026-06-12 11:30:00',
    created_at: '2026-08-30 09:00:00'
  },
  {
    id: 1002,
    banner_id: '64',
    item_id: '10288',
    obtained_at: '2026-06-11 20:15:00',
    created_at: '2026-08-30 09:00:00'
  },
  {
    id: 1003,
    banner_id: '63',
    item_id: '10301',
    obtained_at: '2026-05-30 14:00:00',
    created_at: '2026-08-30 09:00:00'
  }
]

/** 示例 Pearpal  Pearpal 手账记录 */
const SAMPLE_PEARPAL: ResonancePearpalRow[] = []

/** 示例进化覆盖记录 */
const SAMPLE_EVO: ResonanceEvoRow[] = [
  { banner_id: '56', outfit_id: '10268', level: 3, updated_at: '2026-04-15T10:00:00Z' },
  { banner_id: '59', outfit_id: '10290', level: 4, updated_at: '2026-05-01T10:00:00Z' },
  { banner_id: '66', outfit_id: '10382', level: 2, updated_at: '2026-07-01T10:00:00Z' }
]

/** 示例衣橱数据 */
const SAMPLE_WARDROBE: ResonanceWardrobeData = {
  version: 1,
  ownedItemIds: [
    10294, 10084, 10056, 10397, 10092, 10058, 10366, 10392, 10300, 10391, 10382, 10385, 10223,
    10384, 10288, 10301, 10145, 10033
  ],
  ownedMakeupIds: [2001, 2003, 2005, 2008, 2012],
  ownedMomoIds: [3001, 3004, 3007, 3010],
  ownedPropIds: [4002, 4005, 4009, 4015],
  ownedEurekaColorIds: [5001, 5003, 5006, 5010],
  updatedAt: '2026-08-30T12:00:00.000Z'
}

/** 组合后的完整 getData 返回 */
const SAMPLE_DATA: ResonanceGetDataResult = {
  pulls: SAMPLE_PULLS,
  edits: SAMPLE_EDITS,
  pearpal: SAMPLE_PEARPAL,
  evo: SAMPLE_EVO,
  wardrobe: SAMPLE_WARDROBE
}

// ============================================================================
// Mock 实现
// ============================================================================

export const resonanceMock = {
  // 数据读取：返回示例数据
  getData: async (): Promise<ResonanceGetDataResult> => SAMPLE_DATA,

  // 写入操作：全部抛 PREVIEW_UNSUPPORTED，组件已有 try/catch + Toast 自动降级
  addManualRecord: async () => {
    throw unsupported(i18n.t('mock.feature.resonanceAddRecord'))
  },
  updateManualRecord: async () => {
    throw unsupported(i18n.t('mock.feature.resonanceUpdateRecord'))
  },
  deleteRecord: async () => {
    throw unsupported(i18n.t('mock.feature.resonanceDeleteRecord'))
  },
  readImportFile: async () => {
    throw unsupported(i18n.t('mock.feature.resonanceReadImport'))
  },
  commitImport: async () => {
    throw unsupported(i18n.t('mock.feature.resonanceCommitImport'))
  },
  export: async () => {
    throw unsupported(i18n.t('mock.feature.resonanceExport'))
  },
  updateWardrobe: async () => {
    throw unsupported(i18n.t('mock.feature.resonanceUpdateWardrobe'))
  },
  clearAll: async () => {
    throw unsupported(i18n.t('mock.feature.resonanceClearAll'))
  }
} as const
