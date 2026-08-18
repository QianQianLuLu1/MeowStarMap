import React, { useContext, createContext } from 'react'
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

interface SettingsToggleProps {
  /** 标签文本 */
  label: string
  /** 描述文本（可选） */
  description?: string
  /** 当前是否开启 */
  checked: boolean
  /** 切换回调 */
  onChange: (checked: boolean) => void
  /** 是否禁用 */
  disabled?: boolean
}

/**
 * 开关类设置行：左侧标签 + 描述，右侧 checkbox
 *
 * 用于 general-sections / appearance-sections 中 7+ 处重复的
 *   `<label><span>{t('xxx')}</span><input type="checkbox" /></label>`
 * 模式。
 *
 * 使用方式：
 *   <SettingsToggle
 *     label={t('settings.startup.autoScan')}
 *     description={t('settings.startup.autoScanDesc')}
 *     checked={autoScan}
 *     onChange={setAutoScan}
 *   />
 */
export const SettingsToggle: React.FC<SettingsToggleProps> = ({
  label,
  description,
  checked,
  onChange,
  disabled
}) => (
  <div>
    <label className={`flex items-center justify-between ${disabled ? '' : 'cursor-pointer'}`}>
      <span style={{ color: 'var(--text-primary)' }}>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="w-5 h-5"
      />
    </label>
    {description && (
      <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
        {description}
      </p>
    )}
  </div>
)

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
