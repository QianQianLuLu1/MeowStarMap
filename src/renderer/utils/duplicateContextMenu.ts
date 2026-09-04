import type { MediaFile } from '../stores/mediaStore'
import type { DuplicateItem } from '../../shared/types/duplicate'
import type { SceneCategory } from '../../shared/scene-category'

/**
 * 将「重复文件」板块的 DuplicateItem 适配为图库右键菜单工厂 getContextMenuItems 所需的 MediaFile 形状。
 *
 * 复用策略：图库右键菜单（ContextMenu 组件 + getContextMenuItems 工厂 + useFileOperations 钩子）
 * 已覆盖打开/编辑/收藏/删除/重命名/导出/分享/属性等全部操作，本函数仅做最小字段映射，
 * 不引入任何新依赖、不重写菜单逻辑。
 *
 * 参数校验：id 必须为 number、file_path 必须为非空字符串，否则返回 null（调用方据此跳过弹菜单）。
 */
export function toContextMenuMediaFile(item: DuplicateItem): MediaFile | null {
  if (
    !item ||
    typeof item.id !== 'number' ||
    typeof item.file_path !== 'string' ||
    item.file_path.length === 0
  ) {
    return null
  }

  const extMatch = /\.([^.]+)$/.exec(item.file_name)
  const file_ext = extMatch ? extMatch[1].toLowerCase() : ''

  return {
    id: String(item.id),
    file_path: item.file_path,
    file_name: item.file_name,
    file_type: item.file_type === 'video' ? 'video' : 'image',
    file_ext,
    file_size: item.file_size,
    width: item.width ?? undefined,
    height: item.height ?? undefined,
    created_at: item.modified_at,
    modified_at: item.modified_at,
    tags: [],
    rating: item.rating,
    is_favorite: item.is_favorite,
    notes: '',
    scene_category: 'other' as SceneCategory
  }
}
