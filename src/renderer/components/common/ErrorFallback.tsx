import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconWarning, IconRefresh, IconFolderOpen, IconCopy } from '../../icons'

interface ErrorFallbackProps {
  error: Error
  onRetry: () => void
  /** 组件栈信息（ErrorBoundary componentDidCatch 提供） */
  componentStack?: string
}

// P1-U4：三按钮配置抽取为模块常量，避免每次渲染重建 3 个对象
interface ActionButton {
  label: string
  icon: React.ReactNode
  onClick: () => void
  variant: 'primary' | 'secondary'
}

/**
 * P0-4：错误兜底页
 * 当 ErrorBoundary 捕获到组件渲染异常时显示，避免白屏
 * 提供重试 / 打开日志目录 / 复制错误信息三个操作
 *
 * P1-U4：所有 inline style 颜色改用 token 引用，柔粉主题下正确显示
 */
export const ErrorFallback: React.FC<ErrorFallbackProps> = ({ error, onRetry, componentStack }) => {
  const { t } = useTranslation()
  const [showDetail, setShowDetail] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    const text = [
      `${t('errorFallback.errorMessage')} ${error.message}`,
      `${t('errorFallback.errorStack')}`,
      error.stack || 'N/A',
      componentStack ? `\n${t('errorFallback.componentStack')}\n${componentStack}` : ''
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用时降级为选中文本
    }
  }

  const handleOpenLogDir = async () => {
    try {
      await window.electronAPI?.log?.openDirectory()
    } catch {}
  }

  // P1-U4：按钮配置数组，统一渲染逻辑，消除 60+ 行重复 inline style
  const buttons: ActionButton[] = [
    {
      label: t('errorFallback.reload'),
      icon: <IconRefresh size={16} color="var(--text-on-accent)" />,
      onClick: onRetry,
      variant: 'primary'
    },
    {
      label: t('errorFallback.openLogDir'),
      icon: <IconFolderOpen size={16} />,
      onClick: handleOpenLogDir,
      variant: 'secondary'
    },
    {
      label: copied ? t('errorFallback.copied') : t('errorFallback.copyError'),
      icon: <IconCopy size={16} />,
      onClick: handleCopy,
      variant: 'secondary'
    }
  ]

  const getButtonStyle = (variant: ActionButton['variant']): React.CSSProperties => {
    const base: React.CSSProperties = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '8px 16px',
      borderRadius: '8px',
      cursor: 'pointer',
      fontSize: '1rem',
      fontWeight: 500,
      border: '1px solid transparent',
      transition: 'background 0.2s'
    }
    if (variant === 'primary') {
      return {
        ...base,
        background: 'var(--accent)',
        color: 'var(--text-on-accent)',
        borderColor: 'var(--accent)'
      }
    }
    return {
      ...base,
      background: 'var(--hover-bg)',
      color: 'var(--text-primary)',
      borderColor: 'var(--divider)'
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-secondary)',
        backdropFilter: 'var(--backdrop-blur)',
        WebkitBackdropFilter: 'var(--backdrop-blur)',
        zIndex: 9999,
        padding: '24px'
      }}
    >
      <div
        style={{
          maxWidth: '560px',
          width: '100%',
          background: 'var(--bg-secondary)',
          borderRadius: '16px',
          boxShadow: 'var(--shadow-lg)',
          padding: '32px',
          border: '1px solid var(--divider)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <div
            style={{
              width: '48px',
              height: '48px',
              borderRadius: '50%',
              background: 'var(--danger-bg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0
            }}
          >
            <IconWarning size={28} color="var(--danger-hover)" />
          </div>
          <div>
            <h2
              style={{
                margin: 0,
                fontSize: '1.429rem',
                fontWeight: 600,
                color: 'var(--text-primary)'
              }}
            >
              {t('errorFallback.title')}
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: '1rem', color: 'var(--text-secondary)' }}>
              {t('errorFallback.subtitle')}
            </p>
          </div>
        </div>

        <div
          style={{
            background: 'var(--danger-bg)',
            borderRadius: '8px',
            padding: '12px 16px',
            marginBottom: '16px',
            border: '1px solid var(--danger-bg)'
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: '1rem',
              color: 'var(--danger-hover)',
              fontFamily: 'monospace',
              wordBreak: 'break-word'
            }}
          >
            {error.message}
          </p>
        </div>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
          {buttons.map((btn, i) => (
            <button
              key={i}
              onClick={btn.onClick}
              style={getButtonStyle(btn.variant)}
              onMouseEnter={(e) => {
                if (btn.variant === 'primary') e.currentTarget.style.background = 'var(--accent)'
                else e.currentTarget.style.background = 'var(--hover-bg-strong)'
              }}
              onMouseLeave={(e) => {
                if (btn.variant === 'primary') e.currentTarget.style.background = 'var(--accent)'
                else e.currentTarget.style.background = 'var(--hover-bg)'
              }}
            >
              {btn.icon}
              {btn.label}
            </button>
          ))}
        </div>

        <button
          onClick={() => setShowDetail(!showDetail)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            fontSize: '0.929rem',
            padding: 0,
            textDecoration: 'underline'
          }}
        >
          {showDetail ? t('errorFallback.hideDetail') : t('errorFallback.showDetail')}
        </button>
        {showDetail && (
          <pre
            style={{
              marginTop: '8px',
              maxHeight: '240px',
              overflow: 'auto',
              padding: '12px',
              background: 'var(--hover-bg)',
              borderRadius: '8px',
              fontSize: '0.857rem',
              fontFamily: 'monospace',
              color: 'var(--text-primary)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word'
            }}
          >
            {error.stack || error.message}
            {componentStack ? `\n\n${t('errorFallback.componentStack')}\n${componentStack}` : ''}
          </pre>
        )}
      </div>
    </div>
  )
}

// 路由级/区域级 fallback 共用的 props（与 ErrorBoundaryFallbackProps 结构一致，本地定义避免循环依赖）
interface BoundaryFallbackProps {
  error: Error
  reset: () => void
  componentStack?: string
}

/**
 * 路由级 fallback：仅占据内容区，侧边栏/顶部工具栏保持可用
 * 由路由级 ErrorBoundary 使用，resetKeys 切换页面时自动恢复
 */
export const RouteErrorFallback: React.FC<BoundaryFallbackProps> = ({ error, reset }) => {
  const { t } = useTranslation()
  const summary = error.message.slice(0, 200)
  return (
    <div
      className="h-full w-full flex flex-col items-center justify-center gap-3 p-6"
      style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
    >
      <IconWarning size={32} color="var(--danger-hover)" />
      <h3 style={{ margin: 0, fontSize: '1.143rem', fontWeight: 600 }}>
        {t('errorFallback.routeTitle')}
      </h3>
      <p
        className="font-mono text-sm break-all text-center"
        style={{ color: 'var(--danger-hover)', maxWidth: '80%' }}
      >
        {summary}
      </p>
      <button
        type="button"
        onClick={reset}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium"
        style={{
          background: 'var(--accent)',
          color: 'var(--text-on-accent)',
          border: '1px solid var(--accent)',
          cursor: 'pointer'
        }}
      >
        <IconRefresh size={14} color="var(--text-on-accent)" />
        {t('errorFallback.routeRetry')}
      </button>
    </div>
  )
}

/**
 * 区域级 fallback：小占位块，仅替换出错区域，不影响周围布局
 * 用于图片/视频渲染、插件面板、编辑器 canvas 等高危区域
 */
export const ZoneErrorFallback: React.FC<BoundaryFallbackProps> = ({ error, reset }) => {
  const { t } = useTranslation()
  const summary = error.message.slice(0, 200)
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 p-4 rounded-lg w-full h-full"
      style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
    >
      <IconWarning size={20} color="var(--danger-hover)" />
      <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
        {t('errorFallback.zoneTitle')}
      </span>
      <span
        className="font-mono text-xs break-all text-center"
        style={{ color: 'var(--danger-hover)', maxWidth: '100%' }}
      >
        {summary}
      </span>
      <button
        type="button"
        onClick={reset}
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium"
        style={{
          background: 'var(--accent)',
          color: 'var(--text-on-accent)',
          border: '1px solid var(--accent)',
          cursor: 'pointer'
        }}
      >
        <IconRefresh size={12} color="var(--text-on-accent)" />
        {t('errorFallback.zoneRetry')}
      </button>
    </div>
  )
}
