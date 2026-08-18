/**
 * 智能分组维度配置（P2-U6：从 Sidebar 和 SmartGroupPanel 抽取到 shared，消除重复）
 *
 * 纯类型与常量模块，不依赖任何 Node API 或 Electron API，
 * 可安全被主进程与渲染进程同时导入。
 */

export type GroupDimension =
  'none' | 'album_type' | 'scene_category' | 'scene_time' | 'outfit' | 'file_type'

export interface GroupDimensionOption {
  value: GroupDimension
  /** i18n key，供 Sidebar 等支持 i18n 的组件使用 */
  labelKey: string
}

export const GROUP_DIMENSION_OPTIONS: GroupDimensionOption[] = [
  { value: 'none', labelKey: 'group.none' },
  { value: 'album_type', labelKey: 'group.albumType' },
  { value: 'scene_category', labelKey: 'group.sceneCategory' },
  { value: 'scene_time', labelKey: 'group.sceneTime' },
  { value: 'outfit', labelKey: 'group.outfit' },
  { value: 'file_type', labelKey: 'group.fileType' }
]
