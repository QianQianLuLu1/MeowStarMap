import React, { useContext, createContext, useId } from 'react'
import { useToast, type ToastType, type ToastMessage } from '../../hooks/useToast'
import { Toast } from '../../components/common/Toast'
// P1-I：formatSize/formatTimestamp 统一到 utils，shared 仅作 re-export 保持外部接口不变
import { formatSize } from '../../utils/format'
import { formatTimestamp } from '../../utils/date'
// P1-U6：FAULT_TYPE_META 与 FaultType 抽取到 utils/fault-colors.ts，此处 re-export 保持外部接口不变
import { FAULT_TYPE_META, type FaultType } from '../../utils/fault-colors'

export { formatSize, formatTimestamp, FAULT_TYPE_META, type FaultType }

// ============ 全局 Toast Context ============
// P0-3：从 SettingsToastProvider 提升为 GlobalToastProvider，覆盖所有页面
// U6：内部 Context 同步重命名为 GlobalToastContext，与 Provider/Hook 语义一致
// 所有页面共享同一个 Toast 实例，避免每个页面各自渲染 Toast
type ShowMessageFn = (text: string, type?: ToastType, action?: ToastMessage['action']) => void
const GlobalToastContext = createContext<ShowMessageFn>(() => {})

/**
 * 全局 Toast Provider（P0-3 改进，原 SettingsToastProvider）
 * 应在 App.tsx 根节点包裹，让 Gallery / Detail / Editor / Categories / RecycleBin / Duplicates 等所有页面都能使用 Toast
 */
export const GlobalToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { messages, showMessage, dismiss } = useToast()
  return (
    <GlobalToastContext.Provider value={showMessage}>
      {children}
      <Toast messages={messages} onDismiss={dismiss} />
    </GlobalToastContext.Provider>
  )
}

/** 全局 Toast Hook，任意页面可调用获取 showMessage */
export function useGlobalToast(): ShowMessageFn {
  return useContext(GlobalToastContext)
}

// 暴露内部 Context 供同目录 Section 组件直接消费（避免重复创建 Context）
export { GlobalToastContext }

// ============ 共享类型与工具 ============

export interface FaultRecord {
  id: string
  timestamp: string
  type: FaultType
  summary: string
  detail: string
  context?: Record<string, unknown>
  file: string
  // P0-1 新增环境信息字段（旧日志可能缺失，UI 兜底显示"未知"）
  appVersion?: string
  electronVersion?: string
  nodeVersion?: string
  platform?: string
  osVersion?: string
  pid?: number
  uptime?: number
}

// T01：数据库备份记录（与主进程 BackupRecord 接口保持一致）
export interface BackupRecord {
  filename: string
  filePath: string
  size: number
  createdAt: string
}

// T13：崩溃 dump 文件元信息（与主进程 CrashRecord 接口保持一致）
// P2-1：新增 crashReason / topFrame 字段
export interface CrashRecord {
  filename: string
  filePath: string
  size: number
  mtime: string
  processType: string
  crashReason?: string
  topFrame?: string
}

// 三级页面容器：统一标题 + 内容区
export const SectionShell: React.FC<{
  title: string
  description?: string
  children: React.ReactNode
}> = ({ title, description, children }) => (
  <div className="glass-card p-5 space-y-4">
    <div>
      <h3 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
        {title}
      </h3>
      {description && (
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
          {description}
        </p>
      )}
    </div>
    {children}
  </div>
)

// ============ 设置行项公共组件 ============
// 设计目标：消除 general-sections / appearance-sections / data-sections 等 15+ 处
// 重复的"标签 + 描述 + 控件"结构，统一行项视觉与交互。

interface SettingsRowProps {
  /** 标签文本 */
  label: string
  /** 描述文本（可选，显示在标签下方） */
  description?: string
  /** 右侧控件（如 select、input、自定义按钮） */
  children?: React.ReactNode
}

/**
 * 通用设置行：左侧标签 + 描述，右侧控件
 *
 * 用于设置项中"非开关"类行（如选择语言、选择主题、输入路径等）。
 *
 * 使用方式：
 *   <SettingsRow label={t('settings.language')} description={t('settings.languageDesc')}>
 *     <select value={lang} onChange={setLang}>...</select>
 *   </SettingsRow>
 */
export const SettingsRow: React.FC<SettingsRowProps> = ({ label, description, children }) => (
  <div className="flex items-center justify-between gap-3">
    <div className="flex-1 min-w-0">
      <span style={{ color: 'var(--text-primary)' }}>{label}</span>
      {description && (
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
          {description}
        </p>
      )}
    </div>
    {children}
  </div>
)

export interface SettingsToggleProps {
  /** 可见标签文本（必填、非空；用于 aria-labelledby 关联） */
  label: string
  /** 描述文本（可选；提供时渲染并通过 aria-describedby 关联） */
  description?: string
  /** 当前是否开启（非 boolean 会按真值性归一化） */
  checked: boolean
  /** 切换回调，接收"取反后"的新值；组件内部已做异常兜底 */
  onChange: (checked: boolean) => void
  /** 是否禁用（短路 onChange + 原生 disabled 双重保险） */
  disabled?: boolean
}

/**
 * 开关类设置行：左侧标签 + 描述，右侧「弹性开关」
 *
 * 用于收敛 general-sections / appearance-sections / scan-sections 中重复的
 *   `<label><span>{t('xxx')}</span><input type="checkbox" /></label>`
 * 模式，是设置板块唯一的开关实现点。
 *
 * 交互：滑块按下（拖动起步）时横向拉伸，松开落位后以过冲曲线回弹至原宽，
 * 呈现"有质量"的视觉手感。动效由 globals.css 的 .settings-elastic-switch* 承载
 * （与 .motion-hover-scale-* 同族：交互态微动画统一走 CSS，
 * 由 compositor 线程合成 transform，不触发 React 重渲染）。
 *
 * 无障碍：以 <button role="switch"> 实现，原生支持 Space / Enter 键盘切换；
 * aria-checked 反映开关态，aria-labelledby / aria-describedby 关联可见文案。
 *
 * 使用方式：
 *   <SettingsToggle
 *     label={t('settings.startup.autoScan')}
 *     description={t('settings.startup.autoScanDesc')}
 *     checked={autoScan}
 *     onChange={saveAutoScan}
 *   />
 */
export const SettingsToggle: React.FC<SettingsToggleProps> = ({
  label,
  description,
  checked,
  onChange,
  disabled
}) => {
  const uid = useId()
  const labelId = `${uid}-label`
  const descId = `${uid}-desc`

  // 参数归一化：保证 aria-checked 恒为 "true"/"false"，避免读屏无法播报
  const isOn = Boolean(checked)
  const isDisabled = Boolean(disabled)

  // 参数校验：label 缺失属无障碍缺陷，显式上报但不阻断渲染
  // 诊断信息面向开发者（控制台），故使用英文、不走 i18n
  if (typeof label !== 'string' || label.length === 0) {
    console.error('[SettingsToggle] "label" must be a non-empty string, received:', label)
  }

  const handleToggle = (): void => {
    if (isDisabled) return
    if (typeof onChange !== 'function') {
      console.error('[SettingsToggle] "onChange" must be a function, received:', onChange)
      return
    }
    try {
      onChange(!isOn)
    } catch (err) {
      // 错误隔离：回调异常不向上冒泡，避免整个设置页被错误边界卸载
      console.error('[SettingsToggle] "onChange" callback threw:', err)
    }
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <div id={labelId} style={{ color: 'var(--text-primary)' }}>
          {label}
        </div>
        {description && (
          <p id={descId} className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {description}
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={isOn}
        aria-labelledby={labelId}
        aria-describedby={description ? descId : undefined}
        disabled={isDisabled}
        onClick={handleToggle}
        className="settings-elastic-switch"
      >
        <span className="settings-elastic-switch-knob" />
      </button>
    </div>
  )
}

interface SettingsCardProps {
  /** 卡片内容 */
  children: React.ReactNode
  /** 自定义类名（追加到默认类之后） */
  className?: string
}

/**
 * 信息行卡片：圆角 + 浅色背景
 *
 * 用于 data-sections / diagnostics-sections / about-sections 中 6+ 处重复的
 *   `<div className="flex items-center justify-between gap-3 p-3 rounded-lg" style={{background: 'var(--bg-tertiary)'}}>` 模式。
 *
 * 使用方式：
 *   <SettingsCard>
 *     <SettingsRow label="备份路径">{path}</SettingsRow>
 *   </SettingsCard>
 */
export const SettingsCard: React.FC<SettingsCardProps> = ({ children, className = '' }) => (
  <div className={`p-3 rounded-lg ${className}`} style={{ background: 'var(--bg-tertiary)' }}>
    {children}
  </div>
)
