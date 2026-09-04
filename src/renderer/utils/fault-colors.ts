/**
 * P1-U6：故障类型颜色与元信息常量
 * 从 pages/settings/shared.tsx 抽取，便于崩溃诊断相关组件共享。
 *
 * 颜色策略：
 * - uncaughtException / rendererComponent 复用主题语义色 var(--danger-hover)/var(--danger-bg)，
 *   随主题切换自动适配。
 * - 其他故障类型使用固定识别色（橙/紫/黄/蓝/灰/青/深灰），
 *   作为故障分类的视觉编码，不随主题变化（类似交通信号灯的红黄绿）。
 */
export type FaultType =
  | 'uncaughtException'
  | 'unhandledRejection'
  | 'rendererCrash'
  | 'rendererError'
  | 'ipcError'
  | 'manual'
  | 'rendererComponent'
  | 'rendererPromise'
  | 'rendererResource'
  | 'exitDiagnosis'
  | 'renderer-not-ready'

export interface FaultMeta {
  /** i18n key，供支持 i18n 的组件用 t() 解析 */
  labelKey: string
  color: string
  bg: string
}

export const FAULT_TYPE_META: Record<FaultType, FaultMeta> = {
  uncaughtException: {
    labelKey: 'faultTypes.uncaughtException',
    color: 'var(--danger-hover)',
    bg: 'var(--danger-bg)'
  },
  unhandledRejection: {
    labelKey: 'faultTypes.unhandledRejection',
    color: '#ea580c',
    bg: 'rgba(234, 88, 12, 0.12)'
  },
  rendererCrash: {
    labelKey: 'faultTypes.rendererCrash',
    color: '#9333ea',
    bg: 'rgba(147, 51, 234, 0.12)'
  },
  rendererError: {
    labelKey: 'faultTypes.rendererError',
    color: '#ca8a04',
    bg: 'rgba(202, 138, 4, 0.12)'
  },
  ipcError: { labelKey: 'faultTypes.ipcError', color: '#2563eb', bg: 'rgba(37, 99, 235, 0.12)' },
  manual: { labelKey: 'faultTypes.manual', color: '#6b7280', bg: 'rgba(107, 114, 128, 0.12)' },
  rendererComponent: {
    labelKey: 'faultTypes.rendererComponent',
    color: 'var(--danger-hover)',
    bg: 'var(--danger-bg)'
  },
  rendererPromise: {
    labelKey: 'faultTypes.rendererPromise',
    color: '#ea580c',
    bg: 'rgba(234, 88, 12, 0.12)'
  },
  rendererResource: {
    labelKey: 'faultTypes.rendererResource',
    color: '#0891b2',
    bg: 'rgba(8, 145, 178, 0.12)'
  },
  exitDiagnosis: {
    labelKey: 'faultTypes.exitDiagnosis',
    color: '#475569',
    bg: 'rgba(71, 85, 105, 0.12)'
  },
  'renderer-not-ready': {
    labelKey: 'faultTypes.renderer-not-ready',
    color: '#be123c',
    bg: 'rgba(190, 18, 60, 0.12)'
  }
}
