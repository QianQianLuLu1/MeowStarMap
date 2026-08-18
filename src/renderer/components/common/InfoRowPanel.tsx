import React from 'react'
import { useTranslation } from 'react-i18next'
import { IconCopy } from '../../icons'

/**
 * P1-U1：5 个 InfoPanel 组件的公共渲染载体
 *
 * 职责：
 * - 统一 loading / error / empty / data 四态渲染
 * - 统一 light / dark 双主题样式
 * - 支持扁平 rows 和分组 groups 两种数据形态
 * - 可选复制按钮（仅 CameraInfoPanel 使用）
 *
 * 设计原则：
 * - 调用方负责 useGameParams 与 xxxToRows 纯函数，本组件只做展示
 * - 行为对齐原有 5 个面板：empty 容器使用 flex 以兼容 CameraInfoPanel 的图标 + 文案组合
 */
export interface InfoRow {
  label: string
  value: string
}

export interface ParamGroup {
  title: string
  rows: InfoRow[]
}

interface InfoRowPanelProps {
  /** 标题左侧图标 */
  icon: React.ReactNode
  /** 标题文本 */
  title: string
  /** 扁平行数据（与 groups 二选一） */
  rows?: InfoRow[]
  /** 分组行数据（与 rows 二选一） */
  groups?: ParamGroup[]
  loading?: boolean
  error?: string | null
  variant?: 'light' | 'dark'
  showTitle?: boolean
  /** 加载态文案 */
  loadingText?: string
  /** 空态文案，可为 ReactNode 以携带图标 */
  emptyText?: React.ReactNode
  /** 错误态前缀 */
  errorPrefix?: string
  /** 复制回调，传入则显示复制按钮 */
  onCopy?: () => void
  copied?: boolean
  copyLabel?: string
}

export const InfoRowPanel: React.FC<InfoRowPanelProps> = ({
  icon,
  title,
  rows,
  groups,
  loading = false,
  error = null,
  variant = 'light',
  showTitle = true,
  loadingText,
  emptyText,
  errorPrefix,
  onCopy,
  copied = false,
  copyLabel
}) => {
  const { t } = useTranslation()
  const resolvedLoadingText = loadingText ?? t('infoPanel.loadingDefault')
  const resolvedEmptyText = emptyText ?? t('infoPanel.emptyDefault')
  const resolvedErrorPrefix = errorPrefix ?? t('infoPanel.errorPrefixDefault')
  const resolvedCopyLabel = copyLabel ?? t('infoPanel.copyDefault')
  const isDark = variant === 'dark'
  const th = isDark
    ? {
        title: 'text-white/90',
        groupTitle: 'text-white/70',
        row: 'border-white/10',
        label: 'text-white/55',
        value: 'text-white/95',
        empty: 'text-white/50',
        btn: 'text-white/80 hover:bg-white/10',
        copied: 'text-emerald-400'
      }
    : {
        title: '',
        groupTitle: '',
        row: 'border-black/5',
        label: '',
        value: '',
        empty: '',
        btn: '',
        copied: ''
      }

  const totalRows = groups ? groups.reduce((sum, g) => sum + g.rows.length, 0) : (rows?.length ?? 0)
  const hasContent = totalRows > 0

  return (
    <div>
      {showTitle && (
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            {icon}
            <span
              className={`text-xs font-semibold ${th.title}`}
              style={!isDark ? { color: 'var(--text-secondary)' } : undefined}
            >
              {title}
            </span>
          </div>
          {onCopy && hasContent && (
            <button
              className={`text-xs flex items-center gap-1 px-2 py-1 rounded transition-colors ${th.btn}`}
              style={!isDark ? { color: 'var(--text-secondary)' } : undefined}
              onClick={onCopy}
              title={t('infoPanel.copyTitle', { title })}
              aria-label={t('infoPanel.copyAriaLabel', { title })}
            >
              {copied ? (
                <span className={th.copied}>{t('infoPanel.copied')}</span>
              ) : (
                <>
                  <IconCopy size={12} />
                  <span>{resolvedCopyLabel}</span>
                </>
              )}
            </button>
          )}
        </div>
      )}

      {loading && (
        <div
          className={`text-xs py-3 flex items-center gap-2 ${th.empty}`}
          style={!isDark ? { color: 'var(--text-tertiary)' } : undefined}
        >
          <div className="w-3 h-3 rounded-full border border-current border-t-transparent animate-spin" />
          {resolvedLoadingText}
        </div>
      )}

      {!loading && error && (
        <div
          className={`text-xs py-3 ${th.empty}`}
          style={!isDark ? { color: 'var(--text-tertiary)' } : undefined}
        >
          {resolvedErrorPrefix}: {error}
        </div>
      )}

      {!loading && !error && !hasContent && (
        <div
          className={`text-xs py-3 flex items-center gap-1.5 ${th.empty}`}
          style={!isDark ? { color: 'var(--text-tertiary)' } : undefined}
        >
          {resolvedEmptyText}
        </div>
      )}

      {!loading &&
        !error &&
        hasContent &&
        (groups ? (
          <div className="space-y-3">
            {groups.map((group) => (
              <div key={group.title}>
                <div
                  className={`text-[10px] font-semibold uppercase tracking-wider mb-1 ${th.groupTitle}`}
                  style={!isDark ? { color: 'var(--text-tertiary)' } : undefined}
                >
                  {group.title}
                </div>
                <div className="space-y-0.5">
                  {group.rows.map((row) => (
                    <div
                      key={row.label}
                      className={`flex items-baseline gap-3 text-xs py-1 border-b last:border-b-0 ${th.row}`}
                    >
                      <span
                        className={`flex-shrink-0 w-20 ${th.label}`}
                        style={!isDark ? { color: 'var(--text-tertiary)' } : undefined}
                      >
                        {row.label}
                      </span>
                      <span
                        className={`flex-1 break-all font-mono ${th.value}`}
                        style={!isDark ? { color: 'var(--text-primary)' } : undefined}
                      >
                        {row.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-0.5">
            {rows!.map((row, idx) => (
              <div
                key={`${row.label}-${idx}`}
                className={`flex items-baseline gap-3 text-xs py-1 border-b last:border-b-0 ${th.row}`}
              >
                <span
                  className={`flex-shrink-0 w-20 ${th.label}`}
                  style={!isDark ? { color: 'var(--text-tertiary)' } : undefined}
                >
                  {row.label}
                </span>
                <span
                  className={`flex-1 break-all font-mono ${th.value}`}
                  style={!isDark ? { color: 'var(--text-primary)' } : undefined}
                >
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        ))}
    </div>
  )
}
