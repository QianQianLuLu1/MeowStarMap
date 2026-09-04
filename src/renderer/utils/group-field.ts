import type { MediaFile } from '../stores/mediaStore'
import type { GroupDimension } from '../../shared/dimension'

/**
 * P1-U4：从 MediaFile 提取指定维度的字段值
 * 统一 SmartGroupPanel 与 useFilteredMediaFiles 的字段映射逻辑，消除 dual-source-of-truth
 */
export function getGroupFieldValue(file: MediaFile, dimension: GroupDimension): string {
  switch (dimension) {
    case 'album_type':
      return file.album_type || 'group.other'
    case 'scene_category':
      return file.scene_category || 'other'
    case 'scene_time':
      return file.scene_time || 'unknown'
    case 'outfit':
      return file.outfit || ''
    case 'file_type':
      return file.file_type
    default:
      return ''
  }
}
