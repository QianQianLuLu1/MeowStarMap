/**
 * MediaFile → SearchableDoc 转换
 *
 * 字段映射策略：
 * - tags JSON 数组预 join 为空格分隔字符串，便于 flexsearch 分词
 * - camera_params 暂为空串（Phase 2 接入解密缓存后填充）
 * - 单字段截断至 500 字符，防止超长 notes 拖慢索引
 */
import type { MediaFile } from '../stores/mediaStore'
import type { SearchableDoc } from './search-index'

/** 单字段最大长度（超出截断，防止超长 notes 拖慢索引） */
const MAX_FIELD_LEN = 500

/** 截断字符串至 MAX_FIELD_LEN 字符 */
function truncate(s: string): string {
  return s.length > MAX_FIELD_LEN ? s.slice(0, MAX_FIELD_LEN) : s
}

/**
 * 将 MediaFile 转换为可索引文档
 * @param file 媒体文件（来自 mediaStore）
 * @param cameraParams 拍摄参数预格式化字符串（Phase 2 接入，Phase 1 留空）
 */
export function buildSearchableDoc(file: MediaFile, cameraParams?: string): SearchableDoc {
  return {
    id: Number(file.id),
    file_name: truncate(file.file_name),
    tags: truncate(Array.isArray(file.tags) ? file.tags.join(' ') : ''),
    outfit: truncate(file.outfit || ''),
    scene_category: truncate(file.scene_category || ''),
    camera_params: truncate(cameraParams || ''),
    notes: truncate(file.notes || '')
  }
}
