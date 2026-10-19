import React from 'react'

interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number
}

const BaseIcon: React.FC<IconProps & { children: React.ReactNode }> = ({
  size = 16,
  className,
  style,
  children,
  ...props
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={style}
    {...props}
  >
    {children}
  </svg>
)

export const IconOpen: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />
    <path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
  </BaseIcon>
)

export const IconEdit: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </BaseIcon>
)

export const IconSaveAs: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
  </BaseIcon>
)

export const IconExport: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </BaseIcon>
)

export const IconCopy: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </BaseIcon>
)

export const IconPaste: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
  </BaseIcon>
)

export const IconMove: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </BaseIcon>
)

export const IconRename: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </BaseIcon>
)

export const IconFavorite: React.FC<IconProps & { filled?: boolean; color?: string }> = ({
  filled = false,
  color = 'var(--favorite)',
  ...props
}) => (
  <BaseIcon {...props} fill={filled ? color : 'none'} stroke={filled ? color : 'currentColor'}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </BaseIcon>
)

export const IconDelete: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </BaseIcon>
)

export const IconProperties: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </BaseIcon>
)

// 在资源管理器中打开文件所在位置（打开文件夹）
export const IconFolderOpen: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z" />
    <path d="M3 10l4 0 2 2" />
  </BaseIcon>
)

// 信息按钮（全屏预览中显示 EXIF 信息）
export const IconInfo: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </BaseIcon>
)

// 相机图标（EXIF 拍摄参数）
export const IconCamera: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </BaseIcon>
)

// 复制按钮
export const IconCopyText: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </BaseIcon>
)

export const IconGrid: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <rect x="3" y="3" width="7" height="7" />
    <rect x="14" y="3" width="7" height="7" />
    <rect x="14" y="14" width="7" height="7" />
    <rect x="3" y="14" width="7" height="7" />
  </BaseIcon>
)

export const IconList: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" />
    <line x1="3" y1="12" x2="3.01" y2="12" />
    <line x1="3" y1="18" x2="3.01" y2="18" />
  </BaseIcon>
)

export const IconTimeline: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </BaseIcon>
)

export const IconMasonry: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <rect x="3" y="3" width="7" height="10" />
    <rect x="14" y="3" width="7" height="6" />
    <rect x="14" y="12" width="7" height="9" />
    <rect x="3" y="16" width="7" height="5" />
  </BaseIcon>
)

export const IconClose: React.FC<IconProps> = (props) => (
  <BaseIcon {...props} strokeWidth="2.5">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </BaseIcon>
)

export const IconSearch: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </BaseIcon>
)

export const IconImage: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <polyline points="21 15 16 10 5 21" />
  </BaseIcon>
)

export const IconVideo: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <polygon points="5 3 19 12 5 21 5 3" />
  </BaseIcon>
)

export const IconWatermark: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M12 2L2 7l10 5 10-5-10-5z" />
    <path d="M2 17l10 5 10-5" />
    <path d="M2 12l10 5 10-5" />
  </BaseIcon>
)

export const IconStar: React.FC<IconProps & { filled?: boolean; color?: string }> = ({
  filled = false,
  color = '#FFB800',
  ...props
}) => (
  <BaseIcon {...props} fill={filled ? color : 'none'} stroke={filled ? color : 'currentColor'}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </BaseIcon>
)

export const IconChevronLeft: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <polyline points="15 18 9 12 15 6" />
  </BaseIcon>
)

export const IconChevronRight: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <polyline points="9 18 15 12 9 6" />
  </BaseIcon>
)

export const IconChevronUp: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <polyline points="18 15 12 9 6 15" />
  </BaseIcon>
)

export const IconChevronDown: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <polyline points="6 9 12 15 18 9" />
  </BaseIcon>
)

export const IconUndo: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M3 7v6h6" />
    <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
  </BaseIcon>
)

export const IconRedo: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M21 7v6h-6" />
    <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
  </BaseIcon>
)

export const IconReset: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </BaseIcon>
)

export const IconCompare: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="12" y1="3" x2="12" y2="21" />
  </BaseIcon>
)

// 分屏对比：左右两个面板，表示原图与编辑效果并排对比
export const IconSplitCompare: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <rect x="3" y="4" width="8" height="16" rx="1" />
    <rect x="13" y="4" width="8" height="16" rx="1" />
  </BaseIcon>
)

export const IconHelp: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </BaseIcon>
)

export const IconFullscreen: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </BaseIcon>
)

export const IconFullscreenExit: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M8 3v3a2 2 0 0 1-2 2H3" />
    <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
    <path d="M3 16h3a2 2 0 0 1 2 2v3" />
    <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
  </BaseIcon>
)

export const IconFilterPreset: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
    <path d="M2 12h20" />
  </BaseIcon>
)

export const IconSettings: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </BaseIcon>
)

// F-S10：重复文件检测图标（两个叠加的文件，前一个透明）
export const IconDuplicate: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" opacity="0.55" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </BaseIcon>
)

export const IconSelectAll: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 12l2 2 4-4" />
  </BaseIcon>
)

export const IconInvertSelection: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M7 7h4v4H7z" />
    <path d="M13 13h4v4h-4z" />
  </BaseIcon>
)

export const IconCategory: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M4 4h6v6H4z" />
    <path d="M14 4h6v6h-6z" />
    <path d="M4 14h6v6H4z" />
    <path d="M14 14h6v6h-6z" />
  </BaseIcon>
)

export const IconTag: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
    <circle cx="7" cy="7" r="2" />
  </BaseIcon>
)

// T03：套装图鉴——衣架图标
export const IconOutfit: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M12 4a2 2 0 1 0 2 2" />
    <path d="M14 6c0 1.5-1 2-2 2.5L3.6 13.7c-.5.3-.5 1 0 1.4l6.9 4.2c.9.6 2.1.6 3 0l6.9-4.2c.5-.3.5-1 0-1.4L14 8.5" />
    <path d="M12 14.5v5.5" />
  </BaseIcon>
)

// T03：未解锁套装——锁图标
export const IconLock: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <rect x="4" y="11" width="16" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </BaseIcon>
)

// T04：活动时间轴——旗帜图标
export const IconEvent: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M5 21V4" />
    <path d="M5 4h11l-2 4 2 4H5" />
  </BaseIcon>
)

export const IconWarning: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </BaseIcon>
)

export const IconDoubleChevronLeft: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <polyline points="11 17 6 12 11 7" />
    <polyline points="18 17 13 12 18 7" />
  </BaseIcon>
)

export const IconDoubleChevronRight: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <polyline points="13 17 18 12 13 7" />
    <polyline points="6 17 11 12 6 7" />
  </BaseIcon>
)

export const IconRefresh: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </BaseIcon>
)

export const IconGallery: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
  </BaseIcon>
)

export const IconLut: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18" />
    <path d="M9 21V9" />
  </BaseIcon>
)

export const IconDouyin: React.FC<IconProps> = (props) => (
  <BaseIcon {...props} fill="currentColor" stroke="none">
    <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
  </BaseIcon>
)

export const IconBilibili: React.FC<IconProps> = (props) => (
  <BaseIcon {...props} fill="currentColor" stroke="none">
    <path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.659.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.249.248.373.551.373.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373z" />
  </BaseIcon>
)

export const IconXiaohongshu: React.FC<IconProps> = (props) => (
  <BaseIcon {...props} fill="currentColor" stroke="none">
    <path d="M20 3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM7 7h10v2H7zm0 4h10v2H7zm0 4h7v2H7z" />
  </BaseIcon>
)

// F-S6 回收站图标（带纵向回收箭头）
export const IconTrash: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M12 11v6" />
    <polyline points="9 14 12 17 15 14" />
  </BaseIcon>
)

// F-S6 恢复图标（逆向箭头）
export const IconRestore: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <polyline points="3 3 3 8 8 8" />
  </BaseIcon>
)

// T08：分享图标（Lucide share-2 三节点网络，业界通用分享符号）
// 字形来源：lucide-static v1.49.0 icons/share-2.svg（ISC License，与仓库 MIT 兼容）
// https://github.com/lucide-icons/lucide
// 选型原因：原「WiFi 弧线 + 圆点」手绘字形外弧悬空截断、观感如被遮挡一半；
// 该字形全部笔画位于描边安全区内（范围 [3,21]×[2,22]），无 viewBox 裁剪风险
export const IconShare: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
  </BaseIcon>
)

// T09：微信图标（简化气泡 + 双圆点）
export const IconWeChat: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M9 2C4.58 2 1 5.13 1 9c0 1.85.83 3.55 2.2 4.83L2 17l3.3-1.7C6.44 15.74 7.7 16 9 16c.4 0 .78-.03 1.16-.08" />
    <path d="M15 8c4.42 0 8 2.91 8 6.5 0 1.79-.84 3.4-2.2 4.6L22 22l-3.2-1.5c-1.13.4-2.4.5-3.8.5-4.42 0-8-2.91-8-6.5S10.58 8 15 8z" />
    <circle cx="6" cy="9" r="0.6" fill="currentColor" />
    <circle cx="12" cy="9" r="0.6" fill="currentColor" />
    <circle cx="13" cy="14.5" r="0.6" fill="currentColor" />
    <circle cx="17" cy="14.5" r="0.6" fill="currentColor" />
  </BaseIcon>
)

// T09：QQ 图标（简化企鹅轮廓）
export const IconQQ: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M12 2c3 0 5 2.5 5 6v3c1 1.5 2 3 2 5 0 .8-.5 1-1 1l-1.5-.5c-.5 1.5-1.5 3-2.5 3.5l1.5 1c.5.5.5 1 0 1H9c-.5 0-.5-.5 0-1l1.5-1c-1-.5-2-2-2.5-3.5L6.5 17c-.5 0-1-.2-1-1 0-2 1-3.5 2-5V8c0-3.5 2-6 4.5-6z" />
  </BaseIcon>
)

// T09：vivo 办公套件图标（V 字 + 文档）
export const IconVivo: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="M8 13l2 3 2-3" />
    <path d="M14 13v3" />
    <path d="M14 13h2" />
  </BaseIcon>
)

// T11：幻灯片播放图标（屏幕 + 播放三角）
export const IconSlideshow: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
    <path d="M10.5 8.5v4l3-2z" fill="currentColor" stroke="none" />
  </BaseIcon>
)

// T11：随机播放图标（洗牌箭头）
export const IconShuffle: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M16 3h5v5" />
    <path d="M4 20L21 3" />
    <path d="M21 16v5h-5" />
    <path d="M15 15l6 6" />
    <path d="M4 4l5 5" />
  </BaseIcon>
)

// T14：导入图标（向下箭头进入托盘）
export const IconImport: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M12 3v12" />
    <path d="M7 10l5 5 5-5" />
    <path d="M5 21h14" />
  </BaseIcon>
)

// 媒体控制：播放（实心三角）
export const IconPlay: React.FC<IconProps> = (props) => (
  <BaseIcon {...props} fill="currentColor" stroke="none">
    <path d="M8 5v14l11-7z" />
  </BaseIcon>
)

// 媒体控制：暂停（双竖条）
export const IconPause: React.FC<IconProps> = (props) => (
  <BaseIcon {...props} fill="currentColor" stroke="none">
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  </BaseIcon>
)

// 通用：对勾
export const IconCheck: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <polyline points="20 6 9 17 4 12" />
  </BaseIcon>
)

// 通用：消息/反馈气泡
export const IconMessage: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </BaseIcon>
)

// 阶段 5：同步图库导航图标。用双向回环箭（repeat 语义）而非 refresh 单箭，
// 与「检查更新」的 IconRotateCw 在侧栏里同时可能出现，需要一眼可分。
export const IconSync: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <polyline points="17 1 21 5 17 9" />
    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <polyline points="7 23 3 19 7 15" />
    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </BaseIcon>
)

// 通用：顺时针旋转（带箭头，用于检查更新等）
export const IconRotateCw: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <polyline points="21 4 21 10 15 10" />
  </BaseIcon>
)

// 通用：对勾圆圈
export const IconCheckCircle: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M9 12l2 2 4-4" />
    <circle cx="12" cy="12" r="10" />
  </BaseIcon>
)

// 通用：盾牌
export const IconShield: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </BaseIcon>
)

// 通用：铃铛
export const IconBell: React.FC<IconProps> = (props) => (
  <BaseIcon {...props}>
    <path d="M12 2c-3.3 0-6 2.7-6 6v1.5c0 .8-.3 1.5-.8 2.1L4 13c-.5.6-.5 1.5 0 2l1.5 1.2c.3.2.4.6.3 1-.2.8-.5 1.6-.8 2.3-.2.5 0 1 .4 1.3.4.3 1 .3 1.4 0 .8-.5 1.7-.8 2.6-1 .5-.1 1 0 1.4.3.7.6 1.6 1 2.7 1s2-.4 2.7-1c.4-.3.9-.4 1.4-.3.9.2 1.8.5 2.6 1 .4.3 1 .3 1.4 0 .4-.3.6-.8.4-1.3-.3-.7-.6-1.5-.8-2.3-.1-.4 0-.8.3-1L20 15c.5-.5.5-1.4 0-2l-1.2-1.4c-.5-.6-.8-1.3-.8-2.1V8c0-3.3-2.7-6-6-6z" />
  </BaseIcon>
)

// 品牌：GitHub
export const IconGithub: React.FC<IconProps> = (props) => (
  <BaseIcon {...props} fill="currentColor" stroke="none">
    <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.9 1.2 1.9 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.6.2 2.8.1 3.2.8.8 1.3 1.9 1.3 3.1 0 4.6-2.8 5.7-5.5 6 .5.4.8 1.1.8 2.3v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3" />
  </BaseIcon>
)
