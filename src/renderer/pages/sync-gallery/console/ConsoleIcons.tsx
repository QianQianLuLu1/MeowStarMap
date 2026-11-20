import React from 'react'

/**
 * N2：上游 DesktopIcons.ts 的 12 个 24px path 原样移植（另补 1 个 `trash` 供「最近删除」入口
 * 与灵感库区分；同为 24px 线性风格，不注册到宿主全局 icon 体系）。
 */
export type ConsoleIconName =
  | 'info'
  | 'phone'
  | 'settings'
  | 'camera'
  | 'album'
  | 'wifi'
  | 'arrow'
  | 'close'
  | 'check'
  | 'shield'
  | 'wechat'
  | 'android'
  | 'trash'

const ICON_PATHS: Record<ConsoleIconName, string> = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="3"/><path d="M10 6h4M11 18h2"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor" stroke="none"/><circle cx="15" cy="17" r="3" fill="currentColor" stroke="none"/>',
  camera:
    '<path d="M8 6l2-3h4l2 3h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/><circle cx="12" cy="13" r="4"/>',
  album:
    '<rect x="5" y="3" width="16" height="16" rx="3"/><path d="M2 7v12a3 3 0 0 0 3 3h12M5 15l4-4 4 4 3-3 5 5"/><circle cx="16" cy="8" r="1"/>',
  wifi: '<path d="M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0M9 16a5 5 0 0 1 6 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/>',
  arrow: '<path d="M5 12h14M14 7l5 5-5 5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12l4 4L19 6"/>',
  shield: '<path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="M8 12l3 3 5-5"/>',
  wechat:
    '<path d="M13 14c-5 2-6 0-8 2l.5-3C1 9 3 4 8 4c4 0 7 2 7 5"/><path d="M15 9c4 0 7 4 4 7l.5 3-3-1c-6 1-8-3-6-6 1-2 3-3 5-3z"/><path d="M7 8h.01M11 8h.01M14 13h.01M17 13h.01" stroke-linecap="round"/>',
  android:
    '<path d="M7 8L5 5M17 8l2-3M5 13a7 7 0 0 1 14 0v5H5zM8 18v3M16 18v3M2 13v5M22 13v5"/><path d="M9 12h.01M15 12h.01" stroke-linecap="round"/>',
  trash: '<path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6M14 11v6"/>'
}

interface ConsoleIconProps {
  name: ConsoleIconName
  size?: number
  className?: string
}

export const ConsoleIcon: React.FC<ConsoleIconProps> = ({ name, size = 20, className = '' }) => (
  <svg
    className={`sc-icon ${className}`.trim()}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.65}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }}
  />
)
