/**
 * 分类相关共享类型定义
 *
 * 字段与数据库表 categories 一一对应。
 */

// ============================================================================
// 分类类型（对应 categories 表）
// ============================================================================

/**
 * 分类数据库行（与 categories 表字段一一对应）
 */
export interface CategoryRow {
  /** 主键 ID（AUTOINCREMENT） */
  id: number
  /** 分类名（唯一约束） */
  name: string
  /** 图标标识（如 'people'、'location'） */
  icon: string | null
  /** 颜色值（如 '#FF6B6B'） */
  color: string | null
  /** 排序序号（默认 0） */
  sort_order: number
  /** 父分类 ID，顶级分类为 null */
  parent_id: number | null
  /** 是否系统分类（0/1，系统分类不可删除） */
  is_system: number
  /** 创建时间（ISO 字符串） */
  created_at: string
}

/**
 * 渲染进程使用的分类模型
 *
 * 与 CategoryRow 区别：
 * - is_system：number → boolean
 */
export interface Category {
  /** 主键 ID */
  id: number
  /** 分类名 */
  name: string
  /** 图标标识 */
  icon: string | null
  /** 颜色值 */
  color: string | null
  /** 排序序号 */
  sortOrder: number
  /** 父分类 ID，顶级分类为 null */
  parentId: number | null
  /** 是否系统分类 */
  isSystem: boolean
  /** 创建时间 */
  createdAt: string
}

/**
 * 分类创建参数
 */
export interface CategoryCreateInput {
  /** 分类名（必填，唯一） */
  name: string
  /** 图标标识 */
  icon?: string | null
  /** 颜色值 */
  color?: string | null
  /** 排序序号 */
  sortOrder?: number
  /** 父分类 ID */
  parentId?: number | null
}

/**
 * 分类更新参数
 *
 * 所有字段可选，仅更新提供的字段。
 */
export interface CategoryUpdateInput {
  /** 分类名 */
  name?: string
  /** 图标标识 */
  icon?: string | null
  /** 颜色值 */
  color?: string | null
  /** 排序序号 */
  sortOrder?: number
  /** 父分类 ID */
  parentId?: number | null
}

/**
 * 分类树节点（含子分类）
 */
export interface CategoryTreeNode extends Category {
  /** 子分类列表 */
  children: CategoryTreeNode[]
  /** 该分类下的媒体数量（含子分类） */
  mediaCount: number
}

/**
 * 系统分类图标标识枚举
 *
 * 与 connection.ts 中默认系统分类一一对应。
 */
export type SystemCategoryIcon =
  'people' | 'location' | 'scene' | 'screenshot' | 'recording' | 'recent' | 'favorite'

/**
 * 系统分类预定义列表
 *
 * 不可删除、不可重命名，仅可修改颜色与排序。
 */
export interface SystemCategoryDef {
  /** 分类名 */
  name: string
  /** 图标标识 */
  icon: SystemCategoryIcon
  /** 颜色值 */
  color: string
  /** 排序序号 */
  sortOrder: number
}
