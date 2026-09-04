/**
 * 角色档案相关共享类型定义
 *
 * 字段与数据库表 character_profiles 一一对应。
 * 拍摄统计实时从 media_files 聚合查询，不单独建表。
 */

import type { MediaType } from './media'

// ============================================================================
// 角色档案类型（对应 character_profiles 表）
// ============================================================================

/**
 * 角色档案数据库行（与 character_profiles 表字段一一对应）
 */
export interface ProfileRow {
  /** 角色 UID（主键） */
  uid: string
  /** 昵称（默认空串） */
  nickname: string
  /** 头像路径，未设置为 null */
  avatar: string | null
  /** 创建时间（ISO 字符串） */
  created_at: string
  /** 最后活跃时间（ISO 字符串），从未活跃为 null */
  last_active_at: string | null
}

/**
 * 渲染进程使用的角色档案模型
 */
export interface CharacterProfile {
  /** 角色 UID */
  uid: string
  /** 昵称 */
  nickname: string
  /** 头像路径 */
  avatar: string | null
  /** 创建时间 */
  createdAt: string
  /** 最后活跃时间 */
  lastActiveAt: string | null
  /** 该档案下的媒体总数（聚合查询结果） */
  mediaCount: number
  /** 该档案下的图片数 */
  imageCount: number
  /** 该档案下的视频数 */
  videoCount: number
  /** 收藏数 */
  favoriteCount: number
}

/**
 * 角色档案创建参数
 */
export interface ProfileCreateInput {
  /** 角色 UID（必填，唯一） */
  uid: string
  /** 昵称 */
  nickname?: string
  /** 头像路径 */
  avatar?: string | null
}

/**
 * 角色档案更新参数
 */
export interface ProfileUpdateInput {
  /** 昵称 */
  nickname?: string
  /** 头像路径 */
  avatar?: string | null
  /** 最后活跃时间 */
  lastActiveAt?: string | null
}

// ============================================================================
// 角色档案统计类型
// ============================================================================

/**
 * 角色档案基础统计（从 media_files 聚合查询）
 */
export interface ProfileBaseStats {
  /** 媒体总数 */
  total: number
  /** 图片数 */
  images: number
  /** 视频数 */
  videos: number
  /** 收藏数 */
  favorites: number
}

/**
 * 角色档案 Top 统计行
 *
 * 用于"最常出现的场景"、"最常穿的套装"等聚合查询。
 */
export interface ProfileTopStatRow {
  /** 统计维度值（如套装名、场景名） */
  value: string
  /** 出现次数 */
  count: number
}

/**
 * Top 统计维度
 */
export type ProfileTopStatDimension = 'outfit' | 'scene_category' | 'scene_time' | 'album_type'

/**
 * Top 统计查询结果
 */
export interface ProfileTopStat {
  /** 统计维度 */
  dimension: ProfileTopStatDimension
  /** Top 列表（按出现次数降序） */
  items: ProfileTopStatRow[]
  /** 限制返回的条目数 */
  limit: number
}

/**
 * 分组计数行
 */
export interface GroupCountRow {
  /** 分组键 */
  key: string
  /** 计数 */
  count: number
}

/**
 * 角色档案完整统计
 */
export interface ProfileStats {
  /** 基础统计 */
  base: ProfileBaseStats
  /** 最常出现的场景（Top 5） */
  topScenes: ProfileTopStatRow[]
  /** 最常穿的套装（Top 5） */
  topOutfits: ProfileTopStatRow[]
  /** 时段分布 */
  sceneTimeDistribution: GroupCountRow[]
  /** 相册类型分布 */
  albumTypeDistribution: GroupCountRow[]
  /** 首次拍摄时间 */
  firstActiveAt: string | null
  /** 最后拍摄时间 */
  lastActiveAt: string | null
}

// ============================================================================
// 媒体分类辅助类型
// ============================================================================

/**
 * 按媒体类型分组的计数
 */
export interface MediaTypeCount {
  /** 媒体类型 */
  type: MediaType
  /** 计数 */
  count: number
}
