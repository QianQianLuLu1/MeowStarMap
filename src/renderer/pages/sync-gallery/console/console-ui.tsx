import React from 'react'
import { ConsoleIcon } from './ConsoleIcons'

/** N2：控制台专用展示组件；只承载上游 DesktopPage 的卡片语义，不接管业务状态。 */

export interface ConsoleSectionProps {
  title: string
  description?: string
  aside?: React.ReactNode
  children: React.ReactNode
  className?: string
  testId?: string
  /** 卡片标题层级：页面内子区块默认 h3；关于/设置的一级卡可传 h2 兼容上游观感。 */
  titleAs?: 'h2' | 'h3'
}

export const ConsoleSection: React.FC<ConsoleSectionProps> = ({
  title,
  description,
  aside,
  children,
  className = '',
  testId,
  titleAs = 'h3'
}) => {
  const Heading = titleAs
  return (
    <section className={`sc-card ${className}`.trim()} data-testid={testId}>
      <div className="sc-card-head">
        <div className="sc-card-head-text">
          <Heading className="sc-card-title">{title}</Heading>
          {description ? <p className="sc-card-desc">{description}</p> : null}
        </div>
        {aside ? <div className="sc-card-aside">{aside}</div> : null}
      </div>
      <div className="sc-card-body">{children}</div>
    </section>
  )
}

export interface ConsoleCardProps {
  children: React.ReactNode
  className?: string
  testId?: string
}

export const ConsoleCard: React.FC<ConsoleCardProps> = ({ children, className = '', testId }) => (
  <div className={`sc-card ${className}`.trim()} data-testid={testId}>
    {children}
  </div>
)

export interface ConsoleRowProps {
  label: string
  description?: string
  children?: React.ReactNode
  className?: string
}

export const ConsoleRow: React.FC<ConsoleRowProps> = ({
  label,
  description,
  children,
  className = ''
}) => (
  <div className={`sc-setting-row ${className}`.trim()}>
    <div className="sc-setting-row-text">
      <span className="sc-setting-title">{label}</span>
      {description ? <p className="sc-setting-help">{description}</p> : null}
    </div>
    {children ? <div className="sc-setting-value">{children}</div> : null}
  </div>
)

export interface ConsoleBadgeProps {
  children: React.ReactNode
}

export const ConsoleBadge: React.FC<ConsoleBadgeProps> = ({ children }) => (
  <span className="sc-badge">{children}</span>
)

export interface ConsoleHintProps {
  children: React.ReactNode
  icon?: React.ComponentProps<typeof ConsoleIcon>['name']
}

export const ConsoleHint: React.FC<ConsoleHintProps> = ({ children, icon = 'wifi' }) => (
  <span className="sc-hint">
    <ConsoleIcon name={icon} size={14} />
    {children}
  </span>
)
