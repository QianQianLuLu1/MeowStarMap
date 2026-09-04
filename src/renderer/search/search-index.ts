/**
 * flexsearch Document 实例与配置
 *
 * 设计原则：
 * - flexsearch 是纯 JS 库，无原生依赖，与 Electron + React + zustand 完全兼容
 * - Document 索引以 media.id（DB INTEGER）为文档 ID，6 字段分别建索引
 * - Phase 1：camera_params 字段留空串，Phase 2 接入解密缓存后填充
 *
 * 字段配置理由：
 * - file_name / outfit / scene_category：forward 前缀匹配，用户输入"奇"即可召回"奇迹平原"
 * - tags：strict 精确匹配，标签是离散值，前缀匹配会引入噪音
 * - notes：full 全文匹配，备注是自由文本，需要支持任意位置匹配
 * - camera_params：forward，参数以"焦距50 光圈1.8"格式存储，前缀匹配足够
 *
 * CJK 策略：保留默认字符级拆分 + tokenize: 'forward' 组合，
 * 用户输入"奇迹"时通过 forward 前缀匹配连续命中，无需引入 jieba 等分词库
 */
import { Document, type DocumentData } from 'flexsearch'

/**
 * 可搜索文档结构
 * id 与数据库 media_files.id（INTEGER）一致；渲染进程与 MediaFile.id（string）对齐时需 String(id)
 */
// 继承 flexsearch DocumentData 以满足 Document<D> 的类型约束
export interface SearchableDoc extends DocumentData {
  id: number
  file_name: string
  tags: string // 预 join：['礼服', '夜景'] → '礼服 夜景'
  outfit: string
  scene_category: string
  camera_params: string // Phase 2 接入：'焦距50 光圈1.8 ISO100 场景:奇迹平原'
  notes: string
}

/**
 * 创建 flexsearch Document 索引实例的工厂函数
 *
 * flexsearch 0.8.x 已知 bug：
 * 1. clear() 会破坏内部注册表（reg）状态 → 已用 recreateSearchIndex() 规避
 * 2. preset: 'performance' 启用 fastupdate: true，使 reg 变为 Set
 *    库代码在 add()/update() 时调用 reg.get()，Set 无此方法 → TypeError
 * 修复：显式设置 fastupdate: false，使 reg 保持 Map 类型
 */
function createSearchIndex(): Document<SearchableDoc> {
  return new Document<SearchableDoc>({
    preset: 'performance',
    fastupdate: false,
    tokenize: 'forward',
    cache: 100,
    document: {
      id: 'id',
      index: [
        { field: 'file_name', tokenize: 'forward', resolution: 9 },
        { field: 'tags', tokenize: 'strict', resolution: 7 },
        { field: 'outfit', tokenize: 'forward', resolution: 7 },
        { field: 'scene_category', tokenize: 'forward', resolution: 5 },
        { field: 'camera_params', tokenize: 'forward', resolution: 5 },
        { field: 'notes', tokenize: 'full', resolution: 9 }
      ]
    }
  })
}

/**
 * R15：索引字段配置指纹（静态部分）
 * 基于索引字段名 + tokenize 策略 + resolution，代码变更时自动失效旧索引。
 * 与 computeSchemaHash 的采样部分组合，形成完整的 schema_hash。
 */
export const INDEX_FIELD_CONFIG =
  'file_name:forward:9|tags:strict:7|outfit:forward:7|scene_category:forward:5|camera_params:forward:5|notes:full:9'

/**
 * 索引容器：通过稳定的对象引用避免 export let 在打包后丢失 live binding
 *
 * Vite/Rollup 打包时，export let 变量会被内联为常量，
 * recreateSearchIndex() 重新赋值后，其他模块仍持有旧实例引用。
 * 改用容器对象：对象本身不重新赋值，只替换 .index 属性，
 * getSearchIndex() 每次读取容器属性，保证拿到最新实例。
 */
const indexHolder: { index: Document<SearchableDoc> } = {
  index: createSearchIndex()
}

/** 获取当前全局索引实例 */
export function getSearchIndex(): Document<SearchableDoc> {
  return indexHolder.index
}

/**
 * 销毁旧索引并创建新实例
 * 用于 searchService.rebuild() 替代 searchIndex.clear()
 */
export function recreateSearchIndex(): void {
  indexHolder.index = createSearchIndex()
}
